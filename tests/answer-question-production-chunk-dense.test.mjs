import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('answer-question chunk RPC is production-safe and service-role only', () => {
  const sql = readFileSync('supabase/sql/20260613_answer_question_chunk_retrieval.sql', 'utf8')

  assert.match(sql, /create or replace function public\.match_answer_question_chunks/)
  assert.match(sql, /query_embedding vector\(1024\)/)
  assert.match(sql, /embedding_model_filter text default '@cf\/baai\/bge-m3'/)
  assert.match(sql, /chunking_version_filter text default 'paragraph-window-v1-2026-06-02'/)
  assert.match(sql, /from public\.article_chunks c/)
  assert.match(sql, /partition by cm\.article_id/)
  assert.match(sql, /'answer_question_chunk_dense_bge_m3'::text as embedding_source/)
  assert.match(sql, /revoke all on function public\.match_answer_question_chunks\(vector\(1024\), integer, text, integer, text\) from public/)
  assert.match(sql, /grant execute on function public\.match_answer_question_chunks\(vector\(1024\), integer, text, integer, text\) to service_role/)
  assert.doesNotMatch(sql, /grant execute on function public\.match_answer_question_chunks[\s\S]*to authenticated/i)
  assert.doesNotMatch(sql, /grant execute on function public\.match_answer_question_chunks[\s\S]*to anon/i)
})

test('answer-question defaults to chunk_dense_bge_m3 and uses BGE search_query embeddings', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /type RetrieverMode = 'chunk_dense_bge_m3' \| 'article_dense_prefer_analysis'/)
  assert.match(source, /ANSWER_QUESTION_RETRIEVER_MODE/)
  assert.match(source, /ANSWER_QUESTION_ALLOW_ARTICLE_DENSE_FALLBACK/)
  assert.match(source, /return \{ mode: 'chunk_dense_bge_m3'/)
  assert.match(source, /embedQueryWithBgeM3/)
  assert.match(source, /input_type:\s*'search_query'/)
  assert.match(source, /match_answer_question_chunks/)
  assert.match(source, /match_articles_prefer_analysis/)
  assert.match(source, /chunk_dense_failed_fell_back_to_article_dense/)
})

test('answer-question traces chunk production with selected gold-set metadata', () => {
  const source = readFileSync('supabase/functions/answer-question/index.ts', 'utf8')

  assert.match(source, /retrieval_strategy: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'chunk_dense_bge_m3'/)
  assert.match(source, /query_embedding_model: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? BGE_EMBEDDING_MODEL/)
  assert.match(source, /retrieval_version: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'answer-question-chunk-dense-bge-m3-v1-2026-06-13'/)
  assert.match(source, /retriever_name: params\.actualRetrieverMode === 'chunk_dense_bge_m3' \? 'match_answer_question_chunks'/)
  assert.match(source, /selected_eval_run_id: '8ba5bdac-88a7-4f7b-8058-1648c734cc33'/)
  assert.match(source, /corpus_health_run_id: '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0'/)
  assert.match(source, /candidate_type: candidate\.candidateType \|\| 'article'/)
  assert.match(source, /chunk_id: candidate\.chunkId \|\| null/)
})

test('chunk dense monitoring reports production gates and rollback state', () => {
  const sql = readFileSync('supabase/sql/20260613_answer_question_chunk_dense_monitoring.sql', 'utf8')

  assert.match(sql, /chunk_dense_bge_m3/)
  assert.match(sql, /dense_article_similarity_prefer_deep_analysis/)
  assert.match(sql, /fallback_rate/)
  assert.match(sql, /empty_candidate_rate/)
  assert.match(sql, /p95_latency_ms/)
  assert.match(sql, /production_gate_status/)
  assert.match(sql, /canary_gate_pass/)
})
