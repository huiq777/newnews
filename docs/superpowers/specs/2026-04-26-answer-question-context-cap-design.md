# answer-question Context Cap (P0 Hotfix) — Design Plan

## Context

Architect-role Principle 4 asserts:

> "`article_content` is capped at 24,000 chars in `process-queue`, **3,000 chars in `answer-question`**."

The first half is true ([process-queue/index.ts:974](../../../supabase/functions/process-queue/index.ts) — `.substring(0, 24000)`). **The second half is not implemented.** [answer-question/index.ts:37](../../../supabase/functions/answer-question/index.ts) sets:

```ts
const mainContext = article.article_content || summary
```

with no slice, no cap. A single query against a long-form article therefore dumps up to 24,000 chars of unsanitized third-party text into the LLM's `system` role.

This is two failures at once:
- **Token budget exposure.** ~24K chars ≈ 6K Groq tokens per query. ~16 queries against long articles drain the 100K TPD cap.
- **Prompt-injection surface.** The Principle 4 defense-in-depth guarantee does not exist; the cap was a doc claim, not a code reality.

P0: ship a strict cap and reconcile the doc.

## Diagnose (5-Dimension Lens)

| Dim | Status |
|---|---|
| 1. Ingestion | N/A — this is a retrieval-time cap, not an ingestion change. |
| 2. Advanced RAG | Asymmetric today: main is uncapped, related uses `summary` only. Capping main + giving related a small explicit budget restores symmetry and is a prerequisite to the future reranker spec. |
| 3. Metrics | Per-query token cost becomes bounded → predictable Groq TPD math; long-article TTFT improves (less prompt to ingest before first token). **Quality is unmeasured today** — see Quality Risk below. |
| 4. Flywheel | N/A. The eval set built for this spec becomes a seed for Spec C's harness. |
| 5. Safety | Closes the prompt-injection surface from worst-case 24K chars to ≤14.4K total. The cap is not a complete defense (no sanitization), but it bounds the blast radius. |

## Decision (locked)

**Tiered char cap** (chosen over flat 3K and over token-counted budget):

| Slot | Cap | Why |
|---|---|---|
| Main `article_content` | 12,000 chars | Preserves long-form fidelity; ~3K tokens. |
| Each related article `summary` | 800 chars | Plenty for a tight digest; 3 × 800 = 2.4K chars ≈ 600 tokens. |
| Max related articles | 3 | Already in code, formalized here. |
| **Total system-role budget** | **≤14.4K chars / ~3.6K tokens** | Comfortably under the 8K Groq target per query. |

Token-counted budgeting is rejected for now — adds a tokenizer dependency in the Edge Function for marginal gain over a char cap. Reconsider when chunking lands (Spec D).

## Quality Risk (made explicit)

The `MAIN_CONTEXT_CAP = 12_000` cuts the back half of every article in the 12K–24K char range. There is **no metric harness today** (Dimension 3 finding) to prove this is safe. Most short-form RSS content (TechCrunch, Verge, Reddit) is well below 12K. The cap will bite:
- **Long-form deep dives** (e.g., Ars Technica multi-section articles, some TechCrunch features).
- **Podcast transcripts** — these can be 15K–40K chars, and the answer to a transcript question often lives in the *body*, not the lede.
- **arXiv full-text** (when/if PDF parsing is added under Spec D).

We accept this risk for the P0 patch — leaving the surface uncapped is worse than a measurable quality regression — but we **must** validate it before ship via the manual eval below.

## Recommended approach

### 1. `answer-question` Edge Function

**File:** [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts)

Add module-level constants and apply them at the two existing context-construction sites. No new functions, no refactor.

```ts
// near top of serve handler, after env reads
const MAIN_CONTEXT_CAP = 12_000
const RELATED_CONTEXT_CAP = 800
const MAX_RELATED = 3

// REPLACE line 37:
const fullContent = article.article_content || summary
const mainContext = fullContent.length > MAIN_CONTEXT_CAP
  ? fullContent.slice(0, MAIN_CONTEXT_CAP)
  : fullContent

// REPLACE line 67 (the slice):
const filtered = related.filter(r => r.id !== article_id).slice(0, MAX_RELATED)

// REPLACE the related context build (lines 68-73):
if (filtered.length > 0) {
  const label = lang === 'zh' ? '相关文章' : 'Related article'
  relatedContext = '\n\n' + filtered.map((r, i) => {
    const trimmed = (r.summary || '').slice(0, RELATED_CONTEXT_CAP)
    return `[${label} ${i + 1}] ${r.title}\n${trimmed}`
  }).join('\n\n')
}
```

That is the full code surface. Five edited lines, three new constants.

### 2. Architect-role doc reconciliation

**File:** [docs/architect-role.md](../../architect-role.md), Principle 4 (current line 88).

Change:

> "Context truncation is also mandatory: `article_content` is capped at 24,000 chars in `process-queue`, 3,000 chars in `answer-question`. Any new LLM call that ingests external content must have an explicit char cap."

To:

> "Context truncation is also mandatory. In `process-queue`, `article_content` is capped at 24,000 chars. In `answer-question`, the system-role budget is tiered: 12,000 chars for the main article, 800 chars per related article (max 3 related). Any new LLM call that ingests external content must have an explicit char cap and a defended total."

### 3. Observability (lightweight)

Add one `console.log` line at the end of context construction so the cap is auditable in Edge Function logs:

```ts
console.log(`[answer-question] context: main=${mainContext.length}c, related=${filtered.length}x, total=${mainContext.length + relatedContext.length}c`)
```

No metrics table — this is a hotfix, not a flywheel item. Spec C (qa_logs) will replace this log with structured persistence.

## Verification

Two layers — behavioral (does the cap fire) and qualitative (does the answer get worse). Both must pass before ship.

### A. Quality eval (manual, one-time, blocking)

This is the spec's quality gate **and** the seed corpus for the eval harness Spec C will productize.

**Cohort selection** (run against production DB):

```sql
-- Long-form cohort (the cap WILL bite — 5 articles, expected to stress the change)
SELECT id, title, length(article_content) AS chars
FROM daily_news
WHERE length(article_content) > 12000
ORDER BY chars DESC
LIMIT 5;

-- Mid-length cohort (cap should NOT fire — regression check, 3 articles)
SELECT id, title, length(article_content) AS chars
FROM daily_news
WHERE length(article_content) BETWEEN 5000 AND 12000
ORDER BY chars DESC
LIMIT 3;
```

**Question authoring** (architect or operator, ~30 minutes):

| Cohort | Questions per article | Question requirement |
|---|---|---|
| Long-form (5) | 3 | At least 1 question whose answer is in the back half of the article (lines 12,001+). This is the cap's stress test. |
| Mid-length (3) | 2 | Any natural reading-comprehension questions. |

Total: **21 question/answer pairs.**

**Test procedure:**
1. Snapshot the current `answer-question` Edge Function (git ref).
2. Deploy the capped version to a *staging* Edge Function name (e.g., `answer-question-capped`) to avoid touching production.
3. For each (article, question) pair: run both Edge Functions, capture the streamed answer to a Markdown file with the format:

```
## [article_id] [title] — Q1
**Question:** ...
### Uncapped (current production)
[answer]
### Capped (proposed)
[answer]
**Verdict:** same | acceptable_degradation | much_worse
**Notes:** [optional]
```

4. Architect / operator scores all 21 pairs.

**Acceptance criteria** (must all pass):

| Cohort | Metric | Threshold |
|---|---|---|
| Long-form (15 pairs) | `much_worse` count | **0** |
| Long-form (15 pairs) | `acceptable_degradation` count | ≤ 4 (≤27%) |
| Mid-length (6 pairs) | Any non-`same` verdict | **0** (regression check — these articles fall under the cap, behavior must be identical) |

**Failure handling:**
- If `much_worse > 0`: do not ship at 12K. Re-run the eval with `MAIN_CONTEXT_CAP = 16_000` and `MAIN_CONTEXT_CAP = 20_000`. Pick the smallest cap that produces zero `much_worse`. Update Principle 4 to match.
- If mid-length cohort shows any drift: there is a bug in the slice logic — fix and re-run.

**Output artifact:** the 21-pair Markdown becomes `docs/superpowers/specs/2026-04-26-answer-question-context-cap-eval.md` and ships with the spec. This is the project's first persisted quality eval. Spec C inherits it.

### B. Behavioral verification (post-deploy)

After production deploy, in Edge Function logs:
1. **Long-article truncation:** issue one query against an article from the long-form cohort. Confirm logs show `main=12000c` exactly.
2. **Short-article passthrough:** issue one query against an article with `length(article_content) ≈ 3000`. Confirm logs show `main=3000c` (or close — actual length, no truncation).
3. **Related cap:** find a question that returns a related article whose summary > 800 chars. Confirm logs show `related=Nx` and `total ≤ 14400`.
4. **Doc-code parity:** re-read [docs/architect-role.md](../../architect-role.md) Principle 4 and confirm it matches the deployed constants. This drift-check is the discipline this whole spec exists to enforce.

## Out of scope

- Token-accurate budgeting (deferred until chunking; char-cap is the 80/20 patch).
- Reranking related candidates (Spec E, deferred until chunking).
- Sanitizing related-article text against prompt injection beyond role-separation + cap (Spec C+ material).
- `qa_logs` persistence and the eval harness productization (Spec C — but this spec produces the seed corpus).

## Critical files

- [supabase/functions/answer-question/index.ts](../../../supabase/functions/answer-question/index.ts) — lines 37, 67, 68–73
- [docs/architect-role.md](../../architect-role.md) — Principle 4, currently line 88
- `docs/superpowers/specs/2026-04-26-answer-question-context-cap-eval.md` — created by SWE during quality eval (new artifact, ships with the spec)

## Sequencing

This spec is **independent** of Spec B (auth gate), Spec C (qa_logs), and Spec D (chunking). Ship it first; the others build on a healthy retrieval baseline. The quality eval artifact produced here is the seed for Spec C's harness.
