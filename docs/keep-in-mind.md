# Keep In Mind

This file exists so that fixes and lessons learned across multiple conversations are captured once.
Before helping with any task in this project, read this file first.
Every entry here was discovered the hard way — do not repeat these mistakes.

---

## Cloudflare Workers — Local Testing

### The correct way to test a worker locally (do this from day one)

**Always use these flags together:**
```bash
wrangler dev --remote --test-scheduled
```

Then trigger the scheduled handler:
```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

**Why `--remote`:** Worker secrets set via `wrangler secret put` are stored in Cloudflare's cloud. Local dev mode (`wrangler dev` without `--remote`) does not have access to them. Without `--remote`, any line that uses `env.SUPABASE_URL` or similar will throw `TypeError: Invalid URL string` because the value is undefined.

**Why `--test-scheduled`:** Without this flag, the `/__scheduled` endpoint returns 200 but does NOT actually run the scheduled handler. The response takes ~2ms (a dead giveaway it didn't run). With this flag, it runs the real handler.

**Without both flags:** You will waste time debugging errors that are purely an artifact of the local dev environment, not real bugs.

---

## Cloudflare Workers — Required Setup Per Worker

Every worker needs these 4 files. Missing any one will cause errors.

```
workers/<worker-name>/
├── wrangler.toml       ← name, main, cron trigger
├── tsconfig.json       ← must reference @cloudflare/workers-types
├── package.json        ← created by npm init -y
└── src/index.ts        ← must export BOTH fetch() and scheduled()
```

### `tsconfig.json` (required for TypeScript types)
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "bundler",
    "strict": false,
    "noUnusedLocals": false
  }
}
```

### Install types (run once per worker directory)
```bash
npm init -y
npm install -D @cloudflare/workers-types typescript
```

### Every worker must export a `fetch` handler
Even if the worker only uses cron triggers, `wrangler dev` requires a `fetch` export or it throws:
`Error: Handler does not export a fetch() function.`

Add this stub to every worker:
```typescript
async fetch(request: Request, env: Env, ctx: ExecutionContext) {
  return new Response('ok')
},
```

---

## Cloudflare Workers — Setting Secrets

Secrets are set per worker. If you haven't `cd`'d into the worker directory, use `--name`:

```bash
wrangler secret put SUPABASE_URL --name ingest-rss
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name ingest-rss

wrangler secret put SUPABASE_URL --name embed-batch
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name embed-batch
wrangler secret put COHERE_API_KEY --name embed-batch

# process-queue is now a Supabase Edge Function — set secrets via supabase CLI, not wrangler
# See docs/instructions.md → process-queue section
```

Verify secrets are set (values stay hidden):
```bash
wrangler secret list --name ingest-rss
```

---

## Cloudflare Workers — Deploying

```bash
cd workers/ingest-rss && wrangler deploy
cd workers/embed-batch && wrangler deploy
# process-queue: supabase functions deploy process-queue
```

Deploy must be run from inside the worker directory (where `wrangler.toml` lives), or pass `--name`.

---

## Supabase — Data API & RLS Settings

- **Enable Data API:** Yes, always. Required for both Cloudflare Workers (REST calls) and the Expo frontend (supabase-js).
- **Enable automatic RLS:** Yes. Only affects future tables — does not retroactively change existing ones.
- **RLS (current state):** All 3 tables have RLS enabled. `daily_news` and `sources` have `public_read_*` policies (anon key can read). `raw_ingestion` has no policies — locked to service role only. See `docs/schema.md` for the exact policy SQL.

---

## Supabase — RLS Blocks Anon Key Even With No Error

**What happened:** The Expo frontend (using the anon key) fetched `sources` and got back `[]` — an empty array with no error. The table had 10 rows in it. Spent multiple sessions debugging why source names showed as `undefined`.

**Root cause:** RLS was enabled on the `sources` table but the `public_read_sources` policy was never created. PostgREST silently returns 0 rows (not an error) when RLS filters everything out for the anon key. The Cloudflare Workers (which use the service role key) were unaffected because the service role bypasses RLS entirely — so the ingestion pipeline worked fine while the frontend couldn't read the same table.

**How to detect immediately:**
```sql
SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'sources';
-- If this returns no rows, the anon key cannot read that table.
```

**Fix:**
```sql
CREATE POLICY "public_read_sources"
  ON sources FOR SELECT
  USING (true);
```

**Rule for every new table:** As soon as you create a table and enable RLS, immediately decide which policies it needs. If the Expo frontend (anon key) needs to read it, add `FOR SELECT USING (true)`. If only workers need it (service role), add no policy and leave it locked.

**PostgREST embedded joins and schema cache:** A separate but related issue: selecting multiple columns from an embedded join (e.g. `sources(name, source_type)`) silently returns `null` for the entire joined object if PostgREST's schema cache doesn't recognise a column. Columns added via `ALTER TABLE` after the schema cache was last built are the usual culprit. Single-column joins (e.g. `sources(name)`) tend to be more forgiving. The workaround: fetch the related table separately and build a client-side lookup map — avoids the join entirely and is immune to schema cache staleness.

**FlatList + async state:** When `renderItem` depends on state that loads asynchronously (like a `sourceMap` populated after mount), FlatList will NOT re-render existing items unless you pass `extraData`:
```tsx
<FlatList extraData={[sourceMap, lang]} ... />
```
Without `extraData`, items render once with the empty initial state and never update.

---

## Project Phase Status

All pipeline stages through Stage 3 (UI redesign) are complete and deployed. Stage 4 (web deployment via Cloudflare Pages) is next.

See `current-state.md` for the live deployment status of every component.

---

## Cloudflare Workers — Subrequest Limit (Free Tier)

Free tier allows **50 subrequests per invocation**. Each `fetch()` call counts as one.

Current counts: ingest-builders ~38/50. (process-queue moved to Supabase Edge Function — no CF subrequest limit applies)

Upgrade path: Cloudflare Workers Paid ($5/mo) raises limit to 1,000 subrequests.

---

## Every New Worker Needs This Setup (run once per worker)

```bash
cd workers/<name>
npm init -y
npm install -D @cloudflare/workers-types typescript
```

Create `tsconfig.json` (see template in this file above).
Add a stub `fetch` handler alongside `scheduled` (required by wrangler dev).

---

## Recovering Stuck 'processing' Rows

If a worker crashes mid-run (e.g., subrequest limit hit), rows get stuck in `processing` status and are never picked up again. Symptom: worker says "No pending articles" but `daily_news` has fewer rows than expected.

Fix — run this in Supabase SQL Editor:
```sql
UPDATE raw_ingestion SET status = 'pending' WHERE status = 'processing';
```

Then re-trigger the worker. Safe to run anytime — rows that genuinely finished will be in `done` status, not `processing`.

---

## Supabase Edge Functions — External Webhook Receivers

When an external service (e.g. Apify, Stripe, GitHub) POSTs to a Supabase Edge Function, **always deploy with `--no-verify-jwt`:**

```bash
supabase functions deploy <function-name> --no-verify-jwt
```

By default, Supabase validates the `Authorization` header as a Supabase JWT. External webhooks send their own Bearer token — Supabase rejects it as an invalid JWT and returns 401 before your code even runs.

**Apify-specific gotchas:**
- "Send test notification" in Apify sends a fake payload (Chuck Norris joke in `resource`, no `datasetId`) — 400 on test is expected and safe to ignore
- Real `RUN_SUCCEEDED` payloads include `resource.defaultDatasetId` — that's the dataset to fetch
- Authorization header in Apify's Headers template must be JSON format: `{"Authorization": "Bearer your-secret"}`

---

## Worker Testing Sequence (do this every time)

1. `cd workers/<name>`
2. `wrangler dev --remote --test-scheduled`
3. In a second terminal: `curl "http://localhost:8787/__scheduled?cron=..."`
4. Watch the first terminal for `console.log` output
5. Check Supabase Table Editor to confirm rows were written
6. Run the curl a second time — row count must NOT increase (idempotency check)

---

## The Live AI Model Is Not in Git History

`OPENROUTER_MODEL` and `OPENROUTER_BIO_MODEL` are Cloudflare Worker secrets. The active model in production is invisible to `git log`. Before debugging a summarization quality regression, always check the active model: run `wrangler secret list --name process-queue` (confirms the secret exists but not its value — check the OpenRouter dashboard request logs for the actual model string).

If temporarily adding `console.log('Model:', env.OPENROUTER_MODEL)` to debug, remove it before committing.

To swap models without redeployment:
```bash
wrangler secret put OPENROUTER_MODEL --name process-queue
# paste new model ID (e.g. qwen/qwen3-235b-a22b:free)
# Takes effect on next cron cycle automatically
```

---

## AI Keyword Matching — Word Boundary vs. Substring

**The `ai` substring trap:** Never match the string `"ai"` without word boundaries in English text. The substring `ai` appears in: `said`, `main`, `train`, `gained`, `explain`, `remain`, `railroad`, `certain`, and countless other common English words. A regex like `/ai/i` without boundaries would match virtually any English sentence, rendering the AI relevance filter useless.

**Rule:** English AI keywords must use `/\bword\b/i` regex with explicit word boundaries on both sides. The `EN_AI_KEYWORDS` constant in `workers/process-queue/src/index.ts` uses `\b...\b` around every term.

**Exception — Chinese:** Chinese script has no word boundaries (characters are not separated by spaces or punctuation). Chinese AI keywords in `ZH_AI_KEYWORDS` use plain `.includes()` substring matching — this is correct and intentional. Chinese characters are granular enough that false-positive risk is negligible.

**Affected code:** `EN_AI_KEYWORDS` and `ZH_AI_KEYWORDS` constants in `supabase/functions/process-queue/index.ts`, used by `hasAISignal()`.

---

## Digest Channels — Markdown Dialects Are Not Interchangeable

The trend-brief LLM emits CommonMark (`**bold**`, `\n\n` paragraphs). Each digest channel speaks a different dialect, and the wrong one ships either literal asterisks or a broken message.

| Channel | Bold syntax | What breaks if you ship CommonMark `**X**` raw |
|---|---|---|
| Feishu (`lark_md`) | `**X**` ✅ | nothing — `lark_md` is a CommonMark superset |
| Slack (`mrkdwn`) | `*X*` (single asterisk) | `**X**` shows as literal text; readers see `**verdict**` |
| Discord embed `description` | `**X**` ✅ | nothing — standard MD works |
| Telegram `MarkdownV2` | `*X*` (single asterisk) but `*` MUST be escaped elsewhere | escaping `*` blindly turns `**X**` into `\*\*X\*\*` (literal); slicing the escaped string can split a `\X` pair → 400 `can't parse entities` |
| Telegram `HTML` | `<b>X</b>` ✅ | only `<`, `>`, `&` need escaping — far simpler than MarkdownV2 |

**Rule:** `workers/send-digest/src/render.ts` converts CommonMark per channel:
- `slackifyMd`: `**X**` → `*X*`
- Telegram: `htmlEscape` then `tgBoldify` (`**X**` → `<b>X</b>`), with `parse_mode: 'HTML'`
- Discord & Feishu: pass through

**Length:** A 2K-token brief is ~6–8K chars — exceeds every channel's single-message limit. Chunk at `\n\n` paragraph boundaries (Slack ≤ 2900/block, Discord ≤ 4000/embed, Telegram ≤ 3500/message). For Telegram, send chunks **sequentially** so messages arrive in reading order.
