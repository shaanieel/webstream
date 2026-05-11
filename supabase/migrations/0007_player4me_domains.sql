-- Player4Me custom player domains.
--
-- Player4Me lets an account map one or more "white-label" player domains
-- (e.g. zaeinstore.qzz.io) that serve the ad-free / VIP embed at the URL
-- pattern  https://{domain}/#{videoId}  instead of the public
-- https://player4me.com/embed/{videoId} URL (which shows ads).
--
-- We need to remember which domains the admin has registered so the
-- adminweb1 UI can present them in a dropdown and build copy-paste URLs
-- with the right domain. Exactly one row should be marked `is_default`.
--
-- NOTE: only admins ever read/write this table — RLS is left "deny by
-- default" (no policies). All access goes through the webstream worker
-- admin API which uses the service key and gates by ADMIN_EMAILS.

create table if not exists public.player4me_domains (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text not null unique,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Reuse / create the standard "touch updated_at" trigger function. Keep it
-- idempotent so re-running this migration is a no-op.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_player4me_domains_updated_at on public.player4me_domains;

create trigger trg_player4me_domains_updated_at
before update on public.player4me_domains
for each row
execute function public.set_updated_at();

-- Lock RLS down (no policies = no row visible to anon / authenticated).
alter table public.player4me_domains enable row level security;

-- Seed the canonical Zaeinstore domain so the UI is functional immediately
-- after migration. Safe to re-run thanks to the unique(domain) conflict.
insert into public.player4me_domains (name, domain, is_default)
values ('Zaeinstore QZZ', 'https://zaeinstore.qzz.io', true)
on conflict (domain) do nothing;
