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
}

interface TrendBriefRow {
  synthesis_en: string | null
  synthesis_zh: string | null
  sources_json: unknown[] | null         // used by Notion to populate Sources count
}

interface DigestSentRow {
  id: string
  channel: Channel
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
async function sendNotion(synthesis: string, today: string, sourcesCount: number | null, env: Env): Promise<void> {
  const blocks = markdownToBlocks(synthesis)
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
        Title:    { title:  [{ text: { content: `TREND BRIEF · ${today}` } }] },
        Date:     { date:   { start: today } },
        Language: { select: { name: 'en' } },
        Sources:  { number: sourcesCount },
      },
      children: blocks.slice(0, 100),
    }),
  })
  if (!res.ok) throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function sendOne(channel: Channel, synthesis: string, today: string, env: Env, sourcesCount: number | null): Promise<void> {
  switch (channel) {
    case 'feishu':   return sendFeishu(synthesis, today, env)
    case 'slack':    return sendSlack(synthesis, today, env)
    case 'discord':  return sendDiscord(synthesis, today, env)
    case 'telegram': return sendTelegram(synthesis, today, env)
    case 'notion':   return sendNotion(synthesis, today, sourcesCount, env)
  }
}

// ── digest_sent helpers ──────────────────────────────────────────────────────
async function claimChannels(channels: Channel[], today: string, env: Env): Promise<DigestSentRow[]> {
  if (channels.length === 0) return []
  const rows = channels.map(channel => ({ channel, anchor_date: today, status: 'pending' }))
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?on_conflict=channel,anchor_date`,
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

async function markSkippedEmpty(channels: Channel[], today: string, env: Env): Promise<void> {
  if (channels.length === 0) return
  const rows = channels.map(channel => ({
    channel, anchor_date: today, status: 'skipped_empty_brief',
  }))
  // ignore-duplicates: do NOT overwrite a prior 'sent'/'failed' status if brief
  // was deleted mid-day. Only inserts new rows for channels never claimed today.
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/digest_sent?on_conflict=channel,anchor_date`,
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

// ── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch() {
    return new Response('send-digest is running')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    // anchorDate = yesterday UTC. The 00:30 UTC delivery covers the UTC day that
    // just closed (8 PM EDT yesterday → 8 PM EDT today during DST). Fires 5 min
    // after the 00:25 UTC pg_cron pre-warm of generate-trend-brief, which writes
    // the trend_briefs row keyed on this same anchor_date.
    const nowUtc = new Date()
    const todayUtcStart = `${nowUtc.toISOString().slice(0, 10)}T00:00:00Z`
    const anchorDate = new Date(nowUtc.getTime() - 86_400_000).toISOString().slice(0, 10)
    const channels = configuredChannels(env)

    if (channels.length === 0) {
      console.log('No channels configured; nothing to send.')
      return
    }

    // 1. Fetch the brief for yesterday's anchor with freshness gate (must be
    // generated by tonight's pre-warm, not a stale cached row)
    const briefRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/trend_briefs` +
      `?anchor_date=eq.${anchorDate}` +
      `&step_days=eq.1` +
      `&generated_at=gte.${encodeURIComponent(todayUtcStart)}` +
      `&order=generated_at.desc&limit=1&select=synthesis_en,synthesis_zh,sources_json`,
      { headers: SB(env) },
    )
    if (!briefRes.ok) {
      console.error(`trend_briefs fetch failed: ${briefRes.status} — ${(await briefRes.text()).slice(0, 300)}`)
      return
    }
    const briefs: TrendBriefRow[] = await briefRes.json()
    const brief = briefs[0]

    // 2. Empty-brief fallback — spec §2
    if (!brief) {
      console.log(`No brief for ${anchorDate}; marking skipped_empty_brief on ${channels.join(',')}`)
      await markSkippedEmpty(channels, anchorDate, env)
      return
    }

    // 3. Filter channels whose target language is null — spec §2 "null target rule"
    const deliverableChannels = channels.filter(c => brief[channelLang(c)])
    if (deliverableChannels.length === 0) {
      console.log(`All configured channels have null target language for ${anchorDate}; skipping.`)
      await markSkippedEmpty(channels, anchorDate, env)
      return
    }

    // 4. Claim (idempotent insert). Only deliver to channels we actually claimed.
    const claimed = await claimChannels(deliverableChannels, anchorDate, env)
    if (claimed.length === 0) {
      console.log(`All channels already claimed for ${anchorDate}; skipping.`)
      return
    }

    // 5. Parallel sends
    const sourcesCount = Array.isArray(brief.sources_json) ? brief.sources_json.length : null
    const results = await Promise.allSettled(
      claimed.map(row => sendOne(row.channel, brief[channelLang(row.channel)]!, anchorDate, env, sourcesCount)),
    )

    // 6. Status updates — batch sent, individual failed (to preserve last_error)
    const sentIds: string[] = []
    for (let i = 0; i < results.length; i++) {
      const row = claimed[i]
      const r = results[i]
      if (r.status === 'fulfilled') {
        sentIds.push(row.id)
        console.log(`✓ ${row.channel}`)
      } else {
        const msg = String(r.reason?.message ?? r.reason ?? '').slice(0, 500)
        console.error(`✗ ${row.channel}: ${msg}`)
        await updateStatus(row.id, 'failed', msg, env)
      }
    }
    await bulkMarkSent(sentIds, env)

    console.log(`Digest ${anchorDate}: ${sentIds.length}/${claimed.length} sent`)
  },
}
