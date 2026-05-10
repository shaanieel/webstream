# Supabase: schema migrations + cross-project mirror Edge Function

Two artifacts live here, both tied to the dual-project auth architecture:

| Artifact | Lives in repo for | Deploys to |
| --- | --- | --- |
| `migrations/*.sql` | Project 2 schema parity. | **Project 2 (Zaeinstream)** — `gmjudsbreuyyznxtfjve` |
| `functions/mirror-accounts-to-zaeinstream/` | Project 1 Edge Function source. | **Project 1 (Zaeinstore)** — `awfpxjwfjtyovbrpbcar` |

Read the rest of this doc top to bottom on first deploy. It maps 1:1 with the
spec: backfill → schema → Edge Function → Database Webhook → test.

## 1. Architecture (one-way mirror)

```
                     ┌─────────────────────────────┐
                     │  Project 1 — Zaeinstore     │
                     │  (https://awfpxj...)        │
                     │                             │
   user signs up ──▶ │  public.accounts            │
                     │  ▲                          │
                     │  │ DB webhook on            │
                     │  │ INSERT/UPDATE/DELETE     │
                     │  ▼                          │
                     │  Edge Function              │
                     │  mirror-accounts-to-zaein… │
                     └──────────────┬──────────────┘
                                    │ Service-role POST
                                    ▼
                     ┌─────────────────────────────┐
                     │  Project 2 — Zaeinstream    │
                     │  (https://gmjuds...)        │
                     │                             │
                     │  public.users_profile       │
                     │  (mirror only — no signup)  │
                     └─────────────────────────────┘
```

**Source of truth**: `accounts` in Project 1.<br>
**Mirror**: `users_profile` in Project 2.<br>
**Direction**: P1 → P2 only. Admin edits to `expired_at`, `is_vip` happen in P2
and stay there (those fields are P2-specific).<br>
**Passwords**: never copied. They live in `auth.users` in Project 1 and the
streaming web verifies them via `supabase.auth.signInWithPassword` against
Project 1.

## 2. Schema migrations (Project 2)

Run these in the Project 2 SQL editor (`supabase.com → Zaeinstream →
SQL Editor → New query`) once, in order:

1. **`migrations/0001_users_profile_mirror_columns.sql`** — adds:
   - `unique(user_id)` so the Edge Function's `upsert(onConflict=user_id)` works.
   - `status text default 'active'` for soft-deletes.
   - `updated_at timestamptz default now()` for change tracking.
2. **`migrations/0002_films_video_url.sql`** — adds:
   - `video_url text` on `films` for the Player4Me embed URL.

Both files are idempotent so re-running on already-migrated databases is
safe.

## 3. Backfill existing accounts (one-time, manual)

You probably already have accounts in Project 1 that don't yet exist in
Project 2. Copy them across before turning on the webhook so users don't
spend a session in limbo:

1. Project 1 → Table Editor → `accounts` → **Export CSV**.
2. Open the CSV in Sheets / Excel:
   - Delete the `password` column (it's "(via auth)" anyway — no real value).
   - Rename `id` → `user_id`.
   - Keep `email` as `email`.
   - **Do not** include the existing `id` column from `users_profile` —
     that one is `int8` auto-increment and Supabase will fill it.
3. Project 2 → Table Editor → `users_profile` → **Insert → Import data from
   CSV** → upload the cleaned CSV → map columns:
   - `user_id` → `user_id`
   - `email` → `email`
   - (skip `id` — auto-increment fills it)
4. Sanity check counts:
   ```sql
   -- Project 1
   select count(*) from public.accounts;
   -- Project 2
   select count(*) from public.users_profile where status = 'active';
   ```
   The two numbers should match.

## 4. Deploy the Edge Function (Project 1)

> The function source lives in this repo at
> `supabase/functions/mirror-accounts-to-zaeinstream/index.ts`. Deploy it to
> Project 1 using the Supabase CLI.

```bash
# Authenticate the Supabase CLI to your account (one-time per machine)
supabase login

# Link this folder to PROJECT 1 (Zaeinstore). Get the ref from
# Supabase dashboard → Zaeinstore → Project Settings → General.
supabase link --project-ref awfpxjwfjtyovbrpbcar

# Set Edge Function secrets (Project 1 only). Use the values for PROJECT 2.
supabase secrets set PROJECT_2_SUPABASE_URL="https://gmjudsbreuyyznxtfjve.supabase.co"
supabase secrets set PROJECT_2_SERVICE_ROLE_KEY="<paste from Project 2 → Settings → API → service_role key>"
supabase secrets set MIRROR_WEBHOOK_SECRET="<run: openssl rand -hex 32>"

# Deploy.
supabase functions deploy mirror-accounts-to-zaeinstream
```

Once deployed, the function URL is:

```
https://awfpxjwfjtyovbrpbcar.functions.supabase.co/mirror-accounts-to-zaeinstream
```

## 5. Database Webhook (Project 1)

Project 1 dashboard → **Database → Webhooks → Create a new hook**.

| Field | Value |
| --- | --- |
| Name | `mirror-accounts-to-zaeinstream` |
| Table | `accounts` |
| Schema | `public` |
| Events | INSERT, UPDATE, DELETE |
| HTTP method | POST |
| URL | `https://awfpxjwfjtyovbrpbcar.functions.supabase.co/mirror-accounts-to-zaeinstream` |
| HTTP headers | `Authorization: Bearer <your MIRROR_WEBHOOK_SECRET>` |

The webhook payload Supabase sends matches what `index.ts` expects:

```jsonc
{
  "type": "INSERT",
  "table": "accounts",
  "schema": "public",
  "record":     { "id": "<uuid>", "email": "...", ... },
  "old_record": null
}
```

## 6. Test the wiring

Run all four checks after deploying the function and the webhook:

```sql
-- Project 1
insert into public.accounts (id, email)
values (gen_random_uuid(), 'mirror-test@example.com');

-- Wait ~5 seconds, then:
-- Project 2
select id, user_id, email, status, updated_at
from public.users_profile
where email = 'mirror-test@example.com';
-- Expect: 1 row, status='active'.
```

```sql
-- Project 1
update public.accounts
set email = 'mirror-renamed@example.com'
where email = 'mirror-test@example.com';

-- Project 2
select email, status from public.users_profile
where user_id = (select id from public.accounts where email = 'mirror-renamed@example.com');
-- Expect: email='mirror-renamed@example.com'.
```

```sql
-- Project 1
delete from public.accounts where email = 'mirror-renamed@example.com';

-- Project 2
select status from public.users_profile
where email = 'mirror-renamed@example.com';
-- Expect: status='inactive' (soft-deleted, not hard-deleted).
```

```sql
-- Project 2 — clean up the test row when done.
delete from public.users_profile where email = 'mirror-renamed@example.com';
```

If a test fails, check:
- **Project 1 → Edge Function logs** for stack traces / mapping errors.
- **Project 1 → Database Webhook logs** for delivery failures / non-2xx
  responses (this catches "Bearer mismatch" 401s).

## 7. Daily operations

- **A user signs up at zaein.semuapro.store** → row created in
  `accounts` → webhook fires → `users_profile` row appears within seconds.
  When the user logs into webstream the very first time, they're a Basic
  user with no expiry; admin can promote them to VIP / set `expired_at`
  from the adminweb1 panel.
- **Admin edits VIP / expiry on adminweb1** → write goes straight to
  Project 2 only. Project 1 is not affected.
- **A user changes their email at zaein.semuapro.store** → webhook fires →
  `users_profile.email` updates automatically.
