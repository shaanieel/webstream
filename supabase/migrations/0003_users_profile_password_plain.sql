-- Run on the LOCAL Supabase (Zaeinstream / gmjudsbreuyyznxtfjve).
--
-- Adds a `password_plain` column on users_profile. Webstream signup and the
-- admin panel both populate this so the admin can read/edit the plaintext
-- password without going through a "reset password" round-trip.
--
-- Idempotent — safe to run multiple times.

alter table public.users_profile
  add column if not exists password_plain text;
