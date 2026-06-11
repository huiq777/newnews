# RAG Video Script Source Notes

Last updated: 2026-06-08

This file is the structured source-note version of the RAG video/transcript ideas. It is not the implementation plan. Use it as the idea bank for:

- `docs/superpowers/specs/2026-06-08-rag-eval-architecture-refinement.md`
- `docs/superpowers/plans/2026-06-08-rag-eval-refinement-plan.md`
- `docs/project-interview-resume-brief.md`

## 1. Core RAG Evaluation Ideas

RAG must be evaluated layer by layer, not as a black-box answer.

Primary retrieval metrics:

- `Recall@K`: whether the correct evidence appears in top K.
- `MRR`: whether the correct evidence ranks near the top.
- `NDCG@10`: overall ranking quality when multiple chunks can be relevant.
- `Hit@5`: whether any relevant evidence appears in the first five results.

Evaluation layers:

1. Retrieval: Did the system find the right evidence?
2. Rerank: Did it move the best evidence upward?
3. Generation: Did the answer stay faithful to context?
4. End-to-end/business: Did users get useful answers?

Project mapping:

- Current project has retrieval eval and historical baselines.
- Generation eval remains missing and must be added before claiming answer-quality improvement.
- Current safe claim is "offline retrieval improved," not "production answer accuracy improved."

## 2. News-Format Cohorts

Different news formats stress chunk retrieval differently.

| Cohort | Typical Shape | Retrieval Risk | Eval Purpose |
|---|---|---|---|
| Short news / brief | 200-300 words, dense facts | Sparse features, low lexical surface area | Check whether short content still embeds and ranks well. |
| Long-form feature | Thousands of words, scattered facts | Relevant evidence may be far apart | Recall@10 and chunk coverage matter more. |
| Transcript / podcast | Conversational, noisy, long | Topic drift and repeated entities | Test chunking and rerank robustness. |
| Reddit / social | Informal wording | Query/document style mismatch | Test query rewrite and lexical fallback. |
| Official source | Precise terms, policy language | Entity/legal terms are load-bearing | Test entity matching and exact terms. |

Project action:

- Add eval metadata fields or JSON tags for `content_length_bucket`, `source_type`, `language`, `format_cohort`, and `entity_density`.
- Report metrics by cohort, not only global average.

## 3. Hard Negatives And Noise

A 21-case set can become too easy if each query only needs to identify one obvious article. Real production retrieval searches across thousands of similar articles.

Hard-negative strategy:

- For each approved case, add 5-10 same-topic but wrong-event articles as distractors.
- Include similar company names, same source, same time window, or same topic but different event.
- Evaluate whether the true article/chunk still ranks above these distractors.

Metrics to watch:

- MRR: most sensitive to hard negatives.
- Hit@5: whether the right item survives near the top.
- NDCG@10: whether partially relevant distractors pollute the ranking.

Project action:

- Add hard-negative labels to `rag_eval_gold_evidence` or case metadata.
- Add diagnostics that show when a hard negative outranks approved gold.

## 4. Hybrid Search And BGE-M3

Dense retrieval finds semantic similarity. BM25/lexical retrieval protects exact names, products, legal terms, and event slogans.

Current project direction:

- Use `@cf/baai/bge-m3` for dense chunk embeddings.
- Keep lexical/BM25-style retrieval for exact term recall.
- Use RRF or weighted RRF to fuse candidates.

BGE-M3 note:

- BGE-M3 can support dense, sparse, and multi-vector retrieval modes in some serving contexts.
- Current project only relies on dense BGE vectors plus Postgres lexical search.
- True BGE sparse or multi-vector eval should be a separate track after confirming the selected API exposes usable sparse/ColBERT outputs.

## 5. Rerank

Rerank is the quality gate between high-recall retrieval and context injection.

Why rerank:

- Vector similarity is coarse and can miss negation, conditions, and fine-grained intent.
- Retrieval optimizes geometric similarity; RAG needs answer-supporting evidence.
- Good rerank reduces irrelevant context and hallucination risk.

Project direction:

- Prefer eval-only Cloudflare Workers AI `@cf/baai/bge-reranker-base`.
- Keep TokenRouter LLM judge rerank as fallback or audit comparison.
- Use two-stage rerank if needed:
  - Stage 1: lightweight reranker on overfetched candidates.
  - Stage 2: heavier rerank only on narrowed candidates.
- Cache rerank results by normalized query, candidate ids, model, and chunking version.

## 6. Query Rewrite

Query rewrite is not "rewrite the user's words." It is retrieval intent alignment.

Rewrite modes:

- Entity expansion: preserve named entities and exact terms.
- HyDE: generate a hypothetical answer and retrieve with answer-like language.
- Task decomposition: split comparison or multi-hop questions into subqueries.
- Context completion: resolve pronouns and missing references in multi-turn conversations.

Risks:

- Latency: every rewrite can add an LLM call.
- Drift: rewritten query can change intent.
- Cost: rewriting every question wastes tokens.

Project guardrails:

- Use an intent router to skip rewrite for simple questions.
- Run rewrite in parallel with baseline retrieval when possible.
- Compare original and rewritten query similarity; if drift is too high, keep original.
- Store rewrite mode and rewritten query in `rag_retrieval_runs.query_input`.

## 7. Agentic RAG

Traditional RAG is linear: query, retrieve, generate. Agentic RAG adds planning, tool choice, self-check, and bounded re-retrieval.

Project architecture:

- Intent router decides fast linear path vs agentic path.
- Planner decomposes complex questions into 1-3 subqueries.
- Retrieval agent runs chunk dense, lexical/entity hybrid, overfetch, and rerank.
- Critique agent checks context sufficiency, relevance, conflicts, and answerability.
- Generation agent answers only from injected context.

Use Agentic RAG for:

- Multi-hop questions.
- Comparisons across entities or time periods.
- Ambiguous multi-turn questions.
- Low-context or conflicting retrieved evidence.

Do not use Agentic RAG for:

- Simple article questions.
- Single-hop factual lookup where chunk retrieval already works.

Safety limits:

- Max two retrieval rounds.
- Max three subqueries.
- Hard timeout before falling back to linear chunk retrieval.
- Trace every plan, subquery, critique score, retry reason, and stop reason.

## 8. GraphRAG And Knowledge Graphs

Vector retrieval answers "what text is similar?" Knowledge graphs answer "how are entities related?"

Use graph/GraphRAG only when:

- The question needs multi-hop entity relations.
- The answer depends on structured relationships, not just a similar chunk.
- Agent memory or long-term entity state becomes important.

Do not add graph complexity for:

- Single-hop definitions.
- Fresh news Q&A where the answer is in one article.
- Cases already solved by chunk dense plus lexical/rerank.

Project stance:

- Defer graph storage until eval cases prove relation-based misses.
- If added, graph should extend retrieval context, not replace vector/BM25 retrieval.

## 9. Compiled Knowledge Layer

Compiled knowledge means precomputing reusable summaries, entities, timelines, and relationships so agents do not repeatedly re-read the same corpus.

Project mapping:

- `article_deep_analysis` is already an early compiled-knowledge layer.
- Future compiled artifacts could include:
  - entity/event summaries
  - timelines
  - source trust metadata
  - per-company or per-topic briefs
  - relation triples for multi-hop cases

This should remain secondary until:

- Deep Analysis coverage is healthy.
- Chunk retrieval and generation eval are stable.
- Agentic RAG eval shows repeated retrieval cost or multi-hop failures.

## 10. Interview Talking Points

Strong claims:

- RAG was evaluated in layers: retrieval, rerank, generation, end-to-end.
- Current measured win is offline retrieval, not production answer accuracy.
- Chunk retrieval with `@cf/baai/bge-m3` is eval-approved, while production retrieval remains rollback-safe.
- Agentic RAG is designed as a gated orchestration layer, not a blanket replacement.

Avoid:

- Claiming production answer accuracy improved before generation eval.
- Claiming Agentic RAG is shipped before implementation and eval.
- Treating GraphRAG as automatically better than vector/BM25 retrieval.
