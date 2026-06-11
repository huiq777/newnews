-- 20260528 — Official source ingestion v1
-- Adds curated OpenAI / Anthropic / Google DeepMind official sources.
-- HTML index sources are fetched by the ingest-official-sources Edge Function
-- through pg_cron; OpenAI RSS is fetched by the existing ingest-rss worker.

create extension if not exists pg_net;
create extension if not exists pg_cron;

insert into public.sources (name, rss_url, source_type, is_active, category, metadata)
values
  (
    'OpenAI News',
    'https://openai.com/news/rss.xml',
    'official_rss',
    true,
    'industry',
    jsonb_build_object(
      'trust_tier', 'official',
      'organization', 'openai',
      'fetch_mode', 'rss',
      'content_scope', jsonb_build_array('news', 'research', 'product', 'technical', 'safety', 'engineering'),
      'dedupe_priority', 100
    )
  ),
  (
    'Anthropic News',
    'https://www.anthropic.com/news',
    'official_html_index',
    true,
    'industry',
    jsonb_build_object(
      'trust_tier', 'official',
      'organization', 'anthropic',
      'fetch_mode', 'html_index',
      'index_selector_version', '2026-05-28',
      'content_scope', jsonb_build_array('news', 'product', 'technical', 'safety'),
      'dedupe_priority', 100
    )
  ),
  (
    'Anthropic Research',
    'https://www.anthropic.com/research',
    'official_html_index',
    true,
    'technical_frontier',
    jsonb_build_object(
      'trust_tier', 'official',
      'organization', 'anthropic',
      'fetch_mode', 'html_index',
      'index_selector_version', '2026-05-28',
      'content_scope', jsonb_build_array('research', 'technical', 'safety'),
      'dedupe_priority', 100
    )
  ),
  (
    'Google DeepMind News',
    'https://deepmind.google/blog/',
    'official_html_index',
    true,
    'technical_frontier',
    jsonb_build_object(
      'trust_tier', 'official',
      'organization', 'google_deepmind',
      'fetch_mode', 'html_index',
      'index_selector_version', '2026-05-28',
      'content_scope', jsonb_build_array('news', 'research', 'product', 'technical', 'safety', 'science'),
      'dedupe_priority', 100
    )
  )
on conflict (rss_url) do update
set
  name = excluded.name,
  source_type = excluded.source_type,
  is_active = excluded.is_active,
  category = excluded.category,
  metadata = excluded.metadata;

select cron.unschedule(jobid)
from cron.job
where jobname = 'ingest-official-sources';

select cron.schedule(
  'ingest-official-sources',
  '17 */3 * * *',
  $$
    select net.http_post(
      url := 'https://exjbwdcxyrkxsmzaowkx.supabase.co/functions/v1/ingest-official-sources',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $$
);
