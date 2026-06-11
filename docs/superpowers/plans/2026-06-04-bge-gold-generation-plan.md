# BGE Gold Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move expanded RAG gold candidate generation off Cohere and onto Cloudflare BGE chunk retrieval so Cohere 403s no longer block labeling.

**Architecture:** Keep the legacy Cohere article-level path for historical dense generation, but make `--expand-candidates true` default to a new `bge_chunk` candidate provider. The BGE path uses existing Cloudflare-compatible `bgeEmbedSearchQuery`, `match_article_chunks_eval`, lexical candidates, and primary-article baseline, and records provider/model metadata on pending gold rows.

**Tech Stack:** Node.js eval scripts, Supabase PostgREST/RPC, Cloudflare Workers AI BGE-compatible embeddings, `node:test` static coverage.

---

### Task 1: Add BGE Provider Tests

**Files:**
- Modify: `tests/rag-retrieval-refinement.test.mjs`

- [ ] **Step 1: Add static assertions**

Add assertions to the gold generation test requiring:

```js
assert.match(source, /--candidate-provider/)
assert.match(source, /bge_chunk/)
assert.match(source, /cohere_article/)
assert.match(source, /candidateProvider/)
```

- [ ] **Step 2: Verify the test fails before implementation**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: failure in `gold generation expands evidence beyond dense candidates before official comparison` because `--candidate-provider` does not exist yet.

### Task 2: Switch Expanded Gold To BGE

**Files:**
- Modify: `scripts/rag-eval-generate-gold.mjs`

- [ ] **Step 1: Make env requirements provider-aware**

Use this behavior:

```js
const expandCandidates = args['expand-candidates'] === 'true'
const candidateProvider = String(args['candidate-provider'] || (expandCandidates ? 'bge_chunk' : 'cohere_article'))
const usesCohereArticleCandidates = candidateProvider === 'cohere_article'
const usesBgeCandidates = expandCandidates || candidateProvider === 'bge_chunk'
```

Require `COHERE_API_KEY` only when `usesCohereArticleCandidates` is true. Require `BGE_EMBEDDING_BASE_URL` and `BGE_EMBEDDING_API_KEY` when `usesBgeCandidates` is true.

- [ ] **Step 2: Skip Cohere candidate retrieval for BGE expanded runs**

For `candidateProvider === 'bge_chunk'`, pass an empty dense candidate list into `expandGoldCandidates()` and rely on chunk, lexical, and primary baseline candidates.

- [ ] **Step 3: Record provider metadata**

Set generated gold metadata to record:

```js
candidate_provider: candidateProvider
query_embedding_model: candidateProvider === 'bge_chunk' ? BGE_EMBEDDING_MODEL : 'embed-english-v3.0'
retrieval_strategy: expandCandidates ? `expanded_${candidateProvider}_lexical_primary_baseline` : RETRIEVAL_STRATEGY
```

### Task 3: Verify

**Files:**
- Test: `tests/rag-retrieval-refinement.test.mjs`
- Test: `scripts/rag-eval-generate-gold.mjs`

- [ ] **Step 1: Syntax check**

Run:

```bash
node --check scripts/rag-eval-generate-gold.mjs
```

Expected: no output and exit code 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
node --test tests/rag-retrieval-refinement.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Operational command**

Use:

```bash
RAG_EVAL_GOLD_TIMEOUT_MS=240000 npm run eval:generate-gold -- --set qa-v1-2026-06 --expand-candidates true --missing-only true --candidate-provider bge_chunk
```

Expected: no `COHERE_API_KEY` or Cohere embed call is needed for missing expanded gold cases.
