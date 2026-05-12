create table if not exists active_downloads (
  token uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  film_path text not null,
  started_at timestamptz not null default now()
);

create index if not exists active_downloads_user_started_idx
  on active_downloads(user_id, started_at);

alter table active_downloads enable row level security;

create or replace function acquire_vip_download_slot(
  p_user_id uuid,
  p_film_path text,
  p_token uuid,
  p_limit int default 2,
  p_stale_before timestamptz default now() - interval '30 minutes'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count int;
begin
  delete from active_downloads
    where user_id = p_user_id
      and started_at < p_stale_before;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)
    into active_count
    from active_downloads
    where user_id = p_user_id
      and started_at >= p_stale_before;

  if active_count >= p_limit then
    return false;
  end if;

  insert into active_downloads(token, user_id, film_path)
    values (p_token, p_user_id, p_film_path);

  return true;
end;
$$;
