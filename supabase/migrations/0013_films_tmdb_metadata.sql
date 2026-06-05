-- Cache TMDB classification metadata on films so public pages do not need
-- to call TMDB one-by-one while users browse genre pages.

alter table public.films
  add column if not exists tmdb_media_type text,
  add column if not exists tmdb_genres jsonb not null default '[]'::jsonb,
  add column if not exists tmdb_genre_ids jsonb not null default '[]'::jsonb,
  add column if not exists tmdb_country_codes jsonb not null default '[]'::jsonb,
  add column if not exists tmdb_original_language text,
  add column if not exists tmdb_poster_path text,
  add column if not exists tmdb_backdrop_path text,
  add column if not exists tmdb_logo_path text,
  add column if not exists tmdb_synced_at timestamptz;

create index if not exists films_tmdb_genres_gin
  on public.films using gin (tmdb_genres);

create index if not exists films_tmdb_country_codes_gin
  on public.films using gin (tmdb_country_codes);

create index if not exists films_tmdb_synced_at_idx
  on public.films (tmdb_synced_at);
