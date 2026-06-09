import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('generation eval schema stores reproducible context and service-role-only scores', () => {
  const sql = readFileSync('supabase/sql/20260608_rag_generation_eval.sql', 'utf8')

  for (const column of [
    'eval_run_id',
    'case_id',
    'retrieval_run_id',
    'generation_eval_mode',
    'context_pack_version',
    'context_hash',
    'context_chars',
    'context_text',
    'answer_text',
    'answer_model',
    'answer_prompt_version',
    'judge_model',
    'judge_prompt_version',
    'faithfulness_score',
    'answer_relevancy_score',
    'context_precision_score',
    'context_recall_score',
    'human_override_score',
    'human_override_notes',
    'metadata',
  ]) {
    assert.match(sql, new RegExp(column))
  }

  assert.match(sql, /references public\.rag_eval_runs/)
  assert.match(sql, /references public\.rag_eval_cases/)
  assert.match(sql, /references public\.rag_retrieval_runs/)
  assert.match(sql, /unique \(eval_run_id, case_id, generation_eval_mode, context_pack_version\)/)
  assert.match(sql, /alter table public\.rag_generation_eval_results enable row level security/)
  assert.match(sql, /revoke all on public\.rag_generation_eval_results from anon, authenticated/)
  assert.match(sql, /grant all on public\.rag_generation_eval_results to service_role/)
})

test('generation eval scripts expose capped budget-aware generation and judging modes', () => {
  const generate = readFileSync('scripts/rag-eval-generate-answers.mjs', 'utf8')
  const judge = readFileSync('scripts/rag-eval-judge-answers.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts['eval:generate-answers'], 'node scripts/rag-eval-generate-answers.mjs')
  assert.equal(pkg.scripts['eval:judge-answers'], 'node scripts/rag-eval-judge-answers.mjs')

  for (const source of [generate, judge]) {
    assert.match(source, /--max-cases/)
    assert.match(source, /--dry-run-budget/)
    assert.match(source, /cache_policy/)
    assert.match(source, /rag-eval-run-notes-v1/)
  }

  assert.match(generate, /inline_article_generation_eval/)
  assert.match(generate, /corpus_retrieval_generation_eval/)
  assert.match(generate, /answer-question-v1-prefer-analysis/)
  assert.match(generate, /--context-pack-version/)
  assert.match(generate, /--retrieval-strategy/)
  assert.match(generate, /--chunking-version/)
  assert.match(generate, /--corpus-health-run-id/)
  assert.match(generate, /--valid-for-strategy-selection/)
  assert.match(generate, /--invalid-reason/)
  assert.match(generate, /corpusHealthRunId/)
  assert.match(generate, /validForStrategySelection/)
  assert.match(generate, /buildInlineArticleContextPack/)
  assert.match(generate, /context_hash/)
  assert.match(generate, /context_text/)
  assert.match(judge, /--mode/)
  assert.match(judge, /--retrieval-strategy/)
  assert.match(judge, /generation_eval_mode=eq/)
  assert.match(judge, /metadata->>retrieval_strategy=eq/)
  assert.match(judge, /faithfulness_score/)
  assert.match(judge, /answer_relevancy_score/)
  assert.match(judge, /context_precision_score/)
  assert.match(judge, /context_recall_score/)
})
