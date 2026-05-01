# AI Relevance Filter Hardening

**Date:** 2026-04-18
**Status:** Ready for implementation
**Owner:** SWE role
**Touches:** `workers/process-queue/src/index.ts`

---

## Problem

Non-AI tweets from known tech figures are slipping through the `NOT_AI_RELEVANT` LLM filter and reaching `daily_news`. Confirmed examples:
- `@paulg: 铁路投资前所未有，即使在对数尺度上也是如此` (economics observation, zero AI content)
- `@paulg: 告诉@PatrickHeizer 不仅表情恰当，脸型也很适合` (personal observation, zero AI content)

---

## Root Cause

Two compounding issues in `workers/process-queue/src/index.ts`:

**1. Identity bias — sender ≠ topic**
The prompt never states that the author's identity is irrelevant to relevance. The LLM knows `@paulg` is a famous AI/tech investor and reasons "Paul Graham → AI-adjacent → probably relevant." Relevance must be determined by **content**, not sender.

**2. FAILURE MODE note is too broad**
Both prompt variants contain:
> "FAILURE MODE: Outputting NOT_AI_RELEVANT for tweets about Chinese AI labs when uncertain"

This guard — meant to protect legitimate Chinese AI lab content — causes the model to be overly conservative about filtering any tweet from a recognized AI-adjacent handle. It needs to be scoped specifically to Chinese AI lab names, not all tech figures.

---

## Fix — Two Parts

### Part 1: Pre-LLM Keyword Gate (zero token cost)

**Where:** `processArticle()` in `workers/process-queue/src/index.ts`, before the `callLLM()` call at line 694.

**Trigger condition:** `isTweet === true` only (articles have full scraped content and are better evaluated by the LLM).

**Implementation:**

```typescript
// English — word-boundary matched (prevents 'ai' matching 'said', 'main', 'train', etc.)
const EN_AI_KEYWORDS = /\b(ai|agi|asi|llm|gpt|claude|gemini|openai|anthropic|deepmind|mistral|llama|groq|cohere|sora|midjourney|runway|nvidia|hugging|transformers|neural|multimodal|generative|agents?|embedding|rag|inference|benchmark|fine.tun|training\s+run|gpu|h100|a100|compute|foundation\s+model|reasoning\s+model|o1|o3|o4)\b/i

// Chinese — plain substring match (no word boundaries in Chinese script)
const ZH_AI_KEYWORDS = [
  '人工智能','大模型','语言模型','神经网络','深度学习','机器学习',
  '生成式','多模态','算力','英伟达',
  '智谱','文心','通义','混元','月之暗面','零一万物','阶跃星辰',
  'DeepSeek','百川','商汤','科大讯飞','华为盘古',
]

function hasAISignal(text: string): boolean {
  if (EN_AI_KEYWORDS.test(text)) return true
  return ZH_AI_KEYWORDS.some(kw => text.includes(kw))
}
```

**Gate placement in `processArticle()`** — insert after `rawContent` is computed and the empty-content check, before `callLLM()`:

```typescript
// Tweet-specific pre-LLM gate: filter zero-AI-signal tweets at zero token cost
if (isTweet && !hasAISignal(rawContent)) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
    method: 'PATCH',
    headers: SB(env),
    body: JSON.stringify({ status: 'error', last_error: 'NOT_AI_RELEVANT' }),
  })
  console.log(`SKIP (keyword gate — not AI relevant): ${article.url}`)
  return
}
```

**Risk note:** The keyword list is intentionally broad. A tweet must contain zero AI signal to be caught. The only failure mode is a genuinely new AI entity whose name matches none of the above — it would pass through to LLM evaluation anyway, same as today.

---

### Part 2: Prompt Hardening

Modify the `NOT_AI_RELEVANT` sentinel definition in **all four prompt constants**:
- `TWEET_SYSTEM_PROMPT` (flat-text, Groq fallback) — lines ~130–141
- `TWEET_SYSTEM_PROMPT_JSON` (JSON, OpenRouter primary) — lines ~251–255

**Change A — Add "content not sender" rule:**

Add this line to the NOT_AI_RELEVANT definition, immediately after the substitution test sentence:

> `— The author's identity does NOT determine relevance. A tweet from @sama about baseball is NOT_AI_RELEVANT. A tweet from @paulg about railroad investment is NOT_AI_RELEVANT. Judge the CONTENT of the tweet, not who sent it.`

**Change B — Add concrete @paulg-type examples to the NOT_AI_RELEVANT examples list:**

```
  • "@paulg: Railroad investment is unprecedented, even on a log scale" → NOT_AI_RELEVANT (economics; no AI content)
  • "@paulg: 铁路投资前所未有，即使在对数尺度上也是如此" → NOT_AI_RELEVANT (same; Chinese-language economics tweet)
  • "@sama: Great dinner tonight" → NOT_AI_RELEVANT (personal; sender identity irrelevant)
```

**Change C — Tighten the FAILURE MODE note:**

Current:
> `FAILURE MODE: Outputting NOT_AI_RELEVANT for tweets about Chinese AI labs when uncertain — when the primary subject is an AI company or model, output the summary.`

Replace with:
> `FAILURE MODE: Outputting NOT_AI_RELEVANT for tweets whose content explicitly names a Chinese AI lab (DeepSeek, 智谱, 文心, 通义, 混元, 月之暗面, 阶跃星辰, 零一万物) — these are AI-relevant by definition even if uncertain. For all other content, apply the substitution test strictly regardless of who sent the tweet.`

---

## Token Budget Impact

- **Keyword gate:** Tweets with zero AI signal are filtered at zero token cost. Conservative estimate: 15–25% of tweets from broad-network handles (e.g. @paulg, general tech VCs) contain no AI signal. ~185–310 tokens saved per filtered tweet. Net effect: positive headroom toward the 100K TPD cap.
- **Prompt changes:** No material token cost change (±50 tokens per call from added text).
- **No new LLM calls introduced.**

---

## Verification

1. Deploy `process-queue` via `wrangler deploy`
2. Use `wrangler dev --remote --test-scheduled` locally
3. Insert test row: `raw_content = '@paulg: 铁路投资前所未有，即使在对数尺度上也是如此'`, `url = 'https://x.com/paulg/status/test1'`, `status = 'pending'`
4. Trigger: `curl "http://localhost:8787/__scheduled?cron=..."`
5. Assert: `raw_ingestion` row → `status='error', last_error='NOT_AI_RELEVANT'`; no `daily_news` row inserted
6. Insert a legitimate AI tweet (e.g. `@sama: OpenAI raised $40B at $300B valuation`)
7. Assert: passes through keyword gate → LLM processes → appears in `daily_news`
8. Run trigger twice on same URL; verify row count does not increase (idempotency check)
