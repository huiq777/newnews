# Command Reference

> All worker commands must be run from inside the worker's directory.
> Always use `--remote` so wrangler can access cloud secrets.

---

## ingest-rss
**Runs automatically:** Every 4 hours (`0 */4 * * *`)

```bash
cd workers/ingest-rss

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+*/4+*+*+*"
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

## process-queue
**Runs automatically:** Every 15 minutes

```bash
cd workers/process-queue

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

**Verify:** Supabase → `daily_news` — new rows with `title_en`, `title_zh`, `summary_en`, `summary_zh`, `questions JSONB`

**Reset stuck rows (if worker crashed mid-run):**
```sql
UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL
WHERE status='processing' AND processed_at IS NULL;
```

**Reprocess specific articles:**
```sql
-- 1. Delete from daily_news first (ON DELETE RESTRICT on raw_ingestion)
DELETE FROM daily_news WHERE id IN (SELECT id FROM daily_news ORDER BY created_at DESC LIMIT 5);
-- 2. Reset raw_ingestion
UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL, processed_at=NULL
WHERE status='done' ORDER BY processed_at DESC LIMIT 5;
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

## send-feishu-digest
**Runs automatically:** Daily 17:00 UTC (12pm EST)

```bash
cd workers/send-feishu-digest

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+17+*+*+*"
```

**Verify:** Feishu group shows a blue interactive card with articles (Chinese content; 🔥 likes for tweets; 3 ZH bullets per article)

**Secrets required:**
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put FEISHU_WEBHOOK_URL
```

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
# Deploy
supabase functions deploy answer-question
supabase functions deploy refresh-questions

# Test answer-question (streaming)
curl -X POST https://<project>.supabase.co/functions/v1/answer-question \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"article_id":"<uuid>","question":"What is this about?","lang":"en"}'

# Test refresh-questions (non-streaming JSON)
curl -X POST https://<project>.supabase.co/functions/v1/refresh-questions \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"article_id":"<uuid>"}'

# Add secrets
supabase secrets set GROQ_API_KEY=... --project-ref <ref>
supabase secrets set COHERE_API_KEY=... --project-ref <ref>
supabase secrets list
```

---

## Secrets Management

```bash
# Set a secret for a specific worker
wrangler secret put GROQ_API_KEY --name process-queue
wrangler secret put COHERE_API_KEY --name embed-batch
wrangler secret put FEISHU_WEBHOOK_URL --name send-feishu-digest

# List secrets for a worker
wrangler secret list --name process-queue
```

---

## Common Issues

| Symptom | Fix |
|---|---|
| `Invalid URL` error in wrangler dev | Add `--remote` flag |
| Scheduled handler not running | Add `--test-scheduled` flag |
| Rows stuck in `processing` | `UPDATE raw_ingestion SET status='pending', retry_count=0, last_error=NULL WHERE status='processing' AND processed_at IS NULL` |
| 429 Groq rate limit | Wait 1 min (TPM) or until midnight UTC (TPD 100K/day). Do not retry in a loop — burns retry_count. |
| Batch insert 409 conflict | Normal — `ON CONFLICT DO NOTHING` skips existing URLs |
| Worker throws immediately with no error row | Subrequest limit (50/invocation) hit — see gotcha #13 in `AI-SWE-skill.md` |
| `questions` null on article | EN+ZH generation all-or-nothing; use ↻ pill to regenerate after TPD resets |
