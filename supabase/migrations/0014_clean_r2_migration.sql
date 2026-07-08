-- ============================================================
-- FASE 1: Bersih-bersih Player4Me + siapin tabel baru untuk R2
-- ============================================================
-- Jalankan sekali setelah koneksi Supabase normal kembali.
-- Via: npx wrangler d1 execute DB_NAME --file=0014_clean_r2_migration.sql
-- Atau langsung di Supabase SQL Editor.

-- 1. HAPUS semua film lama (Player4Me — 5,267 row)
truncate table public.films cascade;

-- 2. HAPUS table player4me_domains (gak dipakai lagi)
drop table if exists public.player4me_domains cascade;

-- 3. TAMBAH kolom baru untuk R2 streaming
alter table public.films
  add column if not exists r2_bucket text,
  add column if not exists audio_url text,
  add column if not exists subtitle_urls jsonb default '[]'::jsonb,
  add column if not exists size_bytes bigint default 0,
  add column if not exists r2_path text;

-- 4. BUAT tabel cf_accounts (mapping akun CF + R2)
create table if not exists public.cf_accounts (
  id            uuid primary key default gen_random_uuid(),
  cf_account_id text not null unique,
  email         text,
  r2_bucket     text not null,
  storage_used_gb  real not null default 0,
  storage_limit_gb real not null default 10,
  status        text not null default 'active',
  api_token     text,
  account_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.cf_accounts enable row level security;

-- 5. BUAT tabel preview_sessions (tracking preview timeout)
create table if not exists public.preview_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null,
  film_id           integer not null references public.films(id) on delete cascade,
  remaining_seconds integer not null default 300,
  started_at        timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now()
);

alter table public.preview_sessions
  add constraint preview_sessions_user_film_unique
  unique (user_id, film_id);

-- 6. Trigger auto-updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_cf_accounts_updated_at on public.cf_accounts;
create trigger trg_cf_accounts_updated_at
  before update on public.cf_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_preview_sessions_updated_at on public.preview_sessions;
create trigger trg_preview_sessions_updated_at
  before update on public.preview_sessions
  for each row execute function public.set_updated_at();

-- ============================================================
-- columns di films setelah migration:
--   id, judul, tipe, tahun, tmdb_id, episode, season, created_at,
--   tier (free/vip), poster_url, backdrop_url, overview, genre,
--   drive_link, drive_path, video_url (R2 video),
--   audio_url (R2 audio), subtitle_urls (JSON array URL),
--   r2_bucket, r2_path, size_bytes,
--   preview_video_url, audio_tracks, videos, subtitles, trailer_url
-- ============================================================
