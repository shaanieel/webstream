-- =============================================================
-- 0009_films_player4me_domain_id.sql
--
-- Add per-film Player4Me domain selection.
--
-- Previously the white-label player domain was a single global env var
-- (PLAYER4ME_PUBLIC_DOMAIN). That means every film had to play through
-- the same domain. Spec change: admin should be able to register many
-- Player4Me domains and pick which one a specific film plays through
-- — useful when the admin rotates domains for risk/abuse, or maintains
-- separate domains for separate brands.
--
-- Schema:
--   films.player4me_domain_id  uuid  null  references player4me_domains(id)
--     - Nullable so existing rows keep working (they fall back to the
--       default row in player4me_domains, then to env).
--     - ON DELETE SET NULL so deleting a domain doesn't orphan-break films
--       — the player gracefully falls back to default/env.
--
-- Idempotent: re-runnable.
-- =============================================================

alter table public.films
  add column if not exists player4me_domain_id uuid
    references public.player4me_domains(id)
    on delete set null;

-- Optional index for the (rare) admin filter "show films using domain X".
create index if not exists films_player4me_domain_id_idx
  on public.films(player4me_domain_id)
  where player4me_domain_id is not null;
