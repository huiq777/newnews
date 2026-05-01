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
# Deploy
supabase functions deploy answer-question
supabase functions deploy refresh-questions
supabase functions deploy process-queue
supabase functions deploy ingest-apify-tweets  # --no-verify-jwt required
supabase functions deploy redeem-invite        # closed-beta auth gate (Round 1)

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
