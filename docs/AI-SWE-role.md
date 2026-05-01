# AI SWE Role — News Project

> **This document describes the SWE role only** — mindset, responsibilities, and key rules to remember. Before any task: read `current-state.md` (live deployment state), `keep-in-mind.md` (hard-won lessons), and the relevant spec in `docs/superpowers/specs/`. Pipeline code, schema details, deployment commands, operational SQL, and full gotcha explanations are NOT here — each lives in its dedicated doc (see Document Map).

---

## Role Definition

When operating as AI SWE on this project:
- Think at FAANG engineer level: correctness first, then performance, then elegance
- Fix root causes, not symptoms — no workarounds over real fixes
- Validate before claiming done: use `superpowers:verification-before-completion`
- Debug systematically: use `superpowers:systematic-debugging` before guessing
- Look up library APIs with `context7` before writing code from memory
- Use `superpowers:brainstorming` before designing any non-trivial feature
- Use `superpowers:writing-plans` for multi-step implementation work

---

## Stack Overview

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Expo (React Native) + TypeScript | Web-first; iOS via EAS is Phase 5 |
| Ingestion | Cloudflare Workers (cron) + Supabase Edge Functions (pg_cron) | CF Workers: 30s wall-clock, 50 subrequest/invocation limit; Edge Functions: no wall-clock limit |
| LLM | TokenRouter `qwen/qwen3.6-plus` → OpenRouter → Groq `llama-3.3-70b-versatile` | TokenRouter: 120s timeout; fallback on AbortError/TCP/429; Groq: 12K TPM, **100K TPD** |
| Embeddings | Cohere `embed-english-v3.0` | 1024-dim; asymmetric `input_type` (see Critical Rules) |
| Vector DB | Supabase pgvector (HNSW index) | Cosine distance via `<=>` operator |
| DB | Supabase PostgreSQL | PostgREST REST API; RLS enforced |
| Auth (Workers) | Service role key | Never expose to frontend |
| Auth (Frontend) | Anon key + RLS | Public read on `daily_news` and `sources` |

---

## Current Implementation State

For full details on each component, see `current-state.md`. Key status:

| Component | Status |
|-----------|--------|
| RSS / WeChat / Reddit ingestion (`ingest-rss`) | ✅ Live — every hour |
| Builder tweets + podcasts + GitHub/PH/Nowcoder/arXiv (`ingest-builders`) | ✅ Live — daily 6am UTC |
| Apify tweet ingestion (`ingest-apify-tweets`) | ✅ Live — webhook on RUN_SUCCEEDED |
| Scrape + LLM summarize + questions (`process-queue` Edge Function) | ✅ Live — pg_cron every 5 min |
| Cohere embeddings (`embed-batch`) | ✅ Live — every 5 min |
| Daily digest (`send-digest`) | ✅ Live — daily 00:30 UTC |
| RAG Q&A (`answer-question`) | ✅ Live |
| Trend Brief (`generate-trend-brief`) | ✅ Live |
| Web deployment (Cloudflare Pages) | 🔄 In Progress |
| iOS build (Expo EAS) | ❌ Not started |

---

## Critical Rules

These are the most commonly broken details in this codebase. Refer to `keep-in-mind.md` for full explanations.

- **Cohere `input_type` asymmetry is load-bearing** — `search_document` for embed-batch, `search_query` for answer-question. Never use the same type for both.
- **pgvector HNSW requires raw `<=>` in ORDER BY** — wrapping it (e.g. `1 - (...)`) forces a sequential scan.
- **`supabase.functions.invoke()` buffers SSE** — use native `fetch` + `ReadableStream` for streaming endpoints.
- **`ON CONFLICT DO NOTHING` is a silent no-op** — duplicate URL inserts return 200 with no error and no update. For backfills, use a separate PATCH.
- **`wrangler dev` needs `--remote --test-scheduled`** — plain `wrangler dev` has no secrets and doesn't run the scheduled handler.
- **PostgREST `or=` filter requires outer parentheses** — `?or=(cond1,cond2)` not `?or=cond1,cond2`.
- **Cloudflare subrequest limit: 50/invocation** — every `fetch()` counts. `ingest-builders` is at ~19/50. Do not add per-item loops.
- **RLS silently returns `[]`** — if anon key gets empty results with no error, check `pg_policies` for the table.
- **HTML parsing on Deno Deploy: use `node-html-parser`** — `HTMLRewriter` and `linkedom` both fail at bundle time (WASM / native binary blocked).
- **TokenRouter needs 120s AbortController** — `qwen/qwen3.6-plus` can take 90–120s. Groq fallback needs its own explicit 30s AbortController (no CF wall-clock to rely on in Edge Functions).

---

## File Reference

| File | Purpose |
|------|---------|
| `workers/ingest-rss/src/index.ts` | RSS / WeChat / Reddit → `raw_ingestion`, every hour |
| `workers/ingest-builders/src/index.ts` | Tweets + podcasts + GitHub Trending + PH + Nowcoder + arXiv → `raw_ingestion`, daily 6am UTC |
| `workers/embed-batch/src/index.ts` | Cohere embeddings → `daily_news.embedding`, every 5 min |
| `workers/send-digest/src/index.ts` | Daily digest — Feishu (ZH) + optional Slack/Discord/Notion (EN), 00:30 UTC |
| `supabase/functions/process-queue/index.ts` | Scrape + LLM summarize + questions + engagement → `daily_news`; pg_cron every 5 min |
| `supabase/functions/answer-question/index.ts` | Streaming RAG Q&A |
| `supabase/functions/refresh-questions/index.ts` | On-demand question regeneration |
| `supabase/functions/ingest-apify-tweets/index.ts` | Apify webhook receiver; `--no-verify-jwt` |
| `supabase/functions/generate-trend-brief/index.ts` | Cross-window trend synthesis; SSE streaming |
| `news-app/App.tsx` | Main Expo entry — feed, date filtering, Q&A, auto-fallback to 3D |
| `news-app/components/` | NavBar, DrumWheelSidebar, ArticleCard, FilterTag, TrendBriefCard, MarkdownText |

---

## Skills Reference

| Skill | When to use |
|-------|-------------|
| `superpowers:brainstorming` | Before designing any non-trivial feature |
| `superpowers:writing-plans` | Before multi-step implementation (3+ files) |
| `superpowers:systematic-debugging` | When something breaks unexpectedly |
| `superpowers:verification-before-completion` | Before claiming any feature is done |
| `frontend-design` | Any UX/UI component or design decision |
| `context7` | Cloudflare Workers API, Supabase SDK, Expo, Cohere API docs |

---

## Document Map

| Document | Contents |
|---|---|
| `docs/current-state.md` | Live deployment status of every component — read first each session |
| `docs/keep-in-mind.md` | Hard-won lessons and gotchas — read before debugging |
| `docs/architecture.md` | Design decisions, pipeline flow, key patterns |
| `docs/schema.md` | Table definitions, RLS policies, RPC signatures |
| `docs/token.md` | Groq token budgets per call, daily TPD math |
| `docs/edge-functions.md` | Edge Function contracts, SSE patterns, token economy |
| `docs/api-keys-and-env.md` | Every secret and where it lives |
| `docs/instructions.md` | Deployment commands for every worker and Edge Function |
| `docs/superpowers/specs/` | Design specs — read the relevant spec before implementing |
| `docs/architect-role.md` | Architectural principles and decision framework |
