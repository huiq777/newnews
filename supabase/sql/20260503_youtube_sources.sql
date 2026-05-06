-- Insert 5 YouTube channels as sources.
-- sources.category is the LLM fallback only (NOT NULL constraint).
-- process-queue's LLM determines the actual per-video category.
insert into sources (name, rss_url, source_type, is_active, category)
values
  ('No Priors Podcast',  'https://www.youtube.com/@NoPriorsPodcast', 'youtube', true, 'technical_frontier'),
  ('Dwarkesh Patel',     'https://www.youtube.com/@DwarkeshPatel',   'youtube', true, 'technical_frontier'),
  ('Sam Witteveen AI',   'https://www.youtube.com/@samwitteveenai',  'youtube', true, 'technical_frontier'),
  ('Matt Wolfe',         'https://www.youtube.com/@mreflow',         'youtube', true, 'technical_frontier'),
  ('Y Combinator',       'https://www.youtube.com/@ycombinator',     'youtube', true, 'technical_frontier')
on conflict (rss_url) do nothing;
