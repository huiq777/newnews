#!/usr/bin/env node

import process from 'node:process'

import {
  buildEvalRunNotes,
  callTokenRouterJson,
  parseArgs,
  requiredEnv,
  restInsert,
  restSelect,
} from './rag-eval-lib.mjs'

const JUDGE_MODEL = process.env.RAG_GENERATION_EVAL_JUDGE_MODEL || 'qwen/qwen3.5-flash'
const JUDGE_PROMPT_VERSION = 'rag-generation-eval-judge-v1-2026-06-08'
// CLI flags: --max-cases, --dry-run-budget, --mode, --retrieval-strategy.

async function main() {
  const args = parseArgs()
  const maxCases = Number(args['max-cases'] || 3)
  const generationEvalMode = args.mode ? String(args.mode) : null
  const retrievalStrategy = args['retrieval-strategy'] ? String(args['retrieval-strategy']) : null
  const budgetNotes = buildEvalRunNotes({
    validForStrategySelection: false,
    invalidReason: 'generation_judge_smoke_requires_corpus_health_gate',
    llmMetadata: {
      estimated_tokens: maxCases * 1600,
      max_cases: maxCases,
      cache_policy: 'read_write',
      timeout_ms: Number(process.env.RAG_GENERATION_EVAL_JUDGE_TIMEOUT_MS || 120000),
      llm_call_count: maxCases,
      models: [JUDGE_MODEL],
      dry_run_budget: args['dry-run-budget'] === true,
    },
  })
  // notes_schema_version: rag-eval-run-notes-v1
  if (args['dry-run-budget']) {
    console.log(JSON.stringify({ cache_policy: budgetNotes.cache_policy, budget_notes: budgetNotes }, null, 2))
    return
  }

  const env = requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TOKENROUTER_API_KEY'])
  const resultFilters = [
    'faithfulness_score=is.null',
    'select=*',
    'order=created_at.asc',
    `limit=${maxCases}`,
  ]
  if (generationEvalMode) resultFilters.unshift(`generation_eval_mode=eq.${encodeURIComponent(generationEvalMode)}`)
  if (retrievalStrategy) resultFilters.unshift(`metadata->>retrieval_strategy=eq.${encodeURIComponent(retrievalStrategy)}`)
  const rows = await restSelect(
    env,
    `rag_generation_eval_results?${resultFilters.join('&')}`
  )
  for (const row of rows) {
    const scores = await judgeAnswer(env, row)
    await restInsert(env, 'rag_generation_eval_results', [{
      ...row,
      judge_model: JUDGE_MODEL,
      judge_prompt_version: JUDGE_PROMPT_VERSION,
      faithfulness_score: scores.faithfulness_score,
      answer_relevancy_score: scores.answer_relevancy_score,
      context_precision_score: scores.context_precision_score,
      context_recall_score: scores.context_recall_score,
      metadata: {
        ...(row.metadata || {}),
        judge_reason: scores.reason || null,
      },
    }], { upsert: true, onConflict: 'eval_run_id,case_id,generation_eval_mode,context_pack_version' })
  }
}

async function judgeAnswer(env, row) {
  return callTokenRouterJson(env.TOKENROUTER_API_KEY, JUDGE_MODEL, [
    {
      role: 'system',
      content: [
        'You are judging generated RAG answers against provided context.',
        'Return JSON only with numeric scores from 0 to 1:',
        '{"faithfulness_score":0,"answer_relevancy_score":0,"context_precision_score":0,"context_recall_score":0,"reason":"short"}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Context:\n${row.context_text}`,
        `Answer:\n${row.answer_text || ''}`,
      ].join('\n\n'),
    },
  ], Number(process.env.RAG_GENERATION_EVAL_JUDGE_TIMEOUT_MS || 120000))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
