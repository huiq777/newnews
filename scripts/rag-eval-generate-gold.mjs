#!/usr/bin/env node

import process from 'node:process'

import {
  BGE_EMBEDDING_MODEL,
  DEFAULT_EVAL_SET,
  RETRIEVAL_STRATEGY,
  RETRIEVAL_VERSION,
  RETRIEVER_NAME,
  bgeEmbedSearchQuery,
  callTokenRouterJson,
  cohereEmbedSearchQuery,
  expandRetrievalQueries,
  fetchChunkDenseCandidates,
  fetchLexicalCandidates,
  fuseCandidatesWeightedRrf,
  normalizeCandidate,
  normalizeEvalQuestions,
  parseArgs,
  readEvalQuestions,
  requiredEnv,
  restInsert,
  restSelect,
  rpc,
  uuidIn,
} from './rag-eval-lib.mjs'

const EVAL_SOURCE_PATH = 'docs/superpowers/eval-questions.json'
const GOLD_MODEL = process.env.RAG_EVAL_GOLD_MODEL || process.env.TREND_BRIEF_MODEL || 'qwen/qwen3.6-plus'
const GOLD_TIMEOUT_MS = Number(process.env.RAG_EVAL_GOLD_TIMEOUT_MS || 180_000)
// Cohere query embedding is load-bearing: input_type: 'search_query'
const QUERY_EMBEDDING_INPUT_TYPE = 'search_query'
const HARD_NEGATIVE_EVIDENCE_ROLE = 'hard_negative'

const JUDGE_SYSTEM = `You are an expert RAG Search Quality Judge.
Your task is to grade the relevance of retrieved article candidates to a user's question.
You must output strictly a valid JSON object matching this schema:
{
  "grades": [
    {
      "candidate_index": number,
      "relevance_grade": number,
      "evidence_note": "string explaining the grading decision"
    }
  ]
}

Grading Rubric:
- 3: Perfect/Core. The candidate directly and comprehensively contains the core facts or evidence required to answer the question.
- 2: Highly Relevant. The candidate contains supporting evidence, context, or partial details directly useful for the answer.
- 1: Marginally Relevant. The candidate mentions related terms/topics but gives little direct evidence.
- 0: Irrelevant. The candidate has no relevance to the question.`

async function main() {
  const args = parseArgs()
  const setName = String(args.set || DEFAULT_EVAL_SET)
  const limit = args.limit ? Number(args.limit) : Infinity
  const matchCount = args.match ? Number(args.match) : 10
  // --expand-candidates true adds lexical, hybrid/fusion, and primary baselines for review.
  const expandCandidates = args['expand-candidates'] === 'true'
  // --candidate-provider bge_chunk avoids legacy Cohere article embeddings.
  // cohere_article remains available for historical dense article candidate generation.
  const candidateProvider = String(args['candidate-provider'] || (expandCandidates ? 'bge_chunk' : 'cohere_article'))
  const usesCohereArticleCandidates = candidateProvider === 'cohere_article'
  const usesBgeCandidates = expandCandidates || candidateProvider === 'bge_chunk'
  if (!['bge_chunk', 'cohere_article'].includes(candidateProvider)) {
    throw new Error(`Unsupported --candidate-provider ${candidateProvider}. Use bge_chunk or cohere_article.`)
  }
  // --include-lexical true adds trigram article candidates. It is off by default
  // because match_articles_lexical_eval can time out on larger corpora.
  const includeLexicalCandidates = args['include-lexical'] === 'true'
  // --missing-only true resumes interrupted expanded runs without spending calls
  // on cases that already have at least one gold evidence row.
  const missingOnly = args['missing-only'] === 'true'
  const envNames = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TOKENROUTER_API_KEY',
  ]
  if (usesCohereArticleCandidates) envNames.push('COHERE_API_KEY')
  if (usesBgeCandidates) envNames.push('BGE_EMBEDDING_BASE_URL', 'BGE_EMBEDDING_API_KEY')
  const env = requiredEnv(envNames)

  const evalSet = await upsertEvalSet(env, setName)
  const cases = await seedCases(env, evalSet.id, Number.isFinite(limit) ? limit : Infinity)
  console.log(`Seeded/found ${cases.length} eval cases in ${setName}.`)

  let generated = 0
  for (const evalCase of cases) {
    const existing = await restSelect(env, `rag_eval_gold_evidence?case_id=eq.${evalCase.id}&select=id&limit=1`)
    if (existing.length > 0 && !args.force && (!expandCandidates || missingOnly)) {
      console.log(`skip gold exists: ${evalCase.question.slice(0, 48)}`)
      continue
    }

    const start = Date.now()
    const denseCandidates = usesCohereArticleCandidates
      ? await fetchCohereArticleCandidates(env, evalCase.question, matchCount)
      : []
    const candidatesForJudging = expandCandidates
      ? await expandGoldCandidates(env, evalCase, denseCandidates, matchCount, { includeLexicalCandidates })
      : denseCandidates
    if (candidatesForJudging.length === 0) {
      console.warn(`no candidates for case ${evalCase.id}`)
      continue
    }

    const grades = await gradeCandidatesWithRetry(env, evalCase, candidatesForJudging)
    const existingReviewState = await fetchExistingGoldReviewState(env, evalCase.id, candidatesForJudging)
    const rows = candidatesForJudging.map((candidate, index) => {
      const grade = grades.find(row => row.candidate_index === index + 1)
      const existingRow = existingReviewState.get(candidate.id)
      const generatedRow = {
        case_id: evalCase.id,
        article_id: candidate.id,
        relevance_grade: clampGrade(grade?.relevance_grade),
        review_status: 'pending',
        evidence_note: String(grade?.evidence_note || 'No judge note returned.').slice(0, 2000),
        metadata: {
          judge_model: GOLD_MODEL,
          candidate_rank: index + 1,
          score_dense: candidate.score ?? candidate.score_dense ?? null,
          score_lexical: candidate.score_lexical ?? null,
          score_final: candidate.score_final ?? candidate.score ?? candidate.score_lexical ?? null,
          generated_latency_ms: Date.now() - start,
          embedding_input_type: QUERY_EMBEDDING_INPUT_TYPE,
          query_embedding_model: candidateProvider === 'bge_chunk' ? BGE_EMBEDDING_MODEL : 'embed-english-v3.0',
          candidate_provider: candidateProvider,
          retrieval_strategy: expandCandidates ? `expanded_${candidateProvider}${includeLexicalCandidates ? '_lexical' : ''}_primary_baseline` : RETRIEVAL_STRATEGY,
          retrieval_version: RETRIEVAL_VERSION,
          retriever_name: expandCandidates
            ? [candidateProvider, includeLexicalCandidates ? 'match_articles_lexical_eval' : null, 'primary_article_baseline'].filter(Boolean).join('+')
            : RETRIEVER_NAME,
          source: candidate.embedding_source,
          candidate_sources: candidate.metadata?.candidate_sources || [candidate.embedding_source || 'dense'],
        },
      }
      return mergeExistingGoldReviewState(generatedRow, existingRow)
    })

    await restInsert(env, 'rag_eval_gold_evidence', rows.map(normalizeHardNegativeEvidence), {
      upsert: true,
      onConflict: 'case_id,article_id',
    })
    generated += rows.length
    console.log(`gold ${rows.length}: ${evalCase.question.slice(0, 64)}`)
  }

  console.log(`Done. Generated/updated ${generated} gold evidence rows.`)
}

async function fetchCohereArticleCandidates(env, question, matchCount) {
  const queryEmbedding = await cohereEmbedSearchQuery(env.COHERE_API_KEY, question)
  const rawCandidates = await rpc(env, 'match_articles_prefer_analysis', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  })
  return rawCandidates.map(normalizeCandidate).filter(row => row.id)
}

async function fetchExistingGoldReviewState(env, caseId, candidates) {
  const articleIds = [...new Set(candidates.map(candidate => candidate.id).filter(Boolean))]
  if (articleIds.length === 0) return new Map()
  const rows = await restSelect(
    env,
    `rag_eval_gold_evidence?case_id=eq.${caseId}&article_id=${uuidIn(articleIds)}&select=article_id,relevance_grade,review_status,evidence_note`
  )
  return new Map(rows.map(row => [row.article_id, row]))
}

function mergeExistingGoldReviewState(row, existingRow) {
  return {
    ...row,
    relevance_grade: existingRow?.relevance_grade ?? row.relevance_grade,
    review_status: existingRow?.review_status ?? row.review_status,
    evidence_note: existingRow?.evidence_note || row.evidence_note,
  }
}

function normalizeHardNegativeEvidence(row) {
  if (row.metadata?.evidence_role !== HARD_NEGATIVE_EVIDENCE_ROLE) return row
  return {
    ...row,
    relevance_grade: 0,
    metadata: {
      ...row.metadata,
      evidence_role: HARD_NEGATIVE_EVIDENCE_ROLE,
    },
  }
}

async function expandGoldCandidates(env, evalCase, denseCandidates, matchCount, options = {}) {
  const { includeLexicalCandidates = false } = options
  const candidateLists = []
  if (denseCandidates.length > 0) {
    candidateLists.push(denseCandidates.map(row => ({
      ...row,
      metadata: { ...(row.metadata || {}), source_key: 'vector', candidate_sources: ['dense'] },
    })))
  }

  const primaryBaseline = evalCase.primary_article_id
    ? await restSelect(
        env,
        `daily_news?select=id,title,summary,summary_en,summary_zh,article_content&id=eq.${evalCase.primary_article_id}&limit=1`
      )
    : []
  if (primaryBaseline[0]) {
    candidateLists.push(primaryBaseline.map((row, index) => ({
      ...normalizeCandidate(row, index),
      score_final: 1,
      embedding_source: 'primary_article_baseline',
      metadata: { source_key: 'primary_article_baseline', candidate_sources: ['primary_article_baseline'] },
    })))
  }

  const expandedQueries = expandRetrievalQueries(evalCase.question)
  const queryEmbedding = await bgeEmbedSearchQuery(env, expandedQueries[0])
  const chunkCandidates = (await fetchChunkDenseCandidates(env, queryEmbedding, Math.max(matchCount, 20), null, 5, BGE_EMBEDDING_MODEL))
    .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'chunk' } }))
  candidateLists.push(chunkCandidates)

  if (includeLexicalCandidates) {
    const lexicalCandidates = (await safeFetchLexicalCandidates(env, expandedQueries[1] || expandedQueries[0], Math.max(matchCount, 20)))
      .map(row => ({ ...row, metadata: { ...(row.metadata || {}), source_key: 'lexical' } }))
    if (lexicalCandidates.length > 0) candidateLists.push(lexicalCandidates)
  }

  // Historical gold expansion used fuseCandidatesByRrf; weighted RRF keeps chunk/entity sources distinguishable.
  return fuseCandidatesWeightedRrf(candidateLists, {
    vector: 1,
    lexical: 1,
    chunk: 1,
    primary_article_baseline: 2,
    ...(includeLexicalCandidates ? { lexical: 1 } : {}),
  }, 50)
    .slice(0, Math.max(matchCount, 20))
    .map(candidate => ({
      ...candidate,
      metadata: {
        ...candidate.metadata,
        expanded_queries: expandedQueries,
        candidate_sources: candidate.metadata?.fusion_sources
          || candidate.metadata?.candidate_sources
          || [candidate.embedding_source || 'dense'],
      },
    }))
}

async function safeFetchLexicalCandidates(env, question, matchCount) {
  try {
    return await fetchLexicalCandidates(env, question, matchCount)
  } catch (error) {
    console.warn(`Skipping lexical candidates after RPC failure: ${error.message}`)
    return []
  }
}

async function upsertEvalSet(env, name) {
  const rows = await restInsert(env, 'rag_eval_sets', [{
    name,
    description: 'RAG Q&A golden dataset v1 seeded from docs/superpowers/eval-questions.json.',
  }], {
    upsert: true,
    onConflict: 'name',
  })
  return rows[0]
}

async function seedCases(env, evalSetId, limit) {
  const raw = await readEvalQuestions(EVAL_SOURCE_PATH)
  const normalized = normalizeEvalQuestions(raw).slice(0, limit)
  const articleIds = [...new Set(normalized.map(row => row.article_id).filter(Boolean))]
  const existingArticles = new Set(
    articleIds.length
      ? (await restSelect(env, `daily_news?id=${uuidIn(articleIds)}&select=id`)).map(row => row.id)
      : []
  )
  const valid = normalized.filter(row => existingArticles.has(row.article_id))
  const skipped = normalized.length - valid.length
  if (skipped > 0) console.warn(`Skipped ${skipped} cases whose article_id is missing from daily_news.`)

  if (valid.length === 0) return []

  await restInsert(env, 'rag_eval_cases', valid.map(row => ({
    eval_set_id: evalSetId,
    surface: 'answer_question_related_articles',
    question: row.question,
    lang: row.lang,
    case_type: row.case_type,
    cohort: row.cohort,
    primary_article_id: row.article_id,
    case_source: 'eval_json',
    metadata: { source_title: row.title, chars: row.chars },
  })), {
    upsert: true,
    onConflict: 'eval_set_id,primary_article_id,question',
  })

  return restSelect(
    env,
    `rag_eval_cases?eval_set_id=eq.${evalSetId}&case_source=eq.eval_json&select=*&order=created_at.asc`
  )
}

async function gradeCandidates(env, evalCase, candidates) {
  const candidateText = candidates.map((candidate, index) => {
    return [
      `Index [${index + 1}]`,
      `Title: ${candidate.title}`,
      `Summary: ${candidate.summary.slice(0, 1200)}`,
    ].join('\n')
  }).join('\n\n')

  const json = await callTokenRouterJson(env.TOKENROUTER_API_KEY, GOLD_MODEL, [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: `Question: ${evalCase.question}\n\nRetrieved Candidates to judge:\n${candidateText}`,
    },
  ], GOLD_TIMEOUT_MS)

  if (!Array.isArray(json.grades)) throw new Error(`Judge response missing grades array for case ${evalCase.id}`)
  return json.grades
}

async function gradeCandidatesWithRetry(env, evalCase, candidates, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await gradeCandidates(env, evalCase, candidates)
    } catch (error) {
      lastError = error
      if (!isTransientJudgeError(error) || attempt === attempts) break
      const delayMs = 1000 * attempt
      console.warn(`Transient judge error for case ${evalCase.id}, retrying in ${delayMs}ms: ${error.message}`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

function isTransientJudgeError(error) {
  const message = String(error?.message || '')
  return /TokenRouter 5\d\d|bad_response_body|unexpected end of JSON input|response missing|terminated|ECONNRESET|ETIMEDOUT/i.test(message)
}

function clampGrade(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(3, Math.round(n)))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
