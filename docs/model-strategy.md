# Model Strategy

> This document compares the current model setup against a proposed two-model split.
> It is a planning reference — no code has been changed yet.
> Source: Arena AI leaderboard (March 2026), Artificial Analysis, xAI/Xiaomi pricing pages.

---

## Current Setup

**Three-tier routing:** TokenRouter (`qwen/qwen3.6-plus`) → OpenRouter (configurable model) → Groq (`llama-3.3-70b-versatile`) as tertiary fallback

`process-queue` (Supabase Edge Function) routes through all three. All other functions (`answer-question`, `refresh-questions`, `ingest-builders`) call Groq directly.

| Property | Value |
|---|---|
| Primary provider | TokenRouter — `qwen/qwen3.6-plus`; 120s timeout |
| Secondary provider | OpenRouter — model set via `OPENROUTER_MODEL` secret |
| Tertiary fallback | Groq (GroqCloud) — `llama-3.3-70b-versatile` |
| Groq context window | 128K tokens |
| Groq Arena score | ~1,250 (estimated; not on Arena top-100) |
| Groq pricing (free tier) | $0 — hard-capped at **100K tokens/day (TPD)** |
| Groq pricing (paid tier) | $0.59 input / $0.79 output per 1M tokens |
| Groq TPM limit | 12,000 tokens/minute |

### What it does today

| Task | Worker / Function | Calls/item | max_tokens |
|---|---|---|---|
| Bilingual article summary (EN + ZH) | `process-queue` (Edge Function) | 1 | 900 |
| Bilingual tweet summary (EN + ZH) | `process-queue` (Edge Function) | 1 | 900 |
| EN analytical questions (3×) | `process-queue` (Edge Function) | 1 | 300 |
| ZH analytical questions (3×) | `process-queue` (Edge Function) | 1 | 300 |
| Twitter bio extraction (batch) | `ingest-builders` | 1/day | 600 |
| RAG streaming Q&A answer | `answer-question` | 1 | 1024 |
| EN question regeneration | `refresh-questions` | 1 | 300 |
| ZH question regeneration | `refresh-questions` | 1 | 300 |

### Problems with the current setup

**1. The TPD ceiling throttles the pipeline when Groq is used**

TokenRouter as primary significantly reduces direct Groq hits — Groq 429s now only occur when TokenRouter + OpenRouter both fail. However, `answer-question`, `refresh-questions`, and `ingest-builders` still call Groq directly, and the structural argument for removing the Groq dependency entirely still holds.

Daily content demand vs the 100K TPD cap (worst case — all traffic on Groq):

| Source | Items/day | Tokens/item | Daily demand |
|---|---|---|---|
| RSS articles | ~30 | ~3,790 | ~113,700 |
| WeChat articles | ~15 | ~3,200 | ~48,000 |
| Builder tweets | ~50 | ~2,545 | ~127,250 |
| Podcasts | ~1 | ~5,000 | ~5,000 |
| Bio extraction | 1 run | ~990 | ~990 |
| **Total demand** | ~97 items | | **~294,940** |
| **TPD cap** | | | **100,000** |
| **Overflow** | | | **~195,000 (~3× over)** |

Only ~35–45 items process before the limit hits. The rest stay `pending` and retry the next day, creating a growing backlog on high-volume days.

**2. One model for every task is wasteful by design**

Questions and bio extraction are structured, mechanical tasks — they need speed and reliability, not top-tier reasoning. Article summarization and Q&A answers are quality-sensitive — they directly affect what the user reads and learns. Using the same model at the same cost for both is over-engineering the simple tasks and under-investing in the important ones.

**3. Paying for Groq removes the TPD ceiling but costs ~$2–3/month** for the same mediocre model

The Groq paid tier ($0.59/$0.79) would lift the TPD limit but still uses llama-3.3-70b-versatile — a model that scores ~1,250 on Arena, meaningfully below the alternatives available at similar or lower cost.

---

## Proposed Setup: Two-Model Split

### Model 1 — `grok-4.1-thinking` (xAI) for quality-sensitive tasks

| Property | Value |
|---|---|
| Provider | xAI API (`https://api.x.ai/v1`) |
| Model ID | `grok-4.1-thinking` (code name: quasarflux) |
| Context window | **2,000,000 tokens** (2M — industry-leading) |
| Arena score | **1,472** (rank 11 overall) |
| Input price | **$0.20 / 1M tokens** |
| Output price | **$0.50 / 1M tokens** |
| Thinking toggle | `{ "reasoning": { "enabled": true/false } }` per call |
| API compatibility | OpenAI-compatible — drop-in endpoint swap |

**Key strength:** Thinking tokens add genuine reasoning depth. Togglable per call, so you only pay for reasoning when it helps.

**Arena leaderboard context:**

| Rank | Model | Score | Input | Output |
|---|---|---|---|---|
| 1 | claude-opus-4-6-thinking | 1502 | $5.00 | $25.00 |
| 3 | gemini-3.1-pro-preview | 1493 | $2.00 | $12.00 |
| 8 | grok-4.20-beta-reasoning | 1481 | $2.00 | $6.00 |
| 9 | gemini-3-flash | 1475 | $0.50 | $3.00 |
| **11** | **grok-4.1-thinking** | **1472** | **$0.20** | **$0.50** |
| — | llama-3.3-70b (current) | ~1,250 | $0.59* | $0.79* |

grok-4.1-thinking at $0.20/$0.50 sits at rank 11 globally while costing **less than the current Groq paid tier** ($0.59/$0.79). That is the core value proposition.

---

### Model 2 — `mimo-v2-flash` (Xiaomi) for structured/mechanical tasks

| Property | Value |
|---|---|
| Provider | Xiaomi API / OpenRouter |
| Model ID | `mimo-v2-flash` (non-thinking mode) |
| Architecture | MoE — 309B total params, **15B active** |
| Context window | 256K tokens |
| Arena score | **1,392** (rank 95, non-thinking mode) |
| Input price | **$0.09 / 1M tokens** |
| Output price | **$0.29 / 1M tokens** |
| Speed | **133 tokens/second** output (2.5× faster than median 54.5 t/s) |
| TTFT | 2.07s (better than average) |
| API compatibility | OpenAI-compatible |

**Key strength:** At $0.09/$0.29 with 133 t/s output speed, it's the fastest cheap model that still scores above average (rank 95 out of 330 models). Only 15B active params keeps latency low despite the large total parameter count.

**⚠️ Verbosity warning:** MiMo generates ~5–6× more output tokens than the average model (98M vs 17M median in evaluation). For tasks with tight `max_tokens` caps (questions at 300) this is harmless — the cap truncates it. For tweet summaries (`max_tokens: 900`), reduce to **400** to prevent bloated outputs from 280-char inputs.

---

## Task-by-Task Assignment

| Task | Current | Proposed | Thinking? | Rationale |
|---|---|---|---|---|
| Article summary (bilingual) | llama-3.3-70b | **grok-4.1-thinking** | ❌ OFF | Writing task, not reasoning — thinking adds latency/cost without improving structured bullet output. Quality gap (1472 vs ~1250) directly improves what user reads daily. |
| Tweet summary (bilingual) | llama-3.3-70b | **grok-4.1-thinking** | ❌ OFF | Same reasoning as above. grok-4.1 produces cleaner author-perspective framing for short content. |
| EN questions (3×) | llama-3.3-70b | **mimo-v2-flash** | ❌ | Structured JSON output, creative but mechanical. Speed matters more than depth. MiMo at $0.09 is 6.5× cheaper input. |
| ZH questions (3×) | llama-3.3-70b | **mimo-v2-flash** | ❌ | Same as EN questions. Chinese output quality is acceptable at rank 95. |
| Bio extraction (batch) | llama-3.3-70b | **mimo-v2-flash** | ❌ | Pure JSON extraction from structured bios. No quality threshold justifies grok-4.1 here. |
| RAG Q&A answer | llama-3.3-70b | **grok-4.1-thinking** | ✅ ON | The only task that genuinely benefits from reasoning — cross-referencing article content with 3 related articles, synthesizing a coherent answer. Thinking mode pays off here. |
| Question regeneration (EN+ZH) | llama-3.3-70b | **mimo-v2-flash** | ❌ | Identical to initial question generation. Same rationale. |

---

## Cost Comparison

**Assumptions:** 40 articles/day + 50 tweets/day + 5 Q&A sessions/day + 3 refreshes/day

### Current — Groq paid tier (after upgrading from free)

| Task | Volume/day | Tokens/item | Input tokens | Output tokens | Cost/day |
|---|---|---|---|---|---|
| Article summary | 40 | 1,610 in / 530 out | 64,400 | 21,200 | $0.055 |
| Tweet summary | 50 | 445 in / 450 out | 22,250 | 22,500 | $0.031 |
| EN questions | 90 | 400 in / 100 out | 36,000 | 9,000 | $0.028 |
| ZH questions | 90 | 1,030 in / 120 out | 92,700 | 10,800 | $0.063 |
| Bio extraction | 1 | 800 in / 190 out | 800 | 190 | $0.001 |
| RAG Q&A | 5 | 1,675 in / 530 out | 8,375 | 2,650 | $0.007 |
| Question refresh | 3 | 1,430 in / 220 out | 4,290 | 660 | $0.003 |
| **Daily total** | | | **228,815** | **67,000** | **$0.188** |
| **Monthly total** | | | | | **~$5.64** |

### Proposed — grok-4.1-thinking (heavy) + mimo-v2-flash (light)

| Task | Model | Volume/day | Input tokens | Output tokens | Cost/day |
|---|---|---|---|---|---|
| Article summary | grok-4.1 | 40 | 64,400 | 21,200 | $0.023 |
| Tweet summary | grok-4.1 | 50 | 22,250 | 22,500 | $0.016 |
| EN questions | mimo-v2-flash | 90 | 36,000 | 9,000 | $0.006 |
| ZH questions | mimo-v2-flash | 90 | 92,700 | 10,800 | $0.012 |
| Bio extraction | mimo-v2-flash | 1 | 800 | 190 | $0.0001 |
| RAG Q&A (thinking ON) | grok-4.1 | 5 | 8,375 | 2,650 + ~1,500 thinking | $0.005 |
| Question refresh | mimo-v2-flash | 3 | 4,290 | 660 | $0.001 |
| **Daily total** | | | **228,815** | **~68,500** | **$0.063** |
| **Monthly total** | | | | | **~$1.89** |

### Summary

| Metric | Groq free (current) | Groq paid | Proposed split |
|---|---|---|---|
| Monthly cost | $0 | ~$5.64 | **~$1.89** |
| TPD cap | 100K (throttles daily) | None | **None** |
| Items processed/day | ~35–45 | All ~97 | **All ~97** |
| Article quality (Arena) | ~1,250 | ~1,250 | **1,472** |
| Question quality (Arena) | ~1,250 | ~1,250 | 1,392 |
| Q&A quality (Arena) | ~1,250 | ~1,250 | **1,472 + reasoning** |
| **Cost vs Groq paid** | — | baseline | **67% cheaper** |

---

## Thinking Token Deep Dive

grok-4.1-thinking's `reasoning` parameter is a per-call toggle:

```json
// Article summary — thinking OFF (writing task, not reasoning)
{
  "model": "grok-4.1-thinking",
  "reasoning": { "enabled": false },
  "max_tokens": 900
}

// RAG Q&A — thinking ON (synthesize multi-source context)
{
  "model": "grok-4.1-thinking",
  "reasoning": { "enabled": true },
  "max_tokens": 1024
}
```

**When thinking adds cost:** Thinking tokens are generated internally and billed at output token rates. A typical thinking pass adds ~500–1,500 tokens on top of the normal output. At $0.50/1M, this adds ~$0.00075 per Q&A session — negligible.

**When thinking hurts:** For structured format tasks (article summary, tweet summary), thinking mode tries to "reason" about the optimal output format — adding latency without improving quality. Always disable for tasks with rigid output schemas.

---

## MiMo Verbosity: Practical Adjustment

MiMo-V2-Flash generates 5–6× more output tokens than average models during evaluation. In practice, `max_tokens` caps prevent runaway costs — but the cap should be set intentionally:

| Task | Current max_tokens | Recommended with MiMo | Reason |
|---|---|---|---|
| EN questions | 300 | 300 | 3 questions × ~25 words = ~75 words = ~100 tokens. Cap is fine. |
| ZH questions | 300 | 300 | Same. Chinese questions are shorter. |
| Tweet summary | 900 | 400 | Tweet is 280 chars. 900-token cap allows bloated output. 400 = 3 tight bullets. |
| Bio extraction | 600 | 300 | 25 handles × ~20 char role = 500 chars max. 300 tokens is sufficient. |
| Question refresh | 300 | 300 | Same as initial generation. |

---

## Alternative: grok-4.1-thinking for Everything

Instead of a two-model split, use grok-4.1-thinking for all tasks with thinking toggled off for light work:

| Metric | Two-model split | grok-4.1 only |
|---|---|---|
| Monthly cost | ~$1.89 | ~$2.80 |
| API keys | 2 (XAI + Xiaomi) | 1 (XAI) |
| Code changes | 5 files, 2 different endpoints | 5 files, 1 endpoint |
| Question quality | 1,392 (MiMo) | 1,472 (grok-4.1) |
| Complexity | Moderate | Low |

**When to choose this:** If MiMo's API reliability is unknown, or the added complexity of managing two providers isn't worth $0.91/month. The Arena score gap between 1,472 and 1,392 is real but minor for question generation.

---

## What Changes in the Codebase (when implemented)

| File | Change |
|---|---|
| `supabase/functions/process-queue/index.ts` | Article + tweet summary calls → grok-4.1 (xAI endpoint, thinking off); EN+ZH question calls → MiMo (Xiaomi endpoint) |
| `workers/ingest-builders/src/index.ts` | Bio extraction call → MiMo |
| `supabase/functions/answer-question/index.ts` | RAG answer → grok-4.1 (thinking on); Cohere embed unchanged |
| `supabase/functions/refresh-questions/index.ts` | Question regen calls → MiMo |
| `docs/api-keys-and-env.md` | Add XAI_API_KEY and MIMO_API_KEY rows; remove or keep GROQ_API_KEY |

### New secrets required

```bash
# Cloudflare Worker (ingest-builders)
wrangler secret put MIMO_API_KEY --name ingest-builders

# Supabase Edge Functions (process-queue, answer-question, refresh-questions)
supabase secrets set XAI_API_KEY=xai_xxxx --project-ref <ref>
supabase secrets set MIMO_API_KEY=xxxx --project-ref <ref>

# GROQ_API_KEY can be removed from all functions after migration
```

### API endpoint changes

```typescript
// Current (Groq)
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

// grok-4.1-thinking (xAI — OpenAI-compatible)
const XAI_URL = 'https://api.x.ai/v1/chat/completions'

// MiMo-V2-Flash (Xiaomi or OpenRouter)
const MIMO_URL = 'https://api.mimo.ai/v1/chat/completions'  // verify at implementation time
// or via OpenRouter: 'https://openrouter.ai/api/v1/chat/completions'
// model: 'xiaomi/mimo-v2-flash'
```

⚠️ **Verify MiMo endpoint before implementation.** Xiaomi's API may require a separate signup; OpenRouter is the safer fallback as it aggregates both models under one key.

---

## Decision: Not Yet Made

This document is a planning reference. The model switch has not been implemented. Decision factors before committing:

1. **MiMo API availability** — confirm Xiaomi API or OpenRouter has stable mimo-v2-flash access
2. **grok-4.1-thinking reasoning toggle** — confirm the `reasoning.enabled` parameter works as documented before relying on it
3. **Groq free tier deprecation** — if Groq stays free, the urgency decreases (though quality argument remains)
4. **Post-Stage 4.5 TPD pressure** — adding 90 Apify tweets/day makes the free-tier TPD ceiling hit even faster; may force the migration

See `docs/token.md` for full token cost calculations underpinning this analysis.
