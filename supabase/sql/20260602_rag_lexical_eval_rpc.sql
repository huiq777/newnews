-- 20260602 — Eval-only lexical article retrieval.
-- Used by offline RAG replay only. Does not change production retrieval.

create extension if not exists pg_trgm;

create or replace function public.match_articles_lexical_eval(
  query_terms text[],
  match_count integer default 10
)
returns table (
  id uuid,
  title text,
  summary text,
  summary_en text,
  summary_zh text,
  article_content text,
  score_lexical double precision,
  embedding_source text
)
language sql
stable
security definer
set search_path = public
as $$
  with terms as (
    select lower(trim(term)) as term
    from unnest(query_terms) term
    where length(trim(term)) >= 2
    limit 10
  ),
  scored as (
    select
      n.id,
      coalesce(n.title, n.title_zh, n.title_en, '') as title,
      n.summary,
      n.summary_en,
      n.summary_zh,
      n.article_content,
      sum(
        greatest(
          similarity(lower(coalesce(n.title, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.title_en, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.title_zh, '')), terms.term) * 4.0,
          similarity(lower(coalesce(n.summary, '')), terms.term) * 2.0,
          similarity(lower(coalesce(n.summary_en, '')), terms.term) * 2.0,
          similarity(lower(coalesce(n.summary_zh, '')), terms.term) * 2.0
        )
      ) as score_lexical
    from public.daily_news n
    cross join terms
    where
      lower(coalesce(n.title, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.title_en, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.title_zh, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary_en, '')) like '%' || terms.term || '%'
      or lower(coalesce(n.summary_zh, '')) like '%' || terms.term || '%'
    group by n.id, n.title, n.title_en, n.title_zh, n.summary, n.summary_en, n.summary_zh, n.article_content
  )
  select
    scored.id,
    scored.title,
    scored.summary,
    scored.summary_en,
    scored.summary_zh,
    scored.article_content,
    scored.score_lexical,
    'lexical_eval_trigram_v1'::text as embedding_source
  from scored
  where scored.score_lexical > 0
  order by scored.score_lexical desc, scored.id
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_articles_lexical_eval(text[], integer) from public;
grant execute on function public.match_articles_lexical_eval(text[], integer) to service_role;
