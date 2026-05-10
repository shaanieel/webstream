-- Run this migration on PROJECT 2 (Zaeinstream) — local supabase that
-- backs the streaming web. Adds the columns + constraint needed by the
-- mirror Edge Function `mirror-accounts-to-zaeinstream` (which lives in
-- Project 1).
--
-- Idempotent — safe to run multiple times.

-- 1. Ensure user_id is unique so onConflict='user_id' upserts work without
--    creating duplicates.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_profile_user_id_key'
      and conrelid = 'public.users_profile'::regclass
  ) then
    alter table public.users_profile
      add constraint users_profile_user_id_key unique (user_id);
  end if;
end$$;

-- 2. status column for soft-deletes ('active' | 'inactive').
alter table public.users_profile
  add column if not exists status text not null default 'active';

-- 3. updated_at column so the mirror function can stamp every change.
alter table public.users_profile
  add column if not exists updated_at timestamptz not null default now();
