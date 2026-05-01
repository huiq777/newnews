# Design Spec: Gemma Multi-Model Pipeline

**Date:** 2026-04-15
**Status:** Design only — no implementation
**Author:** Architect role

---

## Context

The pipeline currently runs all LLM tasks on a single provider and model: Groq `llama-3.3-70b-versatile`. Two structural problems motivate this change:

1. **TPD pressure.** Groq's 100K token/day free cap is consistently at 267% demand. The pipeline self-throttles via `retry_count`, but this means ~67% of articles queue to the next UTC day. Offloading batch summarization to a second provider directly expands effective daily throughput.

2. **Quality improvement.** Gemma 4 31B (Google AI Studio) is a meaningfully stronger model for bilingual summarization. Initial testing confirmed it follows the structured format correctly — the problem was the model generating inline reasoning prose alongside the output, not output quality per se.

**This spec designs the routing architecture and prompt format strategy. It does not implement any code.**

---

## The Thinking-Prose Problem — Root Cause

When Gemma 4 31B was tested against the current flat-text prompt (`TITLE_EN: ... TITLE_ZH: ... SUMMARY_EN: ...`), the model produced correct structured output but also narrated its verification process as text — checking its own rule compliance, revising questions, re-running through the banned-word list. This is not API-level "thinking tokens" — it is the model treating the rich rule set in the system prompt as an invitation to self-audit visibly.

**Example:** The model output included passages like:
```
*Wait*, I used "How do..." in QUESTIONS_EN. "No question starting with 'How does.'"
*Check*: "How do the productivity growth figures..." starts with "How do", not "How does".
*Revised EN Questions*: ...
```

The correct structured output appeared at the end of this prose — but the current flat-text parser fails because it sees the thinking text before finding `TITLE_EN:`.

**Why `thinking_budget: 0` does not fix this.** The Google AI Studio `thinking_budget` parameter controls a separate thinking mode (like Gemini's extended reasoning). Gemma 4's inline prose is standard text output, not a reasoning mode — it cannot be suppressed via that parameter.

**The actual fix:** Set `responseMimeType: "application/json"` in Google AI Studio's `generationConfig`. This is enforced at the API level — the model is constrained to emit valid JSON only. There is no schema slot for reasoning prose, so the model cannot self-narrate. This is a structural constraint, not a prompt instruction. A JSON output prompt also needs to be paired with explicit instruction: `"Respond with valid JSON only. No verification. No commentary. No reasoning."` as belt-and-suspenders.

---

## Architecture: Provider Adapter Pattern

The pipeline currently makes raw `fetch()` calls to `https://api.groq.com/openai/v1/chat/completions`. The proposed change introduces a thin routing layer:

```
Worker / Edge Function
    │
    └─ callLLM(task: TaskType, content: string, env: Env)
            │                   ↑
            │         NO prompt param — each provider builds
            │         its own prompt internally for the given task
            │
            ├─ TASK: bilingual_summary, question_refresh
            │       └─ PRIMARY:  Google AI Studio Gemma 4 31B
            │                    → buildAIStudioRequest(task, content)
            │                      (constructs JSON prompt variant internally)
            │                    → parseGemmaResponse(json)
            │                    → normalizeGemmaResponse(parsed)
            │          FALLBACK: Groq llama-3.3-70b (fast failures only — see below)
            │                    → buildGroqRequest(task, content)
            │                      (constructs flat-text prompt variant internally)
            │                    → parseGroqFlatTextResponse(text)
            │
            ├─ TASK: simple_extraction (bio)
            │       └─ PRIMARY:  Google AI Studio Gemma 3 12B
            │          FALLBACK: Groq llama-3.3-70b
            │
            └─ TASK: streaming_rag, streaming_brief
                    └─ Groq llama-3.3-70b only (SSE streaming format, no AI Studio)
```

`callLLM` is the only function that knows which provider handles which task and which prompt format each provider receives. Everything above it only knows task types and content — not provider details, not prompt formats.

**Why `prompt` is not a parameter:** If a single prompt string were threaded through the interface, a fallback from AI Studio to Groq would pass the JSON-format Gemma prompt to Groq's flat-text parser. Groq would output JSON, the flat-text parser would fail to find `TITLE_EN:`, and every fallback invocation would silently error. Decoupling prompt construction inside each provider's builder function eliminates this class of bug entirely.

**Key design rule:** The fallback is triggered only on fast failures (HTTP 429 or immediate TCP/connection rejection) — not on timeouts or 5xx responses.

---

## Google AI Studio API Format

Google AI Studio uses a different API surface from Groq's OpenAI-compatible endpoint:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}

{
  "systemInstruction": {
    "parts": [{ "text": "<system prompt>" }]
  },
  "contents": [
    { "role": "user", "parts": [{ "text": "<user message>" }] }
  ],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "object",
      "properties": {
        "title_en":    { "type": "string" },
        "title_zh":    { "type": "string" },
        "summary_en":  {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": { "type": "string" },
              "text":  { "type": "string" }
            }
          }
        },
        "summary_zh":  {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": { "type": "string" },
              "text":  { "type": "string" }
            }
          }
        },
        "questions_en": { "type": "array", "items": { "type": "string" } },
        "questions_zh": { "type": "array", "items": { "type": "string" } },
        "sentinel":     { "type": "string" }
      }
    },
    "temperature": 0.3
  }
}
```

Auth is via query param (`?key=`), not `Authorization: Bearer` header. This is the critical difference from Groq. The `GOOGLE_AI_STUDIO_API_KEY` secret is passed as a query parameter, not a header.

Response shape:
```json
{
  "candidates": [{
    "content": {
      "parts": [{ "text": "{ ...json... }" }]
    }
  }]
}
```

Extract: `response.candidates[0].content.parts[0].text` → parse as JSON.

**Why `responseSchema` in addition to `responseMimeType`:** `responseMimeType: "application/json"` forces the model to emit valid JSON but does not constrain which keys it emits. Without `responseSchema`, the model may hallucinate arbitrary key names (`headline_en` instead of `title_en`). The schema adds a second structural constraint at the API level — key names are enforced by the provider, not just by prompt instruction. This is additive: both constraints are needed. `responseMimeType` eliminates reasoning prose; `responseSchema` eliminates key hallucination.

**Note on `responseSchema` and complex schemas:** Google AI Studio's schema support has known limitations with deeply nested structures. If content quality degrades (model satisfying schema at the expense of content depth), remove the nested `summary_en`/`summary_zh` array schema and keep only the flat top-level key constraints. The `sentinel` field is intentionally included so the model can emit `{ "sentinel": "INSUFFICIENT_CONTENT" }` as a valid response without triggering a schema validation failure.

**Model IDs on AI Studio (confirmed):**
- Gemma 4 31B: `gemma-4-31b-it`
- Gemma 3 12B: `gemma-3-12b-it`
- Gemma 3 27B: `gemma-3-27b-it`

---

## JSON Output Schema for Gemma Path

The current flat-text format (`TITLE_EN: ...`, `SUMMARY_EN:• **[The Move]:** ...`) works well for Groq llama but creates ambiguity for Gemma. The Gemma path uses a JSON-first schema. The `responseMimeType: "application/json"` API constraint enforces this at the protocol level.

### Article/Tweet Summarization Schema

```json
{
  "title_en": "string — actor + action + specific number/outcome",
  "title_zh": "string — 主体 + 行动 + 关键数字/结果",
  "summary_en": [
    { "label": "The Move", "text": "2 sentences exactly." },
    { "label": "The Number That Matters", "text": "2 sentences exactly." },
    { "label": "Who Gets Hurt or Wins", "text": "2 sentences exactly." }
  ],
  "summary_zh": [
    { "label": "这一动作", "text": "恰好2句话。" },
    { "label": "关键数字", "text": "恰好2句话。" },
    { "label": "谁输谁赢", "text": "恰好2句话。" }
  ],
  "questions_en": ["string", "string", "string"],
  "questions_zh": ["string", "string", "string"]
}
```

For sentinel values (insufficient content, not AI-relevant):
```json
{ "sentinel": "INSUFFICIENT_CONTENT" }
{ "sentinel": "NOT_AI_RELEVANT" }
```

### Bio Extraction Schema (simple, Gemma 3 12B)

```json
{
  "bios": {
    "@handle": "one-sentence role description",
    "@handle2": "..."
  }
}
```

This replaces the current Groq bio extraction call in `ingest-builders` which already produces a similar structure.

### Response Normalization

A `normalizeGemmaResponse(json)` function converts the Gemma JSON schema into the same internal structure currently produced by the Groq flat-text parser. For summary bullets, it reconstructs the `• **[Label]:** text` format that `MarkdownText` renders:

```
summary_en[0] → "• **[The Move]:** " + text
summary_en[1] → "• **[The Number That Matters]:** " + text
summary_en[2] → "• **[Who Gets Hurt or Wins]:** " + text
```

The rest of the worker logic is unchanged — it receives the same normalized structure regardless of which provider processed the request.

---

## Prompt Redesign for Gemma Path

The current `ARTICLE_SYSTEM_PROMPT` and `TWEET_SYSTEM_PROMPT` are tuned for Groq llama and should be kept as-is for the Groq fallback path. The Gemma path requires a parallel variant.

**Changes from current to Gemma-JSON variant:**

1. **Output format changed from flat-text to JSON.** The instructions describe the JSON schema instead of the `TITLE_EN: ...` section format. Example rule replacement:
   - Current: `"Output EXACTLY this structure — no deviations, no extra text: TITLE_EN: [...]"`
   - Gemma: `"Respond with a single valid JSON object matching this schema exactly. No text before or after the JSON."`

2. **Anti-reasoning instruction added.** First line of system prompt:
   ```
   Respond with valid JSON only. No reasoning. No verification. No self-correction.
   Output the JSON object once, directly. Do not narrate your process.
   ```

3. **Sentinel encoding changed.** Instead of outputting the string `INSUFFICIENT_CONTENT`, the model outputs `{ "sentinel": "INSUFFICIENT_CONTENT" }`.

4. **All other rules preserved.** Banned words, bilingual rules, bullet content requirements, question rules — identical to the current prompts. The content expectations are unchanged; only the output encoding differs.

**What does NOT change:** The `BILINGUAL RULES` block, banned word lists, sentence count requirements, example good/bad titles, and sentinel conditions. These are content quality rules, not format rules — they apply regardless of output encoding.

---

## Task Routing Table

| Task | Worker / Function | Primary Model | Provider | Fallback |
|---|---|---|---|---|
| Article bilingual summary | `process-queue` | Gemma 4 31B | Google AI Studio | Groq llama-3.3-70b |
| Tweet bilingual summary | `process-queue` | Gemma 4 31B | Google AI Studio | Groq llama-3.3-70b |
| Bio extraction | `ingest-builders` | Gemma 3 12B | Google AI Studio | Groq llama-3.3-70b |
| Question refresh (single combined call) | `refresh-questions` | Gemma 3 27B | Google AI Studio | Groq llama-3.3-70b |
| RAG Q&A streaming | `answer-question` | llama-3.3-70b | Groq | None (streaming) |
| Trend brief streaming | `generate-trend-brief` | llama-3.3-70b | Groq | None (streaming) |

Streaming tasks are Groq-only because Google AI Studio's streaming format (`application/x-ndjson`) differs from Groq's OpenAI-compatible SSE. Rewriting the streaming layer is a separate project — out of scope here.

---

## Fallback Chain Design

### Fast-Fail vs Slow-Fail: The Critical Distinction

Cloudflare Workers have a 30-second wall-clock limit. Sequential LLM calls across two providers are dangerous if the first call hangs. If AI Studio takes 15 seconds to time out, a subsequent Groq call (10-15 seconds) will exceed the wall-clock budget — killing the Worker mid-execution and orphaning rows in `processing` status. This is the active high-severity risk in the risk register.

**Rule: Only fast failures trigger fallback. Slow failures fail immediately.**

- **Fast failure** = HTTP 429 (received instantly) or TCP connection rejection (received instantly). Trigger fallback.
- **Slow failure** = timeout, 5xx after a delay. Do NOT trigger fallback. Fail the row immediately (`status='error'`). The queue retries it on the next cron pass.

### AbortController Timeout

An explicit timeout must be set on the AI Studio call — do not rely on the provider's own network timeout, which can be 20-30 seconds under load. The recommended value is **8 seconds**. This leaves ~20 seconds for the Groq fallback (fast-failure case) or immediate fail (slow-failure case) within the 30-second wall-clock budget.

```
AbortController timeout: 8s on AI Studio call
Rationale: 30s wall-clock − 8s AI Studio timeout − ~10s Groq call = 12s safety margin
```

### Fallback Logic in `callLLM`

```
1. Create AbortController with 8s timeout
   Call Google AI Studio (primary)

   - 200 → parse Gemma JSON response → normalize → return
   - 429 (immediate) → log "AI Studio 429, falling back to Groq" → proceed to step 2
   - TCP rejection (immediate) → log "AI Studio unreachable, falling back to Groq" → step 2
   - AbortController fires (8s elapsed) → log "AI Studio timeout, failing row" → throw
   - 5xx → log "AI Studio error, failing row" → throw
   - JSON parse failure → log error → throw (do NOT silently fallback)

2. Call Groq llama-3.3-70b (fallback — fast failures only)
   - 200 → parse flat-text response (existing parser) → return
   - 429 → row stays in `error` status with last_error "Groq 429: ..." (existing behavior)
   - Parse failure → throw
```

**Why JSON parse failure doesn't trigger fallback:** A malformed JSON response from Gemma means the model misunderstood the prompt. This is a prompt quality signal that needs investigation, not silent retry. Swallowing parse failures would hide prompt regressions.

**What changes in `raw_ingestion` error tracking:**
- AI Studio 429 → Groq succeeds: row processes normally, no error recorded
- AI Studio 429 → Groq 429: `status='error'`, `last_error='Groq 429: ...'` (same as today, existing recovery SQL applies)
- AI Studio timeout or 5xx: `status='error'`, `last_error='AI Studio timeout'` or `'AI Studio 5xx'`. These rows are retried on the next cron pass automatically — no recovery SQL needed.

---

## Subrequest Accounting

Per the architect constraints, every `fetch()` call added to a Worker requires an explicit subrequest count. The fallback path doubles the subrequest cost for affected calls.

### `process-queue`

| Scenario | Subrequests/invocation |
|---|---|
| Normal (5 articles, all AI Studio) | 5 (AI Studio) + 2 (Supabase fetch + write) = **7/50** |
| Full fallback (5 articles, all Groq) | 5 (AI Studio attempt) + 5 (Groq fallback) + 2 (Supabase) = **12/50** |

`process-queue` has substantial headroom in both scenarios. Not a constraint.

### `ingest-builders`

Current baseline: ~38/50 subrequests (tweets + podcasts fetch + bio Groq call + Supabase writes).

| Scenario | Subrequests/invocation |
|---|---|
| Normal (bio → AI Studio only) | 38 base − 1 (old Groq bio) + 1 (AI Studio bio) = **38/50** |
| Fallback (bio → AI Studio + Groq) | 38 base − 1 + 1 (AI Studio) + 1 (Groq) = **39/50** |

Worst-case fallback: **39/50**. 11 subrequests remaining. This is the tightest ceiling in the project. Any new data source added to `ingest-builders` must be audited against this 39/50 baseline, not the original 38/50.

**Red line:** Do not add more than 10 additional `fetch()` calls to `ingest-builders` without upgrading to Cloudflare Workers paid ($5/mo, 1,000 subrequests).

New secret required: `GOOGLE_AI_STUDIO_API_KEY`

| Worker / Function | New Secrets Needed | Existing Secrets Unchanged |
|---|---|---|
| `process-queue` | `GOOGLE_AI_STUDIO_API_KEY` | `GROQ_API_KEY`, `SUPABASE_*` |
| `ingest-builders` | `GOOGLE_AI_STUDIO_API_KEY` | `GROQ_API_KEY`, `SUPABASE_*` |
| `refresh-questions` (Edge Fn) | `GOOGLE_AI_STUDIO_API_KEY` | `GROQ_API_KEY`, `SUPABASE_*`, `COHERE_API_KEY` |
| `answer-question` (Edge Fn) | None | Unchanged |
| `generate-trend-brief` (Edge Fn) | None | Unchanged |

Set per worker via `wrangler secret put GOOGLE_AI_STUDIO_API_KEY` (same pattern as existing secrets). Set for Edge Functions via `supabase secrets set GOOGLE_AI_STUDIO_API_KEY=...`.

---

## Google AI Studio Rate Limits

These are free-tier limits as of April 2025. Verify before implementation — Google adjusts these.

| Model | Requests/min (RPM) | Tokens/min (TPM) | Tokens/day (TPD) |
|---|---|---|---|
| Gemma 4 31B (`gemma-4-31b-it`) | 30 RPM | 16K TPM | 14,400 RPD |
| Gemma 3 27B (`gemma-3-27b-it`) | 30 RPM | 15K TPM | 14,400 RPD |
| Gemma 3 12B (`gemma-3-12b-it`) | 30 RPM | 15K TPM | 14,400 RPD |

**RPD = Requests Per Day** (not tokens/day). At 14,400 RPD and a `process-queue` batch of 5 articles every 15 minutes, the pipeline issues at most 5 × 4 × 24 = 480 requests/day to AI Studio — well within the 14,400 RPD limit.

**TPM comparison:** Gemma 4 31B's 16K TPM is slightly above Groq's 12K TPM. At 5 articles × ~2,510 tokens = ~12,550 tokens/run, the batch fits within a single minute on both providers.

**Key comparison vs Groq:** Groq's binding constraint is TPD (100K tokens/day). AI Studio's binding constraint is RPD (14,400 requests/day). These are different axes — AI Studio is effectively unconstrained for token volume on this workload.

---

## Token Economy Impact

Moving bilingual summarization to Google AI Studio does **not** reduce Groq TPD consumption directly — it redirects that work to a separate provider. The net effect on Groq:

- Articles routed to AI Studio → those tokens come off AI Studio's cap, not Groq's
- Groq's 100K TPD cap is now reserved for: streaming Q&A (~2,205/session), trend briefs (~3,250/brief), and fallback processing
- Fallback only fires when AI Studio 429s — in practice this should be rare given AI Studio's generous limits

**App token accounting is unchanged.** The `deduct_tokens` / `refund_tokens` pattern uses Groq token counts because that's what the user-facing features (`answer-question`, `generate-trend-brief`) consume. Batch summarization (`process-queue`) doesn't charge app tokens — it's pipeline cost, not user cost.

---

## Prompt Content Preservation — What Must Not Change

The following must be preserved exactly in the Gemma prompt variants:

- All banned words (EN + ZH)
- Bilingual rules (especially: never translate proper nouns; ZH is a rewrite not a translation)
- Sentence count requirements (2 sentences per bullet, exactly)
- Question rules (3 per language, one skeptical, no "What is"/"How does")
- Sentinel conditions and definitions (INSUFFICIENT_CONTENT, NOT_AI_RELEVANT)
- Character limit rule (TITLE_EN/ZH: no brackets, actor + action + number)

Only the output encoding changes. The content standards are model-agnostic.

---

## Verification Plan

Before deploying to production:

1. **Prompt regression test (manual):** Run 5 known articles through the Gemma JSON prompt via AI Studio. Verify: (a) valid JSON returned, (b) no reasoning prose in output, (c) sentinel fires correctly on a paywall stub, (d) `NOT_AI_RELEVANT` fires on a non-AI article.

2. **Normalization round-trip test:** Take the Gemma JSON output and run it through `normalizeGemmaResponse()`. Verify the output matches what the current Groq flat-text parser produces for the same article.

3. **Fallback test:** Temporarily set an invalid AI Studio API key, run `process-queue`. Verify: (a) fallback to Groq fires, (b) row processes successfully, (c) `last_error` is NOT set (row processed normally).

4. **Parse failure test:** Return malformed JSON from a mocked AI Studio response. Verify: (a) error is thrown (not silently caught), (b) row lands in `status='error'`, (c) `last_error` contains a useful diagnostic.

5. **Rate limit profile check:** Call AI Studio at 6 requests in under a minute (slightly over the conservative RPM estimate) and verify the 429 response is received and fallback fires.

---

## Resolved Decisions

All open questions from the initial draft have been resolved:

**Gemma 4 31B model ID:** `gemma-4-31b-it` (confirmed).

**AI Studio rate limits for Gemma 4 31B:** RPM: 30, TPM: 16K, RPD: 14,400. See Rate Limits section.

**`refresh-questions` call structure:** Collapse to a single combined call returning `{ questions_en: [...], questions_zh: [...] }`. The current 2-parallel-call design was optimizing for Groq latency. On AI Studio with a JSON schema, a single call is cleaner and — more importantly — produces bilingual coherence: both question sets are generated in the same context window and can reference each other. Two independent calls generate EN and ZH sets with no awareness of each other, which can produce question sets that probe different aspects of the same article. Single call is architecturally mandated, not just a simplification.
