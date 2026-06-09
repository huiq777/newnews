import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('agentic eval trace schema stores planner critique retry and stop fields', () => {
  const sql = readFileSync('supabase/sql/20260608_agentic_rag_eval_trace.sql', 'utf8')

  for (const column of [
    'plan_id',
    'intent',
    'subquery',
    'retrieval_round',
    'strategy',
    'candidate_count',
    'critique_sufficient',
    'critique_answerable',
    'retry_reason',
    'stop_reason',
    'latency_ms',
  ]) {
    assert.match(sql, new RegExp(column))
  }

  assert.match(sql, /create table if not exists public\.agentic_rag_eval_traces/)
  assert.match(sql, /alter table public\.agentic_rag_eval_traces enable row level security/)
  assert.match(sql, /revoke all on public\.agentic_rag_eval_traces from anon, authenticated/)
  assert.match(sql, /grant all on public\.agentic_rag_eval_traces to service_role/)
})

test('agentic eval replay calls runtime and reports directional slices with n guards', () => {
  const replay = readFileSync('scripts/rag-agentic-eval-replay.mjs', 'utf8')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts['eval:agentic'], 'node scripts/rag-agentic-eval-replay.mjs')
  assert.match(replay, /orchestrateAgenticRag/)
  assert.match(replay, /--max-cases/)
  assert.match(replay, /--dry-run-budget/)
  assert.match(replay, /--retrieval-strategy/)
  assert.match(replay, /--chunking-version/)
  assert.match(replay, /--corpus-health-run-id/)
  assert.match(replay, /--valid-for-strategy-selection/)
  assert.match(replay, /--invalid-reason/)
  assert.match(replay, /corpusHealthRunId/)
  assert.match(replay, /validForStrategySelection/)
  assert.match(replay, /multi-hop/)
  assert.match(replay, /comparison/)
  assert.match(replay, /ambiguous follow-up/)
  assert.match(replay, /entity-heavy/)
  assert.match(replay, /low-context\/conflicting evidence/)
  assert.match(replay, /slice_n >= 5/)
  assert.match(replay, /loop_safety/)
})
