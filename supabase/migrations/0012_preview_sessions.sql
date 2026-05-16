-- Stores per-user preview countdowns in the database.
-- Once a free user's preview expires, reopening the same movie/season remains locked.

create table if not exists public.preview_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  film_id bigint,
  preview_key text not null,
  title text,
  limit_seconds integer not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, preview_key)
);

create index if not exists preview_sessions_user_idx on public.preview_sessions(user_id, created_at desc);
create index if not exists preview_sessions_key_idx on public.preview_sessions(preview_key);

alter table public.preview_sessions enable row level security;