#!/usr/bin/env node

import process from 'node:process'

import {
  DEFAULT_EVAL_SET,
  buildEvalRunNotes,
  fetchWithRetry,
  hashText,
  parseArgs,
  requiredEnv,
  restInsert,
  restSelect,
} from './rag-eval-lib.mjs'

const CONTEXT_PACK_VERSION = 'answer-question-v1-prefer-analysis'
const ANSWER_PROMPT_VERSION = 'rag-generation-eval-answer-v1-2026-06-08'
const DEFAULT_ANSWER_MODEL = process.env.RAG_GENERATION_EVAL_ANSWER_MODEL || 'qwen/qwen3.5-flash'
const GENERATION_MODES = ['inline_article_generation_eval', 'corpus_retrieval_generation_eval']
// CLI flags: --max-cases, --dry-run-budget, --mode, --context-pack-version, --retrieval-strategy, --chunking-version, --corpus-health-run-id, --valid-for-strategy-selection, --invalid-reason.

async function main() {
  const args = parseArgs()
  const maxCases = Number(args['max-cases'] || 3)
  const generationEvalMode = String(args.mode || 'inline_article_generation_eval')
  const contextPackVersion = String(args['context-pack-version'] || CONTEXT_PACK_VERSION)
  const retrievalStrategy = args['retrieval-strategy'] ? String(args['retrieval-strategy']) : null
  const chunkingVersion = args['chunking-version'] ? String(args['chunking-version']) : null
  const validForStrategySelection = args['valid-for-strategy-selection'] === 'true'
  const invalidReason = args['invalid-reason']
    ? String(args['invalid-reason'])
    : 'generation_eval_smoke_requires_corpus_health_gate'
  const corpusHealthRunId = args['corpus-health-run-id'] ? String(args['corpus-health-run-id']) : null
  if (!GENERATION_MODES.includes(generationEvalMode)) {
    throw new Error(`--mode must be one of: ${GENERATION_MODES.join(', ')}`)
  }

  const budgetNotes = buildEvalRunNotes({
    existing: {
      generation_eval_mode: generationEvalMode,
      context_pack_version: contextPackVersion,
      retrieval_strategy: retrievalStrategy,
      chunking_version: chunkingVersion,
    },
    validForStrategySelection,
    invalidReason,
    corpusHealthRunId,
    llmMetadata: {
      estimated_tokens: maxCases * 1800,
      max_cases: maxCases,
      cache_policy: 'read_write',
      timeout_ms: Number(process.env.RAG_GENERATION_EVAL_TIMEOUT_MS || 120000),
      llm_call_count: maxCases,
      models: [DEFAULT_ANSWER_MODEL],
      dry_run_budget: args['dry-run-budget'] === true,
    },
  })
  // notes_schema_version: rag-eval-run-notes-v1
  if (args['dry-run-budget']) {
    console.log(JSON.stringify({ cache_policy: budgetNotes.cache_policy, budget_notes: budgetNotes }, null, 2))
    return
  }

  const env = requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TOKENROUTER_API_KEY'])
  const evalSetName = String(args.set || DEFAULT_EVAL_SET)
  const evalSet = (await restSelect(env, `rag_eval_sets?name=eq.${encodeURIComponent(evalSetName)}&select=*&limit=1`))[0]
  if (!evalSet) throw new Error(`Eval set not found: ${evalSetName}`)

  const evalRun = (await restInsert(env, 'rag_eval_runs', [{
    eval_set_id: evalSet.id,
    runner_version: 'rag-generation-eval-v1-2026-06-08',
    retrieval_strategy: generationEvalMode,
    retrieval_version: contextPackVersion,
    notes: JSON.stringify(budgetNotes),
  }]))[0]

  const cases = await restSelect(env, `rag_eval_cases?eval_set_id=eq.${evalSet.id}&select=*&order=created_at.asc&limit=${maxCases}`)
  for (const evalCase of cases) {
    const contextPack = generationEvalMode === 'inline_article_generation_eval'
      ? await buildInlineArticleContextPack(env, evalCase)
      : await buildCorpusRetrievalContextPack(env, evalCase, { retrievalStrategy })
    const answerText = await generateAnswer(env, evalCase.question, contextPack.text)
    await restInsert(env, 'rag_generation_eval_results', [{
      eval_run_id: evalRun.id,
      case_id: evalCase.id,
      retrieval_run_id: contextPack.retrieval_run_id,
      generation_eval_mode: generationEvalMode,
      context_pack_version: contextPackVersion,
      context_hash: contextPack.context_hash,
      context_chars: contextPack.context_chars,
      context_text: contextPack.text,
      answer_text: answerText,
      answer_model: DEFAULT_ANSWER_MODEL,
      answer_prompt_version: ANSWER_PROMPT_VERSION,
      metadata: {
        context_article_ids: contextPack.article_ids,
        context_chunk_ids: contextPack.chunk_ids,
        corpus_health_run_id: corpusHealthRunId,
        retrieval_strategy: retrievalStrategy,
        chunking_version: chunkingVersion,
        valid_for_strategy_selection: validForStrategySelection,
      },
    }], { upsert: true, onConflict: 'eval_run_id,case_id,generation_eval_mode,context_pack_version' })
  }
}

export async function buildInlineArticleContextPack(env, evalCase) {
  const article = evalCase.primary_article_id
    ? (await restSelect(env, `daily_news?id=eq.${evalCase.primary_article_id}&select=id,title,title_en,title_zh,summary_en,summary_zh,article_content&limit=1`))[0]
    : null
  const analysis = evalCase.primary_article_id
    ? (await restSelect(env, `article_deep_analysis?article_id=eq.${evalCase.primary_article_id}&status=eq.ready&select=analysis&limit=1`))[0]
    : null
  const primaryText = [
    article?.title_en || article?.title_zh || article?.title || '',
    analysis?.analysis ? JSON.stringify(analysis.analysis).slice(0, 6000) : '',
    article?.summary_en || article?.summary_zh || '',
    String(article?.article_content || '').slice(0, 6000),
  ].filter(Boolean).join('\n\n')
  return buildContextPack(primaryText, {
    article_ids: article?.id ? [article.id] : [],
    chunk_ids: [],
    retrieval_run_id: null,
  })
}

async function buildCorpusRetrievalContextPack(env, evalCase, options = {}) {
  const { retrievalStrategy = null } = options
  const strategyFilter = retrievalStrategy
    ? `&retrieval_strategy=ilike.*${encodeURIComponent(retrievalStrategy)}*`
    : ''
  const latestRetrieval = (await restSelect(
    env,
    `rag_retrieval_runs?query_input->>eval_case_id=eq.${evalCase.id}${strategyFilter}&select=id&order=created_at.desc&limit=1`
  ))[0]
  const candidates = latestRetrieval
    ? await restSelect(env, `rag_retrieval_candidates?retrieval_run_id=eq.${latestRetrieval.id}&select=article_id,chunk_id,title,summary_excerpt&order=rank.asc&limit=10`)
    : []
  return buildContextPack(candidates.map(row => [row.title, row.summary_excerpt].filter(Boolean).join('\n')).join('\n\n'), {
    article_ids: candidates.map(row => row.article_id).filter(Boolean),
    chunk_ids: candidates.map(row => row.chunk_id).filter(Boolean),
    retrieval_run_id: latestRetrieval?.id || null,
  })
}

function buildContextPack(text, metadata) {
  const contextText = String(text || '').slice(0, 16000)
  return {
    text: contextText,
    context_hash: hashText(contextText),
    context_chars: contextText.length,
    article_ids: metadata.article_ids,
    chunk_ids: metadata.chunk_ids,
    retrieval_run_id: metadata.retrieval_run_id,
  }
}

async function generateAnswer(env, question, contextText) {
  const res = await fetchWithRetry('https://api.tokenrouter.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TOKENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_ANSWER_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Answer only from the provided context. If evidence is insufficient, say so.' },
        { role: 'user', content: `Question:\n${question}\n\nContext:\n${contextText}` },
      ],
    }),
  })
  if (!res.ok) throw new Error(`TokenRouter answer ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
