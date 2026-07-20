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
      ...securityHeaders(),
      ...corsHeaders(),
      ...extraHeaders,
    },
  });

const err = (msg, status = 400) => json({ ok: false, error: msg }, status);
const VIP_DOWNLOAD_LIMIT = 2;
const VIP_DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MOVIE_PRICE = 2500;
const DEFAULT_SERIES_SEASON_PRICE = 5000;
const VIP_MONTH_PRICE = 49000;
const VIP_WEEK_PRICE = 19000;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  };
}

function minifyHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function serveAsset(request, env) {
  const res = await env.ASSETS.fetch(request);
  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return res;

  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  headers.delete('Content-Length');

  let html = await res.text();
  html = html
    .replace(/\/assets\/app\.css\?v=[^"']+/g, '/assets/app.css?v=20260720-r2-inventory-fs2')
    .replace(/\/assets\/app\.js\?v=[^"']+/g, '/assets/app.js?v=20260720-r2-inventory-fs2');
  return new Response(minifyHtml(html), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
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
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data, contentRange: res.headers.get('content-range') || '' };
}

// Read a PostgREST collection past Supabase's hard 1000-row default by
// looping with the Range header until contentRange tells us we got it all.
// Use this for endpoints that may need every row (catalog, films-by-tmdb,
// etc.) — single supabaseRest() will silently truncate at 1000 otherwise.
async function supabaseRestAll(env, path, opts = {}) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const r = await supabaseRest(env, path, {
      ...opts,
      prefer: 'count=exact',
      headers: { ...(opts.headers || {}), Range: `${from}-${to}`, 'Range-Unit': 'items' },
    });
    if (!r.ok) return r;
    const rows = Array.isArray(r.data) ? r.data : [];
    out.push(...rows);
    // Stop when fewer than PAGE rows came back (last page) or we exceed
    // the total reported in Content-Range ("0-999/1161").
    let total = null;
    if (r.contentRange) {
      const m = /\/(\d+|\*)$/.exec(r.contentRange);
      if (m && m[1] !== '*') total = parseInt(m[1], 10);
    }
    if (rows.length < PAGE) break;
    if (total != null && out.length >= total) break;
    // Safety: cap at 50k rows so a malformed path can't infinite-loop.
    if (out.length >= 50000) break;
  }
  return { ok: true, status: 200, data: out };
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
  async function _normalizeVipState(row) {
    if (!row) return row;
    const exp = row.expired_at ? new Date(row.expired_at) : null;
    const expired = !!(row.is_vip && exp && exp < new Date());
    if (!expired) return row;
    try {
      await supabaseRest(env, `/users_profile?user_id=eq.${encodeURIComponent(row.user_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_vip: false, expired_at: null }),
      });
    } catch {}
    return { ...row, is_vip: false, expired_at: null };
  }
  if (userId) {
    const r = await supabaseRest(
      env,
      `/users_profile?user_id=eq.${userId}&select=user_id,email,is_vip,expired_at,password_plain,created_at`
    );
    if (r.ok && Array.isArray(r.data) && r.data.length) return _normalizeVipState(r.data[0]);
  }
  if (email) {
    const e = encodeURIComponent(email.toLowerCase());
    const r = await supabaseRest(
      env,
      `/users_profile?email=eq.${e}&select=user_id,email,is_vip,expired_at,password_plain,created_at`
    );
    if (r.ok && Array.isArray(r.data) && r.data.length) return _normalizeVipState(r.data[0]);
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

async function sendTelegramNotif(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('telegram notif gagal:', e && e.message);
  }
}

function telegramEsc(s) {
  return String(s == null ? '-' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function telegramTime(d = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d) + ' WIB';
}

function requestMeta(request) {
  const cf = request.cf || {};
  return {
    ip: request.headers.get('CF-Connecting-IP') || '-',
    country: cf.country || '-',
    city: cf.city || '-',
    ua: (request.headers.get('User-Agent') || '-').slice(0, 110),
  };
}

function buildAuthTelegramMsg(opts) {
  const { type, email, ip, country, city, ua, reason } = opts;
  // REGISTER
  if (type === 'register') {
    return [
      '🆕 <b>USER BARU DAFTAR — ZAEINSTREAM</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `📧 <b>Email</b>     <code>${telegramEsc(email)}</code>`,
      `🌐 <b>IP</b>        <code>${telegramEsc(ip)}</code>`,
      `📍 <b>Lokasi</b>    ${telegramEsc(city)}, ${telegramEsc(country)}`,
      `🖥️ <b>Device</b>    ${telegramEsc(ua)}`,
      `🕐 <b>Waktu</b>     ${telegramTime()}`,
      '━━━━━━━━━━━━━━━━━━━━',
      '<i>zaeinstream.my.id</i>',
    ].join('\n');
  }
  // LOGIN SUCCESS
  if (type === 'login') {
    return [
      '🔐 <b>USER LOGIN — ZAEINSTREAM</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `📧 <b>Email</b>     <code>${telegramEsc(email)}</code>`,
      `🌐 <b>IP</b>        <code>${telegramEsc(ip)}</code>`,
      `📍 <b>Lokasi</b>    ${telegramEsc(city)}, ${telegramEsc(country)}`,
      `🖥️ <b>Device</b>    ${telegramEsc(ua)}`,
      `🕐 <b>Waktu</b>     ${telegramTime()}`,
      '━━━━━━━━━━━━━━━━━━━━',
      '<i>zaeinstream.my.id</i>',
    ].join('\n');
  }
  // LOGIN FAIL
  return [
    '⚠️ <b>LOGIN GAGAL — ZAEINSTREAM</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📧 <b>Email</b>     <code>${telegramEsc(email)}</code>`,
    `❗ <b>Alasan</b>    ${telegramEsc(reason || '-')}`,
    `🌐 <b>IP</b>        <code>${telegramEsc(ip)}</code>`,
    `📍 <b>Lokasi</b>    ${telegramEsc(city)}, ${telegramEsc(country)}`,
    `🖥️ <b>Device</b>    ${telegramEsc(ua)}`,
    `🕐 <b>Waktu</b>     ${telegramTime()}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '<i>zaeinstream.my.id</i>',
  ].join('\n');
}

async function authLoginEventHandler(request, env, ctx) {
  const user = await getUserFromAuth(request, env);
  if (!user || !user.email) return err('Login dulu', 401);
  const send = () => sendTelegramNotif(env, buildAuthTelegramMsg({
    type: 'login',
    email: user.email,
    ...requestMeta(request),
  }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send());
  else await send();
  return json({ ok: true });
}

// POST /api/auth/login-notify — kirim notif Telegram pas LOGIN GAGAL
// No auth needed (user belum tentu login), tapi kasih rate-limit
async function authLoginFailNotifyHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON', 400); }
  const email = (body && body.email || '').trim().toLowerCase();
  const reason = (body && body.reason || 'Unknown error').slice(0, 100);
  if (!email) return err('Email wajib', 400);
  const send = () => sendTelegramNotif(env, buildAuthTelegramMsg({
    type: 'loginfail',
    email,
    reason,
    ...requestMeta(request),
  }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send());
  else await send();
  return json({ ok: true });
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

function tmdbImage(path, size = 'w500') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

function pickTmdbLogo(images) {
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  if (!logos.length) return null;
  const preferred = logos.find(x => x.iso_639_1 === 'en') || logos.find(x => x.iso_639_1 === null) || logos[0];
  return preferred && preferred.file_path ? tmdbImage(preferred.file_path, 'w500') : null;
}

function tmdbMediaTypeForFilm(film) {
  return film && film.tipe === 'series' ? 'tv' : 'movie';
}

function tmdbLogoPath(images) {
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  if (!logos.length) return null;
  const preferred = logos.find(x => x.iso_639_1 === 'en') || logos.find(x => x.iso_639_1 === null) || logos[0];
  return preferred && preferred.file_path ? preferred.file_path : null;
}

function tmdbMetadataPatch(type, tmdb) {
  const genres = Array.isArray(tmdb?.genres) ? tmdb.genres : [];
  const countries = new Set();
  if (type === 'tv' && Array.isArray(tmdb?.origin_country)) {
    tmdb.origin_country.forEach(code => {
      if (code) countries.add(String(code).toUpperCase());
    });
  }
  if (Array.isArray(tmdb?.production_countries)) {
    tmdb.production_countries.forEach(country => {
      if (country && country.iso_3166_1) countries.add(String(country.iso_3166_1).toUpperCase());
    });
  }
  return {
    tmdb_media_type: type,
    tmdb_genres: genres.map(g => g && g.name).filter(Boolean),
    tmdb_genre_ids: genres.map(g => g && g.id).filter(Boolean),
    tmdb_country_codes: Array.from(countries),
    tmdb_original_language: tmdb?.original_language || null,
    tmdb_poster_path: tmdb?.poster_path || null,
    tmdb_backdrop_path: tmdb?.backdrop_path || null,
    tmdb_logo_path: tmdbLogoPath(tmdb?.images),
    tmdb_synced_at: new Date().toISOString(),
  };
}

async function resolveTmdbDetailForFilm(env, film) {
  const type = tmdbMediaTypeForFilm(film);
  let tmdbId = film && film.tmdb_id;
  if (!tmdbId && film && film.judul) {
    const year = film.tahun ? `&year=${encodeURIComponent(film.tahun)}` : '';
    const sr = await tmdbFetch(env, `/search/${type}?query=${encodeURIComponent(film.judul)}${year}&include_adult=false`);
    const sd = await sr.json().catch(() => ({}));
    if (!sr.ok) throw new Error(`TMDB search ${sr.status}: ${sd.status_message || ''}`);
    tmdbId = sd && sd.results && sd.results[0] && sd.results[0].id;
  }
  if (!tmdbId) return null;
  const dr = await tmdbFetch(env, `/${type}/${tmdbId}?append_to_response=images`);
  const detail = await dr.json().catch(() => ({}));
  if (!dr.ok) throw new Error(`TMDB detail ${dr.status}: ${detail.status_message || ''}`);
  return { type, tmdbId, detail };
}

async function buildFilmTmdbMetadataPatch(env, film) {
  const resolved = await resolveTmdbDetailForFilm(env, film);
  if (!resolved || !resolved.detail) return {};
  return {
    tmdb_id: film.tmdb_id || resolved.tmdbId,
    ...tmdbMetadataPatch(resolved.type, resolved.detail),
  };
}

function filmNeedsTmdbMetadata(film, force = false) {
  if (force) return true;
  const genres = Array.isArray(film?.tmdb_genres) ? film.tmdb_genres : [];
  return !film?.tmdb_synced_at || !genres.length;
}

// Normalize a title for fuzzy matching: lowercase, strip diacritics, drop
// punctuation, collapse whitespace. "The Punisher: One Last Kill" and
// "the punisher one last kill" become the same string.
function normalizeTitleKey(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mapTmdbHomeItem(item, mediaType, category, hiddenSet, localIndex, logoUrl = null) {
  if (!item || !item.id) return null;
  const key = `${mediaType}:${item.id}`;
  if (hiddenSet.has(key)) return null;
  const title = item.title || item.name || item.original_title || item.original_name || 'Untitled';
  // Match by TMDB id first (most reliable); fall back to normalized title so
  // films added without a tmdb_id still resolve when their judul matches.
  let local = localIndex.byTmdb.get(key);
  if (!local) {
    const tk = `${mediaType}:${normalizeTitleKey(title)}`;
    local = localIndex.byTitle.get(tk);
    const altTitle = item.original_title || item.original_name;
    if (!local && altTitle) {
      const ak = `${mediaType}:${normalizeTitleKey(altTitle)}`;
      local = localIndex.byTitle.get(ak);
    }
  }
  return {
    id: `tmdb-${mediaType}-${item.id}`,
    tmdb_id: item.id,
    local_id: local ? local.id : null,
    source: 'tmdb',
    category,
    media_type: mediaType,
    tipe: mediaType === 'tv' ? 'series' : 'movie',
    judul: local?.judul || title,
    tahun: local?.tahun || String(item.release_date || item.first_air_date || '').slice(0, 4),
    poster_url: local?.poster_url || tmdbImage(item.poster_path, 'w500'),
    backdrop_url: local?.backdrop_url || tmdbImage(item.backdrop_path, 'w1280'),
    logo_url: local?.logo_url || logoUrl,
    overview: local?.overview || item.overview || '',
    rating: item.vote_average ? Number(item.vote_average).toFixed(1) : null,
    vote_count: item.vote_count || 0,
    is_available: !!local,
  };
}

async function getTmdbHiddenSet(env) {
  const r = await supabaseRest(env, '/tmdb_home_hidden?select=media_type,tmdb_id');
  const rows = r.ok && Array.isArray(r.data) ? r.data : [];
  return new Set(rows.map(x => `${x.media_type}:${x.tmdb_id}`));
}

// Build two indexes over the local catalog so TMDB items can match either by
// numeric tmdb_id (preferred) or by normalized title (fallback for catalog
// entries that were added without a tmdb_id, or where the tmdb_id is stored
// as a string vs. number — template-literal coercion makes both keys equal
// for digit strings, but title fallback also covers genuine ID mismatches).
//
// The previous PostgREST filter "not.tmdb_id=is.null" is invalid syntax
// (the correct form is "tmdb_id=not.is.null"), which caused the request to
// return zero rows on some PostgREST versions — meaning NO TMDB items ever
// matched. We drop the filter and let JS skip rows without a tmdb_id.
async function getLocalFilmIndex(env) {
  // Fetch all rows; previously this used select=id,judul,tipe,tahun,tmdb_id,
  // poster_url,backdrop_url,overview,rating,tier — at least one of those
  // columns is not present in the live films table, so PostgREST 400s the
  // whole request and we end up with an empty index. select=* is what
  // /api/catalog uses and it's known to work; we only read a handful of
  // fields anyway.
  // Pakai supabaseRestAll supaya >1000 row gak ke-cap diam-diam.
  const r = await supabaseRestAll(env, '/films?select=*');
  const rows = r.ok && Array.isArray(r.data) ? r.data : [];
  const byTmdb = new Map();
  const byTitle = new Map();
  for (const f of rows) {
    const mediaType = f.tipe === 'series' ? 'tv' : 'movie';
    if (f.tmdb_id !== null && f.tmdb_id !== undefined && f.tmdb_id !== '') {
      const k = `${mediaType}:${f.tmdb_id}`;
      if (!byTmdb.has(k)) byTmdb.set(k, f);
    }
    const norm = normalizeTitleKey(f.judul);
    if (norm) {
      const tk = `${mediaType}:${norm}`;
      if (!byTitle.has(tk)) byTitle.set(tk, f);
    }
  }
  return { byTmdb, byTitle };
}

async function tmdbList(env, path) {
  const r = await tmdbFetch(env, path);
  const data = await r.json();
  if (!r.ok) throw new Error(data.status_message || `TMDB ${r.status}`);
  return Array.isArray(data.results) ? data.results : [];
}

async function tmdbHomeHandler(request, env) {
  try {
    const [hiddenSet, localIndex] = await Promise.all([getTmdbHiddenSet(env), getLocalFilmIndex(env)]);
    const [trendingMoviesRaw, trendingShowsRaw, topMoviesRaw, topShowsRaw] = await Promise.all([
      tmdbList(env, '/trending/movie/week?page=1&include_adult=false'),
      tmdbList(env, '/trending/tv/week?page=1&include_adult=false'),
      tmdbList(env, '/movie/top_rated?page=1&include_adult=false'),
      tmdbList(env, '/tv/top_rated?page=1&include_adult=false'),
    ]);

    const rows = {
      trending_movies: trendingMoviesRaw.map(x => mapTmdbHomeItem(x, 'movie', 'trending_movies', hiddenSet, localIndex)).filter(Boolean).slice(0, 20),
      trending_shows: trendingShowsRaw.map(x => mapTmdbHomeItem(x, 'tv', 'trending_shows', hiddenSet, localIndex)).filter(Boolean).slice(0, 20),
      top_movies: topMoviesRaw.map(x => mapTmdbHomeItem(x, 'movie', 'top_movies', hiddenSet, localIndex)).filter(Boolean).slice(0, 20),
      top_shows: topShowsRaw.map(x => mapTmdbHomeItem(x, 'tv', 'top_shows', hiddenSet, localIndex)).filter(Boolean).slice(0, 20),
    };

    const heroBase = [...trendingMoviesRaw, ...trendingShowsRaw].filter(x => x && x.backdrop_path).slice(0, 10);
    const hero = [];
    for (const item of heroBase) {
      const mediaType = item.title ? 'movie' : 'tv';
      const detail = await tmdbFetch(env, `/${mediaType}/${item.id}?append_to_response=images`).then(r => r.json()).catch(() => null);
      const merged = detail && !detail.success ? { ...item, ...detail } : item;
      const mapped = mapTmdbHomeItem(merged, mediaType, 'hero', hiddenSet, localIndex, pickTmdbLogo(detail?.images));
      if (mapped && mapped.backdrop_url) hero.push(mapped);
      if (hero.length >= 10) break;
    }

    return json({ ok: true, hero, rows });
  } catch (e) {
    return err('TMDB home error: ' + e.message, 502);
  }
}

async function adminTmdbHiddenList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, '/tmdb_home_hidden?select=*&order=created_at.desc');
  if (!r.ok) return err('Gagal load hidden TMDB', 500);
  return json({ ok: true, items: Array.isArray(r.data) ? r.data : [] });
}

async function adminTmdbHiddenUpsert(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json().catch(() => ({}));
  const mediaType = body.media_type;
  const tmdbId = Number(body.tmdb_id);
  if (!['movie', 'tv'].includes(mediaType) || !tmdbId) return err('media_type dan tmdb_id wajib');
  const r = await supabaseRest(env, '/tmdb_home_hidden?on_conflict=media_type,tmdb_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      media_type: mediaType,
      tmdb_id: tmdbId,
      title: body.title || null,
      reason: body.reason || null,
    }),
  });
  if (!r.ok) return err('Gagal hide item TMDB', 500);
  return json({ ok: true, item: Array.isArray(r.data) ? r.data[0] : r.data });
}

async function adminTmdbHiddenDelete(request, env, mediaType, tmdbId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  if (!['movie', 'tv'].includes(mediaType) || !/^\d+$/.test(String(tmdbId))) return err('Parameter tidak valid');
  const r = await supabaseRest(env, `/tmdb_home_hidden?media_type=eq.${encodeURIComponent(mediaType)}&tmdb_id=eq.${encodeURIComponent(tmdbId)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
  if (!r.ok) return err('Gagal unhide item TMDB', 500);
  return json({ ok: true });
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

async function findFilmByDrivePath(env, drivePath) {
  const path = String(drivePath || '').trim();
  if (!path) return null;
  const r = await supabaseRest(
    env,
    `/films?or=(drive_path.eq.${encodeURIComponent(path)},drive_link.eq.${encodeURIComponent(path)})&select=*&limit=1`
  );
  if (r.ok && Array.isArray(r.data) && r.data.length) return r.data[0];

  const all = await supabaseRestAll(env, '/films?select=*');
  const films = all.ok && Array.isArray(all.data) ? all.data : [];
  return films.find(f => filmReferencesDrivePath(f, path)) || null;
}

function filmReferencesDrivePath(film, path) {
  if (!film || !path) return false;
  if (String(film.drive_path || '').trim() === path) return true;
  if (String(film.drive_link || '').trim() === path) return true;
  for (const key of ['videos', 'audio_tracks', 'subtitles']) {
    const list = Array.isArray(film[key]) ? film[key] : [];
    if (list.some(item => String((item && (item.drive_path || item.drive_link)) || '').trim() === path)) {
      return true;
    }
  }
  return false;
}

async function canResolveDrivePath(request, env, drivePath) {
  const user = await getUserFromAuth(request, env);
  if (!user) return { ok: false, response: err('Login dulu', 401) };
  if (isAdminEmail(env, user.email || '')) return { ok: true, user, film: null, profile: null };

  const film = await findFilmByDrivePath(env, drivePath);
  if (!film) return { ok: false, response: err('Path Drive tidak terdaftar di katalog', 404) };

  const profile = await getUserProfile(env, user.id, user.email);
  const isVip = isVipProfileActive(profile);
  const entitled = await hasFilmEntitlement(env, profile?.user_id || user.id, film);
  if (!isVip && !entitled) return { ok: false, response: err('Akses video belum aktif', 403) };
  return { ok: true, user, film, profile };
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
  const access = await canResolveDrivePath(request, env, drivePath);
  if (!access.ok) return access.response;
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
    entitlements: await userEntitlements(env, profile?.user_id || user.id),
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
  // Pakai supabaseRestAll supaya pagination 1000-row default Supabase
  // tidak ngecap row terbaru (kasus film >1000 row → If Wishes Could Kill, dst).
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

  const r = await supabaseRestAll(env, finalPath);
  if (!r.ok) return err('Gagal load katalog', 500);
  const isAdmin = isAdminEmail(env, user?.email || '');
  const films = Array.isArray(r.data) ? r.data : [];
  const safeFilms = isAdmin ? films : films.map(f => {
    const copy = { ...f };
    delete copy.video_url;
    delete copy.preview_video_url;
    delete copy.drive_link;
    delete copy.drive_path;
    delete copy.videos;
    delete copy.audio_tracks;
    return copy;
  });
  return json({ ok: true, user_tier: userTier, films: safeFilms });
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

  let row = {
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
  let tmdb_warning = null;
  try {
    row = { ...row, ...(await buildFilmTmdbMetadataPatch(env, row)) };
  } catch (e) {
    tmdb_warning = e.message;
  }
  const r = await supabaseRest(env, '/films', {
    method: 'POST',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('Gagal simpan: ' + JSON.stringify(r.data), 500);
  return json({ ok: true, film: Array.isArray(r.data) ? r.data[0] : r.data, tmdb_warning });
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
  let tmdb_warning = null;
  if ('judul' in patch || 'tipe' in patch || 'tmdb_id' in patch || 'tahun' in patch) {
    try {
      const current = await getFilmById(env, id);
      const merged = { ...(current || {}), ...patch };
      Object.assign(patch, await buildFilmTmdbMetadataPatch(env, merged));
    } catch (e) {
      tmdb_warning = e.message;
    }
  }
  const r = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err('Gagal update', 500);
  return json({ ok: true, tmdb_warning });
}

async function adminFilmsTmdbSync(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const u = new URL(request.url);
  const force = u.searchParams.get('force') === '1' || u.searchParams.get('force') === 'true';
  const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit') || 100)));
  const after = Number(u.searchParams.get('after') || 0);
  const path = `/films?id=gt.${encodeURIComponent(after)}&select=*&order=id.asc&limit=${limit}`;
  const r = await supabaseRest(env, path);
  if (!r.ok) return err('Gagal load film untuk sync TMDB', 500);
  const films = Array.isArray(r.data) ? r.data : [];
  const results = [];
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let next_after = after;
  let index = 0;
  async function syncOne(film) {
    next_after = Math.max(next_after, Number(film.id) || next_after);
    if (!filmNeedsTmdbMetadata(film, force)) {
      skipped++;
      results.push({ id: film.id, title: film.judul, status: 'skipped' });
      return;
    }
    try {
      const patch = await buildFilmTmdbMetadataPatch(env, film);
      if (!Object.keys(patch).length) {
        failed++;
        results.push({ id: film.id, title: film.judul, status: 'missing_tmdb' });
        return;
      }
      const up = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(film.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!up.ok) throw new Error(JSON.stringify(up.data));
      synced++;
      results.push({
        id: film.id,
        title: film.judul,
        status: 'synced',
        genres: patch.tmdb_genres || [],
        countries: patch.tmdb_country_codes || [],
      });
    } catch (e) {
      failed++;
      results.push({ id: film.id, title: film.judul, status: 'error', error: e.message });
    }
  }
  async function worker() {
    while (index < films.length) {
      const film = films[index++];
      await syncOne(film);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, films.length) }, worker));
  results.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  return json({
    ok: true,
    force,
    limit,
    after,
    next_after,
    has_more: films.length === limit,
    synced,
    skipped,
    failed,
    results,
  });
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
async function authSignupHandler(request, env, ctx) {
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

  const send = () => sendTelegramNotif(env, buildAuthTelegramMsg({
    type: 'register',
    email,
    ...requestMeta(request),
  }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send());
  else await send();

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
  const users = Array.isArray(r.data) ? r.data : [];
  // Batch: get ALL entitlements for ALL users in 1 query instead of N sequential
  const userIds = users.map(u => u.user_id).filter(Boolean);
  const now = new Date();
  const nowEnc = encodeURIComponent(now.toISOString());
  const entCount = {};
  if (userIds.length > 0) {
    const chunkSize = 50; // Supabase URL length safety
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);
      const idsParam = chunk.map(id => encodeURIComponent(id)).join(',');
      const e = await supabaseRest(
        env,
        `/film_entitlements?user_id=in.(${idsParam})&or=(expires_at.is.null,expires_at.gt.${nowEnc})&select=user_id,id&limit=5000`
      );
      if (e.ok && Array.isArray(e.data)) {
        for (const ent of e.data) {
          entCount[ent.user_id] = (entCount[ent.user_id] || 0) + 1;
        }
      }
    }
  }
  for (const u of users) {
    const exp = u.expired_at ? new Date(u.expired_at) : null;
    const vipActive = !!(u.is_vip && exp && exp > now);
    if (!vipActive) {
      u.is_vip = false;
      u.expired_at = null;
    }
    u.entitlement_count = entCount[u.user_id] || 0;
  }
  return json({ ok: true, users });
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
  const expiredAt = isVip && body && body.expired_at ? body.expired_at : null;
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
  if (body.is_vip !== undefined) {
    profilePatch.is_vip = !!body.is_vip;
    if (!profilePatch.is_vip) profilePatch.expired_at = null;
  }
  if (body.expired_at !== undefined) profilePatch.expired_at = body.expired_at;
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

async function adminUsersResetFree(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, '/users_profile', {
    method: 'PATCH',
    body: JSON.stringify({ is_vip: false, expired_at: null }),
  });
  if (!r.ok) return err('Gagal reset users ke free', 500);
  return json({ ok: true });
}

async function adminGrantUserEntitlement(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON', 400); }
  const filmId = Number(body.film_id || 0);
  if (!filmId) return err('film_id wajib', 400);
  const film = await getFilmById(env, filmId);
  if (!film) return err('Film tidak ditemukan', 404);
  const key = entitlementKeyForFilm(film);
  const kind = normalizeFilmKind(film);
  const up = await supabaseRest(env, '/film_entitlements', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      user_id: userId,
      film_id: film.id,
      kind,
      entitlement_key: key,
      title: film.judul || 'Film',
      season: film.season || null,
      expires_at: null,
    }),
  });
  if (!up.ok) return err('Gagal tambah akses film', 500);
  return json({ ok: true, entitlement: Array.isArray(up.data) ? up.data[0] : up.data });
}

async function adminRevokeUserEntitlement(request, env, userId, entitlementId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const entId = String(entitlementId || '').trim();
  if (!entId) return err('entitlement_id wajib', 400);
  const r = await supabaseRest(
    env,
    `/film_entitlements?id=eq.${encodeURIComponent(entId)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
  if (!r.ok) return err('Gagal hapus akses film user', 500);
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
// Payments / entitlements (Violet Media Pay)
// ───────────────────────────────────────────────────────────────────

function cleanPaymentBase(env) {
  const mode = String(env.VIOLET_MODE || 'live').toLowerCase();
  return (env.VIOLET_API_BASE || (mode === 'sandbox'
    ? 'https://violetmediapay.com/api/sanbox'
    : 'https://violetmediapay.com/api/live')).replace(/\/$/, '');
}

function normalizeFilmKind(film) {
  return film && film.tipe === 'series' ? 'series_season' : 'movie';
}

function entitlementKeyForFilm(film) {
  if (!film) return null;
  if (normalizeFilmKind(film) === 'series_season') {
    return `series:${film.judul || film.tmdb_id || film.id}:season:${film.season || 1}`;
  }
  return `movie:${film.id}`;
}

function parseOrderMetadata(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try { return JSON.parse(meta); } catch { return {}; }
}

async function getFilmById(env, id) {
  const r = await supabaseRest(env, `/films?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  return r.data[0];
}

async function getPaymentSettings(env) {
  const defaults = {
    movie_price: DEFAULT_MOVIE_PRICE,
    series_season_price: DEFAULT_SERIES_SEASON_PRICE,
    vip_month_price: VIP_MONTH_PRICE,
    vip_week_price: VIP_WEEK_PRICE,
  };
  const r = await supabaseRest(env, '/payment_settings?select=key,value');
  if (!r.ok || !Array.isArray(r.data)) return defaults;
  for (const row of r.data) {
    const n = Number(row.value);
    if (Number.isFinite(n) && n >= 0 && row.key in defaults) defaults[row.key] = n;
  }
  return defaults;
}

async function userEntitlements(env, userId) {
  if (!userId) return [];
  const now = encodeURIComponent(new Date().toISOString());
  const r = await supabaseRest(
    env,
    `/film_entitlements?user_id=eq.${encodeURIComponent(userId)}&or=(expires_at.is.null,expires_at.gt.${now})&select=id,user_id,film_id,kind,entitlement_key,title,season,created_at,expires_at&order=created_at.desc`
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data;
}

async function hasFilmEntitlement(env, userId, film) {
  if (!userId || !film) return false;
  const key = entitlementKeyForFilm(film);
  const r = await supabaseRest(
    env,
    `/film_entitlements?user_id=eq.${encodeURIComponent(userId)}&entitlement_key=eq.${encodeURIComponent(key)}&select=id&limit=1`
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

async function grantVip(env, userId, days) {
  const current = await supabaseRest(env, `/users_profile?user_id=eq.${encodeURIComponent(userId)}&select=expired_at`);
  const row = current.ok && Array.isArray(current.data) ? current.data[0] : null;
  const base = row && row.expired_at && new Date(row.expired_at) > new Date() ? new Date(row.expired_at) : new Date();
  const exp = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  return supabaseRest(env, `/users_profile?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_vip: true, expired_at: exp }),
  });
}

async function grantFilmAccess(env, order) {
  const meta = parseOrderMetadata(order.metadata);
  if (!order.user_id) return;
  const items = Array.isArray(meta.cart_items) ? meta.cart_items : [];
  if (items.length) {
    for (const item of items) {
      if (!item || !item.entitlement_key) continue;
      await supabaseRest(env, '/film_entitlements', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: JSON.stringify({
          user_id: order.user_id,
          film_id: item.film_id || null,
          kind: item.kind || 'movie',
          entitlement_key: item.entitlement_key,
          title: item.title || order.product_name || 'Film',
          season: item.season || null,
          payment_ref: order.ref,
          expires_at: null,
        }),
      });
    }
    return;
  }
  if (!meta.film_id || !meta.entitlement_key) return;
  await supabaseRest(env, '/film_entitlements', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      user_id: order.user_id,
      film_id: meta.film_id,
      kind: meta.kind || 'movie',
      entitlement_key: meta.entitlement_key,
      title: meta.title || order.product_name || 'Film',
      season: meta.season || null,
      payment_ref: order.ref,
      expires_at: null,
    }),
  });
}

async function applyPaidOrder(env, order) {
  const meta = parseOrderMetadata(order.metadata);
  if (order.product_type === 'vip_month') return grantVip(env, order.user_id, 30);
  if (order.product_type === 'vip_week') return grantVip(env, order.user_id, 7);
  if (order.product_type === 'film') return grantFilmAccess(env, order);
  if (meta.vip_days) return grantVip(env, order.user_id, Number(meta.vip_days));
}

// HMAC-SHA256 via Web Crypto (tersedia di Cloudflare Workers runtime).
// Mengikuti spesifikasi Violet Media Pay:
//   signature = HMAC_SHA256( secret_key, ref_kode + api_key + amount ) → hex
async function sha256HmacHex(secret, message) {
  if (!secret || !String(secret).trim()) {
    throw new Error('VIOLET_SECRET_KEY kosong atau belum di-set di Cloudflare secrets');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function extractCallbackAmountCandidates(body) {
  return [
    body.total_amount,
    body.nominal,
    body.amount,
    body.amount_received,
    body.amount_merchant,
  ]
    .map(v => String(v || '').replace(/[^\d]/g, '').trim())
    .filter(Boolean);
}

async function validateVioletCallbackSignature(env, body, expectedAmount = null) {
  const secret = env.VIOLET_SECRET_KEY || '';
  const apiKey = env.VIOLET_API_KEY || '';
  if (!secret || !apiKey) {
    return { ok: false, error: 'VIOLET_API_KEY / VIOLET_SECRET_KEY belum di-set' };
  }
  const ref = String(body.ref_kode || body.ref || body.reference || '').trim();
  const signature = String(body.signature || body['x-callback-signature'] || '').trim().toLowerCase();
  if (!ref || !signature) {
    return { ok: false, error: 'Callback VMP tidak punya ref/signature' };
  }

  const amountCandidates = extractCallbackAmountCandidates(body);
  const expected = expectedAmount === null || expectedAmount === undefined
    ? ''
    : String(Math.round(Number(expectedAmount) || 0));

  const messages = [
    ...amountCandidates.map(a => `${ref}${apiKey}${a}`),
  ];
  if (expected) messages.unshift(`${ref}${apiKey}${expected}`);
  if (!messages.length) {
    return { ok: false, error: 'Callback VMP tidak punya nominal untuk verifikasi signature' };
  }
  const expectedSet = new Set();
  for (const msg of messages) {
    expectedSet.add((await sha256HmacHex(secret, msg)).toLowerCase());
  }
  if (!expectedSet.has(signature)) {
    return { ok: false, error: 'Signature callback VMP tidak valid' };
  }
  return { ok: true };
}

function validateVioletCallbackAmount(body, order) {
  const expected = Math.round(Number(order && order.amount) || 0);
  if (!expected) return { ok: false, error: 'Nominal order lokal tidak valid' };
  const meta = parseOrderMetadata(order && order.metadata);
  const fee = Math.max(0, Math.round(Number(meta.violet_fee) || 0));
  const allowed = new Set([expected, expected + fee]);
  const amounts = extractCallbackAmountCandidates(body).map(v => Number(v)).filter(Number.isFinite);
  if (!amounts.length) return { ok: false, error: 'Callback VMP tidak menyertakan nominal' };
  if (!amounts.some(a => allowed.has(Math.round(a)))) {
    return { ok: false, error: 'Nominal callback VMP tidak cocok dengan order' };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────
// VMP channel catalog
// ───────────────────────────────────────────────────────────────────
// Daftar channel pembayaran VMP yang ditampilkan di halaman /payment/checkout,
// urut sesuai permintaan user. Fee dihitung berdasarkan rate publik VMP
// (lihat https://violetmediapay.com/ docs). Fee ditanggung pembeli — di
// /create kita kirim `nominal` = harga + fee dan `amount_merchant` = harga
// asli, jadi VMP charge pembeli total (gross) tapi penjual tetap terima
// harga asli setelah fee dipotong.
const VMP_CHANNELS_ORDERED = [
  { code: 'QRIS2',     label: 'QRIS2',        metode: 'QRIS / E-Wallet',     tipe: 'qris',     fee_kind: 'percent', fee_value: 0.8,  fee_min: 0 },
  { code: 'MANDIRIVA', label: 'Mandiri VA',   metode: 'Virtual Account',     tipe: 'va',       fee_kind: 'flat',    fee_value: 3000 },
  { code: 'DANA',      label: 'DANA',         metode: 'E-Wallet',            tipe: 'ewallet',  fee_kind: 'percent', fee_value: 1.67, fee_min: 100 },
  { code: 'SHOPEEPAY', label: 'ShopeePay',    metode: 'E-Wallet',            tipe: 'ewallet',  fee_kind: 'percent', fee_value: 4,    fee_min: 100 },
  { code: 'OVO',       label: 'OVO',          metode: 'E-Wallet',            tipe: 'ewallet',  fee_kind: 'percent', fee_value: 3.03, fee_min: 100 },
  { code: 'ALFAMART',  label: 'Alfamart',     metode: 'Convenience Store',   tipe: 'retail',   fee_kind: 'flat',    fee_value: 3500 },
  { code: 'INDOMARET', label: 'Indomaret',    metode: 'Convenience Store',   tipe: 'retail',   fee_kind: 'flat',    fee_value: 3500 },
  { code: 'BSI',       label: 'BSI VA',       metode: 'Virtual Account',     tipe: 'va',       fee_kind: 'flat',    fee_value: 3500 },
  { code: 'DANAMON',   label: 'Danamon VA',   metode: 'Virtual Account',     tipe: 'va',       fee_kind: 'flat',    fee_value: 2500 },
];

function computeVmpFee(amount, channel) {
  if (!channel) return 0;
  const base = Number(amount) || 0;
  if (channel.fee_kind === 'flat') return Math.max(0, Math.ceil(channel.fee_value));
  const pct = Math.ceil((base * Number(channel.fee_value || 0)) / 100);
  const min = Number(channel.fee_min || 0);
  return Math.max(pct, min);
}

function findVmpChannel(code) {
  const key = String(code || '').toUpperCase().trim();
  return VMP_CHANNELS_ORDERED.find(c => c.code === key) || null;
}

function listVmpChannelsForAmount(amount) {
  return VMP_CHANNELS_ORDERED.map(ch => {
    const fee = computeVmpFee(amount, ch);
    return {
      code: ch.code,
      label: ch.label,
      metode: ch.metode,
      tipe: ch.tipe,
      fee,
      total: Number(amount) + fee,
    };
  });
}

function normalizeGatewayEmail(email) {
  const value = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : 'customer@zaeinstream.my.id';
}

async function createVioletTransaction(env, order, userEmail, { channel: channelCode, nominal, fee } = {}) {
  const apiKey = env.VIOLET_API_KEY || '';
  const secret = env.VIOLET_SECRET_KEY || '';
  if (!apiKey || !secret) throw new Error('VIOLET_API_KEY / VIOLET_SECRET_KEY belum di-set di Cloudflare secrets');
  const base = cleanPaymentBase(env);
  // Pilih channel: kalau caller ga ngasih, fallback ke env override atau QRIS2.
  const code = String(channelCode || env.VIOLET_DEFAULT_CHANNEL || 'QRIS2').toUpperCase();
  const channel = findVmpChannel(code) || findVmpChannel('QRIS2');
  const amountMerchant = Number(order.amount) || 0;
  const feeCharged = Number.isFinite(Number(fee)) ? Math.max(0, Math.floor(Number(fee))) : computeVmpFee(amountMerchant, channel);
  const grossNominal = Number.isFinite(Number(nominal)) ? Math.max(0, Math.floor(Number(nominal))) : amountMerchant + feeCharged;
  const nominalToGateway = grossNominal;
  const signature = await sha256HmacHex(secret, `${order.ref}${apiKey}${nominalToGateway}`);
  const origin = (env.PUBLIC_BASE_URL || new URL(env.WORKER_SELF_URL || 'https://webstream.zaeinstreamx.workers.dev').origin).replace(/\/$/, '');
  const callbackUrl = `${origin}/api/payments/violet/callback`;
  const customerEmail = normalizeGatewayEmail(userEmail);
  const customerName = customerEmail.split('@')[0] || 'Pelanggan';
  // VMP `/create` paling konsisten kalau dikirim sebagai form-urlencoded
  // (sesuai contoh dokumentasi). Kirim juga beberapa alias callback supaya
  // VMP bisa route per-transaksi ke endpoint kita kalau memang support
  // override per-create. Callback global mungkin sudah dipakai project lain.
  const formBody = new URLSearchParams({
    api_key: apiKey,
    apikey: apiKey,
    secret_key: secret,
    signature: String(signature),
    channel_payment: channel.code,
    code_payment: channel.code,
    ref_kode: String(order.ref),
    nominal: String(nominalToGateway),
    amount: String(nominalToGateway),
    amount_merchant: String(amountMerchant),
    fee: String(feeCharged),
    cus_nama: customerName,
    nama: customerName,
    cus_email: customerEmail,
    email: customerEmail,
    cus_phone: env.VIOLET_DEFAULT_PHONE || '081234567890',
    phone: env.VIOLET_DEFAULT_PHONE || '081234567890',
    produk: String(order.product_name || ''),
    url_redirect: `${origin}/payment/success?ref=${encodeURIComponent(order.ref)}`,
    url_callback: callbackUrl,
    callback_url: callbackUrl,
    callback: callbackUrl,
    callbackUrl: callbackUrl,
    expired_time: String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
  });
  const res = await fetch(`${base}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
    body: formBody,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Violet HTTP ${res.status}: ${text.slice(0, 180)}`);
  return { data, channel: channel.code, nominal: nominalToGateway, fee: feeCharged, amount_merchant: amountMerchant, estimated_gross: grossNominal };
}

// Pick the first VMP transaction entry from a /create or /transactions response.
function pickVioletEntry(data) {
  if (!data || typeof data !== 'object') return {};
  if (Array.isArray(data.data) && data.data.length) return data.data[0] || {};
  if (data.data && typeof data.data === 'object') return data.data;
  return data;
}

// Some VMP fields have a stray trailing space in their JSON keys (e.g. "ref_kode ",
// "id_reference ", "nominal "). Try both variants when reading.
function vioField(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  if (obj[`${key} `] !== undefined) return obj[`${key} `];
  return undefined;
}

function extractVioletRefId(data) {
  const entry = pickVioletEntry(data);
  return (
    vioField(entry, 'id_reference')
    || vioField(entry, 'ref_id')
    || vioField(data, 'id_reference')
    || vioField(data, 'ref_id')
    || null
  );
}

function extractVioletStatus(data) {
  const entry = pickVioletEntry(data);
  return String(
    vioField(entry, 'status')
    || vioField(entry, 'payment_status')
    || vioField(data, 'status')
    || ''
  ).toLowerCase();
}

// Map VMP status string → internal status. VMP can return e.g. 'success',
// 'Belum Dibayar' (unpaid), 'kadaluarsa' (expired), 'failed', 'cancel'.
function normalizeVioletStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'pending';
  if (['success', 'paid', 'settlement', 'berhasil', 'sukses'].some(k => s.includes(k))) return 'success';
  if (['kadaluarsa', 'expired', 'failed', 'cancel', 'gagal'].some(k => s.includes(k))) return 'failed';
  return 'pending';
}

// Extract list of transaction entries from VMP /transactions response.
// VMP `/transactions` actually returns SEMUA transaksi merchant, jadi kita
// harus search by ref/ref_id, bukan asal ambil data[0] yang bisa transaksi
// orang lain.
function extractVioletTxList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const candidates = [payload.data, payload.result, payload.results, payload.transactions, payload.payments];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') {
      if (Array.isArray(c.data)) return c.data;
      if (Array.isArray(c.transactions)) return c.transactions;
      if (vioField(c, 'ref_id') || vioField(c, 'id_reference') || vioField(c, 'ref_kode') || vioField(c, 'ref')) return [c];
    }
  }
  if (vioField(payload, 'ref_id') || vioField(payload, 'id_reference') || vioField(payload, 'ref_kode') || vioField(payload, 'ref')) return [payload];
  return [];
}

function findVioletTxByRef(payload, refKode, refId) {
  const list = extractVioletTxList(payload);
  const wantRef = String(refKode || '').trim();
  const wantId = String(refId || '').trim();
  return list.find(item => {
    const itemRef = String(vioField(item, 'ref_kode') || vioField(item, 'ref') || '').trim();
    const itemId = String(vioField(item, 'ref_id') || vioField(item, 'id_reference') || '').trim();
    return (wantRef && itemRef === wantRef) || (wantId && itemId === wantId);
  }) || (list.length === 1 ? list[0] : null);
}

// Poll VMP for transaction status. Try JSON body first, fall back to
// form-urlencoded — VMP kadang menolak salah satu format dengan
// {status:false,data:[{status:"Invalid"}]} jadi kita perlu retry dengan
// body format yang lain.
async function fetchVioletTransactionStatus(env, refKode, refId) {
  const apiKey = env.VIOLET_API_KEY || '';
  const secret = env.VIOLET_SECRET_KEY || '';
  if (!apiKey || !secret) throw new Error('VIOLET_API_KEY / VIOLET_SECRET_KEY belum di-set di Cloudflare secrets');
  const base = cleanPaymentBase(env);
  const payload = { api_key: apiKey, secret_key: secret };
  if (refKode) payload.ref = String(refKode);
  if (refId) payload.ref_id = String(refId);

  async function tryFetch(opts) {
    const res = await fetch(`${base}/transactions`, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data, text };
  }

  // 1) JSON body
  let parsed = await tryFetch({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const topInvalid = String(parsed.data?.data?.status || parsed.data?.status || '').toLowerCase();
  const list = extractVioletTxList(parsed.data);
  // Kalau VMP balas {status:false} / "Invalid" / list kosong, retry pakai form-urlencoded.
  if (!parsed.data?.status || !list.length || topInvalid.includes('invalid')) {
    parsed = await tryFetch({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
      body: new URLSearchParams(payload),
    });
  }
  return parsed;
}

// POST /api/payments/checkout — buat order PENDING (belum nge-call VMP).
// Flow baru: frontend redirect ke /payment/checkout?ref=<ref> setelah ini,
// di halaman tsb user pilih channel + lihat fee, baru click "Bayar" yg
// nge-trigger /api/payments/start → bikin VMP transaction & redirect ke VMP.
async function paymentCheckout(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON'); }
  const settings = await getPaymentSettings(env);
  let productType = String(body.type || '').trim();
  let amount = 0;
  let productName = '';
  let metadata = {};

  if (productType === 'vip_month') {
    amount = settings.vip_month_price || VIP_MONTH_PRICE;
    productName = 'VIP Premium 1 Bulan';
    metadata = { vip_days: 30 };
  } else if (productType === 'vip_week') {
    amount = settings.vip_week_price || VIP_WEEK_PRICE;
    productName = 'VIP Premium 1 Minggu';
    metadata = { vip_days: 7 };
  } else if (productType === 'film') {
    const film = await getFilmById(env, body.film_id);
    if (!film) return err('Film tidak ditemukan', 404);
    if (film.tier === 'vip') return err('Judul ini hanya tersedia untuk member VIP dan tidak bisa dibeli sebagai akses satuan.', 403);
    const kind = normalizeFilmKind(film);
    amount = kind === 'series_season' ? settings.series_season_price : settings.movie_price;
    const seasonText = kind === 'series_season' ? ` Season ${film.season || 1}` : '';
    productName = `Akses Full ${film.judul || 'Film'}${seasonText}`;
    metadata = {
      film_id: film.id,
      kind,
      entitlement_key: entitlementKeyForFilm(film),
      title: film.judul || 'Film',
      season: film.season || null,
    };
  } else if (productType === 'cart') {
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const uniq = [...new Set(rawItems.map(x => String(x || '').trim()).filter(Boolean))];
    if (!uniq.length) return err('Keranjang kosong');
    const cartItems = [];
    let total = 0;
    for (const fid of uniq) {
      const film = await getFilmById(env, fid);
      if (!film) continue;
      if (film.tier === 'vip') return err(`${film.judul || 'Film ini'} hanya tersedia untuk member VIP dan tidak bisa dibeli sebagai akses satuan.`, 403);
      const kind = normalizeFilmKind(film);
      const price = kind === 'series_season' ? settings.series_season_price : settings.movie_price;
      total += price;
      cartItems.push({
        film_id: film.id,
        kind,
        entitlement_key: entitlementKeyForFilm(film),
        title: film.judul || 'Film',
        season: film.season || null,
        price,
      });
    }
    if (!cartItems.length) return err('Tidak ada item valid di keranjang');
    amount = total;
    productType = 'film';
    productName = `Keranjang ${cartItems.length} item`;
    metadata = { cart_items: cartItems };
  } else {
    return err('Tipe checkout tidak valid');
  }

  const ref = `ZS-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const insert = await supabaseRest(env, '/payment_orders', {
    method: 'POST',
    body: JSON.stringify({
      ref,
      user_id: user.id,
      email: user.email,
      product_type: productType,
      product_name: productName,
      amount,
      status: 'pending',
      metadata,
    }),
  });
  if (!insert.ok) return err('Gagal membuat order: ' + JSON.stringify(insert.data).slice(0, 200), 500);
  const order = Array.isArray(insert.data) ? insert.data[0] : insert.data;
  // checkout_url di-redirect ke halaman pilih-channel internal.
  // Frontend boleh juga langsung pakai field `ref` dan navigate sendiri.
  const checkoutUrl = `/payment/checkout?ref=${encodeURIComponent(ref)}`;
  return json({ ok: true, order, checkout_url: checkoutUrl, ref });
}

// GET /api/payments/order?ref=... — fetch order detail untuk halaman /payment/checkout.
// Aman dipanggil user yang login (di-scope ke user_id).
async function paymentOrderGet(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  const u = new URL(request.url);
  const ref = u.searchParams.get('ref') || '';
  if (!ref) return err('ref wajib');
  const r = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return err('Order tidak ditemukan', 404);
  const order = r.data[0];
  const channels = listVmpChannelsForAmount(order.amount || 0);
  return json({ ok: true, order, channels });
}

// GET /api/payments/channels?amount=... — list channel + fee untuk amount tertentu.
function paymentChannelsList(request) {
  const u = new URL(request.url);
  const amount = Number(u.searchParams.get('amount') || 0);
  return json({ ok: true, channels: listVmpChannelsForAmount(amount) });
}

// POST /api/payments/start — buat VMP transaction untuk order existing dengan channel pilihan.
// Body: { ref, channel }
async function paymentStart(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON'); }
  const ref = String(body.ref || '').trim();
  const channelCode = String(body.channel || '').toUpperCase().trim();
  if (!ref) return err('ref wajib');
  if (!findVmpChannel(channelCode)) return err('Channel pembayaran tidak valid');
  const r = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return err('Order tidak ditemukan', 404);
  const order = r.data[0];
  if (order.status === 'success') return err('Order sudah dibayar', 409);
  // Idempotency: kalau sudah pernah create VMP transaction untuk channel yang
  // sama dan masih pending, langsung pakai checkout_url existing — VMP punya
  // expired_time 24 jam jadi cukup safe.
  const existingMeta = parseOrderMetadata(order.metadata);
  if (order.checkout_url && existingMeta.violet_channel === channelCode && order.status === 'pending') {
    return json({ ok: true, checkout_url: order.checkout_url, channel: channelCode, reused: true });
  }
  try {
    const violet = await createVioletTransaction(env, order, user.email || '', { channel: channelCode });
    const data = violet.data;
    const entry = pickVioletEntry(data);
    const checkoutUrl = vioField(entry, 'checkout_url') || data.checkout_url || data.result?.checkout_url || data.url || null;
    const refId = extractVioletRefId(data);
    if (!checkoutUrl) {
      return err('VMP tidak mengembalikan checkout_url: ' + JSON.stringify(data).slice(0, 200), 502);
    }
    const patchBody = {
      checkout_url: checkoutUrl,
      gateway_response: data,
      metadata: {
        ...existingMeta,
        violet_ref_id: refId ? String(refId) : existingMeta.violet_ref_id || null,
        violet_channel: channelCode,
        violet_nominal: violet.nominal,
        violet_fee: violet.fee,
        violet_amount_merchant: violet.amount_merchant,
      },
    };
    await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    });
    return json({ ok: true, checkout_url: checkoutUrl, channel: channelCode, nominal: violet.nominal, fee: violet.fee, gateway: data });
  } catch (e) {
    return err('Gagal membuat checkout VMP: ' + e.message, 502);
  }
}

async function paymentStatus(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  const u = new URL(request.url);
  const ref = u.searchParams.get('ref') || '';
  if (!ref) return err('ref wajib');
  const r = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}&user_id=eq.${encodeURIComponent(user.id)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return err('Order tidak ditemukan', 404);
  let order = r.data[0];

  // Kalau status di DB masih 'pending', sync ke Violet Media Pay.
  // Ini menutupi kasus di mana callback VMP global terdaftar ke project lain,
  // jadi kita TIDAK pernah dapat notifikasi sukses. Setelah user redirect
  // balik ke /payment/success?ref=..., frontend akan poll endpoint ini dan
  // worker akan otomatis tanya ke VMP + apply order kalau memang sudah lunas.
  if (order.status === 'pending' && (env.VIOLET_API_KEY && env.VIOLET_SECRET_KEY)) {
    try {
      const meta = parseOrderMetadata(order.metadata);
      const refId = meta.violet_ref_id || extractVioletRefId(order.gateway_response) || null;
      const sync = await fetchVioletTransactionStatus(env, order.ref, refId);
      // /transactions return list semua transaksi merchant. Cari yang
      // matching ref_kode atau ref_id kita — kalau asal ambil data[0] bisa
      // jadi transaksi orang lain (= polling selalu "pending" walau VMP
      // bilang sukses).
      const tx = findVioletTxByRef(sync.data, order.ref, refId);
      const rawStatus = tx ? (vioField(tx, 'status') || vioField(tx, 'payment_status')) : extractVioletStatus(sync.data);
      const normalized = normalizeVioletStatus(rawStatus);
      if (normalized === 'success' && tx) {
        const amountCheck = validateVioletCallbackAmount(tx, order);
        if (!amountCheck.ok) return err(amountCheck.error, 400);
      }
      if (normalized !== 'pending' && normalized !== order.status) {
        const patchBody = {
          status: normalized,
          gateway_response: { ...(order.gateway_response || {}), last_sync: sync.data, last_sync_at: new Date().toISOString() },
        };
        if (normalized === 'success' && !order.paid_at) patchBody.paid_at = new Date().toISOString();
        const up = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(order.ref)}`, {
          method: 'PATCH',
          body: JSON.stringify(patchBody),
        });
        if (up.ok && Array.isArray(up.data) && up.data.length) {
          order = up.data[0];
        } else {
          order = { ...order, ...patchBody };
        }
        if (normalized === 'success') {
          try { await applyPaidOrder(env, order); } catch (_) { /* idempotent grants — ignore secondary errors */ }
        }
      }
    } catch (_) {
      // Sync ke VMP gagal — jangan throw, biarkan FE polling lagi nanti.
    }
  }
  return json({ ok: true, order });
}

// GET /api/payments/my-orders — riwayat pembelian user login.
async function paymentMyOrders(request, env) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  const r = await supabaseRest(
    env,
    `/payment_orders?user_id=eq.${encodeURIComponent(user.id)}&select=ref,product_type,product_name,amount,status,created_at,paid_at,metadata&order=created_at.desc&limit=200`
  );
  if (!r.ok) return err('Gagal memuat riwayat pembelian', 500);
  const orders = (Array.isArray(r.data) ? r.data : []).map(o => {
    const meta = parseOrderMetadata(o.metadata);
    const items = Array.isArray(meta.cart_items) && meta.cart_items.length
      ? meta.cart_items.map(i => ({
          title: i.title || 'Film',
          kind: i.kind || 'movie',
          season: i.season || null,
          price: Number(i.price || 0),
        }))
      : [{
          title: meta.title || o.product_name || 'Produk',
          kind: meta.kind || o.product_type || 'other',
          season: meta.season || null,
          price: Number(o.amount || 0),
        }];
    return {
      ...o,
      channel: meta.violet_channel || null,
      items,
    };
  });
  return json({ ok: true, orders });
}

// Forward callback ke worker lain (toko 1 / auto-drive-share). Dipakai supaya
// callback URL VMP yang sudah disetel ke project lain BISA jadi 1 URL bersama:
//   - prefix ZS-* → handle di sini (webstream — grant VIP / akses film)
//   - prefix lain → forward as-is ke https://api.semuapro.store/api/callback
// Kembalikan apa pun yang dijawab upstream (default 200 OK kalau gagal).
async function forwardCallbackToToko1(request, rawBody, contentType, env) {
  const upstream = (env.TOKO1_CALLBACK_URL || 'https://api.semuapro.store/api/callback').trim();
  try {
    const headers = { Accept: 'application/json' };
    if (contentType) headers['Content-Type'] = contentType;
    // forward X-Callback-Signature kalau ada (VMP pakai header itu utk auth)
    const sig = request.headers.get('x-callback-signature');
    if (sig) headers['X-Callback-Signature'] = sig;
    const res = await fetch(upstream, {
      method: 'POST',
      headers,
      body: rawBody,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return new Response(JSON.stringify({ ok: true, forwarded_to: upstream, upstream_status: res.status, upstream_body: data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  } catch (e) {
    // Walaupun upstream error, balas 200 ke VMP — supaya VMP gak retry forever.
    return new Response(JSON.stringify({ ok: true, forwarded_to: upstream, error: e.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
}

async function violetCallback(request, env) {
  // Baca raw body DULU supaya kita bisa forward ke upstream apa-adanya kalau
  // ref-nya bukan punya kita.
  const ctype = String(request.headers.get('content-type') || '').toLowerCase();
  const rawText = await request.text();

  // Parse buat ekstrak ref_kode — tidak peduli format apa.
  let body = {};
  if (ctype.includes('application/json')) {
    try { body = JSON.parse(rawText); } catch { body = {}; }
  } else if (ctype.includes('application/x-www-form-urlencoded') || ctype.includes('multipart/form-data')) {
    try { body = Object.fromEntries(new URLSearchParams(rawText)); } catch { body = {}; }
  } else {
    try { body = JSON.parse(rawText); }
    catch {
      try { body = Object.fromEntries(new URLSearchParams(rawText)); } catch { body = { raw: rawText }; }
    }
  }

  const u = new URL(request.url);
  const ref = String(
    body.ref_kode || body.ref || body.reference
    || u.searchParams.get('ref_kode') || u.searchParams.get('ref') || ''
  ).trim();
  const headerSig = String(request.headers.get('x-callback-signature') || '').trim();
  if (headerSig && !body['x-callback-signature']) body['x-callback-signature'] = headerSig;

  // Dispatcher: prefix non-ZS dianggap punya toko lain, forward as-is.
  // Catatan: prefix bisa dikonfigurasi via env.WEBSTREAM_REF_PREFIX (default 'ZS-').
  const ownPrefix = String(env.WEBSTREAM_REF_PREFIX || 'ZS-');
  if (ref && !ref.startsWith(ownPrefix)) {
    return forwardCallbackToToko1(request, rawText, ctype || 'application/x-www-form-urlencoded', env);
  }

  if (!ref) {
    // Tidak ada ref sama sekali — kemungkinan VMP test ping. Forward ke
    // upstream juga supaya toko 1 tidak kehilangan callback miliknya kalau
    // memang itu mereka.
    return forwardCallbackToToko1(request, rawText, ctype || 'application/x-www-form-urlencoded', env);
  }

  const r = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) {
    // Ref terlihat milik webstream tapi tidak ditemukan. Supaya callback toko1
    // tetap aman (mis. ada ref legacy/bentrok), forward juga ke toko1.
    return forwardCallbackToToko1(request, rawText, ctype || 'application/x-www-form-urlencoded', env);
  }
  const order = r.data[0];
  const verifyMode = String(env.WEBSTREAM_VERIFY_VMP_CALLBACK_SIG || '1').toLowerCase();
  const enforceSig = !['0', 'false', 'no', 'off'].includes(verifyMode);
  if (enforceSig) {
    const sigCheck = await validateVioletCallbackSignature(env, body, order.amount);
    if (!sigCheck.ok) return err(sigCheck.error, 401);
  }
  const newStatus = normalizeVioletStatus(body.status || body.payment_status);
  if (newStatus === 'success') {
    const amountCheck = validateVioletCallbackAmount(body, order);
    if (!amountCheck.ok) return err(amountCheck.error, 400);
  }
  const up = await supabaseRest(env, `/payment_orders?ref=eq.${encodeURIComponent(ref)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: newStatus, gateway_response: body, paid_at: newStatus === 'success' ? new Date().toISOString() : order.paid_at }),
  });
  const updated = up.ok && Array.isArray(up.data) ? up.data[0] : { ...order, status: newStatus };
  if (newStatus === 'success') {
    try { await applyPaidOrder(env, updated); } catch (_) { /* idempotent */ }
  }
  return json({ ok: true });
}

async function adminPaymentList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, '/payment_orders?select=*&order=created_at.desc&limit=300');
  if (!r.ok) return err('Gagal load pembelian', 500);
  return json({ ok: true, orders: r.data || [] });
}

async function adminSettingsGet(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  return json({ ok: true, settings: await getPaymentSettings(env) });
}

async function adminSettingsUpdate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  let body;
  try { body = await request.json(); } catch { return err('Body harus JSON'); }
  const allowed = ['movie_price', 'series_season_price', 'vip_month_price', 'vip_week_price'];
  const rows = [];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0) return err(`Harga ${key} tidak valid`);
    rows.push({ key, value: String(Math.round(value)) });
  }
  if (!rows.length) return err('Tidak ada setting untuk disimpan');
  const r = await supabaseRest(env, '/payment_settings', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(rows),
  });
  if (!r.ok) return err('Gagal simpan setting: ' + JSON.stringify(r.data).slice(0, 200), 500);
  return json({ ok: true, settings: await getPaymentSettings(env) });
}

async function adminUserEntitlements(request, env, userId) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  return json({ ok: true, entitlements: await userEntitlements(env, userId) });
}


function previewKeyForFilm(film) {
  if (!film) return null;
  if (film.tipe === 'series') return `series:${film.judul || film.tmdb_id || film.id}:season:${film.season || 1}`;
  return `movie:${film.id}`;
}

async function getOrCreatePreviewSession(env, userId, film, limitSeconds) {
  const key = previewKeyForFilm(film);
  const existing = await supabaseRest(
    env,
    `/preview_sessions?user_id=eq.${encodeURIComponent(userId)}&preview_key=eq.${encodeURIComponent(key)}&select=*&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
    return existing.data[0];
  }
  const created = await supabaseRest(env, '/preview_sessions', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      film_id: film.id,
      preview_key: key,
      title: film.judul || null,
      limit_seconds: limitSeconds,
      remaining_seconds: limitSeconds,
      is_running: false,
    }),
  });
  if (created.ok && Array.isArray(created.data) && created.data.length) return created.data[0];
  if (created.ok && created.data) return created.data;
  throw new Error('Gagal membuat sesi preview');
}

async function startPreviewSession(env, session) {
  const now = new Date();
  let remaining = Number(session.remaining_seconds ?? session.limit_seconds ?? 0);
  if (session.is_running && session.expires_at) {
    remaining = Math.max(0, Math.ceil((new Date(session.expires_at).getTime() - Date.now()) / 1000));
  }
  if (remaining <= 0) {
    await supabaseRest(env, `/preview_sessions?id=eq.${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        remaining_seconds: 0,
        is_running: false,
        expires_at: null,
        updated_at: now.toISOString(),
      }),
    });
    return { ...session, remaining_seconds: 0, is_running: false, expires_at: null };
  }
  const expiresAt = new Date(now.getTime() + remaining * 1000).toISOString();
  const updated = await supabaseRest(env, `/preview_sessions?id=eq.${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      remaining_seconds: remaining,
      is_running: true,
      started_at: now.toISOString(),
      expires_at: expiresAt,
      updated_at: now.toISOString(),
    }),
  });
  const row = updated.ok && Array.isArray(updated.data) && updated.data.length ? updated.data[0] : session;
  return { ...row, remaining_seconds: remaining, is_running: true, started_at: now.toISOString(), expires_at: expiresAt };
}

async function stopPreviewHandler(request, env, filmId) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  const film = await getFilmById(env, filmId);
  if (!film) return err('Film tidak ditemukan', 404);
  const profile = await getUserProfile(env, user.id, user.email);
  const isVip = isVipProfileActive(profile);
  const entitled = await hasFilmEntitlement(env, profile?.user_id || user.id, film);
  if (isVip || entitled) return json({ ok: true, skipped: true });

  const key = previewKeyForFilm(film);
  const userId = profile?.user_id || user.id;
  const existing = await supabaseRest(
    env,
    `/preview_sessions?user_id=eq.${encodeURIComponent(userId)}&preview_key=eq.${encodeURIComponent(key)}&select=*&limit=1`
  );
  const session = existing.ok && Array.isArray(existing.data) && existing.data.length ? existing.data[0] : null;
  if (!session) return json({ ok: true, skipped: true });

  let remaining = Number(session.remaining_seconds ?? session.limit_seconds ?? 0);
  if (session.is_running && session.expires_at) {
    remaining = Math.max(0, Math.ceil((new Date(session.expires_at).getTime() - Date.now()) / 1000));
  }
  const now = new Date().toISOString();
  const updated = await supabaseRest(env, `/preview_sessions?id=eq.${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      remaining_seconds: remaining,
      is_running: false,
      expires_at: null,
      updated_at: now,
    }),
  });
  if (!updated.ok) return err('Gagal menyimpan sisa preview', 500);
  return json({ ok: true, preview_remaining_seconds: remaining });
}
async function playbackHandler(request, env, filmId) {
  const user = await getUserFromAuth(request, env);
  if (!user) return err('Login dulu', 401);
  const film = await getFilmById(env, filmId);
  if (!film) return err('Film tidak ditemukan', 404);
  const profile = await getUserProfile(env, user.id, user.email);
  const isVip = isVipProfileActive(profile);
  const entitled = await hasFilmEntitlement(env, profile?.user_id || user.id, film);
  const hasFullAccess = isVip || entitled;
  const isVipOnly = film.tier === 'vip';
  const episodeNo = Number(film.episode || 1);
  const isLockedEpisode = film.tipe === 'series' && episodeNo > 1 && !hasFullAccess;

  if (isVipOnly && !isVip) {
    return json({ ok: true, locked: true, reason: 'vip_required', message: 'Film ini hanya untuk member VIP aktif.' }, 403);
  }
  if (isLockedEpisode) {
    return json({ ok: true, locked: true, reason: 'episode_locked', message: 'Free hanya bisa membuka episode 1. Beli season atau upgrade VIP.' }, 403);
  }

  const previewSeconds = film.tipe === 'series' ? 7 * 60 : 5 * 60;
  const previewUrl = (typeof film.preview_video_url === 'string' && film.preview_video_url.trim()) ? film.preview_video_url.trim() : null;
  const fullUrl = (typeof film.video_url === 'string' && film.video_url.trim()) ? film.video_url.trim() : null;
  const videoUrl = hasFullAccess ? fullUrl : (previewUrl || fullUrl);
  if (!videoUrl) return err('Film ini belum punya URL video.', 404);

  let previewSession = null;
  let remainingSeconds = null;
  if (!hasFullAccess) {
    try {
      previewSession = await getOrCreatePreviewSession(env, profile?.user_id || user.id, film, previewSeconds);
      previewSession = await startPreviewSession(env, previewSession);
    } catch (e) {
      return err(e.message || 'Preview belum siap', 500);
    }
    remainingSeconds = Math.max(0, Number(previewSession.remaining_seconds || 0));
    if (remainingSeconds <= 0) {
      return json({
        ok: true,
        locked: true,
        reason: 'preview_expired',
        message: 'Waktu preview sudah habis. Silahkan daftar VIP atau beli akses full.',
        preview_seconds: previewSeconds,
        preview_expires_at: previewSession.expires_at,
      }, 403);
    }
  }

  return json({
    ok: true,
    locked: false,
    access: hasFullAccess ? 'full' : 'preview',
    preview_seconds: hasFullAccess ? null : previewSeconds,
    preview_remaining_seconds: remainingSeconds,
    preview_started_at: previewSession ? previewSession.started_at : null,
    preview_expires_at: previewSession ? previewSession.expires_at : null,
    has_real_preview: !hasFullAccess && !!previewUrl,
    video_url: videoUrl,
    videos: film.videos || [],
    audio_url: film.audio_url || null,
    audio_tracks: film.audio_tracks || [],
    subtitles: film.subtitles || [],
    subtitle_urls: film.subtitle_urls || [],
    r2_bucket: film.r2_bucket || '',
    r2_path: film.r2_path || '',
  });
}
// ───────────────────────────────────────────────────────────────────
// Router
// ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // === Public expose config (NON-secret only) ===
    // Frontend butuh tahu Supabase URL + anon key. Service key TIDAK pernah
    // di-expose. Single supabase project — no more cross-project mirror.
   if (pathname === '/api/config' && request.method === 'GET') {
  const basicDomain = env.PLAYER4ME_BASIC_DOMAIN || env.PLAYER4ME_PUBLIC_DOMAIN || '';
  const vipDomain = env.PLAYER4ME_VIP_DOMAIN || basicDomain;

  return json({
    ok: true,
    supabase_url: env.SUPABASE_URL,
    supabase_anon_key: env.SUPABASE_ANON_KEY || '',
    gdi_worker_url: env.GDI_WORKER_URL,
    tmdb_image_base: 'https://image.tmdb.org/t/p/w500',

    // Legacy, supaya kode lama tetap aman
    video_host_domain: basicDomain,

    // Baru: domain player per tier
    player4me_basic_domain: basicDomain,
    player4me_vip_domain: vipDomain,
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

    // === R2 stream proxy (GET + HEAD, video seeking via Range) ===
    {
      const m = pathname.match(/^\/api\/r2-stream\/(.+)/);
      if (m && (request.method === 'GET' || request.method === 'HEAD')) {
        return r2StreamHandler(request, env, m[1]);
      }
    }

    // === Catalog (public read) ===
    if (pathname === '/api/catalog' && request.method === 'GET') {
      return catalogList(request, env);
    }

    {
      const m = pathname.match(/^\/api\/playback\/([^/]+)$/);
      if (m && request.method === 'GET') return playbackHandler(request, env, m[1]);
    }
    {
      const m = pathname.match(/^\/api\/playback\/([^/]+)\/stop$/);
      if (m && request.method === 'POST') return stopPreviewHandler(request, env, m[1]);
    }
    // === Identity ===
    if (pathname === '/api/me' && request.method === 'GET') {
      return meHandler(request, env);
    }

    // === Payments / purchases ===
    if (pathname === '/api/payments/checkout' && request.method === 'POST') {
      return paymentCheckout(request, env);
    }
    if (pathname === '/api/payments/order' && request.method === 'GET') {
      return paymentOrderGet(request, env);
    }
    if (pathname === '/api/payments/channels' && request.method === 'GET') {
      return paymentChannelsList(request);
    }
    if (pathname === '/api/payments/start' && request.method === 'POST') {
      return paymentStart(request, env);
    }
    if (pathname === '/api/payments/status' && request.method === 'GET') {
      return paymentStatus(request, env);
    }
    if (pathname === '/api/payments/my-orders' && request.method === 'GET') {
      return paymentMyOrders(request, env);
    }
    // Callback URL VMP — terima POST & GET supaya VMP yang variant query-string juga aman.
    // Dispatcher di violetCallback() akan forward ke toko 1 kalau ref bukan ZS-*.
    if (pathname === '/api/payments/violet/callback' && (request.method === 'POST' || request.method === 'GET')) {
      return violetCallback(request, env);
    }
    // Alias supaya kamu bisa setup callback URL pendek di dashboard VMP.
    if (pathname === '/api/callback' && (request.method === 'POST' || request.method === 'GET')) {
      return violetCallback(request, env);
    }

    // === Payment page (handled inside SPA index.html) ===
    // Backward-compat: beberapa link lama masih pakai /payment?ref=...
    // Redirect ke route baru /payment/checkout?ref=... (route ini ditangani
    // oleh client-side router di index.html, bukan file payment terpisah).
    if (pathname === '/payment' && request.method === 'GET') {
      const ref = (
        url.searchParams.get('ref')
        || url.searchParams.get('ref_kode')
        || url.searchParams.get('reference')
        || url.searchParams.get('order_ref')
        || ''
      ).trim();
      if (ref) {
        return Response.redirect(`${url.origin}/payment/checkout?ref=${encodeURIComponent(ref)}`, 302);
      }
      return Response.redirect(`${url.origin}/`, 302);
    }
    // /payment/checkout?ref=... & /payment/success?ref=...
    // keduanya di-handle SPA index.html.
    if (pathname === '/payment/checkout' && request.method === 'GET') {
      if (env.ASSETS) {
        const assetReq = new Request(new URL('/index.html', url.origin).toString(), request);
        return serveAsset(assetReq, env);
      }
    }
    // Clean SPA routes: refresh/direct-open should serve the app shell,
    // then the client router resolves pagination, genre, film, and account pages.
    if (request.method === 'GET' && /^(\/vip(?:\/.*)?|\/movies(?:\/.*)?|\/tv(?:\/.*)?|\/browse(?:\/.*)?|\/film(?:\/.*)?|\/collection(?:\/.*)?|\/search|\/collections|\/my-collections|\/watchlist|\/cart|\/orders|\/faq|\/profile)$/.test(pathname)) {
      if (env.ASSETS) {
        const assetReq = new Request(new URL('/index.html', url.origin).toString(), request);
        return serveAsset(assetReq, env);
      }
    }
    // Hard-guard: root homepage MUST serve index.html.
    // This avoids accidental fallback to payment.html when asset/CDN routing
    // gets stale after deploy.
    if (pathname === '/' && request.method === 'GET') {
      if (env.ASSETS) {
        const assetReq = new Request(new URL('/index.html', url.origin).toString(), request);
        return serveAsset(assetReq, env);
      }
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
    if (pathname === '/api/tmdb/home' && request.method === 'GET') {
      return tmdbHomeHandler(request, env);
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

    // === Admin: payments / pricing ===
    if (pathname === '/api/admin/payments' && request.method === 'GET') {
      return adminPaymentList(request, env);
    }
    if (pathname === '/api/admin/payment-settings' && request.method === 'GET') {
      return adminSettingsGet(request, env);
    }
    if (pathname === '/api/admin/payment-settings' && request.method === 'PATCH') {
      return adminSettingsUpdate(request, env);
    }
    if (pathname === '/api/admin/tmdb-hidden' && request.method === 'GET') {
      return adminTmdbHiddenList(request, env);
    }
    if (pathname === '/api/admin/tmdb-hidden' && request.method === 'POST') {
      return adminTmdbHiddenUpsert(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/tmdb-hidden\/(movie|tv)\/(\d+)$/);
      if (m && request.method === 'DELETE') return adminTmdbHiddenDelete(request, env, m[1], m[2]);
    }
    {
      const m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/entitlements$/);
      if (m && request.method === 'GET') return adminUserEntitlements(request, env, m[1]);
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
      return authSignupHandler(request, env, ctx);
    }
    if (pathname === '/api/auth/login-event' && request.method === 'POST') {
      return authLoginEventHandler(request, env, ctx);
    }
    if (pathname === '/api/auth/login-notify' && request.method === 'POST') {
      return authLoginFailNotifyHandler(request, env, ctx);
    }

    // === Admin: films ===
    if (pathname === '/api/admin/films' && request.method === 'POST') {
      return adminFilmCreate(request, env);
    }
    if (pathname === '/api/admin/films/tmdb-sync' && (request.method === 'POST' || request.method === 'GET')) {
      return adminFilmsTmdbSync(request, env);
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
    if (pathname === '/api/admin/users/reset-free' && request.method === 'POST') {
      return adminUsersResetFree(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (m && request.method === 'PATCH') return adminUserUpdate(request, env, m[1]);
      if (m && request.method === 'DELETE') return adminUserDelete(request, env, m[1]);
    }
    {
      const m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/entitlements$/);
      if (m && request.method === 'POST') return adminGrantUserEntitlement(request, env, m[1]);
    }
    {
      const m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/entitlements\/([^/]+)$/);
      if (m && request.method === 'DELETE') return adminRevokeUserEntitlement(request, env, m[1], m[2]);
    }

    // === Public collections ===
    if (pathname === '/api/collections' && request.method === 'GET') {
      return collectionsList(request, env);
    }
    {
      const m = pathname.match(/^\/api\/collections\/([^/]+)$/);
      if (m && request.method === 'GET') return collectionsDetail(request, env, m[1]);
    }

    // === Admin: collections ===
    if (pathname === '/api/admin/collections' && request.method === 'GET') {
      return adminCollectionsList(request, env);
    }
    if (pathname === '/api/admin/collections' && request.method === 'POST') {
      return adminCollectionCreate(request, env);
    }
    {
      const m = pathname.match(/^\/api\/admin\/collections\/([^/]+)$/);
      if (m && request.method === 'PATCH')  return adminCollectionUpdate(request, env, m[1]);
      if (m && request.method === 'DELETE') return adminCollectionDelete(request, env, m[1]);
      if (m && request.method === 'GET')    return adminCollectionDetail(request, env, m[1]);
    }
    {
      const m = pathname.match(/^\/api\/admin\/collections\/([^/]+)\/films$/);
      if (m && request.method === 'PUT') return adminCollectionFilmsReplace(request, env, m[1]);
    }

    // === Static assets (index.html, dll) ===
    // Cloudflare akan otomatis serve dari ./public/ via [assets] di wrangler.toml
    if (env.ASSETS) return serveAsset(request, env);

    return err('Not Found', 404);
    } catch (e) {
      return json({ ok: false, error: 'Internal error: ' + e.message }, 500);
    }
  },
};

// ───────────────────────────────────────────────────────────────────
// R2 STREAM PROXY — proxying from R2 public domain with Range + CORS support
// ───────────────────────────────────────────────────────────────────

// GET|HEAD /api/r2-stream/:path
// Two path formats:
//   1. r2_bucket+r2_path:  /api/r2-stream/{bucket}/{objectKey}  → strip bucket name
//   2. fallback (audio/sub): /api/r2-stream/{objectKey}          → use as-is
// Forwarded to R2_PUBLIC_DOMAIN with Range header for video seeking.
// ─── AWS V4 signing helpers for presigned R2 S3 URLs ───

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function enc(s) { return encodeURIComponent(s); }
function encPath(s) {
  return String(s || '').split('/').map(part => encodeURIComponent(part)).join('/');
}

function decodeR2Token(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  try {
    const bin = atob(raw);
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    return decoded.includes(':') ? decoded : raw;
  } catch (_) {
    return raw;
  }
}

async function getR2AccountConfig(env, accountId) {
  const wanted = String(accountId || '').trim();
  if (!wanted) return null;
  const defaultAccount = env.R2_S3_ACCOUNT_ID || '0c3e24ee0059b5d7deaeee4bd9ace23f';
  if (wanted === defaultAccount && env.R2_S3_ACCESS_KEY && env.R2_S3_SECRET_KEY) {
    return {
      accountId: defaultAccount,
      accessKey: env.R2_S3_ACCESS_KEY,
      secretKey: env.R2_S3_SECRET_KEY,
      bucket: env.R2_BUCKET_NAME || 'zaeinstream-video',
    };
  }
  const r = await supabaseRest(
    env,
    `/cf_r2_accounts?account_id=eq.${encodeURIComponent(wanted)}&select=account_id,bucket_name,token_encrypted,status&limit=1`
  );
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  const account = r.data[0];
  if (account.status && String(account.status).toLowerCase() !== 'active') return null;
  const token = decodeR2Token(account.token_encrypted || '');
  const parts = token.split(':');
  if (!parts[0] || !parts[1]) return null;
  return {
    accountId: account.account_id,
    accessKey: parts[0],
    secretKey: parts.slice(1).join(':'),
    bucket: account.bucket_name || 'zaeinstream-video',
  };
}

async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

async function presignR2Url(accountId, accessKey, secretKey, bucket, key, expiresIn, method = 'GET') {
  const region = 'auto', service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, '').split('.')[0] + 'Z';
  const dateStamp = amzDate.substring(0, 8);
  const credential = accessKey + '/' + dateStamp + '/' + region + '/' + service + '/aws4_request';
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonQs = params.map(p => enc(p[0]) + '=' + enc(p[1])).join('&');
  const canonUri = '/' + encPath(bucket) + '/' + encPath(key);
  const canonHeaders = 'host:' + accountId + '.r2.cloudflarestorage.com\n';
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const canonReq = method + '\n' + canonUri + '\n' + canonQs + '\n' + canonHeaders + '\n' + signedHeaders + '\n' + payloadHash;
  const crHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonReq)));
  const credScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credScope + '\n' + crHash;
  // Derive signing key: AWS4(secret) → dateStamp → region → service → aws4_request
  let k = await hmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  k = await hmacSha256(k, region);
  k = await hmacSha256(k, service);
  k = await hmacSha256(k, 'aws4_request');
  const sig = bytesToHex(await hmacSha256(k, sts));
  const host = accountId + '.r2.cloudflarestorage.com';
  return 'https://' + host + '/' + encPath(bucket) + '/' + encPath(key) + '?' + canonQs + '&X-Amz-Signature=' + sig;
}

async function fetchR2FollowingRedirects(url, init, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const upstream = await fetch(current, Object.assign({}, init, { redirect: 'manual' }));
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream;
    const loc = upstream.headers.get('Location');
    if (!loc) return upstream;
    current = new URL(loc, current).toString();
  }
  return fetch(current, Object.assign({}, init, { redirect: 'follow' }));
}

function guessR2ContentType(key) {
  const lower = String(key || '').toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (lower.endsWith('.srt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'text/plain; charset=utf-8';
  return '';
}

async function r2StreamHandler(request, env, r2Path) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Origin',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Known logical bucket names (from film.r2_bucket)
  const knownBuckets = ['zaeinstream-video', 'zaeinstream-zip', 'zaeinstream-music'];
  let accountOverride = null;
  if (r2Path.startsWith('account/')) {
    const parts = r2Path.split('/');
    if (parts.length >= 4) {
      accountOverride = decodeURIComponent(parts[1] || '');
      r2Path = parts.slice(2).join('/');
    }
  }
  let bucketName = null;
  let objectKey = r2Path;
  const firstSlash = r2Path.indexOf('/');
  if (firstSlash > 0) {
    const firstSeg = r2Path.substring(0, firstSlash);
    if (knownBuckets.includes(firstSeg)) {
      bucketName = firstSeg;
      // Strip bucket prefix — the actual R2 object key is just {r2_path}/{type}/{filename}
      objectKey = r2Path.substring(firstSlash + 1);
    }
  }

  // If we have S3 credentials and this is zaeinstream-video → proxy via presigned S3 URL
  // Server-to-server fetch (no CORS issues), then return with CORS headers to browser.
  // Worker streams response body directly — no 100MB buffer limit for streaming bodies.
  if (bucketName === 'zaeinstream-video' && (accountOverride || (env.R2_S3_ACCESS_KEY && env.R2_S3_SECRET_KEY))) {
    const accountCfg = accountOverride
      ? await getR2AccountConfig(env, accountOverride)
      : {
          accountId: env.R2_S3_ACCOUNT_ID || '0c3e24ee0059b5d7deaeee4bd9ace23f',
          accessKey: env.R2_S3_ACCESS_KEY,
          secretKey: env.R2_S3_SECRET_KEY,
          bucket: env.R2_BUCKET_NAME || 'zaeinstream-video',
        };
    if (!accountCfg) return err('R2 account tidak ditemukan', 404);
    const s3Account = accountCfg.accountId;
    const s3AccessKey = accountCfg.accessKey;
    const s3SecretKey = accountCfg.secretKey;
    const bucket = accountCfg.bucket || bucketName;

    // Presigned URL valid 12 hours — one landing page visit is enough
    const presignedUrl = await presignR2Url(s3Account, s3AccessKey, s3SecretKey, bucket, objectKey, 43200, request.method);

    // Forward Range header for seeking
    const upstreamHeaders = new Headers();
    const range = request.headers.get('Range');
    if (range) upstreamHeaders.set('Range', range);

    const upstream = await fetchR2FollowingRedirects(presignedUrl, { method: request.method, headers: upstreamHeaders });

    // Forward upstream response with CORS headers added
    const responseHeaders = new Headers(upstream.headers);
    if (!responseHeaders.get('Content-Type')) {
      const guessed = guessR2ContentType(objectKey);
      if (guessed) responseHeaders.set('Content-Type', guessed);
    }
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type, Origin, Accept');
    responseHeaders.set('Cache-Control', 'no-store, max-age=0');
    responseHeaders.set('Vary', 'Origin, Range');

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  // Fallback: proxy via public URL (original approach — for other buckets)
  const VIDEO_DOMAIN = env.R2_PUBLIC_DOMAIN || 'https://pub-0c8b20c7691f40b8b024516868a0a2f7.r2.dev';
  const MEDIA_DOMAIN = env.R2_MEDIA_PUBLIC_DOMAIN || VIDEO_DOMAIN;
  let publicDomain, finalKey;
  if (bucketName === 'zaeinstream-video') {
    // Use custom domain (not pub-xxx) — path does NOT need bucket prefix
    publicDomain = 'https://zaeinstream-video.0c3e24ee0059b5d7deaeee4bd9ace23f.r2.dev';
    finalKey = objectKey;
  } else {
    publicDomain = VIDEO_DOMAIN.replace(/\/+$/, '');
    finalKey = objectKey;
  }
  const publicUrl = publicDomain + '/' + finalKey;
  const upstreamHeaders = new Headers();
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.set('Range', range);
  const upstream = await fetchR2FollowingRedirects(publicUrl, { method: request.method, headers: upstreamHeaders });
  const responseHeaders = new Headers(upstream.headers);
  if (!responseHeaders.get('Content-Type')) {
    const guessed = guessR2ContentType(finalKey);
    if (guessed) responseHeaders.set('Content-Type', guessed);
  }
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  responseHeaders.set('Cache-Control', 'no-store, max-age=0');
  responseHeaders.set('Vary', 'Origin, Range');
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status, statusText: upstream.statusText, headers: responseHeaders,
  });
}

// ───────────────────────────────────────────────────────────────────
// COLLECTIONS — public list/detail + admin CRUD
// ───────────────────────────────────────────────────────────────────

// GET /api/collections — list all collections (no films, just cards for grid)
async function collectionsList(request, env) {
  const r = await supabaseRest(env, '/collections?select=id,title,description,cover_url,sort_order&order=sort_order.asc,id.asc');
  if (!r.ok) return err('Gagal load collections', 500);
  const collections = Array.isArray(r.data) ? r.data : [];
  if (!collections.length) return json({ ok: true, collections: [] });
  const ids = collections.map(c => c.id);
  const inList = ids.join(',');
  // Pull collection_films join with the film tipe + judul so we can count
  // movies and series SEPARATELY (series get deduped per-judul, since a
  // multi-episode series shouldn't inflate the count).
  const cf = await supabaseRest(
    env,
    `/collection_films?select=collection_id,films(tipe,judul)&collection_id=in.(${inList})`
  );
  // Per-collection counters: movies = unique movie ids; series = unique
  // series titles.
  const movieCount = {};
  const seriesTitlesByColl = {};
  if (cf.ok && Array.isArray(cf.data)) {
    for (const row of cf.data) {
      const cid = row.collection_id;
      const f = row.films;
      if (!f) continue;
      if (f.tipe === 'series') {
        if (!seriesTitlesByColl[cid]) seriesTitlesByColl[cid] = new Set();
        if (f.judul) seriesTitlesByColl[cid].add(f.judul);
      } else {
        movieCount[cid] = (movieCount[cid] || 0) + 1;
      }
    }
  }
  return json(
    {
      ok: true,
      collections: collections.map(c => {
        const movies = movieCount[c.id] || 0;
        const series = seriesTitlesByColl[c.id] ? seriesTitlesByColl[c.id].size : 0;
        return {
          id: c.id,
          title: c.title,
          description: c.description || '',
          cover_url: c.cover_url || '',
          film_count: movies + series,
          movie_count: movies,
          series_count: series,
        };
      }),
    },
    200,
    // Cache the collections list at the CF edge for 60 s. Detail cards
    // change rarely (admin curation), so this hides Supabase round-trip
    // latency that was making the page feel slow.
    { 'Cache-Control': 'public, max-age=15, s-maxage=60, stale-while-revalidate=120' }
  );
}

// GET /api/collections/:id — detail with films
async function collectionsDetail(request, env, id) {
  const r = await supabaseRest(env, `/collections?id=eq.${encodeURIComponent(id)}&select=id,title,description,cover_url,sort_order`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return err('Collection not found', 404);
  const collection = r.data[0];
  const cf = await supabaseRest(env, `/collection_films?select=position,films(*)&collection_id=eq.${encodeURIComponent(id)}&order=position.asc`);
  const films = (cf.ok && Array.isArray(cf.data))
    ? cf.data
        .map(row => row.films)
        .filter(Boolean)
        .map(f => {
          const copy = { ...f };
          // Public detail strips streaming sources — same convention as /api/catalog.
          delete copy.video_url;
          delete copy.preview_video_url;
          delete copy.drive_link;
          delete copy.drive_path;
          delete copy.videos;
          delete copy.audio_tracks;
          return copy;
        })
    : [];

  // Count movies and series separately (series deduped by judul).
  let movieCount = 0;
  const seriesTitles = new Set();
  for (const f of films) {
    if (f.tipe === 'series') {
      if (f.judul) seriesTitles.add(f.judul);
    } else {
      movieCount++;
    }
  }
  const seriesCount = seriesTitles.size;

  return json({
    ok: true,
    collection: {
      id: collection.id,
      title: collection.title,
      description: collection.description || '',
      cover_url: collection.cover_url || '',
      film_count: movieCount + seriesCount,
      movie_count: movieCount,
      series_count: seriesCount,
    },
    films,
  }, 200, {
    'Cache-Control': 'public, max-age=15, s-maxage=60, stale-while-revalidate=120',
  });
}

// GET /api/admin/collections — admin list (with raw cover URL for editing)
async function adminCollectionsList(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, '/collections?select=*&order=sort_order.asc,id.asc');
  if (!r.ok) return err('Gagal load collections', 500);
  const collections = Array.isArray(r.data) ? r.data : [];
  const ids = collections.map(c => c.id);
  const movieCount = {};
  const seriesTitlesByColl = {};
  if (ids.length) {
    const cf = await supabaseRest(
      env,
      `/collection_films?select=collection_id,films(tipe,judul)&collection_id=in.(${ids.join(',')})`
    );
    if (cf.ok && Array.isArray(cf.data)) {
      for (const row of cf.data) {
        const cid = row.collection_id;
        const f = row.films;
        if (!f) continue;
        if (f.tipe === 'series') {
          if (!seriesTitlesByColl[cid]) seriesTitlesByColl[cid] = new Set();
          if (f.judul) seriesTitlesByColl[cid].add(f.judul);
        } else {
          movieCount[cid] = (movieCount[cid] || 0) + 1;
        }
      }
    }
  }
  return json({
    ok: true,
    collections: collections.map(c => {
      const movies = movieCount[c.id] || 0;
      const series = seriesTitlesByColl[c.id] ? seriesTitlesByColl[c.id].size : 0;
      return { ...c, film_count: movies + series, movie_count: movies, series_count: series };
    }),
  });
}

// GET /api/admin/collections/:id — admin detail (full film records, including streaming sources for preview)
async function adminCollectionDetail(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, `/collections?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return err('Collection not found', 404);
  const cf = await supabaseRest(env, `/collection_films?select=position,film_id,films(id,judul,tahun,tipe,poster_url,backdrop_url,tmdb_id)&collection_id=eq.${encodeURIComponent(id)}&order=position.asc`);
  const films = (cf.ok && Array.isArray(cf.data))
    ? cf.data.map(row => ({ ...row.films, position: row.position }))
    : [];
  return json({ ok: true, collection: r.data[0], films });
}

// POST /api/admin/collections — create collection.
// Body: { title, description?, cover_url?, sort_order?, film_ids?: number[] }
async function adminCollectionCreate(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  if (!title) return err('Title wajib diisi');
  const filmIds = Array.isArray(body.film_ids) ? body.film_ids.filter(x => Number.isFinite(Number(x))).map(Number) : [];

  let coverUrl = (typeof body.cover_url === 'string' ? body.cover_url.trim() : '') || null;
  // If admin didn't supply cover URL but added films, auto-pick the first film's
  // backdrop (TMDB landscape image). Fallback to poster_url if no backdrop.
  if (!coverUrl && filmIds.length) {
    const first = await supabaseRest(env, `/films?id=eq.${filmIds[0]}&select=backdrop_url,poster_url`);
    if (first.ok && Array.isArray(first.data) && first.data[0]) {
      coverUrl = first.data[0].backdrop_url || first.data[0].poster_url || null;
    }
  }

  const insert = await supabaseRest(env, '/collections', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      title,
      description: (typeof body.description === 'string' ? body.description.trim() : '') || null,
      cover_url: coverUrl,
      sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    }),
  });
  if (!insert.ok || !Array.isArray(insert.data) || !insert.data[0]) return err('Gagal buat collection', 500);
  const collection = insert.data[0];

  // Insert film junction rows.
  if (filmIds.length) {
    const rows = filmIds.map((fid, idx) => ({
      collection_id: collection.id,
      film_id: fid,
      position: idx,
    }));
    await supabaseRest(env, '/collection_films', {
      method: 'POST',
      body: JSON.stringify(rows),
    });
  }

  return json({ ok: true, collection });
}

// PATCH /api/admin/collections/:id
async function adminCollectionUpdate(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (typeof body.title === 'string') patch.title = body.title.trim();
  if (typeof body.description === 'string') patch.description = body.description.trim() || null;
  if (typeof body.cover_url === 'string') patch.cover_url = body.cover_url.trim() || null;
  if (Number.isFinite(Number(body.sort_order))) patch.sort_order = Number(body.sort_order);
  patch.updated_at = new Date().toISOString();
  const r = await supabaseRest(env, `/collections?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err('Gagal update', 500);
  return json({ ok: true });
}

// DELETE /api/admin/collections/:id (cascade deletes collection_films)
async function adminCollectionDelete(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const r = await supabaseRest(env, `/collections?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) return err('Gagal delete', 500);
  return json({ ok: true });
}

// PUT /api/admin/collections/:id/films — replace film list and reorder.
// Body: { film_ids: number[] } — order matters; positions are reset.
async function adminCollectionFilmsReplace(request, env, id) {
  const admin = await requireAdmin(request, env);
  if (!admin) return err('Forbidden', 403);
  const body = await request.json().catch(() => ({}));
  const filmIds = Array.isArray(body.film_ids) ? body.film_ids.filter(x => Number.isFinite(Number(x))).map(Number) : [];
  // Clear existing junction rows.
  await supabaseRest(env, `/collection_films?collection_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  // Insert fresh rows.
  if (filmIds.length) {
    const rows = filmIds.map((fid, idx) => ({
      collection_id: Number(id),
      film_id: fid,
      position: idx,
    }));
    const ins = await supabaseRest(env, '/collection_films', {
      method: 'POST',
      body: JSON.stringify(rows),
    });
    if (!ins.ok) return err('Gagal save film list', 500);
  }
  // Bump updated_at on parent.
  await supabaseRest(env, `/collections?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });
  return json({ ok: true, count: filmIds.length });
}
