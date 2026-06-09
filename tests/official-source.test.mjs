import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const modulePath = process.env.OFFICIAL_SOURCE_MODULE ?? '../supabase/functions/_shared/official-source.js'
const {
  canonicalizeUrl,
  chooseDedupeWinner,
  classifyContentTypeHint,
  computeFingerprint,
  computeSimilarity,
  normalizeText,
  scoreUsableContent,
} = await import(modulePath)

describe('official-source helpers', () => {
  it('canonicalizes URLs by removing tracking params, fragments, index pages, and trailing slash', () => {
    assert.equal(
      canonicalizeUrl('https://openai.com/news/example/?utm_source=x&ref=home#section'),
      'https://openai.com/news/example',
    )
    assert.equal(
      canonicalizeUrl('https://deepmind.google/blog/post/index.html?fbclid=abc&x=1'),
      'https://deepmind.google/blog/post?x=1',
    )
  })

  it('normalizes text deterministically and removes common boilerplate', () => {
    assert.equal(
      normalizeText('  OpenAI: GPT-5, Safety & Research!\nSubscribe to our newsletter.  '),
      'openai gpt 5 safety research',
    )
  })

  it('computes stable fingerprints from canonical URL, normalized content, date, and organization', async () => {
    const one = await computeFingerprint({
      url: 'https://www.anthropic.com/news/claude?utm_campaign=test',
      title: 'Claude Research Update',
      bodyText: 'Claude research update with benchmark details.',
      publishedAt: '2026-05-28T00:00:00Z',
      organization: 'anthropic',
    })
    const two = await computeFingerprint({
      url: 'https://www.anthropic.com/news/claude',
      title: 'Claude Research Update!',
      bodyText: 'Claude research update with benchmark details.',
      publishedAt: '2026-05-28T00:00:00Z',
      organization: 'anthropic',
    })

    assert.equal(one, two)
    assert.match(one, /^[a-f0-9]{64}$/)
  })

  it('scores usable content higher when article metadata and technical detail are present', () => {
    const rich = scoreUsableContent({
      title: 'Anthropic releases circuit tracing results',
      bodyText: 'Methods section. Benchmark table. Claude 4.5 model evaluation with 92% accuracy and release notes.',
      publishedAt: '2026-05-28',
    })
    const thin = scoreUsableContent({
      title: '',
      bodyText: 'Short announcement.',
      publishedAt: null,
    })

    assert.equal(rich.usableContentChars, 98)
    assert.ok(rich.score > thin.score)
  })

  it('treats near-identical official and secondary candidates as duplicates and lets official win', () => {
    const official = {
      id: 'official',
      url: 'https://openai.com/news/model-release',
      title: 'OpenAI releases a new model with stronger coding results',
      bodyText: 'OpenAI releases a new model with stronger coding results and benchmark details for developers.',
      publishedAt: '2026-05-28',
      organization: 'openai',
      trustTier: 'official',
      usableContentChars: 90,
      dedupePriority: 100,
    }
    const secondary = {
      id: 'secondary',
      url: 'https://example.com/openai-model-release',
      title: 'OpenAI releases new model with stronger coding results',
      bodyText: 'OpenAI releases a new model with stronger coding results and benchmark details for developers.',
      publishedAt: '2026-05-28',
      organization: 'openai',
      trustTier: 'secondary',
      usableContentChars: 120,
      dedupePriority: 0,
    }

    assert.ok(computeSimilarity(official, secondary) >= 0.9)
    assert.equal(chooseDedupeWinner(official, secondary).winner.id, 'official')
  })

  it('classifies official content type hints from URL, title, and body cues', () => {
    assert.equal(classifyContentTypeHint('https://www.anthropic.com/research/circuits', 'Circuit tracing', 'Paper and methods'), 'research')
    assert.equal(classifyContentTypeHint('https://openai.com/news/product', 'API release notes', 'New API pricing'), 'product')
    assert.equal(classifyContentTypeHint('https://deepmind.google/blog/safety', 'Safety framework', 'Frontier safety policy'), 'safety')
  })
})
