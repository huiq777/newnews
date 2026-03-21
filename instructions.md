# Command Reference

> All worker commands must be run from inside the worker's directory.
> Always use `--remote` so wrangler can access cloud secrets.

---

## ingest-rss
**Runs automatically:** daily at 7:00 UTC

```bash
cd workers/ingest-rss

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

**Verify:** Supabase → `raw_ingestion` — new rows with `status=pending`

---

## process-queue
**Runs automatically:** every 15 minutes

```bash
cd workers/process-queue

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

**Verify:** Supabase → `daily_news` — new rows with title + summary

**Reset stuck rows (if worker crashed mid-run):**
```sql
UPDATE raw_ingestion SET status='pending' WHERE status='processing';
```

**Reprocess specific articles:**
```sql
UPDATE raw_ingestion SET status='pending', retry_count=0
WHERE id IN (SELECT id FROM raw_ingestion WHERE status='done' LIMIT 5);

DELETE FROM daily_news
WHERE id IN (SELECT id FROM daily_news ORDER BY created_at DESC LIMIT 5);
```

---

## ingest-x
**Runs automatically:** every hour
**Note:** Requires X API Basic tier ($100/mo). Disable sources if not subscribed:
```sql
UPDATE sources SET is_active=false WHERE source_type='x_api';
```

```bash
cd workers/ingest-x

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

---

## embed-batch
**Runs automatically:** every 5 minutes (Phase 2)

```bash
cd workers/embed-batch

# Deploy
wrangler deploy

# Test locally (Terminal 1)
wrangler dev --remote --test-scheduled

# Trigger (Terminal 2)
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

**Verify:** Supabase → `article_embeddings` — new rows

---

## Expo App (news-app)

```bash
cd news-app

# Start dev server
npx expo start

# Run on iOS simulator
npx expo start --ios

# Run on Android simulator
npx expo start --android
```

---

## Supabase Edge Functions (Phase 2)

```bash
# Deploy both functions
supabase functions deploy chat-live
supabase functions deploy chat-rag

# Test chat-live
curl -X POST https://<project>.supabase.co/functions/v1/chat-live \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is happening in AI today?"}'

# Test chat-rag
curl -X POST https://<project>.supabase.co/functions/v1/chat-rag \
  -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"question":"Summarize recent GPU news","session_id":"abc123"}'
```

---

## Secrets Management

```bash
# Set a secret for a specific worker
wrangler secret put GROQ_API_KEY --name process-queue
wrangler secret put COHERE_API_KEY --name embed-batch
wrangler secret put X_BEARER_TOKEN --name ingest-x

# List secrets for a worker
wrangler secret list --name process-queue

# Supabase Edge Function secrets: Dashboard → Edge Functions → Manage Secrets
```

---

## Common Issues

| Symptom | Fix |
|---|---|
| `Invalid URL` error in wrangler dev | Add `--remote` flag |
| Scheduled handler not running | Add `--test-scheduled` flag |
| Rows stuck in `processing` | `UPDATE raw_ingestion SET status='pending' WHERE status='processing'` |
| 429 Groq rate limit | Wait 1 min, re-trigger. Long articles hit 12K TPM limit |
| 402 X API error | X free tier is write-only. Disable X sources or upgrade to Basic |
| Batch insert 409 conflict | Normal — `ON CONFLICT DO NOTHING` skips existing URLs |
