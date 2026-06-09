import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

export const DEFAULT_EVAL_SET = 'qa-v1-2026-06'
export const RUNNER_VERSION = 'rag-eval-runner-v1-2026-06-01'
export const RETRIEVAL_STRATEGY = 'dense_query_embedding_article_similarity'
export const RETRIEVAL_VERSION = 'answer-question-related-v1-2026-05-31'
export const RETRIEVER_NAME = 'match_articles_prefer_analysis'
export const BGE_EMBEDDING_MODEL = process.env.BGE_EMBEDDING_MODEL || '@cf/baai/bge-m3'
export const BGE_RERANK_MODEL = process.env.BGE_RERANK_MODEL || '@cf/baai/bge-reranker-base'
export const EVAL_REWRITE_MODES = ['none', 'entity_expansion', 'hyde', 'decomposition', 'context_completion']
export const DEFAULT_REWRITE_DRIFT_THRESHOLD = 0.82

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
}

export function requiredEnv(names) {
  const env = {}
  const missing = []
  for (const name of names) {
    const value = process.env[name]
    if (!value) missing.push(name)
    else env[name] = value.replace(/\/$/, '')
  }
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`)
  }
  return env
}

export function serviceHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  }
}

export async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch (error) {
      lastError = error
      if (attempt === retries || !isTransientFetchError(error)) break
      const delayMs = 500 * 2 ** attempt
      console.warn(`Transient fetch error (${error?.cause?.code || error?.code || 'unknown'}), retrying in ${delayMs}ms: ${url}`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

function isTransientFetchError(error) {
  const code = error?.cause?.code || error?.code
  return [
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
  ].includes(code)
}

export async function restSelect(env, path) {
  const res = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
  })
  if (!res.ok) throw new Error(`PostgREST select ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function restInsert(env, table, rows, options = {}) {
  const params = []
  if (options.onConflict) params.push(`on_conflict=${encodeURIComponent(options.onConflict)}`)
  const query = params.length ? `?${params.join('&')}` : ''
  const res = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'POST',
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, {
      Prefer: options.upsert
        ? 'resolution=merge-duplicates,return=representation'
        : 'return=representation',
    }),
    body: JSON.stringify(rows),
  })
  if (!res.ok) throw new Error(`PostgREST insert ${table} ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function rpc(env, name, body) {
  const res = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`RPC ${name} ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function cohereEmbedSearchQuery(cohereApiKey, text) {
  const res = await fetchWithRetry('https://api.cohere.com/v1/embed', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cohereApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'embed-english-v3.0',
      input_type: 'search_query',
      texts: [text],
    }),
  })
  if (!res.ok) throw new Error(`Cohere embed ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const data = await res.json()
  if (!Array.isArray(data.embeddings) || !Array.isArray(data.embeddings[0])) {
    throw new Error('Cohere embed response missing embeddings[0]')
  }
  return data.embeddings[0]
}

export function buildBgeEmbeddingsUrl(baseUrl) {
  const normalized = String(baseUrl || '').replace(/\/$/, '')
  return normalized.endsWith('/v1')
    ? `${normalized}/embeddings`
    : `${normalized}/v1/embeddings`
}

export async function bgeEmbedSearchQuery(env, text) {
  const res = await fetchWithRetry(buildBgeEmbeddingsUrl(env.BGE_EMBEDDING_BASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BGE_EMBEDDING_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BGE_EMBEDDING_MODEL,
      input: text,
    }),
  })
  if (!res.ok) throw new Error(`BGE embed ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const json = await res.json()
  const embedding = json.data?.[0]?.embedding
  if (!Array.isArray(embedding)) throw new Error('BGE embedding response missing data[0].embedding')
  return embedding
}

export async function callTokenRouterJson(tokenrouterKey, model, messages, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchWithRetry('https://api.tokenrouter.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`TokenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('TokenRouter response missing choices[0].message.content')
    return parseJsonObject(content)
  } finally {
    clearTimeout(timer)
  }
}

export function buildCloudflareRerankUrl(accountId, model = BGE_RERANK_MODEL) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`
}

export function hashText(text) {
  return createHash('sha256').update(String(text || '')).digest('hex')
}

export function normalizeRerankQuery(query) {
  return String(query || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function buildRerankCacheKey({
  normalizedQuery,
  orderedCandidateIds,
  contextHashes,
  rerankModel,
  chunkingVersion,
  strategyVariant,
}) {
  return hashText(JSON.stringify({
    cache_version: 'rag-rerank-cache-v1',
    normalized_query: normalizedQuery,
    ordered_candidate_ids: orderedCandidateIds,
    context_hashes: contextHashes,
    rerank_model: rerankModel,
    chunking_version: chunkingVersion,
    strategy_variant: strategyVariant,
  }))
}

export function mapCloudflareRerankResults(candidates, resultRows, model = BGE_RERANK_MODEL) {
  const scoreByIndex = new Map()
  for (const row of resultRows || []) {
    const rawIndex = Number(row.index ?? row.id)
    const score = Number(row.score ?? row.relevance_score)
    if (!Number.isFinite(rawIndex) || !Number.isFinite(score)) continue
    scoreByIndex.set(rawIndex, score)
  }
  return candidates
    .map((candidate, index) => {
      const score = scoreByIndex.has(index)
        ? scoreByIndex.get(index)
        : scoreByIndex.get(index + 1)
      const scoreRerank = Number.isFinite(score) ? score : 0
      return {
        ...candidate,
        score_rerank: scoreRerank,
        score_final: scoreRerank,
        metadata: {
          ...(candidate.metadata || {}),
          rerank_model: model,
        },
      }
    })
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

export async function rerankCandidatesWithCloudflareBge(env, question, candidates, options = {}) {
  const model = options.model || BGE_RERANK_MODEL
  const contexts = candidates.map(candidate => ({
    text: String(candidate.chunk_text || candidate.summary || candidate.title || '').slice(0, 4000),
  }))
  const topK = Math.min(Number(options.topK || contexts.length), contexts.length)
  const start = Date.now()
  const res = await fetchWithRetry(buildCloudflareRerankUrl(env.CLOUDFLARE_ACCOUNT_ID, model), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: question,
      contexts,
      top_k: topK,
    }),
  })
  if (!res.ok) throw new Error(`Cloudflare rerank ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const json = await res.json()
  const resultRows = json.result?.data || json.result?.response || json.result || json.data || []
  return {
    candidates: mapCloudflareRerankResults(candidates, resultRows, model),
    metadata: {
      rerank_model: model,
      rerank_latency_ms: Date.now() - start,
      cache_hit: false,
      cache_provider: 'cloudflare_workers_ai',
    },
  }
}

export async function rerankCandidatesWithCache(env, question, candidates, options = {}) {
  const model = options.model || BGE_RERANK_MODEL
  const contextTexts = candidates.map(candidate => String(candidate.chunk_text || candidate.summary || candidate.title || '').slice(0, 4000))
  const orderedCandidateIds = candidates.map(candidate => candidate.id || candidate.article_id)
  const contextHashes = contextTexts.map(hashText)
  const cacheKey = buildRerankCacheKey({
    normalizedQuery: normalizeRerankQuery(question),
    orderedCandidateIds,
    contextHashes,
    rerankModel: model,
    chunkingVersion: options.chunkingVersion || null,
    strategyVariant: options.strategyVariant || 'rerank_hybrid',
  })
  const cacheMetadata = {
    rerank_cache_key: cacheKey,
    rerank_model: model,
    cache_hit: false,
    cold_cache_latency_ms: null,
    warm_cache_latency_ms: null,
  }

  try {
    const cachedRows = await restSelect(env, `rag_eval_rerank_cache?cache_key=eq.${cacheKey}&stale_reason=is.null&select=*&limit=1`)
    const cached = cachedRows[0]
    if (cached?.value?.ordered_candidates) {
      const scoreById = new Map(cached.value.ordered_candidates.map(row => [row.article_id, row.score_rerank]))
      return {
        candidates: candidates
          .map(candidate => ({
            ...candidate,
            score_rerank: Number(scoreById.get(candidate.id || candidate.article_id) || 0),
            score_final: Number(scoreById.get(candidate.id || candidate.article_id) || 0),
            metadata: { ...(candidate.metadata || {}), rerank_model: model, rerank_cache_key: cacheKey, cache_hit: true },
          }))
          .sort((a, b) => b.score_final - a.score_final)
          .map((candidate, index) => ({ ...candidate, rank: index + 1 })),
        metadata: { ...cacheMetadata, cache_hit: true, warm_cache_latency_ms: 0 },
      }
    }
  } catch (error) {
    console.warn(`Skipping rerank cache read after failure: ${error.message}`)
  }

  const start = Date.now()
  const reranked = env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AUTH_TOKEN
    ? await rerankCandidatesWithCloudflareBge(env, question, candidates, { model })
    : { candidates: await rerankCandidatesWithJudge(env, question, candidates, candidates.length), metadata: { rerank_model: env.RAG_EVAL_RERANK_MODEL || 'qwen/qwen3.5-flash', cache_provider: 'tokenrouter_judge_fallback' } }
  const latencyMs = Date.now() - start
  const metadata = {
    ...cacheMetadata,
    ...reranked.metadata,
    cache_hit: false,
    rerank_latency_ms: latencyMs,
    cold_cache_latency_ms: latencyMs,
  }
  const candidatesWithCacheMetadata = reranked.candidates.map(candidate => ({
    ...candidate,
    metadata: {
      ...(candidate.metadata || {}),
      rerank_cache_key: cacheKey,
      cache_hit: false,
      rerank_latency_ms: latencyMs,
      cold_cache_latency_ms: latencyMs,
      warm_cache_latency_ms: null,
    },
  }))

  try {
    await restInsert(env, 'rag_eval_rerank_cache', [{
      cache_key: cacheKey,
      cache_version: 'rag-rerank-cache-v1',
      normalized_query: normalizeRerankQuery(question),
      rerank_model: model,
      chunking_version: options.chunkingVersion || null,
      strategy_variant: options.strategyVariant || 'rerank_hybrid',
      ordered_candidate_ids: orderedCandidateIds,
      context_hashes: contextHashes,
      value: {
        ordered_candidates: candidatesWithCacheMetadata.map(candidate => ({
          article_id: candidate.id || candidate.article_id,
          score_rerank: candidate.score_rerank,
        })),
        metadata,
      },
    }], { upsert: true, onConflict: 'cache_key' })
  } catch (error) {
    console.warn(`Skipping rerank cache write after failure: ${error.message}`)
  }

  return { candidates: candidatesWithCacheMetadata, metadata }
}

export function parseJsonObject(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`No JSON object found in model response: ${trimmed.slice(0, 200)}`)
  return JSON.parse(match[0])
}

export const EVAL_RUN_NOTES_SCHEMA_VERSION = 'rag-eval-run-notes-v1'

export function parseEvalRunNotes(notesText) {
  const legacy = {
    valid_for_strategy_selection: false,
    invalid_reason: 'legacy_or_nonconforming_notes',
    corpus_health_run_id: null,
  }
  if (!notesText || typeof notesText !== 'string') return legacy
  try {
    const parsed = JSON.parse(notesText)
    if (!parsed || parsed.notes_schema_version !== EVAL_RUN_NOTES_SCHEMA_VERSION) return legacy
    return {
      ...parsed,
      valid_for_strategy_selection: parsed.valid_for_strategy_selection === true,
      invalid_reason: parsed.invalid_reason ?? null,
      corpus_health_run_id: parsed.corpus_health_run_id ?? null,
    }
  } catch {
    return legacy
  }
}

export function buildEvalRunNotes({
  existing = {},
  validForStrategySelection = false,
  invalidReason = null,
  corpusHealthRunId = null,
  llmMetadata = {},
} = {}) {
  const valid = validForStrategySelection === true
  return {
    notes_schema_version: EVAL_RUN_NOTES_SCHEMA_VERSION,
    estimated_tokens: Number.isFinite(llmMetadata.estimated_tokens) ? llmMetadata.estimated_tokens : 0,
    actual_tokens: llmMetadata.actual_tokens ?? null,
    max_cases: llmMetadata.max_cases ?? null,
    cache_policy: llmMetadata.cache_policy || 'read_write',
    timeout_ms: Number.isFinite(llmMetadata.timeout_ms) ? llmMetadata.timeout_ms : null,
    budget_approved_by: llmMetadata.budget_approved_by ?? null,
    llm_call_count: Number.isFinite(llmMetadata.llm_call_count) ? llmMetadata.llm_call_count : 0,
    models: Array.isArray(llmMetadata.models) ? llmMetadata.models : [],
    dry_run_budget: llmMetadata.dry_run_budget === true,
    ...existing,
    valid_for_strategy_selection: valid,
    invalid_reason: valid ? null : (invalidReason || 'corpus_health_not_checked'),
    corpus_health_run_id: corpusHealthRunId || null,
  }
}

export async function readEvalQuestions(path = 'docs/superpowers/eval-questions.json') {
  return JSON.parse(await readFile(path, 'utf8'))
}

export function normalizeEvalQuestions(rawRows) {
  return rawRows
    .filter(row => !row.stress_test)
    .filter(row => String(row.question || '').trim().length > 0)
    .map(row => ({
      article_id: row.article_id,
      title: row.title || '',
      question: String(row.question).trim(),
      lang: row.lang === 'en' ? 'en' : 'zh',
      cohort: row.cohort === 'long' ? 'long' : 'mid',
      case_type: inferCaseType(row.question),
      chars: Number.isFinite(row.chars) ? row.chars : null,
    }))
}

function inferCaseType(question) {
  const q = String(question || '').toLowerCase()
  if (/比较|对比|versus|vs\.?|compare/.test(q)) return 'comparison'
  if (/时间|日期|开庭|发布|when|date|timeline/.test(q)) return 'temporal'
  if (/是否|能否|如何|why|how|impact|影响/.test(q)) return 'synthesis'
  return 'factual'
}

export function summarizeArticle(candidate, lang = 'zh') {
  return candidate.summary
    || (lang === 'zh' ? candidate.summary_zh : candidate.summary_en)
    || candidate.summary_zh
    || candidate.summary_en
    || candidate.article_content
    || ''
}

export function normalizeCandidate(candidate, index) {
  return {
    rank: index + 1,
    id: candidate.id || candidate.article_id,
    title: candidate.title || candidate.title_zh || candidate.title_en || '',
    summary: summarizeArticle(candidate),
    score: numberOrNull(candidate.score ?? candidate.similarity ?? candidate.match_score),
    score_dense: numberOrNull(candidate.score_dense ?? candidate.score ?? candidate.similarity ?? candidate.match_score),
    score_lexical: numberOrNull(candidate.score_lexical),
    score_final: numberOrNull(candidate.score_final ?? candidate.score ?? candidate.score_lexical),
    embedding_source: candidate.embedding_source || candidate.source || 'daily_news',
    metadata: candidate.metadata || {},
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function computeRetrievalMetrics(candidates, goldRows) {
  const articleCandidates = dedupeCandidatesForArticleMetrics(candidates)
  const relevantGold = goldRows.filter(row => !isHardNegativeEvidence(row) && Number(row.relevance_grade || 0) >= 2)
  const gradedGold = goldRows.filter(row => !isHardNegativeEvidence(row) && Number(row.relevance_grade || 0) > 0)
  const relevantIds = new Set(relevantGold.map(row => row.article_id))
  const gradeById = new Map(goldRows.map(row => [
    row.article_id,
    isHardNegativeEvidence(row) ? 0 : Number(row.relevance_grade || 0),
  ]))

  const recall = k => {
    if (relevantIds.size === 0) return 0
    const hits = articleCandidates.slice(0, k).filter(row => relevantIds.has(row.id || row.article_id)).length
    return hits / relevantIds.size
  }

  const firstRelevantIndex = articleCandidates.findIndex(row => relevantIds.has(row.id || row.article_id))
  const mrr = firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0
  const hitAt5 = articleCandidates.slice(0, 5).some(row => relevantIds.has(row.id || row.article_id))

  return {
    recall_at_3: recall(3),
    recall_at_5: recall(5),
    recall_at_10: recall(10),
    mrr,
    ndcg_at_10: ndcgAt(articleCandidates, gradeById, gradedGold, 10),
    hit_at_5: hitAt5,
  }
}

export function dedupeCandidatesForArticleMetrics(candidates = []) {
  const seenArticleIds = new Set()
  const deduped = []
  for (const candidate of candidates) {
    const articleId = candidate.id || candidate.article_id
    if (!articleId || seenArticleIds.has(articleId)) continue
    seenArticleIds.add(articleId)
    deduped.push({
      ...candidate,
      rank: deduped.length + 1,
    })
  }
  return deduped
}

export function isHardNegativeEvidence(row) {
  return row?.metadata?.evidence_role === 'hard_negative'
}

export function computeHardNegativeDiagnostics(candidates, goldRows) {
  const relevantGoldIds = new Set(
    goldRows
      .filter(row => !isHardNegativeEvidence(row) && row.relevance_grade >= 2)
      .map(row => row.article_id)
  )
  const hardNegativeIds = new Set(
    goldRows
      .filter(isHardNegativeEvidence)
      .map(row => row.article_id)
  )
  const rankById = new Map(candidates.map((row, index) => [row.id || row.article_id, row.rank || index + 1]))
  const goldRanks = [...relevantGoldIds]
    .map(id => rankById.get(id))
    .filter(rank => Number.isFinite(rank))
  const hardNegativeRanks = [...hardNegativeIds]
    .map(id => ({ id, rank: rankById.get(id) }))
    .filter(row => Number.isFinite(row.rank))
  const bestGoldRank = goldRanks.length > 0 ? Math.min(...goldRanks) : null
  const hardNegativeArticleIdsAboveGold = bestGoldRank === null
    ? []
    : hardNegativeRanks
        .filter(row => row.rank < bestGoldRank)
        .sort((a, b) => a.rank - b.rank)
        .map(row => row.id)

  return {
    hard_negatives_above_gold: hardNegativeArticleIdsAboveGold.length,
    best_gold_rank: bestGoldRank,
    best_hard_negative_rank: hardNegativeRanks.length > 0 ? Math.min(...hardNegativeRanks.map(row => row.rank)) : null,
    hard_negative_article_ids_above_gold: hardNegativeArticleIdsAboveGold,
  }
}

export function extractLexicalTerms(question) {
  const normalized = String(question || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .trim()
  const spacedTerms = normalized
    .split(/\s+/)
    .filter(term => term.length >= 2 && !/^[\u3400-\u9fff]+$/.test(term))
  const chineseText = normalized.replace(/[^\u3400-\u9fff]/g, '')
  const chineseTerms = []
  for (let i = 0; i < chineseText.length - 1; i += 2) {
    chineseTerms.push(chineseText.slice(i, i + 4))
  }
  return [...new Set([...spacedTerms, ...chineseTerms.filter(term => term.length >= 2)])].slice(0, 10)
}

export function loadEntityLexicon(raw = process.env.RAG_EVAL_ENTITY_TERMS || '') {
  return String(raw)
    .split(',')
    .map(term => term.trim())
    .filter(term => term.length >= 2)
}

export function extractEntityTerms(question, lexicon = loadEntityLexicon()) {
  const text = String(question || '')
  const latinEntities = text.match(/\b[A-Z][A-Za-z0-9$.-]*(?:\s+[A-Z][A-Za-z0-9$.-]*){0,3}\b/g) || []
  const configuredTerms = lexicon.filter(term => text.toLowerCase().includes(term.toLowerCase()))
  const moneyTerms = text.match(/\$?\d+(?:\.\d+)?\s?(?:M|B|亿|万|万美元|亿美元)?/gi) || []
  const codeTerms = text.match(/\b[a-z]+[A-Z][A-Za-z0-9_-]*\b|\b[a-z]+(?:search|ctl|cli)\b/g) || []
  return [...new Set([...configuredTerms, ...latinEntities, ...moneyTerms, ...codeTerms])]
    .map(term => term.trim())
    .filter(term => term.length >= 2)
    .slice(0, 12)
}

export function expandRetrievalQueries(question, options = {}) {
  const original = String(question || '').trim()
  const entityTerms = extractEntityTerms(original, options.lexicon || loadEntityLexicon())
  const lexicalTerms = extractLexicalTerms(original)
  const entityQuery = [...entityTerms, ...lexicalTerms.slice(0, 6)].join(' ')
  return [...new Set([original, entityQuery].filter(Boolean))]
}

export function rewriteQueryForEval(question, mode = 'none') {
  const rewriteMode = EVAL_REWRITE_MODES.includes(mode) ? mode : 'none'
  const originalQuery = String(question || '').trim()
  if (rewriteMode === 'none') {
    return { rewrite_mode: rewriteMode, rewritten_query: originalQuery, metadata: { rule_based: true } }
  }

  const expandedQueries = expandRetrievalQueries(originalQuery)
  if (rewriteMode === 'entity_expansion') {
    return {
      rewrite_mode: rewriteMode,
      rewritten_query: expandedQueries[1] ? `${originalQuery}\n\nKey entities and exact terms: ${expandedQueries[1]}` : originalQuery,
      metadata: { rule_based: true, expanded_queries: expandedQueries },
    }
  }

  if (rewriteMode === 'hyde') {
    return {
      rewrite_mode: rewriteMode,
      rewritten_query: `${originalQuery}\n\nHypothetical answer evidence should mention the concrete entities, dates, numbers, and event outcomes in the question.`,
      metadata: { rule_based: true, llm_smoke_required_for_official_run: true },
    }
  }

  if (rewriteMode === 'decomposition') {
    return {
      rewrite_mode: rewriteMode,
      rewritten_query: expandedQueries.join('\n'),
      metadata: { rule_based: true, subquery_count: expandedQueries.length },
    }
  }

  return {
    rewrite_mode: rewriteMode,
    rewritten_query: `${originalQuery}\n\nComplete missing conversation context using only the current eval case and retrieved corpus evidence.`,
    metadata: { rule_based: true, context_completion: true },
  }
}

export function buildEvalRewriteTrace({
  originalQuery,
  rewrittenQuery,
  rewriteMode,
  accepted,
  rejectReason = null,
  similarity = null,
  topCandidateDivergence = null,
} = {}) {
  return {
    original_query: String(originalQuery || ''),
    rewritten_query: String(rewrittenQuery || originalQuery || ''),
    rewrite_mode: EVAL_REWRITE_MODES.includes(rewriteMode) ? rewriteMode : 'none',
    accepted: accepted === true,
    reject_reason: accepted === true ? null : (rejectReason || 'rewrite_rejected_or_not_evaluated'),
    original_vs_rewrite_similarity: Number.isFinite(similarity) ? similarity : null,
    drift_threshold: DEFAULT_REWRITE_DRIFT_THRESHOLD,
    top_candidate_divergence: topCandidateDivergence,
  }
}

export async function fetchLexicalCandidates(env, question, matchCount = 10) {
  const queryTerms = extractLexicalTerms(question)
  if (queryTerms.length === 0) return []
  const rows = await rpc(env, 'match_articles_lexical_eval', {
    query_terms: queryTerms,
    match_count: matchCount,
  })
  return rows.map((row, index) => ({
    ...normalizeCandidate(row, index),
    score_lexical: row.score_lexical,
    score_final: row.score_lexical,
    embedding_source: row.embedding_source || 'lexical_eval_trigram_v1',
    metadata: { lexical_terms: queryTerms },
  }))
}

export async function fetchChunkDenseCandidates(env, queryEmbedding, matchCount = 10, chunkingVersion = null, chunkOverfetchMultiplier = 5, embeddingModel = BGE_EMBEDDING_MODEL) {
  const rows = await rpc(env, 'match_article_chunks_eval', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    chunking_version_filter: chunkingVersion,
    chunk_overfetch_multiplier: chunkOverfetchMultiplier,
    embedding_model_filter: embeddingModel,
  })
  return rows.map((row, index) => ({
    ...normalizeCandidate({
      id: row.article_id,
      title: row.title,
      summary: row.summary,
      summary_en: row.summary_en,
      summary_zh: row.summary_zh,
      article_content: row.article_content,
      score_dense: row.score_dense,
      score_final: row.score_dense,
      embedding_source: row.embedding_source || 'chunk_dense_eval_v1',
      metadata: row.metadata || {},
    }, index),
    candidate_type: 'chunk',
    chunk_id: row.chunk_id,
    article_id: row.article_id,
    chunk_text: row.chunk_text || '',
    chunk_index: row.chunk_index,
    chunk_rank: row.chunk_rank,
    article_rank: row.article_rank,
    summary: row.chunk_text || row.summary || row.summary_zh || row.summary_en || '',
    metadata: {
      ...(row.metadata || {}),
      source_key: 'chunk',
      chunk_rank: row.chunk_rank,
      article_rank: row.article_rank,
      chunk_index: row.chunk_index,
    },
  }))
}

export function fuseCandidatesByRrf(candidateLists, k = 60) {
  const byId = new Map()
  for (const list of candidateLists) {
    for (const candidate of list) {
      const id = candidate.id || candidate.article_id
      if (!id) continue
      if (!byId.has(id)) {
        byId.set(id, {
          ...candidate,
          score_final: 0,
          metadata: { fusion_sources: [] },
        })
      }
      const existing = byId.get(id)
      existing.score_final += 1 / (k + (candidate.rank || 1))
      existing.score_dense = existing.score_dense ?? candidate.score
      existing.score_lexical = existing.score_lexical ?? candidate.score_lexical
      existing.metadata.fusion_sources.push(candidate.embedding_source)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

export function fuseCandidatesWeightedRrf(candidateLists, weights = {}, k = 60) {
  const byId = new Map()
  for (const list of candidateLists) {
    for (const candidate of list) {
      const id = candidate.id || candidate.article_id
      if (!id) continue
      const source = candidate.metadata?.source_key || candidate.embedding_source || 'unknown'
      const sourceWeight = Number.isFinite(weights[source]) ? weights[source] : 1
      if (!byId.has(id)) {
        byId.set(id, {
          ...candidate,
          score_final: 0,
          metadata: { ...(candidate.metadata || {}), fusion_sources: [] },
        })
      }
      const existing = byId.get(id)
      existing.score_final += sourceWeight / (k + (candidate.rank || 1))
      existing.score_dense = existing.score_dense ?? candidate.score_dense ?? candidate.score
      existing.score_lexical = existing.score_lexical ?? candidate.score_lexical
      existing.metadata.fusion_sources.push(source)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

export async function rerankCandidatesWithJudge(env, question, candidates, limit = 20) {
  const model = env.RAG_EVAL_RERANK_MODEL || 'qwen/qwen3.5-flash'
  const candidateText = candidates.slice(0, limit).map((candidate, index) => [
    `[${index + 1}] ${candidate.title}`,
    String(candidate.summary || '').slice(0, 1200),
  ].join('\n')).join('\n\n')

  const result = await callTokenRouterJson(env.TOKENROUTER_API_KEY, model, [
    {
      role: 'system',
      content: [
        'You are reranking retrieved news evidence for a RAG system.',
        'Return JSON only: {"scores":[{"index":1,"relevance_score":0-100,"reason":"short"}]}',
        'Score direct evidence highest. Penalize merely adjacent topic matches.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Question:\n${question}\n\nCandidates:\n${candidateText}`,
    },
  ], Number(env.RAG_EVAL_RERANK_TIMEOUT_MS || 120000))

  const scores = Array.isArray(result.scores) ? result.scores : []
  const scoreByIndex = new Map(scores.map(row => [Number(row.index), Number(row.relevance_score)]))
  return candidates
    .map((candidate, index) => ({
      ...candidate,
      score_rerank: Number.isFinite(scoreByIndex.get(index + 1)) ? scoreByIndex.get(index + 1) / 100 : 0,
      score_final: Number.isFinite(scoreByIndex.get(index + 1)) ? scoreByIndex.get(index + 1) / 100 : candidate.score_final || 0,
      metadata: { ...(candidate.metadata || {}), rerank_model: model },
    }))
    .sort((a, b) => b.score_final - a.score_final)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))
}

function ndcgAt(candidates, gradeById, relevantGold, k) {
  const dcg = candidates.slice(0, k).reduce((sum, row, index) => {
    const grade = gradeById.get(row.id || row.article_id) || 0
    return sum + gain(grade, index + 1)
  }, 0)
  const ideal = relevantGold
    .slice()
    .sort((a, b) => Number(b.relevance_grade || 0) - Number(a.relevance_grade || 0))
    .slice(0, k)
    .reduce((sum, row, index) => sum + gain(Number(row.relevance_grade || 0), index + 1), 0)
  return ideal > 0 ? dcg / ideal : 0
}

function gain(grade, rank) {
  return (2 ** grade - 1) / Math.log2(rank + 1)
}

export function average(rows, key) {
  if (rows.length === 0) return 0
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length
}

export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]
}

export function uuidIn(ids) {
  return `in.(${ids.join(',')})`
}
