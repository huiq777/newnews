#!/usr/bin/env node

import crypto from 'node:crypto'
import process from 'node:process'

import {
  BGE_EMBEDDING_MODEL,
  DEFAULT_EVAL_SET,
  buildBgeEmbeddingsUrl,
  fetchWithRetry,
  parseArgs,
  requiredEnv,
  restInsert,
  restSelect,
  uuidIn,
} from './rag-eval-lib.mjs'

const CHUNKING_VERSION = 'paragraph-window-v1-2026-06-02'
// Refinement chunk embeddings use BGE_EMBEDDING_MODEL so query/document vectors match.
const CHUNKING_PARAMS = {
  targetChars: 3200,
  overlapChars: 600,
}

async function main() {
  const args = parseArgs()
  const env = requiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BGE_EMBEDDING_BASE_URL', 'BGE_EMBEDDING_API_KEY'])
  const limit = Number(args.limit || 20)
  const hasEvalSet = Boolean(args['eval-set'])
  const minChars = Number(args['min-chars'] || (hasEvalSet ? 200 : 5000))
  // --batch-size can be lowered for providers that reject large embedding batches.
  const batchSize = Number(args['batch-size'] || 16)

  // --eval-set backfills approved relevant gold articles, avoiding accidental recent-only sampling.
  const rows = hasEvalSet
    ? await loadEvalGoldArticles(env, String(args['eval-set'] || DEFAULT_EVAL_SET))
    : await restSelect(
        env,
        `daily_news?select=id,source_id,title,article_content,summary,summary_en,summary_zh&article_content=not.is.null&order=created_at.desc&limit=${limit}`
      )
  const articles = rows.filter(row => String(row.article_content || '').length >= minChars)
  let chunksWritten = 0

  for (const article of articles) {
    const chunks = splitArticleIntoChunks(
      article.article_content,
      CHUNKING_PARAMS.targetChars,
      CHUNKING_PARAMS.overlapChars
    )
    if (chunks.length === 0) continue
    const embeddingInputs = chunks.map((chunk, index) => ({
      text: chunk.chunk_text,
      articleId: article.id,
      title: article.title || '',
      chunkIndex: index,
    }))
    const embeddings = await embedChunksInBatches(env, embeddingInputs, batchSize)
    const insertRows = chunks.map((chunk, index) => ({
      article_id: article.id,
      source_id: article.source_id,
      chunking_version: CHUNKING_VERSION,
      chunking_params: CHUNKING_PARAMS,
      chunk_index: index,
      chunk_text: chunk.chunk_text,
      chunk_hash: sha256(chunk.chunk_text),
      boundary_type: 'paragraph',
      char_start: chunk.char_start,
      char_end: chunk.char_end,
      token_estimate: Math.ceil(chunk.chunk_text.length / 4),
      language: detectLanguage(chunk.chunk_text),
      embedding: `[${embeddings[index].join(',')}]`,
      embedding_model: BGE_EMBEDDING_MODEL,
      embedding_input_type: 'search_document',
    }))
    await restInsert(env, 'article_chunks', insertRows, {
      upsert: true,
      onConflict: 'article_id,chunking_version,chunk_hash',
    })
    chunksWritten += insertRows.length
    console.log(`chunked ${insertRows.length}: ${article.title || article.id}`)
  }

  console.log(`Done. Wrote/upserted ${chunksWritten} chunks.`)
}

async function loadEvalGoldArticles(env, evalSetName) {
  const sets = await restSelect(env, `rag_eval_sets?name=eq.${encodeURIComponent(evalSetName)}&select=id&limit=1`)
  if (!sets[0]) throw new Error(`Eval set not found: ${evalSetName}`)

  const cases = await restSelect(env, `rag_eval_cases?eval_set_id=eq.${sets[0].id}&select=id`)
  const caseIds = cases.map(row => row.id)
  if (caseIds.length === 0) return []

  const articleIds = await loadEvalGoldArticleIds(env, caseIds)
  if (articleIds.length === 0) return []

  return restSelect(
    env,
    `daily_news?id=${uuidIn(articleIds)}&select=id,source_id,title,article_content,summary,summary_en,summary_zh&article_content=not.is.null`
  )
}

async function loadEvalGoldArticleIds(env, caseIds) {
  const rows = await restSelect(
    env,
    `rag_eval_gold_evidence?case_id=${uuidIn(caseIds)}&review_status=eq.approved&relevance_grade=gte.2&select=article_id`
  )
  return [...new Set(rows.map(row => row.article_id).filter(Boolean))]
}

export function splitArticleIntoChunks(text, targetChars = 3200, overlapChars = 600) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
  const chunks = []
  let buffer = ''
  let start = 0
  let cursor = 0

  for (const paragraph of paragraphs) {
    const paragraphStart = text.indexOf(paragraph, cursor)
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (next.length > targetChars && buffer) {
      chunks.push({ chunk_text: buffer, char_start: start, char_end: start + buffer.length })
      const overlap = buffer.slice(Math.max(0, buffer.length - overlapChars))
      buffer = `${overlap}\n\n${paragraph}`
      start = Math.max(0, paragraphStart - overlap.length)
    } else {
      if (!buffer) start = paragraphStart >= 0 ? paragraphStart : cursor
      buffer = next
    }
    cursor = paragraphStart >= 0 ? paragraphStart + paragraph.length : cursor + paragraph.length
  }

  if (buffer) chunks.push({ chunk_text: buffer, char_start: start, char_end: start + buffer.length })
  return chunks
}

async function embedChunksInBatches(env, inputs, batchSize = 16) {
  const embeddings = []
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize)
    const batchEmbeddings = await embedChunkBatch(env, batch)
    if (batchEmbeddings.length !== batch.length) {
      throw new Error(`BGE returned ${batchEmbeddings.length} embeddings for ${batch.length} chunks`)
    }
    embeddings.push(...batchEmbeddings)
  }
  return embeddings
}

async function embedChunkBatch(env, texts) {
  const inputs = texts.map(item => ({
    ...item,
    text: sanitizeEmbeddingInput(typeof item === 'string' ? item : item.text),
  })).filter(item => item.text.length > 0)
  if (inputs.length !== texts.length) {
    throw new Error('BGE rejected chunk: empty sanitized embedding input')
  }

  const res = await fetchWithRetry(buildBgeEmbeddingsUrl(env.BGE_EMBEDDING_BASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BGE_EMBEDDING_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BGE_EMBEDDING_MODEL,
      input_type: 'search_document',
      input: inputs.map(item => item.text),
    }),
  })
  if (!res.ok) {
    const errorText = (await res.text()).slice(0, 500)
    if (inputs.length > 1 && res.status === 400) {
      return embedChunkBatchIndividually(env, inputs, errorText)
    }
    const item = inputs[0] || {}
    throw new Error(`BGE rejected chunk articleId=${item.articleId || 'unknown'} chunkIndex=${item.chunkIndex ?? 'unknown'} title="${String(item.title || '').slice(0, 80)}": ${errorText}`)
  }
  const json = await res.json()
  const embeddings = Array.isArray(json.data)
    ? json.data.map(row => row.embedding)
    : json.embeddings
  if (!Array.isArray(embeddings) || embeddings.some(row => !Array.isArray(row))) {
    throw new Error('BGE chunk embed response missing embeddings')
  }
  return embeddings
}

async function embedChunkBatchIndividually(env, inputs, batchErrorText) {
  const embeddings = []
  for (const item of inputs) {
    try {
      embeddings.push(...await embedChunkBatch(env, [item]))
    } catch (error) {
      throw new Error(`${error.message}; parent_batch_error=${batchErrorText}`)
    }
  }
  return embeddings
}

function sanitizeEmbeddingInput(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function detectLanguage(text) {
  return /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en'
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
