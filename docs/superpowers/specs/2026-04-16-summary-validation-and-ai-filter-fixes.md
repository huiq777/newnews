# Design Spec: Summary Validation Boundary + AI Filter Tightening

**Date:** 2026-04-16  
**Status:** Ready for implementation  
**File affected:** `workers/process-queue/src/index.ts`

---

## Context

Two related quality defects in the `process-queue` pipeline:

1. **Missing summaries** — Articles reach `daily_news` with `title_en`/`title_zh` populated but `summary_en`/`summary_zh` empty. The pipeline currently writes empty strings without validation. The root cause is a combination of: Gemma returning `""` for summary fields when the JSON schema has no `minLength` constraint, and the Groq fallback regex silently returning `''` on parse failure. Both paths allow a partial result to pass through as if it were a complete one.

2. **AI filter leaking non-AI articles** — Articles like "Trump posts AI-generated Jesus image" and "Gemini adds NEET exam questions" are passing the `NOT_AI_RELEVANT` filter and entering `daily_news`. The LLM is interpreting the presence of an AI product name as sufficient to qualify — but the current prompt definition does not distinguish between *an AI company as the story subject* and *an AI tool mentioned in an otherwise non-AI story*. These false positives waste ~2,510 tokens each and degrade RAG retrieval quality by injecting noise embeddings.

---

## Fix 1: Strict Validation Boundary for Empty Summaries

### Decision

Add a validation throw after the LLM result is parsed, before `insertAndMarkDone()`. If `summary_en` or `summary_zh` is empty on a non-sentinel result, throw an error. This routes the article through the existing `catch` block → `status='error'` with a descriptive `last_error` message. Zero additional tokens. Zero wall-clock risk.

**Why not retry:** A retry appended after a slow Gemma response (~18s) + Groq fallback (~10s) approaches the 30s Cloudflare wall-clock limit and risks orphaning the `processing` row. More fundamentally: an empty summary from a structurally valid JSON response is a **prompt quality signal**, not a transient failure. Retrying silently swallows that signal and pays an "ignorance tax" of ~1,200 tokens each time.

### Change 1a — Validation throw in `processArticle()`

**Location:** `workers/process-queue/src/index.ts`, after line 693 (after both sentinel checks), before line 695.

Add:
```typescript
if (!result.summary_en || !result.summary_zh) {
  throw new Error(`Validation Error: Empty summary field — summary_en="${result.summary_en}" summary_zh="${result.summary_zh}"`)
}
```

This relies on the existing catch block (lines 703–722) to write `status='error'` and `last_error` with the message. After 3 retries it becomes permanent `error`. Surfacing in logs is the signal to fix the prompt.

### Change 1b — Prompt instruction: summaries must not be empty

The Gemma JSON schema (`buildAIStudioSummaryRequest`, lines 278–290) specifies `{ type: 'string' }` for `summary_en`/`summary_zh` with no minimum length. Google AI Studio's JSON schema does not reliably enforce `minLength`, so the enforcement must come from the prompt text.

**In `ARTICLE_SYSTEM_PROMPT_GEMMA` and `TWEET_SYSTEM_PROMPT_GEMMA`**, add to the SENTINEL DEFINITIONS section (immediately before the `INSUFFICIENT_CONTENT` definition in each):

```
CRITICAL: summary_en and summary_zh MUST be non-empty strings. If the article has insufficient content to generate a meaningful summary, output the INSUFFICIENT_CONTENT sentinel — do NOT output an empty summary_en or summary_zh. An empty summary field is never a valid response.
```

**In `ARTICLE_SYSTEM_PROMPT` and `TWEET_SYSTEM_PROMPT`** (Groq fallback), add the same instruction above the SENTINEL VALUES block.

### What this does not fix

The Groq fallback `parseSection()` regex can also return `''` if the multiline SUMMARY block doesn't match. The validation throw will catch this too — any empty summary from either path triggers the error. The regex itself does not need to change.

---

## Fix 2: AI Filter — NOT_AI_RELEVANT Prompt Tightening

### Decision

Rewrite the `NOT_AI_RELEVANT` sentinel definition in all four prompt variants (article + tweet × Groq + Gemma) to add:

1. **A discriminating test** that distinguishes AI-as-subject from AI-as-tool
2. **Explicit negative examples** (the failure modes we've observed)
3. **Explicit positive examples** that preserve high-value borderline cases

### The discriminating test

Current definition relies on "primary subject" which is ambiguous for AI product feature stories. Replace with a concrete substitution test:

> **Substitution test:** Would this story still be newsworthy if the AI product were replaced with any other software tool? If yes → NOT_AI_RELEVANT. If no (the AI nature of the product is what makes it news) → output the summary.

### Replacement definition for `NOT_AI_RELEVANT` — all four prompt variants

Replace the existing `NOT_AI_RELEVANT` block in each prompt with:

```
NOT_AI_RELEVANT
— Use when: the story's news value does not depend on AI. Apply the substitution test: if you replaced the AI product with any other software tool and the story would be equally newsworthy, it is NOT_AI_RELEVANT.
— AI-relevant means: AI model releases, AI company strategy (funding, leadership, M&A), AI research (papers, benchmarks, evals, capabilities), AI regulation/policy whose primary scope is AI, AI safety incidents.
— NOT AI-relevant examples:
  • "Trump posts AI-generated image on Truth Social" → NOT_AI_RELEVANT (Trump's social media behavior; AI is an adjective on the image, not the subject)
  • "Gemini adds NEET exam question bank for Indian students" → NOT_AI_RELEVANT (a product feature launch for an education use case; substitute "Google Search" and the story is identical)
  • "Apple includes AI writing tools in iOS 19" → NOT_AI_RELEVANT (iOS release; the AI feature is incidental to the hardware/OS story)
  • General earnings reports that mention AI revenue as one line item → NOT_AI_RELEVANT
— AI-relevant examples (DO NOT filter these):
  • "Anthropic拒绝8000亿美元估值融资，维持独立掌控权" → RELEVANT (AI company strategy and power dynamics)
  • "Accel筹集50亿美元资金，重点布局后期AI软件与机器人领域" → RELEVANT (VC thesis on AI ecosystem)
  • "Peter Thiel投资的Objection推出AI新闻审判工具" → RELEVANT (AI product launch where AI capability is the product)
  • "Google 推出Gemini 4.0" → RELEVANT (AI model release)
— WHY: Non-AI articles waste pipeline budget (tokens, embedding, storage) and degrade RAG retrieval by injecting noise embeddings that pull wrong articles on every Q&A query.
— FAILURE MODE: Outputting NOT_AI_RELEVANT for Chinese AI lab articles when uncertain. When the primary subject is an AI company or model, output the summary.
```

For the `TWEET_SYSTEM_PROMPT` / `TWEET_SYSTEM_PROMPT_GEMMA` variants, prepend tweet-specific negative examples:

```
  • "@joshwoodward: Gemini adds NEET exam questions" → NOT_AI_RELEVANT (product feature tweet for education market; Gemini here is a delivery vehicle, not the subject)
  • "@realDonaldTrump: posts AI-generated Jesus image" → NOT_AI_RELEVANT (political figure's social media content)
```

### Token cost impact

Each correctly filtered article that previously generated a full summary (~2,510 tokens) now returns a `NOT_AI_RELEVANT` sentinel (~300–500 tokens). Net saving: ~2,000 tokens per corrected false positive. If 10 articles/day were false positives: ~20,000 tokens/day recovered against the 267K/day demand. The RAG quality improvement (fewer noise embeddings) is the compounding benefit.

---

## Files Changed

| File | Lines affected | Change |
|------|---------------|--------|
| `workers/process-queue/src/index.ts` | 56–62 | Replace NOT_AI_RELEVANT block in ARTICLE_SYSTEM_PROMPT |
| `workers/process-queue/src/index.ts` | 118–120 | Replace NOT_AI_RELEVANT block in TWEET_SYSTEM_PROMPT |
| `workers/process-queue/src/index.ts` | 184–186 | Replace NOT_AI_RELEVANT block in ARTICLE_SYSTEM_PROMPT_GEMMA |
| `workers/process-queue/src/index.ts` | 230–232 | Replace NOT_AI_RELEVANT block in TWEET_SYSTEM_PROMPT_GEMMA |
| `workers/process-queue/src/index.ts` | ~134, ~192 | Add CRITICAL summary non-empty instruction to Gemma prompts |
| `workers/process-queue/src/index.ts` | ~49, ~111 | Add CRITICAL summary non-empty instruction to Groq prompts |
| `workers/process-queue/src/index.ts` | after line 693 | Add validation throw for empty summary_en / summary_zh |

---

## Verification

1. **Validation throw:** Find rows in `raw_ingestion` with `status='error'` and `last_error LIKE '%Validation Error: Empty summary%'`. Presence = the guard is firing. Absence of `daily_news` rows with empty `summary_en` = the guard is preventing write-through.

2. **AI filter:** Query `raw_ingestion` for `status='error'` and `last_error='NOT_AI_RELEVANT'`. Review a sample of 20 URLs to confirm they are correctly filtered. Check that none of the user's positive examples (Anthropic funding, Gemini 4.0 launch) are appearing in the filtered set.

3. **Regression check:** Verify `daily_news` row count per day does not drop by more than 30% — a larger drop suggests the filter is over-triggering on legitimate AI content.

4. **Wrangler test:**
```bash
wrangler dev --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
Run twice. Confirm idempotency (row count unchanged on second run).
