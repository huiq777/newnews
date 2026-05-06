import { renderBrief, type Channel } from './render'
import { markdownToBlocks } from './notion-blocks'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  FEISHU_WEBHOOK_URL?: string            // optional — skip channel if missing
  SLACK_WEBHOOK_URL?: string             // optional
  DISCORD_WEBHOOK_URL?: string           // optional
  TELEGRAM_BOT_TOKEN?: string            // optional (paired with TELEGRAM_CHAT_ID)
  TELEGRAM_CHAT_ID?: string              // optional
  NOTION_TOKEN?: string                  // optional (paired with NOTION_DATABASE_ID)
  NOTION_DATABASE_ID?: string            // optional
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  APP_URL?: string
}

interface TrendBriefRow {
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: unknown[] | null         // used by Notion to populate Sources count
}

interface DigestSentRow {
  id: string
  channel: Channel
  step_days: number
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

function channelLang(channel: Channel): 'synthesis_zh' | 'synthesis_en' {
  // ZH-target channels: Feishu (existing)
  if (channel === 'feishu') return 'synthesis_zh'
  return 'synthesis_en'
}

function configuredChannels(env: Env): Channel[] {
  const out: Channel[] = []
  if (env.FEISHU_WEBHOOK_URL) out.push('feishu')
  if (env.SLACK_WEBHOOK_URL) out.push('slack')
  if (env.DISCORD_WEBHOOK_URL) out.push('discord')
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) out.push('telegram')
  if (env.NOTION_TOKEN && env.NOTION_DATABASE_ID) out.push('notion')
  return out
}

// ── Channel senders ──────────────────────────────────────────────────────────
async function sendFeishu(synthesis: string, today: string, env: Env): Promise<void> {
  const { bodies } = renderBrief('feishu', synthesis, today)
  const res = await fetch(env.FEISHU_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodies[0]),
  })
  if (!res.ok) throw new Error(`Feishu ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function sendSlack(synthesis: string, today: string, env: Env): Promise<void> {
  const { bodies } = renderBrief('slack', synthesis, today)
  const res = await fetch(env.SLACK_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodies[0]),
  })
  if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function sendDiscord(synthesis: string, today: string, env: Env): Promise<void> {
  const { bodies } = renderBrief('discord', synthesis, today)
  const res = await fetch(env.DISCORD_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodies[0]),
  })
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// Telegram: sequential await across chunks. Architect-approved exception to
// NFR §9 — concurrent dispatch races and reorders messages, breaking reading
// flow.
async function sendTelegram(synthesis: string, today: string, env: Env): Promise<void> {
  const { bodies } = renderBrief('telegram', synthesis, today)
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
  for (let i = 0; i < bodies.length; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, ...(bodies[i] as object) }),
    })
    if (!res.ok) throw new Error(`Telegram chunk ${i + 1}/${bodies.length} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
}



// Notion: single POST creating a database row. children[] is capped at 100
// per request — typical brief is 5–20 blocks so this is unreachable in
// practice. If a future change pushes briefs past 100 blocks, switch to a
// two-step pattern (POST first 100; PATCH /blocks/{page_id}/children for the rest).
async function sendNotion(synthesis: string, today: string, sourcesCount: number | null, stepDays: number, env: Env): Promise<void> {
  const blocks = markdownToBlocks(synthesis)
  const briefLabel = stepDays >= 30
    ? `MONTHLY BRIEF · ${today.slice(0, 7)}`
    : stepDays >= 7
      ? `WEEKLY BRIEF · ${today}`
      : `TREND BRIEF · ${today}`
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: {
        Title:    { title:  [{ text: { content: briefLabel } }] },
        Date:     { date:   { start: today } },
        Language: { select: { name: 'en' } },
        Sources:  { number: sourcesCount },
      },
      children: blocks.slice(0, 100),
    }),
  })
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function sendOne(channel: Channel, synthesis: string, today: string, env: Env, sourcesCount: number | null, stepDays: number): Promise<void> {
  switch (channel) {
    case 'feishu':   return sendFeishu(synthesis, today, env)
    case 'slack':    return sendSlack(synthesis, today, env)
    case 'discord':  return sendDiscord(synthesis, today, env)
    case 'telegram': return sendTelegram(synthesis, today, env)
    case 'notion':   return sendNotion(synthesis, today, sourcesCount, stepDays, env)
  }
}

// ── digest_sent helpers ──────────────────────────────────────────────────────
async function claimChannels(channels: Channel[], today: string, stepDays: number, env: Env): Promise<DigestSentRow[]> {
  if (channels.length === 0) return []
  const rows = channels.map(channel => ({ channel, anchor_date: today, step_days: stepDays, status: 'pending' }))
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?on_conflict=channel,anchor_date,step_days`,
    {
      method: 'POST',
      headers: {
        ...SB(env),
        'Prefer': 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    },
  )
  if (!res.ok) {
    console.error(`claim failed: ${res.status} — ${(await res.text()).slice(0, 300)}`)
    return []
  }
  const returned: DigestSentRow[] = await res.json()
  return returned
}

async function markSkippedEmpty(channels: Channel[], today: string, stepDays: number, env: Env): Promise<void> {
  if (channels.length === 0) return
  const rows = channels.map(channel => ({
    channel, anchor_date: today, step_days: stepDays, status: 'skipped_empty_brief',
  }))
  // ignore-duplicates: do NOT overwrite a prior 'sent'/'failed' status if brief
  // was deleted mid-day. Only inserts new rows for channels never claimed today.
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?on_conflict=channel,anchor_date,step_days`,
    {
      method: 'POST',
      headers: {
        ...SB(env),
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    },
  )
  if (!res.ok) console.error(`markSkippedEmpty failed: ${res.status} — ${(await res.text()).slice(0, 300)}`)
}

async function updateStatus(id: string, status: 'sent' | 'failed', lastError: string | null, env: Env): Promise<void> {
  const body: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (lastError !== null) body.last_error = lastError
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?id=eq.${id}`,
    { method: 'PATCH', headers: SB(env), body: JSON.stringify(body) },
  )
  if (!res.ok) console.error(`updateStatus ${id} failed: ${res.status}`)
}

async function bulkMarkSent(ids: string[], env: Env): Promise<void> {
  if (ids.length === 0) return
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?id=in.(${ids.join(',')})`,
    {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({ status: 'sent', last_error: null, updated_at: new Date().toISOString() }),
    },
  )
  if (!res.ok) console.error(`bulkMarkSent failed: ${res.status}`)
}

// ── Email delivery ───────────────────────────────────────────────────────────
function buildEmailHtml(synthesis: string, briefLabel: string, subscriberId: string, appUrl: string): string {
  const body = synthesis
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br/>')
  const unsubUrl = `${appUrl}/functions/v1/unsubscribe-email?id=${subscriberId}`
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:640px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.7">
    <p style="font-size:11px;color:#71717a;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">${briefLabel}</p>
    <p>${body}</p>
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0"/>
    <p style="font-size:11px;color:#a1a1aa">You subscribed to trend briefs. <a href="${unsubUrl}" style="color:#71717a">Unsubscribe</a>.</p>
  </body></html>`
}

function buildEmailSubject(briefLabel: string): string {
  return briefLabel
}

async function sendEmailDigests(
  stepDays: number,
  anchorDate: string,
  brief: TrendBriefRow,
  briefLabel: string,
  env: Env,
): Promise<void> {
  if (!env.RESEND_API_KEY || (!brief.synthesis_en && !brief.synthesis_zh)) return

  const subRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/email_subscribers?unsubscribed_at=is.null&select=id,email,lang`,
    { headers: SB(env) },
  )
  if (!subRes.ok) { console.error('email_subscribers fetch failed'); return }
  const subscribers: { id: string; email: string; lang: 'en' | 'zh' }[] = await subRes.json()
  if (subscribers.length === 0) return

  const claims = subscribers.map(s => ({
    subscriber_id: s.id, anchor_date: anchorDate, step_days: stepDays, status: 'pending',
  }))
  const claimRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/email_digest_sent?on_conflict=subscriber_id,anchor_date,step_days`,
    {
      method: 'POST',
      headers: { ...SB(env), 'Prefer': 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(claims),
    },
  )
  if (!claimRes.ok) { console.error('email claim failed'); return }
  const claimed: { id: string; subscriber_id: string }[] = await claimRes.json()
  if (claimed.length === 0) { console.log('All email subscribers already claimed'); return }

  const claimedBySubscriber = new Map(claimed.map(r => [r.subscriber_id, r.id]))
  const appUrl = env.APP_URL ?? ''
  const toSend = subscribers.filter(s => claimedBySubscriber.has(s.id))

  const results = await Promise.allSettled(
    toSend.map(async s => {
      const synthesis = s.lang === 'zh'
        ? (brief.synthesis_zh ?? brief.synthesis_en ?? '')
        : (brief.synthesis_en ?? brief.synthesis_zh ?? '')
      if (!synthesis) throw new Error('no synthesis for lang ' + s.lang)
      const html = buildEmailHtml(synthesis, briefLabel, s.id, appUrl)
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.RESEND_FROM ?? 'Trend Brief <brief@resend.dev>',
          to: [s.email],
          subject: buildEmailSubject(briefLabel),
          html,
        }),
      })
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return s
    }),
  )

  const sentIds: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sub = toSend[i]
    const rowId = claimedBySubscriber.get(sub.id)!
    if (r.status === 'fulfilled') {
      sentIds.push(rowId)
      console.log(`✓ email → ${sub.email}`)
    } else {
      const msg = String((r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason ?? '').slice(0, 500)
      console.error(`✗ email → ${sub.email}: ${msg}`)
      await fetch(`${env.SUPABASE_URL}/rest/v1/email_digest_sent?id=eq.${rowId}`, {
        method: 'PATCH', headers: SB(env),
        body: JSON.stringify({ status: 'failed', last_error: msg, updated_at: new Date().toISOString() }),
      })
    }
  }
  if (sentIds.length > 0) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/email_digest_sent?id=in.(${sentIds.join(',')})`, {
      method: 'PATCH', headers: SB(env),
      body: JSON.stringify({ status: 'sent', updated_at: new Date().toISOString() }),
    })
  }
  console.log(`Email digest ${anchorDate} step_days=${stepDays}: ${sentIds.length}/${claimed.length} sent`)
}

// ── Per-cadence send ─────────────────────────────────────────────────────────
async function sendBriefForStepDays(
  stepDays: number,
  anchorDate: string,
  todayUtcStart: string,
  channels: Channel[],
  env: Env,
): Promise<void> {
  // For daily (stepDays=1): require freshness gate (generated tonight).
  // For weekly/monthly: anchor is always a past date — skip freshness gate.
  let briefUrl =
    `${env.SUPABASE_URL}/rest/v1/trend_briefs` +
    `?anchor_date=eq.${anchorDate}` +
    `&step_days=eq.${stepDays}` +
    `&order=generated_at.desc&limit=1&select=synthesis_en,synthesis_zh,sources_json`
  if (stepDays === 1) {
    briefUrl += `&generated_at=gte.${encodeURIComponent(todayUtcStart)}`
  }

  const briefRes = await fetch(briefUrl, { headers: SB(env) })
  if (!briefRes.ok) {
    console.error(`trend_briefs fetch failed (step_days=${stepDays}): ${briefRes.status} — ${(await briefRes.text()).slice(0, 300)}`)
    return
  }
  const briefs: TrendBriefRow[] = await briefRes.json()
  const brief = briefs[0]

  if (!brief) {
    console.log(`No brief for ${anchorDate} step_days=${stepDays}; marking skipped_empty_brief.`)
    await markSkippedEmpty(channels, anchorDate, stepDays, env)
    return
  }

  const deliverableChannels = channels.filter(c => brief[channelLang(c)])
  if (deliverableChannels.length === 0) {
    console.log(`All channels have null synthesis for ${anchorDate} step_days=${stepDays}; skipping.`)
    await markSkippedEmpty(channels, anchorDate, stepDays, env)
    return
  }

  const claimed = await claimChannels(deliverableChannels, anchorDate, stepDays, env)
  if (claimed.length === 0) {
    console.log(`All channels already claimed for ${anchorDate} step_days=${stepDays}; skipping.`)
    return
  }

  const briefLabel = stepDays >= 30
    ? `MONTHLY BRIEF · ${anchorDate.slice(0, 7)}`
    : stepDays >= 7
      ? `WEEKLY BRIEF · ${anchorDate}`
      : `TREND BRIEF · ${anchorDate}`
  const sourcesCount = Array.isArray(brief.sources_json) ? brief.sources_json.length : null
  const results = await Promise.allSettled(
    claimed.map(row =>
      sendOne(row.channel, brief[channelLang(row.channel)]!, anchorDate, env, sourcesCount, stepDays),
    ),
  )

  const sentIds: string[] = []
  for (let i = 0; i < results.length; i++) {
    const row = claimed[i]
    const r   = results[i]
    if (r.status === 'fulfilled') {
      sentIds.push(row.id)
      console.log(`✓ ${row.channel} (step_days=${stepDays})`)
    } else {
      const msg = String(r.reason?.message ?? r.reason ?? '').slice(0, 500)
      console.error(`✗ ${row.channel} (step_days=${stepDays}): ${msg}`)
      await updateStatus(row.id, 'failed', msg, env)
    }
  }
  await bulkMarkSent(sentIds, env)
  await sendEmailDigests(stepDays, anchorDate, brief, briefLabel, env)
  console.log(`Digest ${anchorDate} step_days=${stepDays}: ${sentIds.length}/${claimed.length} sent`)
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch() {
    return new Response('send-digest is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    const nowUtc        = new Date()
    const todayUtcStart = `${nowUtc.toISOString().slice(0, 10)}T00:00:00Z`
    const anchorDate    = new Date(nowUtc.getTime() - 86_400_000).toISOString().slice(0, 10)
    const channels      = configuredChannels(env)

    if (channels.length === 0) {
      console.log('No channels configured; nothing to send.')
      return
    }

    // Cadence: monthly beats weekly. Max 2 briefs per day. Longer window first.
    const isMonthlyDay = nowUtc.getUTCDate() === 1
    const isWeeklyDay  = nowUtc.getUTCDay() === 1  // Monday
    const stepDaysQueue: number[] = isMonthlyDay ? [30, 1] : isWeeklyDay ? [7, 1] : [1]

    for (const stepDays of stepDaysQueue) {
      await sendBriefForStepDays(stepDays, anchorDate, todayUtcStart, channels, env)
    }
  },
}
