# Follow-up Spec: Phase 1 Timeout Fallback + Threshold Calibration

**Date:** 2026-04-15
**Status:** Design only — no implementation
**Parent spec:** `2026-04-15-gemma-timeout-and-json-fixes.md`

---

## Context

After deploying the two-phase timeout and string-aware JSON extractor, live testing returned:

- 1 SKIP (sentinel working)
- 1 OK (full pipeline successful)
- 3 AI Studio connection timeout (5s) — failing row

The JSON parse fix is working. The 5-second Phase 1 threshold is too tight for free-tier AI Studio TTFT variance, and the timeout was routing to row failure rather than Groq fallback — leaving Groq idle while rows piled up in `error`.

---

## Change 1 — Phase 1 Timeout Routes to Groq Fallback

### Root Cause of Current Behavior

The `AbortError` branch in `callLLM` throws immediately, landing the row in `status='error'`. The wall-clock math for a Phase 1 timeout + Groq fallback is:

```
8s (Phase 1 timeout) + ~10s (Groq call) + ~2s (Supabase write) = ~20s
```

20 seconds is within the 30-second Cloudflare wall-clock limit with a 10-second safety margin. Routing Phase 1 timeouts to Groq fallback is both safe and correct. The previous design violated the purpose of the fallback system by choosing clean failure over availability when availability was mathematically affordable.

### Concurrent Batch Behavior Under Promise.all()

`process-queue` runs batches of 5 via `Promise.all()`. Under AI Studio degradation, all 5 Phase 1 timeouts fire at the same moment. All 5 Groq fallbacks then fire concurrently. The batch completes in ~20s — not 5 × 20s. The wall-clock budget holds under the actual concurrent execution model.

Concurrent Groq fallback produces the same subrequest and TPM load as the current all-Groq baseline: 5 parallel calls × ~2,510 tokens ≈ 12,550 tokens/min, right at the 12K TPM ceiling — same as today. The fallback degrades to current behavior, not worse than current behavior.

### Change

In the `catch (fetchErr)` block, the `AbortError` branch changes from throw to fallback:

**Current:**
```typescript
if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
  throw new Error('AI Studio connection timeout (5s) — failing row')
}
```

**After:**
```typescript
if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
  console.log('AI Studio Phase 1 timeout (8s) — no headers received, falling back to Groq')
  return await callGroqFallback(isTweet, content, env)
}
```

---

## Change 2 — Raise Phase 1 Threshold from 5s to 8s

### Why 5s Is Too Tight

5s was set as "3× the observed 1.59s TTFT." That observation was a single data point from a favorable request. Free-tier AI Studio shares infrastructure dynamically — cold-starts and load spikes push TTFT into the 4–7s range. Three consecutive timeouts at 5s confirm the threshold sits below p95 TTFT under realistic load conditions.

### Why 8s, Not 10s

The Phase 1 threshold governs latency on degraded-AI-Studio runs, not safety. With Change 1 in place (timeout → Groq fallback), the threshold is no longer safety-critical — any value between ~6s and ~16s fits within the wall-clock budget. The choice is a latency/success-rate tradeoff:

| Threshold | Wall-clock (timeout + Groq + Supabase) | Safety margin | Excess wait vs 5s |
|---|---|---|---|
| 5s | ~17s | 13s | — |
| 8s | ~20s | 10s | +3s |
| 10s | ~22s | 8s | +5s |

8s is preferred over 10s because it adds only 3 seconds of overhead on fallback runs while giving substantially more headroom for TTFT variance. 10s would add 5 seconds of unnecessary waiting on every degraded-AI-Studio batch.

**Caveat:** 8s is empirically reasonable given one observed TTFT of 1.59s and confirmed failures at 5s. It is a provisional threshold, not a solved constant. If failures at 8s are observed, the threshold should be raised to 10s — the safety margin remains adequate at all values up to ~16s.

### Change

Replace `setTimeout(() => controller.abort(), 5000)` with `setTimeout(() => controller.abort(), 8000)`.

---

## Change 3 — Distinguish Phase 1 and Phase 2 Abort in Error Logs

`AbortError` is ambiguous without context. The same error type covers two distinct failure modes:
- Phase 1: AbortController fires before headers arrive (TTFT failure)
- Phase 2: Should not fire (timer cleared on 200), but if it did, it would indicate a body-stream stall

Clear log messages allow future diagnosis from `last_error` and Worker logs without code inspection.

**Phase 1 log (timeout before headers):**
```
AI Studio Phase 1 timeout (8s) — no headers received, falling back to Groq
```

**Phase 2 (cleared on 200 — should never appear in logs):**
If a body-stream stall were ever observed despite the Phase 2 clear, it would surface as an unhandled rejection with a generic `AbortError` message. Consider wrapping the `aiRes.json()` call in a try/catch that logs `"AI Studio body read aborted unexpectedly"` and throws — giving it a recognizable signature in the error log distinct from Phase 1.

---

## Summary of All Changes

| Change | Location | One-line description |
|---|---|---|
| Route `AbortError` to Groq fallback | `callLLM` catch block | Timeout → `callGroqFallback()` instead of throw |
| Raise threshold 5s → 8s | `setTimeout` in `callLLM` | Single constant change |
| Update log message | `AbortError` branch | "Phase 1 timeout (8s) — no headers received, falling back to Groq" |

No changes to: prompts, `responseSchema`, `normalizeGemmaResponse`, `extractFirstJson`, Groq fallback logic, any other worker, any Edge Function.

---

## Expected Outcome After These Changes

| Scenario | Before | After |
|---|---|---|
| AI Studio fast (TTFT < 8s) | 1/4 succeed | Majority succeed |
| AI Studio slow (TTFT 5–8s) | Timeout → row fails | Timeout → Groq fallback → row processes |
| AI Studio degraded (TTFT > 8s) | Timeout → row fails | Timeout → Groq fallback → row processes |
| AI Studio 429 | Groq fallback | Groq fallback (unchanged) |
| Both providers fail | Row fails | Row fails (correct, unavoidable) |

---

## Verification Plan

1. **Phase 1 timeout → fallback fires:** Point `AI_STUDIO_BASE` at a slow/non-responding host. Confirm `AbortError` at ~8s is followed by a successful Groq call. Confirm row processes without `last_error` set.

2. **Both-provider failure:** Invalidate both API keys. Confirm row lands in `status='error'`, `last_error` reflects Groq failure (the last provider attempted).

3. **Concurrent batch under simulated degradation:** Run a batch of 5 while AI Studio is slow. Confirm all 5 complete via Groq within the 30s wall-clock budget. Confirm no orphaned `processing` rows.

4. **Normal path unaffected:** Run 5 articles under healthy AI Studio conditions. Confirm no regressions — Phase 1 timer clears normally on 200, full Gemma path executes.
