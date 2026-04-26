/**
 * ZAEINSTREAM — Cloudflare Worker
 *
 * Tugas:
 * 1. Serve static assets (index.html, admin.html, dll dari /public)
 * 2. Proxy ke Subsource API (subtitle search/download) dengan API key di env (aman)
 * 3. Proxy ke Drive Index Worker untuk dapat direct video link
 * 4. Admin API: tambah/edit/hapus film & user, manage VIP — pakai Supabase Service Key di env
 *
 * Semua secret HANYA di env vars Cloudflare. Tidak pernah dikirim ke browser.
 */

const SUBSOURCE_BASE = 'https://api.subsource.net/api/v1';

// ───────────────────────────────────────────────────────────────────
// Util
// ───────────────────────────────────────────────────────────────────

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });

const err = (msg, status = 400) => json({ ok: false, error: msg }, status);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

// ───────────────────────────────────────────────────────────────────
// Supabase REST helper (untuk admin API & verifikasi user)
// ───────────────────────────────────────────────────────────────────

async function supabaseRest(env, path, opts = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer || 'return=representation',
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Verifikasi JWT user dari frontend → return user record dari Supabase
async function getUserFromAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  // Ambil user dari Supabase Auth via JWT
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  return await r.json();
}

async function getUserProfile(env, userId) {
  const r = await supabaseRest(
    env,
    `/users_profile?user_id=eq.${userId}&select=user_id,email,is_vip,expired_at`
  );
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}

function isAdminEmail(env, email) {
  if (!email) return false;
  const list = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
  return list.includes(email.toLowerCase());
}

async function requireAdmin(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user || !user.email) return null;
  if (!isAdminEmail(env, user.email)) return null;
  return user;
}

// ───────────────────────────────────────────────────────────────────
// Subsource proxy (subtitle)
// ───────────────────────────────────────────────────────────────────

async function subsourceFetch(env, path, opts = {}) {
  const url = `${SUBSOURCE_BASE}${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      'X-API-Key': env.SUBSOURCE_API_KEY,
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  });
  return r;
}

// GET /api/subsource/search?q=Stranger+Things&year=2026&type=tv
async function subsourceSearch(request, env) {
  const u = new URL(request.url);
  const q = u.searchParams.get('q');
  if (!q) return err('Parameter q wajib');
  const year = u.searchParams.get('year');
  const type = u.searchParams.get('type'); // 'movie' | 'tv'

  const params = new URLSearchParams({ query: q });
  if (year) params.set('year', year);
  if (type) params.set('type', type);

  try {
    const r = await subsourceFetch(env, `/movies/search?${params.toString()}`);
    if (!r.ok) return err(`Subsource search ${r.status}`, 502);
    const data = await r.json();
    return json({ ok: true, data });
  } catch (e) {
    return err('Subsource error: ' + e.message, 502);
  }
}

// GET /api/subsource/subtitles?movie_id=123&lang=indonesian&season=1&episode=1
async function subsourceSubtitles(request, env) {
  const u = new URL(request.url);
  const movieId = u.searchParams.get('movie_id');
  if (!movieId) return err('Parameter movie_id wajib');
  const params = new URLSearchParams({ movie_id: movieId });
  const lang = u.searchParams.get('lang');
  if (lang) params.set('language', lang);
  const season = u.searchParams.get('season');
  if (season) params.set('season', season);
  const episode = u.searchParams.get('episode');
  if (episode) params.set('episode', episode);

  try {
    const r = await subsourceFetch(env, `/subtitles?${params.toString()}`);
    if (!r.ok) return err(`Subsource subtitles ${r.status}`, 502);
    const data = await r.json();
    return json({ ok: true, data });
  } catch (e) {
    return err('Subsource error: ' + e.message, 502);
  }
}

// GET /api/subsource/download/:id  → return raw .srt as text
async function subsourceDownload(request, env, id) {
  if (!id) return err('Subtitle id wajib');
  try {
    const r = await subsourceFetch(env, `/subtitles/${encodeURIComponent(id)}/download`);
    if (!r.ok) return err(`Subsource download ${r.status}`, 502);
    // Forward dengan CORS supaya bisa di-fetch dari browser
    const text = await r.text();
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return err('Subsource error: ' + e.message, 502);
  }
}

// ───────────────────────────────────────────────────────────────────
// Drive helper — extract file id, build stream URL via GDI worker
// ───────────────────────────────────────────────────────────────────

function extractDriveId(link) {
  if (!link) return null;
  // Format umum: /file/d/{id}/, ?id={id}, /folders/{id}, /open?id=...
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,
    /\/folders\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];
  for (const p of patterns) {
    const m = link.match(p);
    if (m) return m[1];
  }
  return null;
}

// GET /api/drive/resolve?link=...  → return { stream_url, file_id }
async function driveResolve(request, env) {
  const u = new URL(request.url);
  const link = u.searchParams.get('link');
  const fileId = extractDriveId(link);
  if (!fileId) return err('Link Drive tidak valid');
  // GDI worker punya endpoint /down yang stream langsung
  const streamUrl = `${env.GDI_WORKER_URL}/down/${fileId}`;
  return json({ ok: true, file_id: fileId, stream_url: streamUrl });
}

// ───────────────────────────────────────────────────────────────────
// Catalog API (films) — public read, admin write
// ───────────────────────────────────────────────────────────────────

// GET /api/catalog?tier=free|vip|all  → list films
async function catalogList(request, env) {
  const u = new URL(request.url);
  const tierFilter = u.searchParams.get('tier'); // 'free' | 'vip' | null

  // Coba ambil user untuk cek tier akses
  const user = await getUserFromAuth(request, env);
  let userTier = 'guest';
  if (user) {
    const profile = await getUserProfile(env, user.id);
    if (profile) {
      const expired = profile.expired_at && new Date(profile.expired_at) < new Date();
      if (expired) userTier = 'expired';
      else userTier = profile.is_vip ? 'vip' : 'free';
    }
  }

  // VIP boleh lihat semua, free hanya tier=free, guest hanya tier=free juga (preview)
  let path = '/films?select=*&order=created_at.desc';
  if (tierFilter === 'free' || userTier === 'free' || userTier === 'guest') {
    path += '&or=(tier.eq.free,tier.is.null)';
  }
  // VIP tidak filter — boleh lihat semua

  const r = await supabaseRest(env, path);
  if (!r.ok) return err('Gagal load katalog', 500);
  return json({ ok: true, user_tier: userTier, films: r.data || [] });
}

// POST /api/admin/films — admin only
async function adminFilmCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();
  const row = {
    judul: body.judul,
    tipe: body.tipe || 'movie',
    drive_link: body.drive_link,
    tahun: body.tahun || null,
    tmdb_id: body.tmdb_id || null,
    episode: body.episode || null,
    season: body.season || null,
    tier: body.tier === 'vip' ? 'vip' : 'free',
    poster_url: body.poster_url || null,
    overview: body.overview || null,
    genre: body.genre || null,
  };
  const r = await supabaseRest(env, '/films', {
    method: 'POST',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('Gagal simpan: ' + JSON.stringify(r.data), 500);
  return json({ ok: true, film: Array.isArray(r.data) ? r.data[0] : r.data });
}

async function adminFilmUpdate(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();
  const r = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!r.ok) return err('Gagal update', 500);
  return json({ ok: true });
}

async function adminFilmDelete(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!r.ok) return err('Gagal hapus', 500);
  return json({ ok: true });
}

// GET /api/admin/users — list users
async function adminUserList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(
    env,
    '/users_profile?select=user_id,email,is_vip,expired_at,created_at&order=created_at.desc'
  );
  if (!r.ok) return err('Gagal load users', 500);
  return json({ ok: true, users: r.data || [] });
}

// POST /api/admin/users  — create user (signup + insert profile)
async function adminUserCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();
  const { email, password, expired_at, is_vip } = body;
  if (!email || !password) return err('email & password wajib');

  // 1. Buat akun di Supabase Auth pakai Admin API
  const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const authData = await authRes.json();
  if (!authRes.ok) return err('Auth: ' + (authData.msg || 'gagal'), 500);

  // 2. Insert profile
  const exp = expired_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const r = await supabaseRest(env, '/users_profile', {
    method: 'POST',
    body: JSON.stringify({
      user_id: authData.id,
      email,
      expired_at: exp,
      is_vip: !!is_vip,
    }),
  });
  if (!r.ok) return err('Profile: ' + JSON.stringify(r.data), 500);
  return json({ ok: true, user: { id: authData.id, email, expired_at: exp, is_vip: !!is_vip } });
}

async function adminUserUpdate(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();
  const patch = {};
  if (body.expired_at !== undefined) patch.expired_at = body.expired_at;
  if (body.is_vip !== undefined) patch.is_vip = !!body.is_vip;
  const r = await supabaseRest(env, `/users_profile?user_id=eq.${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err('Gagal update', 500);
  return json({ ok: true });
}

async function adminUserDelete(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  // Hapus dari users_profile dulu
  await supabaseRest(env, `/users_profile?user_id=eq.${userId}`, { method: 'DELETE' });
  // Hapus dari auth
  await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  return json({ ok: true });
}

// ───────────────────────────────────────────────────────────────────
// Router
// ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // === Public expose config (NON-secret only) ===
    // Frontend butuh tahu Supabase URL + anon key. Service key TIDAK pernah di-expose.
    if (pathname === '/api/config' && request.method === 'GET') {
      return json({
        ok: true,
        supabase_url: env.SUPABASE_URL,
        supabase_anon_key: env.SUPABASE_ANON_KEY || '',
        gdi_worker_url: env.GDI_WORKER_URL,
        tmdb_image_base: 'https://image.tmdb.org/t/p/w500',
      });
    }

    // === Subsource ===
    if (pathname === '/api/subsource/search' && request.method === 'GET') {
      return subsourceSearch(request, env);
    }
    if (pathname === '/api/subsource/subtitles' && request.method === 'GET') {
      return subsourceSubtitles(request, env);
    }
    {
      const m = pathname.match(/^\/api\/subsource\/download\/(.+)$/);
      if (m && request.method === 'GET') return subsourceDownload(request, env, m[1]);
    }

    // === Drive ===
    if (pathname === '/api/drive/resolve' && request.method === 'GET') {
      return driveResolve(request, env);
    }

    // === Catalog (public read) ===
    if (pathname === '/api/catalog' && request.method === 'GET') {
      return catalogList(request, env);
    }

    // === Admin: films ===
    if (pathname === '/api/admin/films' && request.method === 'POST') {
      return adminFilmCreate(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/films\/([^/]+)$/);
      if (m && request.method === 'PATCH') return adminFilmUpdate(request, env, m[1]);
      if (m && request.method === 'DELETE') return adminFilmDelete(request, env, m[1]);
    }

    // === Admin: users ===
    if (pathname === '/api/admin/users' && request.method === 'GET') {
      return adminUserList(request, env);
    }
    if (pathname === '/api/admin/users' && request.method === 'POST') {
      return adminUserCreate(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (m && request.method === 'PATCH') return adminUserUpdate(request, env, m[1]);
      if (m && request.method === 'DELETE') return adminUserDelete(request, env, m[1]);
    }

    // === Static assets (index.html, admin.html, dll) ===
    // Cloudflare akan otomatis serve dari ./public/ via [assets] di wrangler.toml
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return err('Not Found', 404);
  },
};
