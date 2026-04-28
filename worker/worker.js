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

// GET /api/drive/resolve?path=/Movies/Foo.mp4  (atau ?link=full-url)
async function driveResolve(request, env) {
  const u = new URL(request.url);
  const raw = u.searchParams.get('path') || u.searchParams.get('link');
  if (!raw) return err('Parameter path atau link wajib');
  const gdiBase = (env.GDI_WORKER_URL || '').replace(/\/$/, '');
  if (!gdiBase) return err('GDI_WORKER_URL belum di-set di env worker', 500);
  const drivePath = normalizeDrivePath(raw, gdiBase);
  if (!drivePath) return err('Path drive tidak valid');
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
      return err(`GDI ${r.status}: ${text.slice(0, 200)}`, 502);
    }
    if (!data.link) {
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
    });
  } catch (e) {
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
  const profile = await getUserProfile(env, user.id);
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

  // === Supabase service ===
  try {
    const r = await supabaseRest(env, '/films?select=id&limit=1');
    checks.supabase = { ok: r.ok, status: r.status, message: r.ok ? 'OK' : 'HTTP ' + r.status };
  } catch (e) {
    checks.supabase = { ok: false, status: 0, message: 'Error: ' + e.message };
  }

  return json({ ok: true, checks, env: {
    has_subsource_key: !!env.SUBSOURCE_API_KEY,
    has_tmdb_key: !!env.TMDB_API_KEY,
    has_supabase_service_key: !!env.SUPABASE_SERVICE_KEY,
    has_admin_emails: !!env.ADMIN_EMAILS,
    admin_emails: (env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean),
    gdi_worker_url: env.GDI_WORKER_URL || null,
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
    const profile = await getUserProfile(env, user.id);
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
  const path = '/films?select=*&order=created_at.desc';
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
  const row = {
    judul: body.judul,
    tipe: body.tipe || 'movie',
    drive_link: body.drive_link || body.drive_path || null,
    drive_path: body.drive_path || body.drive_link || null,
    tahun: body.tahun || null,
    tmdb_id: body.tmdb_id || null,
    episode: body.episode || null,
    season: body.season || null,
    tier: (body.tier === 'vip' || body.tier === 'basic' || body.tier === 'free') ? body.tier : 'free',
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

  // 1. Update users_profile (vip / expired_at / email cache)
  const profilePatch = {};
  if (body.expired_at !== undefined) profilePatch.expired_at = body.expired_at;
  if (body.is_vip !== undefined) profilePatch.is_vip = !!body.is_vip;
  if (body.email !== undefined) profilePatch.email = body.email;
  if (Object.keys(profilePatch).length) {
    const r = await supabaseRest(env, `/users_profile?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(profilePatch),
    });
    if (!r.ok) return err('Gagal update profile: ' + JSON.stringify(r.data), 500);
  }

  // 2. Update auth (email / password) via Admin API
  const authPatch = {};
  if (body.email !== undefined) authPatch.email = body.email;
  if (body.password) authPatch.password = body.password;
  if (body.email !== undefined) authPatch.email_confirm = true;
  if (Object.keys(authPatch).length) {
    const ar = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(authPatch),
    });
    if (!ar.ok) {
      const t = await ar.text();
      return err('Gagal update auth: ' + t.slice(0, 200), 500);
    }
  }

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

    // === Static assets (index.html, dll) ===
    // Cloudflare akan otomatis serve dari ./public/ via [assets] di wrangler.toml
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return err('Not Found', 404);
  },
};
