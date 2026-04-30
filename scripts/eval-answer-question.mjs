#!/usr/bin/env node
//
// scripts/eval-answer-question.mjs
//
// Quality eval runner for the answer-question context-cap spec
// (docs/superpowers/specs/2026-04-26-answer-question-context-cap-design.md, §3).
//
// For each (article_id, question) pair in the input JSON, this calls both:
//   • prod  (uncapped) — defaults to function name `answer-question`
//   • stage (capped)   — defaults to function name `answer-question-capped`
// in parallel, parses the SSE stream from each, and writes a markdown file
// where every pair has both answers populated and the **Verdict:** /
// **Notes:** lines blank for the architect to fill in.
//
// Output is written incrementally — the header lands first, then each pair
// is appended as soon as both streams complete. A mid-run crash preserves
// every pair completed up to that point.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//   export SUPABASE_URL="https://<ref>.supabase.co"
//   export SUPABASE_ANON_KEY="<anon-key>"
//   node scripts/eval-answer-question.mjs \
//     "docs/superpowers/Questions Authoring.json" \
//     "docs/superpowers/specs/2026-04-26-answer-question-context-cap-eval.md"
//
// Both args optional (defaults shown above). Override function names via
// PROD_FN / CAPPED_FN env vars if you used different deploy names.
//
// ── Input JSON format ─────────────────────────────────────────────────────────
//   [
//     {
//       "article_id": "uuid",
//       "title": "OpenAI o4 launch",
//       "question": "What benchmarks did OpenAI cite for o4?",
//       "lang": "en",
//       "cohort": "long",          // optional, surfaced in markdown
//       "stress_test": true        // optional, marks back-half-of-article Qs
//     },
//     ...
//   ]
//
// Requires Node 18+ for native fetch / ReadableStream.

import { readFile, writeFile, appendFile } from 'node:fs/promises'
import process from 'node:process'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY in env before running.')
  process.exit(1)
}

const PROD_FN = process.env.PROD_FN || 'answer-question'
const CAPPED_FN = process.env.CAPPED_FN || 'answer-question-capped'

const inputPath = process.argv[2] || 'docs/superpowers/Questions Authoring.json'
const outputPath = process.argv[3] || 'docs/superpowers/specs/2026-04-26-answer-question-context-cap-eval.md'

async function streamAnswer(fnName, payload) {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return `[NETWORK ERROR] ${e.message}`
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return `[HTTP ${res.status}] ${body.slice(0, 500)}`
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const sse = line.slice(6).trim()
      if (sse === '[DONE]' || !sse) continue
      try {
        const parsed = JSON.parse(sse)
        // Skip `thinking` chunks — only `content` deltas are part of the
        // user-visible answer.
        if (parsed.type === 'content' && parsed.content) {
          answer += parsed.content
        }
      } catch {
        // Single malformed chunk shouldn't kill the pair — keep accumulating.
        // Missing data would surface as visible truncation in the eval doc.
      }
    }
  }
  return answer.trim() || '[empty response]'
}

function formatPairBlock({ pair, qNum, uncapped, capped }) {
  const lines = []
  lines.push(`## ${pair.article_id}${pair.title ? ` ${pair.title}` : ''} — Q${qNum}`)
  if (pair.cohort) {
    lines.push(`*Cohort: ${pair.cohort}${pair.stress_test ? ' · stress test (back-half answer)' : ''}*`)
  }
  lines.push('')
  lines.push(`**Question:** ${pair.question}`)
  lines.push('')
  lines.push('### Uncapped (current production)')
  lines.push(uncapped)
  lines.push('')
  lines.push('### Capped (proposed)')
  lines.push(capped)
  lines.push('')
  lines.push('**Verdict:** ')
  lines.push('**Notes:** ')
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const raw = await readFile(inputPath, 'utf8')
  const pairs = JSON.parse(raw)
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error(`Input ${inputPath} is empty or not an array.`)
    process.exit(1)
  }

  // Header — written first so a crash mid-loop still leaves an inspectable file.
  const header = [
    '# answer-question Context Cap — Quality Eval',
    '',
    `**Run:** ${new Date().toISOString()}`,
    `**Pairs (planned):** ${pairs.length}`,
    `**Prod fn:** \`${PROD_FN}\` (uncapped baseline)  ·  **Staging fn:** \`${CAPPED_FN}\` (capped)`,
    '',
    'Verdict legend: `same` / `acceptable_degradation` / `much_worse`. Mid-length cohort must score `same` on all pairs (regression check).',
    '',
    '---',
    '',
    '',
  ].join('\n')
  await writeFile(outputPath, header, 'utf8')

  // Per-article Q numbering so headings read as Q1, Q2, Q3 within each article.
  const qCounters = new Map()

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    const lang = pair.lang || 'en'
    const qNum = (qCounters.get(pair.article_id) || 0) + 1
    qCounters.set(pair.article_id, qNum)

    process.stderr.write(`[${i + 1}/${pairs.length}] ${pair.article_id} Q${qNum} — ${(pair.question || '').slice(0, 70)}\n`)

    const payload = { article_id: pair.article_id, question: pair.question, lang }
    const [uncapped, capped] = await Promise.all([
      streamAnswer(PROD_FN, payload),
      streamAnswer(CAPPED_FN, payload),
    ])

    await appendFile(outputPath, formatPairBlock({ pair, qNum, uncapped, capped }), 'utf8')
  }

  process.stderr.write(`\nWrote ${pairs.length} pairs → ${outputPath}\n`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
