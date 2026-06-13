import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  analysisToEmbeddingText,
  extractFirstJson,
  prepareAnalysisInput,
  validateDeepAnalysis,
} from '../supabase/functions/_shared/deep-analysis.js'

const validAnalysis = {
  article_type: 'technical_report',
  en: {
    facts: [
      { text: 'Anthropic published an evaluation of agent behavior.', evidence: 'opening section' },
      { text: 'The article describes multiple test settings.', evidence: 'methods section' },
      { text: 'The article separates observed behavior from interpretation.', evidence: 'results section' },
    ],
    why_it_matters: 'The result gives builders a concrete way to reason about model reliability. It also clarifies which parts of the article are measured rather than merely claimed. That matters because teams can compare the evidence against their own deployment risk.',
    deeper_interpretation: 'As interpretation, this suggests evaluation design is becoming a product requirement. Vertically, the article fits a broader move from model capability claims toward operational trust claims. Horizontally, it positions labs that can publish concrete behavior tests against competitors that only describe product improvements. The cross-axis point is that reliability is becoming both a technical frontier and a market signal. That makes the evidence format almost as important as the reported result.',
    limitations_or_uncertainties: ['The article does not provide every prompt.', 'The result may not generalize to all deployments.'],
  },
  zh: {
    facts: [
      { text: 'Anthropic发布了关于智能体行为的评估。', evidence: '开头部分' },
      { text: '文章描述了多个测试设置。', evidence: '方法部分' },
      { text: '文章区分了观察结果和解读。', evidence: '结果部分' },
    ],
    why_it_matters: '这让开发者可以更具体地判断模型可靠性。它也把文章里的实测内容和普通主张区分开来。对团队来说，这意味着可以把证据和自己的部署风险直接对照。',
    deeper_interpretation: '作为解读，这说明评估设计正在变成产品要求。纵向看，这篇文章延续了从模型能力叙事转向运行可信度叙事的变化。横向看，能发布具体行为测试的实验室，会比只描述产品升级的竞争者更容易建立信任。交叉来看，可靠性已经同时变成技术前沿和市场信号。也因此，证据呈现方式几乎和结果本身一样重要。',
    limitations_or_uncertainties: ['文章没有提供每个提示词。', '结果不一定能泛化到所有部署场景。'],
  },
}

test('validateDeepAnalysis accepts and normalizes the expected nested contract', () => {
  const normalized = validateDeepAnalysis(validAnalysis)
  assert.equal(normalized.article_type, 'technical_report')
  assert.equal(normalized.en.facts.length, 3)
  assert.equal(normalized.zh.limitations_or_uncertainties.length, 2)
})

test('validateDeepAnalysis rejects missing evidence anchors', () => {
  const bad = structuredClone(validAnalysis)
  delete bad.en.facts[0].evidence
  assert.throws(() => validateDeepAnalysis(bad), /evidence must be a string/)
})

test('validateDeepAnalysis rejects analysis paragraphs that are too short', () => {
  const bad = structuredClone(validAnalysis)
  bad.en.why_it_matters = 'Too short.'
  assert.throws(() => validateDeepAnalysis(bad), /why_it_matters must contain at least 3 sentences/)
})

test('prepareAnalysisInput reports truncation without hiding original size', () => {
  const prepared = prepareAnalysisInput('x'.repeat(20), 10)
  assert.equal(prepared.content.length, 10)
  assert.equal(prepared.input_chars, 20)
  assert.equal(prepared.truncated, true)
})

test('analysisToEmbeddingText produces deterministic bilingual content', () => {
  const text = analysisToEmbeddingText(validateDeepAnalysis(validAnalysis), 'A title')
  assert.match(text, /Title: A title/)
  assert.match(text, /EN facts:/)
  assert.match(text, /ZH limitations:/)
})

test('generate-deep-analysis embeds ready analyses with Cloudflare BGE instead of Cohere', () => {
  const source = readFileSync('supabase/functions/generate-deep-analysis/index.ts', 'utf8')

  assert.match(source, /CLOUDFLARE_ACCOUNT_ID/)
  assert.match(source, /CLOUDFLARE_API_TOKEN/)
  assert.match(source, /@cf\/baai\/bge-m3/)
  assert.match(source, /input_type:\s*'search_document'/)
  assert.match(source, /Cloudflare BGE returned invalid embedding length/)
  assert.doesNotMatch(source, /COHERE_EMBED_API/)
  assert.doesNotMatch(source, /COHERE_API_KEY/)
  assert.doesNotMatch(source, /Cohere/)
})

test('extractFirstJson handles braces inside strings and trailing prose', () => {
  const json = extractFirstJson('```json\n{"a":"{not depth}","b":{"c":1}}\n```\nextra')
  assert.deepEqual(JSON.parse(json), { a: '{not depth}', b: { c: 1 } })
})
