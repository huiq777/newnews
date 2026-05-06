// keywords.ts — mirrors is_ai_relevant() SQL function in supabase/sql/20260503_is_ai_relevant.sql
// Used by ingest-builders CF Worker to avoid per-item RPC subrequests (50/invocation limit).
// KEEP IN SYNC with the SQL function when updating keywords. SQL function is authoritative.

const EN_AI_PATTERN = /\b(ai|agi|asi|llm|gpt|claude|gemini|openai|anthropic|deepmind|mistral|llama|groq|cohere|sora|midjourney|runway|nvidia|hugging|transformers|neural|multimodal|generative|agents?|embedding|rag|inference|benchmark|fine[-._ ]tun|training\s+run|gpu|h100|a100|compute|foundation\s+model|reasoning\s+model|o1|o3|o4)\b/i

const ZH_AI_KEYWORDS: string[] = [
  '人工智能', '大模型', '语言模型', '神经网络', '深度学习', '机器学习',
  '生成式', '多模态', '算力', '芯片', '英伟达',
  '智谱', '文心', '通义', '混元', '月之暗面', '零一万物', '阶跃星辰',
  'DeepSeek', '百川', '商汤', '科大讯飞', '华为盘古',
]

export function hasAISignal(text: string): boolean {
  if (EN_AI_PATTERN.test(text)) return true
  return ZH_AI_KEYWORDS.some(kw => text.includes(kw))
}
