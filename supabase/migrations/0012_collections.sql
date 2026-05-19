-- Public movie collections (Star Wars Collection, Harry Potter Collection, etc.)
-- Admin curates these via /api/admin/collections endpoints. Frontend exposes
-- /collections (grid) and /collection/:id (detail) routes.

create table if not exists public.collections (
  id          bigserial primary key,
  title       text not null,
  description text,
  cover_url   text,             -- backdrop landscape; auto-set from first film's TMDB backdrop, admin-overridable
  -- Optional sort weight; smaller numbers come first. Default 0 keeps insertion order via id.
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Junction table: which films belong to which collection, in what order.
-- A film can appear in multiple collections (e.g. Tom Hanks Collection + Drama Picks).
create table if not exists public.collection_films (
  collection_id bigint not null references public.collections(id) on delete cascade,
  film_id       bigint not null references public.films(id)        on delete cascade,
  position      int    not null default 0,
  created_at    timestamptz not null default now(),
  primary key (collection_id, film_id)
);

create index if not exists collection_films_by_collection
  on public.collection_films (collection_id, position);

create index if not exists collections_by_sort
  on public.collections (sort_order, id);

-- Public read: anyone can browse collections.
alter table public.collections        enable row level security;
alter table public.collection_films   enable row level security;

drop policy if exists "collections_select" on public.collections;
create policy "collections_select"
  on public.collections
  for select
  using (true);

drop policy if exists "collection_films_select" on public.collection_films;
create policy "collection_films_select"
  on public.collection_films
  for select
  using (true);

-- Writes are gated through the worker (service-role key), so no INSERT/UPDATE/DELETE
-- policies for end-users. Admin endpoints in worker.js perform admin email check
-- before mutating these tables.
