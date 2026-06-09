#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { hashText, parseArgs } from './rag-eval-lib.mjs'

// AgenticRagResult production-compatible contract.
// Guardrails: max two retrieval rounds, max three subqueries, no external web browsing.

export function classifyAgenticIntent(question, conversationContext = '') {
  const text = `${question || ''} ${conversationContext || ''}`.toLowerCase()
  if (/compare|versus| vs |比较|对比/.test(text)) return 'comparison'
  if (/follow|previous|that|it|上述|刚才|这家公司|该公司/.test(text)) return 'ambiguous follow-up'
  if (/conflict|contradict|insufficient|低上下文|冲突/.test(text)) return 'low-context/conflicting evidence'
  if (/and|multi-hop|between|同时|以及|之间/.test(text)) return 'multi-hop'
  const entityMatches = new Set(((question || '').match(/[A-Z][A-Za-z0-9$.-]+|\$[0-9]|OpenAI|Anthropic|Google|Microsoft|Okta|xAI/g) || [])
    .filter(term => !['What', 'When', 'Why', 'How', 'Where', 'Who'].includes(term)))
  if (entityMatches.size >= 2 || /\$[0-9]/.test(question || '')) return 'entity-heavy'
  return 'simple'
}

export function buildAgenticPlan(question, intent, conversationContext = '') {
  const planId = `agentic-${hashText(`${intent}:${question}:${conversationContext}`).slice(0, 12)}`
  const base = String(question || '').trim()
  const subqueries = intent === 'comparison'
    ? [
        { id: 'sq1', query: base, purpose: 'retrieve first side of comparison' },
        { id: 'sq2', query: base, purpose: 'retrieve second side of comparison' },
      ]
    : intent === 'multi-hop'
      ? [
          { id: 'sq1', query: base, purpose: 'retrieve first hop evidence' },
          { id: 'sq2', query: base, purpose: 'retrieve second hop evidence' },
        ]
      : intent === 'ambiguous follow-up'
        ? [{ id: 'sq1', query: `${conversationContext}\n${base}`.trim(), purpose: 'complete follow-up context' }]
        : [{ id: 'sq1', query: base, purpose: 'retrieve direct evidence' }]

  return {
    plan_id: planId,
    intent,
    subqueries: subqueries.slice(0, 3),
    required_evidence: intent === 'comparison' ? ['evidence_for_each_side'] : ['direct_answer_support'],
    stop_condition: 'sufficient_answerable_context_or_max_rounds',
    timeout_budget_ms: 8000,
  }
}

export async function runAgenticRetrievalStep(plan, subquery, strategyOptions = {}) {
  const retriever = strategyOptions.retriever || (async () => [])
  const started = Date.now()
  const rows = await retriever(subquery.query, {
    strategy: strategyOptions.strategy || 'chunk_dense',
    plan,
    subquery,
  })
  return {
    candidates: rows.map((row, index) => normalizeAgenticCandidate(row, index, strategyOptions.strategy || 'chunk_dense')),
    trace: {
      subquery_id: subquery.id,
      strategy: strategyOptions.strategy || 'chunk_dense',
      candidate_count: rows.length,
      latency_ms: Date.now() - started,
    },
  }
}

export function critiqueRetrievedContext(question, plan, candidates) {
  const sufficient = candidates.length > 0
  return {
    sufficient,
    relevance: sufficient ? 'candidate_context_available' : 'no_candidates',
    conflict_check: 'not_evaluated_in_rule_based_runtime',
    answerable: sufficient,
    retry_reason: sufficient ? null : 'no_candidates_found',
  }
}

export async function orchestrateAgenticRag(question, options = {}) {
  const started = Date.now()
  const conversationContext = options.conversationContext || ''
  const intent = classifyAgenticIntent(question, conversationContext)
  const plan = buildAgenticPlan(question, intent, conversationContext)
  const mode = intent === 'simple' ? 'linear_fallback' : 'agentic'
  const maxRounds = 2
  let retrievalRounds = 0
  let candidates = []
  let critique = { sufficient: false, answerable: false, retry_reason: null }

  for (let round = 1; round <= maxRounds; round += 1) {
    retrievalRounds = round
    const roundResults = []
    const activeSubqueries = mode === 'linear_fallback' ? plan.subqueries.slice(0, 1) : plan.subqueries.slice(0, 3)
    for (const subquery of activeSubqueries) {
      const result = await runAgenticRetrievalStep(plan, subquery, {
        retriever: options.retriever,
        strategy: options.strategy || 'chunk_dense',
      })
      roundResults.push(...result.candidates)
    }
    candidates = mergeAgenticCandidates(candidates, roundResults)
    critique = critiqueRetrievedContext(question, plan, candidates)
    if (mode === 'agentic' && round === 1 && plan.required_evidence.includes('evidence_for_each_side') && candidates.length < 2) {
      critique = { ...critique, sufficient: false, answerable: false, retry_reason: 'comparison_needs_more_evidence' }
    } else if (mode === 'agentic' && round > 1 && candidates.length > 0) {
      critique = { ...critique, sufficient: true, answerable: true, retry_reason: null }
    }
    if (mode === 'linear_fallback' || critique.sufficient || round === maxRounds) break
  }

  const stopReason = mode === 'linear_fallback'
    ? 'linear_simple_question'
    : retrievalRounds > 1 && critique.sufficient
      ? 'critique_retry_satisfied'
      : critique.sufficient
        ? 'critique_sufficient'
        : 'max_rounds_reached'

  return {
    mode,
    intent,
    plan: {
      plan_id: plan.plan_id,
      subqueries: plan.subqueries,
      required_evidence: plan.required_evidence,
      stop_condition: plan.stop_condition,
    },
    candidates,
    context_pack: buildAgenticContextPack(candidates),
    critique: {
      sufficient: critique.sufficient,
      answerable: critique.answerable,
      retry_reason: critique.retry_reason,
    },
    trace: {
      retrieval_rounds: retrievalRounds,
      subquery_count: mode === 'linear_fallback' ? 1 : Math.min(plan.subqueries.length, 3),
      stop_reason: stopReason,
      latency_ms: Date.now() - started,
    },
  }
}

function normalizeAgenticCandidate(row, index, sourceStrategy) {
  return {
    article_id: row.article_id || row.id,
    chunk_id: row.chunk_id || null,
    title: row.title || '',
    chunk_text: row.chunk_text || null,
    summary: row.summary || row.summary_excerpt || '',
    rank: index + 1,
    score_dense: row.score_dense ?? null,
    score_lexical: row.score_lexical ?? null,
    score_rerank: row.score_rerank ?? null,
    score_final: row.score_final ?? row.score_dense ?? row.score_lexical ?? 0,
    source_strategy: sourceStrategy,
    metadata: row.metadata || {},
  }
}

function mergeAgenticCandidates(existing, next) {
  const byId = new Map()
  for (const candidate of [...existing, ...next]) {
    const key = `${candidate.article_id}:${candidate.chunk_id || ''}`
    if (!byId.has(key) || candidate.score_final > byId.get(key).score_final) byId.set(key, candidate)
  }
  return [...byId.values()]
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

function buildAgenticContextPack(candidates) {
  const text = candidates.map(row => [row.title, row.chunk_text || row.summary].filter(Boolean).join('\n')).join('\n\n')
  return {
    text,
    article_ids: [...new Set(candidates.map(row => row.article_id).filter(Boolean))],
    chunk_ids: [...new Set(candidates.map(row => row.chunk_id).filter(Boolean))],
    context_chars: text.length,
    context_hash: hashText(text),
  }
}

async function main() {
  const args = parseArgs()
  const question = String(args.question || 'Compare OpenAI and Anthropic funding and product launches')
  const result = await orchestrateAgenticRag(question, { retriever: async () => [] })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
