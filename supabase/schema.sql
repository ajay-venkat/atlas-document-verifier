-- ============================================================
-- Document Verification Engine — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Enable pgvector extension
create extension if not exists vector;

-- Documents table
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text,
  source_type text,
  raw_text text,
  metadata jsonb,
  created_at timestamptz default now()
);

-- Chunks table (for dense + lexical retrieval)
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  content text,
  embedding vector(768),
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  chunk_index int,
  created_at timestamptz default now()
);

-- Indexes for retrieval
create index if not exists chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists chunks_tsv_idx on chunks using gin (tsv);

-- Entity edges (lightweight knowledge graph)
create table if not exists entity_edges (
  id uuid primary key default gen_random_uuid(),
  subject text,
  predicate text,
  object text,
  source_document_id uuid references documents(id) on delete cascade,
  confidence float,
  created_at timestamptz default now()
);

create index if not exists entity_edges_subject_idx on entity_edges (subject);
create index if not exists entity_edges_object_idx on entity_edges (object);
create index if not exists entity_edges_source_doc_idx on entity_edges (source_document_id);

-- Verification runs
create table if not exists verification_runs (
  id uuid primary key default gen_random_uuid(),
  query text,
  status text default 'pending',
  report jsonb,
  risk_score float,
  created_at timestamptz default now()
);

-- ============================================================
-- RPC Functions for Retrieval
-- ============================================================

-- Dense vector search (cosine similarity)
create or replace function match_chunks(
  query_embedding text,
  match_count int default 10
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float,
  document_title text
)
language plpgsql
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding::vector) as similarity,
    d.title as document_title
  from chunks c
  join documents d on d.id = c.document_id
  order by c.embedding <=> query_embedding::vector
  limit match_count;
end;
$$;

-- Lexical full-text search
create or replace function search_chunks_lexical(
  search_query text,
  match_count int default 10
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  rank float,
  document_title text
)
language plpgsql
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.content,
    ts_rank(c.tsv, to_tsquery('english', search_query))::float as rank,
    d.title as document_title
  from chunks c
  join documents d on d.id = c.document_id
  where c.tsv @@ to_tsquery('english', search_query)
  order by rank desc
  limit match_count;
end;
$$;
