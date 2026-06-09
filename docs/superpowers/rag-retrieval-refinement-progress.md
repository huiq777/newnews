# RAG Retrieval Refinement Progress

Last updated: 2026-06-09

This is the working handoff for RAG retrieval refinement. It records what has shipped, what is eval-only, the latest measured baseline, and the next safe steps.

## Current Rule

Production retrieval behavior has not changed. `answer-question` still uses article-level dense retrieval through `match_articles_prefer_analysis`, which prefers ready Deep Analysis vectors when available and falls back to article embeddings. `generate-trend-brief` still uses its existing historical enrichment path.

All dense/lexical/hybrid/chunk work below is offline evaluation only until a later metric-gated production plan explicitly changes production functions.

As of 2026-06-08, replay runs must carry `rag-eval-run-notes-v1` metadata in `rag_eval_runs.notes`. Unless `valid_for_strategy_selection = true` is explicitly written from a passing corpus-health preflight, legacy and new replay rows are interpreted as diagnostics only.

## Shipped Foundation

- Trace completeness: `supabase/sql/20260531_rag_trace_completeness.sql`.
- Trace verification: `supabase/sql/20260531_rag_trace_completeness_verification.sql`.
- Golden dataset schema: `supabase/sql/20260601_rag_eval_dataset.sql`.
- Golden dataset review SQL: `supabase/sql/20260601_rag_eval_dataset_verification.sql`.
- Retrieval diagnostics: `supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql`.
- Eval-only lexical RPC: `supabase/sql/20260602_rag_lexical_eval_rpc.sql`.
- Eval-only chunk scaffold: `supabase/sql/20260602_article_chunks_eval_scaffold.sql`.
- Eval-only chunk dense RPC: `supabase/sql/20260603_rag_chunk_eval_rpc.sql`.
- Metrics refinement diagnostics: `supabase/sql/20260603_rag_metrics_refinement_diagnostics.sql`.
- Human coverage candidate-selection SQL: `supabase/sql/20260603_rag_eval_coverage_candidate_selection.sql`.
- Gold tooling: `scripts/rag-eval-generate-gold.mjs`.
- Replay tooling: `scripts/rag-eval-replay.mjs`.
- Chunk backfill tooling: `scripts/rag-chunk-backfill.mjs`.
- Corpus health preflight gate: `supabase/sql/20260608_rag_eval_corpus_health.sql`.
- Eval case taxonomy: `supabase/sql/20260608_rag_eval_case_taxonomy.sql`.
- Hard-negative evaluation: `supabase/sql/20260608_rag_eval_hard_negatives.sql`.
- Query rewrite diagnostics: `supabase/sql/20260608_rag_query_rewrite_diagnostics.sql`.
- Rerank cache: `supabase/sql/20260608_rag_eval_rerank_cache.sql`.
- Generation eval: `supabase/sql/20260608_rag_generation_eval.sql`.
- Agentic runtime: `scripts/rag-agentic-runtime.mjs`.
- Agentic eval trace: `supabase/sql/20260608_agentic_rag_eval_trace.sql`.

## Corpus Health Preflight

Latest corpus-health result from `supabase/sql/results.md`:

- Run id: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`
- Eval set id: `bb090d0b-6df2-4002-aa00-4d84e0002821`
- Chunking version: `paragraph-window-v1-2026-06-02`
- Embedding model: `@cf/baai/bge-m3`
- `ready_for_taxonomy = true`
- `ready_for_hard_negatives = true`
- `ready_for_replay = true`
- Replay blockers: `zero_chunk_gold_articles = 0`, `missing_bge_embedding_gold_articles = 0`, `stale_source_count = 0`
- Latest chunk count for `paragraph-window-v1-2026-06-02`: `1024`

Task 0 implementation adds `rag_eval_corpus_health_runs` as the persisted source of truth for eval readiness. The run summary records:

- `zero_chunk_gold_articles`
- `missing_bge_embedding_gold_articles`
- `stale_source_count`
- `deep_analysis_pending`
- `deep_analysis_processing_stale`
- `deep_analysis_retryable_errors`
- `short_or_empty_ineligible_articles`
- `chunk_count_by_version`

Interpretation rule:

- Taxonomy labeling, hard-negative proposal/review, and source-note annotation can proceed while corpus coverage is incomplete.
- Chunk-dependent strategy selection, release interpretation, rewrite/rerank/generation eval claims, and Agentic RAG eval claims remain blocked unless the latest corpus-health run has `ready_for_replay = true`.
- Article-level dense/lexical baselines may still run as diagnostics when chunk health fails, but replay rows must be marked `valid_for_strategy_selection = false` with an explicit `invalid_reason`, such as `chunk_corpus_health_failed`.

Remediation update from 2026-06-09:

- Article-level retrieval metrics now de-duplicate repeated chunks from the same article before computing Recall, MRR, Hit@5, and NDCG.
- NDCG now includes all non-hard-negative graded evidence in the ideal denominator, preventing grade-1 evidence from making `ndcg_at_10 > 1`.
- `supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql` identifies the exact approved relevant gold articles and active sources blocking replay readiness.
- The zero-chunk blockers were repaired by backfilling approved gold articles that had summary text but empty `article_content`, then rerunning chunk backfill with a lower minimum character threshold.
- Source freshness was repaired or reinterpreted so quiet sources with recent processed articles do not block replay solely because no new raw rows arrived in the last 24 hours.
- Fresh replay rows are valid for strategy selection only if they carry `rag-eval-run-notes-v1` with `valid_for_strategy_selection = true` and a passing corpus-health run id.
- Historical taxonomy output contained impossible `ndcg_at_10 > 1` rows and must not be used as release-grade strategy truth. Valid-only metric-bound checks now return no rows after the metric fix and valid replay.

## Eval Case Taxonomy

Task 1 implementation adds best-effort taxonomy backfill and slice reporting through `supabase/sql/20260608_rag_eval_case_taxonomy.sql`.

`rag_eval_cases.metadata` now carries the taxonomy convention:

- `format_cohort`
- `content_length_bucket`
- `source_type`
- `language`
- `question_type`
- `difficulty_tags`
- `entity_density`
- `origin`

Use the SQL's `metrics_by_taxonomy_slice` diagnostic before interpreting global metrics. Minimum required slices include short news, long-form, transcript/social, official, entity-heavy, and multi-hop.

## Hard Negatives

Task 2 implementation adds the canonical hard-negative convention:

- `rag_eval_gold_evidence.metadata->>'evidence_role' = 'hard_negative'`
- `relevance_grade = 0`

The SQL migration adds a check constraint so hard negatives cannot carry positive relevance. Replay now reports `hard_negatives_above_gold` separately; hard negatives are excluded from positive gold and cannot improve Recall, MRR, Hit@5, or NDCG.

Use `supabase/sql/20260608_rag_eval_hard_negatives.sql` to propose 5-10 same-topic distractors per approved case, then review them before approving. Proposals now require question/gold lexical overlap, prior top-k retrieval evidence, or a shared entity tag before surfacing. At least 10 approved cases need human-approved hard negatives before leaderboard hard-negative slices should be treated as stable.

## Query Rewrite Replay

Task 3 implementation adds eval-only rewrite modes:

- `none`
- `entity_expansion`
- `hyde`
- `decomposition`
- `context_completion`

Replay accepts `--rewrite-mode` and stores `rewrite_trace` in `rag_retrieval_runs.query_input`, including original query, rewritten query, mode, accepted/rejected status, drift threshold, reject reason, and candidate-divergence placeholder. Rejected or unavailable drift checks fall back to the original query. Rewrite runs remain diagnostics unless corpus health passes and the replay row is explicitly marked `valid_for_strategy_selection = true`.

## Rerank Replay

Task 4 implementation adds a Cloudflare Workers AI rerank adapter for `@cf/baai/bge-reranker-base`, with TokenRouter judge rerank retained as fallback/audit. The rerank cache key includes normalized query, ordered candidate ids, context hashes, rerank model, chunking version, and strategy variant.

Replay records cache hit/miss and cold/warm latency metadata in retrieval traces. Do not interpret rerank p95 without separating cold-cache and warm-cache runs.

## Generation Evaluation

Task 5 implementation adds `rag_generation_eval_results` plus capped scripts:

- `npm run eval:generate-answers`
- `npm run eval:judge-answers`

Generation eval has two explicit modes: `inline_article_generation_eval` mirrors production inline Q&A context packing, while `corpus_retrieval_generation_eval` answers only from retrieved corpus candidates. Both modes store `context_pack_version = answer-question-v1-prefer-analysis`, exact `context_text`, `context_hash`, answer text, model/prompt versions, judge scores, and human override fields.

Retrieval metrics must not be described as answer accuracy. Generation scores are separate evidence.

## Agentic RAG Runtime

Task 6 implementation adds an eval-only runtime module with:

- `classifyAgenticIntent(question, conversationContext)`
- `buildAgenticPlan(question, intent, conversationContext)`
- `runAgenticRetrievalStep(plan, subquery, strategyOptions)`
- `critiqueRetrievedContext(question, plan, candidates)`
- `orchestrateAgenticRag(question, options)`

The runtime enforces max two retrieval rounds, max three subqueries, no external web browsing, deterministic trace output, and linear fallback for simple questions. It is not wired into production `answer-question`.

## Agentic RAG Eval Harness

Task 7 implementation adds:

- `supabase/sql/20260608_agentic_rag_eval_trace.sql`
- `scripts/rag-agentic-eval-replay.mjs`
- `npm run eval:agentic`

Trace rows store `plan_id`, `intent`, `subquery`, `retrieval_round`, `strategy`, `candidate_count`, critique sufficiency/answerability, retry reason, stop reason, and latency. Slices with `n < 5` are directional only; pass/fail language requires `n >= 5` approved cases per decision slice.

## Dataset Status

Eval set: `qa-v1-2026-06`.

Latest readiness check from 2026-06-05:

| total_cases | cases_with_approved_relevant_gold | cases_with_only_pending_relevant_gold | cases_without_relevant_gold |
|---:|---:|---:|---:|
| 21 | 21 | 0 | 0 |

Interpretation:

- The 2026-06-05 comparison is the latest historical offline baseline. Treat it as a strong candidate signal, but rerun corpus-health preflight before using it for strategy selection or release claims.
- The set should continue to grow across WeChat, YouTube, Reddit, official, GitHub, Product Hunt, and RSS sources before production cutover.
- `review_status = approved` means the human trusts the label, including correct grade `0` and `1` rows.
- `review_status = rejected` means the row itself is unusable or wrong.

## Replay Results

Remediation status as of 2026-06-09:

- Fresh metric-fixed, corpus-health-valid replay exists for `chunk_dense`, `chunk_hybrid`, and `rerank_hybrid`.
- Current corpus-health run id for strategy-valid rows: `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`.
- Valid-only metric-bound checks return no rows, so the old `ndcg_at_10 > 1` issue is resolved for strategy-valid replay rows.
- `chunk_dense` is the deployable retrieval candidate: rerank has much stronger quality but fails the latency gate, while chunk hybrid is slower and lower-quality than dense.

Valid replay comparison:

| strategy | eval run id | total_cases | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 ms | p95 ms | interpretation |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `rerank_hybrid` | `c24ad51f-13ca-4adc-a2e8-8b843cd3c08f` | 21 | 0.990 | 1.000 | 0.944 | 0.935 | 1.000 | 40932 | 68056 | quality-best, latency-fails gate |
| `chunk_dense @cf/baai/bge-m3` | `8ba5bdac-88a7-4f7b-8058-1648c734cc33` | 21 | 0.895 | 0.943 | 0.739 | 0.764 | 0.952 | 1179 | 3425 | selected production candidate |
| `chunk_dense @cf/baai/bge-m3` | `e5f6d233-6908-4b89-a02d-ace206e43a36` | 21 | 0.895 | 0.943 | 0.739 | 0.764 | 0.952 | 1112 | 7221 | repeat run; same quality, higher p95 |
| `chunk_hybrid` | `9a265197-b101-4a4d-9302-d7791e95c0fd` | 21 | 0.848 | 0.905 | 0.744 | 0.762 | 0.905 | 6753 | 12447 | eval-only; slower and lower recall |

Generation eval for `chunk_dense`:

| mode | retrieval strategy | judged rows | Faithfulness | Answer relevancy | Context precision | Context recall | interpretation |
|---|---|---:|---:|---:|---:|---:|---|
| `corpus_retrieval_generation_eval` | `chunk_dense` | 24 | 0.994 | 0.950 | 0.785 | 0.819 | strong faithfulness/relevancy; inspect per-run grouping before quoting final case count |

The generation table above is grouped by mode and retrieval strategy. Because `24` judged rows is larger than the 21-case retrieval set, final reporting should group by `eval_run_id` and use the latest complete 21-case generation run before treating the generation score as a locked benchmark. Low-context cases mostly produced honest "insufficient context" answers, which preserved faithfulness but lowered context precision/recall and, in some judge rows, answer relevancy.

Approved-label replay as of 2026-06-05 06:47 UTC:

| strategy | total_cases | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chunk_dense (`@cf/baai/bge-m3`) | 21 | 0.567 | 0.710 | 0.757 | 0.620 | 0.658 | 0.810 | 1843 | 4429 |
| entity_hybrid | 21 | n/a | 0.719 | 0.800 | 0.683 | 0.723 | 0.810 | 7080 | 11559 |
| chunk_hybrid | 21 | n/a | 0.600 | 0.681 | 0.613 | 0.640 | 0.714 | 7884 | 19044 |

Historical approved-label baselines:

| date | strategy | total_cases | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 ms | p95 ms | note |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2026-06-02 | dense | 14 | n/a | 0.107 | 0.107 | 0.071 | 0.087 | 0.143 | 1071 | 5312 | earliest stored approved-gold dense row; generated before current 21-case readiness |
| 2026-06-03 | dense | 9 | 0.222 | 0.278 | 0.278 | 0.133 | 0.259 | 0.333 | 1201 | 22380 | first 9-case approved-only article-dense replay |
| 2026-06-03 | lexical | 9 | 0.222 | 0.333 | 0.556 | 0.202 | 0.301 | 0.333 | 3696 | 5573 | best early article-level challenger |
| 2026-06-03 | hybrid | 9 | 0.222 | 0.222 | 0.444 | 0.178 | 0.322 | 0.222 | 5392 | 11343 | article-level hybrid was slower and worse than lexical |

Headline improvement from historical baselines to `chunk_dense`:

| comparison | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| vs earliest dense 14-case row | +0.603 | +0.650 | +0.549 | +0.571 | +0.667 | +772ms | -883ms |
| vs 2026-06-03 dense 9-case row | +0.432 | +0.479 | +0.487 | +0.399 | +0.477 | +642ms | -17951ms |
| vs 2026-06-03 lexical 9-case row | +0.377 | +0.201 | +0.418 | +0.357 | +0.477 | -1853ms | -1144ms |
| vs 2026-06-03 hybrid 9-case row | +0.488 | +0.313 | +0.442 | +0.336 | +0.588 | -3549ms | -6914ms |

Note: the case counts differ across baselines as the gold set matured from 14 total / 9 approved-relevant cases to 21 approved-relevant cases. Treat the improvement table as directional evidence plus gate status, not a perfectly controlled A/B.

Legacy rows retained for raw continuity:

| strategy | total_cases | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@10 | Hit@5 | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dense | 9 | 0.222 | 0.278 | 0.278 | 0.133 | 0.259 | 0.333 | 1201 | 22380 |
| lexical | 9 | 0.222 | 0.333 | 0.556 | 0.202 | 0.301 | 0.333 | 3696 | 5573 |
| hybrid | 9 | 0.222 | 0.222 | 0.444 | 0.178 | 0.322 | 0.222 | 5392 | 11343 |

An older dense row with 14 cases exists (`dense_query_embedding_article_similarity`, Recall@5 0.107, Recall@10 0.107, MRR 0.071, NDCG@10 0.087, Hit@5 0.143, p50 1071ms, p95 5312ms). Keep it as the oldest historical reference because it was generated before the current approved-gold readiness state and strategy naming.

Historical local implementation note from 2026-06-03, superseded by the 2026-06-05 replay metrics below:

- Added eval-only replay infrastructure for `chunk_dense`, `chunk_hybrid`, `entity_hybrid`, and `rerank_hybrid`.
- Switched eval chunk backfill to matching BGE query/document vector space. This was later superseded by the Cloudflare Workers AI model id `@cf/baai/bge-m3` as the eval default on 2026-06-05.
- Added weighted RRF strategy labels (`*_vw*_lw*_cw*`) and trace metadata for fusion weights, expanded queries, chunks, and rerank scores.
- Added coverage-gate test and candidate-selection SQL. At that point, local JSON had 14 non-stress questions, so the 20-case stability gate was intentionally not met yet.
- At that point, no new replay metrics were recorded. This was superseded by the 2026-06-05 21-case replay metrics below.

Local implementation update on 2026-06-05:

- Switched the BGE eval default to Cloudflare Workers AI model id `@cf/baai/bge-m3`.
- Lowered `rag-chunk-backfill --eval-set` default `--min-chars` to `200`, so approved gold evidence with shorter article bodies is not silently skipped.
- `chunk_dense` produced the strongest historical offline chunk baseline on 21 approved cases at the time: Recall@5 0.710, Recall@10 0.757, MRR 0.620, NDCG@10 0.658, Hit@5 0.810, p50 1843ms, p95 4429ms.
- This result was superseded by the 2026-06-09 corpus-health-valid replay above.

## Reading The Baseline

Lexical is the current best offline article-level challenger. It has the best Recall@5, Recall@10, MRR, and p95 latency among the eval-only challengers. Hybrid remains useful as a research signal, but on this run it is worse than lexical alone and slower.

Dense article-level retrieval is behind the target range. It misses too many exact entity/event questions, especially where named entities, product names, legal terms, or slogans are load-bearing.

The likely next quality lever is chunk retrieval. The architecture spec expects a move from coarse article-level retrieval toward traceable, chunk-level retrieval before any user-facing retriever change.

## Case-Level Dense vs Lexical Diagnosis

Latest dense-vs-lexical case comparison:

| question short label | dense Recall@10 | lexical Recall@10 | dense MRR | lexical MRR | read |
|---|---:|---:|---:|---:|---|
| DOJ / GCC High encrypted docs | 0 | 1 | 0 | 0.333 | lexical win; exact compliance/entity terms rescue retrieval |
| Pinterest script / 15-minute firing | 0 | 1 | 0 | 0.200 | lexical win; exact event wording matters |
| Okta / $280B cyber market | 0 | 1 | 0 | 0.143 | lexical win but relevant item is still below top 5 |
| AGI definition / financing narrative | 0 | 1 | 0 | 0.143 | lexical win but relevant item is still below top 5 |
| MuleRun dedicated VM | 1 | 1 | 0.500 | 1.000 | both hit; lexical ranks the target first |
| AI layoffs / ldapsearch | 0 | 0 | 0 | 0 | both miss |
| FedRAMP $10M budget | 0 | 0 | 0 | 0 | both miss |
| Musk lawsuit / xAI listing buffer | 0.5 | 0 | 0.200 | 0 | dense-only win |
| OpenAI April 27 hearing / IPO valuation | 1 | 0 | 0.500 | 0 | dense-only win |

Interpretation: lexical/entity matching is rescuing several cases that dense misses, but lexical also loses two OpenAI/xAI legal cases that dense finds. The next retriever should preserve dense semantic recall while improving entity-aware precision and ranking.

## Target Metrics

Near-term target for a 20-50 case eval set before considering production retriever changes:

| metric | minimum gate | healthy target |
|---|---:|---:|
| Recall@5 | >= 0.55 | >= 0.70 |
| Recall@10 | >= 0.70 | >= 0.85 |
| MRR | >= 0.35 | >= 0.50 |
| NDCG@10 | >= 0.55 | >= 0.70 |
| Hit@5 | >= 0.55 | >= 0.70 |
| p50 latency | <= 2500ms | <= 1500ms |
| p95 latency | <= 8000ms | <= 5000ms |

Current gap from latest strategy-valid `chunk_dense` replay:

| metric | chunk_dense now | minimum gate | gap |
|---|---:|---:|---:|
| Recall@5 | 0.895 | 0.55 | within gate |
| Recall@10 | 0.943 | 0.70 | within gate |
| MRR | 0.739 | 0.35 | within gate |
| NDCG@10 | 0.764 | 0.55 | within gate |
| Hit@5 | 0.952 | 0.55 | within gate |
| p50 latency | 1179ms | 2500ms | within gate |
| p95 latency | 3425ms | 8000ms | within gate |

The latest offline baseline clears the numeric minimum retrieval gate. Before using it for release-grade strategy selection, rerun the corpus-health preflight, clean up zero-chunk gold articles, and write an integration plan that preserves existing answer-question behavior until chunk retrieval is wired, observed, and rollback-safe.

## Next Commands

Run approved-label dense/lexical/hybrid replays after every gold-label update:

```bash
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy dense
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy lexical
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy hybrid
```

If expanding gold candidates, use a longer judge timeout:

```bash
RAG_EVAL_GOLD_TIMEOUT_MS=240000 npm run eval:generate-gold -- --set qa-v1-2026-06 --expand-candidates true
```

After applying the 20260603 SQL and setting BGE credentials, run eval-only chunk backfill/replays:

```bash
npm run eval:chunk-backfill -- --limit 100
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy chunk_dense --chunking-version paragraph-window-v1-2026-06-02
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy chunk_hybrid --chunking-version paragraph-window-v1-2026-06-02
npm run eval:replay -- --set qa-v1-2026-06 --allow-pending false --strategy entity_hybrid
```

Run weighted sweeps and rerank comparisons only after `runnable_cases >= 20`.

Then run:

```sql
-- Supabase SQL Editor
-- supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql
```

Use query 6 for readiness and query 7 for latest strategy comparison.

## Next Implementation Step

Recommended next implementation: live application of the eval SQL, BGE chunk backfill, and human-approved coverage expansion. Keep all work eval-only.

Proposed shape:

- Apply `match_article_chunks_eval` RPC against `article_chunks.embedding`.
- Run `chunk_dense` and `chunk_hybrid` replays.
- Run an entity-aware fusion comparison that keeps dense legal/event wins while preserving lexical entity wins.
- Improve lexical term extraction/ranking so exact matches land in top 5, not just top 10.
- Preserve production `answer-question` behavior.
- Gate any later production change on improved Recall@5/10, MRR/NDCG, and acceptable latency.

Do not deploy hybrid article-level retrieval directly.
