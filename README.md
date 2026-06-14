# News Project

Language: [English](#english) | [中文](#中文) | [Agent/LLM Orientation](#agentllm-orientation)

## English

Open Beta AI news intelligence app for bilingual AI/tech coverage. The public daily feed is readable without login; GitHub or Google OAuth unlocks Deep Analysis, streaming RAG Q&A, question refresh, and Trend Brief generation.

For the interview-ready background, metrics, and implementation story, read [docs/project-interview-resume-brief.md](docs/project-interview-resume-brief.md).

### What It Does

- Ingests RSS, WeChat, Reddit, YouTube fallback feeds, builder tweets, podcasts, AIHot, official sources, Product Hunt, Nowcoder, GitHub Trending, and arXiv.
- Filters for AI relevance, generates bilingual titles/summaries/questions, embeds articles, and serves a grouped public feed.
- Streams article-grounded Q&A through Supabase Edge Functions, with RAG traces for retriever inputs, ranked candidates, injected context, answer logs, and feedback.
- Generates cross-window Trend Briefs with historical enrichment, copy/feedback controls, and digest delivery.
- Keeps premium generated content behind OAuth and Edge Function rate limits instead of broad direct table reads.

### Current Results

Latest valid offline RAG eval uses corpus-health run `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0` on eval set `qa-v1-2026-06`.

| Track | Result |
|---|---|
| Latest eval / selected candidate | `chunk_dense @cf/baai/bge-m3` — chunk-level dense retrieval |
| Retrieval eval, 21 approved cases | Recall@5 `0.895`, Recall@10 `0.943`, MRR `0.739`, NDCG@10 `0.764`, Hit@5 `0.952` |
| Latency for selected candidate | p50/p95 as low as `1179/3425ms` |
| Generation eval, latest aggregate | Faithfulness `0.994`, answer relevancy `0.950`, context precision `0.785`, context recall `0.819` |
| Quality ceiling | `rerank_hybrid` reached Recall@10 `1.000`, but p95 `68056ms`, so it stays eval-only |

Production `answer-question` now defaults to **chunk-level dense retrieval** via `chunk_dense @cf/baai/bge-m3`. The older article-level retriever remains available only as rollback/fallback.

These metrics describe the **Q&A RAG eval track**. Deep Analysis and Trend Brief need separate surface-specific evals before their quality can be quoted. Agentic RAG is an eval-only orchestration path for harder multi-hop/comparison questions; GraphRAG is deferred until relation-based failures justify a graph layer.

### How It Is Built

- **Frontend:** Expo/React Native web app, deployed through Cloudflare Pages.
- **Data + Auth:** Supabase Postgres, pgvector, RLS, Auth OAuth providers.
- **Ingestion:** Cloudflare Workers cron jobs plus Supabase Edge Function webhooks.
- **AI:** TokenRouter primary LLM path, OpenRouter/Groq fallback, Cloudflare Workers AI BGE for production Q&A chunk retrieval and Deep Analysis embeddings, plus Cohere for legacy article embeddings/rollback paths.
- **Observability:** `pipeline_events`, `qa_logs`, `rag_retrieval_*`, and `rag_eval_*` tables.
- **Access model:** anonymous public feed; OAuth-gated analysis; `user_article_questions` and `user_trend_briefs` for user-scoped overrides.

## 中文

这是一个面向 Open Beta 的双语 AI 新闻智能应用。用户无需登录即可浏览每日新闻流；通过 GitHub 或 Google OAuth 登录后，可以使用 Deep Analysis、流式 RAG 问答、问题刷新和 Trend Brief 生成。

如果需要面试/简历视角的背景、指标和实现说明，请阅读 [docs/project-interview-resume-brief.md](docs/project-interview-resume-brief.md)。

### 功能概览

- 自动采集 RSS、微信公众号、Reddit、YouTube 轻量 fallback、开发者推文、播客、AIHot、官方来源、Product Hunt、Nowcoder、GitHub Trending 和 arXiv。
- 过滤 AI 相关内容，生成中英文标题、摘要和问题，写入向量，并通过分组 feed 提供公开阅读。
- 通过 Supabase Edge Functions 提供基于文章证据的流式 RAG 问答，并记录检索输入、候选排序、注入上下文、回答日志和反馈。
- 生成跨时间窗口 Trend Brief，包含历史相关文章补充、复制/反馈交互和摘要分发。
- 将高成本的生成式分析放在 OAuth 和 Edge Function rate limit 后面，而不是让前端直接读取大范围分析表。

### 当前结果

最新有效离线 RAG 评估使用 corpus-health run `54dcd974-2fa2-4fb7-bb62-6eae9f3880c0`，评估集为 `qa-v1-2026-06`。

| 项目 | 结果 |
|---|---|
| Latest eval / 当前选择的候选 | `chunk_dense @cf/baai/bge-m3` — chunk-level dense retrieval |
| 21 个 approved case 检索评估 | Recall@5 `0.895`，Recall@10 `0.943`，MRR `0.739`，NDCG@10 `0.764`，Hit@5 `0.952` |
| 候选方案延迟 | p50/p95 最好达到 `1179/3425ms` |
| 最新 generation eval 聚合 | Faithfulness `0.994`，Answer relevancy `0.950`，Context precision `0.785`，Context recall `0.819` |
| 质量上限参考 | `rerank_hybrid` Recall@10 达到 `1.000`，但 p95 `68056ms`，因此仍保留为 eval-only |

当前生产 `answer-question` 默认使用 **chunk-level dense retrieval**：`chunk_dense @cf/baai/bge-m3`。原 article-level retriever 仅保留为 fallback/回滚路径。

这些指标描述的是 **Q&A RAG eval track**。Deep Analysis 和 Trend Brief 需要单独的 surface-specific eval，不能直接套用 Q&A 的 Recall/MRR/NDCG。Agentic RAG 目前是 eval-only 的编排层，用于未来更复杂的 multi-hop/comparison 问题；GraphRAG 暂缓，直到评估证明 chunk/hybrid/rerank 无法解决关系型证据问题。

### 技术实现

- **前端:** Expo/React Native Web，通过 Cloudflare Pages 部署。
- **数据与认证:** Supabase Postgres、pgvector、RLS、Supabase Auth OAuth providers。
- **采集:** Cloudflare Workers 定时任务 + Supabase Edge Function webhook。
- **AI:** TokenRouter 主路径，OpenRouter/Groq fallback，Cohere 文章/查询向量，Cloudflare Workers AI BGE 用于 Deep Analysis 和 eval chunk embedding。
- **可观测性:** `pipeline_events`、`qa_logs`、`rag_retrieval_*`、`rag_eval_*`。
- **访问模型:** 匿名用户可看公开 feed；OAuth 用户可用生成式分析；`user_article_questions` 和 `user_trend_briefs` 保存用户级 override。

## Agent/LLM Orientation

If you are an agent or LLM working in this repo, read these first:

- [docs/current-state.md](docs/current-state.md) — live deployment state, active architecture, and next steps.
- [docs/project-interview-resume-brief.md](docs/project-interview-resume-brief.md) — concise background, metrics, and implementation narrative.
- [docs/instructions.md](docs/instructions.md) — commands for deployment, RAG eval, smoke checks, and local dev.
- [docs/schema.md](docs/schema.md) — database tables, RLS model, eval stores, and service-owned analysis caches.
- [docs/edge-functions.md](docs/edge-functions.md) — authenticated analysis APIs, webhooks, streaming patterns, and required secrets.
- [docs/api-keys-and-env.md](docs/api-keys-and-env.md) — where secrets live and how OAuth callback URLs are configured.
- [docs/architecture.md](docs/architecture.md) — rationale for Supabase, Cloudflare Workers, queueing, LLM routing, and retrieval design.

Core invariants:

- The public feed is anonymous; generated analysis is OAuth-gated.
- Closed-beta invite auth is legacy/rollback only.
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` or AI provider keys to the frontend.
- Browser analysis should go through Edge Functions, not direct broad reads from `article_deep_analysis`, `trend_briefs`, `user_article_questions`, or `user_trend_briefs`.
- Production `answer-question` defaults to chunk-level dense retrieval through `match_answer_question_chunks` with `@cf/baai/bge-m3`; article-level dense retrieval is rollback/fallback only.
- Hybrid, rerank, agentic RAG, and GraphRAG remain eval-gated until their own rollout plans land.
- When quoting RAG results, use corpus-health-valid runs only and preserve the offline-vs-production distinction.
- Q&A RAG, Deep Analysis eval, Trend Brief eval, Agentic RAG, and GraphRAG are separate terms. Do not transfer metrics from one surface to another.
- Future plan: [Deep Analysis and Trend Brief RAG eval refinement](docs/superpowers/plans/2026-06-11-deep-analysis-trend-brief-rag-eval-refinement-plan.md).

## Useful Docs

- [Project interview/resume brief](docs/project-interview-resume-brief.md) — background, results/metrics, and how the system was achieved.
- [Current state](docs/current-state.md) — live component status and next steps.
- [Command reference](docs/instructions.md) — deploy, smoke, and eval commands.
- [Schema](docs/schema.md) — tables, RLS, and eval stores.
- [Edge functions](docs/edge-functions.md) — user-facing and webhook APIs.
- [API keys and env](docs/api-keys-and-env.md) — secrets, OAuth setup, and deployment env.

## Local Dev

```bash
cd news-app
npm install
npx expo start --web
```

Run the core verification from the repo root:

```bash
npm test
```
