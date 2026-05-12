# Supabase: schema migrations (single-project setup)

This folder holds `migrations/*.sql` for the LOCAL Supabase project that
backs the streaming web (`gmjudsbreuyyznxtfjve` — "Zaeinstream"). Run them
in order via the Supabase SQL editor (`supabase.com → Zaeinstream →
SQL Editor → New query`). All migrations are idempotent so re-running on
already-migrated databases is safe.

> The previous cross-project "mirror" Edge Function and external supabase
> wiring have been removed. Auth (login + signup + password edit) now
> happens entirely in this project. There is no longer a Project 1 / 2
> distinction — all film, user, and auth data lives here.

## Migrations (in order)

1. **`0001_users_profile_mirror_columns.sql`** — adds:
   - `unique(user_id)` on `users_profile` so admin upserts work.
   - `status text default 'active'` (kept as a soft-delete column).
   - `updated_at timestamptz default now()`.
2. **`0002_films_video_url.sql`** — adds `video_url text` on `films` so the
   admin can store the Player4Me embed URL per tier.
3. **`0003_users_profile_password_plain.sql`** — adds `password_plain text`
   on `users_profile` so the admin can view/edit the plaintext password.
4. **`0004_films_drive_link_nullable.sql`** — drops the NOT NULL
   constraint on `films.drive_link` and `films.drive_path` so basic-tier
   films (no Drive backend) can be created.
5. **`0005_films_tier_allow_basic.sql`** — expands the `films_tier_check`
   CHECK constraint so `tier='basic'` is accepted alongside the legacy
   `'free'` and `'vip'`. Without this, the new admin form fails with
   `films_tier_check` violation when saving a basic-tier film.
6. **`0006_users_profile_expired_at_nullable.sql`** — drops the NOT NULL
   constraint on `users_profile.expired_at` so new admin-created accounts
   without a fixed expiry can be saved.
7. **`0007_player4me_domains.sql`** — adds the `player4me_domains` table
   used by the adminweb1 Player4Me Videos menu. Each row represents a
   white-label / ad-free Player4Me player domain (e.g.
   `https://zaeinstore.qzz.io`). Embed URLs are built as
   `https://{domain}/#{videoId}`. Exactly one row may be `is_default`;
   the worker API enforces that invariant on insert/update. Seed inserts
   `Zaeinstore QZZ → https://zaeinstore.qzz.io` as the default.
8. **`0008_rewrite_legacy_player4me_urls.sql`** — rewrites legacy
   Player4Me URLs to the current custom-domain hash URL format.
9. **`0009_active_downloads_limit.sql`** — adds `active_downloads` plus
   `acquire_vip_download_slot(...)` so VIP Drive downloads are limited to
   2 simultaneous active downloads per user. Slots auto-expire after the
   worker's stale window and are released by the frontend when the player
   closes.

## Required tables

The migrations assume the following base tables already exist:

```sql
create table if not exists users_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  is_vip boolean default false,
  expired_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists films (
  id bigserial primary key,
  judul text not null,
  tipe text not null default 'movie',
  drive_link text,
  drive_path text,
  tahun int,
  tmdb_id text,
  episode int,
  season int,
  tier text default 'free',
  poster_url text,
  overview text,
  genre text,
  audio_tracks jsonb default '[]'::jsonb,
  videos jsonb default '[]'::jsonb,
  subtitles jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
```
