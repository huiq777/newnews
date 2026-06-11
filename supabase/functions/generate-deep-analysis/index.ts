import {
  analysisToEmbeddingText,
  buildDeepAnalysisMessages,
  DEEP_ANALYSIS_INPUT_CAP,
  DEEP_ANALYSIS_PROMPT_VERSION,
  extractFirstJson,
  prepareAnalysisInput,
  validateDeepAnalysis,
} from "../_shared/deep-analysis.js"

const TOKENROUTER_API = 'https://api.tokenrouter.com/v1/chat/completions'
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'
const COHERE_EMBED_API = 'https://api.cohere.com/v1/embed'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
}

type ClaimedRow = {
  analysis_id: string
  article_id: string
  title: string
  title_en: string | null
  title_zh: string | null
  summary_en: string | null
  summary_zh: string | null
  article_content: string
  source_name: string
  source_type: string
  category: string
  published_at: string | null
  retry_count: number
}

type LlmResult = {
  analysis: ReturnType<typeof validateDeepAnalysis>
  model: string
  tokensUsed: number | null
}

function env(name: string, fallback = '') {
  return Deno.env.get(name) ?? fallback
}

function sbUrl() {
  return env('SUPABASE_URL')
}

function sbHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

function log(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), fn: 'generate-deep-analysis', event, ...payload }))
}

async function claimBatch(batchSize: number): Promise<ClaimedRow[]> {
  const res = await fetch(`${sbUrl()}/rest/v1/rpc/claim_deep_analysis_batch`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ batch_size: batchSize }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`claim_deep_analysis_batch failed (${res.status}): ${errBody.substring(0, 300)}`)
  }
  return await res.json() as ClaimedRow[]
}

function buildLlmBody(row: ClaimedRow, model: string) {
  const prepared = prepareAnalysisInput(row.article_content, DEEP_ANALYSIS_INPUT_CAP)
  const messages = buildDeepAnalysisMessages({
    title: row.title_en || row.title,
    source_name: row.source_name,
    category: row.category,
    published_at: row.published_at,
    summary_en: row.summary_en,
    summary_zh: row.summary_zh,
    article_content: prepared.content,
  })

  return {
    model,
    temperature: 0.1,
    max_tokens: 2200,
    response_format: { type: 'json_object' },
    messages,
  }
}

function parseLlmResponse(textContent: string, model: string): LlmResult {
  const parsed = JSON.parse(extractFirstJson(textContent))
  return {
    analysis: validateDeepAnalysis(parsed),
    model,
    tokensUsed: null,
  }
}

async function callTokenRouter(row: ClaimedRow): Promise<LlmResult> {
  const model = env('DEEP_ANALYSIS_LLM_MODEL', 'qwen/qwen3.6-plus')
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), 120000)
  try {
    log('llm_call', { provider: 'tokenrouter', model, analysis_id: row.analysis_id })
    const res = await fetch(TOKENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('TOKENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://news-app.internal',
        'X-Title': 'NewsApp',
      },
      body: JSON.stringify(buildLlmBody(row, model)),
      signal: controller.signal,
    })
    clearTimeout(timerId)

    if (res.status === 429) {
      const body429 = await res.text().catch(() => '')
      log('llm_429', { provider: 'tokenrouter', body: body429.substring(0, 200) })
      return await callOpenRouter(row)
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`TokenRouter ${res.status}: ${errBody.substring(0, 300)}`)
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
    const textContent = data.choices?.[0]?.message?.content
    if (!textContent) throw new Error('TokenRouter returned empty content')
    const result = parseLlmResponse(textContent, model)
    result.tokensUsed = data.usage?.total_tokens ?? null
    return result
  } catch (err) {
    clearTimeout(timerId)
    if (err instanceof Error && err.name === 'AbortError') {
      log('llm_timeout', { provider: 'tokenrouter', analysis_id: row.analysis_id })
      return await callOpenRouter(row)
    }
    if ((err as Error).message.startsWith('TokenRouter')) throw err
    log('llm_unreachable', { provider: 'tokenrouter', error: (err as Error).message })
    return await callOpenRouter(row)
  }
}

async function callOpenRouter(row: ClaimedRow): Promise<LlmResult> {
  const model = env('DEEP_ANALYSIS_OPENROUTER_MODEL', env('OPENROUTER_MODEL'))
  if (!env('OPENROUTER_API_KEY') || !model) return await callGroq(row)

  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), 8000)
  try {
    log('llm_call', { provider: 'openrouter', model, analysis_id: row.analysis_id })
    const res = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://news-app.internal',
        'X-Title': 'NewsApp',
      },
      body: JSON.stringify(buildLlmBody(row, model)),
      signal: controller.signal,
    })
    clearTimeout(timerId)

    if (res.status === 429) {
      const body429 = await res.text().catch(() => '')
      log('llm_429', { provider: 'openrouter', body: body429.substring(0, 200) })
      return await callGroq(row)
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`OpenRouter ${res.status}: ${errBody.substring(0, 300)}`)
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
    const textContent = data.choices?.[0]?.message?.content
    if (!textContent) throw new Error('OpenRouter returned empty content')
    const result = parseLlmResponse(textContent, model)
    result.tokensUsed = data.usage?.total_tokens ?? null
    return result
  } catch (err) {
    clearTimeout(timerId)
    if (err instanceof Error && err.name === 'AbortError') {
      log('llm_timeout', { provider: 'openrouter', analysis_id: row.analysis_id })
      return await callGroq(row)
    }
    if ((err as Error).message.startsWith('OpenRouter')) throw err
    log('llm_unreachable', { provider: 'openrouter', error: (err as Error).message })
    return await callGroq(row)
  }
}

async function callGroq(row: ClaimedRow): Promise<LlmResult> {
  if (!env('GROQ_API_KEY')) throw new Error('No LLM fallback available: missing GROQ_API_KEY')

  const model = 'llama-3.3-70b-versatile'
  const controller = new AbortController()
  const timerId = setTimeout(() => controller.abort(), 30000)
  try {
    log('llm_call', { provider: 'groq', model, analysis_id: row.analysis_id })
    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env('GROQ_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildLlmBody(row, model)),
      signal: controller.signal,
    })
    clearTimeout(timerId)

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Groq ${res.status}: ${errBody.substring(0, 300)}`)
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
    const textContent = data.choices?.[0]?.message?.content
    if (!textContent) throw new Error('Groq returned empty content')
    const result = parseLlmResponse(textContent, model)
    result.tokensUsed = data.usage?.total_tokens ?? null
    return result
  } catch (err) {
    clearTimeout(timerId)
    throw new Error(`Groq unreachable: ${(err as Error).message}`)
  }
}

async function callLLM(row: ClaimedRow): Promise<LlmResult> {
  if (env('TOKENROUTER_API_KEY')) return await callTokenRouter(row)
  return await callOpenRouter(row)
}

async function embedAnalysis(row: ClaimedRow, analysis: ReturnType<typeof validateDeepAnalysis>): Promise<number[]> {
  if (!env('COHERE_API_KEY')) throw new Error('Missing COHERE_API_KEY')
  const text = analysisToEmbeddingText(analysis, row.title_en || row.title)
  const res = await fetch(COHERE_EMBED_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env('COHERE_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'embed-english-v3.0',
      input_type: 'search_document',
      texts: [text],
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Cohere ${res.status}: ${errBody.substring(0, 300)}`)
  }
  const data = await res.json() as { embeddings?: number[][] }
  const embedding = data.embeddings?.[0]
  if (!Array.isArray(embedding) || embedding.length !== 1024) {
    throw new Error(`Cohere returned invalid embedding length=${embedding?.length ?? 'null'}`)
  }
  return embedding
}

async function markReady(
  row: ClaimedRow,
  result: LlmResult,
  embedding: number[],
  prepared: ReturnType<typeof prepareAnalysisInput>,
) {
  const res = await fetch(`${sbUrl()}/rest/v1/article_deep_analysis?id=eq.${row.analysis_id}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({
      status: 'ready',
      analysis: result.analysis,
      analysis_embedding: `[${embedding.join(',')}]`,
      model: result.model,
      prompt_version: DEEP_ANALYSIS_PROMPT_VERSION,
      tokens_used: result.tokensUsed,
      last_error: null,
      input_chars: prepared.input_chars,
      truncated: prepared.truncated,
      generated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`ready patch failed (${res.status}): ${errBody.substring(0, 300)}`)
  }
}

async function markFailure(row: ClaimedRow, err: Error) {
  const retryCount = (row.retry_count ?? 0) + 1
  const status = retryCount >= 3 ? 'error' : 'pending'
  const res = await fetch(`${sbUrl()}/rest/v1/article_deep_analysis?id=eq.${row.analysis_id}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify({
      status,
      retry_count: retryCount,
      last_error: err.message.slice(0, 1000),
      prompt_version: DEEP_ANALYSIS_PROMPT_VERSION,
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    log('failure_patch_failed', { analysis_id: row.analysis_id, status: res.status, body: errBody.substring(0, 300) })
  }
}

async function processOne(row: ClaimedRow) {
  const prepared = prepareAnalysisInput(row.article_content, DEEP_ANALYSIS_INPUT_CAP)
  if (prepared.content.length <= 500) {
    await fetch(`${sbUrl()}/rest/v1/article_deep_analysis?id=eq.${row.analysis_id}`, {
      method: 'PATCH',
      headers: sbHeaders(),
      body: JSON.stringify({
        status: 'ineligible',
        input_chars: prepared.input_chars,
        truncated: prepared.truncated,
        last_error: null,
        prompt_version: DEEP_ANALYSIS_PROMPT_VERSION,
      }),
    })
    return
  }

  log('article_start', { analysis_id: row.analysis_id, article_id: row.article_id, input_chars: prepared.input_chars, truncated: prepared.truncated })
  const rowForLlm = { ...row, article_content: prepared.content }
  const result = await callLLM(rowForLlm)
  const embedding = await embedAnalysis(row, result.analysis)
  await markReady(row, result, embedding, prepared)
  log('article_ready', { analysis_id: row.analysis_id, article_id: row.article_id, model: result.model })
}

async function processBatch() {
  const batchSize = Math.min(Math.max(Number(env('DEEP_ANALYSIS_BATCH_SIZE', '2')) || 2, 1), 5)
  const rows = await claimBatch(batchSize)
  log('claimed', { count: rows.length, batch_size: batchSize })
  for (const row of rows) {
    try {
      await processOne(row)
    } catch (err) {
      log('article_error', { analysis_id: row.analysis_id, article_id: row.article_id, error: (err as Error).message })
      await markFailure(row, err as Error)
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  EdgeRuntime.waitUntil(processBatch().catch(err => log('unhandled_error', { error: (err as Error).message })))
  return new Response(JSON.stringify({ status: 'accepted' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
