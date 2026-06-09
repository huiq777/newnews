#!/usr/bin/env node

import process from 'node:process'

import {
  BGE_EMBEDDING_MODEL,
  DEFAULT_EVAL_SET,
  RETRIEVAL_STRATEGY,
  RETRIEVAL_VERSION,
  RETRIEVER_NAME,
  RUNNER_VERSION,
  average,
  bgeEmbedSearchQuery,
  buildEvalRunNotes,
  buildEvalRewriteTrace,
  cohereEmbedSearchQuery,
  computeHardNegativeDiagnostics,
  computeRetrievalMetrics,
  EVAL_REWRITE_MODES,
  expandRetrievalQueries,
  fetchChunkDenseCandidates,
  fetchLexicalCandidates,
  fuseCandidatesByRrf,
  fuseCandidatesWeightedRrf,
  normalizeCandidate,
  parseArgs,
  percentile,
  requiredEnv,
  rerankCandidatesWithJudge,
  rerankCandidatesWithCache,
  rewriteQueryForEval,
  restInsert,
  restSelect,
  rpc,
} from './rag-eval-lib.mjs'

async function main() {
  const args = parseArgs()

  const setName = String(args.set || DEFAULT_EVAL_SET)
  const matchCount = args.match ? Number(args.match) : 10
  // Smoke-run limiter used by remediation commands: --max-cases.
  const maxCases = args['max-cases'] ? Number(args['max-cases']) : Infinity
  const allowPending = args['allow-pending'] !== 'false'
  // Corpus-health gate flags: --corpus-health-run-id, --valid-for-strategy-selection, --invalid-reason.
  const validForStrategySelection = args['valid-for-strategy-selection'] === 'true'
  const invalidReason = args['invalid-reason'] ? String(args['invalid-reason']) : null
  const corpusHealthRunId = args['corpus-health-run-id'] ? String(args['corpus-health-run-id']) : null
  // Eval-only rewrite flag: --rewrite-mode none|entity_expansion|hyde|decomposition|context_completion.
  const rewriteMode = String(args['rewrite-mode'] || 'none')
  if (!EVAL_REWRITE_MODES.includes(rewriteMode)) {
    throw new Error(`--rewrite-mode must be one of: ${EVAL_REWRITE_MODES.join(', ')}`)
  }
  // --strategy controls eval replay only. Remediation aliases map to existing eval-only strategies.
  const strategyAliases = {
    article_dense: 'dense',
    entity_expanded_chunk: 'entity_hybrid',
  }
  const rawStrategy = String(args.strategy || 'dense')
  const strategy = strategyAliases[rawStrategy] || rawStrategy
  if (!['dense', 'lexical', 'hybrid', 'chunk_dense', 'chunk_hybrid', 'entity_hybrid', 'rerank_hybrid'].includes(strategy)) {
    throw new Error('--strategy must be dense, lexical, hybrid, chunk_dense, chunk_hybrid, entity_hybrid, rerank_hybrid, article_dense, or entity_expanded_chunk')
  }
  const baseEnvNames = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
  if (['dense', 'hybrid'].includes(strategy)) baseEnvNames.push('COHERE_API_KEY')
  if (['chunk_dense', 'chunk_hybrid', 'entity_hybrid', 'rerank_hybrid'].includes(strategy)) {
    baseEnvNames.push('BGE_EMBEDDING_BASE_URL', 'BGE_EMBEDDING_API_KEY')
  }
  const env = requiredEnv(baseEnvNames)
  if (strategy === 'rerank_hybrid') {
    if (process.env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
    if (process.env.CLOUDFLARE_AUTH_TOKEN) env.CLOUDFLARE_AUTH_TOKEN = process.env.CLOUDFLARE_AUTH_TOKEN
    if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AUTH_TOKEN) {
      Object.assign(env, requiredEnv(['TOKENROUTER_API_KEY']))
    }
    if (process.env.RAG_EVAL_RERANK_MODEL) env.RAG_EVAL_RERANK_MODEL = process.env.RAG_EVAL_RERANK_MODEL
    if (process.env.RAG_EVAL_RERANK_TIMEOUT_MS) env.RAG_EVAL_RERANK_TIMEOUT_MS = process.env.RAG_EVAL_RERANK_TIMEOUT_MS
  }
  // Optional replay tuning flags: --chunking-version, --vector-weight, --lexical-weight, --chunk-weight.
  const chunkingVersion = args['chunking-version'] ? String(args['chunking-version']) : null
  const embeddingModel = ['chunk_dense', 'chunk_hybrid', 'entity_hybrid', 'rerank_hybrid'].includes(strategy)
    ? BGE_EMBEDDING_MODEL
    : 'embed-english-v3.0'
  const defaultChunkWeight = strategy === 'chunk_hybrid' ? 1 : 0
  const fusionWeights = {
    vector: Number(args['vector-weight'] || 1),
    lexical: Number(args['lexical-weight'] || 1),
    chunk: Number(args['chunk-weight'] || defaultChunkWeight),
  }
  const strategyVariant = buildStrategyVariant(strategy, {
    vector: fusionWeights.vector,
    lexical: fusionWeights.lexical,
    chunk: fusionWeights.chunk,
  })
  const rewriteStrategyPrefix = rewriteMode === 'none' ? strategyVariant : `${strategy}_rewrite_${rewriteMode}`
  // Example rewrite labels: chunk_dense_rewrite_${rewriteMode}, chunk_dense_rewrite_none, chunk_dense_rewrite_entity_expansion.
  const strategyLabel = `${rewriteStrategyPrefix}_${RETRIEVAL_STRATEGY}`
  // Label reserved for Task 6/7 eval orchestration: agentic_decomposition_eval.
  const retrieverName = strategy === 'dense'
    ? RETRIEVER_NAME
    : strategy === 'lexical'
      ? 'match_articles_lexical_eval'
      : strategy === 'chunk_dense'
        ? 'match_article_chunks_eval'
        : strategy === 'chunk_hybrid'
          ? 'match_article_chunks_eval+match_articles_lexical_eval'
          : strategy === 'entity_hybrid'
            ? `${RETRIEVER_NAME}+match_articles_lexical_eval+entity_expansion`
            : strategy === 'rerank_hybrid'
              ? 'match_article_chunks_eval+match_articles_lexical_eval+rerank'
              : `${RETRIEVER_NAME}+match_articles_lexical_eval`

  const evalSet = await findEvalSet(env, setName)
  const cases = await restSelect(
    env,
    `rag_eval_cases?eval_set_id=eq.${evalSet.id}&select=*&order=created_at.asc`
  )
  if (cases.length === 0) throw new Error(`No eval cases found for set ${setName}`)

  const goldByCase = await loadGold(env, cases.map(row => row.id), allowPending)
  const runnableCases = cases.filter(row => (goldByCase.get(row.id) || []).some(g => g.relevance_grade >= 2))
  const selectedCases = runnableCases.slice(0, maxCases)
  if (runnableCases.length === 0) throw new Error('No cases have relevant gold evidence (grade >= 2). Generate/approve gold first.')

  const evalRunNotes = buildEvalRunNotes({
    existing: {
      gold_policy: allowPending ? 'approved_preferred_pending_fallback' : 'approved_only',
      raw_strategy: rawStrategy,
      strategy,
      strategy_variant: strategyVariant,
      fusion_weights: {
        vector: fusionWeights.vector,
        lexical: fusionWeights.lexical,
        chunk: fusionWeights.chunk,
      },
    },
    validForStrategySelection,
    invalidReason,
    corpusHealthRunId,
  })

  const evalRun = (await restInsert(env, 'rag_eval_runs', [{
    eval_set_id: evalSet.id,
    runner_version: RUNNER_VERSION,
    retrieval_strategy: strategyLabel,
    retrieval_version: RETRIEVAL_VERSION,
    notes: JSON.stringify(evalRunNotes),
  }]))[0]

  const caseResults = []
  const hardNegativeDiagnostics = []
  const latencies = []
  let approvedGoldCount = 0
  let pendingFallbackCases = 0

  for (const evalCase of selectedCases) {
    const goldRows = goldByCase.get(evalCase.id) || []
    if (goldRows.some(row => row.review_status === 'pending')) pendingFallbackCases += 1
    approvedGoldCount += goldRows.filter(row => row.review_status === 'approved' && row.relevance_grade >= 2).length

    const rewrite = rewriteQueryForEval(evalCase.question, rewriteMode)
    const rewriteAccepted = rewriteMode === 'none'
      || (rewriteMode === 'entity_expansion' && rewrite.rewritten_query.includes(evalCase.question))
      || rewriteMode === 'decomposition'
    const rewriteTrace = buildEvalRewriteTrace({
      originalQuery: evalCase.question,
      rewrittenQuery: rewrite.rewritten_query,
      rewriteMode,
      accepted: rewriteAccepted,
      rejectReason: rewriteAccepted ? null : 'bge_similarity_or_llm_judge_not_available',
      similarity: null,
      topCandidateDivergence: null,
    })
    const retrievalEvalCase = rewriteAccepted
      ? { ...evalCase, question: rewrite.rewritten_query }
      : evalCase

    const { candidates, latencyMs, rerankMetadata = null } = await retrieveCandidates(env, retrievalEvalCase, matchCount, strategy, {
      chunkingVersion,
      embeddingModel,
      fusionWeights,
    })
    latencies.push(latencyMs)

    const retrievalRun = await recordRetrievalTrace(
      env,
      evalCase,
      candidates,
      matchCount,
      latencyMs,
      strategyLabel,
      retrieverName,
      strategy,
      {
        chunkingVersion,
        embeddingModel,
        strategyVariant,
        fusionWeights,
        rewriteTrace: {
          ...rewriteTrace,
          baseline_retrieval_always_runs: true,
          rewrite_metadata: rewrite.metadata,
        },
        rerankMetadata,
      }
    )
    const metrics = computeRetrievalMetrics(candidates, goldRows)
    const hardNegativeDiagnostic = computeHardNegativeDiagnostics(candidates, goldRows)
    caseResults.push(metrics)
    hardNegativeDiagnostics.push(hardNegativeDiagnostic)

    await restInsert(env, 'rag_eval_case_results', [{
      eval_run_id: evalRun.id,
      case_id: evalCase.id,
      retrieval_run_id: retrievalRun.id,
      recall_at_3: metrics.recall_at_3,
      recall_at_5: metrics.recall_at_5,
      recall_at_10: metrics.recall_at_10,
      mrr: metrics.mrr,
      ndcg_at_10: metrics.ndcg_at_10,
      hit_at_5: metrics.hit_at_5,
    }], {
      upsert: true,
      onConflict: 'eval_run_id,case_id',
    })

    const hardNegativeSummary = hardNegativeDiagnostic.hard_negatives_above_gold > 0
      ? ` | hard_negative_diagnostics: ${hardNegativeDiagnostic.hard_negatives_above_gold} above gold`
      : ''
    console.log(`${fmt(metrics.recall_at_10)} R@10 | ${fmt(metrics.mrr)} MRR${hardNegativeSummary} | ${evalCase.question.slice(0, 70)}`)
  }

  const aggregate = {
    eval_run_id: evalRun.id,
    avg_recall_at_3: average(caseResults, 'recall_at_3'),
    avg_recall_at_5: average(caseResults, 'recall_at_5'),
    avg_recall_at_10: average(caseResults, 'recall_at_10'),
    avg_mrr: average(caseResults, 'mrr'),
    avg_ndcg_at_10: average(caseResults, 'ndcg_at_10'),
    avg_hit_rate_at_5: caseResults.filter(row => row.hit_at_5).length / caseResults.length,
    total_cases: caseResults.length,
    approved_gold_count: approvedGoldCount,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
  }

  await restInsert(env, 'rag_eval_retrieval_metrics', [aggregate])
  printReport(setName, evalRun.id, aggregate, pendingFallbackCases, hardNegativeDiagnostics)
}

async function findEvalSet(env, name) {
  const rows = await restSelect(env, `rag_eval_sets?name=eq.${encodeURIComponent(name)}&select=*&limit=1`)
  if (!rows[0]) throw new Error(`Eval set not found: ${name}`)
  return rows[0]
}

async function loadGold(env, caseIds, allowPending) {
  const approvedRows = await restSelect(
    env,
    `rag_eval_gold_evidence?case_id=in.(${caseIds.join(',')})&review_status=eq.approved&select=*`
  )
  const approvedByCase = groupByCase(approvedRows)
  if (!allowPending) return approvedByCase

  const casesNeedingFallback = caseIds.filter(id => !approvedByCase.has(id))
  if (casesNeedingFallback.length === 0) return approvedByCase

  const pendingRows = await restSelect(
    env,
    `rag_eval_gold_evidence?case_id=in.(${casesNeedingFallback.join(',')})&review_status=eq.pending&select=*`
  )
  const pendingByCase = groupByCase(pendingRows)
  for (const [caseId, rows] of pendingByCase.entries()) approvedByCase.set(caseId, rows)
  if (pendingRows.length > 0) {
    console.warn(`Warning: using pending gold evidence for ${pendingByCase.size} cases. Approve labels after HITL review for official metrics.`)
  }
  return approvedByCase
}

function groupByCase(rows) {
  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.case_id)) grouped.set(row.case_id, [])
    grouped.get(row.case_id).push(row)
  }
  return grouped
}

function buildStrategyVariant(strategy, weights) {
  const vector = Number.isFinite(weights.vector) ? weights.vector : 1
  const lexical = Number.isFinite(weights.lexical) ? weights.lexical : 1
  const chunk = Number.isFinite(weights.chunk) ? weights.chunk : 1
  if (!['hybrid', 'entity_hybrid', 'chunk_hybrid', 'rerank_hybrid'].includes(strategy)) {
    return strategy
  }
  return `${strategy}_vw${vector}_lw${lexical}_cw${chunk}`.replaceAll('.', 'p')
}

async function retrieveCandidates(env, evalCase, matchCount, strategy, options = {}) {
  const {
    chunkingVersion = null,
    embeddingModel = BGE_EMBEDDING_MODEL,
    fusionWeights = { vector: 1, lexical: 1, chunk: 1 },
  } = options
  const start = Date.now()
  const expandedQueries = strategy === 'entity_hybrid'
    ? expandRetrievalQueries(evalCase.question)
    : [evalCase.question]

  if (strategy === 'lexical') {
    const candidates = await fetchLexicalCandidates(env, evalCase.question, matchCount)
    return { candidates, latencyMs: Date.now() - start }
  }

  if (strategy === 'chunk_dense') {
    const queryEmbedding = await bgeEmbedSearchQuery(env, evalCase.question)
    const chunkCandidates = await fetchChunkDenseCandidates(env, queryEmbedding, matchCount, chunkingVersion, 5, embeddingModel)
    return { candidates: chunkCandidates, latencyMs: Date.now() - start }
  }

  if (strategy === 'chunk_hybrid') {
    const overfetchCount = Math.max(matchCount * 3, 30)
    const queryEmbedding = await bgeEmbedSearchQuery(env, evalCase.question)
    const vectorCandidates = (await fetchChunkDenseCandidates(env, queryEmbedding, Math.max(matchCount * 3, 30), chunkingVersion))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'vector' } }))
    const lexicalCandidates = (await safeFetchLexicalCandidates(env, evalCase.question, Math.max(matchCount * 3, 30)))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'lexical' } }))
    const candidates = fuseCandidatesWeightedRrf([vectorCandidates, lexicalCandidates], fusionWeights, 50).slice(0, matchCount)
    void overfetchCount
    return { candidates, latencyMs: Date.now() - start }
  }

  if (strategy === 'entity_hybrid') {
    const overfetchCount = Math.max(matchCount * 3, 30)
    const queryEmbedding = await bgeEmbedSearchQuery(env, expandedQueries[0])
    const vectorCandidates = (await fetchChunkDenseCandidates(env, queryEmbedding, overfetchCount, chunkingVersion, 5, embeddingModel))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'vector' } }))
    const lexicalCandidates = (await safeFetchLexicalCandidates(env, expandedQueries[1] || expandedQueries[0], overfetchCount))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'lexical' } }))
    const candidates = fuseCandidatesWeightedRrf([vectorCandidates, lexicalCandidates], fusionWeights, 50).slice(0, matchCount)
    return {
      candidates: candidates.map(row => ({
        ...row,
        metadata: { ...(row.metadata || {}), expanded_queries: expandedQueries },
      })),
      latencyMs: Date.now() - start,
    }
  }

  if (strategy === 'rerank_hybrid') {
    const overfetchCount = Math.max(matchCount * 3, 30)
    const queryEmbedding = await bgeEmbedSearchQuery(env, evalCase.question)
    const denseCandidates = (await fetchChunkDenseCandidates(env, queryEmbedding, overfetchCount, chunkingVersion, 5, embeddingModel))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'chunk' } }))
    const lexicalCandidates = (await safeFetchLexicalCandidates(env, evalCase.question, overfetchCount))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'lexical' } }))
    const fused = fuseCandidatesByRrf([denseCandidates, lexicalCandidates]).slice(0, overfetchCount)
    void rerankCandidatesWithJudge
    const reranked = await rerankCandidatesWithCache(env, evalCase.question, fused, {
      chunkingVersion,
      strategyVariant: 'rerank_hybrid',
    })
    return {
      candidates: reranked.candidates.slice(0, matchCount),
      latencyMs: Date.now() - start,
      rerankMetadata: reranked.metadata,
    }
  }

  const queryEmbedding = await cohereEmbedSearchQuery(env.COHERE_API_KEY, evalCase.question)
  const rawDense = await rpc(env, 'match_articles_prefer_analysis', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  })
  const denseCandidates = rawDense.map(normalizeCandidate).filter(row => row.id)
  if (strategy === 'dense') return { candidates: denseCandidates, latencyMs: Date.now() - start }

  const lexicalCandidates = await safeFetchLexicalCandidates(env, evalCase.question, matchCount)
  const candidates = fuseCandidatesByRrf([denseCandidates, lexicalCandidates]).slice(0, matchCount)
  return { candidates, latencyMs: Date.now() - start }
}

async function safeFetchLexicalCandidates(env, question, matchCount) {
  try {
    return await fetchLexicalCandidates(env, question, matchCount)
  } catch (error) {
    console.warn(`Skipping lexical replay candidates after RPC failure: ${error.message}`)
    return []
  }
}

async function recordRetrievalTrace(env, evalCase, candidates, matchCount, latencyMs, strategyLabel, retrieverName, strategy, options = {}) {
  const {
    chunkingVersion = null,
    embeddingModel = 'embed-english-v3.0',
    strategyVariant = strategy,
    fusionWeights = { vector: 1, lexical: 1, chunk: 0 },
    rewriteTrace = null,
    rerankMetadata = null,
  } = options
  const retrievalRun = (await restInsert(env, 'rag_retrieval_runs', [{
    surface: evalCase.surface,
    query_text: evalCase.question,
    query_input: {
      eval_case_id: evalCase.id,
      eval_set_id: evalCase.eval_set_id,
      lang: evalCase.lang,
      primary_article_id: evalCase.primary_article_id,
      chunking_version: chunkingVersion,
      dense_embedding_model: embeddingModel,
      expanded_queries: strategy === 'entity_hybrid' ? expandRetrievalQueries(evalCase.question) : null,
      strategy_variant: strategyVariant,
      fusion_weights: {
        vector: fusionWeights.vector,
        lexical: fusionWeights.lexical,
        chunk: fusionWeights.chunk,
      },
      rewrite_trace: rewriteTrace,
      baseline_retrieval_always_runs: true,
      rerank_metadata: rerankMetadata,
      cache_hit: rerankMetadata?.cache_hit ?? null,
      rerank_latency_ms: rerankMetadata?.rerank_latency_ms ?? null,
      cold_cache_latency_ms: rerankMetadata?.cold_cache_latency_ms ?? null,
      warm_cache_latency_ms: rerankMetadata?.warm_cache_latency_ms ?? null,
    },
    query_embedding_model: embeddingModel,
    embedding_input_type: 'search_query',
    retrieval_strategy: strategyLabel,
    retrieval_version: RETRIEVAL_VERSION,
    retriever_name: retrieverName,
    match_count: matchCount,
    candidate_count: candidates.length,
    injected_count: 0,
    context_total_chars: 0,
    latency_ms: latencyMs,
  }]))[0]

  if (candidates.length > 0) {
    await restInsert(env, 'rag_retrieval_candidates', candidates.map(candidate => ({
      retrieval_run_id: retrievalRun.id,
      rank: candidate.rank,
      candidate_type: candidate.candidate_type || 'article',
      article_id: candidate.id || candidate.article_id,
      chunk_id: candidate.chunk_id || null,
      title: candidate.title,
      summary_excerpt: candidate.summary.slice(0, 1000),
      score_dense: candidate.score ?? candidate.score_dense ?? null,
      score_lexical: candidate.score_lexical ?? null,
      score_rerank: candidate.score_rerank ?? null,
      score_final: candidate.score_final ?? candidate.score ?? candidate.score_lexical ?? null,
      embedding_source: candidate.embedding_source,
      injected: false,
      drop_reason: 'eval_replay_not_prompt_injected',
      metadata: {
        eval_case_id: evalCase.id,
        eval_set_id: evalCase.eval_set_id,
        replay_strategy: strategy,
        fusion_sources: candidate.metadata?.fusion_sources || null,
        lexical_terms: candidate.metadata?.lexical_terms || null,
        expanded_queries: candidate.metadata?.expanded_queries || null,
        chunk_rank: candidate.metadata?.chunk_rank || null,
        article_rank: candidate.metadata?.article_rank || null,
        chunk_index: candidate.metadata?.chunk_index || null,
        rerank_cache_key: candidate.metadata?.rerank_cache_key || null,
        cache_hit: candidate.metadata?.cache_hit ?? null,
        rerank_latency_ms: candidate.metadata?.rerank_latency_ms ?? null,
        cold_cache_latency_ms: candidate.metadata?.cold_cache_latency_ms ?? null,
        warm_cache_latency_ms: candidate.metadata?.warm_cache_latency_ms ?? null,
      },
    })))
  }

  return retrievalRun
}

function printReport(setName, runId, metrics, pendingFallbackCases, hardNegativeDiagnostics = []) {
  const hardNegativesAboveGold = hardNegativeDiagnostics.reduce((sum, row) => sum + row.hard_negatives_above_gold, 0)
  console.log('\n## RAG Retrieval Replay')
  console.log(`Eval set: ${setName}`)
  console.log(`Eval run: ${runId}`)
  if (pendingFallbackCases > 0) console.log(`Warning: ${pendingFallbackCases} cases used pending gold fallback.`)
  console.log('')
  console.log('| metric | value |')
  console.log('| --- | ---: |')
  console.log(`| cases | ${metrics.total_cases} |`)
  console.log(`| avg_recall_at_3 | ${fmt(metrics.avg_recall_at_3)} |`)
  console.log(`| avg_recall_at_5 | ${fmt(metrics.avg_recall_at_5)} |`)
  console.log(`| avg_recall_at_10 | ${fmt(metrics.avg_recall_at_10)} |`)
  console.log(`| avg_mrr | ${fmt(metrics.avg_mrr)} |`)
  console.log(`| avg_ndcg_at_10 | ${fmt(metrics.avg_ndcg_at_10)} |`)
  console.log(`| avg_hit_rate_at_5 | ${fmt(metrics.avg_hit_rate_at_5)} |`)
  console.log(`| latency_p50_ms | ${metrics.latency_p50_ms} |`)
  console.log(`| latency_p95_ms | ${metrics.latency_p95_ms} |`)
  console.log(`| hard_negatives_above_gold | ${hardNegativesAboveGold} |`)
}

function fmt(value) {
  return Number(value).toFixed(3)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
