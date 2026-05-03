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

## pg_cron → Edge Function Authentication

**Never add a manual `Authorization` header check inside an Edge Function called by pg_cron.**

The Supabase Edge Runtime validates the JWT at the gateway level before `Deno.serve()` runs. By the time your handler executes, the caller is already authenticated. A manual check like:

```ts
const authHeader = req.headers.get('Authorization') ?? ''
if (authHeader !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`) {
  return new Response('Unauthorized', { status: 401 })
}
```

will **always fail** — the Edge Runtime processes the Authorization header before Deno sees it, so `req.headers.get('Authorization')` does not return the raw JWT string you expect. The function silently rejects every pg_cron tick with 401 and the queue stops.

**How to call a JWT-verified Edge Function from pg_cron (the correct pattern):**

1. Store the service role key in Vault:
   ```sql
   select vault.create_secret('<service_role_jwt>', 'service_role_key', 'pg_cron auth');
   ```
2. In the pg_cron schedule, look it up at call time:
   ```sql
   select cron.schedule('job-name', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/<function>',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb
     );
   $$);
   ```
3. Do NOT add any auth check inside the function — the gateway handles it.

**Diagnostic:** If pg_cron fires but the Edge Function returns 401 with `sb_error_code: UNAUTHORIZED_NO_AUTH_HEADER`, the Vault lookup returned NULL (secret name mismatch or secret not created). Verify with: `select name from vault.decrypted_secrets;`.

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

---

## Supabase — Closed-Beta Auth Gate (Round 1) Lessons

These six items were all surfaced shipping the closed-beta invite-link gate ([spec](superpowers/specs/2026-04-26-beta-auth-gate-design.md), shipped 2026-04-28). Each one cost a real debugging session. Read before touching anything that uses `signInAnonymously()`, Edge Function CORS, or `app_metadata`.

### 1. Anonymous sign-ins are OFF by default in newer Supabase projects

**Symptom:** `signInAnonymously()` returns `{ code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled' }` (HTTP 422).

**Fix:** Dashboard → Authentication → Sign In / Sign Up → **Anonymous Sign-Ins → ON → Save.** Then hard-reload the calling page.

**Rule:** Any feature that mints anonymous users (closed-beta gates, ephemeral guest sessions) requires this toggle as a project pre-req. Treat it like a secret you'd document in `api-keys-and-env.md` — if a project doesn't have it set, the feature is dead.

### 2. CAPTCHA + anonymous sign-ins are mutually exclusive without a widget

**Symptom:** `500: captcha verification process failed` — error string only visible in Auth Logs (Logs → Auth Logs in dashboard); the HTTP body just says `unexpected_failure`.

**Root cause:** Supabase's CAPTCHA protection enforces a `captcha_token` on every signup, including the no-email-no-password call that backs `signInAnonymously()`. We don't ship a CAPTCHA widget on the gate.

**Fix for invite-only beta:** Authentication → Attack Protection → **Captcha protection → OFF**. The invite code is already the access control — adding CAPTCHA on top buys nothing.

**Rule:** When you reach for "open up to public signup," that's also when you turn CAPTCHA back ON and wire hCaptcha/Turnstile into the gate. Until then it's strictly worse than having it off.

### 3. `handle_new_user` triggers must branch on `new.is_anonymous`

**Symptom:** `{ code: 'unexpected_failure', message: 'Database error creating anonymous user' }` (HTTP 500). The signup endpoint reaches the database; a trigger errors out; Supabase swallows the trigger error and surfaces the generic message.

**How to diagnose:**
```sql
select t.tgname, p.proname, pg_get_functiondef(p.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;
```

**Common shape that fails:** a function that inserts into `public.user_tokens` / `public.profiles` / similar with columns the anonymous user can't satisfy (e.g. NOT NULL `email`).

**Fix:**
```sql
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_anonymous then return new; end if;   -- skip for beta users
  insert into public.user_tokens (user_id, balance) values (new.id, 500);
  return new;
end; $$;
```

**Rule:** Any project with a row-creation trigger on `auth.users` needs `is_anonymous` branching as soon as it adopts anonymous sign-ins. Forgetting this turns every signup into a 500 with a useless error message.

### 4. Edge Function CORS for `supabase-js` callers needs `apikey, x-client-info`

**Symptom:** Browser console: `Failed to load resource: Request header field apikey is not allowed by Access-Control-Allow-Headers.` Function never runs; preflight fails.

**Root cause:** `supabase-js` adds an `apikey` header (and on some versions `x-client-info`) automatically alongside `Authorization` when calling Edge Functions. `Access-Control-Allow-Headers: 'authorization, content-type'` is not enough.

**Fix:**
```ts
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
```

**Rule:** Every new Edge Function called from `supabase-js` needs all four headers in the CORS allowlist. Existing functions called from raw `fetch` (e.g. `ingest-apify-tweets` from Apify) don't need this — but anything the Expo frontend hits via `supabase.functions.invoke()` does.

### 5. `refreshSession()` race conditions with fresh anonymous JWTs

**Symptom:** Immediately after calling `signInAnonymously()` and redeeming an invite, the UI calls `refreshSession()` to update the JWT's `app_metadata`. The user is silently signed out and stuck at the gate.

**Root cause:** If `refreshSession()` is called on a JWT that was minted only milliseconds ago, Supabase's auth service may reject the refresh attempt (likely due to internal clock skew or rate-limiting guards on token reuse). When `refreshSession()` fails with these specific errors, the Supabase JS client automatically calls `_removeSession()`, wiping the session from localStorage and firing a `SIGNED_OUT` event.

**Fix:** Never call `refreshSession()` immediately after a sign-in or within the same UI bootstrap loop. Rely on `getUser()` to check live metadata, and let the background token refresh (or the next organic app reload) naturally mint the new JWT.

### 6. RLS `UPDATE` policies and the `RETURNING` clause trap

**Symptom:** A `supabase.from('qa_logs').update().eq('id', id).select('id')` call returns `[]` (0 rows updated), but no permission error is thrown, and examining the database shows the row *was* actually updated!

**Root cause:** PostgREST translates `.update().select('id')` into `UPDATE ... RETURNING id`. Crucially, **the `RETURNING` clause is subject to the `SELECT` RLS policy, not just the `UPDATE` policy.** If your `UPDATE` policy passes but your `SELECT` policy fails (e.g., due to a `security definer` function returning false in the updated context), Postgres will update the row but return an empty result set. Supabase JS interprets this as "0 rows matched".

**Rule:** Keep `SELECT` and `UPDATE` policies as simple as possible. Avoid using complex `security definer` functions (like `is_beta_user()`) inside `UPDATE` or `SELECT` policies where `user_id = auth.uid()` alone provides mathematical security.

### 7. Postgres has no `base64url` encoding

**Symptom:** `encode(gen_random_bytes(N), 'base64url')` returns `ERROR:  unrecognized encoding: "base64url"`. Postgres `encode()` only supports `base64`, `escape`, `hex`.

**Fix for URL-safe random codes:**
```sql
replace(replace(replace(
  encode(gen_random_bytes(12), 'base64'),
  '+', '-'), '/', '_'), '=', '')
```

**Rule:** Any operator runbook or generated-column default that needs URL-safe random tokens uses the explicit replace chain. `hex` is also URL-safe but doubles the character count; pick `base64` + replace if you want short codes (12 bytes → 16 chars).

---

## Delivery Channels — WeCom + Notion Onboarding

These two channels were added 2026-04-29 ([spec](superpowers/specs/2026-04-29-delivery-channels-wecom-notion-design.md)). Both are operator-side and mirror the existing Feishu/Slack/Discord/Telegram pattern, but each has one onboarding gotcha that's easy to miss.

### Hosting the WeCom QR image (frontend)

WeCom group invites are **QR codes**, not click-to-join URLs. The
`SubscriptionManualModal` renders `channel_invites.invite_url` as an inline
`<Image>` for the wecom row — so for that one channel, `invite_url` is an
HTTPS image URL (PNG/JPG of the QR), not a clickable link.

**Recommended host:** Supabase Storage public bucket (e.g. `public-assets`).
1. Storage → New bucket → name: `public-assets` → **Public** access.
2. Upload the WeCom group QR image (export from WeCom mobile app: 群聊 →
   群机器人 / 邀请二维码 → save image).
3. Copy the public URL: `https://<ref>.supabase.co/storage/v1/object/public/public-assets/wecom-qr.png`.
4. `update channel_invites set invite_url = '<that-url>' where channel = 'wecom';`

**Alternative hosts:** any public HTTPS image URL — GitHub raw (`raw.githubusercontent.com/...`), Cloudflare R2 with public bucket, Imgur. Avoid private hosts that 403 anonymous browsers.

**Re-upload triggers:** WeCom regenerates the QR if the group changes
member-set significantly, the bot is replaced, or an external-customer-group
invite hits its 7-day expiry. Same operational pattern as the Feishu invite
refresh — operator monitors `digest_sent.last_error` for 93000-class WeCom
errors and rotates both the bot key (secret) and the QR image (storage URL).

### WeCom — webhook URL is the full URL, not just the key

**Symptom:** `WeCom errcode=93000` ("invalid bot key") on first delivery, even though the operator just created the bot.

**Cause:** the WeCom admin UI shows the bot's webhook URL in two places — a full URL and a "key" parameter at the end. `WECOM_WEBHOOK_URL` must be the **full URL including `?key=<key>`**, not just the key.

**Format that works:**
```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef-1234-...
```

**Other WeCom-specific failure modes** (all visible only in `digest_sent.last_error`):
- `errcode 93000` — bot key invalidated (member who created the bot left the WeCom org, or admin regenerated). Re-create the bot, update the secret.
- `errcode 45009` — rate limit (20 messages/min per bot). Won't trigger for one daily brief; if it does, the per-chunk sequential `await` in `sendWecom` naturally rate-limits.
- 5xx from `qyapi.weixin.qq.com` — transient. The next cron tick re-attempts (the `digest_sent` row stays in `failed`, not `sent`).

### Notion — the database must be shared with the integration

**Symptom:** First Notion delivery returns 404 with no obvious cause. The token is right, the database ID is right, but POST `/v1/pages` 404s every time.

**Cause:** Creating a Notion **integration** is one step. **Sharing each target database with that integration** is a separate step that's easy to forget. Without it, the integration has zero permissions on the database and Notion returns 404 (not 403 — they treat it as "the integration cannot see this database, therefore it doesn't exist").

**Fix:** open the target database in Notion → top-right `Share` menu → `Add connections` → pick the integration. Wait a few seconds for propagation, retry.

**Other Notion failure modes:**
- `400 validation_error` — usually the database is missing one of the four properties the spec defines (`Title`, `Date`, `Language`, `Sources`) or the property name doesn't match exactly (case-sensitive). Match the spec's database schema literally.
- `401` — token revoked / wrong. Regenerate from `notion.so/my-integrations` and update `NOTION_TOKEN`.
- `429` — rate limit (3 req/s). Won't trigger for one daily call.

**Rule for any new Notion integration** in this project: token + database ID + share-the-database is the three-step setup. All three are mandatory; missing any returns a different unhelpful error.

---

## qa_logs — Operator Triage

`qa_logs` is the production data flywheel for the RAG path: every `answer-question` invocation persists a row with question, retrieval truth-set, response, model, tokens, timing, abort flag, error, and the user's later 👍/👎 ([spec](superpowers/specs/2026-04-26-qa-logs-and-feedback-design.md), shipped 2026-04-30). Triage is SQL-via-dashboard until volume justifies a UI.

### Daily question volume (last 14 days)

```sql
select date_trunc('day', asked_at)::date as day, count(*) as questions
from qa_logs
group by 1 order by 1 desc limit 14;
```

### Negative feedback in last 7 days (badcase triage queue)

```sql
select id, asked_at, lang, question, response_text, related_article_ids
from qa_logs
where feedback = -1 and asked_at > now() - interval '7 days'
order by asked_at desc;
```

### Aborted-stream rate (proxy for "user gave up")

```sql
select date_trunc('day', asked_at)::date as day,
       count(*) filter (where aborted) * 100.0 / count(*) as abort_pct
from qa_logs group by 1 order by 1 desc limit 14;
```

### Long-context badcase correlation (Spec-A → Spec-D justification)

```sql
-- Rows where the Spec-A 12K cap fired hard AND the user said the answer was bad.
-- This is the queryable evidence for "we need chunking" (Spec D).
select id, asked_at, question, context_main_chars, total_tokens
from qa_logs
where context_main_chars >= 12000 and feedback = -1
order by asked_at desc;
```

### Token cost per user (last 30 days)

```sql
select user_id, sum(total_tokens) as tokens, count(*) as questions
from qa_logs where asked_at > now() - interval '30 days'
group by user_id order by tokens desc;
```

### Hallucination-suspect triage seed

```sql
select id, question, response_text, related_article_ids
from qa_logs
where feedback = -1 and error_message is null
order by asked_at desc limit 50;
```

### Token-leak canary (CRITICAL — re-run after any answer-question change)

```sql
-- Aborted streams should have total_tokens << max_tokens (1024). If aborted
-- rows show total_tokens near 1024, the cancel() handler in answer-question
-- is NOT propagating to the upstream LLM fetch — every closed-tab event
-- silently burns a full generation budget.
select id, asked_at, total_tokens, total_ms,
       case when total_tokens > 800 then 'LEAK SUSPECT'
            when total_tokens > 400 then 'review'
            else 'ok'
       end as canary
from qa_logs
where aborted = true
order by asked_at desc limit 20;
```

If the canary shows `LEAK SUSPECT` rows, re-deploy `answer-question` and verify §A9 in [the spec](superpowers/specs/2026-04-26-qa-logs-and-feedback-design.md) — the abort ordering (`downstreamAbort.abort()` BEFORE `persistQaLog`) is the load-bearing invariant.

### Latency baseline (post-deploy quality check)

```sql
-- Run 24h after ship, then again whenever Spec D (chunking) or Spec E
-- (rerank) lands — these p50/p95s are the regression baseline.
select
  percentile_cont(0.5)  within group (order by ttft_ms)  as p50_ttft,
  percentile_cont(0.95) within group (order by ttft_ms)  as p95_ttft,
  percentile_cont(0.5)  within group (order by total_ms) as p50_total,
  percentile_cont(0.95) within group (order by total_ms) as p95_total
from qa_logs
where asked_at >= now() - interval '1 day'
  and not aborted and error_message is null;
-- Expected p50 ttft <2s; p95 total <15s.
```
