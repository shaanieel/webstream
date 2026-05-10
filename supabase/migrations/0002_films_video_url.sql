-- Run this migration on PROJECT 2 (Zaeinstream) — local supabase that
-- backs the streaming web. Adds the `video_url` column on `films` so the
-- admin form can store the Player4Me embed URL per tier.
--
-- Idempotent — safe to run multiple times.

alter table public.films
  add column if not exists video_url text;
