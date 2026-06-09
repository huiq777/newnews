import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildBgeEmbeddingsUrl,
  buildEvalRunNotes,
  computeHardNegativeDiagnostics,
  computeRetrievalMetrics,
  buildEvalRewriteTrace,
  buildCloudflareRerankUrl,
  buildRerankCacheKey,
  mapCloudflareRerankResults,
  rewriteQueryForEval,
  parseEvalRunNotes,
} from '../scripts/rag-eval-lib.mjs'

test('retrieval diagnostics SQL inspects latest eval misses, gold readiness, and primary article rank', () => {
  const sql = readFileSync('supabase/sql/20260602_rag_retrieval_refinement_diagnostics.sql', 'utf8')

  assert.match(sql, /rag_eval_retrieval_metrics/)
  assert.match(sql, /primary_rank/)
  assert.match(sql, /rag_retrieval_candidates/)
  assert.match(sql, /primary_article_baseline/)
  assert.match(sql, /approved_relevant_gold/)
  assert.match(sql, /score_lexical/)
})

test('eval lib exposes lexical and hybrid replay helpers', () => {
  const source = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const sql = readFileSync('supabase/sql/20260602_rag_lexical_eval_rpc.sql', 'utf8')

  assert.match(source, /fetchLexicalCandidates/)
  assert.match(source, /fuseCandidatesByRrf/)
  assert.match(source, /extractLexicalTerms/)
  assert.match(sql, /match_articles_lexical_eval/)
  assert.match(sql, /pg_trgm/)
  assert.match(sql, /title_en/)
  assert.match(sql, /summary_zh/)
  assert.doesNotMatch(sql, /article_content, ''\)\) like/)
})

test('replay runner supports dense, lexical, and hybrid strategies without production changes', () => {
  const source = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(source, /--strategy/)
  assert.match(source, /dense/)
  assert.match(source, /lexical/)
  assert.match(source, /hybrid/)
  assert.match(source, /safeFetchLexicalCandidates/)
  assert.match(source, /Skipping lexical replay candidates after RPC failure/)
  assert.match(source, /recordRetrievalTrace\(env, evalCase, candidates, matchCount, latencyMs, strategyLabel/)
  assert.doesNotMatch(source, /answer-question\/index\.ts/)
})

test('gold generation expands evidence beyond dense candidates before official comparison', () => {
  const source = readFileSync('scripts/rag-eval-generate-gold.mjs', 'utf8')

  assert.match(source, /--expand-candidates/)
  assert.match(source, /--missing-only/)
  assert.match(source, /--candidate-provider/)
  assert.match(source, /--include-lexical/)
  assert.match(source, /includeLexicalCandidates/)
  assert.match(source, /safeFetchLexicalCandidates/)
  assert.match(source, /gradeCandidatesWithRetry/)
  assert.match(source, /mergeExistingGoldReviewState/)
  assert.match(source, /review_status: existingRow\?\.review_status \?\? row\.review_status/)
  assert.match(source, /bge_chunk/)
  assert.match(source, /cohere_article/)
  assert.match(source, /candidateProvider/)
  assert.match(source, /primary_article_baseline/)
  assert.match(source, /fetchLexicalCandidates/)
  assert.match(source, /fuseCandidatesByRrf/)
  assert.match(source, /candidate_sources/)
})

test('chunk scaffold creates eval-only article chunk table', () => {
  const sql = readFileSync('supabase/sql/20260602_article_chunks_eval_scaffold.sql', 'utf8')

  assert.match(sql, /create table if not exists public\.article_chunks/)
  assert.match(sql, /chunking_version/)
  assert.match(sql, /chunking_params/)
  assert.match(sql, /chunk_hash/)
  assert.match(sql, /unique \(article_id, chunking_version, chunk_hash\)/)
  assert.match(sql, /unique \(article_id, chunking_version, chunk_index\)/)
  assert.match(sql, /embedding vector\(1024\)/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /revoke all on public\.article_chunks from anon, authenticated/)
})

test('chunk backfill script preserves paragraph boundaries and embeds with search_document', () => {
  const source = readFileSync('scripts/rag-chunk-backfill.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts['eval:chunk-backfill'], 'node scripts/rag-chunk-backfill.mjs')
  assert.match(source, /CHUNKING_VERSION/)
  assert.match(source, /chunking_version/)
  assert.match(source, /splitArticleIntoChunks/)
  assert.match(source, /embedChunksInBatches/)
  assert.match(source, /fetchWithRetry/)
  assert.match(source, /boundary_type: 'paragraph'/)
  assert.match(source, /input_type: 'search_document'/)
  assert.match(source, /article_chunks/)
})

test('chunk backfill script can target approved eval gold articles', () => {
  const source = readFileSync('scripts/rag-chunk-backfill.mjs', 'utf8')

  assert.match(source, /--eval-set/)
  assert.match(source, /loadEvalGoldArticleIds/)
  assert.match(source, /rag_eval_gold_evidence/)
  assert.match(source, /review_status=eq\.approved/)
  assert.match(source, /relevance_grade=gte\.2/)
  assert.match(source, /daily_news\?id=\$\{uuidIn\(articleIds\)\}/)
  assert.match(source, /const hasEvalSet = Boolean\(args\['eval-set'\]\)/)
  assert.match(source, /hasEvalSet \? 200 : 5000/)
})

test('chunk backfill script sanitizes and isolates invalid embedding inputs', () => {
  const source = readFileSync('scripts/rag-chunk-backfill.mjs', 'utf8')

  assert.match(source, /--batch-size/)
  assert.match(source, /sanitizeEmbeddingInput/)
  assert.match(source, /replace\(\/\\u0000\/g/)
  assert.match(source, /articleId/)
  assert.match(source, /chunkIndex/)
  assert.match(source, /BGE rejected chunk/)
})

test('chunk eval RPC retrieves article chunks without touching production retrieval', () => {
  const sql = readFileSync('supabase/sql/20260603_rag_chunk_eval_rpc.sql', 'utf8')

  assert.match(sql, /create or replace function public\.match_article_chunks_eval/)
  assert.match(sql, /returns table/)
  assert.match(sql, /article_chunks/)
  assert.match(sql, /embedding <=> query_embedding/)
  assert.match(sql, /chunk_rank/)
  assert.match(sql, /article_rank/)
  assert.match(sql, /chunk_overfetch_multiplier/)
  assert.match(sql, /grant execute on function public\.match_article_chunks_eval/)
  assert.doesNotMatch(sql, /create or replace function public\.match_articles\(/)
})

test('replay runner supports chunk dense strategy and records chunk metadata', () => {
  const lib = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(lib, /BGE_EMBEDDING_MODEL/)
  assert.match(lib, /bgeEmbedSearchQuery/)
  assert.match(lib, /fetchChunkDenseCandidates/)
  assert.match(lib, /match_article_chunks_eval/)
  assert.match(lib, /chunk_id/)
  assert.match(readFileSync('scripts/rag-chunk-backfill.mjs', 'utf8'), /BGE_EMBEDDING_MODEL/)
  assert.match(replay, /chunk_dense/)
  assert.match(replay, /--chunking-version/)
  assert.match(replay, /candidate_type: candidate\.candidate_type \|\| 'article'/)
  assert.match(replay, /chunk_id: candidate\.chunk_id \|\| null/)
  assert.doesNotMatch(replay, /answer-question\/index\.ts/)
})

test('BGE embedding model can be overridden for compatible free providers', () => {
  const lib = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')

  assert.match(lib, /process\.env\.BGE_EMBEDDING_MODEL/)
  assert.match(lib, /@cf\/baai\/bge-m3/)
})

test('BGE embeddings URL supports generic and Cloudflare OpenAI-compatible base URLs', () => {
  assert.equal(
    buildBgeEmbeddingsUrl('https://api.example.com'),
    'https://api.example.com/v1/embeddings'
  )
  assert.equal(
    buildBgeEmbeddingsUrl('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1'),
    'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/embeddings'
  )
  assert.equal(
    buildBgeEmbeddingsUrl('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/'),
    'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/embeddings'
  )
})

test('replay runner supports chunk hybrid fusion explicitly', () => {
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(replay, /chunk_hybrid/)
  assert.match(replay, /match_article_chunks_eval\+match_articles_lexical_eval/)
  assert.match(replay, /fetchChunkDenseCandidates\(env, queryEmbedding, Math\.max\(matchCount \* 3, 30\), chunkingVersion\)/)
  assert.match(replay, /safeFetchLexicalCandidates\(env, evalCase\.question, Math\.max\(matchCount \* 3, 30\)\)/)
  assert.match(replay, /fuseCandidatesWeightedRrf|fuseCandidatesByRrf/)
})

test('entity-aware query expansion preserves named entities and mixed-language terms', () => {
  const source = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(source, /extractEntityTerms/)
  assert.match(source, /expandRetrievalQueries/)
  assert.match(source, /loadEntityLexicon/)
  assert.match(source, /RAG_EVAL_ENTITY_TERMS/)
  assert.match(source, /latinEntities/)
  assert.match(source, /moneyTerms/)
  assert.doesNotMatch(source, /mixedKnown|hardcodedEvalEntities/)
  assert.match(replay, /entity_hybrid/)
  assert.match(replay, /expanded_queries/)
})

test('weighted fusion supports controlled dense lexical and chunk weights', () => {
  const lib = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')
  const sql = readFileSync('supabase/sql/20260603_rag_metrics_refinement_diagnostics.sql', 'utf8')

  assert.match(lib, /fuseCandidatesWeightedRrf/)
  assert.match(lib, /sourceWeight/)
  assert.match(replay, /--vector-weight/)
  assert.match(replay, /--lexical-weight/)
  assert.match(replay, /--chunk-weight/)
  assert.match(replay, /buildStrategyVariant/)
  assert.match(replay, /fusion_weights/)
  assert.match(replay, /notes: JSON\.stringify/)
  assert.match(sql, /strategy_gate_status/)
  assert.match(sql, /candidate_top10/)
  assert.match(sql, /gold_targets/)
  assert.match(sql, /array_agg\(candidate_article_id order by rank\)/)
  assert.match(sql, /best_gold_rank/)
  assert.match(sql, /missing_approved_gold/)
  assert.match(sql, /gold_chunk_coverage/)
  assert.match(sql, /public\.article_chunks/)
  assert.doesNotMatch(sql, /public\.article_chunk_eval/)
})

test('rerank replay uses explicit candidate judgment and preserves retrieval traces', () => {
  const lib = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(lib, /rerankCandidatesWithJudge/)
  assert.match(lib, /relevance_score/)
  assert.match(replay, /rerank_hybrid/)
  assert.match(replay, /RAG_EVAL_RERANK_MODEL/)
  assert.match(replay, /score_rerank/)
})

test('corpus health preflight SQL persists gate results and read-only diagnostics', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_eval_corpus_health.sql', 'utf8')

  assert.match(sql, /create table if not exists public\.rag_eval_corpus_health_runs/)
  assert.match(sql, /ready_for_taxonomy/)
  assert.match(sql, /ready_for_hard_negatives/)
  assert.match(sql, /ready_for_replay/)
  assert.match(sql, /summary jsonb not null default '\{\}'::jsonb/)
  assert.match(sql, /zero_chunk_gold_articles/)
  assert.match(sql, /missing_bge_embedding_gold_articles/)
  assert.match(sql, /stale_source_count/)
  assert.match(sql, /deep_analysis_pending/)
  assert.match(sql, /deep_analysis_processing_stale/)
  assert.match(sql, /deep_analysis_retryable_errors/)
  assert.match(sql, /short_or_empty_ineligible_articles/)
  assert.match(sql, /source_freshness_by_type/)
  assert.match(sql, /now\(\) - interval '24 hours'/)
  assert.match(sql, /ri\.fetched_at/)
  assert.doesNotMatch(sql, /ri\.created_at/)
  assert.match(sql, /processing' and ada\.updated_at < now\(\) - interval '15 minutes'/)
  assert.match(sql, /count\(\*\) filter \(where coalesce\(chunk_count, 0\) = 0\)/)
  assert.match(sql, /embedding_model = '@cf\/baai\/bge-m3'/)
  assert.match(sql, /chunk_count_by_version/)
  assert.match(sql, /alter table public\.rag_eval_corpus_health_runs enable row level security/)
  assert.match(sql, /revoke all on public\.rag_eval_corpus_health_runs from anon, authenticated/)
  assert.match(sql, /grant all on public\.rag_eval_corpus_health_runs to service_role/)
})

test('zero chunk diagnostics explain corpus-health replay blockers', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_eval_zero_chunk_gold_diagnostics.sql', 'utf8')

  assert.match(sql, /approved relevant gold articles/i)
  assert.match(sql, /article_content_chars/)
  assert.match(sql, /chunk_versions/)
  assert.match(sql, /missing_article_text/)
  assert.match(sql, /below_default_chunk_backfill_min_chars/)
  assert.match(sql, /needs_chunk_backfill/)
  assert.match(sql, /stale_success/)
  assert.match(sql, /public\.rag_eval_gold_evidence/)
  assert.match(sql, /public\.daily_news/)
  assert.match(sql, /public\.sources/)
  assert.match(sql, /is_active = true/)
  assert.match(sql, /fetched_at/)
})

test('eval run notes parser is legacy-safe and defaults old notes to invalid strategy selection', () => {
  assert.deepEqual(parseEvalRunNotes('plain historical note'), {
    valid_for_strategy_selection: false,
    invalid_reason: 'legacy_or_nonconforming_notes',
    corpus_health_run_id: null,
  })

  assert.deepEqual(parseEvalRunNotes('{"gold_policy":"approved_only"}'), {
    valid_for_strategy_selection: false,
    invalid_reason: 'legacy_or_nonconforming_notes',
    corpus_health_run_id: null,
  })

  assert.deepEqual(parseEvalRunNotes('{"notes_schema_version":"rag-eval-run-notes-v1","valid_for_strategy_selection":true,"invalid_reason":null,"corpus_health_run_id":"abc"}'), {
    notes_schema_version: 'rag-eval-run-notes-v1',
    valid_for_strategy_selection: true,
    invalid_reason: null,
    corpus_health_run_id: 'abc',
  })
})

test('replay runner writes corpus-health validity metadata into eval run notes', () => {
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')
  const notes = buildEvalRunNotes({
    existing: { strategy: 'chunk_dense', gold_policy: 'approved_only' },
    validForStrategySelection: false,
    invalidReason: 'chunk_corpus_health_failed',
    corpusHealthRunId: '00000000-0000-0000-0000-000000000001',
  })

  assert.equal(notes.notes_schema_version, 'rag-eval-run-notes-v1')
  assert.equal(notes.valid_for_strategy_selection, false)
  assert.equal(notes.invalid_reason, 'chunk_corpus_health_failed')
  assert.equal(notes.corpus_health_run_id, '00000000-0000-0000-0000-000000000001')
  assert.equal(notes.strategy, 'chunk_dense')
  assert.match(replay, /--corpus-health-run-id/)
  assert.match(replay, /--valid-for-strategy-selection/)
  assert.match(replay, /--invalid-reason/)
  assert.match(replay, /buildEvalRunNotes/)
})

test('replay runner supports remediation smoke aliases and max-case caps', () => {
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(replay, /--max-cases/)
  assert.match(replay, /strategyAliases/)
  assert.match(replay, /article_dense/)
  assert.match(replay, /entity_expanded_chunk/)
  assert.match(replay, /rawStrategy/)
  assert.match(replay, /runnableCases\.slice\(0, maxCases\)/)
})

test('eval taxonomy SQL backfills case metadata and reports metrics by slice', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_eval_case_taxonomy.sql', 'utf8')
  const spec = readFileSync('docs/superpowers/specs/2026-06-01-rag-golden-dataset-v1-design.md', 'utf8')

  for (const field of [
    'format_cohort',
    'content_length_bucket',
    'source_type',
    'language',
    'question_type',
    'difficulty_tags',
    'entity_density',
    'origin',
  ]) {
    assert.match(sql, new RegExp(field))
    assert.match(spec, new RegExp(field))
  }

  assert.match(sql, /jsonb_set/)
  assert.match(sql, /public\.rag_eval_cases/)
  assert.match(sql, /public\.daily_news/)
  assert.match(sql, /public\.sources/)
  assert.match(sql, /short_news/)
  assert.match(sql, /long_form/)
  assert.match(sql, /transcript/)
  assert.match(sql, /reddit_social/)
  assert.match(sql, /official/)
  assert.match(sql, /metrics_by_taxonomy_slice/)
  assert.match(sql, /latest_run_by_strategy/)
  assert.match(sql, /slice_status/)
  assert.match(sql, /directional_n_lt_5/)
  assert.match(sql, /avg_recall_at_5/)
  assert.match(sql, /avg_ndcg_at_10/)
  assert.match(sql, /max_ndcg_at_10/)
  assert.match(sql, /where c\.metadata \? 'format_cohort'/)
})

test('hard negative SQL enforces zero relevance and proposes same-topic distractors', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_eval_hard_negatives.sql', 'utf8')
  const generateGold = readFileSync('scripts/rag-eval-generate-gold.mjs', 'utf8')

  assert.match(sql, /metadata->>'evidence_role' is distinct from 'hard_negative'/)
  assert.match(sql, /relevance_grade = 0/)
  assert.match(sql, /add constraint rag_eval_gold_hard_negative_zero_grade/)
  assert.match(sql, /same_topic_wrong_event/)
  assert.match(sql, /same_entity_wrong_time/)
  assert.match(sql, /same_source_wrong_article/)
  assert.match(sql, /semantically_similar_not_answer_supporting/)
  assert.match(sql, /hard_negative_candidate_proposals/)
  assert.match(sql, /limit 10/)
  assert.match(generateGold, /evidence_role/)
  assert.match(generateGold, /hard_negative/)
})

test('hard negative proposals require lexical overlap or top-k retrieval evidence', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_eval_hard_negatives.sql', 'utf8')

  assert.match(sql, /question_terms/)
  assert.match(sql, /primary_gold_terms/)
  assert.match(sql, /candidate_overlap/)
  assert.match(sql, /question_overlap_terms/)
  assert.match(sql, /gold_title_overlap_terms/)
  assert.match(sql, /appeared_in_top_k/)
  assert.match(sql, /strong_entity_tag_shared/)
  assert.match(sql, /question_overlap_terms >= 1/)
  assert.match(sql, /gold_title_overlap_terms >= 1/)
  assert.match(sql, /co\.appeared_in_top_k/)
  assert.match(sql, /co\.strong_entity_tag_shared/)
  assert.match(sql, /proposal_rank <= 10/)
  assert.match(sql, /review_status,\n  jsonb_build_object/)
})

test('hard negative diagnostics detect distractors above approved gold without positive gain', () => {
  const candidates = [
    { id: 'hard-a', rank: 1 },
    { id: 'gold-a', rank: 2 },
    { id: 'hard-b', rank: 3 },
  ]
  const goldRows = [
    { article_id: 'gold-a', relevance_grade: 3, review_status: 'approved' },
    { article_id: 'hard-a', relevance_grade: 0, review_status: 'approved', metadata: { evidence_role: 'hard_negative' } },
    { article_id: 'hard-b', relevance_grade: 0, review_status: 'approved', metadata: { evidence_role: 'hard_negative' } },
  ]

  assert.deepEqual(computeHardNegativeDiagnostics(candidates, goldRows), {
    hard_negatives_above_gold: 1,
    best_gold_rank: 2,
    best_hard_negative_rank: 1,
    hard_negative_article_ids_above_gold: ['hard-a'],
  })
})

test('article-level retrieval metrics de-duplicate repeated chunks from the same article', () => {
  const metrics = computeRetrievalMetrics(
    [
      { id: 'article-gold', article_id: 'article-gold', chunk_id: 'chunk-1', rank: 1 },
      { id: 'article-gold', article_id: 'article-gold', chunk_id: 'chunk-2', rank: 2 },
      { id: 'article-miss', article_id: 'article-miss', chunk_id: 'chunk-3', rank: 3 },
    ],
    [
      {
        article_id: 'article-gold',
        relevance_grade: 3,
        review_status: 'approved',
        metadata: {},
      },
    ],
  )

  assert.equal(metrics.recall_at_3, 1)
  assert.equal(metrics.recall_at_5, 1)
  assert.equal(metrics.hit_at_5, true)
  assert.equal(metrics.mrr, 1)
  assert.equal(metrics.ndcg_at_10 <= 1, true)
})

test('graded non-threshold evidence cannot make NDCG exceed 1', () => {
  const metrics = computeRetrievalMetrics(
    [
      { id: 'answer-supporting', article_id: 'answer-supporting', rank: 1 },
      { id: 'related-grade-one', article_id: 'related-grade-one', rank: 2 },
    ],
    [
      {
        article_id: 'answer-supporting',
        relevance_grade: 2,
        review_status: 'approved',
        metadata: {},
      },
      {
        article_id: 'related-grade-one',
        relevance_grade: 1,
        review_status: 'approved',
        metadata: {},
      },
    ],
  )

  assert.equal(metrics.recall_at_10, 1)
  assert.equal(metrics.ndcg_at_10 <= 1, true)
})

test('replay runner reports hard negative diagnostics separately from retrieval metrics', () => {
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

  assert.match(replay, /computeHardNegativeDiagnostics/)
  assert.match(replay, /hard_negatives_above_gold/)
  assert.match(replay, /hard_negative_diagnostics/)
  assert.doesNotMatch(replay, /relevantGold.*hard_negative/s)
})

test('query rewrite helpers support eval-only modes with drift trace metadata', () => {
  const entity = rewriteQueryForEval('OpenAI IPO valuation hearing on April 27?', 'entity_expansion')
  const none = rewriteQueryForEval('plain question', 'none')
  const trace = buildEvalRewriteTrace({
    originalQuery: 'OpenAI IPO valuation hearing on April 27?',
    rewrittenQuery: entity.rewritten_query,
    rewriteMode: 'entity_expansion',
    accepted: true,
    rejectReason: null,
    similarity: 0.91,
  })

  assert.equal(none.rewritten_query, 'plain question')
  assert.equal(entity.rewrite_mode, 'entity_expansion')
  assert.match(entity.rewritten_query, /OpenAI/)
  assert.equal(trace.original_query, 'OpenAI IPO valuation hearing on April 27?')
  assert.equal(trace.rewrite_mode, 'entity_expansion')
  assert.equal(trace.accepted, true)
  assert.equal(trace.drift_threshold, 0.82)
})

test('replay runner supports rewrite modes and stores fallback trace metadata', () => {
  const lib = readFileSync('scripts/rag-eval-lib.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')
  const sql = readFileSync('supabase/sql/20260608_rag_query_rewrite_diagnostics.sql', 'utf8')

  for (const mode of ['none', 'entity_expansion', 'hyde', 'decomposition', 'context_completion']) {
    assert.match(lib, new RegExp(mode))
    assert.match(replay, new RegExp(mode))
    assert.match(sql, new RegExp(mode))
  }

  assert.match(replay, /--rewrite-mode/)
  assert.match(replay, /chunk_dense_rewrite_\$\{rewriteMode\}/)
  assert.match(replay, /agentic_decomposition_eval/)
  assert.match(replay, /rewrite_trace/)
  assert.match(replay, /baseline_retrieval_always_runs/)
  assert.match(sql, /original_query/)
  assert.match(sql, /rewritten_query/)
  assert.match(sql, /reject_reason/)
  assert.match(sql, /top_candidate_divergence/)
})

test('Cloudflare rerank helper maps indexed scores back to original ordered candidates', () => {
  const candidates = [
    { id: 'a', rank: 1, summary: 'first' },
    { id: 'b', rank: 2, summary: 'second' },
  ]
  const mapped = mapCloudflareRerankResults(candidates, [
    { index: 1, score: 0.9 },
    { index: 0, score: 0.2 },
  ], '@cf/baai/bge-reranker-base')

  assert.equal(buildCloudflareRerankUrl('acct'), 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/baai/bge-reranker-base')
  assert.equal(mapped[0].id, 'b')
  assert.equal(mapped[0].score_rerank, 0.9)
  assert.equal(mapped[0].metadata.rerank_model, '@cf/baai/bge-reranker-base')
  assert.equal(mapped[1].id, 'a')
})

test('rerank cache SQL and replay metadata include cache key, hit/miss, and latency fields', () => {
  const keyA = buildRerankCacheKey({
    normalizedQuery: 'same',
    orderedCandidateIds: ['a', 'b'],
    contextHashes: ['h1', 'h2'],
    rerankModel: '@cf/baai/bge-reranker-base',
    chunkingVersion: 'v1',
    strategyVariant: 'rerank_hybrid',
  })
  const keyB = buildRerankCacheKey({
    normalizedQuery: 'same',
    orderedCandidateIds: ['b', 'a'],
    contextHashes: ['h2', 'h1'],
    rerankModel: '@cf/baai/bge-reranker-base',
    chunkingVersion: 'v1',
    strategyVariant: 'rerank_hybrid',
  })
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')
  const sql = readFileSync('supabase/sql/20260608_rag_eval_rerank_cache.sql', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.notEqual(keyA, keyB)
  assert.equal(pkg.scripts['eval:rerank'], 'node scripts/rag-eval-replay.mjs --strategy rerank_hybrid')
  assert.match(sql, /create table if not exists public\.rag_eval_rerank_cache/)
  assert.match(sql, /unique\(cache_key\)/)
  assert.match(sql, /cache_version text not null/)
  assert.match(sql, /stale_reason text/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /grant all on public\.rag_eval_rerank_cache to service_role/)
  assert.match(replay, /rerankCandidatesWithCache/)
  assert.match(replay, /cache_hit/)
  assert.match(replay, /rerank_latency_ms/)
  assert.match(replay, /cold_cache_latency_ms/)
  assert.match(replay, /warm_cache_latency_ms/)
})
