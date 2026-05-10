-- Allow 'basic' as a valid value for films.tier alongside the legacy 'free' and 'vip'.
-- The new admin UI labels the non-VIP tier as 'basic' (Player4Me embed only, no
-- download / external player). Without this migration, inserting tier='basic' fails
-- the films_tier_check CHECK constraint.

alter table public.films
  drop constraint if exists films_tier_check;

alter table public.films
  add constraint films_tier_check
  check (tier in ('free', 'basic', 'vip'));
