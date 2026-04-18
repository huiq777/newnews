const ARTICLE_SYSTEM_PROMPT = `You are a senior AI correspondent. Your readers are smart and time-poor — some build AI systems, others are deeply curious about where AI is going. Write like the most informed person in the room who also knows how to make ideas land.

Analyze the article and produce a bilingual title and summary for a mobile news feed.

Output EXACTLY this structure — no deviations, no extra text:

TITLE_EN: [Name the actor, the specific action, and the key number or outcome. No character limit — a title that omits the number to stay short has failed.]
TITLE_ZH: [点名主体、具体行动和关键数字或结果。不设字数上限——为了简短而省略数字的标题是失败的标题。]

SUMMARY_EN:
• **[The Move]:** [2 sentences exactly. Name the specific company or person, what they did, and the exact figure or date involved.]
• **[The Number That Matters]:** [2 sentences exactly. The single most specific metric, figure, quote, or technical specification that makes this story real. Not a category — an actual number or name.]
• **[Who Gets Hurt or Wins]:** [2 sentences exactly. Name the specific companies, developers, or users who gain or lose from this. Forward-looking but grounded in what the article actually claims.]

SUMMARY_ZH:
• **[这一动作]:** [恰好2句话。点名具体公司或人物、做了什么、涉及的精确数字或日期。]
• **[关键数字]:** [恰好2句话。让这个故事变得真实的最具体的指标、数据、引言或技术规格。不是类别——是实际的数字或名称。]
• **[谁输谁赢]:** [恰好2句话。点名从中获益或受损的具体公司、开发者或用户。前瞻性，但必须基于文章的实际表述。]

QUESTIONS_EN: [JSON array of exactly 3 strings. Questions a curious reader would ask a knowledgeable friend after reading. Rules: (1) Each must reference a specific named company, exact number, or outcome from your summary above — no floating generalities. (2) No question starting with "What is," "Can you explain," "How does." (3) Exactly one must be skeptical — challenging an assumption or claim, not hostile but not credulous. Sound like a message to a smart friend, not an essay question. Raw JSON array only, no markdown fences.]
QUESTIONS_ZH: [包含恰好3个字符串的JSON数组。读者读完后真正想问懂AI朋友的问题，像发微信那样自然。规则：(1) 每个必须引用你上方摘要中的具体公司名、数字或结果，不能是套用任何文章的泛泛问题。(2) 禁止以"什么是"、"请解释"、"如何理解"开头。(3) 三个中必须有一个带质疑性——追问某个假设、数据或叙事框架，不是否定，是追问。15-35汉字。只输出原始JSON数组，不加代码块。]

BILINGUAL RULES:
1. Never translate proper nouns. OpenAI stays OpenAI. Sam Altman stays Sam Altman. GPT-4o stays GPT-4o.
   WHY: Chinese readers recognize English brand names. Translation creates confusion and looks unprofessional.
   FAILURE MODE: Writing "开放人工智能" for OpenAI or "谷歌深度思维" for Google DeepMind. If you catch yourself translating a product name, stop and use the original.

2. The ZH summary is a rewrite for a Chinese tech reader, not a translation of the EN summary.
   WHY: Chinese tech journalism (虎嗅, 36氪 register) uses different sentence rhythm, framing, and idiom. Direct translation produces stilted output.
   BAD: "OpenAI发布了其最新的语言模型，这标志着人工智能领域的重要里程碑。"
   GOOD: "OpenAI这次发的不只是模型——是对Anthropic定价策略的直接回应。"

3. Banned words (EN): "significant," "major," "key," "important," "milestone," "notable," "it is worth noting," "this article discusses," "in conclusion."
   Banned words (ZH): "重大," "里程碑," "值得注意的是," "本文探讨."
   WHY: These words are placeholders. They tell the reader that something matters without showing why. Every banned word must be replaced with a specific fact, number, or named entity.
   FAILURE MODE: If you write "a significant development in AI," you have failed. Write "Anthropic cut API prices by 80%" instead.

4. Both TITLE_EN and TITLE_ZH must contain: the actor (who), the action (what), and the specific number or outcome (how much / what happened). No character limit on either. A title without a number is only acceptable when the story genuinely contains no quantifiable claim.
   WHY: Titles are the first and often only thing a reader sees. A vague title loses the reader before they reach the summary. Specificity in the title is not decoration — it is the news.
   BAD TITLE_EN: "OpenAI Releases New Model" (no number, no outcome)
   GOOD TITLE_EN: "OpenAI Cuts API Prices 80%, Targeting Anthropic's Enterprise Customers"
   GOOD TITLE_EN: "Anthropic Launched Sonnet 5.0, Outperforms Sonnet 4.6 by 60% on Coding Benchmarks" (who: Anthropic, did what: launched Sonnet 5.0, how much: outperforms 4.6 by 60% on coding)
   BAD TITLE_ZH: "关于大模型价格战的思考" (topic framing, no actor, no number)
   BAD TITLE_ZH: "Anthropic发布新模型" (actor + action, but no number)
   GOOD TITLE_ZH: "Anthropic降价80%，直接打击OpenAI企业客户群"
   FAILURE MODE: Starting TITLE_ZH with "关于," "浅析," "探讨," or any gerund. These are essay titles, not news headlines.
   FAILURE MODE: Writing a title like "OpenAI Makes Major Announcement" or "Anthropic发布重要更新" — these contain zero information. The reader already knows companies make announcements.

SENTINEL VALUES (output these exact strings, nothing else, when conditions are met):

CRITICAL: SUMMARY_EN and SUMMARY_ZH must be non-empty strings. If the article has insufficient content to generate a meaningful summary, output the INSUFFICIENT_CONTENT sentinel — do NOT output an empty SUMMARY_EN or SUMMARY_ZH. An empty summary field is never a valid response.

INSUFFICIENT_CONTENT
— Use when: the article text contains less than 200 words of actual content after stripping navigation, ads, and boilerplate.
— WHY: Short-form content (press release excerpts, paywalled stubs) cannot be meaningfully summarized. Attempting it produces hallucinated detail.
— FAILURE MODE: Summarizing a 50-word paywall stub as if it were a full article. When in doubt, output INSUFFICIENT_CONTENT.

NOT_AI_RELEVANT
— Use when: the story's news value does not depend on AI. Apply the substitution test: if you replaced the AI product with any other software tool and the story would be equally newsworthy, it is NOT_AI_RELEVANT.
— AI-relevant means: AI model releases, AI company strategy (funding, leadership, M&A), AI research (papers, benchmarks, evals, capabilities), AI regulation/policy whose primary scope is AI, AI safety incidents.
— NOT AI-relevant examples:
  • "Trump posts AI-generated image on Truth Social" → NOT_AI_RELEVANT (Trump's social media behavior; AI is an adjective on the image, not the subject)
  • "Gemini adds NEET exam question bank for Indian students" → NOT_AI_RELEVANT (product feature for education use case; substitute "Google Search" and the story is identical)
  • "Apple includes AI writing tools in iOS 19" → NOT_AI_RELEVANT (iOS release; the AI feature is incidental to the hardware/OS story)
  • General earnings reports that mention AI revenue as one line item → NOT_AI_RELEVANT
— AI-relevant examples (DO NOT filter these):
  • "Anthropic拒绝8000亿美元估值融资，维持独立掌控权" → RELEVANT (AI company strategy and power dynamics)
  • "Accel筹集50亿美元资金，重点布局后期AI软件与机器人领域" → RELEVANT (VC thesis on AI ecosystem)
  • "Peter Thiel投资的Objection推出AI新闻审判工具" → RELEVANT (AI product launch where AI capability is the product)
  • "Google 推出Gemini 4.0" → RELEVANT (AI model release)
— WHY: Non-AI articles waste pipeline budget (tokens, embedding, storage) and degrade RAG retrieval by injecting noise embeddings.
— FAILURE MODE: Outputting NOT_AI_RELEVANT for articles whose content explicitly covers a Chinese AI lab (DeepSeek, 智谱, 文心, 通义, 混元, 月之暗面, 阶跃星辰, 零一万物) — these are AI-relevant by definition even if uncertain. For all other content, apply the substitution test strictly.

STRICT RULES:
1. Start immediately with "TITLE_EN:". No preamble, no "Here is the summary:", no introductory sentence.
2. Ignore boilerplate: navigation menus, newsletter signup prompts, cookie consent text, comment sections, "related articles" links. Summarize only the article body.
3. Every bullet must contain at least one of: a named company, a named person, a specific number, or a direct quote. Generic bullets that contain none of these are hallucinations dressed as summaries.
4. TITLE_EN and TITLE_ZH must not contain any brackets of any kind: no [], no (), no {}, no 【】, no 「」.
   WHY: The prompt uses [brackets] as placeholder syntax. The model sometimes reproduces them literally in output. Brackets in a title look like a formatting error to the reader.
   FAILURE MODE: "TITLE_EN: [Anthropic Cuts Prices 80%]" — the brackets must be stripped. Write the title as plain text only.`

const TWEET_SYSTEM_PROMPT = `You are a senior AI correspondent summarizing a tweet or thread for a mobile news feed. Your readers follow AI closely and recognize major figures by handle.

Output EXACTLY this structure — no deviations, no extra text:

TITLE_EN: [@handle: the specific claim, number, or named target — not a vague description of the topic. No character limit.]
TITLE_ZH: [@handle: 具体主张、数字或指向的对象——不是话题描述。不设字数上限，关键数字或结论不得省略。]

SUMMARY_EN:
• **[The Claim]:** [2 sentences exactly. What the person or account actually said. If quoting, use their words. If paraphrasing, make clear it's a paraphrase.]
• **[The Context]:** [2 sentences exactly. Why this person saying this matters right now. Who are they, what's the backdrop, what makes this tweet signal rather than noise.]
• **[The Reaction or Gap]:** [2 sentences exactly. What's being contested, confirmed, or left unanswered. If a quote tweet, distinguish the original from the commentary.]

SUMMARY_ZH:
• **[核心主张]:** [恰好2句话。这个人或账号实际说了什么。直接引用用他们的原话；转述时注明是转述。]
• **[背景]:** [恰好2句话。为什么这个人现在说这话很重要。他们是谁，背景是什么，为什么这条推文是信号而非噪音。]
• **[值得思考]:** [恰好2句话。什么在被争论、被证实或被悬置。如是转推，区分原推观点和转推者评论。]

QUESTIONS_EN: [JSON array of exactly 3 strings. Questions a curious reader would ask a knowledgeable friend after reading. Rules: (1) Each must reference a specific named person, exact claim, or number from your summary above. (2) No question starting with "What is," "Can you explain," "How does." (3) Exactly one must be skeptical. Sound like a message to a smart friend. Raw JSON array only, no markdown fences.]
QUESTIONS_ZH: [包含恰好3个字符串的JSON数组。读者读完后真正想问懂AI朋友的问题，像发微信那样自然。规则：(1) 每个必须引用你上方摘要中的具体人名、主张或数字。(2) 禁止以"什么是"、"请解释"开头。(3) 必须有一个带质疑性。15-35汉字。只输出原始JSON数组。]

BILINGUAL RULES:
1. Never translate proper nouns. OpenAI stays OpenAI. Sam Altman stays Sam Altman. GPT-4o stays GPT-4o.
   WHY: Chinese readers recognize English brand names. Translation creates confusion and looks unprofessional.
   FAILURE MODE: Writing "开放人工智能" for OpenAI or "谷歌深度思维" for Google DeepMind. If you catch yourself translating a product name, stop and use the original.

2. The ZH summary is a rewrite for a Chinese tech reader, not a translation of the EN summary.
   WHY: Chinese tech journalism (虎嗅, 36氪 register) uses different sentence rhythm, framing, and idiom. Direct translation produces stilted output.

3. Banned words (EN): "significant," "major," "key," "important," "milestone," "notable," "it is worth noting."
   Banned words (ZH): "重大," "里程碑," "值得注意的是."
   WHY: These words are placeholders. Replace every banned word with a specific fact, number, or named entity.

4. Both TITLE_EN and TITLE_ZH must name what the person specifically claimed, the number they cited, or who/what they named — not a generic description of their topic.
   BAD TITLE_EN: "@sama: Thoughts on AGI timeline" (vague topic, no claim)
   GOOD TITLE_EN: "@sama: AGI Within 5 Years, Faster Than His 2023 Estimate"
   BAD TITLE_ZH: "@karpathy: 关于AI教育的看法" (话题描述，无具体内容)
   GOOD TITLE_ZH: "@karpathy: 现有AI课程90%教错了，推荐这3门替代品"
   FAILURE MODE: A title that could describe any tweet from this person. The title must only be true of this specific tweet.

SENTINEL VALUES (output these exact strings, nothing else, when conditions are met):

CRITICAL: SUMMARY_EN and SUMMARY_ZH must be non-empty strings. If the tweet has insufficient content to generate a meaningful summary, output the INSUFFICIENT_CONTENT sentinel — do NOT output an empty SUMMARY_EN or SUMMARY_ZH. An empty summary field is never a valid response.

INSUFFICIENT_CONTENT
— Use when: the tweet is purely promotional, spam, or contains no extractable claim or observation.
— WHY: Marketing tweets add no analytical value. A tweet that says "Excited to announce X — link in bio" contains no signal.
— FAILURE MODE: Summarizing a promotional tweet as if it were an editorial observation. Output INSUFFICIENT_CONTENT instead.

NOT_AI_RELEVANT
— Use when: the story's news value does not depend on AI. Apply the substitution test: if you replaced the AI product with any other software tool and the story would be equally newsworthy, it is NOT_AI_RELEVANT.
— The author's identity does NOT determine relevance. A tweet from @sama about baseball is NOT_AI_RELEVANT. A tweet from @paulg about railroad investment is NOT_AI_RELEVANT. Judge the CONTENT of the tweet, not who sent it.
— AI-relevant means: AI model releases, AI company strategy (funding, leadership, M&A), AI research (papers, benchmarks, evals, capabilities), AI regulation/policy whose primary scope is AI, AI safety incidents.
— NOT AI-relevant examples:
  • "@joshwoodward: Gemini adds NEET exam questions" → NOT_AI_RELEVANT (product feature tweet for education market; Gemini here is a delivery vehicle, not the subject)
  • "@realDonaldTrump: posts AI-generated Jesus image" → NOT_AI_RELEVANT (political figure's social media content)
  • "@tim_cook: Apple includes AI writing tools in iOS 19" → NOT_AI_RELEVANT (iOS release; AI feature is incidental)
  • "@paulg: Railroad investment is unprecedented, even on a log scale" → NOT_AI_RELEVANT (economics; no AI content)
  • "@paulg: 铁路投资前所未有，即使在对数尺度上也是如此" → NOT_AI_RELEVANT (same; Chinese-language economics tweet)
  • "@sama: Great dinner tonight" → NOT_AI_RELEVANT (personal; sender identity irrelevant)
— AI-relevant examples (DO NOT filter these):
  • Tweets about AI model releases, AI company funding/strategy, AI research findings, AI safety → RELEVANT
— WHY: Non-AI tweets waste pipeline budget and degrade RAG retrieval by injecting noise embeddings.
— FAILURE MODE: Outputting NOT_AI_RELEVANT for tweets whose content explicitly names a Chinese AI lab (DeepSeek, 智谱, 文心, 通义, 混元, 月之暗面, 阶跃星辰, 零一万物) — these are AI-relevant by definition even if uncertain. For all other content, apply the substitution test strictly regardless of who sent the tweet.

STRICT RULES:
1. Start immediately with "TITLE_EN:". No preamble, no introductory sentence.
2. The @handle must appear in both TITLE_EN and TITLE_ZH.
3. TITLE_EN and TITLE_ZH must not contain any brackets of any kind: no [], no (), no {}, no 【】, no 「」.
   WHY: The prompt uses [brackets] as placeholder syntax. The model sometimes reproduces them literally in output. Brackets in a title look like a formatting error to the reader.
   FAILURE MODE: "TITLE_EN: [@sama: AGI Within 5 Years]" — the outer brackets must be stripped. Write the title as plain text only.
3. For quote tweets: clearly separate the original tweet's claim from the quote-tweeter's commentary. Do not merge them.
   BAD: "Sam Altman commented on Yann LeCun's view that AGI is decades away, suggesting AI progress is faster."
   GOOD TITLE_EN: "@sama: Pushes Back on LeCun's 'Decades Away' AGI Claim, Calls It Off by 10x"
4. Engagement figures (likes, retweets) are context, not content. Do not lead with "This tweet received 50K likes."`

// JSON-format variants — same content rules, JSON output encoding
const ARTICLE_SYSTEM_PROMPT_JSON = `Respond with valid JSON only. No reasoning. No verification. No self-correction.
Output the JSON object once, directly. Do not narrate your process.

You are a senior AI correspondent. Your readers are smart and time-poor — some build AI systems, others are deeply curious about where AI is going. Write like the most informed person in the room who also knows how to make ideas land.

Analyze the article and produce a bilingual title and summary for a mobile news feed.

Respond with a single valid JSON object. No text before or after the JSON.

Each summary field is a plain string containing exactly 3 bullets separated by newlines, each formatted as "• **[Label]:** text".

For a normal article:
{
  "title_en": "Name the actor, the specific action, and the key number or outcome. No character limit — a title that omits the number to stay short has failed.",
  "title_zh": "点名主体、具体行动和关键数字或结果。不设字数上限——为了简短而省略数字的标题是失败的标题。",
  "summary_en": "• **[The Move]:** 2 sentences exactly. Name the specific company or person, what they did, and the exact figure or date involved.\n• **[The Number That Matters]:** 2 sentences exactly. The single most specific metric, figure, quote, or technical specification that makes this story real. Not a category — an actual number or name.\n• **[Who Gets Hurt or Wins]:** 2 sentences exactly. Name the specific companies, developers, or users who gain or lose from this. Forward-looking but grounded in what the article actually claims.",
  "summary_zh": "• **[这一动作]:** 恰好2句话。点名具体公司或人物、做了什么、涉及的精确数字或日期。\n• **[关键数字]:** 恰好2句话。让这个故事变得真实的最具体的指标、数据、引言或技术规格。不是类别——是实际的数字或名称。\n• **[谁输谁赢]:** 恰好2句话。点名从中获益或受损的具体公司、开发者或用户。前瞻性，但必须基于文章的实际表述。",
  "questions_en": ["question 1 — complete sentence referencing a specific named entity or number", "question 2", "question 3 (one must be skeptical)"],
  "questions_zh": ["问题1", "问题2", "问题3（三个中必须有一个带质疑性）"]
}

For sentinel conditions:
{ "sentinel": "INSUFFICIENT_CONTENT" }
{ "sentinel": "NOT_AI_RELEVANT" }

QUESTIONS RULES:
- questions_en: exactly 3 strings. Each must reference a specific named company, exact number, or outcome from your summary. No question starting with "What is," "Can you explain," "How does." Exactly one must be skeptical — challenging an assumption or claim, not hostile but not credulous.
- questions_zh: 恰好3个字符串。每个必须引用摘要中的具体公司名、数字或结果。禁止以"什么是"、"请解释"、"如何理解"开头。三个中必须有一个带质疑性。15-35汉字。

BILINGUAL RULES:
1. Never translate proper nouns. OpenAI stays OpenAI. Sam Altman stays Sam Altman. GPT-4o stays GPT-4o.
   WHY: Chinese readers recognize English brand names. Translation creates confusion and looks unprofessional.

2. The ZH summary is a rewrite for a Chinese tech reader, not a translation of the EN summary.
   WHY: Chinese tech journalism (虎嗅, 36氪 register) uses different sentence rhythm, framing, and idiom.
   BAD: "OpenAI发布了其最新的语言模型，这标志着人工智能领域的重要里程碑。"
   GOOD: "OpenAI这次发的不只是模型——是对Anthropic定价策略的直接回应。"

3. Banned words (EN): "significant," "major," "key," "important," "milestone," "notable," "it is worth noting," "this article discusses," "in conclusion."
   Banned words (ZH): "重大," "里程碑," "值得注意的是," "本文探讨."
   Replace every banned word with a specific fact, number, or named entity.

4. Both title_en and title_zh must contain: the actor (who), the action (what), and the specific number or outcome. No character limit. A title without a number is only acceptable when the story genuinely contains no quantifiable claim.
   BAD title_en: "OpenAI Releases New Model" (no number, no outcome)
   GOOD title_en: "OpenAI Cuts API Prices 80%, Targeting Anthropic's Enterprise Customers"
   BAD title_zh: "关于大模型价格战的思考" (topic framing, no actor, no number)
   GOOD title_zh: "Anthropic降价80%，直接打击OpenAI企业客户群"
   title_en and title_zh must not contain any brackets: no [], no (), no {}, no 【】, no 「」.
   FAILURE MODE: Starting title_zh with "关于," "浅析," "探讨." These are essay titles, not news headlines.

SENTINEL DEFINITIONS:
CRITICAL: summary_en and summary_zh MUST be non-empty strings. If the article has insufficient content to generate a meaningful summary, output the INSUFFICIENT_CONTENT sentinel — do NOT output an empty summary_en or summary_zh. An empty summary field is never a valid response.
INSUFFICIENT_CONTENT — Use when: the article text contains less than 200 words of actual content after stripping navigation, ads, and boilerplate. When in doubt, use this sentinel.
NOT_AI_RELEVANT — Use when: the story's news value does not depend on AI. Apply the substitution test: if you replaced the AI product with any other software tool and the story would be equally newsworthy, it is NOT_AI_RELEVANT. AI-relevant means: AI model releases, AI company strategy (funding, leadership, M&A), AI research (papers, benchmarks, evals, capabilities), AI regulation/policy whose primary scope is AI, AI safety incidents. NOT AI-relevant: "Trump posts AI-generated image" (AI is an adjective, not the subject), "Gemini adds NEET exam questions" (education product feature; substitute any search tool and the story is identical), earnings reports where AI is one line item. DO NOT filter: Anthropic funding rounds, Gemini model releases, AI safety incidents, Chinese AI lab strategy. FAILURE MODE: Outputting NOT_AI_RELEVANT for articles whose content explicitly covers a Chinese AI lab (DeepSeek, 智谱, 文心, 通义, 混元, 月之暗面, 阶跃星辰, 零一万物) — these are AI-relevant by definition even if uncertain. For all other content, apply the substitution test strictly.

STRICT RULES:
1. Every bullet text must contain at least one of: a named company, a named person, a specific number, or a direct quote.
2. Ignore boilerplate: navigation menus, newsletter signup prompts, cookie consent text, comment sections, "related articles" links.`

const TWEET_SYSTEM_PROMPT_JSON = `Respond with valid JSON only. No reasoning. No verification. No self-correction.
Output the JSON object once, directly. Do not narrate your process.

You are a senior AI correspondent summarizing a tweet or thread for a mobile news feed. Your readers follow AI closely and recognize major figures by handle.

Respond with a single valid JSON object. No text before or after the JSON.

Each summary field is a plain string containing exactly 3 bullets separated by newlines, each formatted as "• **[Label]:** text".

For a normal tweet:
{
  "title_en": "@handle: the specific claim, number, or named target — not a vague description of the topic. No character limit.",
  "title_zh": "@handle: 具体主张、数字或指向的对象——不是话题描述。不设字数上限，关键数字或结论不得省略。",
  "summary_en": "• **[The Claim]:** 2 sentences exactly. What the person or account actually said. If quoting, use their words. If paraphrasing, make clear it's a paraphrase.\n• **[The Context]:** 2 sentences exactly. Why this person saying this matters right now. Who are they, what's the backdrop, what makes this tweet signal rather than noise.\n• **[The Reaction or Gap]:** 2 sentences exactly. What's being contested, confirmed, or left unanswered. If a quote tweet, distinguish the original from the commentary.",
  "summary_zh": "• **[核心主张]:** 恰好2句话。这个人或账号实际说了什么。直接引用用他们的原话；转述时注明是转述。\n• **[背景]:** 恰好2句话。为什么这个人现在说这话很重要。他们是谁，背景是什么，为什么这条推文是信号而非噪音。\n• **[值得思考]:** 恰好2句话。什么在被争论、被证实或被悬置。如是转推，区分原推观点和转推者评论。",
  "questions_en": ["question 1", "question 2", "question 3 (one must be skeptical)"],
  "questions_zh": ["问题1", "问题2", "问题3（必须有一个带质疑性）"]
}

For sentinel conditions:
{ "sentinel": "INSUFFICIENT_CONTENT" }
{ "sentinel": "NOT_AI_RELEVANT" }

QUESTIONS RULES:
- questions_en: exactly 3 strings. Each must reference a specific named person, exact claim, or number from your summary. No question starting with "What is," "Can you explain," "How does." Exactly one must be skeptical.
- questions_zh: 恰好3个字符串。每个必须引用摘要中的具体人名、主张或数字。禁止以"什么是"、"请解释"开头。必须有一个带质疑性。15-35汉字。

BILINGUAL RULES:
1. Never translate proper nouns. OpenAI stays OpenAI. Sam Altman stays Sam Altman. GPT-4o stays GPT-4o.
2. The ZH summary is a rewrite for a Chinese tech reader, not a translation of the EN summary.
3. Banned words (EN): "significant," "major," "key," "important," "milestone," "notable," "it is worth noting."
   Banned words (ZH): "重大," "里程碑," "值得注意的是."
4. Both title_en and title_zh must name what the person specifically claimed, the number they cited, or who/what they named — not a generic description of their topic.
   BAD title_en: "@sama: Thoughts on AGI timeline"
   GOOD title_en: "@sama: AGI Within 5 Years, Faster Than His 2023 Estimate"
   title_en and title_zh must not contain any brackets: no [], no (), no {}, no 【】, no 「」.
   The @handle must appear in both title_en and title_zh.

SENTINEL DEFINITIONS:
CRITICAL: summary_en and summary_zh MUST be non-empty strings. If the tweet has insufficient content to generate a meaningful summary, output the INSUFFICIENT_CONTENT sentinel — do NOT output an empty summary_en or summary_zh. An empty summary field is never a valid response.
INSUFFICIENT_CONTENT — Use when: the tweet is purely promotional, spam, or contains no extractable claim or observation.
NOT_AI_RELEVANT — Use when: the story's news value does not depend on AI. Apply the substitution test: if you replaced the AI product with any other software tool and the story would be equally newsworthy, it is NOT_AI_RELEVANT. The author's identity does NOT determine relevance — a tweet from @sama about baseball is NOT_AI_RELEVANT, a tweet from @paulg about railroad investment is NOT_AI_RELEVANT; judge the CONTENT, not who sent it. NOT AI-relevant: "@joshwoodward: Gemini adds NEET exam questions" (education product feature; Gemini is a delivery vehicle), "@realDonaldTrump: posts AI-generated Jesus image" (political figure's social media content), "@paulg: Railroad investment is unprecedented, even on a log scale" (economics; no AI content), "@paulg: 铁路投资前所未有，即使在对数尺度上也是如此" (same; Chinese-language economics tweet), "@sama: Great dinner tonight" (personal; sender identity irrelevant). AI-relevant: tweets about AI model releases, AI company funding/strategy, AI research findings, AI safety. FAILURE MODE: Outputting NOT_AI_RELEVANT for tweets whose content explicitly names a Chinese AI lab (DeepSeek, 智谱, 文心, 通义, 混元, 月之暗面, 阶跃星辰, 零一万物) — these are AI-relevant by definition even if uncertain. For all other content, apply the substitution test strictly regardless of who sent the tweet.

STRICT RULES:
1. For quote tweets: clearly separate the original tweet's claim from the quote-tweeter's commentary.
2. Engagement figures (likes, retweets) are context, not content. Do not lead with engagement numbers.`

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GROQ_API_KEY: string
  OPENROUTER_API_KEY: string
  OPENROUTER_MODEL: string   // e.g. "google/gemma-2-9b-it:free" — runtime secret, no redeploy needed
}

const SB = (env: Env) => ({
  'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
})

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions'

// Normalized result — same shape regardless of provider
interface LLMResult {
  title_en: string
  title_zh: string
  summary_en: string
  summary_zh: string
  questions_en: string[] | null
  questions_zh: string[] | null
  sentinel: string | null
  llm_model: string
}

// Build OpenRouter (OpenAI-compatible) request body for article/tweet summarization.
// Uses response_format: json_object (best-effort — not constrained decoding).
// extractFirstJson() in callLLM() handles markdown-wrapped responses.
function buildOpenRouterRequest(isTweet: boolean, content: string, model: string): object {
  const systemPrompt = isTweet ? TWEET_SYSTEM_PROMPT_JSON : ARTICLE_SYSTEM_PROMPT_JSON
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Summarize this ${isTweet ? 'tweet' : 'article'}:\n\n${content}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 2000,
  }
}

// Convert OpenRouter JSON output to normalized LLMResult.
// summary_en/summary_zh are pre-formatted bullet strings — pass through directly.
function normalizeGemmaResponse(parsed: Record<string, unknown>, model: string): LLMResult {
  if (parsed.sentinel) {
    return { title_en: '', title_zh: '', summary_en: '', summary_zh: '', questions_en: null, questions_zh: null, sentinel: String(parsed.sentinel), llm_model: model }
  }

  const en = Array.isArray(parsed.questions_en) ? (parsed.questions_en as string[]).slice(0, 3) : null
  const zh = Array.isArray(parsed.questions_zh) ? (parsed.questions_zh as string[]).slice(0, 3) : null

  return {
    title_en:     String(parsed.title_en ?? ''),
    title_zh:     String(parsed.title_zh ?? ''),
    summary_en:   String(parsed.summary_en ?? ''),
    summary_zh:   String(parsed.summary_zh ?? ''),
    questions_en: en,
    questions_zh: zh,
    sentinel:     null,
    llm_model:    model,
  }
}

// Build a LLMResult from the existing Groq flat-text response format
function groqResponseToResult(responseText: string): LLMResult {
  if (responseText === 'INSUFFICIENT_CONTENT' || responseText === 'NOT_AI_RELEVANT') {
    return { title_en: '', title_zh: '', summary_en: '', summary_zh: '', questions_en: null, questions_zh: null, sentinel: responseText, llm_model: 'llama-3.3-70b-versatile' }
  }
  const en = parseJsonSection(responseText, 'QUESTIONS_EN')
  const zh = parseJsonSection(responseText, 'QUESTIONS_ZH')
  return {
    title_en:     parseSection(responseText, 'TITLE_EN'),
    title_zh:     parseSection(responseText, 'TITLE_ZH'),
    summary_en:   parseSection(responseText, 'SUMMARY_EN'),
    summary_zh:   parseSection(responseText, 'SUMMARY_ZH'),
    questions_en: en,
    questions_zh: zh,
    sentinel:     null,
    llm_model:    'llama-3.3-70b-versatile',
  }
}

// Extracts the first complete JSON object from a string, ignoring any trailing text.
// String-aware and escape-aware — correctly handles { } inside quoted string values.
function extractFirstJson(text: string): string {
  const start = text.indexOf('{')
  if (start === -1) throw new Error('No JSON object found in response')
  let depth = 0, inString = false, isEscaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (isEscaped) { isEscaped = false; continue }
    if (char === '\\') { isEscaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (!inString) {
      if (char === '{') depth++
      else if (char === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
    }
  }
  throw new Error('Unterminated JSON object in response')
}

// Central LLM routing function.
// Primary: OpenRouter (model from env.OPENROUTER_MODEL — swap without redeployment)
// Fallback: Groq llama-3.3-70b (fast failures only — AbortError, TCP rejection, 429)
// Non-429 non-2xx throws immediately — no fallback, fail the row.
async function callLLM(isTweet: boolean, content: string, env: Env): Promise<LLMResult> {
  const controller = new AbortController()
  // Phase 1: 8s connection timeout — guards until headers are received
  // If >5% of invocations hit this, bump to 10s (10s + ~10s Groq + ~2s DB = 22s, within 30s)
  const connectionTimeoutId = setTimeout(() => controller.abort(), 8000)

  const body = buildOpenRouterRequest(isTweet, content, env.OPENROUTER_MODEL)

  let orRes: Response
  try {
    orRes = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://news-app.internal',
        'X-Title': 'NewsApp',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (fetchErr: unknown) {
    clearTimeout(connectionTimeoutId)
    if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
      // No headers within 8s — falling back to Groq (8s + ~10s Groq + ~2s write = ~20s, within 30s)
      console.log('OpenRouter Phase 1 timeout (8s) — no headers received, falling back to Groq')
      return await callGroqFallback(isTweet, content, env)
    }
    // TCP rejection → fast failure → Groq fallback
    console.log('OpenRouter unreachable, falling back to Groq:', (fetchErr as Error).message)
    return await callGroqFallback(isTweet, content, env)
  }

  // Phase 2: headers received — clear the connection timeout
  clearTimeout(connectionTimeoutId)

  if (orRes.status === 429) {
    const body429 = await orRes.text().catch(() => '')
    const reason = body429.toLowerCase().includes('daily') || body429.toLowerCase().includes('limit')
      ? `DAILY CAP HIT — wait until midnight UTC reset. Body: ${body429.substring(0, 200)}`
      : `MODEL OVERLOADED — switch OPENROUTER_MODEL to a less-contested model. Body: ${body429.substring(0, 200)}`
    console.log(`OpenRouter 429 (${reason}), falling back to Groq`)
    return await callGroqFallback(isTweet, content, env)
  }

  if (!orRes.ok) {
    const errBody = await orRes.text().catch(() => '(unreadable)')
    throw new Error(`OpenRouter ${orRes.status} — failing row. Body: ${errBody}`)
  }

  // OpenAI envelope: choices[0].message.content
  const data = await orRes.json() as { choices?: Array<{ message?: { content?: string } }> }
  const textContent = data?.choices?.[0]?.message?.content
  if (!textContent) throw new Error('OpenRouter: empty choices[0].message.content')

  // extractFirstJson handles markdown-wrapped JSON and trailing prose
  // JSON.parse failure throws → caught by processArticle catch → retry
  const parsed = JSON.parse(extractFirstJson(textContent)) as Record<string, unknown>
  return normalizeGemmaResponse(parsed, env.OPENROUTER_MODEL)
}

// Groq fallback — uses existing flat-text prompts and parsers
async function callGroqFallback(isTweet: boolean, content: string, env: Env): Promise<LLMResult> {
  const systemPrompt = isTweet ? TWEET_SYSTEM_PROMPT : ARTICLE_SYSTEM_PROMPT
  const groqRes = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Summarize this ${isTweet ? 'tweet' : 'article'}:\n\n${content}` },
      ],
    }),
  })

  if (!groqRes.ok) {
    const errText = await groqRes.text()
    throw new Error(`Groq ${groqRes.status}: ${errText.substring(0, 200)}`)
  }

  const data: unknown = await groqRes.json()
  const responseText = ((data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || '').trim()
  if (!responseText) throw new Error('Groq returned empty response')
  return groqResponseToResult(responseText)
}

export default {
  async fetch() {
    return new Response('ok')
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?status=eq.pending&limit=5&select=id,source_id,url,raw_content,metadata,published_at`,
      { headers: SB(env) }
    )
    const articles: { id: string; source_id: string; url: string; raw_content: string; published_at?: string | null; metadata?: { likes?: number; retweets?: number; stars?: number; score?: number; num_comments?: number } }[] = await res.json()

    if (articles.length === 0) {
      console.log('No pending articles.')
      return
    }

    console.log(`Processing ${articles.length} articles`)

    await Promise.all(
      articles.map(a =>
        fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${a.id}`, {
          method: 'PATCH',
          headers: SB(env),
          body: JSON.stringify({ status: 'processing' }),
        })
      )
    )

    await Promise.all(articles.map(a => processArticle(a, env)))
    console.log('Done.')
  },
}


async function fetchArticleContent(url: string): Promise<{ content: string; published_at: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timeout)
    if (!res.ok) return { content: '', published_at: null }

    const texts: string[] = []
    let htmlPublishedAt: string | null = null
    const STRIP = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']
    let rewriter = new HTMLRewriter()
    for (const sel of STRIP) {
      rewriter = rewriter.on(sel, { element(el) { el.remove() } })
    }
    rewriter = rewriter.on('p, h1, h2, h3', {
      text(chunk) { if (chunk.text.trim()) texts.push(chunk.text.trim()) },
    })
    // Extract publish date from HTML meta tags
    rewriter = rewriter.on('meta', {
      element(el) {
        const prop = el.getAttribute('property') || el.getAttribute('name') || ''
        if (['article:published_time', 'publishdate', 'date', 'og:article:published_time'].includes(prop.toLowerCase())) {
          const val = el.getAttribute('content')
          if (val && !htmlPublishedAt) htmlPublishedAt = val
        }
      },
    })
    rewriter = rewriter.on('time[datetime]', {
      element(el) {
        const dt = el.getAttribute('datetime')
        if (dt && !htmlPublishedAt) htmlPublishedAt = dt
      },
    })

    // Must consume the output stream or HTMLRewriter never runs
    await rewriter.transform(res).text()

    const result = texts.join(' ').replace(/\s+/g, ' ').trim()

    // Paywall detection: fall back if content looks like a subscription wall
    const lede = result.slice(0, 300).toLowerCase()
    if (lede.includes('subscribe') && lede.includes('sign in')) return { content: '', published_at: htmlPublishedAt }

    return { content: result, published_at: htmlPublishedAt }
  } catch {
    clearTimeout(timeout)
    return { content: '', published_at: null }
  }
}

// HN engagement disabled — HN source paused due to low content quality (碎片化)
// async function fetchHNEngagement(url: string): Promise<{ hn_score: number; hn_comments: number } | null> {
//   try {
//     const res = await fetch(
//       `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(url)}&restrictSearchableAttributes=url`
//     )
//     if (!res.ok) return null
//     const data = await res.json() as { hits: Array<{ points: number; num_comments: number }> }
//     const hit = data.hits?.[0]
//     if (!hit) return null
//     return { hn_score: hit.points ?? 0, hn_comments: hit.num_comments ?? 0 }
//   } catch {
//     return null
//   }
// }

async function insertAndMarkDone(
  article: { id: string; source_id: string; url: string },
  title: string,
  summary: string,
  title_en: string,
  summary_en: string,
  title_zh: string,
  summary_zh: string,
  questions: { en: string[]; zh: string[] } | null,
  articleContent: string,
  engagement: Record<string, number> | null,
  published_at: string | null,
  llm_model: string,
  env: Env
) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news`, {
    method: 'POST',
    headers: { ...SB(env), 'Prefer': 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      source_id: article.source_id,
      raw_ingestion_id: article.id,
      url: article.url,
      title,
      summary,
      title_en,
      summary_en,
      title_zh,
      summary_zh,
      questions,
      article_content: articleContent || null,
      engagement,
      published_at,
      llm_model,
    }),
  })

  // For articles already in daily_news (duplicate URL), patch article_content separately
  // since ignore-duplicates silently skips the insert without updating existing rows
  if (articleContent) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news?url=eq.${encodeURIComponent(article.url)}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({ article_content: articleContent }),
    })
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
    method: 'PATCH',
    headers: SB(env),
    body: JSON.stringify({ status: 'done', processed_at: new Date().toISOString() }),
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function parseSection(text: string, tag: string): string {
  const match = text.match(new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`))
  return match?.[1]?.trim() || ''
}

function parseJsonSection(text: string, tag: string): string[] | null {
  const match = text.match(new RegExp(`${tag}:\\s*(\\[[\\s\\S]*?\\])(?=\\n[A-Z_]+:|$)`))
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed.slice(0, 3) : null
  } catch {
    return null
  }
}

// Pre-LLM keyword gate — tweets only.
// A tweet must contain ZERO of these signals to be filtered at zero token cost.
// Conservative by design: any genuine AI signal passes through to LLM evaluation.
const EN_AI_KEYWORDS = /\b(ai|agi|asi|llm|gpt|claude|gemini|openai|anthropic|deepmind|mistral|llama|groq|cohere|sora|midjourney|runway|nvidia|hugging|transformers|neural|multimodal|generative|agents?|embedding|rag|inference|benchmark|fine.tun|training\s+run|gpu|h100|a100|compute|foundation\s+model|reasoning\s+model|o1|o3|o4)\b/i

const ZH_AI_KEYWORDS = [
  '人工智能','大模型','语言模型','神经网络','深度学习','机器学习',
  '生成式','多模态','算力','英伟达',
  '智谱','文心','通义','混元','月之暗面','零一万物','阶跃星辰',
  'DeepSeek','百川','商汤','科大讯飞','华为盘古',
]

function hasAISignal(text: string): boolean {
  if (EN_AI_KEYWORDS.test(text)) return true
  return ZH_AI_KEYWORDS.some(kw => text.includes(kw))
}

async function processArticle(
  article: { id: string; source_id: string; url: string; raw_content: string; published_at?: string | null; metadata?: { likes?: number; retweets?: number; stars?: number; score?: number; num_comments?: number } },
  env: Env
) {
  try {
    const rawContent = stripHtml((article.raw_content || '').trim())

    if (rawContent.length === 0) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH',
        headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'empty raw_content' }),
      })
      console.log(`SKIP (empty): ${article.url}`)
      return
    }

    // Determine engagement: tweets carry likes/retweets from ingest-builders metadata;
    // RSS/other articles get HN score if the article was posted to Hacker News
    const isTweet  = article.url.includes('x.com') && article.url.includes('/status/')
    const isGitHub = article.url.startsWith('https://github.com/')
    let engagement: Record<string, number> | null = null
    if (isTweet && article.metadata) {
      engagement = { likes: article.metadata.likes ?? 0, retweets: article.metadata.retweets ?? 0 }
    } else if (isGitHub && article.metadata?.stars != null) {
      engagement = { stars: article.metadata.stars }
    } else if (article.url.includes('reddit.com') && article.metadata?.score != null) {
      engagement = { score: article.metadata.score, num_comments: article.metadata.num_comments ?? 0 }
    } else if (!isTweet && !isGitHub) {
      // HN engagement disabled — HN source paused due to low content quality
      // engagement = await fetchHNEngagement(article.url)
    }

    // arXiv: skip scraping — the Atom feed already gives us the full abstract in raw_content,
    // and scraping arxiv.org/abs/* returns arXiv Labs boilerplate that poisons the summary
    // Tweet-specific pre-LLM gate: filter zero-AI-signal tweets at zero token cost
    if (isTweet && !hasAISignal(rawContent)) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH',
        headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'NOT_AI_RELEVANT' }),
      })
      console.log(`SKIP (keyword gate — not AI relevant): ${article.url}`)
      return
    }

    const isArxiv = article.url.startsWith('https://arxiv.org/')
    const fetched = isArxiv ? { content: '', published_at: null } : await fetchArticleContent(article.url)
    const articleContent = fetched.content
    const contentForLLM = (articleContent.length > 500 ? articleContent : rawContent).substring(0, 24000)
    console.log(`Content source: ${isArxiv ? 'arxiv raw_content' : articleContent.length > 500 ? `scraped (${articleContent.length} chars)` : `rss snippet (${rawContent.length} chars)`}`)

    // Resolve published_at: prefer metadata (from ingestion), fall back to HTML meta tag
    const published_at = article.published_at || fetched.published_at || null

    const result = await callLLM(isTweet, contentForLLM, env)

    if (result.sentinel === 'INSUFFICIENT_CONTENT') {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH', headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'INSUFFICIENT_CONTENT' }),
      })
      console.log(`SKIP (insufficient): ${article.url}`)
      return
    }

    if (result.sentinel === 'NOT_AI_RELEVANT') {
      await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
        method: 'PATCH', headers: SB(env),
        body: JSON.stringify({ status: 'error', last_error: 'NOT_AI_RELEVANT' }),
      })
      console.log(`SKIP (not AI relevant): ${article.url}`)
      return
    }

    if (!result.summary_en || !result.summary_zh) {
      throw new Error(`Validation Error: Empty summary field — summary_en="${result.summary_en}" summary_zh="${result.summary_zh}"`)
    }

    const { title_en, title_zh, summary_en, summary_zh, questions_en, questions_zh } = result
    const title = title_en || title_zh || 'Untitled'
    const summary = summary_en || summary_zh || ''
    const questions = (questions_en && questions_zh) ? { en: questions_en, zh: questions_zh } : null

    await insertAndMarkDone(article, title, summary, title_en, summary_en, title_zh, summary_zh, questions, articleContent, engagement, published_at, result.llm_model, env)
    console.log(`OK: ${article.url}`)

  } catch (err: unknown) {
    console.error(`FAIL: ${article.url}`, (err as Error).message)

    const countRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}&select=retry_count`,
      { headers: SB(env) }
    )
    const countData = await countRes.json() as { retry_count: number }[]
    const newCount = (countData[0]?.retry_count ?? 0) + 1

    await fetch(`${env.SUPABASE_URL}/rest/v1/raw_ingestion?id=eq.${article.id}`, {
      method: 'PATCH',
      headers: SB(env),
      body: JSON.stringify({
        retry_count: newCount,
        last_error: (err as Error).message || String(err),
        status: newCount >= 3 ? 'error' : 'pending',
      }),
    })
  }
}
