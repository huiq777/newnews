# Command Reference

> All worker commands must be run from inside the worker's directory.
> Always use `--remote` so wrangler can access cloud secrets.

---

## ingest-rss
**Runs automatically:** Every hour (`0 * * * *`)

```bash
cd workers/ingest-rss

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

**Verify:** Supabase → `raw_ingestion` — new rows with `status=pending`

---

## ingest-builders
**Runs automatically:** Daily 6am UTC

Fetches `feed-x.json` (builder tweets) + `feed-podcasts.json` (podcast episodes) in one run. Performs one Groq batch call for bio extraction. Stores tweet engagement metadata `{likes, retweets}`.

```bash
cd workers/ingest-builders

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
```

**Verify:** Supabase → `raw_ingestion` — new rows with `source_type=github_feed` (tweets) or `source_type=podcast` (episodes); `status=pending`

**Secrets required:**
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GROQ_API_KEY
```

---

## process-queue (Supabase Edge Function)
**Runs automatically:** Every 5 min via pg_cron → `net.http_post`

```bash
# Deploy
supabase functions deploy process-queue

# Trigger manually
curl -X POST https://<SUPABASE_URL>/functions/v1/process-queue \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

**Verify:** Supabase → `daily_news` — new rows with `title_en`, `title_zh`, `summary_en`, `summary_zh`, `questions JSONB`; check Edge Function logs for `[TokenRouter] ok (200)`.

**Reset stuck rows (if function crashed mid-run):**
```sql
UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL
WHERE status='processing' AND processed_at IS NULL;
```

**Secrets** (set in Supabase dashboard — do NOT set `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`, those are auto-injected):
```bash
supabase secrets set TOKENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set LLM_MODEL=... --project-ref <ref>
supabase secrets set OPENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set OPENROUTER_MODEL=... --project-ref <ref>
supabase secrets set GROQ_API_KEY=... --project-ref <ref>
```

---

## embed-batch
**Runs automatically:** Every 5 minutes

```bash
cd workers/embed-batch

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

**Verify:** Supabase → `daily_news` — `embedding` column populated (non-null) on recent rows

---

## send-digest
**Runs automatically:** Daily 00:30 UTC. Depends on `generate-trend-brief` pg_cron pre-warm at 00:25 UTC.

**Trend-brief-only** delivery. Per-channel language routing: Feishu → `synthesis_zh`; Slack/Discord/Telegram → `synthesis_en`. Per-channel per-day idempotency via `digest_sent` table. Empty brief → logs `skipped_empty_brief`, no send.

```bash
cd workers/send-digest

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=30+0+*+*+*"
```

**Verify:** Feishu ZH card, Slack/Discord/Telegram EN messages. Re-trigger same UTC day → no duplicates. Check `select * from digest_sent where anchor_date = current_date`.

**Secrets required:**
```bash
wrangler secret put SUPABASE_URL               --name send-digest
wrangler secret put SUPABASE_SERVICE_ROLE_KEY  --name send-digest
wrangler secret put FEISHU_WEBHOOK_URL         --name send-digest  # optional
wrangler secret put SLACK_WEBHOOK_URL          --name send-digest  # optional
wrangler secret put DISCORD_WEBHOOK_URL        --name send-digest  # optional
wrangler secret put TELEGRAM_BOT_TOKEN         --name send-digest  # optional (paired)
wrangler secret put TELEGRAM_CHAT_ID           --name send-digest  # optional (paired)
wrangler secret put RESEND_API_KEY             --name send-digest  # email delivery via Resend
wrangler secret put RESEND_FROM               --name send-digest  # e.g. "Newnews Brief <brief@newnews.dev>"
wrangler secret put APP_URL                   --name send-digest  # e.g. "https://newnews.dev" (used for unsubscribe link)
# Without RESEND_API_KEY, email delivery is silently skipped (worker guards with if (!env.RESEND_API_KEY))
# Remove stale Notion secrets if previously bound:
# wrangler secret delete NOTION_API_KEY       --name send-digest
# wrangler secret delete NOTION_DATABASE_ID   --name send-digest
```

**Supabase Edge Function secret (for pg_cron auth):**
```bash
supabase secrets set CRON_SECRET=<value>       # read by generate-trend-brief
```

**pg_cron pre-warm setup (one-time):**

1. In Supabase SQL editor, put the CRON_SECRET into Vault:
   ```sql
   select vault.create_secret('<CRON_SECRET value>', 'cron_secret');
   ```
2. Open `supabase/sql/20260424_digest_sent_and_trend_brief_cron.sql`, replace
   `<PROJECT_REF>` with your Supabase project ref, then paste-and-run in SQL editor.

Supabase Cloud does not permit `alter database postgres set app.X` — use Vault for
secrets and hardcode the (non-secret) project ref in the migration.

---

## ingest-x
**Status: Deleted** — freed the 5th Cloudflare cron slot. X API costs $100/mo. Builder tweets are now sourced via `ingest-builders` (reads follow-builders `feed-x.json` from GitHub at zero API cost). The `workers/ingest-x/` directory still exists in the repo but the worker is not deployed.

---

## Expo App (news-app)

```bash
cd news-app

# Start dev server (web)
npx expo start --web

# Run on iOS simulator
npx expo start --ios
```

---

## Supabase Edge Functions

```bash
# Deploy all functions
supabase functions deploy answer-question
supabase functions deploy refresh-questions
supabase functions deploy process-queue
supabase functions deploy generate-trend-brief
supabase functions deploy ingest-apify-tweets  # --no-verify-jwt required
supabase functions deploy redeem-invite        # closed-beta auth gate (Round 1)
supabase functions deploy unsubscribe-email --no-verify-jwt

# Test answer-question (streaming)
curl -X POST https://<project>.supabase.co/functions/v1/answer-question \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"article_id":"<uuid>","question":"What is this about?","lang":"en","deep_think":false}'

# Test refresh-questions (non-streaming JSON)
curl -X POST https://<project>.supabase.co/functions/v1/refresh-questions \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"article_id":"<uuid>"}'

# Add secrets
supabase secrets set TOKENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set GROQ_API_KEY=... --project-ref <ref>
supabase secrets set COHERE_API_KEY=... --project-ref <ref>
supabase secrets set TREND_BRIEF_MODEL=anthropic/claude-opus-4.7 --project-ref <ref>
supabase secrets set QA_LLM_MODEL=qwen/qwen3.5-flash --project-ref <ref>
supabase secrets list
```

### Apply new SQL migrations (2026-05-03)

Run each file in the Supabase SQL Editor (all idempotent — safe to re-run):

1. `supabase/sql/20260503_observability_foundation.sql` — `pipeline_events` table + `run_id` columns + `request_id` on `qa_logs`
2. `supabase/sql/20260503_is_ai_relevant.sql` — `is_ai_relevant()` RPC (canonical AI keyword gate)
3. `supabase/sql/20260503_fetch_grouped_feed.sql` — `fetch_grouped_feed()` RPC (cursor pagination + thread grouping)

---

## Beta Invite Link Format

```
https://<host>/?invite=<code>
```

Share this URL with invitees (e.g. over WeChat). The first click signs them in anonymously and ties them to the invite row. Subsequent reloads skip the gate entirely.

- `<host>` — your Cloudflare Pages domain (e.g. `news-app.pages.dev`) or custom domain
- `<code>` — the random URL-safe slug from the `beta_invites.code` column

---

## Generate a beta invite (Round 1)

Apply migration once: paste `supabase/sql/20260426_beta_invites.sql` into the
Supabase SQL Editor (idempotent — safe to re-run). Then mint an invite:

```sql
insert into beta_invites (code, display_name, default_lang)
values (
  replace(replace(replace(
    encode(gen_random_bytes(12), 'base64'),
    '+', '-'), '/', '_'), '=', ''),
  'Wang Lei',  -- the invitee's display name
  'zh'         -- 'en' or 'zh' — preselects gate language
)
returning code;
```

Share over WeChat: `https://<host>/?invite=<code>`. First click signs the user
in anonymously and ties them to the row; subsequent reloads skip the gate.

To inspect / audit:

```sql
select code, display_name, default_lang, used_at, user_id, expires_at
from beta_invites order by created_at desc;
```

---

## Secrets Management

```bash
# Set a secret for a specific worker
wrangler secret put GROQ_API_KEY --name ingest-builders
wrangler secret put COHERE_API_KEY --name embed-batch
wrangler secret put FEISHU_WEBHOOK_URL --name send-digest

# List secrets for a worker
wrangler secret list --name ingest-builders
```

---

## Operational Health Checks

Run these in the **Supabase SQL Editor**. No code changes needed — just paste and read.

---

### Every day (~2 min)

**1. Did the pipeline run and produce articles?**
```sql
select date_trunc('hour', created_at) as hour, count(*) as articles
from daily_news
where created_at > now() - interval '24 hours'
group by 1 order by 1 desc;
```
Expect: rows in the last 24h. If empty, check `raw_ingestion` for stuck rows (see #3 below).

**2. Did the trend brief send?**
```sql
select channel, anchor_date, status, last_error
from digest_sent
order by anchor_date desc, channel
limit 10;
```
Expect: `status = 'sent'` for each channel. `skipped_empty_brief` means no articles for that UTC day — normal if ingestion ran late. `failed` means delivery error — check `last_error`.

**3. Any stuck or errored rows in the queue?**
```sql
select status, count(*) as cnt,
       max(fetched_at) as newest
from raw_ingestion
where fetched_at > now() - interval '24 hours'
group by status;
```
Expect: mostly `done`. `processing` rows older than 10 min = stuck (fix: reset to `pending`). High `error` count = LLM or scraper failure — check `last_error` on those rows:
```sql
select url, last_error, retry_count
from raw_ingestion
where status = 'error' and fetched_at > now() - interval '24 hours'
order by retry_count desc limit 10;
```

**4. Are embeddings keeping up?**
```sql
select count(*) as unembedded
from daily_news
where embedding is null
  and created_at > now() - interval '24 hours';
```
Expect: 0 or near-0. `embed-batch` runs every 5 min. >10 unembedded after an hour = `embed-batch` worker down or Cohere key expired.

---

### When something feels off (on-demand)

**Trace a full pipeline run by run_id**
```sql
-- Pick a run_id from a recent pipeline_events row
select run_id, step, status, duration_ms, error_text, created_at
from pipeline_events
where run_id = '<paste-run-id>'
order by created_at;
```
Expect: `keyword_gate ok` → `llm ok` → `insert ok` for each article in the batch. `keyword_gate skip` = filtered as not AI-relevant (normal). `llm error` = LLM call failed.

**Find the run_id for a specific article**
```sql
select dn.id, dn.title_en, dn.run_id, dn.created_at
from daily_news dn
where dn.id = '<article-uuid>';
-- then paste run_id into the query above
```

**Q&A is returning bad answers — check recent request trace**
```sql
select request_id, asked_at, lang, deep_think,
       left(question, 80) as q,
       left(response_text, 120) as answer,
       total_ms, feedback, error_message
from qa_logs
order by asked_at desc limit 20;
```

**Is the Q&A abort rate spiking? (users giving up)**
```sql
select date_trunc('day', asked_at)::date as day,
       count(*) as total,
       count(*) filter (where aborted) as aborted,
       round(count(*) filter (where aborted) * 100.0 / count(*), 1) as abort_pct
from qa_logs
where asked_at > now() - interval '7 days'
group by 1 order by 1 desc;
```
Expect: abort_pct < 20%. Spike = LLM slow or context too large.

**Token leak canary — run after any answer-question deploy**
```sql
select id, asked_at, total_tokens,
       case when total_tokens > 800 then 'LEAK' else 'ok' end as canary
from qa_logs
where aborted = true
order by asked_at desc limit 10;
```
Expect: all `ok`. `LEAK` = abort signal not reaching the upstream LLM — redeploy `answer-question`.

---

### Weekly (5 min)

**LLM category mismatch rate — prompt drift signal**
```sql
select date_trunc('day', created_at)::date as day,
       count(*) as mismatches
from pipeline_events
where step = 'llm_category_mismatch'
group by 1 order by 1 desc limit 14;
```
Expect: 0–2/day. Creeping up = LLM is drifting on category assignment — review the prompt's category list.

**Negative feedback triage — badcase queue**
```sql
select asked_at, lang, left(question, 100) as q,
       left(response_text, 200) as answer
from qa_logs
where feedback = -1
  and asked_at > now() - interval '7 days'
order by asked_at desc;
```
Review each row: is the answer factually wrong, incomplete, or off-topic? Fix: adjust system prompt or retrieval context.

**Source coverage — is every active source producing articles?**
```sql
select s.name, s.source_type, count(dn.id) as articles_7d,
       max(dn.created_at) as last_article
from sources s
left join daily_news dn on dn.source_id = s.id
  and dn.created_at > now() - interval '7 days'
where s.is_active = true
group by s.id, s.name, s.source_type
order by articles_7d asc;
```
Expect: every active source has articles in the last 7 days. `articles_7d = 0` = that source's ingest is broken. Check `raw_ingestion` for that `source_id`.

**Token cost per user (last 30 days)**
```sql
select user_id, count(*) as questions, sum(total_tokens) as tokens
from qa_logs
where asked_at > now() - interval '30 days'
group by user_id order by tokens desc;
```
Spot any user burning disproportionate tokens — relevant if moving to a paid LLM tier.

---

### Fix recipes

| Symptom | Fix |
|---|---|
| Rows stuck in `processing` | `UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL WHERE status='processing' AND processed_at IS NULL;` |
| 429 errors in `last_error` | Wait until UTC midnight (Groq TPD resets). Do not retry in a loop. |
| `unembedded > 0` after 1h | Check `embed-batch` CF Worker — redeploy or check `COHERE_API_KEY` |
| Trend brief missing both languages | Check `trend_briefs` for `synthesis_zh IS NULL` — `triggerSecondaryGeneration` timed out; retrigger manually |
| `pipeline_events` table empty | SQL migration `20260503_observability_foundation.sql` not yet applied — run it in SQL Editor |

---

## Common Issues

| Symptom | Fix |
|---|---|
| `Invalid URL` error in wrangler dev | Add `--remote` flag |
| Scheduled handler not running | Add `--test-scheduled` flag |
| Rows stuck in `processing` | `UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL WHERE status='processing' AND processed_at IS NULL` |
| 429 Groq rate limit | Wait 1 min (TPM) or until midnight UTC (TPD 100K/day). Do not retry in a loop — burns retry_count. |
| Batch insert 409 conflict | Normal — `ON CONFLICT DO NOTHING` skips existing URLs |
| Worker throws immediately with no error row | Subrequest limit (50/invocation) hit — see `keep-in-mind.md` |
| `questions` null on article | EN+ZH generation all-or-nothing; use ↻ pill to regenerate after TPD resets |
