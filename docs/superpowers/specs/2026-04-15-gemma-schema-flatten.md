# Follow-up Spec: Flatten summary_en/summary_zh Schema (Option B)

**Date:** 2026-04-15
**Status:** Design only — no implementation
**Parent spec:** `2026-04-15-gemma-multi-model-design.md`

---

## What Failed and Why

After deploying the Gemma adapter, all articles returned:

```
AI Studio 400 — failing row. Body: {
  "error": {
    "code": 400,
    "message": "* GenerateContentRequest.generation_config.response_schema.properties[summary_zh].items: missing field.\n
                * GenerateContentRequest.generation_config.response_schema.properties[summary_en].items: missing field.\n",
    "status": "INVALID_ARGUMENT"
  }
}
```

**Root cause:** The Gemini API schema validator requires `items` to be defined on every `array`-typed property. `summary_en` and `summary_zh` were declared as `{ type: 'array' }` with no `items`. The validator rejects the entire request before the model runs — no inference occurs. This explains 100% failure rate independent of article content.

---

## Why Option B (Flatten) Over Option A (Fix Items)

**Option A** would add `items: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } } }` to both fields.

Three reasons to prefer flattening instead:

**1. The nested array structure is destroyed immediately by `normalizeGemmaResponse`.**

The intermediate `[{label, text}, {label, text}, {label, text}]` shape is converted back to a pre-formatted string before any downstream consumer sees it:

```
summary_en[0] → "• **[The Move]:** " + text
summary_en[1] → "• **[The Number That Matters]:** " + text
summary_en[2] → "• **[Who Gets Hurt or Wins]:** " + text
```

The structured array adds schema complexity, model output complexity, and a normalization step — and is eliminated before any consumer benefits from it. The complexity exists only as scaffolding inside the LLM call.

**2. Option A introduces a secondary type-casing risk.**

The Gemini API's `SchemaType` enum uses uppercase values (`OBJECT`, `STRING`, `ARRAY`). The current implementation uses lowercase throughout. The 400 validator stopped at the missing `items` field — it may or may not have continued to check type casing. Adding `{ type: 'object' }` inside `items` risks unblocking the first error and surfacing a second 400 on the same request with no change to the actual logic.

**3. The parent spec's own escape hatch anticipated this.**

The spec explicitly noted: *"If content quality degrades (model satisfying schema at the expense of content depth), remove the nested `summary_en`/`summary_zh` array schema and keep only the flat top-level key constraints."* The Gemini validator is stricter than anticipated — using the escape hatch now is the architecturally honest response.

**Precedent from the working fields:** `questions_en` and `questions_zh` are also arrays but have `items: { type: 'string' }` and did not trigger an error. This confirms the validator accepts string-array schemas. It does not confirm it accepts nested object schemas — that's the untested risk in Option A.

---

## Changes Required

Exactly two changes. Nothing else.

### Change 1 — `responseSchema` in `buildAIStudioSummaryRequest`

**Current:**
```typescript
summary_en: { type: 'array' },
summary_zh: { type: 'array' },
```

**After:**
```typescript
summary_en: { type: 'string' },
summary_zh: { type: 'string' },
```

The six top-level keys are preserved. `questions_en` and `questions_zh` remain `{ type: 'array', items: { type: 'string' } }` — unchanged. `sentinel` remains `{ type: 'string' }` — unchanged.

### Change 2 — Prompt field description in `ARTICLE_SYSTEM_PROMPT_GEMMA` and `TWEET_SYSTEM_PROMPT_GEMMA`

The `summary_en` and `summary_zh` fields in the JSON schema example within the prompt currently show array-of-object format:

```
"summary_en": [
  { "label": "The Move", "text": "2 sentences exactly. ..." },
  ...
]
```

After this change they become pre-formatted strings. The prompt's JSON schema example becomes:

```
"summary_en": "• **[The Move]:** 2 sentences exactly. Name the specific company or person, what they did, and the exact figure or date involved.\n• **[The Number That Matters]:** 2 sentences exactly. The single most specific metric...\n• **[Who Gets Hurt or Wins]:** 2 sentences exactly. Name the specific companies...",
"summary_zh": "• **[这一动作]:** 恰好2句话。点名具体公司或人物、做了什么、涉及的精确数字或日期。\n• **[关键数字]:** 恰好2句话。...\n• **[谁输谁赢]:** 恰好2句话。..."
```

The model is now instructed to produce the `• **[Label]:** text` format directly rather than an intermediate array. The instruction becomes: *"Each summary field is a plain string containing exactly 3 bullets separated by newlines, each formatted as `• **[Label]:** text`."*

The tweet prompt's `summary_en`/`summary_zh` follows the same change with its own labels (`The Claim`, `The Context`, `The Reaction or Gap` / `核心主张`, `背景`, `争议或空白`).

### Change 3 — `normalizeGemmaResponse` simplification

The normalization function currently converts the array into a string via `formatBullets`. After this change, the model outputs the pre-formatted string directly. The `formatBullets` helper is no longer needed. `normalizeGemmaResponse` reads `summary_en` and `summary_zh` directly as strings:

```typescript
summary_en: String(parsed.summary_en ?? ''),
summary_zh: String(parsed.summary_zh ?? ''),
```

`formatBullets` can be deleted. All other normalization logic (title, questions, sentinel) is unchanged.

---

## What Does NOT Change

- The six top-level key names: `title_en`, `title_zh`, `summary_en`, `summary_zh`, `questions_en`, `questions_zh`, `sentinel`
- `responseMimeType: 'application/json'` — still enforced
- `questions_en`/`questions_zh` schema — already working, untouched
- All content quality rules: banned words, bilingual rules, sentence count requirements, question rules, sentinel conditions
- `callLLM` fallback logic — unchanged
- `parseAIStudioResponse` envelope extractor — unchanged
- Groq flat-text path — unchanged
- All other workers and edge functions — unchanged

---

## Verification Plan

1. **Schema rejection gone:** Send a minimal request with the updated `responseSchema`. Confirm 200 response — no 400.

2. **Bullet format correct:** Run the `swyx` tweet and the `simonw` tweet that previously failed. Confirm `summary_en` in the response is a pre-formatted bullet string, not an array, not prose.

3. **Normalization round-trip:** Pass the Gemma response through the updated `normalizeGemmaResponse`. Confirm the bullet string passes through unchanged and renders correctly in the frontend `MarkdownText` component.

4. **Sentinel still fires:** Send a paywall stub (under 200 words). Confirm `{ "sentinel": "INSUFFICIENT_CONTENT" }` is returned and the normalization branch handles it correctly.

5. **Groq fallback unaffected:** Temporarily force AI Studio to 429. Confirm Groq flat-text path produces the same normalized output shape.

---

## Risk

Low. The only behavioral change is that the model outputs pre-formatted bullet strings instead of `[{label, text}]` arrays. The output the frontend consumes is identical — the `MarkdownText` component receives `• **[The Move]:** ...` strings in both cases. The normalization layer is simpler, not different.

The one new failure mode to watch: if the model omits the `• **[` prefix on a bullet, the frontend renders it as plain text without bold formatting. This would be visible but not silent — worth checking in the manual prompt regression test (step 2 above).
