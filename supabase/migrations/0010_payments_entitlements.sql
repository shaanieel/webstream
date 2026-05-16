-- Payment pricing, orders, and per-film entitlements for ZAEINSTREAM.

create table if not exists public.payment_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.payment_settings (key, value) values
  ('movie_price', '5000'),
  ('series_season_price', '10000'),
  ('vip_month_price', '49000'),
  ('vip_week_price', '19000')
on conflict (key) do nothing;

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  user_id uuid not null,
  email text,
  product_type text not null check (product_type in ('film','vip_month','vip_week')),
  product_name text not null,
  amount integer not null check (amount >= 0),
  status text not null default 'pending' check (status in ('pending','success','failed')),
  checkout_url text,
  metadata jsonb not null default '{}'::jsonb,
  gateway_response jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_orders_user_idx on public.payment_orders(user_id, created_at desc);
create index if not exists payment_orders_status_idx on public.payment_orders(status, created_at desc);

create table if not exists public.film_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  film_id bigint,
  kind text not null check (kind in ('movie','series_season')),
  entitlement_key text not null,
  title text not null,
  season integer,
  payment_ref text references public.payment_orders(ref) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, entitlement_key)
);

create index if not exists film_entitlements_user_idx on public.film_entitlements(user_id, created_at desc);
create index if not exists film_entitlements_key_idx on public.film_entitlements(entitlement_key);

alter table public.payment_settings enable row level security;
alter table public.payment_orders enable row level security;
alter table public.film_entitlements enable row level security;