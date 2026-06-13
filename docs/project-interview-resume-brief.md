# News Project Interview And Resume Brief

Last updated: 2026-06-11

## One-Line Pitch

Built a production AI news intelligence app with public bilingual feeds, OAuth-gated analysis, automated ingestion, bilingual summarization, streaming RAG Q&A, trend briefs, observability, and an eval-gated RAG refinement pipeline.

## Background

The product started as a private AI news digest and evolved into an Open Beta intelligence app. Anonymous users can browse the daily feed, while GitHub or Google OAuth unlocks premium generated surfaces: Deep Analysis, inline RAG Q&A, regenerated questions, and Trend Brief generation. The system is designed to keep broad article discovery public while protecting expensive LLM and analysis paths behind authenticated Edge Functions, rate limits, and user-scoped caches.

## Current Product State

- Open Beta access model is live: public feed first, OAuth for analysis.
- Closed-beta invite redemption remains in the repo as legacy/rollback code, but it is no longer the primary access model.
- Anonymous feed rows intentionally show login prompts for Deep Analysis, Q&A, and Trend Brief content instead of leaking generated analysis through direct table reads.
- GitHub stars are fetched for the nav action from the configured repository URL; the fallback label remains configurable.

## Resume Bullets

- Built an end-to-end AI news pipeline across Cloudflare Workers, Supabase Edge Functions, Postgres/pgvector, and Expo: source ingestion, AI relevance filtering, bilingual summaries, generated questions, embeddings, streaming RAG answers, trend briefs, feedback, and email digest delivery.
- Reworked access from invite-only beta to Open Beta: public daily feed, GitHub/Google OAuth, authenticated Deep Analysis/Q&A/Trend Briefs, per-user question and brief overrides, and rate-limited Edge Function access for premium generation.
- Implemented RAG observability with request-level traces across retriever inputs, ranked candidates, injected prompt context, `qa_logs`, and trend brief generation, enabling per-case debugging instead of black-box answer checking.
- Designed and shipped an offline RAG evaluation harness with human-reviewed gold evidence, replayable dense/lexical/hybrid/chunk strategies, per-case metrics, aggregate leaderboards, and historical baseline preservation.
- Improved offline retrieval from early article-level dense baselines to a corpus-health-valid chunk retrieval candidate with `@cf/baai/bge-m3`: Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, NDCG@10 `0.764`, Hit@5 `0.952`, p50/p95 as low as `1179/3425ms` on 21 approved cases.
- Added generation-side eval for the selected chunk-level dense retrieval candidate, measuring faithfulness `0.994`, answer relevancy `0.950`, context precision `0.785`, and context recall `0.819` across the latest aggregated `chunk_dense` corpus-retrieval generation results.
- Promoted the corpus-health-valid `chunk_dense @cf/baai/bge-m3` candidate to the production `answer-question` default, while keeping article-level dense retrieval as explicit rollback/fallback and keeping hybrid, rerank, generation eval, and Agentic RAG upgrades behind trace and quality gates.

## Real Metrics To Quote

Current approved-gold eval set: `qa-v1-2026-06`, 21 runnable cases, 21 with approved relevant gold.

| Strategy | Cases | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 | p95 | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `rerank_hybrid` | 21 | 0.990 | 1.000 | 0.944 | 0.935 | 1.000 | 40932ms | 68056ms | Quality-best, latency fails gate |
| `chunk_dense @cf/baai/bge-m3` | 21 | 0.895 | 0.943 | 0.739 | 0.764 | 0.952 | 1179ms | 3425ms | Selected chunk-level dense retrieval candidate after passing corpus-health and metric-bound checks |
| `chunk_hybrid` | 21 | 0.848 | 0.905 | 0.744 | 0.762 | 0.905 | 6753ms | 12447ms | Eval-only; slower and lower recall than dense |

Historical baselines:

| Strategy | Cases | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| earliest dense row | 14 | 0.107 | 0.107 | 0.071 | 0.087 | 0.143 | 1071ms | 5312ms |
| 2026-06-03 dense | 9 | 0.278 | 0.278 | 0.133 | 0.259 | 0.333 | 1201ms | 22380ms |
| 2026-06-03 lexical | 9 | 0.333 | 0.556 | 0.202 | 0.301 | 0.333 | 3696ms | 5573ms |
| 2026-06-03 hybrid | 9 | 0.222 | 0.444 | 0.178 | 0.322 | 0.222 | 5392ms | 11343ms |

Safe claim: "improved offline retrieval and measured generation quality in an eval-gated pipeline."  
Do not claim: "production answer accuracy improved" until the selected retriever is rolled out and measured on production traffic.

Scope note: these metrics are for the Q&A RAG eval track. Deep Analysis eval and Trend Brief eval are planned as separate quality gates because their outputs are structured article analysis and cross-window synthesis, not ranked answer retrieval.

## How It Was Achieved

- Split ingestion from processing with `raw_ingestion` as a durable queue, so fetch failures, LLM failures, and embedding failures are separately recoverable.
- Centralized user-facing generation behind Supabase Edge Functions, where service-role reads, OAuth user checks, rate limits, and streaming responses can be enforced.
- Made the feed RPC auth-aware: anonymous callers receive public article fields, while authenticated callers can receive bounded Deep Analysis fields.
- Moved user-triggered generated content to user-scoped tables: `user_article_questions` for refreshed questions and `user_trend_briefs` for manual trend brief generations.
- Added corpus-health gates before trusting RAG eval metrics: source freshness, approved-gold chunk coverage, and BGE embedding coverage must pass before strategy selection.
- Preserved production safety by staging RAG upgrades in eval-only scripts first, then requiring trace, latency, generation-quality, and rollback gates before production rollout.

## Architecture Talking Points

### Production Pipeline

- `ingest-rss`: RSS-like sources, WeChat, Reddit RSS fallback, YouTube lightweight Atom fallback.
- `ingest-builders`: builder tweets, podcasts, AIHot with stateful since-cursor.
- `process-queue`: one LLM call per article for bilingual summaries and questions; pre-LLM AI relevance gate; pipeline events and run ids.
- `embed-batch`: Cohere `embed-english-v3.0`, 1024-dim article embeddings for current production retrieval.
- `answer-question`: decomposed into route, retrieve, generate, orchestrate; streaming SSE; `qa_logs`; user feedback.
- `generate-trend-brief`: planned trend brief generation with historical enrichment and RAG trace logging.
- Open Beta access: `fetch_grouped_feed` serves public feed data; OAuth-gated analysis routes through `answer-question`, `refresh-questions`, and `generate-trend-brief`.

### RAG Observability

- `rag_retrieval_runs`: trace header, surface, retriever input, candidate count, context hash, latency.
- `rag_retrieval_candidates`: ranked candidates with dense/lexical/rerank/final scores, injected flag, drop reason.
- `rag_injected_contexts`: exact prompt context snapshots.
- `rag_eval_*`: eval sets, cases, gold evidence, replay runs, per-case metrics, aggregate metrics.

### Retrieval Refinement

- Production `answer-question` now defaults to `chunk_dense @cf/baai/bge-m3`, which is chunk-level dense retrieval rather than article-level retrieval, after corpus-health repair, valid replay metadata, and metric-bound checks.
- Article-level dense retrieval through `match_articles_prefer_analysis` remains available as explicit rollback/fallback.
- Rerank improved quality materially but failed latency gates, so it remains an offline research/audit path.
- Corpus-health, taxonomy, hard-negative, query rewrite, Cloudflare BGE rerank, and generation-eval scaffolding are implemented as eval-only layers.
- Rerank prefers Cloudflare Workers AI `@cf/baai/bge-reranker-base`, with LLM judge rerank as fallback/audit.

### Agentic RAG Upgrade Path

Agentic RAG is implemented as an eval-only runtime/harness, not production behavior:

- Intent router chooses fast linear RAG vs agentic path.
- Planner decomposes comparison/multi-hop questions into subqueries.
- Query rewrite layer supports entity expansion, HyDE-style semantic queries, task decomposition, and conversation context completion.
- Retrieval agent runs chunk dense, optional lexical/entity hybrid, overfetch, and rerank.
- Critique agent checks sufficiency, relevance, conflicts, and answerability.
- Re-retrieval is bounded: max two retrieval rounds and max three subqueries.
- If evidence remains insufficient, the generation agent must say so instead of hallucinating.
- Agentic trace storage records plan id, intent, subquery, retrieval round, strategy, candidate count, critique result, retry reason, stop reason, and latency.

Good interview phrasing:

> I treated Agentic RAG as orchestration above a strong retriever, not as a replacement for retrieval. The baseline path stays fast for simple questions; the agentic path only triggers for ambiguous, comparison, multi-hop, or low-context questions. Every planning and critique step has trace metadata and loop limits.

### GraphRAG Position

GraphRAG is not the current retrieval architecture. It is a deferred candidate for relation-heavy failures where chunk retrieval, lexical/entity hybrid retrieval, rerank, and bounded Agentic RAG still cannot recover the needed evidence. The project moved from traditional article-level RAG toward chunk/eval-gated RAG and an Agentic RAG harness first; GraphRAG should only be introduced after eval cases prove that explicit entity-relation structure is the missing piece.

## What I Would Say In An Interview

**Why chunk retrieval?**  
Article-level retrieval was too coarse for entity-heavy and exact-event questions. Chunk retrieval improved the odds that the model receives the exact supporting evidence while keeping latency inside the minimum gate.

**Why not just ship rerank?**  
`rerank_hybrid` had stronger quality metrics than `chunk_dense` but p95 latency was `68056ms`, far above the latency gate. I kept it eval-only and treated it as a quality ceiling/research signal.

**How did you avoid black-box RAG debugging?**  
I split the system into traceable layers: retriever inputs, candidates, injected context, answer logs, and eval replay. When a case fails, we can tell whether the issue is missing recall, bad ranking, bad context assembly, or generation.

**What is still missing?**  
Production rollout and production-traffic measurement. Retrieval replay and generation eval now exist, but the production `answer-question` retriever has not been changed yet. Agentic RAG also still needs its own completed eval run before quoting multi-hop wins.

**What makes this production-minded?**  
The production path did not change just because offline metrics improved. The plan requires feature flags, rollback, latency gates, source coverage checks, chunk coverage checks, and generation-side eval before claiming production answer quality.

## Honest Boundaries

- Current RAG metric wins are offline/eval results, not production retriever rollout results.
- Current eval size is 21 approved cases; enough for an engineering gate, not enough for broad benchmark claims.
- Historical taxonomy output had impossible NDCG slices before the 2026-06-08 metric fix; quote only rows that carry valid corpus-health metadata after the fix.
- Generation quality has a strong `chunk_dense` aggregate, but the current 24-row table should be grouped by `eval_run_id` before being treated as a locked benchmark because it exceeds the 21-case retrieval set.
- Agentic RAG has an eval-only runtime/harness, but no production rollout and no recorded multi-hop win should be quoted yet.
- GraphRAG and compiled knowledge are deferred until multi-hop/entity-relation eval misses justify the added complexity.

## Short Version For Resume

Built an AI news intelligence platform with automated multi-source ingestion, bilingual LLM summarization, streaming RAG Q&A, trend briefs, and traceable RAG evaluation. Added golden-dataset replay and chunk-level retrieval with `@cf/baai/bge-m3`, improving offline retrieval to Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, Hit@5 `0.952` on 21 approved cases, with generation eval showing faithfulness `0.994` and answer relevancy `0.950` while keeping production rollout behind eval and rollback gates.
