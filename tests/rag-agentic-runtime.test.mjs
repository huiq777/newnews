import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildAgenticPlan,
  classifyAgenticIntent,
  orchestrateAgenticRag,
} from '../scripts/rag-agentic-runtime.mjs'

test('agentic intent router keeps simple questions on the linear path', async () => {
  assert.equal(classifyAgenticIntent('What did OpenAI announce?', ''), 'simple')
  const result = await orchestrateAgenticRag('What did OpenAI announce?', {
    retriever: async () => [{ article_id: 'a', title: 'A', summary: 'S', score_final: 1 }],
  })

  assert.equal(result.mode, 'linear_fallback')
  assert.equal(result.intent, 'simple')
  assert.equal(result.trace.retrieval_rounds, 1)
  assert.equal(result.trace.subquery_count, 1)
  assert.equal(result.trace.stop_reason, 'linear_simple_question')
})

test('agentic planner bounds complex questions to three subqueries and two rounds', async () => {
  const intent = classifyAgenticIntent('Compare OpenAI and Anthropic funding and product launches', '')
  const plan = buildAgenticPlan('Compare OpenAI and Anthropic funding and product launches', intent, '')

  assert.equal(intent, 'comparison')
  assert.ok(plan.subqueries.length >= 2)
  assert.ok(plan.subqueries.length <= 3)

  let calls = 0
  const result = await orchestrateAgenticRag('Compare OpenAI and Anthropic funding and product launches', {
    retriever: async () => {
      calls += 1
      return calls === 1 ? [] : [{ article_id: 'b', title: 'B', summary: 'S', score_final: 1 }]
    },
  })

  assert.equal(result.mode, 'agentic')
  assert.ok(result.trace.retrieval_rounds <= 2)
  assert.ok(result.trace.subquery_count <= 3)
  assert.equal(result.trace.stop_reason, 'critique_retry_satisfied')
  assert.equal(result.critique.answerable, true)
})

test('agentic runtime source files expose production-compatible contract and package script', () => {
  const runtime = readFileSync('scripts/rag-agentic-runtime.mjs', 'utf8')
  const replay = readFileSync('scripts/rag-eval-replay.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts['eval:agentic-runtime'], 'node scripts/rag-agentic-runtime.mjs')
  for (const token of [
    'classifyAgenticIntent',
    'buildAgenticPlan',
    'runAgenticRetrievalStep',
    'critiqueRetrievedContext',
    'orchestrateAgenticRag',
    'max two retrieval rounds',
    'max three subqueries',
    'no external web browsing',
    'linear_fallback',
    'AgenticRagResult',
  ]) {
    assert.match(runtime, new RegExp(token))
  }
  assert.match(replay, /agentic_decomposition_eval/)
})
