# 🎬 ZAEINSTREAM

Platform streaming film & series eksklusif dengan UI mirip [streamex.net](https://www.streamex.net/).

- **Frontend** — UI streamex-style (sidebar + grid + dark theme), responsive PC + mobile
- **Auth** — Supabase (email + password), VIP gating
- **Video** — Google Drive Index (Cloudflare Worker terpisah)
- **Subtitle** — Subsource API (search by judul + pilih bahasa, auto-load ke player)
- **Admin Panel terpisah** di repo [`shaanieel/adminweb1`](https://github.com/shaanieel/adminweb1) — manage film, user, VIP akses lewat domain sendiri (cross-origin, panggil `/api/admin/*` di sini)
- **Hanya menampilkan film yang admin tambahkan** (curated catalog di Supabase)

URL produksi: <https://webstream.zaeinstreamx.workers.dev>

---

## 📐 Struktur

```
webstream/
├── public/                    # Static assets (di-serve di "/")
│   └── index.html             # Frontend utama (streamex-style)
│
├── worker/
│   └── worker.js              # Main Cloudflare Worker
│                              #   • Serve public/* assets
│                              #   • /api/config (publik, non-secret)
│                              #   • /api/subsource/* (proxy + key di env)
│                              #   • /api/drive/resolve (resolve drive link)
│                              #   • /api/catalog (public read, filter by tier)
│                              #   • /api/admin/* (auth required, admin only — dipanggil dari adminweb1)
│
├── gdi-worker/                # Worker terpisah untuk Drive Index
│   ├── indexgoogle.js         # GDI-JS (Parveen Bhadoo) — proxy ke Drive
│   ├── wrangler.toml
│   └── README.md
│
├── wrangler.toml              # Config main worker
├── package.json
└── README.md
```

---

## 🗄️ Schema Supabase

Pastikan tabel-tabel ini ada di Supabase. Jalankan SQL berikut sekali:

```sql
-- Profile + VIP
create table if not exists users_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  is_vip boolean default false,
  expired_at timestamptz,
  created_at timestamptz default now()
);

-- Catalog film (curated)
create table if not exists films (
  id bigserial primary key,
  judul text not null,
  tipe text default 'movie' check (tipe in ('movie','series')),
  drive_link text not null,
  tahun text,
  tmdb_id text,
  episode int,
  season int,
  tier text default 'free' check (tier in ('free','vip')),
  poster_url text,
  backdrop_url text,
  overview text,
  genre text,
  created_at timestamptz default now()
);

-- Index untuk performance
create index if not exists films_tier_idx on films(tier);
create index if not exists films_tipe_idx on films(tipe);
create index if not exists films_judul_idx on films(judul);

-- RLS
alter table users_profile enable row level security;
alter table films enable row level security;

-- Policy: user bisa baca profile sendiri
create policy "users read own profile" on users_profile
  for select using (auth.uid() = user_id);

-- Policy: catalog films boleh dibaca semua user (frontend filter di sisi server worker)
create policy "anyone can read films" on films
  for select using (true);

-- Catatan: write ke films & users_profile dilakukan worker (pakai service key, bypass RLS).
```

Kalau tabel `users_profile` & `films` sudah ada dari sebelumnya, jalankan **migration tier**:

```sql
alter table films add column if not exists tier text default 'free' check (tier in ('free','vip'));
alter table films add column if not exists season int;
alter table films add column if not exists poster_url text;
alter table films add column if not exists backdrop_url text;
alter table films add column if not exists overview text;
alter table films add column if not exists genre text;
update films set tier='free' where tier is null;
```

---

## 🚀 Deploy

### 1. Pre-requisites

```bash
npm install
wrangler login
```

### 2. Set secrets di Cloudflare (jangan commit ke Git!)

```bash
# Subsource API key (dapat dari https://subsource.net/profile)
wrangler secret put SUBSOURCE_API_KEY

# Supabase service role key (dashboard Supabase → Settings → API → service_role)
wrangler secret put SUPABASE_SERVICE_KEY

# Supabase anon key (publik, OK kalau di-expose)
wrangler secret put SUPABASE_ANON_KEY
```

### 3. Deploy main worker

```bash
wrangler deploy
```

### 4. Deploy GDI worker (sekali saja, atau update kalau ada perubahan)

```bash
cd gdi-worker
wrangler secret put CLIENT_ID
wrangler secret put CLIENT_SECRET
wrangler secret put REFRESH_TOKEN
wrangler secret put GDI_USER
wrangler secret put GDI_PASS
wrangler deploy
cd ..
```

---

## 🔄 Alur sistem

### A. User login → tonton film

```
Browser
  ↓ POST /auth/signin (Supabase)
Supabase → return JWT
  ↓ GET /api/config
Worker → return { supabase_url, supabase_anon_key, gdi_worker_url }
  ↓ GET /api/catalog (Authorization: Bearer JWT)
Worker → cek tier user → query Supabase films → return films sesuai tier
  ↓ user klik film
  ↓ GET /api/drive/resolve?link=...
Worker → extract file_id → return stream_url (GDI worker)
  ↓ VideoJS load video
  ↓ user klik "Subs" → cari di Subsource
  ↓ GET /api/subsource/search?q=...&type=movie&year=...
Worker → call api.subsource.net (X-API-Key di env) → return list
  ↓ user pilih bahasa → pilih release
  ↓ GET /api/subsource/download/{id}
Worker → fetch SRT dari Subsource → return text/plain
  ↓ Browser: SRT → VTT → addRemoteTextTrack ke VideoJS
```

### B. Admin tambah film  (dari repo `adminweb1`)

```
adminweb1 (https://adminweb1.zaeinstreamx.workers.dev)
  ↓ login (Supabase)
  ↓ POST https://webstream.zaeinstreamx.workers.dev/api/admin/films
    Headers: Authorization: Bearer JWT
webstream worker
  ↓ verifikasi JWT → cek email di ADMIN_EMAILS env
  ↓ INSERT ke films via Supabase Service Key
Supabase → return film row
  ↓ adminweb1 auto-refresh tabel
```

### C. Admin manage VIP

```
adminweb1 → tab "VIP Akses"
  ↓ klik "Beri VIP" untuk user
  ↓ PATCH https://webstream.zaeinstreamx.workers.dev/api/admin/users/{user_id} { is_vip: true }
webstream worker → verifikasi admin → UPDATE users_profile via service key
  ↓ User reload → sekarang bisa lihat film tier=vip
```

---

## 🔐 Security checklist

✅ **Tidak ada secret di frontend** — semua via worker
- Subsource API key → `SUBSOURCE_API_KEY` (worker secret)
- Supabase service key → `SUPABASE_SERVICE_KEY` (worker secret)
- Google OAuth credentials → `CLIENT_SECRET`, `REFRESH_TOKEN` (gdi-worker secret)

✅ **Admin route diproteksi**
- Worker verifikasi JWT dari header `Authorization`
- Bandingkan email user dengan `ADMIN_EMAILS` env (comma-separated)
- Hanya admin yang boleh INSERT/UPDATE/DELETE films + users

✅ **RLS di Supabase**
- `users_profile.select` hanya untuk user sendiri
- `films.select` boleh public (filter dilakukan di worker)

⚠️ **Yang harus kamu lakukan setelah merge PR ini:**
1. **Rotate semua kredensial yang sebelumnya ter-expose** (Google OAuth, Supabase service key, password GDI). Yang lama mungkin sudah dipakai orang.
2. **Rotate Subsource API key** kalau pernah di-share.
3. (Opsional) Hapus secrets dari git history pakai [`git filter-repo`](https://github.com/newren/git-filter-repo).

---

## 🛠 Development lokal

```bash
npm run dev
# Buka http://localhost:8787
```

Untuk test API tanpa deploy:
```bash
curl http://localhost:8787/api/config
curl "http://localhost:8787/api/subsource/search?q=Avengers&year=2019"
```

---

## 🆘 Troubleshooting

**"Gagal memuat katalog"**
- Cek RLS policy di Supabase → `films` harus punya policy SELECT untuk role `anon`.

**"Subsource error 401"**
- API key tidak valid. Generate ulang di <https://subsource.net/profile>.

**"Video tidak play"**
- Cek apakah `drive_link` valid dan file tersedia di Drive.
- Cek GDI worker masih hidup: <https://indexgoogle.zaeinstream.workers.dev/>.
- Cek expiry refresh token Google OAuth (perlu re-auth setiap beberapa bulan).

**"Forbidden" saat akses admin panel (di `adminweb1`)**
- Email kamu belum terdaftar di `ADMIN_EMAILS` (di `wrangler.toml` → vars di repo ini).
- Update lalu `wrangler deploy` ulang.

**Admin panel "Network error / CORS"**
- Pastikan `webstream` sudah di-deploy.
- Worker sudah `Access-Control-Allow-Origin: *`, jadi domain `adminweb1.*.workers.dev` boleh akses tanpa perlu setting tambahan.
