-- 20260604 — Social source coverage recovery
-- Purpose:
--   Recover the current WeChat, Reddit, and YouTube source names exactly as
--   provided by the production coverage audit. YouTube transcript depth remains
--   owned by Apify via ingest-youtube-transcripts; ingest-rss only provides
--   lightweight channel freshness.

insert into public.sources (name, rss_url, source_type, is_active, category, metadata)
values
  (
    'Reddit r/layoffs',
    'https://www.reddit.com/r/layoffs.rss',
    'reddit',
    true,
    'career_community',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('layoffs', 'career_community', 'workforce'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Reddit r/cscareerquestions',
    'https://www.reddit.com/r/cscareerquestions.rss',
    'reddit',
    true,
    'career_community',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('career_advice', 'job_market', 'community'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Reddit r/MachineLearning',
    'https://www.reddit.com/r/MachineLearning.rss',
    'reddit',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'content_scope', jsonb_build_array('research', 'technical_discussion', 'community'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Founder Park',
    'https://wechat2rss.xlab.app/feed/e95ec80ad542565f0eeaf02a42c6d021a7ae51bc.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('startup', 'ai_industry', 'founders'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '机器之心',
    'https://wechat2rss.xlab.app/feed/51e92aad2728acdd1fda7314be32b16639353001.xml',
    'wechat',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_research', 'models', 'technical_news'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '新智元',
    'https://wechat2rss.xlab.app/feed/ede30346413ea70dbef5d485ea5cbb95cca446e7.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_industry', 'models', 'china_ai'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '量子位',
    'https://wechat2rss.xlab.app/feed/7131b577c61365cb47e81000738c10d872685908.xml',
    'wechat',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('ai_research', 'technical_news', 'china_ai'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    '极客公园',
    'https://wechat2rss.xlab.app/feed/1a5aec98e71c707c8ca092bc2c255b9d4bac477d.xml',
    'wechat',
    true,
    'industry',
    jsonb_build_object(
      'fetch_mode', 'wechat2rss',
      'content_scope', jsonb_build_array('technology_business', 'startups', 'ai_industry'),
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Y Combinator',
    'https://www.youtube.com/@ycombinator',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@ycombinator',
      'channel_id', 'UCcefcZRL2oaA_uBNeo5UOWg',
      'apify_start_url', 'https://www.youtube.com/@ycombinator',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Sam Witteveen AI',
    'https://www.youtube.com/@samwitteveenai',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@samwitteveenai',
      'channel_id', 'UC55ODQSvARtgSyc8ThfiepQ',
      'apify_start_url', 'https://www.youtube.com/@samwitteveenai',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Dwarkesh Patel',
    'https://www.youtube.com/@DwarkeshPatel',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@DwarkeshPatel',
      'channel_id', 'UCXl4i9dYBrFOabk0xGmbkRA',
      'apify_start_url', 'https://www.youtube.com/@DwarkeshPatel',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'Matt Wolfe',
    'https://www.youtube.com/@mreflow',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@mreflow',
      'channel_id', 'UChpleBmo18P08aKCIgti38g',
      'apify_start_url', 'https://www.youtube.com/@mreflow',
      'coverage_recovered_at', '2026-06-04'
    )
  ),
  (
    'No Priors Podcast',
    'https://www.youtube.com/@NoPriorsPodcast',
    'youtube',
    true,
    'technical_frontier',
    jsonb_build_object(
      'fetch_mode', 'youtube_atom_fallback',
      'depth_mode', 'apify_transcript',
      'youtube_handle', '@NoPriorsPodcast',
      'channel_id', 'UCSI7h9hydQ40K5MJHnCrQvw',
      'apify_start_url', 'https://www.youtube.com/@NoPriorsPodcast',
      'coverage_recovered_at', '2026-06-04'
    )
  )
on conflict (rss_url) do update
set
  name = excluded.name,
  source_type = excluded.source_type,
  is_active = excluded.is_active,
  category = excluded.category,
  metadata = coalesce(public.sources.metadata, '{}'::jsonb) || excluded.metadata;

-- Ensure older Reddit rows are handled by ingest-rss, not the historical JSON path.
update public.sources
set source_type = 'reddit',
    is_active = true,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'fetch_mode', 'reddit_rss',
      'coverage_recovered_at', '2026-06-04'
    )
where name in ('Reddit r/layoffs', 'Reddit r/cscareerquestions', 'Reddit r/MachineLearning');

-- Verification: current source registry.
select name, source_type, rss_url, is_active, category, metadata
from public.sources
where name in (
  'Reddit r/layoffs',
  'Reddit r/cscareerquestions',
  'Reddit r/MachineLearning',
  'Founder Park',
  '机器之心',
  '新智元',
  '量子位',
  '极客公园',
  'Y Combinator',
  'Sam Witteveen AI',
  'Dwarkesh Patel',
  'Matt Wolfe',
  'No Priors Podcast'
)
order by source_type, name;

-- Verification: post-deploy freshness. Run after ingest-rss has executed once.
select
  s.name,
  s.source_type,
  count(ri.id) filter (where ri.fetched_at > now() - interval '24 hours') as raw_24h,
  count(dn.id) filter (where dn.created_at > now() - interval '7 days') as articles_7d,
  max(ri.fetched_at) as newest_raw,
  max(dn.created_at) as newest_article
from public.sources s
left join public.raw_ingestion ri on ri.source_id = s.id
left join public.daily_news dn on dn.source_id = s.id
where s.is_active = true
  and s.source_type in ('wechat', 'reddit', 'youtube')
group by s.id, s.name, s.source_type
order by s.source_type, raw_24h asc, s.name;
