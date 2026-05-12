/**
 * ZAEINSTREAM — Cloudflare Worker
 *
 * Tugas:
 * 1. Serve static assets (index.html, dll dari /public)
 * 2. Proxy ke Subsource API (subtitle search/download) dengan API key di env (aman)
 * 3. Proxy ke Drive Index Worker untuk dapat direct video link
 * 4. Admin API: tambah/edit/hapus film & user, manage VIP — pakai Supabase Service Key di env
 *
 * Semua secret HANYA di env vars Cloudflare. Tidak pernah dikirim ke browser.
 */

const SUBSOURCE_BASE = 'https://api.subsource.net/api/v1';
const PLAYER4ME_BASE = 'https://player4me.com/api/v1';

// Build the public player URL for a Player4Me video id. Always uses the
// admin's branded custom domain (PLAYER4ME_PUBLIC_DOMAIN, e.g.
// `zaeinstore.qzz.io`). The legacy fallback to `player4me.com/embed/<id>`
// was removed on purpose — that URL 404s for users who only own the
// white-label domain (the public player4me.com only serves THEIR id
// namespace, not ours). If the env var is not configured we return null
// so the caller surfaces a clear error instead of silently producing a
// broken iframe URL.
function player4meEmbedUrl(env, id) {
  if (!id) return null;
  const dom = (env && env.PLAYER4ME_PUBLIC_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!dom) return null;
  return `https://${dom}/#${id}`;
}

// Share URL is the same hash-style URL as the embed URL — Player4Me's
// custom domain uses ONE format (https://<dom>/#<id>) for both the player
// iframe AND the share link. The previous /#/<id> shape (with a slash
// after the hash) was a mis-read of the spec and 404s in practice.
function player4meShareUrl(env, id) {
  return player4meEmbedUrl(env, id);
}

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
const VIP_DOWNLOAD_LIMIT = 2;
const VIP_DOWNLOAD_TTL_MS = 30 * 60 * 1000;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
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

async function supabaseRpc(env, name, body) {
  return supabaseRest(env, `/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

// Verifikasi JWT user dari frontend → return user record dari Supabase.
// All auth lives in the LOCAL Supabase project (Zaeinstream). The cross-
// project / external supabase mirror was removed — there is now exactly
// one identity store, one signup surface, one logout target.
async function getUserFromAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Lookup users_profile in the LOCAL supabase by user_id, with email as a
// fallback for legacy rows that may not have user_id populated.
async function getUserProfile(env, userId, email) {
  if (userId) {
    const r = await supabaseRest(
      env,
      `/users_profile?user_id=eq.${userId}&select=user_id,email,is_vip,expired_at,password_plain`
    );
    if (r.ok && Array.isArray(r.data) && r.data.length) return r.data[0];
  }
  if (email) {
    const e = encodeURIComponent(email.toLowerCase());
    const r = await supabaseRest(
      env,
      `/users_profile?email=eq.${e}&select=user_id,email,is_vip,expired_at,password_plain`
    );
    if (r.ok && Array.isArray(r.data) && r.data.length) return r.data[0];
  }
  return null;
}

function nowIsoMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function isVipProfileActive(profile) {
  if (!profile || !profile.is_vip) return false;
  return !(profile.expired_at && new Date(profile.expired_at) < new Date());
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
// Player4Me proxy (video hosting + player)
//
// Admin uses these endpoints to:
//   - List videos (so they can pick a video URL when adding/editing a film)
//   - Get a single video by id
// The Player4Me API token NEVER leaves the worker — frontend just gets the
// JSON response shaped by the Player4Me REST API.
// ───────────────────────────────────────────────────────────────────

async function player4meFetch(env, path, opts = {}) {
  const token = (env.PLAYER4ME_API_TOKEN || '').trim();
  if (!token) {
    throw new Error('PLAYER4ME_API_TOKEN belum di-set di Cloudflare worker secrets');
  }
  const r = await fetch(`${PLAYER4ME_BASE}${path}`, {
    ...opts,
    headers: {
      'api-token': token,
      Accept: 'application/json',
      'User-Agent': 'zaeinstream-worker/1.0',
      ...(opts.headers || {}),
    },
  });
  return r;
}

// GET /api/admin/player4me/videos?page=1&perPage=30&search=foo
// Mirrors GET https://player4me.com/api/v1/video/manage with the worker's
// stored API token. Each row gets an extra `embed_url` and `share_url` so the
// admin UI can show a copy-to-clipboard button without hardcoding the URL
// pattern.
async function adminPlayer4meVideos(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const u = new URL(request.url);
  const page = u.searchParams.get('page') || '1';
  const perPage = u.searchParams.get('perPage') || '30';
  const search = u.searchParams.get('search') || '';
  const status = u.searchParams.get('status') || '';
  const params = new URLSearchParams();
  params.set('page', page);
  params.set('perPage', perPage);
  params.set('sort', 'createdAt');
  params.set('order', 'desc');
  if (search) params.set('search', search);
  if (status) params.set('status', status);

  try {
    const r = await player4meFetch(env, `/video/manage?${params.toString()}`);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!r.ok) {
      return err(`Player4Me list ${r.status}: ${typeof body === 'object' ? (body.message || body.error || text.slice(0, 200)) : text.slice(0, 200)}`, 502);
    }
    const data = Array.isArray(body && body.data) ? body.data : [];
    const enriched = data.map(v => ({
      ...v,
      embed_url: player4meEmbedUrl(env, v && v.id),
      share_url: player4meShareUrl(env, v && v.id),
    }));
    return json({
      ok: true,
      data: enriched,
      metadata: (body && body.metadata) || null,
    });
  } catch (e) {
    return err('Player4Me error: ' + e.message, 502);
  }
}

// GET /api/admin/player4me/balance — light health probe (also used by status grid).
async function adminPlayer4meBalance(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  try {
    const r = await player4meFetch(env, '/billing/balance');
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!r.ok) {
      return err(`Player4Me balance ${r.status}: ${typeof body === 'object' ? (body.message || body.error || text.slice(0, 200)) : text.slice(0, 200)}`, 502);
    }
    return json({ ok: true, data: body });
  } catch (e) {
    return err('Player4Me error: ' + e.message, 502);
  }
}

// ───────────────────────────────────────────────────────────────────
// Player4Me custom player domains (admin CRUD)
//
// Backed by public.player4me_domains (see migration 0007). Admin picks one
// of these in adminweb1 to build copy-paste embed URLs of the form
//   https://{domain}/#{videoId}
// which is the white-label / ad-free player. Exactly one row may be
// `is_default = true`; the API enforces that invariant on insert.
// ───────────────────────────────────────────────────────────────────

// Normalize a user-typed domain to a clean origin (no trailing slash, with
// scheme). Mirrors the spec:
//   "zaeinstore.qzz.io"           -> "https://zaeinstore.qzz.io"
//   "https://zaeinstore.qzz.io/"  -> "https://zaeinstore.qzz.io"
function normalizePlayer4meDomain(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  if (!s) return '';
  // Drop any path/query/hash the user may have pasted; we only keep the origin.
  s = s.replace(/\s+/g, '');
  if (!/^https?:\/\//i.test(s)) {
    s = 'https://' + s;
  }
  // Strip trailing slashes and anything after the host.
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

// GET /api/admin/player4me/domains — list every registered domain.
async function adminPlayer4meDomainsList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(
    env,
    '/player4me_domains?select=id,name,domain,is_default,created_at,updated_at&order=is_default.desc,created_at.asc'
  );
  if (!r.ok) return err(`Supabase ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 200)}`, 502);
  return json({ ok: true, data: Array.isArray(r.data) ? r.data : [] });
}

// POST /api/admin/player4me/domains — create a new domain.
// Body: { name, domain, is_default? }
async function adminPlayer4meDomainCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch { return err('JSON body wajib'); }

  const name = (typeof body.name === 'string' ? body.name.trim() : '');
  const domain = normalizePlayer4meDomain(body.domain);
  const isDefault = !!body.is_default;
  if (!name) return err('Field "name" wajib');
  if (!domain) return err('Field "domain" wajib');
  // Sanity-check the normalized URL.
  try {
    const u = new URL(domain);
    if (!u.host) throw new Error('host kosong');
  } catch (e) {
    return err('Domain tidak valid: ' + (e.message || domain));
  }

  // If the new row is the default, clear any prior default first so the
  // "exactly one default" invariant holds.
  if (isDefault) {
    const u = await supabaseRest(env, '/player4me_domains?is_default=eq.true', {
      method: 'PATCH',
      body: JSON.stringify({ is_default: false }),
      prefer: 'return=minimal',
    });
    if (!u.ok && u.status !== 404) {
      return err(`Gagal reset default: ${u.status}`, 502);
    }
  }

  const r = await supabaseRest(env, '/player4me_domains', {
    method: 'POST',
    body: JSON.stringify({ name, domain, is_default: isDefault }),
  });
  if (!r.ok) {
    // Postgres unique violation -> 409.
    if (r.status === 409 || (typeof r.data === 'object' && r.data && /duplicate|unique/i.test(r.data.message || ''))) {
      return err('Domain ini sudah terdaftar', 409);
    }
    return err(`Supabase ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 200)}`, 502);
  }
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return json({ ok: true, data: row });
}

// PATCH /api/admin/player4me/domains/:id — partial update.
// Allows renaming, normalizing domain, or flipping is_default.
async function adminPlayer4meDomainUpdate(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch { return err('JSON body wajib'); }

  const patch = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (typeof body.domain === 'string') {
    const norm = normalizePlayer4meDomain(body.domain);
    if (!norm) return err('Domain tidak valid');
    patch.domain = norm;
  }
  if (typeof body.is_default === 'boolean') patch.is_default = body.is_default;
  if (!Object.keys(patch).length) return err('Tidak ada field untuk di-update');

  if (patch.is_default === true) {
    const u = await supabaseRest(env, '/player4me_domains?is_default=eq.true', {
      method: 'PATCH',
      body: JSON.stringify({ is_default: false }),
      prefer: 'return=minimal',
    });
    if (!u.ok && u.status !== 404) return err(`Gagal reset default: ${u.status}`, 502);
  }

  const r = await supabaseRest(env, `/player4me_domains?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`Supabase ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 200)}`, 502);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return json({ ok: true, data: row });
}

// DELETE /api/admin/player4me/domains/:id
async function adminPlayer4meDomainDelete(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, `/player4me_domains?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  if (!r.ok) return err(`Supabase ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data).slice(0, 200)}`, 502);
  return json({ ok: true });
}

// ───────────────────────────────────────────────────────────────────
// (REMOVED) External Supabase / cross-project mirror helpers
//
// The dual-project auth architecture has been removed. Auth (login,
// signup, password edit) is now exclusively against the LOCAL Supabase
// (`SUPABASE_URL`). The mirror Edge Function in supabase/functions has
// also been deleted. If you still see references to EXTERNAL_SUPABASE_*
// anywhere, they are dead and can be removed.
// ───────────────────────────────────────────────────────────────────

// Internal helper for the LOCAL Supabase auth admin API. Used by signup +
// admin user create/update. Requires SUPABASE_URL + SUPABASE_SERVICE_KEY.
async function localAuthAdmin(env, path, opts = {}) {
  const url = `${env.SUPABASE_URL}/auth/v1/admin${path}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// Look up an auth user by email in the local Supabase. Returns null if not
// found. Used by signup so we don't create duplicates.
//
// Supabase GoTrue admin /users supports `filter=<term>` for fuzzy matching;
// the legacy `?email=` query param is silently ignored, which means querying
// it returns ALL users (the first page) and a naive `array.length > 0` check
// would incorrectly conclude that every email already exists. Always
// post-filter the result by exact (case-insensitive) email match.
async function localAuthFindByEmail(env, email) {
  if (!email) return null;
  const needle = email.toLowerCase();
  const e = encodeURIComponent(needle);
  const r = await localAuthAdmin(env, `/users?filter=${e}`, { method: 'GET' });
  if (!r.ok) return null;
  const users = Array.isArray(r.data) ? r.data
    : (r.data && Array.isArray(r.data.users)) ? r.data.users
    : [];
  return users.find(u => ((u && u.email) || '').toLowerCase() === needle) || null;
}

// ───────────────────────────────────────────────────────────────────
// Subsource proxy (subtitle)
// ───────────────────────────────────────────────────────────────────

async function subsourceFetch(env, path, opts = {}) {
  const url = `${SUBSOURCE_BASE}${path}`;
  const apiKey = (env.SUBSOURCE_API_KEY || '').trim();
  if (!apiKey) {
    // Throw supaya caller bisa balikin error dengan pesan yang jelas
    throw new Error('SUBSOURCE_API_KEY belum di-set di Cloudflare worker secrets');
  }
  const r = await fetch(url, {
    ...opts,
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
      'User-Agent': 'zaeinstream-worker/1.0',
      ...(opts.headers || {}),
    },
  });
  return r;
}

// GET /api/subsource/search?q=Stranger+Things&year=2026&type=series&imdb=tt...
// Subsource real params: searchType (required), q | imdb, year, type=all|movie|series, season
async function subsourceSearch(request, env) {
  const u = new URL(request.url);
  const q = u.searchParams.get('q');
  const imdb = u.searchParams.get('imdb');
  if (!q && !imdb) return err('Parameter q atau imdb wajib');
  const year = u.searchParams.get('year');
  let type = u.searchParams.get('type'); // 'movie' | 'tv' | 'series' | 'all'
  if (type === 'tv') type = 'series';
  const season = u.searchParams.get('season');

  const params = new URLSearchParams();
  params.set('searchType', imdb ? 'imdb' : 'text');
  if (q) params.set('q', q);
  if (imdb) params.set('imdb', imdb);
  if (year) params.set('year', year);
  if (type && ['movie', 'series', 'all'].includes(type)) params.set('type', type);
  if (season) params.set('season', season);

  try {
    const r = await subsourceFetch(env, `/movies/search?${params.toString()}`);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) return err(`Subsource search ${r.status}: ${typeof data === 'string' ? data.slice(0,200) : (data && (data.error || data.message)) || ''}`, 502);
    return json({ ok: true, data });
  } catch (e) {
    return err('Subsource error: ' + e.message, 502);
  }
}

// GET /api/subsource/subtitles?movie_id=123&lang=indonesian&season=1&episode=1
// Subsource real params: movieId, language, productionType, releaseType, page, limit
async function subsourceSubtitles(request, env) {
  const u = new URL(request.url);
  const movieId = u.searchParams.get('movie_id') || u.searchParams.get('movieId');
  if (!movieId) return err('Parameter movie_id wajib');
  const params = new URLSearchParams({ movieId });
  const lang = u.searchParams.get('lang') || u.searchParams.get('language');
  if (lang) params.set('language', lang);
  const productionType = u.searchParams.get('productionType');
  if (productionType) params.set('productionType', productionType);
  const releaseType = u.searchParams.get('releaseType');
  if (releaseType) params.set('releaseType', releaseType);
  const limit = u.searchParams.get('limit') || '100';
  params.set('limit', limit);

  try {
    const r = await subsourceFetch(env, `/subtitles?${params.toString()}`);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) return err(`Subsource subtitles ${r.status}: ${typeof data === 'string' ? data.slice(0,200) : (data && (data.error || data.message)) || ''}`, 502);
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
// TMDB helpers — proxy ke api.themoviedb.org pakai key di env (server-side)
// ───────────────────────────────────────────────────────────────────
async function tmdbFetch(env, path) {
  const key = env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY belum di-set di env');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(key)}&language=en-US`;
  return fetch(url);
}

// GET /api/tmdb/search?type=movie|tv&query=The%20Matrix
async function tmdbSearch(request, env) {
  const u = new URL(request.url);
  const type = u.searchParams.get('type') || 'movie';
  const query = u.searchParams.get('query') || '';
  if (!query) return err('Parameter query wajib');
  if (!['movie', 'tv'].includes(type)) return err('type harus movie atau tv');
  try {
    const r = await tmdbFetch(env, `/search/${type}?query=${encodeURIComponent(query)}&include_adult=false`);
    const data = await r.json();
    if (!r.ok) return err(`TMDB ${r.status}: ${data.status_message || ''}`, 502);
    return json({ ok: true, data });
  } catch (e) {
    return err('TMDB error: ' + e.message, 502);
  }
}

// GET /api/tmdb/movie/:id  atau  /api/tmdb/tv/:id
// Append=videos,credits,recommendations supaya frontend dapat semua data sekaligus
async function tmdbDetail(request, env, type, id) {
  if (!['movie', 'tv'].includes(type)) return err('type harus movie atau tv');
  if (!/^\d+$/.test(id)) return err('id TMDB harus angka');
  try {
    const r = await tmdbFetch(env, `/${type}/${id}?append_to_response=videos,credits,recommendations`);
    const data = await r.json();
    if (!r.ok) return err(`TMDB ${r.status}: ${data.status_message || ''}`, 502);
    return json({ ok: true, data });
  } catch (e) {
    return err('TMDB error: ' + e.message, 502);
  }
}

// GET /api/tmdb/tv/:id/season/:n — episode list (dengan still_path & nama episode)
async function tmdbSeason(request, env, id, season) {
  if (!/^\d+$/.test(id)) return err('id TMDB harus angka');
  if (!/^\d+$/.test(season)) return err('season harus angka');
  try {
    const r = await tmdbFetch(env, `/tv/${id}/season/${season}`);
    const data = await r.json();
    if (!r.ok) return err(`TMDB ${r.status}: ${data.status_message || ''}`, 502);
    return json({ ok: true, data });
  } catch (e) {
    return err('TMDB error: ' + e.message, 502);
  }
}

// GET /api/tmdb/multi?query=spider — search movie+tv+person sekaligus (untuk autocomplete)
async function tmdbMulti(request, env) {
  const u = new URL(request.url);
  const query = u.searchParams.get('query') || '';
  if (!query) return err('Parameter query wajib');
  try {
    const r = await tmdbFetch(env, `/search/multi?query=${encodeURIComponent(query)}&include_adult=false`);
    const data = await r.json();
    if (!r.ok) return err(`TMDB ${r.status}: ${data.status_message || ''}`, 502);
    return json({ ok: true, data });
  } catch (e) {
    return err('TMDB error: ' + e.message, 502);
  }
}

// ───────────────────────────────────────────────────────────────────
// Drive helper — call GDI worker to resolve path → signed stream URL
// ───────────────────────────────────────────────────────────────────
//
// Admin masukin "drive path" di Drive Index, contoh:
//   /Movies/One Piece/S02E01.mp4
// Worker ini POST ke GDI worker dengan path itu → GDI return JSON
// dengan field `link` = path /download.aspx?file=...&expiry=...&mac=...
// (signed, expired, encrypted dengan secret GDI). Kita bikin URL absolute
// dari GDI worker URL, ini yang dipakai <video src=...>.
//
// Frontend tetap bisa kirim link Drive lama → kita coba ekstrak path
// dari "link" param. Kalau yang dikirim sudah absolute URL ke GDI worker,
// kita parse path-nya.

// gdiFetch — wrapper yang otomatis pakai service binding (env.GDI) kalau ada,
// fallback ke plain fetch. Service binding dipakai supaya bypass Cloudflare
// error 1042 (Worker tidak boleh fetch Worker lain di *.workers.dev via URL).
async function gdiFetch(env, url, options) {
  if (env.GDI && typeof env.GDI.fetch === 'function') {
    return env.GDI.fetch(url, options);
  }
  return fetch(url, options);
}

function normalizeDrivePath(input, gdiBase) {
  if (!input) return null;
  let s = String(input).trim();
  // Buang base URL GDI kalau ada (mendukung paste URL utuh dari address bar GDI)
  try {
    const u = new URL(s);
    if (gdiBase && u.origin === new URL(gdiBase).origin) {
      // Buang query (mis: ?a=view) — kita cuma butuh path-nya untuk resolve POST
      s = u.pathname;
    }
  } catch { /* not a URL, treat as path */ }
  // Buang query string juga kalau pake plain string (mis: "/Movies/Foo.mp4?a=view")
  const qIdx = s.indexOf('?');
  if (qIdx >= 0) s = s.slice(0, qIdx);
  // Pastikan ada leading slash
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

async function acquireVipDownloadSlot(request, env, drivePath) {
  const user = await getUserFromAuth(request, env);
  if (!user) return { ok: false, response: err('Login dulu', 401) };

  const profile = await getUserProfile(env, user.id, user.email);
  if (!isVipProfileActive(profile)) {
    return { ok: false, response: err('Download VIP hanya untuk member VIP aktif', 403) };
  }

  const userId = profile.user_id || user.id;
  const token = crypto.randomUUID();
  const staleBefore = nowIsoMinus(VIP_DOWNLOAD_TTL_MS);

  const rpc = await supabaseRpc(env, 'acquire_vip_download_slot', {
    p_user_id: userId,
    p_film_path: drivePath,
    p_token: token,
    p_limit: VIP_DOWNLOAD_LIMIT,
    p_stale_before: staleBefore,
  });

  if (rpc.ok && rpc.data === true) return { ok: true, token };
  if (rpc.ok && rpc.data === false) {
    return {
      ok: false,
      response: err(`Maksimal ${VIP_DOWNLOAD_LIMIT} download VIP berjalan sekaligus per user`, 429),
    };
  }

  return { ok: false, response: err('Limit download VIP belum siap. Jalankan migration Supabase terbaru.', 500) };
}

async function releaseVipDownloadSlot(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const token = body && body.token ? String(body.token) : '';
  if (!token) return err('Token wajib', 400);
  const r = await supabaseRest(env, `/active_downloads?token=eq.${encodeURIComponent(token)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  if (!r.ok) return err('Gagal release download slot', 500);
  return json({ ok: true });
}

// GET /api/drive/resolve?path=/Movies/Foo.mp4  (atau ?link=full-url)
async function driveResolve(request, env, opts = {}) {
  const u = new URL(request.url);
  const raw = u.searchParams.get('path') || u.searchParams.get('link');
  if (!raw) return err('Parameter path atau link wajib');
  const gdiBase = (env.GDI_WORKER_URL || '').replace(/\/$/, '');
  if (!gdiBase) return err('GDI_WORKER_URL belum di-set di env worker', 500);
  const drivePath = normalizeDrivePath(raw, gdiBase);
  if (!drivePath) return err('Path drive tidak valid');
  let slot = null;
  if (opts.acquireSlot) {
    slot = await acquireVipDownloadSlot(request, env, drivePath);
    if (!slot.ok) return slot.response;
  }
  // Path file (bukan folder) → POST ke GDI dengan body kosong, GDI return { link: '/download.aspx?...' }
  try {
    const r = await gdiFetch(env, `${gdiBase}${drivePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok || !data) {
      if (slot) await supabaseRest(env, `/active_downloads?token=eq.${encodeURIComponent(slot.token)}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      return err(`GDI ${r.status}: ${text.slice(0, 200)}`, 502);
    }
    if (!data.link) {
      if (slot) await supabaseRest(env, `/active_downloads?token=eq.${encodeURIComponent(slot.token)}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      return err('File tidak ditemukan di Drive Index', 404);
    }
    const streamUrl = `${gdiBase}${data.link}`;
    return json({
      ok: true,
      drive_path: drivePath,
      stream_url: streamUrl,
      mime_type: data.mimeType || null,
      size: data.size || null,
      name: data.name || null,
      download_token: slot ? slot.token : null,
    });
  } catch (e) {
    if (slot) await supabaseRest(env, `/active_downloads?token=eq.${encodeURIComponent(slot.token)}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
    return err('GDI error: ' + e.message, 502);
  }
}

// ───────────────────────────────────────────────────────────────────
// Identity / Health
// ───────────────────────────────────────────────────────────────────

// GET /api/me — return profile + tier + isAdmin (untuk frontend)
async function meHandler(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return json({ ok: true, authenticated: false });
  const profile = await getUserProfile(env, user.id, user.email);
  let userTier = 'free';
  let expired = false;
  if (profile) {
    expired = profile.expired_at && new Date(profile.expired_at) < new Date();
    if (expired) userTier = 'expired';
    else userTier = profile.is_vip ? 'vip' : 'free';
  }
  return json({
    ok: true,
    authenticated: true,
    user: { id: user.id, email: user.email, created_at: user.created_at },
    profile: profile || null,
    tier: userTier,
    expired,
    is_admin: isAdminEmail(env, user.email || ''),
  });
}

// GET /api/admin/me — strict, hanya untuk gating panel adminweb1
async function adminMeHandler(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden — bukan admin', 403);
  return json({ ok: true, is_admin: true, email: admin.email, id: admin.id });
}

// GET /api/admin/health — cek status integrasi (subsource, GDI, supabase, tmdb)
// Hanya admin yang boleh akses (jangan expose status detail ke user biasa)
async function adminHealthHandler(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);

  const checks = {};

  // === Subsource ===
  try {
    if (!env.SUBSOURCE_API_KEY) {
      checks.subsource = { ok: false, status: 0, message: 'SUBSOURCE_API_KEY belum di-set di Cloudflare' };
    } else {
      const r = await subsourceFetch(env, '/movies/search?searchType=text&q=avengers&limit=1');
      checks.subsource = {
        ok: r.ok,
        status: r.status,
        message: r.ok ? 'API key valid' : `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`,
      };
    }
  } catch (e) {
    checks.subsource = { ok: false, status: 0, message: 'Error: ' + e.message };
  }

  // === TMDB ===
  try {
    if (!env.TMDB_API_KEY) {
      checks.tmdb = { ok: false, status: 0, message: 'TMDB_API_KEY belum di-set di Cloudflare' };
    } else {
      const r = await tmdbFetch(env, '/configuration');
      checks.tmdb = {
        ok: r.ok,
        status: r.status,
        message: r.ok ? 'API key valid' : `HTTP ${r.status}`,
      };
    }
  } catch (e) {
    checks.tmdb = { ok: false, status: 0, message: 'Error: ' + e.message };
  }

  // === GDI worker (Drive Index) ===
  try {
    const gdiBase = (env.GDI_WORKER_URL || '').replace(/\/$/, '');
    if (!gdiBase) {
      checks.drive = { ok: false, status: 0, message: 'GDI_WORKER_URL belum di-set di wrangler.toml' };
    } else {
      // GET ke root → harusnya 401 / 200 (kalau ada login GDI_USER/GDI_PASS)
      const r = await gdiFetch(env, gdiBase + '/', { method: 'GET' });
      const text = await r.text();
      const looksDown = r.status >= 500;
      const looksOk = r.status < 500;
      checks.drive = {
        ok: looksOk,
        status: r.status,
        message: looksDown
          ? 'GDI worker error 5xx — kemungkinan token Google Drive expired (refresh CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN)'
          : `Reachable (HTTP ${r.status}). Pastikan path file ada di Drive.`,
        url: gdiBase,
        body_preview: text.slice(0, 200),
      };
    }
  } catch (e) {
    checks.drive = { ok: false, status: 0, message: 'Error reaching GDI: ' + e.message };
  }

  // === Supabase service (local) ===
  try {
    const r = await supabaseRest(env, '/films?select=id&limit=1');
    checks.supabase = { ok: r.ok, status: r.status, message: r.ok ? 'OK' : 'HTTP ' + r.status };
  } catch (e) {
    checks.supabase = { ok: false, status: 0, message: 'Error: ' + e.message };
  }

  // === Player4Me ===
  try {
    if (!env.PLAYER4ME_API_TOKEN) {
      checks.player4me = { ok: false, status: 0, message: 'PLAYER4ME_API_TOKEN belum di-set di Cloudflare' };
    } else {
      const r = await player4meFetch(env, '/billing/balance');
      checks.player4me = {
        ok: r.ok,
        status: r.status,
        message: r.ok ? 'API token valid' : `HTTP ${r.status}`,
      };
    }
  } catch (e) {
    checks.player4me = { ok: false, status: 0, message: 'Error: ' + e.message };
  }

  // (External cross-project supabase removed — single auth project now.)

  return json({ ok: true, checks, env: {
    has_subsource_key: !!env.SUBSOURCE_API_KEY,
    has_tmdb_key: !!env.TMDB_API_KEY,
    has_supabase_service_key: !!env.SUPABASE_SERVICE_KEY,
    has_player4me_token: !!env.PLAYER4ME_API_TOKEN,
    has_admin_emails: !!env.ADMIN_EMAILS,
    admin_emails: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),
    gdi_worker_url: env.GDI_WORKER_URL || null,
    player4me_public_domain: env.PLAYER4ME_PUBLIC_DOMAIN || null,
    video_host_domain: env.PLAYER4ME_PUBLIC_DOMAIN || null,
  } });
}

// Helper: detect video-file extensions so admin folder probe bisa decide
// "series mode". Browser hampir cuma bisa play .mp4/.m4v native, tapi MKV/AVI
// masih kita izinin karena player external dropdown bisa handle.
const VIDEO_EXT_RE = /\.(mp4|m4v|mkv|webm|avi|mov)$/i;

// Helper: tebak nomor episode dari nama file. Pattern paling sering kepakai:
//   "S01E03", "Episode 4", "Ep05", "ep_05", "EP10", "01.", "- 03 -", "[03]"
// Kalau gak ketemu, return null — caller akan fallback urut alfabet.
function guessEpisodeNumber(filename) {
  if (!filename) return null;
  const base = filename.replace(/\.[^.]+$/, ''); // buang ekstensi
  const patterns = [
    /S\d{1,2}\s*[EX]\s*(\d{1,3})/i,           // S01E03, S1x03
    /\bE(?:p(?:isode)?)?\s*[._-]?\s*(\d{1,3})\b/i, // E03, Ep03, Episode 3
    /[\s\[\(_-]Ep\.?\s*(\d{1,3})\b/i,         // - Ep 3 -
    /[\s\[\(_-](\d{1,3})\s*[\]\)_-]/,          // - 03 -, [03]
    /^(\d{1,3})[\s._-]/,                       // 03 - The...
  ];
  for (const re of patterns) {
    const m = base.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n < 999) return n;
    }
  }
  return null;
}

// Helper: build URL aman dari path yang punya spasi atau karakter spesial.
// encodeURI preserve `/`, jadi struktur path tetap utuh, tapi spasi di-encode
// jadi %20 (penting karena GDI worker matching path persis).
function buildGdiUrl(gdiBase, drivePath) {
  return gdiBase + encodeURI(drivePath);
}

// Helper: probe 1 folder ke GDI, return parsed file list atau error.
async function probeFolder(env, gdiBase, folderPath) {
  const fullUrl = buildGdiUrl(gdiBase, folderPath);
  const r = await gdiFetch(env, fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (data && data.data && Array.isArray(data.data.files)) {
    return { ok: true, files: data.data.files, gdi_status: r.status, full_url: fullUrl };
  }
  return {
    ok: false,
    gdi_status: r.status,
    raw: text.slice(0, 500),
    full_url: fullUrl,
  };
}

// Helper: classify file list jadi {videoFiles, seasonFolders}.
function classifyFolderContents(files, parentPath) {
  const folderMime = 'application/vnd.google-apps.folder';
  const seasonRe = /^S(?:eason)?\s*0*(\d{1,2})\b/i;
  const videoFiles = [];
  const seasonFolders = [];
  const otherFolders = [];
  for (const f of files) {
    const name = f.name || '';
    if (f.mimeType === folderMime) {
      const m = name.match(seasonRe);
      if (m) seasonFolders.push({ name, season: parseInt(m[1], 10), path: parentPath + name + '/' });
      else otherFolders.push({ name, path: parentPath + name + '/' });
    } else if (VIDEO_EXT_RE.test(name)) {
      videoFiles.push({
        name,
        path: parentPath + name,
        size: f.size || null,
        episode_guess: guessEpisodeNumber(name),
      });
    }
  }
  return { videoFiles, seasonFolders, otherFolders };
}

// Helper: sort video files by episode number (kalau semua punya) atau natural alfabet.
function sortVideoFiles(vids) {
  const allHaveEp = vids.length > 0 && vids.every(v => v.episode_guess != null);
  if (allHaveEp) {
    vids.sort((a, b) => a.episode_guess - b.episode_guess);
  } else {
    vids.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }
  return vids;
}

// POST /api/admin/drive/test — test resolve sebuah path drive (admin only).
// 3 mode:
//   1. Path file (tidak akhiri "/"): cek bisa di-stream → return stream_url
//   2. Path folder berisi video files → series 1 season → video_files[]
//   3. Path folder berisi sub-folder S01/S02/... → multi-season → seasons[]
async function adminDriveTest(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json().catch(() => ({}));
  const path = body.path;
  if (!path) return err('Field path wajib');
  const gdiBase = (env.GDI_WORKER_URL || '').replace(/\/$/, '');
  if (!gdiBase) return err('GDI_WORKER_URL belum di-set', 500);
  const drivePath = normalizeDrivePath(path, gdiBase);
  const isFolder = drivePath.endsWith('/');
  const fullUrl = buildGdiUrl(gdiBase, drivePath);

  try {
    if (isFolder) {
      // ── Folder probe (level 1) ────────────────────────────────
      const lvl1 = await probeFolder(env, gdiBase, drivePath);
      if (!lvl1.ok) {
        return json({
          ok: true,
          gdi_ok: false,
          is_folder: true,
          gdi_status: lvl1.gdi_status,
          drive_path: drivePath,
          gdi_url_called: lvl1.full_url,
          gdi_base: gdiBase,
          error: 'Folder tidak bisa di-list (GDI '+lvl1.gdi_status+')',
          error_data: lvl1.raw,
          stream_url: null,
          video_files: [],
          seasons: [],
        });
      }
      const lvl1Cls = classifyFolderContents(lvl1.files, drivePath);

      // ── Multi-season detection (≥2 sub-folder S01/S02/...) ────
      if (lvl1Cls.seasonFolders.length >= 2) {
        const seasons = [];
        // Probe semua season folder paralel — masing-masing return list episode
        const probes = await Promise.all(
          lvl1Cls.seasonFolders.map(sf => probeFolder(env, gdiBase, sf.path))
        );
        for (let i = 0; i < lvl1Cls.seasonFolders.length; i++) {
          const sf = lvl1Cls.seasonFolders[i];
          const sub = probes[i];
          if (!sub.ok) continue;
          const subCls = classifyFolderContents(sub.files, sf.path);
          const vids = sortVideoFiles(subCls.videoFiles);
          if (vids.length > 0) {
            seasons.push({
              season: sf.season,
              folder_name: sf.name,
              folder_path: sf.path,
              video_files: vids,
            });
          }
        }
        seasons.sort((a, b) => a.season - b.season);
        const totalEps = seasons.reduce((n, s) => n + s.video_files.length, 0);
        return json({
          ok: true,
          gdi_ok: true,
          gdi_status: 200,
          is_folder: true,
          multi_season: true,
          drive_path: drivePath,
          gdi_url_called: fullUrl,
          gdi_base: gdiBase,
          seasons,
          season_count: seasons.length,
          total_episodes: totalEps,
          stream_url: null,
          data: { multi_season: true, seasons: seasons.length, episodes: totalEps },
        });
      }

      // ── Single-season folder (file langsung di dalam) ─────────
      const videoFiles = sortVideoFiles(lvl1Cls.videoFiles);
      return json({
        ok: true,
        gdi_ok: true,
        gdi_status: 200,
        is_folder: true,
        multi_season: false,
        drive_path: drivePath,
        gdi_url_called: fullUrl,
        gdi_base: gdiBase,
        service_binding_used: !!(env.GDI && typeof env.GDI.fetch === 'function'),
        video_files: videoFiles,
        non_video_count: lvl1.files.length - videoFiles.length - lvl1Cls.seasonFolders.length - lvl1Cls.otherFolders.length,
        sub_folder_count: lvl1Cls.seasonFolders.length + lvl1Cls.otherFolders.length,
        // legacy fields supaya frontend lama tetap kebaca tanpa pecah
        stream_url: null,
        data: { files_summary: { total: lvl1.files.length, videos: videoFiles.length } },
      });
    }

    // ── File mode (path tidak diakhiri /) ──────────────────────
    const r = await gdiFetch(env, fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return json({
      ok: true,
      gdi_ok: r.ok,
      gdi_status: r.status,
      is_folder: false,
      drive_path: drivePath,
      gdi_url_called: fullUrl,
      gdi_base: gdiBase,
      service_binding_used: !!(env.GDI && typeof env.GDI.fetch === 'function'),
      data: data || text.slice(0, 500),
      stream_url: data && data.link ? gdiBase + data.link : null,
    });
  } catch (e) {
    return err('GDI error: ' + e.message + ' (url=' + fullUrl + ')', 502);
  }
}

// ───────────────────────────────────────────────────────────────────
// Catalog API (films) — public read, admin write
// ───────────────────────────────────────────────────────────────────

// GET /api/catalog?tier=free|basic|vip|all  → list films
// Tier semantics:
//   free  = Basic + VIP (tampil di semua halaman, semua user bisa nonton)
//   basic = Basic saja (tampil di halaman utama, semua user bisa nonton)
//   vip   = VIP saja   (hanya VIP user yang bisa nonton)
async function catalogList(request, env) {
  const u = new URL(request.url);
  const tierFilter = u.searchParams.get('tier'); // 'free' | 'basic' | 'vip' | null

  // Coba ambil user untuk cek tier akses
  const user = await getUserFromAuth(request, env);
  let userTier = 'guest';
  if (user) {
    const profile = await getUserProfile(env, user.id, user.email);
    if (profile) {
      const expired = profile.expired_at && new Date(profile.expired_at) < new Date();
      if (expired) userTier = 'expired';
      else userTier = profile.is_vip ? 'vip' : 'free';
    }
  }

  // Kirim semua film ke frontend — frontend yang tentukan mana yang tampil di mana
  // (Home vs VIP Zone). Gate akses pas play tetap dicek di openFilm() + server saat
  // fetch stream URL kalau perlu. Ini biar badge "VIP" tetap keliatan sebagai teaser
  // di grid utama meski user bukan VIP, sama kayak Netflix.
  // Nested-select auto_subtitle_tracks via PostgREST relationship (ON films.id = auto_subtitle_tracks.film_id).
  const path = '/films?select=*,auto_subtitle_tracks(language,label,url,source)&order=created_at.desc';
  // Backward-compat: frontend lama boleh pakai ?tier=free untuk minta subset non-VIP
  let finalPath = path;
  if (tierFilter === 'free') {
    finalPath += '&or=(tier.eq.free,tier.eq.basic,tier.is.null)';
  } else if (tierFilter === 'vip') {
    finalPath += '&or=(tier.eq.vip,tier.eq.free,tier.is.null)';
  } else if (tierFilter === 'basic') {
    finalPath += '&tier.eq.basic';
  }

  const r = await supabaseRest(env, finalPath);
  if (!r.ok) return err('Gagal load katalog', 500);
  return json({ ok: true, user_tier: userTier, films: r.data || [] });
}

// POST /api/admin/films — admin only
async function adminFilmCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();
  // Tier rules:
  //   - vip   : iframe Player4Me (ad-free) + drive_path untuk download/external player
  //   - basic : iframe Player4Me (with-ads) only
  //   - free  : legacy / dual-tier rows (kept for backward compat)
  const tier = (body.tier === 'vip' || body.tier === 'basic' || body.tier === 'free') ? body.tier : 'free';
  const videoUrl = (typeof body.video_url === 'string' ? body.video_url.trim() : '') || null;
  const drivePath = (typeof body.drive_path === 'string' ? body.drive_path.trim() : '') || null;
  const driveLink = (typeof body.drive_link === 'string' ? body.drive_link.trim() : '') || drivePath;

  if (tier === 'vip') {
    if (!videoUrl) return err('VIP: video_url (Player4Me) wajib diisi');
    if (!drivePath) return err('VIP: drive_path wajib diisi (untuk download + external player)');
  } else if (tier === 'basic') {
    if (!videoUrl) return err('Basic: video_url (Player4Me) wajib diisi');
  }

  // The legacy `films.drive_link` column has a NOT NULL constraint in the
  // production DB. Basic-tier rows have no drive path (no download), so
  // coerce null → empty string to satisfy the constraint without forcing
  // every operator to run a migration. VIP rows still get the actual path.
  const safeDriveLink = driveLink == null ? '' : driveLink;
  const safeDrivePath = drivePath == null ? '' : drivePath;

  const row = {
    judul: body.judul,
    tipe: body.tipe || 'movie',
    drive_link: safeDriveLink,
    drive_path: safeDrivePath,
    video_url: videoUrl,
    tahun: body.tahun || null,
    tmdb_id: body.tmdb_id || null,
    episode: body.episode || null,
    season: body.season || null,
    tier,
    poster_url: body.poster_url || null,
    overview: body.overview || null,
    genre: body.genre || null,
    trailer_url: body.trailer_url || null,
    audio_tracks: Array.isArray(body.audio_tracks) ? body.audio_tracks : [],
    videos: Array.isArray(body.videos) ? body.videos : [],
    subtitles: Array.isArray(body.subtitles) ? body.subtitles : [],
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
  // Whitelist editable columns. We never let the client overwrite primary key
  // / created_at / created_by metadata.
  const allowed = [
    'judul', 'tipe', 'drive_link', 'drive_path', 'video_url',
    'tahun', 'tmdb_id', 'episode', 'season', 'tier',
    'poster_url', 'overview', 'genre', 'trailer_url',
    'audio_tracks', 'videos', 'subtitles',
  ];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  // Trim string URL fields so the streaming page never sees stray whitespace.
  for (const k of ['drive_link', 'drive_path', 'video_url']) {
    if (typeof patch[k] === 'string') {
      patch[k] = patch[k].trim();
    }
  }
  // `films.drive_link` and `films.drive_path` have NOT NULL constraints in the
  // production schema. For basic-tier films (no Drive backend), we coerce null
  // → '' so PATCH succeeds without a migration. video_url stays nullable.
  if ('drive_link' in patch && patch.drive_link == null) patch.drive_link = '';
  if ('drive_path' in patch && patch.drive_path == null) patch.drive_path = '';
  if (typeof patch.video_url === 'string' && patch.video_url === '') {
    patch.video_url = null;
  }
  const r = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
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

// ───────────────────────────────────────────────────────────────────
// (DEPRECATED) The old GitHub Actions / zaeinstore-processor pipeline
// for auto-subtitle extraction has been removed. Subtitles are now
// uploaded directly to Player4Me by the admin, so the worker no longer
// needs to dispatch external workflows or maintain a `subtitle_jobs`
// table. The corresponding /api/admin/extract-subs* endpoints are also
// removed from the router below.
// ───────────────────────────────────────────────────────────────────

// POST /api/auth/signup — self-serve registration (no email confirmation)
//
// Body: { email, password }
// Creates the auth.users row with email_confirm=true (so the user can log in
// immediately) and seeds the matching users_profile row including
// `password_plain` so admins can still see/edit it later.
async function authSignupHandler(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON', 400); }
  const email = (body && body.email || '').trim().toLowerCase();
  const password = (body && body.password || '').trim();
  if (!email) return err('Email wajib diisi', 400);
  if (!password) return err('Password wajib diisi', 400);
  if (password.length < 6) return err('Password minimal 6 karakter', 400);

  // If the auth user already exists, refuse — admin can edit them instead.
  const existing = await localAuthFindByEmail(env, email);
  if (existing) return err('Email sudah terdaftar. Silakan login.', 409);

  // 1. Create auth.users (email already confirmed — no verification step).
  const cr = await localAuthAdmin(env, '/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!cr.ok || !cr.data || !cr.data.id) {
    const msg = cr.data && (cr.data.msg || cr.data.message || cr.data.error_description || cr.data.error)
      ? (cr.data.msg || cr.data.message || cr.data.error_description || cr.data.error)
      : `Gagal membuat akun (HTTP ${cr.status})`;
    return err(msg, 500);
  }
  const userId = cr.data.id;

  // 2. Insert/upsert users_profile row including password_plain (so admin can
  //    view/edit later from the admin panel).
  const profileRow = {
    user_id: userId,
    email,
    is_vip: false,
    expired_at: null,
    password_plain: password,
  };
  const pr = await supabaseRest(env, '/users_profile', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(profileRow),
  });
  if (!pr.ok) {
    // Roll back the auth user so a future signup attempt can retry cleanly.
    try {
      await localAuthAdmin(env, `/users/${userId}`, { method: 'DELETE' });
    } catch { /* best-effort */ }
    return err('Gagal simpan profil: ' + JSON.stringify(pr.data).slice(0, 200), 500);
  }

  return json({ ok: true, user: { id: userId, email } });
}

// GET /api/admin/users — list users (includes password_plain so admin can view)
async function adminUserList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(
    env,
    '/users_profile?select=user_id,email,is_vip,expired_at,created_at,password_plain&order=created_at.desc'
  );
  if (!r.ok) return err('Gagal load users', 500);
  return json({ ok: true, users: r.data || [] });
}

// POST /api/admin/users — admin creates a user manually.
async function adminUserCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON', 400); }
  const email = (body && body.email || '').trim().toLowerCase();
  const password = (body && body.password || '').trim();
  const isVip = !!(body && body.is_vip);
  const expiredAt = body && body.expired_at ? body.expired_at : null;
  if (!email) return err('Email wajib diisi', 400);
  if (!password) return err('Password wajib diisi', 400);
  if (password.length < 6) return err('Password minimal 6 karakter', 400);

  const existing = await localAuthFindByEmail(env, email);
  if (existing) return err('Email sudah terdaftar.', 409);

  const cr = await localAuthAdmin(env, '/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!cr.ok || !cr.data || !cr.data.id) {
    return err('Gagal create auth: HTTP ' + cr.status, 500);
  }
  const userId = cr.data.id;

  const profileRow = {
    user_id: userId,
    email,
    is_vip: isVip,
    expired_at: expiredAt,
    password_plain: password,
  };
  const pr = await supabaseRest(env, '/users_profile', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(profileRow),
  });
  if (!pr.ok) {
    try { await localAuthAdmin(env, `/users/${userId}`, { method: 'DELETE' }); } catch {}
    return err('Gagal simpan profil: ' + JSON.stringify(pr.data).slice(0, 200), 500);
  }

  return json({ ok: true, user: { id: userId, email } });
}

async function adminUserUpdate(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json();

  // 1. Update users_profile (vip / expired_at / email / password_plain)
  const profilePatch = {};
  if (body.expired_at !== undefined) profilePatch.expired_at = body.expired_at;
  if (body.is_vip !== undefined) profilePatch.is_vip = !!body.is_vip;
  if (body.email !== undefined) profilePatch.email = (body.email || '').trim().toLowerCase();
  if (body.password) profilePatch.password_plain = body.password;
  if (Object.keys(profilePatch).length) {
    const r = await supabaseRest(env, `/users_profile?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(profilePatch),
    });
    if (!r.ok) return err('Gagal update profile: ' + JSON.stringify(r.data), 500);
  }

  // 2. Update auth.users (email / password) via Admin API
  const authPatch = {};
  if (body.email !== undefined) authPatch.email = (body.email || '').trim().toLowerCase();
  if (body.password) authPatch.password = body.password;
  if (body.email !== undefined) authPatch.email_confirm = true;
  if (Object.keys(authPatch).length) {
    const ar = await localAuthAdmin(env, `/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(authPatch),
    });
    if (!ar.ok) {
      return err('Gagal update auth: ' + JSON.stringify(ar.data).slice(0, 200), 500);
    }
  }

  return json({ ok: true });
}

async function adminUserDelete(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  // Hapus dari users_profile dulu
  await supabaseRest(env, `/users_profile?user_id=eq.${userId}`, { method: 'DELETE' });
  // Hapus dari local auth
  await localAuthAdmin(env, `/users/${userId}`, { method: 'DELETE' });
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
    // Frontend butuh tahu Supabase URL + anon key. Service key TIDAK pernah
    // di-expose. Single supabase project — no more cross-project mirror.
    if (pathname === '/api/config' && request.method === 'GET') {
      return json({
        ok: true,
        supabase_url: env.SUPABASE_URL,
        supabase_anon_key: env.SUPABASE_ANON_KEY || '',
        gdi_worker_url: env.GDI_WORKER_URL,
        tmdb_image_base: 'https://image.tmdb.org/t/p/w500',
        // Public CONFIG — keep this minimal; no backend identifiers leak.
        video_host_domain: env.PLAYER4ME_PUBLIC_DOMAIN || '',
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
      return driveResolve(request, env, { acquireSlot: url.searchParams.get('download') === '1' });
    }
    if (pathname === '/api/drive/release' && request.method === 'POST') {
      return releaseVipDownloadSlot(request, env);
    }

    // === Catalog (public read) ===
    if (pathname === '/api/catalog' && request.method === 'GET') {
      return catalogList(request, env);
    }

    // === Identity ===
    if (pathname === '/api/me' && request.method === 'GET') {
      return meHandler(request, env);
    }

    // === TMDB (any authenticated user; key tetap di-server, gak ke browser) ===
    if (pathname === '/api/tmdb/search' && request.method === 'GET') {
      const u = await getUserFromAuth(request, env);
      if (!u) return err('Login dulu', 401);
      return tmdbSearch(request, env);
    }
    if (pathname === '/api/tmdb/multi' && request.method === 'GET') {
      const u = await getUserFromAuth(request, env);
      if (!u) return err('Login dulu', 401);
      return tmdbMulti(request, env);
    }
    {
      const m = pathname.match(/^\/api\/tmdb\/(movie|tv)\/(\d+)$/);
      if (m && request.method === 'GET') {
        const u = await getUserFromAuth(request, env);
        if (!u) return err('Login dulu', 401);
        return tmdbDetail(request, env, m[1], m[2]);
      }
    }
    {
      const m = pathname.match(/^\/api\/tmdb\/tv\/(\d+)\/season\/(\d+)$/);
      if (m && request.method === 'GET') {
        const u = await getUserFromAuth(request, env);
        if (!u) return err('Login dulu', 401);
        return tmdbSeason(request, env, m[1], m[2]);
      }
    }

    // === Admin: identity / health (untuk gating adminweb1 + diagnostik) ===
    if (pathname === '/api/admin/me' && request.method === 'GET') {
      return adminMeHandler(request, env);
    }
    if (pathname === '/api/admin/health' && request.method === 'GET') {
      return adminHealthHandler(request, env);
    }
    if (pathname === '/api/admin/drive/test' && request.method === 'POST') {
      return adminDriveTest(request, env);
    }

    // === Auth: signup (no email verification per spec) ===
    if (pathname === '/api/auth/signup' && request.method === 'POST') {
      return authSignupHandler(request, env);
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

    // === Admin: Player4Me (video listing for admin UI) ===
    if (pathname === '/api/admin/player4me/videos' && request.method === 'GET') {
      return adminPlayer4meVideos(request, env);
    }
    if (pathname === '/api/admin/player4me/balance' && request.method === 'GET') {
      return adminPlayer4meBalance(request, env);
    }

    // === Admin: Player4Me player domains (white-label / VIP embed) ===
    if (pathname === '/api/admin/player4me/domains' && request.method === 'GET') {
      return adminPlayer4meDomainsList(request, env);
    }
    if (pathname === '/api/admin/player4me/domains' && request.method === 'POST') {
      return adminPlayer4meDomainCreate(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/player4me\/domains\/([^/]+)$/);
      if (m && request.method === 'PATCH') return adminPlayer4meDomainUpdate(request, env, m[1]);
      if (m && request.method === 'DELETE') return adminPlayer4meDomainDelete(request, env, m[1]);
    }

    // === Admin: auto-subtitle pipeline (DEPRECATED — zaeinstore-processor)
    // Routes intentionally removed. Subtitle upload now goes through Player4Me.
    // The existing handler functions remain in this file for git history but
    // are no longer reachable from the router.
    if (pathname.startsWith('/api/admin/extract-subs')) {
      return err('Endpoint dihapus — sub sekarang via Player4Me', 410);
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

    // === Static assets (index.html, dll) ===
    // Cloudflare akan otomatis serve dari ./public/ via [assets] di wrangler.toml
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return err('Not Found', 404);
  },
};
