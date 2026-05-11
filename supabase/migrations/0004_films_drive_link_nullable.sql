-- Run on the LOCAL Supabase (Zaeinstream / gmjudsbreuyyznxtfjve).
--
-- Drops the NOT NULL constraint on `films.drive_link` and `films.drive_path`
-- so basic-tier films (which only have a Player4Me video_url and no Drive
-- backend) can be inserted without violating the constraint.
--
-- The worker also coerces null → '' as a belt-and-suspenders compatibility
-- shim, but running this migration is the cleaner long-term fix.
--
-- Idempotent — safe to run multiple times.

alter table public.films
  alter column drive_link drop not null;

alter table public.films
  alter column drive_path drop not null;
