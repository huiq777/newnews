-- 20260503 — is_ai_relevant: canonical AI-relevance keyword gate.
-- Single source of truth replacing copy-pasted arrays in 3 files.
-- Called by process-queue and ingest-apify-tweets Edge Functions via RPC.
-- ingest-builders (CF Worker) uses workers/ingest-builders/src/keywords.ts
-- which mirrors this exact logic (subrequest budget constraint).
--
-- NOTE: keep this function in sync with keywords.ts if keywords change.
-- The SQL function is authoritative; keywords.ts is a mirror.

CREATE OR REPLACE FUNCTION public.is_ai_relevant(
  content TEXT,
  source_type TEXT DEFAULT 'article'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  en_pattern TEXT := '\y(ai|agi|asi|llm|gpt|claude|gemini|openai|anthropic|deepmind|mistral|llama|groq|cohere|sora|midjourney|runway|nvidia|hugging|transformers|neural|multimodal|generative|agents|agent|embedding|rag|inference|benchmark|gpu|h100|a100|compute)\y';
  zh_keywords TEXT[] := ARRAY[
    '人工智能','大模型','语言模型','神经网络','深度学习','机器学习',
    '生成式','多模态','算力','芯片','英伟达',
    '智谱','文心','通义','混元','月之暗面','零一万物','阶跃星辰',
    'DeepSeek','百川','商汤','科大讯飞','华为盘古'
  ];
  kw TEXT;
BEGIN
  -- EN: case-insensitive word-boundary match
  IF content ~* en_pattern THEN RETURN TRUE; END IF;
  -- Extended EN patterns (contain spaces/hyphens — can't use \y cleanly)
  IF content ~* '(?i)(fine[- ]tun|training run|foundation model|reasoning model|o1[-\s]|o3[-\s]|o4[-\s])' THEN RETURN TRUE; END IF;
  -- ZH: substring match
  FOREACH kw IN ARRAY zh_keywords LOOP
    IF content LIKE '%' || kw || '%' THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

-- Grant execute to all roles (service role, anon, authenticated)
GRANT EXECUTE ON FUNCTION public.is_ai_relevant(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_ai_relevant(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.is_ai_relevant(TEXT, TEXT) TO authenticated;
