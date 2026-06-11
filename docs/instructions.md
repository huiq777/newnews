# Command Reference

> All worker commands must be run from inside the worker's directory.
> Always use `--remote` so wrangler can access cloud secrets.

---

## RAG Eval Remediation Gates

Before treating replay metrics as strategy-selection evidence, run the corpus-health SQL and use its latest run id in every replay/generation/agentic command:

```sql
\i supabase/sql/20260608_rag_eval_corpus_health.sql
\i supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql
```

If `ready_for_replay = false`, runs are smoke/diagnostic only:

```bash
npm run eval:replay -- --set qa-v1-2026-06 --strategy chunk_hybrid --rewrite-mode entity_expansion --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason query_rewrite_smoke
npm run eval:rerank -- --set qa-v1-2026-06 --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason rerank_cache_smoke
npm run eval:generate-answers -- --set qa-v1-2026-06 --mode corpus_retrieval_generation_eval --retrieval-strategy chunk_hybrid --max-cases 5 --chunking-version paragraph-window-v1-2026-06-02 --context-pack-version answer-question-v1-prefer-analysis --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason generation_smoke
npm run eval:agentic -- --set qa-v1-2026-06 --max-cases 5 --retrieval-strategy chunk_hybrid --chunking-version paragraph-window-v1-2026-06-02 --corpus-health-run-id <health_run_id> --valid-for-strategy-selection false --invalid-reason agentic_smoke
```

Only use `--valid-for-strategy-selection true` after corpus health passes and fresh metric-fixed replay has no Recall/NDCG values above `1`.

---

## OAuth Public Feed + Authenticated Analysis Deployment

Apply the OAuth/public-feed policy before deploying the matching frontend and premium Edge Functions:

```sql
\i supabase/sql/20260610_oauth_access_policy.sql
```

Deploy the gated analysis functions:

```bash
supabase functions deploy answer-question
supabase functions deploy refresh-questions
supabase functions deploy generate-trend-brief
```

Supabase Auth setup:
- Enable GitHub and Google providers.
- Provider callback URL for both GitHub and Google:
  `https://exjbwdcxyrkxsmzaowkx.supabase.co/auth/v1/callback`
- GitHub OAuth App:
  - Homepage URL: production app URL.
  - Authorization callback URL: the Supabase callback URL above.
- Google OAuth Client:
  - Application type: Web application.
  - Authorized JavaScript origins: production origin and local dev origin, e.g. `http://localhost:8081`.
  - Authorized redirect URIs: the Supabase callback URL above. Do not use localhost as Google's redirect URI when Supabase Auth brokers the OAuth flow.
- Supabase Auth URL Configuration:
  - Site URL: `https://newnews.dev`.
  - Redirect URLs: `https://newnews.dev` plus local dev URL(s), e.g. `http://localhost:8081`, only if intentionally testing local OAuth returns.
- Disable email/password, email OTP, and email sign-up for this release.

Frontend env for OAuth redirect and the nav GitHub action:

```bash
EXPO_PUBLIC_APP_URL=https://newnews.dev
EXPO_PUBLIC_GITHUB_REPO_URL=https://github.com/<owner>/<repo>
EXPO_PUBLIC_GITHUB_STARS_LABEL=Star
```

`EXPO_PUBLIC_APP_URL` controls Supabase OAuth `redirectTo`. If omitted, the app defaults to `https://newnews.dev`; it does not use localhost automatically.

Post-deploy smoke:

```bash
npm test
```

Manual browser checks:
- Anonymous visitor can load the daily feed.
- Anonymous Deep Analysis, Q&A, and Trend Brief slots show a login row, not generated content.
- GitHub or Google OAuth returns to the app and unlocks Deep Analysis, Q&A, question refresh, and trend brief generation.

---

## ingest-rss
**Runs automatically:** Every hour (`0 * * * *`)

Owns RSS-like feeds: `rss`, `wechat`, `official_rss`, `reddit`, and lightweight `youtube` fallback. YouTube transcript-quality ingestion still comes from the Apify webhook, but this worker keeps channel titles/descriptions from going completely stale.

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

**Verify source coverage after deploy:**
```sql
select s.name, s.source_type, count(ri.id) as raw_rows_24h, max(ri.fetched_at) as newest_raw
from sources s
left join raw_ingestion ri on ri.source_id = s.id
  and ri.fetched_at > now() - interval '24 hours'
where s.is_active = true
  and s.source_type in ('wechat', 'reddit', 'youtube')
group by s.id, s.name, s.source_type
order by s.source_type, raw_rows_24h asc, s.name;
```

Expected after the hourly worker runs:
- Reddit rows should have fresh `raw_ingestion` through preserved `.rss` URLs.
- YouTube rows should have at least lightweight feed items when the channel published recently.
- WeChat rows depend on upstream bridge freshness; if `raw_rows_24h = 0`, inspect the RSS URL directly.

**Social source recovery:**
Run `supabase/sql/20260604_social_source_coverage_recovery.sql` before deploying `ingest-rss` when Reddit, WeChat, or YouTube rows are stale or missing. This preserves the current source names and stores YouTube channel IDs for deterministic Atom fallback.

Reddit RSS requires a descriptive `User-Agent`; plain anonymous requests can return `403`. If Reddit coverage drops again, test with:

```bash
curl -L -A 'web:LinkXCapitalNews:v1.0 (source coverage recovery; contact: ops@linkx.capital)' 'https://www.reddit.com/r/MachineLearning.rss'
```

YouTube depth comes from Apify through `ingest-youtube-transcripts`. The `ingest-rss` YouTube path is only a lightweight title/description fallback.

---

## ingest-official-sources (Supabase Edge Function)
**Runs automatically:** Every 3 hours via pg_cron → `net.http_post`

Fetches curated official HTML index sources (`official_html_index`) for Anthropic and Google DeepMind. OpenAI official RSS is fetched by `ingest-rss` via `source_type=official_rss`.

```bash
# Deploy
supabase functions deploy ingest-official-sources

# Trigger manually
curl -X POST https://<SUPABASE_URL>/functions/v1/ingest-official-sources \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Apply source rows + cron:**
Run `supabase/sql/20260528_official_sources.sql` in the Supabase SQL Editor or with `psql`.

**Verify:** Supabase → `raw_ingestion` — official rows have `metadata->>'trust_tier' = 'official'`; duplicate-suppressed rows have `status='error'` and `last_error='DUPLICATE_SUPPRESSED'`.

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

## generate-deep-analysis (Supabase Edge Function)
**Runs automatically:** Every 5 min via pg_cron → `net.http_post`

Generates bilingual structured Deep Analysis for eligible `daily_news` rows (`article_content` length > 500) after `process-queue` publishes the compact article. It writes `article_deep_analysis.status='ready'` only after both JSON analysis and Cohere embedding succeed.

```bash
# Deploy
supabase functions deploy generate-deep-analysis

# Trigger manually
curl -X POST https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/generate-deep-analysis \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

`<SUPABASE_URL>` means the full host, including `.supabase.co`. Using only
`https://exjbwdcxyrkxsmzaowkx/...` causes `curl: (6) Could not resolve host`.

**Apply schema + cron:**
Run `supabase/sql/20260529_deep_analysis.sql` in the Supabase SQL Editor or with `psql`.

**Verify:**
```sql
select status, count(*)
from article_deep_analysis
group by status
order by status;

select count(*) as claimable
from article_deep_analysis ada
join daily_news dn on dn.id = ada.article_id
where ada.status in ('pending', 'error')
  and ada.retry_count < 3
  and dn.article_content is not null
  and length(dn.article_content) > 500;

select ada.status, dn.title, ada.model, ada.input_chars, ada.truncated, ada.last_error
from article_deep_analysis ada
join daily_news dn on dn.id = ada.article_id
order by ada.updated_at desc
limit 20;
```

**Secrets** (set in Supabase dashboard — `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected):
```bash
supabase secrets set TOKENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set DEEP_ANALYSIS_LLM_MODEL=qwen/qwen3.6-plus --project-ref <ref>
supabase secrets set OPENROUTER_API_KEY=... --project-ref <ref>
supabase secrets set OPENROUTER_MODEL=... --project-ref <ref>
supabase secrets set GROQ_API_KEY=... --project-ref <ref>
supabase secrets set COHERE_API_KEY=... --project-ref <ref>
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
supabase functions deploy generate-deep-analysis
supabase functions deploy generate-trend-brief
supabase functions deploy ingest-apify-tweets  # --no-verify-jwt required
supabase functions deploy redeem-invite        # legacy closed-beta rollback path only
supabase functions deploy unsubscribe-email --no-verify-jwt

# Test answer-question (streaming)
curl -X POST https://<project>.supabase.co/functions/v1/answer-question \
  -H "Authorization: Bearer <user-jwt>" \
  -H "apikey: <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"article_id":"<uuid>","question":"What is this about?","lang":"en","deep_think":false}'

# Test refresh-questions (non-streaming JSON)
curl -X POST https://<project>.supabase.co/functions/v1/refresh-questions \
  -H "Authorization: Bearer <user-jwt>" \
  -H "apikey: <anon-key>" \
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

## Legacy Beta Invite Link Format

```
https://<host>/?invite=<code>
```

Legacy only. The current app uses Open Beta public feed plus GitHub/Google OAuth. Keep this path for rollback/history unless explicitly removing closed-beta support.

- `<host>` — your Cloudflare Pages domain (e.g. `news-app.pages.dev`) or custom domain
- `<code>` — the random URL-safe slug from the `beta_invites.code` column

---

## Generate a legacy beta invite

Apply migration once: paste `supabase/sql/20260426_beta_invites.sql` into the
Supabase SQL Editor (idempotent — safe to re-run). Then mint an invite only if testing the legacy path:

```sql
INSERT INTO beta_invites (code, display_name, default_lang)
VALUES (
  'beta-000',
  'xxx',
  'zh'
)
RETURNING code;
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

**RAG trace completeness — verify latest production traces**

Run `supabase/sql/20260531_rag_trace_completeness_verification.sql` in Supabase SQL Editor after deploying `answer-question` or `generate-trend-brief`. The trace is healthy when:
- `qa_logs.rag_retrieval_run_id` links to `rag_retrieval_runs` for Q&A.
- `trend_brief_key` links trend brief historical enrichment traces.
- `rag_retrieval_candidates` has rows when candidates were returned.
- `rag_injected_contexts` records the exact prompt context that reached the model.

**RAG golden dataset — review pending labels**

Use this to list every pending label with raw source context:
```sql
select
  c.id as case_id,
  g.article_id,
  dn.raw_ingestion_id,
  ri.url as raw_url,
  ri.source_id,
  ri.status as raw_status,
  ri.raw_content,
  ri.metadata as raw_metadata,
  c.question,
  dn.title as evidence_article_title,
  g.relevance_grade,
  g.evidence_note,
  g.review_status,
  g.metadata as gold_metadata
from public.rag_eval_gold_evidence g
join public.rag_eval_cases c on c.id = g.case_id
join public.daily_news dn on dn.id = g.article_id
join public.raw_ingestion ri on ri.id = dn.raw_ingestion_id
where g.review_status = 'pending'
order by c.created_at asc, (g.metadata->>'candidate_rank')::int asc nulls last;
```

Use `approved` for a human-trusted label, including correct low-relevance grades `0` and `1`. Use `rejected` only when the row itself is wrong/unusable, not merely because the article is irrelevant.

Use this to inspect pending labels with a specific grade, for example grade `0`:
```sql
select
  c.id as case_id,
  g.id as gold_id,
  g.article_id,
  dn.raw_ingestion_id,
  ri.url as raw_url,
  c.question,
  dn.title as evidence_article_title,
  g.relevance_grade,
  g.evidence_note,
  g.metadata->>'candidate_provider' as candidate_provider,
  g.metadata->>'query_embedding_model' as query_embedding_model
from public.rag_eval_gold_evidence g
join public.rag_eval_cases c on c.id = g.case_id
join public.daily_news dn on dn.id = g.article_id
left join public.raw_ingestion ri on ri.id = dn.raw_ingestion_id
where g.review_status = 'pending'
  and g.relevance_grade = 0
order by c.created_at asc, (g.metadata->>'candidate_rank')::int asc nulls last;
```

Use this to change the grade for specific labels after review:
```sql
update public.rag_eval_gold_evidence
set
  relevance_grade = 2,
  evidence_note = coalesce(evidence_note, '') || E'\nHuman correction: updated relevance grade after reviewing raw URL and article evidence.'
where id in (
  -- paste gold_id values here
);
```

update public.rag_eval_gold_evidence
set
  review_status = 'rejected',
  evidence_note = coalesce(evidence_note, '') || E'\nHuman review: rejected as duplicate evidence label.'
where id in (
  -- paste duplicate gold_id values here
);

After human review, approve all trusted pending labels at a specific grade:
```sql
update public.rag_eval_gold_evidence
set review_status = 'approved'
where review_status = 'pending'
  and relevance_grade = 0;
```

Do this only after checking that the grade is correct. A trusted `0` means "this article is truly irrelevant to the question," not "delete this row."

Gold generation reruns preserve existing human review state. If a case/article pair already has `review_status = 'approved'`, rerunning `npm run eval:generate-gold` should not downgrade it back to `pending`.

**RAG eval replay — dense, lexical, hybrid**

Apply these SQL files before lexical/hybrid/chunk work:
```bash
supabase/sql/20260602_rag_lexical_eval_rpc.sql
supabase/sql/20260602_article_chunks_eval_scaffold.sql
```

Generate or expand gold candidates:
```bash
RAG_EVAL_GOLD_TIMEOUT_MS=240000 npm run eval:generate-gold -- --set qa-v1-2026-06 --expand-candidates true
```

Run official approved-label replays:
```bash
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy dense
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy lexical
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy hybrid
npm run eval:chunk-backfill -- --eval-set qa-v1-2026-06 --batch-size 8
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy chunk_dense --chunking-version paragraph-window-v1-2026-06-02
```

Then run `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`, especially:
- Query 6: approved-gold readiness preflight.
- Query 7: latest dense/lexical/hybrid comparison.

As of 2026-06-09, `chunk_dense` with Cloudflare Workers AI `@cf/baai/bge-m3` is the selected corpus-health-valid eval candidate on 21 approved cases: Recall@5 0.895, Recall@10 0.943, MRR 0.739, NDCG@10 0.764, Hit@5 0.952, p50/p95 as low as 1179/3425ms. Generation eval aggregate for `chunk_dense` is faithfulness 0.994, answer relevancy 0.950, context precision 0.785, and context recall 0.819, but group by `eval_run_id` before quoting it as a locked benchmark. Do not change production `answer-question` without a separate feature-flagged integration and rollback plan.

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
