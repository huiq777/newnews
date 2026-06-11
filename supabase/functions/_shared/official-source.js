const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'ref',
  'ref_src',
  'spm',
])

const BOILERPLATE_PATTERNS = [
  /\bsubscribe to (our|the) newsletter\b/gi,
  /\bsign up for (our|the) newsletter\b/gi,
  /\bshare this (article|post)\b/gi,
  /\bread more\b/gi,
  /\bcookie policy\b/gi,
]

export function canonicalizeUrl(input) {
  try {
    const url = new URL(input)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key)
      }
    }
    url.pathname = url.pathname
      .replace(/\/index\.html?$/i, '')
      .replace(/\/+$/g, '')
    return url.toString().replace(/\?$/, '')
  } catch {
    return String(input || '').trim()
  }
}

export function normalizeText(input) {
  let text = String(input || '').toLowerCase()
  for (const pattern of BOILERPLATE_PATTERNS) text = text.replace(pattern, ' ')
  return text
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function computeFingerprint({ url, title, bodyText, publishedAt, organization }) {
  const canonicalUrl = canonicalizeUrl(url)
  const normalizedTitle = normalizeText(title)
  const normalizedBody = normalizeText(bodyText).slice(0, 4000)
  const date = normalizeDate(publishedAt)
  const org = normalizeText(organization)
  const payload = [canonicalUrl, normalizedTitle, normalizedBody, date, org].join('\n')
  const bytes = new TextEncoder().encode(payload)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function scoreUsableContent({ title, bodyText, publishedAt }) {
  const text = String(bodyText || '').replace(/\s+/g, ' ').trim()
  const normalized = normalizeText(text)
  const usableContentChars = text.length
  const boilerplateHits = BOILERPLATE_PATTERNS.reduce((count, pattern) => {
    const matches = text.match(pattern)
    return count + (matches?.length ?? 0)
  }, 0)
  const technicalHits = [
    /\bmethod(s)?\b/i,
    /\bbenchmark(s)?\b/i,
    /\bmodel(s)?\b/i,
    /\brelease notes?\b/i,
    /\btable(s)?\b/i,
    /\bsection(s)?\b/i,
    /\bevaluation(s)?\b/i,
    /\barchitecture\b/i,
    /\bsafety\b/i,
  ].reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)

  const score =
    usableContentChars +
    (String(title || '').trim() ? 250 : 0) +
    (publishedAt ? 150 : 0) +
    technicalHits * 80 -
    boilerplateHits * 120 -
    Math.max(0, normalized.length ? Math.round((1 - normalized.length / Math.max(text.length, 1)) * 100) : 0)

  return { score, usableContentChars, technicalHits, boilerplateHits }
}

export function computeSimilarity(a, b) {
  if (canonicalizeUrl(a.url) === canonicalizeUrl(b.url)) return 1

  const titleSimilarity = jaccard(tokens(normalizeText(a.title)), tokens(normalizeText(b.title)))
  const bodySimilarity = jaccard(shingles(normalizeText(a.bodyText), 5), shingles(normalizeText(b.bodyText), 5))
  const dateBoost = normalizeDate(a.publishedAt) && normalizeDate(a.publishedAt) === normalizeDate(b.publishedAt) ? 0.03 : 0
  return Math.min(1, titleSimilarity * 0.38 + bodySimilarity * 0.59 + dateBoost)
}

export function chooseDedupeWinner(a, b) {
  const aOfficial = a.trustTier === 'official'
  const bOfficial = b.trustTier === 'official'
  if (aOfficial !== bOfficial) {
    return aOfficial ? { winner: a, suppressed: b, reason: 'official_beats_secondary' } : { winner: b, suppressed: a, reason: 'official_beats_secondary' }
  }

  const priorityDelta = (a.dedupePriority ?? 0) - (b.dedupePriority ?? 0)
  if (priorityDelta !== 0) {
    return priorityDelta > 0 ? { winner: a, suppressed: b, reason: 'higher_dedupe_priority' } : { winner: b, suppressed: a, reason: 'higher_dedupe_priority' }
  }

  const contentDelta = (a.usableContentChars ?? 0) - (b.usableContentChars ?? 0)
  if (contentDelta !== 0) {
    return contentDelta >= 0 ? { winner: a, suppressed: b, reason: 'richer_usable_content' } : { winner: b, suppressed: a, reason: 'richer_usable_content' }
  }

  return { winner: a, suppressed: b, reason: 'stable_first_candidate' }
}

export function classifyContentTypeHint(url, title, bodyText) {
  const haystack = normalizeText(`${url} ${title} ${bodyText}`).toLowerCase()
  if (/\b(safety|preparedness|risk|alignment|policy)\b/.test(haystack)) return 'safety'
  if (/\b(engineering|infrastructure|systems|latency|scaling)\b/.test(haystack)) return 'engineering'
  if (/\b(research|paper|method|benchmark|evaluation|circuits|model card)\b/.test(haystack)) return 'research'
  if (/\b(technical report|system card|report)\b/.test(haystack)) return 'technical_report'
  if (/\b(product|api|release notes|pricing|launch|app)\b/.test(haystack)) return 'product'
  if (/\b(news|announcement|announces|introducing)\b/.test(haystack)) return 'news'
  return 'unknown'
}

export function isNearDuplicate(candidate, existing, threshold = 0.9) {
  return computeSimilarity(candidate, existing) >= threshold
}

export function shouldSuppressCandidate(candidate, existing, threshold = 0.9) {
  if (!isNearDuplicate(candidate, existing, threshold)) return null
  const decision = chooseDedupeWinner(candidate, existing)
  return decision.suppressed === candidate ? decision : null
}

function normalizeDate(input) {
  if (!input) return ''
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return String(input).slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function tokens(text) {
  if (!text) return []
  return text.split(/\s+/).filter(Boolean)
}

function shingles(text, size) {
  const parts = tokens(text)
  if (parts.length <= size) return parts.length ? [parts.join(' ')] : []
  const result = []
  for (let i = 0; i <= parts.length - size; i++) {
    result.push(parts.slice(i, i + size).join(' '))
  }
  return result
}

function jaccard(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  const a = new Set(left)
  const b = new Set(right)
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection++
  return intersection / (a.size + b.size - intersection)
}
