#!/usr/bin/env node

import process from 'node:process'

import { orchestrateAgenticRag } from './rag-agentic-runtime.mjs'
import {
  DEFAULT_EVAL_SET,
  buildEvalRunNotes,
  parseArgs,
  requiredEnv,
  restInsert,
  restSelect,
} from './rag-eval-lib.mjs'

// CLI flags: --max-cases, --dry-run-budget, --retrieval-strategy, --chunking-version, --corpus-health-run-id, --valid-for-strategy-selection, --invalid-reason.
const AGENTIC_SLICES = ['multi-hop', 'comparison', 'ambiguous follow-up', 'entity-heavy', 'low-context/conflicting evidence']

async function main() {
  const args = parseArgs()
  const maxCases = Number(args['max-cases'] || 3)
  const retrievalStrategy = String(args['retrieval-strategy'] || 'chunk_dense')
  const chunkingVersion = args['chunking-version'] ? String(args['chunking-version']) : null
  const validForStrategySelection = args['valid-for-strategy-selection'] === 'true'
  const invalidReason = args['invalid-reason']
    ? String(args['invalid-reason'])
    : 'agentic_eval_smoke_requires_corpus_health_gate'
  const corpusHealthRunId = args['corpus-health-run-id'] ? String(args['corpus-health-run-id']) : null
  const budgetNotes = buildEvalRunNotes({
    existing: {
      retrieval_strategy: retrievalStrategy,
      chunking_version: chunkingVersion,
      eval_path: 'agentic_rag_eval',
    },
    validForStrategySelection,
    invalidReason,
    corpusHealthRunId,
    llmMetadata: {
      estimated_tokens: 0,
      max_cases: maxCases,
      cache_policy: 'read_write',
      timeout_ms: 8000,
      llm_call_count: 0,
      models: [],
      dry_run_budget: args['dry-run-budget'] === true,
    },
  })
  if (args['dry-run-budget']) {
    console.log(JSON.stringify({
      slices: AGENTIC_SLICES,
      retrieval_strategy: retrievalStrategy,
      chunking_version: chunkingVersion,
      loop_safety: 'max_two_rounds',
      budget_notes: budgetNotes,
    }, null, 2))
    return
  }

  const env = requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])
  const evalSetName = String(args.set || DEFAULT_EVAL_SET)
  const evalSet = (await restSelect(env, `rag_eval_sets?name=eq.${encodeURIComponent(evalSetName)}&select=*&limit=1`))[0]
  if (!evalSet) throw new Error(`Eval set not found: ${evalSetName}`)
  const cases = await restSelect(env, `rag_eval_cases?eval_set_id=eq.${evalSet.id}&select=*&order=created_at.asc&limit=${maxCases}`)

  const sliceCounts = new Map()
  for (const evalCase of cases) {
    const result = await orchestrateAgenticRag(evalCase.question, {
      retriever: async () => [],
    })
    const slice_n = sliceCounts.get(result.intent) || 0
    sliceCounts.set(result.intent, slice_n + 1)
    await writeTraceRows(env, evalCase.id, result, slice_n >= 5, {
      retrievalStrategy,
      chunkingVersion,
      corpusHealthRunId,
      validForStrategySelection,
    })
  }

  console.log(JSON.stringify({
    slices: [...sliceCounts.entries()].map(([intent, slice_n]) => ({
      intent,
      slice_n,
      interpretation: slice_n >= 5 ? 'eligible_for_pass_fail' : 'directional_only',
    })),
    loop_safety: 'max_two_rounds',
  }, null, 2))
}

async function writeTraceRows(env, evalCaseId, result, sliceHasEnoughCases, options = {}) {
  const {
    retrievalStrategy = 'chunk_dense',
    chunkingVersion = null,
    corpusHealthRunId = null,
    validForStrategySelection = false,
  } = options
  const rows = result.plan.subqueries.map(subquery => ({
    eval_case_id: evalCaseId,
    plan_id: result.plan.plan_id,
    intent: result.intent,
    subquery,
    retrieval_round: result.trace.retrieval_rounds,
    strategy: result.candidates[0]?.source_strategy || retrievalStrategy,
    candidate_count: result.candidates.length,
    critique_sufficient: result.critique.sufficient,
    critique_answerable: result.critique.answerable,
    retry_reason: result.critique.retry_reason,
    stop_reason: result.trace.stop_reason,
    latency_ms: result.trace.latency_ms,
    metadata: {
      subquery_count: result.trace.subquery_count,
      loop_safety: result.trace.retrieval_rounds <= 2,
      slice_n_gte_5: sliceHasEnoughCases,
      interpretation: sliceHasEnoughCases ? 'eligible_for_pass_fail' : 'directional_only',
      retrieval_strategy: retrievalStrategy,
      chunking_version: chunkingVersion,
      corpus_health_run_id: corpusHealthRunId,
      valid_for_strategy_selection: validForStrategySelection,
    },
  }))
  await restInsert(env, 'agentic_rag_eval_traces', rows)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
