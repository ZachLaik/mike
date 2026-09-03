-- Migration date: 2026-09-03
-- Server-only cache for normalized provider documents opened from citations.
-- Browser clients have no table grants or RLS policies; the backend service role
-- keys every row by the authenticated Mike user.

create table if not exists public.user_external_source_documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id text not null check (
    length(document_id) between 1 and 4096
  ),
  provider text not null check (provider in ('legal-data-hunter')),
  document jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, document_id)
);

create index if not exists user_external_source_documents_expiry_idx
  on public.user_external_source_documents (expires_at);

alter table public.user_external_source_documents enable row level security;
revoke all on public.user_external_source_documents
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.user_external_source_documents to service_role;
