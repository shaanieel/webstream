-- Allow users_profile.expired_at to be NULL.
--
-- Signup creates a fresh row with NULL expired_at — the admin then assigns a
-- masa aktif from the panel (or via the +30 hari button). Forcing NOT NULL
-- means every signup fails with code 23502:
--
--   "Failing row contains (..., null, ...)"
--   (signup tries to set expired_at = null intentionally)
--
-- Idempotent — safe to run multiple times.

alter table public.users_profile
  alter column expired_at drop not null;
