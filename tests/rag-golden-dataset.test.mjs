import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { computeRetrievalMetrics, normalizeEvalQuestions } from '../scripts/rag-eval-lib.mjs'

const migration = () => readFileSync('supabase/sql/20260601_rag_eval_dataset.sql', 'utf8')
const verification = () => readFileSync('supabase/sql/20260601_rag_eval_dataset_verification.sql', 'utf8')
const generateGold = () => readFileSync('scripts/rag-eval-generate-gold.mjs', 'utf8')
const replay = () => readFileSync('scripts/rag-eval-replay.mjs', 'utf8')

test('RAG eval migration creates service-role-only dataset and metric tables', () => {
  const sql = migration()

  for (const table of [
    'rag_eval_sets',
    'rag_eval_cases',
    'rag_eval_gold_evidence',
    'rag_eval_runs',
    'rag_eval_case_results',
    'rag_eval_retrieval_metrics',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`, 'i'))
    assert.match(sql, new RegExp(`grant all on public\\.${table} to service_role`, 'i'))
  }

  assert.match(sql, /references public\.rag_retrieval_runs\(id\)/i)
  assert.match(sql, /unique \(case_id, article_id\)/i)
  assert.match(sql, /review_status\s+text not null default 'pending'/i)
})

test('RAG eval scripts seed, generate gold, replay, and record retrieval traces', () => {
  assert.equal(existsSync('package.json'), true)

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.scripts['eval:generate-gold'], 'node scripts/rag-eval-generate-gold.mjs')
  assert.equal(pkg.scripts['eval:replay'], 'node scripts/rag-eval-replay.mjs')

  assert.match(generateGold(), /docs\/superpowers\/eval-questions\.json/)
  assert.match(generateGold(), /match_articles_prefer_analysis/)
  assert.match(generateGold(), /input_type: 'search_query'/)
  assert.match(generateGold(), /rag_eval_gold_evidence/)

  assert.match(replay(), /rag_eval_case_results/)
  assert.match(replay(), /rag_eval_retrieval_metrics/)
  assert.match(replay(), /rag_retrieval_runs/)
  assert.match(replay(), /computeRetrievalMetrics/)
})

test('normalizeEvalQuestions filters stress tests and blank questions', () => {
  const rows = normalizeEvalQuestions([
    { article_id: 'a', title: 'A', question: 'hello', stress_test: false, lang: 'en', cohort: 'mid' },
    { article_id: 'b', title: 'B', question: '', stress_test: false, lang: 'zh', cohort: 'long' },
    { article_id: 'c', title: 'C', question: 'skip me', stress_test: true, lang: 'zh', cohort: 'long' },
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].question, 'hello')
  assert.equal(rows[0].case_type, 'factual')
})

test('computeRetrievalMetrics calculates recall, MRR, NDCG, and hit rate', () => {
  const metrics = computeRetrievalMetrics(
    [
      { id: 'x' },
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
    ],
    [
      { article_id: 'a', relevance_grade: 3 },
      { article_id: 'b', relevance_grade: 2 },
      { article_id: 'z', relevance_grade: 2 },
    ],
  )

  assert.equal(metrics.recall_at_3, 2 / 3)
  assert.equal(metrics.recall_at_5, 2 / 3)
  assert.equal(metrics.recall_at_10, 2 / 3)
  assert.equal(metrics.mrr, 1 / 2)
  assert.equal(metrics.hit_at_5, true)
  assert.ok(metrics.ndcg_at_10 > 0)
  assert.ok(metrics.ndcg_at_10 < 1)
})

test('verification SQL exposes HITL approval and latest replay summaries', () => {
  const sql = verification()

  assert.match(sql, /review_status = 'pending'/)
  assert.match(sql, /review_status = 'approved'/)
  assert.match(sql, /rag_eval_retrieval_metrics/)
  assert.match(sql, /rag_eval_case_results/)
  assert.match(sql, /rag_eval_gold_evidence/)
})

test('eval question set keeps enough human-curated non-stress questions for stable metrics', () => {
  const rows = JSON.parse(readFileSync('docs/superpowers/eval-questions.json', 'utf8'))
  const normalized = normalizeEvalQuestions(rows)

  assert.ok(normalized.length >= 20, `expected at least 20 human-curated non-stress questions, got ${normalized.length}`)
  assert.ok(normalized.some(row => row.case_type === 'temporal' || row.cohort === 'temporal'))
  assert.ok(normalized.some(row => row.case_type === 'synthesis' || row.cohort === 'long'))
  assert.ok(normalized.every(row => row.article_id && row.question && row.lang))
})
