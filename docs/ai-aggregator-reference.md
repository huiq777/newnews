# AI Aggregator Reference — Pipeline & Prompt Patterns

Three open-source AI news aggregators examined for architecture and prompt design patterns. Referenced during feature design for this project. Each entry covers pipeline architecture, model choices, and exact or paraphrased prompt designs.

---

## 1. WorldMonitor (`koala73/worldmonitor`)

**Purpose:** Real-time global intelligence dashboard. Synthesizes 435+ curated news feeds across 15 geopolitical/financial/infrastructure categories into AI briefs and composite risk scores. Targets situational awareness, not casual reading.

### Pipeline Architecture

```
435+ RSS/news feeds (21 languages)
  → Vercel Edge Functions (60+) — ingestion + routing
  → Railway relay server — LLM proxy layer (keys never on client)
  → Redis/Upstash — 3-tier cache
  → AI briefing generation
  → Frontend: globe.gl + deck.gl dual-map visualization
  → Desktop: Tauri 2 (Rust) + Node.js sidecar
```

**Five deployment variants** (world, tech, finance, commodity, happy) share one codebase — the variant determines which source categories are active.

### AI / Model Stack

| Component | Technology |
|---|---|
| Primary inference | Ollama (local) / Groq / OpenRouter — user-configurable |
| Browser-side NLP | Transformers.js — runs in browser, no remote API |
| Chat analyst | `callLlmReasoningStream()` — streaming SSE, max 600 tokens, temp 0.35 |

Model is configurable per deployment. The local Ollama option is a privacy-first design — no article content leaves the device.

### Chat Analyst Prompt Design

The only surfaced prompt is the interactive chat analyst (Pro-only feature):

- System prompt assembled dynamically via `buildAnalystSystemPrompt()` — incorporates active source list, degradation status, and domain filter (`all` / `geo` / `market` / `military` / `economic`)
- User input capped at 500 chars — prompt injection surface control
- Geographic context (`geoContext`: 2-char country code) injected into system context when provided
- Response stream: metadata event first (active sources), then optional widget-suggestion action events, then token deltas, then `[DONE]`

**What's notable:** The briefing generation prompts are not public — they live behind the Railway relay proxy. The architecture deliberately obscures the system prompts from the client (keys and prompts injected server-side before forwarding). This is a deliberate IP protection pattern.

### Key Design Signals

- Correlation across streams is a first-class feature — military + economic + climate signals synthesized into a single Country Intelligence Index (12-signal composite)
- No pipeline transparency in the public repo — the value is in the curated feed list and the correlation logic, not the prompts
- Free tier has visualization; AI chat is paywalled (Pro subscription via Clerk JWT)

---

## 2. Horizon (`Thysrael/Horizon`)

**Purpose:** Automated daily tech news brief. Pulls from Hacker News, RSS, Reddit, Telegram, GitHub. AI scores, deduplicates, enriches, and publishes a bilingual (EN/ZH) Markdown daily to GitHub Pages via Actions.

### Pipeline Architecture

```
Sources: HN + RSS/Atom + Reddit + Telegram + GitHub events/releases
  → 1. Fetch (concurrent)
  → 2. URL-level dedup (merge richest content variant)
  → 3. AI scoring (0-10 per item)
  → 4. Score filter (default threshold: 6.0)
  → 5. AI semantic dedup (topic-level, merge comments into survivor)
  → 6. Enrichment (background knowledge + web search grounding)
  → 7. Daily summary Markdown generation
  → GitHub Pages deploy via Actions
```

Token usage tracked across all providers and reported at pipeline end.

### AI / Model Stack

| Component | Model |
|---|---|
| Scoring | Any OpenAI-compatible — Claude, GPT-4, Gemini, DeepSeek, Doubao, MiniMax |
| Deduplication | Same configurable provider |
| Enrichment | Same configurable provider |
| Summary | Same configurable provider |

Model is fully configurable in `config.json` — the system is model-agnostic by design. MCP server also exposed (`hz_score_items`, `hz_generate_summary`, `hz_run_pipeline`).

### Prompt Design

All prompts live in `src/ai/prompts.py`. All responses are strict JSON.

---

#### Scoring Prompt (`CONTENT_ANALYSIS_SYSTEM` / `CONTENT_ANALYSIS_USER`)

Five-tier rubric. The system prompt:

```
You are an expert content curator helping filter important technical and academic information.

Score content on a 0-10 scale based on importance and relevance:

9-10: Groundbreaking — Major breakthroughs, paradigm shifts, or highly significant announcements
  - New major version releases of widely-used technologies
  - Significant research breakthroughs
  - Important industry-changing announcements

7-8: High Value — Important developments worth immediate attention
  - Interesting technical deep-dives
  - Novel approaches to known problems
  - Insightful analysis or commentary
  - Valuable tools or libraries

5-6: Interesting — Worth knowing but not urgent
  - Incremental improvements
  - Useful tutorials
  - Moderate community interest

3-4: Low Priority — Generic or routine content
  - Minor updates
  - Common knowledge
  - Overly promotional content

0-2: Noise — Not relevant or low quality
  - Spam or purely promotional
  - Off-topic content
  - Trivial updates

Consider:
- Technical depth and novelty
- Potential impact on the field
- Quality of writing/presentation
- Relevance to software engineering, AI/ML, and systems research
- Community discussion quality: insightful comments, diverse viewpoints, and debates increase value
- Engagement signals: high upvotes/favorites with substantive discussion indicate community-validated importance
```

User message template:
```
Analyze the following content and provide a JSON response with:
- score (0-10)
- reason: Brief explanation
- summary: One-sentence summary
- tags: Relevant topic tags (3-5)

Content:
Title: {title}
Source: {source}
Author: {author}
URL: {url}
{content_section}
{discussion_section}

Respond with valid JSON only:
{ "score": <number>, "reason": "...", "summary": "...", "tags": [...] }
```

---

#### Deduplication Prompt (`TOPIC_DEDUP_SYSTEM` / `TOPIC_DEDUP_USER`)

```
You are a news deduplication assistant. Identify groups of news items that cover the
exact same real-world event, release, or announcement.

Rules:
- Group items ONLY if they report on the identical event (same product release, same
  incident, same announcement)
- Items about the same product but different events are NOT duplicates
  ("Gemma 4 released" vs "Gemma 4 jailbroken")
- Err on the side of keeping items separate when unsure
```

User message feeds already-sorted items (descending by score), requests JSON:
```json
{ "duplicates": [[<primary_idx>, <dup_idx>, ...], ...] }
```
Primary item = the highest-scoring one (first in group). Comments from duplicates are merged into the survivor before the duplicates are dropped.

---

#### Concept Extraction Prompt (`CONCEPT_EXTRACTION_SYSTEM` / `CONCEPT_EXTRACTION_USER`)

```
You identify technical concepts in news that a reader might not know.
Given a news item, return 1-3 search queries for concepts that need explanation.
Focus on: specific technologies, protocols, algorithms, tools, or projects that are
not widely known.
Do NOT return queries for well-known things (e.g. "Python", "Linux", "Google").
If the news is self-explanatory, return an empty list.
```

Output: `{ "queries": ["<search query 1>", ...] }` — fed into web search, results used for the enrichment step below.

---

#### Enrichment Prompt (`CONTENT_ENRICHMENT_SYSTEM` / `CONTENT_ENRICHMENT_USER`)

The most detailed prompt. Generates bilingual structured fields for every high-scoring item, grounded against web search results. System prompt specifies six field pairs (EN + ZH each):

| Field | Content | Length |
|---|---|---|
| `title_en` / `title_zh` | Clear headline | ≤15 words |
| `whats_new_en/zh` | What exactly happened — names, versions, numbers | 1-2 sentences |
| `why_it_matters_en/zh` | Significance + ecosystem impact | 1-2 sentences |
| `key_details_en/zh` | Technical specifics, caveats, limitations | 1-2 sentences |
| `background_en/zh` | Context for non-experts | 2-4 sentences |
| `community_discussion_en/zh` | Sentiment + key viewpoints from comments | 1-3 sentences |

Language rules enforced in system prompt:
```
CRITICAL — Language rules (MUST follow):
- All *_en fields MUST be written in English.
- All *_zh fields MUST be written in Simplified Chinese (简体中文). 绝对不能用英文写 _zh 字段的内容。
  Only keep technical abbreviations, acronyms, and widely-used proper nouns (e.g. "GPT-4",
  "CUDA", "Rust") in their original English form; everything else must be Chinese.
```

Grounding rule: `Only use URLs that appear verbatim in the search results above — do not invent or modify URLs.`

---

#### Summary Output Format

Markdown daily brief structure:
1. Header with date + filtering stats (N items fetched, M passed threshold)
2. Table of contents: `N. [title](anchor) — score/10`
3. Per-item sections: title + URL + score + summary + background + references (collapsible) + community discussion + tags
4. Bilingual with Pangu spacing between CJK and ASCII characters

---

## 3. hacker-podcast (`miantiao-me/hacker-podcast`)

**Purpose:** Automated Chinese-language podcast from Hacker News. Fetches top HN stories daily, generates bilingual summaries, synthesizes a two-host podcast script, converts to audio via TTS, distributes via RSS/Apple Podcasts/YouTube/Spotify.

### Pipeline Architecture

```
Hacker News Top Stories API (top 10 prod / 1 dev)
  → Jina content extraction (full article text)
  → GPT-4.1: per-story summary (article + HN comments integrated)
  → Store summaries in Cloudflare KV (1h TTL)
  [rate-limit pause between stories]
  → OPENAI_THINKING_MODEL: full podcast script (all summaries as input)
  → GPT-4.1 (or same model): blog post generation
  → GPT-4.1: episode intro (≤200 chars)
  → Edge TTS: segment-by-segment MP3 synthesis (男/女 markers split segments)
  → Cloudflare Browser Worker: merge all MP3 segments
  → Cloudflare R2: final audio stored
  → Cloudflare KV: metadata stored (date, stories, podcast text, blog, intro, audio URL)
  → Web app + RSS feed for distribution
```

Orchestrated as a Cloudflare Workflow with `step.do()` wrappers — each step has state persistence, so a crash mid-pipeline resumes from the last completed step. Retry policy: 5 retries, 10s delay, exponential backoff, 3-minute timeout on audio steps.

### AI / Model Stack

| Step | Model |
|---|---|
| Per-story summarization | `gpt-4.1` |
| Podcast script generation | `OPENAI_THINKING_MODEL` (configurable, likely `o3` or `o4-mini`) |
| Blog post generation | Same as summary model |
| Episode intro | Same as summary model |
| TTS audio synthesis | Edge TTS (Microsoft Azure, free tier) |

A "thinking model" is used specifically for the podcast script — the most creatively demanding step — while a standard model handles straightforward summarization. This is a cost-optimized split.

### Prompt Design

All prompts in `workflow/prompt.ts`. All prompts are in Chinese.

---

#### Story Summarization (`summarizeStoryPrompt`)

```
你是 Hacker News 播客的编辑助理，负责整理文章和社区讨论。

【输入格式】
- <title>：文章标题
- <article>：文章正文
- <comments>：Hacker News 社区评论

【工作目标】
1. 保留文章原文的核心内容，尽量使用原文表述
2. 筛选评论区有价值的观点（支持、反对、补充）
3. 专业术语首次出现时用括号简要解释

【输出要求】
- 直接输出正文，无需前言或标题
- 评论观点融入正文，不要单独列"评论区"章节
- 保持简洁，不做过度加工
```

Key design decision: comments are merged *into* the article summary rather than appended as a separate section — same pattern as Horizon's deduplication step.

---

#### Podcast Script (`summarizePodcastPrompt`)

Two-host persona system. Hosts are:

- **小雅 (Xiaoya)**: Product manager background. Explains complex concepts with analogies. Curious about product and business impact.
- **老冯 (Lao Feng)**: Senior engineer. Provides technical depth and industry war stories. Skeptical and grounded.

Style rules (paraphrased from prompt):
- Natural conversation tone: "像两个老朋友在咖啡馆闲聊" (like two old friends chatting at a café)
- No filler words (`嗯`, `啊`, `那个`)
- Concrete examples over abstractions
- Mix short and long sentences for rhythm
- Each host speaks in their defined voice — PM host drives with "why does this matter for users?", engineer host responds with "here's the technical reality"

Segment markers: `男:` and `女:` prefix each line, used downstream to split the script into TTS segments with different voices.

---

#### Blog Post (`summarizeBlogPrompt`)

Flexible template by article type:

| Article Type | Structure |
|---|---|
| 技术发布 (tech release) | What changed → Key features → Migration/impact |
| 深度分析 (deep analysis) | Core argument → Evidence → Implications |
| 事件/新闻 (news event) | What happened → Background → What's next |

Writing rules enforced:
- Lead with essential information (inverted pyramid)
- Active voice
- Specific sources, not vague attribution
- Banned words: `标志着` (marks), `革命性` (revolutionary)
- SEO-friendly markdown headers

---

#### Episode Intro (`introPrompt`)

```
你是 Hacker News 中文播客的编辑，为播客生成吸引人的极简摘要。

【目标】让读者一眼看到摘要就想点击收听。

【内容结构】
1. 开头用一句吸引人的话点明本期亮点
2. 列出本期讨论的 3-5 个核心话题
3. 可选：用一句话制造悬念或期待

【输出要求】
- 纯文本，不使用 Markdown
- 不超过 200 字
- 忽略评论区讨论内容
```

---

## Cross-Project Observations

### Pipeline Patterns

| Pattern | WorldMonitor | Horizon | hacker-podcast |
|---|---|---|---|
| Scoring/filtering before enrichment | — | ✅ (0-10 + threshold 6.0) | — |
| Semantic deduplication | — | ✅ (AI topic-level) | — |
| URL deduplication | — | ✅ (merge richest) | — |
| Comments integrated into summary | — | ✅ (merged into survivor) | ✅ (merged into article) |
| Bilingual EN/ZH output | — | ✅ (strict field pairs) | ✅ (Chinese primary) |
| Thinking model for creative step | — | — | ✅ (podcast script only) |
| Intermediate state checkpointing | — | — | ✅ (Cloudflare Workflows `step.do()`) |
| Web search grounding | — | ✅ (concept extraction → search → enrichment) | — |
| Local/private inference option | ✅ (Ollama) | — | — |

### Prompt Design Patterns

1. **JSON-only responses everywhere** — all three projects enforce structured JSON output; no freeform prose in critical pipeline steps. Horizon is most explicit: every prompt ends with `Respond with valid JSON only`.

2. **Rubric-based scoring beats vague instructions** — Horizon's 5-tier scoring rubric with explicit examples per tier produces consistent results. Vague "rate this 1-10" prompts drift. Our process-queue prompts use the `INSUFFICIENT_CONTENT` / `NOT_AI_RELEVANT` sentinel pattern for the same reason.

3. **Comments as signal, not noise** — Both Horizon and hacker-podcast integrate community comments into the article summary rather than discarding them. HN score + comment quality together are stronger relevance signals than the article alone.

4. **Role separation for bilingual output** — Horizon's `CRITICAL — Language rules` block with explicit per-field EN/ZH requirements and an exception list for proper nouns (`"GPT-4"`, `"CUDA"`, `"Rust"`) is the most thorough approach seen. Our current prompts use `TITLE_ZH` / `SUMMARY_ZH` field separation but do not enforce the exception list.

5. **Persona-driven podcast scripts** — hacker-podcast's two-host persona system (PM + engineer) with "coffee shop" naturalness requirement and banned-word lists produces higher-quality dialogue than single-narrator instructions. The `男:`/`女:` line markers elegantly solve the TTS segment split problem.

6. **Grounding against web search** — Horizon explicitly fetches web search results before the enrichment step and instructs the model to only cite URLs that appear verbatim in the results. This is a strong anti-hallucination measure for the `background` and `sources` fields.

### Cost Architecture

| Project | Cost strategy |
|---|---|
| WorldMonitor | Pro paywall gates AI chat; free tier is visualization only |
| Horizon | Single pipeline run per day; token usage tracked and reported; model-agnostic for cost switching |
| hacker-podcast | Thinking model only for the expensive creative step; cheap model for summarization; Edge TTS is free |

Our project: token economy via app token reserve/refund pattern; Groq free tier; single consolidated Groq call per article (34% reduction from 3-call design).

---

*Last updated: 2026-04-15*
