-- =============================================================
-- 0008_rewrite_legacy_player4me_urls.sql
--
-- One-time data migration to rewrite legacy Player4Me URLs stored in
-- films.video_url so existing rows keep working after the worker
-- dropped the player4me.com/embed/<id> fallback.
--
-- The Player4Me white-label custom domain (e.g. zaeinstore.qzz.io) is
-- the ONLY URL pattern that resolves to our id-space; the public
-- player4me.com/embed/<id> 404s for our ids. Anything saved with the
-- legacy pattern needs to be rewritten to the hash-style URL on the
-- default custom domain.
--
-- The default domain is read at runtime from public.player4me_domains
-- (the row with is_default = true, or fallback to the first row by
-- created_at). If no domain row exists yet, the migration is a no-op —
-- run 0007 first.
--
-- Patterns rewritten (case-insensitive):
--   https://player4me.com/embed/<id>      -> https://<default>/#<id>
--   http://player4me.com/embed/<id>       -> https://<default>/#<id>
--   https://player4me.com/v/<id>          -> https://<default>/#<id>
--   https://<custom-domain>/#/<id>        -> https://<custom-domain>/#<id>
--                                            (drop the extra slash after #)
--
-- Idempotent: rerunning produces no further changes because the matchers
-- never fire on the rewritten output.
-- =============================================================

do $migrate$
declare
  default_domain text;
  legacy_re      text := 'https?://player4me\.com/(?:embed|v)/([A-Za-z0-9_-]+)';
  hashslash_re   text := '^(https?://[^/]+)/#/([A-Za-z0-9_-]+)$';
  updated_count  int;
begin
  -- Pick the active custom domain. Strip trailing slash + leading scheme
  -- so we can reassemble it in the desired shape below.
  select regexp_replace(regexp_replace(domain, '^https?://', '', 'i'), '/$', '')
    into default_domain
    from public.player4me_domains
   where is_default = true
   order by created_at asc
   limit 1;

  if default_domain is null then
    -- Fall back to the oldest registered domain.
    select regexp_replace(regexp_replace(domain, '^https?://', '', 'i'), '/$', '')
      into default_domain
      from public.player4me_domains
     order by created_at asc
     limit 1;
  end if;

  if default_domain is null or default_domain = '' then
    raise notice 'player4me_domains is empty — skipping legacy URL rewrite. Run 0007 first.';
    return;
  end if;

  -- 1) player4me.com/(embed|v)/<id>  ->  https://<default_domain>/#<id>
  update public.films
     set video_url = 'https://' || default_domain || '/#' ||
                     substring(video_url from legacy_re)
   where video_url ~* legacy_re;

  get diagnostics updated_count = row_count;
  raise notice 'Rewrote % rows from player4me.com/(embed|v)/<id> -> https://%/#<id>',
               updated_count, default_domain;

  -- 2) https://<dom>/#/<id>  ->  https://<dom>/#<id>   (drop extra slash)
  update public.films
     set video_url = regexp_replace(video_url, hashslash_re, '\1/#\2')
   where video_url ~ hashslash_re;

  get diagnostics updated_count = row_count;
  raise notice 'Rewrote % rows from <dom>/#/<id> -> <dom>/#<id>', updated_count;
end
$migrate$;
