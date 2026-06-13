-- 20260613 - Production chunk retrieval RPC for answer-question.
--
-- Default production retriever target:
-- chunk_dense @cf/baai/bge-m3, selected from valid eval run
-- 8ba5bdac-88a7-4f7b-8058-1648c734cc33 after corpus-health run
-- 54dcd974-2fa2-4fb7-bb62-6eae9f3880c0.

create extension if not exists vector;

create or replace function public.match_answer_question_chunks(
  query_embedding vector(1024),
  match_count integer default 4,
  chunking_version_filter text default 'paragraph-window-v1-2026-06-02',
  chunk_overfetch_multiplier integer default 5,
  embedding_model_filter text default '@cf/baai/bge-m3'
)
returns table (
  chunk_id uuid,
  article_id uuid,
  title text,
  summary text,
  summary_en text,
  summary_zh text,
  article_content text,
  chunk_text text,
  chunk_index integer,
  chunk_rank integer,
  article_rank integer,
  score_dense double precision,
  embedding_source text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with chunk_matches as (
    select
      c.id as chunk_id,
      c.article_id,
      c.chunk_text,
      c.chunk_index,
      c.chunking_version,
      c.token_estimate,
      c.language,
      1 - (c.embedding <=> query_embedding) as score_dense,
      row_number() over (order by c.embedding <=> query_embedding, c.id) as chunk_rank
    from public.article_chunks c
    where c.embedding is not null
      and c.embedding_model = embedding_model_filter
      and (chunking_version_filter is null or c.chunking_version = chunking_version_filter)
    order by c.embedding <=> query_embedding, c.id
    limit greatest(match_count * greatest(chunk_overfetch_multiplier, 1), match_count, 1)
  ),
  article_best as (
    select
      cm.*,
      row_number() over (
        partition by cm.article_id
        order by cm.score_dense desc, cm.chunk_rank asc
      ) as per_article_rank
    from chunk_matches cm
  ),
  deduped as (
    select
      ab.*,
      row_number() over (order by ab.score_dense desc, ab.chunk_rank asc) as article_rank
    from article_best ab
    where ab.per_article_rank = 1
  )
  select
    d.chunk_id,
    d.article_id,
    coalesce(n.title, n.title_zh, n.title_en, '') as title,
    n.summary,
    n.summary_en,
    n.summary_zh,
    n.article_content,
    d.chunk_text,
    d.chunk_index,
    d.chunk_rank::integer,
    d.article_rank::integer,
    d.score_dense,
    'answer_question_chunk_dense_bge_m3'::text as embedding_source,
    jsonb_build_object(
      'retrieval_path', 'answer_question_chunk_dense_bge_m3',
      'chunking_version', d.chunking_version,
      'embedding_model', embedding_model_filter,
      'token_estimate', d.token_estimate,
      'language', d.language,
      'selected_eval_run_id', '8ba5bdac-88a7-4f7b-8058-1648c734cc33',
      'corpus_health_run_id', '54dcd974-2fa2-4fb7-bb62-6eae9f3880c0'
    ) as metadata
  from deduped d
  join public.daily_news n on n.id = d.article_id
  order by d.article_rank asc
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) from public;
grant execute on function public.match_answer_question_chunks(vector(1024), integer, text, integer, text) to service_role;
