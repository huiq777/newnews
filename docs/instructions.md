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
**Runs automatically:** Daily 00:30 UTC

Sends digest to Feishu (Chinese) and optionally Slack / Discord / Notion (English). Includes today's trend brief if available. Fetches last 24h articles, limit 10.

```bash
cd workers/send-digest

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=30+0+*+*+*"
```

**Verify:** Feishu group shows a blue interactive card with trend brief + articles (Chinese; 🔥 likes for tweets; 3 ZH bullets per article)

**Secrets required:**
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put FEISHU_WEBHOOK_URL         # required
wrangler secret put SLACK_WEBHOOK_URL          # optional
wrangler secret put DISCORD_WEBHOOK_URL        # optional
wrangler secret put NOTION_API_KEY             # optional
wrangler secret put NOTION_DATABASE_ID         # optional
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
supabase functions deploy process-queue
supabase functions deploy ingest-apify-tweets  # --no-verify-jwt required

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
wrangler secret put GROQ_API_KEY --name ingest-builders
wrangler secret put COHERE_API_KEY --name embed-batch
wrangler secret put FEISHU_WEBHOOK_URL --name send-digest

# List secrets for a worker
wrangler secret list --name ingest-builders
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
| Worker throws immediately with no error row | Subrequest limit (50/invocation) hit — see `keep-in-mind.md` |
| `questions` null on article | EN+ZH generation all-or-nothing; use ↻ pill to regenerate after TPD resets |
