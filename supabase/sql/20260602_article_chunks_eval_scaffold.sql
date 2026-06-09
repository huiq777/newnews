-- 20260602 — Eval-only article chunks scaffold.
-- This table is not used by production retrieval until a later gated rollout.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists public.article_chunks (
  id                       uuid primary key default gen_random_uuid(),
  article_id               uuid not null references public.daily_news(id) on delete cascade,
  source_id                uuid references public.sources(id) on delete set null,
  chunking_version         text not null,
  chunking_params          jsonb not null default '{}'::jsonb,
  chunk_index              integer not null,
  chunk_text               text not null,
  chunk_hash               text not null,
  boundary_type            text not null check (boundary_type in ('paragraph', 'heading', 'semantic', 'sliding_window')),
  char_start               integer,
  char_end                 integer,
  token_estimate           integer,
  language                 text not null default 'unknown',
  embedding vector(1024),
  embedding_model          text,
  embedding_input_type     text,
  created_at               timestamptz not null default now(),

  unique (article_id, chunking_version, chunk_hash),
  unique (article_id, chunking_version, chunk_index)
);

create index if not exists article_chunks_article_idx
  on public.article_chunks(article_id, chunking_version, chunk_index);

create index if not exists article_chunks_no_embedding_idx
  on public.article_chunks(id)
  where embedding is null;

create index if not exists article_chunks_embedding_hnsw_idx
  on public.article_chunks
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.article_chunks enable row level security;

revoke all on public.article_chunks from anon, authenticated;
grant all on public.article_chunks to service_role;
