# Delivery Channels — WeCom + Notion — Design Plan

## Context

`send-digest` currently fans out the daily trend brief to four channels: Feishu (ZH), Slack / Discord / Telegram (EN). All four share one architecture: a single operator-side webhook URL or token stored in Cloudflare Worker secrets; per-channel render; per-channel-per-day idempotency via the `digest_sent` table.

Two more channels are now requested:

1. **企业微信 (WeCom) groupchat bot** — extends WeChat reach via the only architecturally clean path (the official WeCom incoming-webhook bot, which can also post into mixed WeCom + personal-WeChat groups).
2. **Notion** — adds a queryable archive surface. Operator maintains one Notion database; each day's brief becomes a new row.

Both channels are operator-side, mirror the existing pattern, and add no per-user infrastructure. Personal-WeChat (no WeCom) remains explicitly out of scope — there is no official webhook API for it; gray-market frameworks are not architecturally defensible.

## Diagnose (5-Dimension Lens)

| Dim | Status |
|---|---|
| 1. Ingestion | N/A — these are output channels, not input. |
| 2. Advanced RAG | N/A. |
| 3. Metrics / Reliability | Per-channel `digest_sent` idempotency already covers WeCom/Notion via the existing UNIQUE (channel, anchor_date) constraint — no schema change needed. New webhook failure modes (Notion rate limits, WeCom bot key revocation) are documented in §6. |
| 4. Flywheel | Notion's row-per-day schema makes the daily brief manually browsable as an archive — useful for the operator when triaging "did the brief look right last Tuesday?" without leaving Notion. Out-of-band benefit. |
| 5. Safety | Both channels carry trend-brief content (LLM-generated, public-facing). No PII surface. WeCom bot key and Notion integration token are operator credentials in CF secrets — same trust boundary as existing four channels. |

## Decisions (locked, per probe)

| Item | Decision |
|---|---|
| WeChat scope | **WeCom bot only.** Personal WeChat (gray-market frameworks) and 公众号 broadcast (OA registration + 4-sends/month limit + opt-in flow) are deferred entirely. |
| Notion shape | **Notion database, one row per day.** "Database" here is a Notion-side concept (a structured view; rows + columns). Operator creates one database, e.g. "AI Trend Briefs"; each day's brief is a new row. Postgres-side: zero new tables; reuse `digest_sent`. |
| Notion auth | **Operator's workspace only.** Single Notion integration token in CF Worker secrets, mirrors Feishu/Slack/Discord/Telegram. No per-user OAuth. |
| Idempotency | Reuse `digest_sent` — `channel` is a TEXT column; just add new values (`wecom`, `notion`). Same UNIQUE (channel, anchor_date) gives us per-channel-per-day claim. |
| Frontend modal | Both channels added to `SubscriptionManualModal`. WeCom uses "join group" framing; Notion uses "read the archive" framing. |

## Architectural reality check

- **No new cron trigger.** Reuses the existing `30 0 * * *` UTC `send-digest` schedule. ✅
- **Token economy:** zero LLM impact. Rendering is deterministic markdown→channel-specific transforms. ✅
- **Subrequest budget:** `send-digest` today uses ~7 subrequests for 4 channels (some chunked). With WeCom + Notion: max ~11 subrequests for 6 channels. Comfortable headroom under CF's 50/invocation. ✅
- **Queue path:** trend brief is generated upstream by `generate-trend-brief`; `send-digest` is a delivery-only fan-out. No queue surface affected. ✅
- **Failure mode (per channel):** any channel failure must NOT block the others. Existing `Promise.allSettled` (or equivalent) pattern in `send-digest` continues per-channel; new channels join the same fan-out. Per-channel `digest_sent` row records `failed` with `last_error`; operator triages via SQL.

## Recommended approach

### 1. WeCom bot integration

**Mechanism:** WeCom incoming webhook — operator creates a bot in any WeCom group, gets a webhook URL like `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>`, pastes the URL into CF Worker secrets.

**Body shape (markdown):**
```ts
{
  msgtype: 'markdown',
  markdown: { content: '<rendered markdown>' }
}
```

**Markdown subset (WeCom-supported):**
- `# title` / `## subtitle` (heading levels 1–6)
- `**bold**`
- `> blockquote`
- `[text](url)` (links)
- `` `inline code` ``
- Plain paragraphs separated by `\n\n`

**Differs from Feishu's `lark_md`:**
- WeCom does NOT support `lark_md` color tags or interactive cards. Plain markdown only.
- WeCom does NOT support tables.
- For our brief content (paragraphs + bold + occasional bullets), the conversion is: take the EN/ZH brief, pass through unchanged. The brief generator already emits a markdown subset that is a clean intersection of all channels.

**Length cap:** WeCom enforces ≤4096 **bytes** UTF-8 per message. Chinese characters are 3 bytes; ~1300 ZH chars per message in worst case. Long briefs require chunking.

**Chunking strategy:** identical to existing Telegram pattern — split at `\n\n` paragraph boundaries; pack chunks ≤3500 bytes (safety margin under 4096); send sequentially via `await` (NOT `Promise.all`) to preserve order. Reuse the Telegram chunking helper if extracted, otherwise inline the same logic.

**Render function** (`workers/send-digest/src/render-wecom.ts`, new):
```ts
export function renderWecom(brief: { synthesis_zh: string; anchor_date: string }): string {
  // ZH brief; the LLM already emits markdown that WeCom understands.
  return brief.synthesis_zh
}
```

**Send function** (added to `workers/send-digest/src/index.ts`):
```ts
async function sendWecom(env: Env, content: string, anchorDate: string): Promise<void> {
  const chunks = chunkMarkdown(content, 3500)  // bytes, not chars
  for (const chunk of chunks) {
    const r = await fetch(env.WECOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: chunk } }),
    })
    if (!r.ok) throw new Error(`WeCom ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const body: any = await r.json()
    if (body.errcode !== 0) throw new Error(`WeCom errcode=${body.errcode}: ${body.errmsg ?? '(none)'}`)
  }
}
```

**WeCom-specific failure modes:**
- `errcode 93000`: bot key invalid/revoked. Operator regenerates in WeCom admin and updates the secret.
- `errcode 45009`: rate limit (20 messages/min per bot). Should never trigger for one daily brief; if it does, the per-message-chunk wait pattern naturally rate-limits.
- 5xx from `qyapi.weixin.qq.com`: transient; existing retry logic in `send-digest` (if any) handles. If no retry today, do not add — `digest_sent` claim makes the next cron tick re-attempt safely.

### 2. Notion integration

**Mechanism:** Notion API integration token + target database ID, both in CF Worker secrets. Each daily run creates one new database row (a Notion "page" inside the database) with the brief body as page content.

**Operator one-time setup:**
1. Create a new Notion **integration** in [www.notion.so/my-integrations](https://www.notion.so/my-integrations) — "Internal" type, capabilities: "Insert content," "Read content." Copy the secret token (`secret_...`).
2. Create a new Notion **database** in the operator's workspace, e.g. "AI Trend Briefs," with these properties:
   - `Title` (title) — auto-populated with `TREND BRIEF · YYYY-MM-DD` per row
   - `Date` (date) — anchor_date
   - `Language` (select) — `zh` | `en`
   - `Sources` (number) — count of source articles
3. **Share the database with the integration** (Notion's `Share → Add connections → <integration name>`). Without this step, the API returns 404.
4. Copy the database ID from the URL (`notion.so/<workspace>/<database-id>?v=...` — the database-id segment).
5. Set CF Worker secrets:
   ```
   wrangler secret put NOTION_TOKEN
   wrangler secret put NOTION_DATABASE_ID
   ```

**API call shape:**
```ts
POST https://api.notion.com/v1/pages
Authorization: Bearer <NOTION_TOKEN>
Notion-Version: 2022-06-28
Content-Type: application/json

{
  "parent": { "database_id": "<NOTION_DATABASE_ID>" },
  "properties": {
    "Title":    { "title":  [{ "text": { "content": "TREND BRIEF · 2026-04-26" } }] },
    "Date":     { "date":   { "start": "2026-04-26" } },
    "Language": { "select": { "name": "zh" } },
    "Sources":  { "number": 12 }
  },
  "children": [ <block>, <block>, ... ]   // up to 100 per request
}
```

**Markdown→Notion blocks parser** (`workers/send-digest/src/notion-blocks.ts`, new, ~60 lines):

The brief is paragraphs + occasional `**bold**` + occasional `- ` bullets + occasional `## ` subheads. A small inline parser is sufficient — no library dependency.

```ts
type RichText = { type: 'text'; text: { content: string }; annotations?: { bold?: boolean } }
type Block =
  | { type: 'paragraph'; paragraph: { rich_text: RichText[] } }
  | { type: 'heading_2'; heading_2: { rich_text: RichText[] } }
  | { type: 'bulleted_list_item'; bulleted_list_item: { rich_text: RichText[] } }

export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = []
  const paragraphs = md.split(/\n\s*\n/)
  for (const p of paragraphs) {
    const trimmed = p.trim()
    if (!trimmed) continue

    // Heading
    if (/^#{1,3}\s/.test(trimmed)) {
      blocks.push({ type: 'heading_2', heading_2: { rich_text: parseInline(trimmed.replace(/^#{1,3}\s/, '')) } })
      continue
    }
    // Bulleted list (one or more lines)
    const lines = trimmed.split('\n')
    if (lines.every(l => /^\s*[-•]\s/.test(l))) {
      for (const line of lines) {
        blocks.push({
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: parseInline(line.replace(/^\s*[-•]\s/, '')) },
        })
      }
      continue
    }
    // Paragraph
    blocks.push({ type: 'paragraph', paragraph: { rich_text: parseInline(trimmed) } })
  }
  return blocks
}

function parseInline(text: string): RichText[] {
  // Split on **bold** segments; preserve order.
  const out: RichText[] = []
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push({ type: 'text', text: { content: part.slice(2, -2) }, annotations: { bold: true } })
    } else {
      out.push({ type: 'text', text: { content: part } })
    }
  }
  return out
}
```

**100-block limit handling:** Notion's POST `/pages` accepts up to 100 children per call. A trend brief is typically 5–20 blocks; this limit is unreachable in practice. If a future change makes briefs longer than 100 blocks, switch to a two-step pattern (POST `/pages` with first 100 blocks; PATCH `/blocks/<page_id>/children` for the rest).

**Send function** (added to `workers/send-digest/src/index.ts`):
```ts
async function sendNotion(env: Env, brief: TrendBrief): Promise<void> {
  const blocks = markdownToBlocks(brief.synthesis_en)  // EN brief for Notion
  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: {
        Title:    { title:  [{ text: { content: `TREND BRIEF · ${brief.anchor_date}` } }] },
        Date:     { date:   { start: brief.anchor_date } },
        Language: { select: { name: 'en' } },
        Sources:  { number: brief.sources_count ?? null },
      },
      children: blocks.slice(0, 100),
    }),
  })
  if (!r.ok) throw new Error(`Notion ${r.status}: ${(await r.text()).slice(0, 200)}`)
}
```

**Notion-specific failure modes:**
- `404`: integration not shared with the database. Operator runs `Share → Add connections` in Notion. Most common first-deploy error.
- `401`: token revoked or wrong. Regenerate in Notion integration settings; update secret.
- `429`: rate limit (3 req/s). Will not trigger for one daily call.
- Schema mismatch (e.g., property name `Sources` doesn't exist on the database): `400 validation_error`. Operator must match the database properties exactly to the spec above.

### 3. `send-digest` worker — extend the channel iterator

**File:** `workers/send-digest/src/index.ts`

Today's iterator (pseudocode):
```ts
const channels = ['feishu', 'slack', 'discord', 'telegram']
for (const channel of channels) {
  await deliverChannel(channel, brief)
}
```

Tomorrow:
```ts
const channels = ['feishu', 'slack', 'discord', 'telegram', 'wecom', 'notion']
// Existing per-channel claim → render → send → mark sent/failed pattern unchanged.
// Per-channel branch:
case 'wecom':  await sendWecom(env, brief.synthesis_zh, brief.anchor_date); break
case 'notion': await sendNotion(env, brief); break
```

Per-channel failure isolation: existing `try/catch` per channel + `digest_sent` row update remains. WeCom or Notion failure cannot block the other four.

### 4. `digest_sent` and channel_invites — schema housekeeping

**File:** `supabase/sql/20260429_delivery_channels_wecom_notion.sql` (new)

```sql
-- ── digest_sent CHECK constraint widening ──────────────────────────────────
-- Today's table doesn't enforce a CHECK on digest_sent.channel (it's a free-form text)
-- so this section is a no-op IF no constraint was added in 20260424. If a CHECK exists,
-- drop and recreate to include the new values:
alter table public.digest_sent drop constraint if exists digest_sent_channel_check;
-- (no new check added — keep channel free-form so future channels don't require migrations)

-- ── channel_invites widening ──────────────────────────────────────────────
-- The existing CHECK constraint restricts channel to the original four; widen it.
alter table public.channel_invites drop constraint channel_invites_channel_check;
alter table public.channel_invites
  add constraint channel_invites_channel_check
  check (channel in ('feishu','slack','discord','telegram','wecom','notion'));

-- Seed rows (operator fills invite_url via dashboard later; empty = hidden in modal)
insert into public.channel_invites (channel, language, display_label) values
  ('wecom',  'zh', null),
  ('notion', 'en', 'AI Trend Briefs Notion archive')
on conflict (channel) do nothing;
```

### 5. `SubscriptionManualModal` — two new channels in the rail

**File:** `news-app/components/SubscriptionManualModal.tsx`

Add WeCom + Notion to the existing channel array; add their copy to `STRINGS`.

**WeCom pane** (ZH default):
- Step 1: 接受 News Project 企业微信群邀请 → `[ Join WeCom group → ]` (operator-shared invite URL)
- Step 2: 群里每天会自动收到 AI 趋势简报。
- Step 3: 不再需要手动获取，关闭群通知免打扰即可。

**Notion pane** (EN default):
- Step 1: Open the AI Trend Briefs Notion database → `[ Open archive → ]` (operator-shared workspace URL)
- Step 2: Each daily brief is a new row, sortable by date and language.
- Step 3: Read on Notion web, mobile, or duplicate the database to your own workspace.

The `LANG` badge in the left rail shows `ZH` for WeCom (matches the brief language sent to that channel) and `EN` for Notion. Same pattern as Feishu/Slack/etc.

**Empty-state behavior** (per the trend-brief subscription manual addendum): if the operator hasn't filled `invite_url` for either new channel, that row is hidden from the rail. If all six rows have empty `invite_url`, the existing fallback copy from the addendum applies.

### 6. Doc updates

**File:** `docs/api-keys-and-env.md` (modified)

Append two new entries under `send-digest` worker secrets:
- `WECOM_WEBHOOK_URL` — full URL `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`
- `NOTION_TOKEN` — `secret_...` from Notion integration settings
- `NOTION_DATABASE_ID` — UUID-like ID from the Notion database URL

**File:** `docs/current-state.md` (modified)

Update the `send-digest` row:
> Trend-brief-only delivery. Feishu (ZH) + optional Slack/Discord/Telegram (EN) + **WeCom (ZH)** + **Notion (EN, archival database row per day)**.

**File:** `docs/keep-in-mind.md`

Append a "Delivery channel onboarding" section listing the three secrets and the Notion-specific gotcha.
