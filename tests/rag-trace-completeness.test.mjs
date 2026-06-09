import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = () => readFileSync('supabase/sql/20260531_rag_trace_completeness.sql', 'utf8')
const verification = () => readFileSync('supabase/sql/20260531_rag_trace_completeness_verification.sql', 'utf8')
const answerQuestion = () => readFileSync('supabase/functions/answer-question/index.ts', 'utf8')
const trendBrief = () => readFileSync('supabase/functions/generate-trend-brief/index.ts', 'utf8')

test('RAG trace migration creates run, candidate, and injected context tables', () => {
  const sql = migration()

  assert.match(sql, /create table if not exists public\.rag_retrieval_runs/i)
  assert.match(sql, /create table if not exists public\.rag_retrieval_candidates/i)
  assert.match(sql, /create table if not exists public\.rag_injected_contexts/i)
  assert.match(sql, /alter table public\.qa_logs\s+add column if not exists rag_retrieval_run_id uuid/i)
  assert.match(sql, /qa_logs_rag_retrieval_run_id_fkey/i)
  assert.match(sql, /surface\s+text not null/i)
  assert.match(sql, /query_text\s+text/i)
  assert.match(sql, /query_input\s+jsonb not null default/i)
  assert.match(sql, /score_dense\s+double precision/i)
  assert.match(sql, /injected\s+boolean not null default false/i)
  assert.match(sql, /drop_reason\s+text/i)
  assert.match(sql, /context_text\s+text/i)
  assert.match(sql, /context_hash\s+text not null/i)
})

test('verification queries cover Q&A and trend brief trace joins', () => {
  const sql = verification()

  assert.match(sql, /qa_logs/i)
  assert.match(sql, /rag_retrieval_runs/i)
  assert.match(sql, /rag_retrieval_candidates/i)
  assert.match(sql, /rag_injected_contexts/i)
  assert.match(sql, /trend_brief_historical_enrichment/i)
  assert.match(sql, /answer_question_related_articles/i)
})

test('answer-question records trace rows without changing retrieval RPC or caps', () => {
  const source = answerQuestion()

  assert.match(source, /recordAnswerQuestionTrace/)
  assert.match(source, /\.from\('rag_retrieval_runs'\)[\s\S]*?\.insert/)
  assert.match(source, /\.from\('rag_retrieval_candidates'\)[\s\S]*?\.insert/)
  assert.match(source, /\.from\('rag_injected_contexts'\)[\s\S]*?\.insert/)
  assert.match(source, /rag_retrieval_run_id: context\.retrievalRunId/)
  assert.match(source, /match_articles_prefer_analysis/)
  assert.match(source, /match_count: caps\.maxRelated \+ 1/)
  assert.match(source, /MAX_RELATED = 3/)
})

test('generate-trend-brief records historical retrieval candidates without changing retrieval RPC or caps', () => {
  const source = trendBrief()

  assert.match(source, /recordTrendBriefTrace/)
  assert.match(source, /\.from\('rag_retrieval_runs'\)[\s\S]*?\.insert/)
  assert.match(source, /\.from\('rag_retrieval_candidates'\)[\s\S]*?\.insert/)
  assert.match(source, /\.from\('rag_injected_contexts'\)[\s\S]*?\.insert/)
  assert.match(source, /surface: 'trend_brief_historical_enrichment'/)
  assert.match(source, /match_articles/)
  assert.match(source, /match_count: 15/)
  assert.match(source, /if \(historical\.length >= 8\) break/)
})
