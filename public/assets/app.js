/* ════════════════════════════════════════════════════════════════════
   STATE & CONFIG
   ════════════════════════════════════════════════════════════════════ */
let CONFIG = null;
// One supabase client — single project, single session, single signOut.
// (The previous external/local dual-client layout has been removed. All
// auth state lives in one storage key now.)
let sb = null;
let currentUser = null;
let session = null;
let currentProfile = null;
let currentTier = 'guest';   // guest | free | vip | expired
let allFilms = [];
// Watchlist: legacy was an array of ids. New format is an object
// { id: { status, addedAt } } where status is one of WL_STATUSES.
// Migration on load: bare ids become { status:'plan', addedAt:0 }.
const WL_STATUSES = ['plan','watching','onhold','finished','dropped'];
let watchlist = (function(){
  let raw;
  try{ raw = JSON.parse(localStorage.getItem('zaein_watchlist')||'{}'); }catch{ raw = {}; }
  if(Array.isArray(raw)){
    const obj = {};
    for(const id of raw){ obj[String(id)] = { status:'plan', addedAt: Date.now() }; }
    raw = obj;
    try{ localStorage.setItem('zaein_watchlist', JSON.stringify(raw)); }catch{}
  }
  return raw && typeof raw === 'object' ? raw : {};
})();
let cart = JSON.parse(localStorage.getItem('zaein_cart')||'[]');
cart = Array.isArray(cart) ? cart.map(i => ({ ...i, selected: i && i.selected !== false })) : [];
let currentEntitlements = [];
let currentFilm = null;
let currentResumeFrom = 0;
let currentPlayerTier = 'basic'; // basic | vip
let currentTmdbExtras = null;
let currentTrailerKey = null;
let _currentSubBlobUrl = null;
let tmdbHome = { hero: [], rows: {} };
let heroSlideIndex = 0;
let heroSlideTimer = null;
// Legacy globals — kept as `null` shims so dead legacy player functions
// (teardownEngine1/2 etc.) don't ReferenceError if called by accident.
// All playback now goes through loadVideoHost().
let mtPlayer = null;
let videoPlayer = null;
let activeEngine = 1;
let p2State = null;
const PLAYER_ENGINE_KEY = 'zaeinstream-player-engine';

async function authHeaders(extra = {}){
  let token = '';
  try{
    token = session?.access_token || (sb && (await sb.auth.getSession()).data.session?.access_token) || '';
  }catch(_){ token = ''; }
  return token ? { ...extra, Authorization: 'Bearer ' + token } : { ...extra };
}

/* ════════════════════════════════════════════════════════════════════
   PAYMENT RETURN — auto-sync setelah user kembali dari VMP
   ────────────────────────────────────────────────────────────────────
   Callback URL global di akun VMP sudah dipakai project lain, jadi
   kita TIDAK bisa bergantung ke webhook untuk auto-grant. Sebagai
   gantinya, kalau user mendarat di /payment/success?ref=..., kita
   poll /api/payments/status?ref=... yang di backend akan tanya VMP
   /transactions dan apply order kalau memang sudah lunas.
   ════════════════════════════════════════════════════════════════════ */
const PAYMENT_RETURN_PATH = '/payment/success';
function readPaymentReturnRef(){
  try{
    if(location.pathname !== PAYMENT_RETURN_PATH) return null;
    const ref = new URLSearchParams(location.search).get('ref') || '';
    return ref.trim() || null;
  }catch(_){ return null; }
}
function showPaymentVerifyOverlay(msg){
  let el = document.getElementById('payVerifyOverlay');
  if(!el){
    el = document.createElement('div');
    el.id = 'payVerifyOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(8,10,16,.92);color:#fff;font-family:inherit;padding:24px;text-align:center;';
    el.innerHTML = ''
      + '<div style="width:42px;height:42px;border:3px solid rgba(245,197,24,.25);border-top-color:#f5c518;border-radius:50%;animation:payspin 1s linear infinite;"></div>'
      + '<div id="payVerifyMsg" style="font-size:1.05rem;max-width:32ch;line-height:1.45;"></div>'
      + '<div id="payVerifySub" style="color:#9aa3b2;font-size:.85rem;max-width:34ch;line-height:1.4;">Jangan tutup halaman ini. Akses kamu akan otomatis terbuka begitu pembayaran terkonfirmasi.</div>'
      + '<style>@keyframes payspin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }
  const m = document.getElementById('payVerifyMsg');
  if(m) m.textContent = msg || 'Memverifikasi pembayaran...';
  el.style.display = 'flex';
}
function hidePaymentVerifyOverlay(){
  const el = document.getElementById('payVerifyOverlay');
  if(el) el.remove();
}
// Ambil judul film dari order: prioritas cart_items[].title (multi item),
// fallback ke metadata.title atau order.product_name. Return array unique.
function extractOrderFilmTitles(order){
  if(!order || typeof order !== 'object') return [];
  const out = [];
  const push = t => {
    const s = String(t || '').trim();
    if(s && !out.includes(s)) out.push(s);
  };
  let meta = order.metadata;
  if(typeof meta === 'string'){
    try{ meta = JSON.parse(meta); }catch(_){ meta = null; }
  }
  if(meta && Array.isArray(meta.cart_items)){
    for(const it of meta.cart_items){
      if(it && it.title) push(it.title);
    }
  }
  if(meta && meta.title) push(meta.title);
  if(order.product_name) push(order.product_name);
  return out;
}
// Toast khusus pembayaran film sukses — sebutkan judul + tombol ke My Collection.
// Auto-hilang 6 detik (lebih lama dari toast normal karena pesan lebih panjang).
function showPaymentSuccessFilmNotice(titles){
  const list = Array.isArray(titles) ? titles.filter(Boolean) : [];
  if(!list.length){
    showToast('Pembayaran berhasil — akses film sudah aktif. Cek di My Collection.', 'success');
    return;
  }
  // Build pesan: kalau 1 film "selamat kamu telah dapat akses \"Judul\"".
  // Kalau >1 film, gabung dengan koma + " dan ".
  let phrase;
  if(list.length === 1){
    phrase = `"${list[0]}"`;
  } else if(list.length === 2){
    phrase = `"${list[0]}" dan "${list[1]}"`;
  } else {
    phrase = list.slice(0, -1).map(t => `"${t}"`).join(', ') + `, dan "${list[list.length - 1]}"`;
  }
  const existing = document.getElementById('payFilmNotice');
  if(existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'payFilmNotice';
  el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99998;max-width:min(92vw,420px);background:#0f1622;border:1px solid rgba(34,197,94,.45);box-shadow:0 12px 28px rgba(0,0,0,.45);border-radius:14px;padding:14px 16px;color:#e8eef7;font-family:inherit;display:flex;flex-direction:column;gap:10px;';
  el.innerHTML = ''
    + '<div style="display:flex;gap:10px;align-items:flex-start;">'
    +   '<div style="width:28px;height:28px;flex:0 0 28px;border-radius:50%;background:rgba(34,197,94,.18);color:#22c55e;display:flex;align-items:center;justify-content:center;font-weight:700;">✓</div>'
    +   '<div style="font-size:.95rem;line-height:1.45;">'
    +     '<div style="font-weight:600;margin-bottom:2px;">Pembayaran berhasil</div>'
    +     '<div id="payFilmNoticeMsg"></div>'
    +   '</div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
    +   '<button type="button" id="payFilmNoticeClose" style="background:transparent;border:1px solid rgba(255,255,255,.18);color:#cbd5e1;padding:7px 12px;border-radius:8px;font-size:.85rem;cursor:pointer;">Tutup</button>'
    +   '<button type="button" id="payFilmNoticeGo" style="background:#f5c518;border:0;color:#111;padding:7px 14px;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer;">Buka My Collection</button>'
    + '</div>';
  document.body.appendChild(el);
  // textContent supaya judul film aman dari XSS walau judul mengandung HTML.
  const msg = el.querySelector('#payFilmNoticeMsg');
  if(msg) msg.textContent = `Selamat, kamu telah dapat akses ${phrase}. Silahkan cek film kamu di My Collection.`;
  const closeBtn = el.querySelector('#payFilmNoticeClose');
  const goBtn = el.querySelector('#payFilmNoticeGo');
  const dismiss = () => { try{ el.remove(); }catch(_){} };
  if(closeBtn) closeBtn.addEventListener('click', dismiss);
  if(goBtn) goBtn.addEventListener('click', () => {
    dismiss();
    try{ if(typeof goPage === 'function') goPage('my-collections'); }catch(_){}
  });
  // Auto-dismiss setelah 8 detik supaya nggak nutupin UI selamanya.
  setTimeout(dismiss, 8000);
}
async function handlePaymentReturn(ref){
  if(!ref) return;
  showPaymentVerifyOverlay('Memverifikasi pembayaran...');
  // Bersihkan URL supaya reload tidak men-trigger ulang flow ini.
  try{ history.replaceState({}, '', '/'); }catch(_){}
  // Tunggu sesi auth siap (bisa kosong di tab baru).
  let token = '';
  for(let i=0;i<10;i++){
    try{ token = session?.access_token || (sb && (await sb.auth.getSession()).data.session?.access_token) || ''; }catch(_){ token = ''; }
    if(token) break;
    await new Promise(r=>setTimeout(r, 300));
  }
  if(!token){
    hidePaymentVerifyOverlay();
    showToast('Login dulu untuk konfirmasi pembayaran.', 'error');
    return;
  }
  const deadline = Date.now() + 90_000; // poll up to 90s
  let lastStatus = 'pending';
  while(Date.now() < deadline){
    try{
      const r = await fetch('/api/payments/status?ref=' + encodeURIComponent(ref), {
        headers: { Authorization: 'Bearer ' + token },
      });
      const d = await r.json().catch(()=>({}));
      if(r.ok && d.ok && d.order){
        lastStatus = String(d.order.status || '').toLowerCase();
        if(lastStatus === 'success'){
          hidePaymentVerifyOverlay();
          // Refresh profil + entitlements supaya VIP/film akses langsung kelihatan.
          try{ if(typeof onAuthSuccess === 'function' && session) await onAuthSuccess(session); }catch(_){}
          try{ if(typeof renderProfilePage === 'function') renderProfilePage(); }catch(_){}
          // Notifikasi disesuaikan: kalau order film tertentu → sebutkan nama
          // filmnya + arahkan ke My Collection. Untuk VIP / order tanpa nama
          // film spesifik, fallback ke pesan generik.
          const order = d.order || {};
          const ptype = String(order.product_type || '').toLowerCase();
          if(ptype === 'film'){
            const titles = extractOrderFilmTitles(order);
            if(titles.length){
              showPaymentSuccessFilmNotice(titles);
            } else {
              showToast('Pembayaran berhasil — akses film sudah aktif. Cek di My Collection.', 'success');
            }
          } else {
            showToast('Pembayaran berhasil — akses sudah aktif.', 'success');
          }
          return;
        }
        if(lastStatus === 'failed'){
          hidePaymentVerifyOverlay();
          showToast('Pembayaran dibatalkan / kadaluarsa.', 'error');
          return;
        }
      }
    }catch(_){ /* abaikan dan coba lagi */ }
    await new Promise(r=>setTimeout(r, 3000));
  }
  hidePaymentVerifyOverlay();
  showToast('Belum ada konfirmasi dari Violet Media Pay. Coba refresh sebentar lagi.', 'error');
}

/* ════════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════════ */
// Disimpan di scope module supaya onAuthSuccess bisa men-trigger polling
// pembayaran setelah user login fresh dari layar auth.
let __pendingPaymentRef = null;
async function bootstrap(){
  // Tangkap return-URL pembayaran sebelum apa-apa lain. Path-nya bukan
  // VALID_PAGES → kalau dibiarkan, applyRoute akan fallback ke /home dan
  // ref-nya hilang.
  __pendingPaymentRef = readPaymentReturnRef();
  if(__pendingPaymentRef){
    // Tampilkan overlay verifikasi langsung supaya user nggak lihat halaman
    // home kosong sambil kita nunggu auth + polling.
    showPaymentVerifyOverlay('Memverifikasi pembayaran...');
  }
  try{
    const r = await fetch('/api/config');
    CONFIG = await r.json();
    if(!CONFIG.ok && !CONFIG.supabase_url){ throw new Error('Config error'); }
    // Defensive cleanup: older builds stored sessions under two keys
    // ('sb-auth-external' + 'sb-auth-local'). If a stale external session
    // is sitting in localStorage from before the migration, the supabase
    // client will rehydrate it on bootstrap and the user appears "logged
    // in" to a phantom account they cannot log out of. Wipe both legacy
    // keys so we always start from a clean single-project state.
    try {
      for (const k of ['sb-auth-external', 'sb-auth-local']) {
        localStorage.removeItem(k);
      }
    } catch {}
    sb = supabase.createClient(CONFIG.supabase_url, CONFIG.supabase_anon_key, {
      auth: { storageKey: 'sb-auth', persistSession: true, autoRefreshToken: true },
    });
  }catch(e){
    console.error('Bootstrap error:', e);
    hideBootSplash();
    document.getElementById('authPage').style.display='flex';
    document.getElementById('authPage').innerHTML='<div style="text-align:center;color:#fca5a5;padding:40px;">Gagal memuat konfigurasi server. Coba refresh.</div>';
    return;
  }

  session = null;
  try { session = (await sb.auth.getSession()).data.session; } catch {}
  if(session){
    await onAuthSuccess(session);
  }else{
    showAuthPage();
  }

  sb.auth.onAuthStateChange((event)=>{
    if(event==='SIGNED_OUT'){ location.reload(); }
  });
}

function showAuthPage(){
  hideBootSplash();
  document.getElementById('authPage').style.display='flex';
  document.getElementById('app').style.display='none';
}

function showApp(){
  hideBootSplash();
  document.getElementById('authPage').style.display='none';
  document.getElementById('app').style.display='flex';
}

function hideBootSplash(){
  const el = document.getElementById('bootSplash');
  if(el) el.remove();
}

async function onAuthSuccess(authSession){
  session = authSession;
  currentUser = authSession.user;
  // Profile lives in the LOCAL supabase (films, vip flag, expired_at). When
  // the user logged in via external, the auth user_id may differ from local;
  // worker's /api/me handles cross-project lookup by email, so we always go
  // through the worker for profile data instead of querying supabase JS.
  try{
    const r = await fetch('/api/me', {
      headers: { Authorization: 'Bearer ' + session.access_token },
    });
    const d = await r.json();
    currentProfile = (d && d.profile) || null;
    currentEntitlements = (d && Array.isArray(d.entitlements)) ? d.entitlements : [];
    if(d && d.tier){ /* worker already computed tier; we recompute below for parity */ }
  }catch{ currentProfile = null; }

  // Determine tier
  if(currentProfile){
    const exp = currentProfile.expired_at ? new Date(currentProfile.expired_at) : null;
    if(exp && exp < new Date()){
      currentTier = 'expired';
      await sb.auth.signOut();
      const msg = document.getElementById('loginMsg');
      msg.textContent='Langganan kamu sudah habis. Hubungi admin untuk perpanjang.';
      msg.className='auth-msg error';
      showAuthPage();
      return;
    }
    currentTier = currentProfile.is_vip ? 'vip' : 'free';
  }else{
    currentTier = 'free';
  }

  // Update profile UI
  const email = currentUser.email || '';
  document.getElementById('profileName').textContent = email;
  document.getElementById('profileAvatar').textContent = (email[0]||'Z').toUpperCase();
  const tierEl = document.getElementById('profileTier');
  if(currentTier==='vip'){ tierEl.textContent='♛ VIP'; tierEl.className='profile-tier vip'; }
  else{ tierEl.textContent='Free'; tierEl.className='profile-tier'; }

  showApp();
  updateCartCount();
  await loadCatalog();
  // Kalau user baru saja redirect balik dari Violet Media Pay
  // (/payment/success?ref=...), trigger polling status di latar belakang.
  // handlePaymentReturn juga sudah me-replaceState('/'), jadi applyRoute
  // di bawah akan jatuh ke home seperti biasa.
  if(__pendingPaymentRef){
    const r = __pendingPaymentRef;
    __pendingPaymentRef = null;
    handlePaymentReturn(r);
  }
  // After catalog is loaded, apply whatever route is in the URL
  // (handles /movies, /tv, /film/123, etc. on initial load/reload)
  applyRoute({ fromPopState:true });
}

/* ════════════════════════════════════════════════════════════════════
   AUTH
   ════════════════════════════════════════════════════════════════════ */
function switchAuthTab(name){
  document.getElementById('authTabLogin').classList.toggle('active', name==='login');
  document.getElementById('authTabRegister').classList.toggle('active', name==='register');
  document.getElementById('loginPanel').style.display = name==='login' ? 'block' : 'none';
  document.getElementById('registerPanel').style.display = name==='register' ? 'block' : 'none';
}

function togglePasswordVisibility(inputId, button){
  const input = document.getElementById(inputId);
  if(!input || !button) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.classList.toggle('is-visible', show);
  button.setAttribute('aria-pressed', show ? 'true' : 'false');
  button.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
}

async function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const msg = document.getElementById('loginMsg');
  const btn = document.getElementById('loginBtn');

  if(!email || !pass){
    msg.textContent='Email dan password wajib diisi.';
    msg.className='auth-msg error';
    msg.style.display='block';
    return;
  }

  btn.disabled=true;btn.textContent='Memuat…';
  msg.style.display='none';
  try{
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if(error){
      msg.textContent = error.message || 'Login gagal.';
      msg.className='auth-msg error';
      msg.style.display='block';
      btn.disabled=false; btn.textContent='Masuk';
      // Notify Telegram about failed login
      fetch('/api/auth/login-notify', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ email, reason: error.message || 'Unknown' }),
      }).catch(()=>{});
      return;
    }
    await onAuthSuccess(data.session);
    notifyLoginEvent(data.session).catch(()=>{});
  }catch(e){
    msg.textContent='Error: '+e.message;
    msg.className='auth-msg error';
    msg.style.display='block';
    btn.disabled=false; btn.textContent='Masuk';
  }
}

async function notifyLoginEvent(authSession){
  const token = authSession && authSession.access_token;
  if(!token) return;
  await fetch('/api/auth/login-event', {
    method:'POST',
    headers:{ Authorization:'Bearer '+token },
  });
}

async function doRegister(){
  const email = document.getElementById('regEmail').value.trim();
  const pass = document.getElementById('regPass').value;
  const pass2 = document.getElementById('regPass2').value;
  const msg = document.getElementById('registerMsg');
  const btn = document.getElementById('registerBtn');

  msg.style.display='none';
  if(!email || !pass){
    msg.textContent='Email dan password wajib diisi.';
    msg.className='auth-msg error';
    msg.style.display='block';
    return;
  }
  if(pass.length < 6){
    msg.textContent='Password minimal 6 karakter.';
    msg.className='auth-msg error';
    msg.style.display='block';
    return;
  }
  if(pass !== pass2){
    msg.textContent='Password tidak cocok.';
    msg.className='auth-msg error';
    msg.style.display='block';
    return;
  }

  btn.disabled=true; btn.textContent='Mendaftarkan…';
  try{
    const r = await fetch('/api/auth/signup', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok){
      msg.textContent = d && (d.error || d.message) ? (d.error || d.message) : ('Gagal daftar (HTTP '+r.status+')');
      msg.className='auth-msg error';
      msg.style.display='block';
      btn.disabled=false; btn.textContent='Daftar & Masuk';
      return;
    }
    // Auto-login after successful signup.
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if(error){
      msg.textContent = 'Akun dibuat tapi auto-login gagal: ' + error.message;
      msg.className='auth-msg error';
      msg.style.display='block';
      btn.disabled=false; btn.textContent='Daftar & Masuk';
      return;
    }
    await onAuthSuccess(data.session);
  }catch(e){
    msg.textContent='Error: ' + e.message;
    msg.className='auth-msg error';
    msg.style.display='block';
    btn.disabled=false; btn.textContent='Daftar & Masuk';
  }
}

async function confirmLogout(){
  if(!confirm('Yakin mau logout?')) return;
  try { await sb.auth.signOut(); } catch {}
  // Belt-and-suspenders: nuke any stale legacy storage keys too.
  try {
    for (const k of ['sb-auth', 'sb-auth-external', 'sb-auth-local']) {
      localStorage.removeItem(k);
    }
  } catch {}
  history.replaceState(null, '', '/');
  location.reload();
}
// Backward-compat alias
const toggleLogoutConfirm = confirmLogout;

/* ════════════════════════════════════════════════════════════════════
   PROFILE PAGE
   ════════════════════════════════════════════════════════════════════ */
function renderProfilePage(){
  const email = (currentUser && currentUser.email) || '—';
  document.getElementById('profileEmail').textContent = email;
  document.getElementById('profileFullName').textContent = email.split('@')[0] || 'User';
  document.getElementById('profileAvatarLg').textContent = (email[0]||'Z').toUpperCase();

  // Joined
  const joinedAt = currentUser?.created_at ? new Date(currentUser.created_at) : null;
  document.getElementById('profileJoinedVal').textContent = joinedAt
    ? joinedAt.toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'})
    : '—';

  // Status
  const statusEl = document.getElementById('profileStatusVal');
  const vipDetailRows = ['profileJoinedVal','profileExpiredVal','profileDaysBadge'].map(id=>document.getElementById(id)?.closest('.profile-row')).filter(Boolean);
  if(currentTier==='vip'){
    statusEl.innerHTML = '<span class="expiry-badge gold">👑 VIP Member</span>';
    vipDetailRows.forEach(r=>r.style.display='');
  } else {
    statusEl.innerHTML = '<span class="expiry-badge green">Status akun free</span>';
    vipDetailRows.forEach(r=>r.style.display='none');
    return;
  }

  // Expiry
  const expiredAt = currentProfile?.expired_at ? new Date(currentProfile.expired_at) : null;
  const expiredEl = document.getElementById('profileExpiredVal');
  const badgeEl = document.getElementById('profileDaysBadge');
  const barEl = document.getElementById('profileProgressBar');

  if(!expiredAt){
    expiredEl.textContent = 'Tidak ada batas';
    badgeEl.textContent = '∞';
    badgeEl.className = 'expiry-badge green';
    barEl.style.width = '100%';
    barEl.className = 'profile-progress-bar green';
    return;
  }

  expiredEl.textContent = expiredAt.toLocaleDateString('id-ID',{year:'numeric',month:'long',day:'numeric'});
  const now = new Date();
  const msLeft = expiredAt.getTime() - now.getTime();
  const daysLeft = Math.max(0, Math.ceil(msLeft / (1000*60*60*24)));

  // Color thresholds: >14 hari ijo, 4-14 kuning, <=3 merah, 0 expired
  let color = 'green';
  if(daysLeft <= 0) color = 'red';
  else if(daysLeft <= 3) color = 'red';
  else if(daysLeft <= 14) color = 'yellow';

  badgeEl.textContent = daysLeft <= 0 ? 'Expired' : (daysLeft + ' hari lagi');
  badgeEl.className = 'expiry-badge ' + color;

  // Progress: 30 hari = full bar
  const pct = Math.min(100, Math.max(0, (daysLeft / 30) * 100));
  barEl.style.width = pct + '%';
  barEl.className = 'profile-progress-bar ' + color;
}

/* ════════════════════════════════════════════════════════════════════
   VIP PAGE
   ════════════════════════════════════════════════════════════════════ */
let _vipFilter = 'all';        // 'all' | 'movie' | 'series'
let _vipQuery = '';
let _vipGenre = 'all';
let _vipHeroTimer = null;
let _vipHeroIndex = 0;
const PAGE_ROWS = 10;
const PAGE_NUMBERS = { browse: 1, movies: 1, tv: 1, vip: 1 };
const VIP_GENRES = [
  { label: 'All', slug: 'all', genres: [], countries: [] },
  { label: 'Action', slug: 'Action', genres: ['action', 'adventure'], countries: [] },
  { label: 'Animasi', slug: 'Animasi', genres: ['animation', 'kids'], countries: [] },
  { label: 'Indonesia', slug: 'Indonesia', genres: [], countries: ['ID'] },
  { label: 'Korea', slug: 'Korea', genres: [], countries: ['KR', 'CN', 'TW'] },
  { label: 'Horror & Thriller', slug: 'Horror-Thriller', genres: ['horror', 'mystery', 'thriller'], countries: [] },
  { label: 'Drama', slug: 'Drama', genres: ['drama', 'romance'], countries: [] },
];

function vipGenreFromSlug(slug){
  const clean = decodeURIComponent(String(slug || 'all')).trim();
  return VIP_GENRES.find(g => g.slug.toLowerCase() === clean.toLowerCase()) || VIP_GENRES[0];
}

function vipGenrePathPart(){
  const g = vipGenreFromSlug(_vipGenre);
  return g.slug === 'all' ? '' : '/' + encodeURIComponent(g.slug);
}

function filmMatchesVipGenre(f, genre){
  const g = typeof genre === 'string' ? vipGenreFromSlug(genre) : genre;
  if(!g || g.slug === 'all') return true;
  const genreNames = new Set(normalizeListField(f?.tmdb_genres).map(x => x.toLowerCase()));
  const countryCodes = new Set(normalizeListField(f?.tmdb_country_codes).map(x => x.toUpperCase()));
  if(g.countries && g.countries.length){
    return g.countries.some(code => countryCodes.has(code));
  }
  if(g.genres && g.genres.length){
    return g.genres.some(name => genreNames.has(name));
  }
  return false;
}

function normalizeListField(value){
  if(Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  if(typeof value === 'string'){
    const s = value.trim();
    if(!s) return [];
    try{
      const parsed = JSON.parse(s);
      if(Array.isArray(parsed)) return parsed.map(v => String(v || '').trim()).filter(Boolean);
    }catch{}
    return s.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function gridColumnCount(gridId){
  const el = document.getElementById(gridId);
  if(!el) return window.innerWidth < 768 ? 2 : 6;
  const template = getComputedStyle(el).gridTemplateColumns || '';
  const cols = template.split(' ').filter(Boolean).length;
  if(cols) return Math.max(1, cols);
  return window.innerWidth < 560 ? 2 : (window.innerWidth < 1024 ? 3 : 6);
}

function pageSizeForGrid(gridId){
  return Math.max(1, gridColumnCount(gridId) * PAGE_ROWS);
}

function renderPagination(pageName, paginationId, totalItems, gridId){
  const el = document.getElementById(paginationId);
  if(!el) return;
  const pageSize = pageSizeForGrid(gridId);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  PAGE_NUMBERS[pageName] = Math.min(Math.max(1, PAGE_NUMBERS[pageName] || 1), totalPages);
  if(totalPages <= 1){ el.innerHTML = ''; return; }
  const current = PAGE_NUMBERS[pageName];
  const nums = [];
  const start = Math.max(1, current - 2);
  const end = Math.min(totalPages, current + 2);
  if(start > 1) nums.push(1);
  if(start > 2) nums.push('gap-start');
  for(let i=start;i<=end;i++) nums.push(i);
  if(end < totalPages - 1) nums.push('gap-end');
  if(end < totalPages) nums.push(totalPages);
  el.innerHTML = [
    `<button class="page-btn page-arrow" type="button" ${current===1?'disabled':''} data-page-num="${current-1}" aria-label="Halaman sebelumnya">&lsaquo;</button>`,
    ...nums.map(n => typeof n === 'number'
      ? `<button class="page-btn${n===current?' active':''}" type="button" data-page-num="${n}" aria-current="${n===current?'page':'false'}">${n}</button>`
      : '<span class="page-gap">...</span>'),
    `<button class="page-btn page-arrow" type="button" ${current===totalPages?'disabled':''} data-page-num="${current+1}" aria-label="Halaman berikutnya">&rsaquo;</button>`,
  ].join('');
  el.querySelectorAll('[data-page-num]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const n = Number(btn.dataset.pageNum) || 1;
      PAGE_NUMBERS[pageName] = Math.min(Math.max(1, n), totalPages);
      goPage(pageName, { page: PAGE_NUMBERS[pageName], vipGenre: _vipGenre });
    });
  });
}

function renderPagedGrid(pageName, gridId, paginationId, items, opts){
  opts = opts || {};
  const pageSize = pageSizeForGrid(gridId);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  PAGE_NUMBERS[pageName] = Math.min(Math.max(1, PAGE_NUMBERS[pageName] || 1), totalPages);
  const start = (PAGE_NUMBERS[pageName] - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  if(opts.vipStyle){
    const grid = document.getElementById(gridId);
    grid.innerHTML = pageItems.map(f=>cardHTML(f, true)).join('');
    grid.querySelectorAll('[data-film-id]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const id = el.dataset.filmId;
        const film = allFilms.find(x=>String(x.id)===String(id));
        // VIP page: every click is a VIP-context playback. VIP users get the
        // ad-free domain even when the film row itself is `tier:'free'`,
        // because the page already lists free titles for VIP convenience.
        if(film) openFilm(film, { vipMode: true });
      });
    });
  }else{
    renderGrid(gridId, pageItems);
  }
  renderPagination(pageName, paginationId, items.length, gridId);
}

function renderVipGenreRail(){
  const track = document.getElementById('vipGenreTrack');
  if(!track) return;
  const activeSlug = vipGenreFromSlug(_vipGenre).slug;
  track.innerHTML = VIP_GENRES.map(g=>`<button class="vip-genre-chip${g.slug===activeSlug?' active':''}" type="button" data-vip-genre="${escapeHtml(g.slug)}">${escapeHtml(g.label)}</button>`).join('');
  track.querySelectorAll('[data-vip-genre]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      _vipGenre = btn.dataset.vipGenre || 'all';
      PAGE_NUMBERS.vip = 1;
      renderVipGenreRail();
      goPage('vip', { page: 1, vipGenre: _vipGenre });
    });
  });
}

function filmUploadTime(f){
  const raw = f?.created_at || f?.uploaded_at || f?.updated_at || f?.modified_at || '';
  const t = raw ? Date.parse(raw) : 0;
  return Number.isFinite(t) ? t : 0;
}

function renderVipPosterStack(pool){
  const stack = document.getElementById('vipPosterStack');
  const dots = document.getElementById('vipHeroDots');
  if(!stack) return;
  if(!pool.length){
    stack.innerHTML = '';
    if(dots) dots.innerHTML = '';
    return;
  }
  const visible = [];
  const count = Math.min(5, pool.length);
  for(let i=0;i<count;i++) visible.push(pool[(_vipHeroIndex + i) % pool.length]);
  stack.innerHTML = visible.map((film, idx)=>{
    const poster = film.poster_url || film.backdrop_url || '';
    return `<div class="vip-stack-card pos-${idx}"><img src="${poster}" alt="${escapeHtml(film.judul || 'VIP poster')}" loading="lazy"></div>`;
  }).join('');
  if(dots){
    const dotCount = Math.min(5, pool.length);
    dots.innerHTML = Array.from({length:dotCount}, (_,i)=>`<span class="vip-hero-dot${i===0?' active':''}"></span>`).join('');
  }
}

function renderVipPage(){
  // VIP Zone: tampilkan film tier 'vip' (VIP saja) + 'free' (Basic + VIP) — series di-dedupe
  const vipFilms = _dedupeSeries(allFilms.filter(f=>f.tier==='vip' || f.tier==='free' || !f.tier));
  const grid = document.getElementById('vipGrid');
  const empty = document.getElementById('vipEmpty');
  const heroDesc = document.getElementById('vipHeroDesc');
  const heroFeatured = document.getElementById('vipHeroFeatured');
  const heroBg = document.getElementById('vipHeroBg');
  const heroPosters = document.getElementById('vipHeroPosters');

  // Non-VIP: tampilkan modal langsung (gak boleh akses isi halaman)
  if(currentTier!=='vip'){
    showVipLocked({page:true});
    heroDesc.innerHTML = `<strong style="color:#facc15">Halaman ini hanya untuk member VIP.</strong>`;
    if(heroFeatured) heroFeatured.style.display = 'none';
    if(heroPosters) heroPosters.style.display = 'none';
    if(heroBg){ heroBg.classList.remove('show'); heroBg.style.backgroundImage = ''; }
    renderVipPosterStack([]);
    if(_vipHeroTimer){ clearInterval(_vipHeroTimer); _vipHeroTimer = null; }
    grid.innerHTML = '';
    renderPagination('vip', 'vipPagination', 0, 'vipGrid');
    renderVipGenreRail();
    empty.style.display = 'none';
    return;
  }

  heroDesc.textContent = 'Selamat datang VIP — semua film premium sudah unlock.';

  // Hero VIP: 20 film terakhir yang diupload, tampil 5 poster, muter tiap 4 detik.
  const heroPool = vipFilms
    .filter(f => f.poster_url || f.backdrop_url)
    .sort((a, b) => {
      const byTime = filmUploadTime(b) - filmUploadTime(a);
      if(byTime) return byTime;
      const av = a.tier === 'vip' ? 0 : 1;
      const bv = b.tier === 'vip' ? 0 : 1;
      if(av !== bv) return av - bv;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    })
    .slice(0, 20);

  const renderHeroSlot = ()=>{
    if(!heroPool.length){
      if(heroFeatured) heroFeatured.style.display = 'none';
      if(heroPosters) heroPosters.style.display = 'none';
      if(heroBg){ heroBg.classList.remove('show'); heroBg.style.backgroundImage = ''; }
      renderVipPosterStack([]);
      return;
    }
    const film = heroPool[_vipHeroIndex % heroPool.length];
    const bgUrl = film.backdrop_url || film.poster_url || '';
    if(heroPosters) heroPosters.style.display = '';
    if(heroBg){
      heroBg.style.backgroundImage = bgUrl ? `url('${bgUrl}')` : '';
      heroBg.classList.toggle('show', !!bgUrl);
    }
    if(heroFeatured){
      heroFeatured.style.display = 'flex';
      document.getElementById('vipHeroFeaturedTitle').textContent = film.judul || '';
      const meta = document.getElementById('vipHeroMeta');
      if(meta){
        const type = film.tipe === 'series' ? 'TV Shows' : 'Movie';
        const parts = [type, film.tahun || '', film.rating ? `★ ${film.rating}` : ''].filter(Boolean);
        meta.textContent = parts.join(' · ');
      }
      const cta = document.getElementById('vipHeroCta');
      if(cta){
        cta.onclick = ()=>openFilm(film, { vipMode: true });
      }
    }
    renderVipPosterStack(heroPool);
  };
  renderHeroSlot();
  if(_vipHeroTimer){ clearInterval(_vipHeroTimer); _vipHeroTimer = null; }
  if(heroPool.length > 1){
    _vipHeroTimer = setInterval(()=>{
      _vipHeroIndex = (_vipHeroIndex + 1) % heroPool.length;
      renderHeroSlot();
    }, 4000);
  }

  // Cache full list for filter/search re-render without recomputing.
  document.getElementById('vipGrid')._vipFilms = vipFilms;
  renderVipGenreRail();
  applyVipFilter();
}

function applyVipFilter(){
  const grid = document.getElementById('vipGrid');
  const empty = document.getElementById('vipEmpty');
  if(!grid) return;
  const all = grid._vipFilms || [];
  const selectedGenre = vipGenreFromSlug(_vipGenre);
  const q = (_vipQuery || '').toLowerCase().trim();
  let items = all;
  if(_vipFilter === 'movie') items = items.filter(f => f.tipe !== 'series');
  else if(_vipFilter === 'series') items = items.filter(f => f.tipe === 'series');
  items = items.filter(f => filmMatchesVipGenre(f, selectedGenre));
  if(q) items = items.filter(f => (f.judul || '').toLowerCase().includes(q));
  if(!items.length){
    grid.innerHTML = '';
    renderPagination('vip', 'vipPagination', 0, 'vipGrid');
    empty.style.display = 'block';
    const genreLabel = selectedGenre.label;
    empty.querySelector('h3').textContent = q ? 'Tidak ada hasil' : (genreLabel === 'All' ? 'Belum ada film VIP' : `Belum ada koleksi ${genreLabel}`);
    empty.querySelector('p').textContent = q
      ? `Tidak ada judul yang cocok dengan "${q}".`
      : 'Admin belum menambahkan koleksi VIP. Cek lagi nanti.';
    return;
  }
  empty.style.display = 'none';
  renderPagedGrid('vip', 'vipGrid', 'vipPagination', items, { vipStyle:true });
}

function setVipFilter(filter){
  if(filter !== 'all' && filter !== 'movie' && filter !== 'series') filter = 'all';
  _vipFilter = filter;
  PAGE_NUMBERS.vip = 1;
  document.querySelectorAll('.vip-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.vipFilter === filter);
  });
  applyVipFilter();
}

function onVipSearchInput(){
  _vipQuery = document.getElementById('vipSearchInput').value || '';
  PAGE_NUMBERS.vip = 1;
  applyVipFilter();
}

function showVipLocked(opts){
  const titleEl = document.getElementById('vipLockedTitle');
  const msgEl = document.getElementById('vipLockedMsg');
  if(opts && opts.page){
    titleEl.textContent = 'VIP Zone Terkunci';
    msgEl.textContent = 'Halaman VIP Zone hanya untuk member VIP. Upgrade akun kamu untuk akses tanpa batas.';
  } else {
    titleEl.textContent = 'Film VIP';
    msgEl.textContent = 'Film ini hanya tersedia untuk member VIP. Upgrade untuk akses tanpa batas.';
  }
  document.getElementById('vipLockedModal').classList.add('show');
}
function closeVipLocked(){
  document.getElementById('vipLockedModal').classList.remove('show');
  // Kalau user di /vip dan bukan VIP, bawa balik ke home
  if(_currentPage==='vip' && currentTier!=='vip'){
    goPage('home');
  }
}

// Tombol back di profile page
function profileBack(){
  if(history.length>1){ history.back(); return; }
  goPage('home');
}

document.addEventListener('keydown',(e)=>{
  if(e.key==='Enter' && document.getElementById('authPage').style.display!=='none'){
    if(document.getElementById('loginPanel').style.display!=='none') doLogin();
  }
});

/* ════════════════════════════════════════════════════════════════════
   NAVIGATION — Clean URLs via History API
   Pages:  /, /movies, /tv, /browse, /watchlist, /search, /vip, /profile
   Film:   /film/{id}
   ════════════════════════════════════════════════════════════════════ */
const VALID_PAGES = ['home','search','browse','movies','tv','watchlist','cart','collections','my-collections','collection','orders','faq','vip','profile','payment'];
let _currentPage = 'home';

function pagePath(name, opts){
  opts = opts || {};
  if(name === 'home') return '/';
  if(name === 'payment') return '/payment/checkout';
  if(['browse','movies','tv'].includes(name)){
    const page = Math.max(1, Number(opts.page || PAGE_NUMBERS[name] || 1));
    return '/' + name + (page > 1 ? '/page/' + page : '');
  }
  if(name === 'vip'){
    const page = Math.max(1, Number(opts.page || PAGE_NUMBERS.vip || 1));
    const genre = opts.vipGenre || _vipGenre || 'all';
    const g = vipGenreFromSlug(genre);
    const base = '/vip' + (g.slug === 'all' ? '' : '/' + encodeURIComponent(g.slug));
    return base + (page > 1 ? '/page/' + page : '');
  }
  return '/' + name;
}

function goPage(name, opts){
  opts = opts || {};
  if(!VALID_PAGES.includes(name)) name = 'home';
  _currentPage = name;
  if(['browse','movies','tv','vip'].includes(name)){
    PAGE_NUMBERS[name] = Math.max(1, Number(opts.page || PAGE_NUMBERS[name] || 1));
  }
  if(name === 'vip'){
    _vipGenre = vipGenreFromSlug(opts.vipGenre || _vipGenre || 'all').slug;
  }
  // If player modal is open, close it first so the user can see the page
  const pm = document.getElementById('playerModal');
  if(pm && pm.classList.contains('open') && !opts.fromPopState){
    closePlayer({ skipHistoryBack:true });
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(n=>n.classList.toggle('active', n.dataset.page===name));
  document.querySelectorAll('.bottom-item[data-page]').forEach(n=>n.classList.toggle('active', n.dataset.page===name));
  const el = document.getElementById('page-'+name);
  if(el) el.classList.add('active');
  closeSidebar();
  // page render hooks
  if(name==='movies') renderMoviesPage();
  if(name==='tv') renderTvPage();
  if(name==='browse') renderBrowsePage();
  if(name==='watchlist') renderWatchlistPage();
  if(name==='cart') renderCartPage();
  if(name==='collections') renderCollectionsBrowsePage();
  if(name==='my-collections') renderMyCollectionsPage();
  if(name==='orders') renderOrdersPage();
  if(name==='search') renderSearchInitial();
  if(name==='vip') renderVipPage();
  if(name==='profile') renderProfilePage();
  if(name==='payment') renderPaymentCheckoutPage();

  // Update URL via History API (clean path, no hash)
  if(!opts.fromPopState){
    const target = pagePath(name, opts);
    if(location.pathname !== target){
      history.pushState({ kind:'page', name, page: PAGE_NUMBERS[name], vipGenre: _vipGenre }, '', target);
    }
  }
  // The mobile topbar used to show the current page URL (breadcrumb);
  // it's been replaced by the ZAEINSTREAM wordmark, so there's nothing
  // to update here anymore.

  window.scrollTo({top:0});
}

// Resolve film by id — handle numeric DB id (preferred) or tmdb_id
function findFilmByRouteId(id){
  if(!id) return null;
  const sid = String(id);
  return allFilms.find(f => String(f.id)===sid)
      || allFilms.find(f => String(f.tmdb_id)===sid)
      || null;
}

// Parse pathname -> route object
function parseRoute(){
  const p = (location.pathname || '/').replace(/\/+$/,'') || '/';
  if(p === '' || p === '/') return { kind:'page', name:'home' };

  const parts = p.split('/').filter(Boolean);

  // VIP route:
  // /film/vip/159
  if(parts[0] === 'film' && parts[1] === 'vip' && parts[2]){
    return { kind:'film', id: parts[2], vipMode: true };
  }

  // Basic route:
  // /film/159
  if(parts[0] === 'film' && parts[1]){
    return { kind:'film', id: parts[1], vipMode: false };
  }

  // Collection detail route:
  // /collection/123
  if(parts[0] === 'collection' && parts[1]){
    return { kind:'collection', id: parts[1] };
  }

  // Payment checkout route:
  // /payment/checkout?ref=...
  if(parts[0] === 'payment' && (parts[1] === 'checkout' || !parts[1])){
    return { kind:'page', name:'payment' };
  }
  // Payment success return route (VMP redirect) ditangani oleh
  // handlePaymentReturn() dan setelah itu URL akan di-replace ke '/'.
  // Supaya tidak nyasar ke page "payment", fallback-kan ke home.
  if(parts[0] === 'payment' && parts[1] === 'success'){
    return { kind:'page', name:'home' };
  }

  if(['browse','movies','tv'].includes(parts[0])){
    const page = parts[1] === 'page' ? Math.max(1, Number(parts[2] || 1)) : 1;
    return { kind:'page', name: parts[0], page };
  }

  if(parts[0] === 'vip'){
    let page = 1;
    let vipGenre = 'all';
    if(parts[1] === 'page'){
      page = Math.max(1, Number(parts[2] || 1));
    }else if(parts[1]){
      vipGenre = vipGenreFromSlug(parts[1]).slug;
      if(parts[2] === 'page') page = Math.max(1, Number(parts[3] || 1));
    }
    return { kind:'page', name:'vip', page, vipGenre };
  }

  if(VALID_PAGES.includes(parts[0])){
    return { kind:'page', name: parts[0] };
  }

  return { kind:'page', name: 'home' };
}

// Apply a route (on initial load or on popstate)
function applyRoute(opts){
  opts = opts || {};
  const r = parseRoute();
  if(r.kind === 'film'){
  const f = findFilmByRouteId(r.id);
  if(f){
    // Direct hit ke /film/vip/:id → tetap buka VIP page di belakang modal
    // (jangan gate ke `f.tier === 'vip'`; VIP user juga buka film free
    // dari halaman VIP via domain ad-free).
    goPage(r.vipMode ? 'vip' : 'home', { fromPopState:true });

    openFilm(f, {
      fromPopState: true,
      vipMode: !!r.vipMode,
    });
  } else {
    goPage('home', { fromPopState:true });
  }
} else if(r.kind === 'collection'){
    goPage('collection', { fromPopState:true });
    loadCollectionDetail(r.id);
  } else {
    // Close player if open (e.g., back button from /film/X → /something)
    const pm = document.getElementById('playerModal');
    if(pm && pm.classList.contains('open')){ closePlayer({ fromPopState:true }); }
    goPage(r.name, { fromPopState:true, page: r.page, vipGenre: r.vipGenre });
  }
}

window.addEventListener('popstate', ()=>applyRoute({ fromPopState:true }));

// Legacy hash-link support: if user arrives with /#/movies, migrate to /movies
(function migrateLegacyHash(){
  const h = location.hash || '';
  if(h.startsWith('#/') || h.startsWith('#!')){
    const name = h.replace(/^#\/?!?/,'').split('/')[0].toLowerCase();
    if(VALID_PAGES.includes(name)){
      history.replaceState({ kind:'page', name }, '', pagePath(name));
    } else {
      history.replaceState({ kind:'page', name:'home' }, '', '/');
    }
  }
})();

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
  // keep the tornado hamburger checkbox in sync when sidebar is opened
  // via another control (e.g. the "More" item in the bottom nav).
  const cb = document.getElementById('checkbox');
  if(cb && !cb.checked) cb.checked = true;
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
  const cb = document.getElementById('checkbox');
  if(cb && cb.checked) cb.checked = false;
}
// Bound directly to the hamburger checkbox change event so the tornado
// animation drives the drawer (instead of click->state->click->state).
function toggleSidebar(open){
  if(open) openSidebar(); else closeSidebar();
}

// ── Mobile "More" bottom sheet (replaces sidebar drawer on mobile) ──
function openMoreSheet(){
  const sheet = document.getElementById('moreSheet');
  const overlay = document.getElementById('moreSheetOverlay');
  if(sheet) sheet.classList.add('show');
  if(overlay) overlay.classList.add('show');
}
function closeMoreSheet(){
  const sheet = document.getElementById('moreSheet');
  const overlay = document.getElementById('moreSheetOverlay');
  if(sheet) sheet.classList.remove('show');
  if(overlay) overlay.classList.remove('show');
}
function toggleMoreSheet(){
  const sheet = document.getElementById('moreSheet');
  if(sheet && sheet.classList.contains('show')) closeMoreSheet();
  else openMoreSheet();
}

// ── Swipe-down to close bottom sheet (drag handle or anywhere on header)
//    User taps the small horizontal pill near the top of the sheet, drags
//    down → sheet follows the finger; release past 90px → close, else
//    snap back. Implements native iOS-style behavior on Android/iPhone.
(function attachSheetDragGesture(){
  let startY = 0;
  let currentY = 0;
  let dragging = false;
  let sheet = null;
  const SHEET_BG_TRANSITION = 'transform .32s cubic-bezier(.4,0,.2,1)';

  function onTouchStart(e){
    sheet = document.getElementById('moreSheet');
    if(!sheet || !sheet.classList.contains('show')) return;
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY;
    currentY = startY;
    dragging = true;
    sheet.style.transition = 'none'; // disable spring during drag
  }

  function onTouchMove(e){
    if(!dragging || !sheet) return;
    const t = e.touches ? e.touches[0] : e;
    currentY = t.clientY;
    const dy = Math.max(0, currentY - startY); // only allow downward
    sheet.style.transform = `translateY(${dy}px)`;
    // Fade overlay too proportionally
    const overlay = document.getElementById('moreSheetOverlay');
    if(overlay){
      const fade = Math.max(0.2, 1 - dy / 300);
      overlay.style.opacity = fade;
    }
    if(e.cancelable) e.preventDefault();
  }

  function onTouchEnd(){
    if(!dragging || !sheet) return;
    dragging = false;
    const dy = Math.max(0, currentY - startY);
    sheet.style.transition = SHEET_BG_TRANSITION;
    const overlay = document.getElementById('moreSheetOverlay');
    if(dy > 90){
      // close
      sheet.style.transform = 'translateY(100%)';
      if(overlay) overlay.style.opacity = '';
      // After animation ends, remove .show so CSS reset kicks in.
      setTimeout(() => {
        closeMoreSheet();
        sheet.style.transform = '';
        sheet.style.transition = '';
      }, 320);
    } else {
      // snap back
      sheet.style.transform = '';
      if(overlay) overlay.style.opacity = '';
      setTimeout(() => { sheet.style.transition = ''; }, 320);
    }
  }

  function bindHandle(){
    const handle = document.getElementById('moreSheetDragHandle');
    if(!handle || handle.dataset.bound) return;
    handle.dataset.bound = '1';
    handle.addEventListener('touchstart', onTouchStart, { passive: false });
    handle.addEventListener('touchmove', onTouchMove, { passive: false });
    handle.addEventListener('touchend', onTouchEnd);
    handle.addEventListener('touchcancel', onTouchEnd);
    // Mouse fallback for testing on desktop dev tools
    handle.addEventListener('mousedown', (e) => {
      onTouchStart(e);
      const onMove = (ev) => onTouchMove(ev);
      const onUp = () => {
        onTouchEnd();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindHandle);
  } else {
    bindHandle();
  }
})();

// ── Mobile row arrows: scroll a tmdb-rail horizontally by ~2 cards ──
function scrollRail(id, dir){
  const el = document.getElementById(id);
  if(!el) return;
  const card = el.querySelector('.card');
  const cardW = card ? card.offsetWidth : 120;
  const gap = 10;
  el.scrollBy({ left: dir * (cardW + gap) * 2, behavior: 'smooth' });
}

// ── Theme toggle (sun/moon) ──────────────────────────────────────────
// Sync the <input type="checkbox"> state on every theme toggle in the
// DOM (sidebar + any future mirror) so they all flip together. Persist
// to localStorage so it survives reloads.
function applyTheme(mode){
  const html = document.documentElement;
  if(mode === 'light'){
    html.setAttribute('data-theme', 'light');
  } else {
    html.removeAttribute('data-theme');
  }
  // Match the iOS/Android browser chrome to the active theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', mode === 'light' ? '#ffffff' : '#0a0a0f');
  // Reflect into every theme toggle input (mobile drawer + sidebar).
  document.querySelectorAll('.themeToggleInput').forEach(el => {
    el.checked = (mode === 'light');
  });
  try{ localStorage.setItem('zaein.theme', mode); }catch{}
}
function toggleTheme(){
  const curr = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(curr === 'light' ? 'dark' : 'light');
}
(function initTheme(){
  let saved = null;
  try{ saved = localStorage.getItem('zaein.theme'); }catch{}
  applyTheme(saved === 'light' ? 'light' : 'dark');
})();

// ── Sidebar collapse (desktop) ──
function toggleSidebarCollapse(){
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  try{ localStorage.setItem('ui.sidebar.collapsed', collapsed ? '1' : '0'); }catch{}
}
// Restore on load
(function restoreSidebarState(){
  try{
    if(localStorage.getItem('ui.sidebar.collapsed') === '1'){
      document.getElementById('sidebar')?.classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
    }
  }catch{}
})();

/* ════════════════════════════════════════════════════════════════════
   CATALOG (films)
   ════════════════════════════════════════════════════════════════════ */
async function loadCatalog(){
  // Skeleton
  ['trendingMoviesGrid','trendingShowsGrid','topMoviesGrid','topShowsGrid'].forEach(id=>{
    const g=document.getElementById(id);
    if(!g) return;
    g.innerHTML='';
    for(let i=0;i<8;i++){
      const c=document.createElement('div');
      c.innerHTML='<div class="card-poster skeleton"></div><div class="card-meta"><span></span><span></span></div><div class="card-title">&nbsp;</div>';
      g.appendChild(c);
    }
  });

  try{
    const session = (await sb.auth.getSession()).data.session;
    const r = await fetch('/api/catalog', {
      headers: session ? { Authorization: 'Bearer '+session.access_token } : {},
    });
    const data = await r.json();
    if(!data.ok){ throw new Error(data.error||'Gagal'); }
    allFilms = data.films || [];
  }catch(e){
    console.error(e);
    allFilms = [];
    showToast('Gagal memuat katalog: '+e.message, 'error');
  }

  // Enrich poster from TMDB if missing
  await enrichTmdbPosters();
  await loadTmdbHome();

  renderHome();
}

async function loadTmdbHome(){
  try{
    const r = await fetch('/api/tmdb/home');
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || 'Gagal memuat TMDB home');
    tmdbHome = { hero: d.hero || [], rows: d.rows || {} };
  }catch(e){
    console.warn('[tmdb-home]', e);
    tmdbHome = { hero: [], rows: {} };
  }
}

async function enrichTmdbPosters(){
  const IMG = CONFIG.tmdb_image_base || 'https://image.tmdb.org/t/p/w500';
  const BACKDROP = IMG.replace('w500','w1280');
  allFilms.forEach(f=>{
    if(!f.poster_url && f.tmdb_poster_path) f.poster_url = IMG + f.tmdb_poster_path;
    if(!f.backdrop_url && f.tmdb_backdrop_path) f.backdrop_url = BACKDROP + f.tmdb_backdrop_path;
    if(!f.logo_url && f.tmdb_logo_path) f.logo_url = IMG + f.tmdb_logo_path;
  });
}

/* ════════════════════════════════════════════════════════════════════
   RENDER PAGES
   ════════════════════════════════════════════════════════════════════ */
// Filter yang pas untuk halaman utama (Home/Movies/TV/Trending/Browse):
// tampilkan film tier 'free' (Basic+VIP) dan 'basic' (Basic saja).
// Film 'vip' hanya muncul di VIP Zone.
function _mainGridFilter(f){ return f.tier !== 'vip'; }

// Dedupe series: 1 row per series (pakai film dengan episode terkecil sebagai cover).
// Kalau bukan series, biarkan apa adanya.
function _dedupeSeries(items){
  const seen = new Map(); // judul → film
  const out = [];
  for(const f of items){
    if(f.tipe === 'series' && f.judul){
      const prev = seen.get(f.judul);
      if(!prev){
        seen.set(f.judul, f);
        out.push(f);
      } else {
        // Pilih episode terkecil sebagai cover (S01E01)
        const prevEp = (prev.season||1)*1000 + (prev.episode||0);
        const curEp = (f.season||1)*1000 + (f.episode||0);
        if(curEp < prevEp){
          // Replace di out array
          const idx = out.indexOf(prev);
          if(idx >= 0) out[idx] = f;
          seen.set(f.judul, f);
        }
      }
    } else {
      out.push(f);
    }
  }
  return out;
}

function renderHome(){
  const mainFilms = _dedupeSeries(allFilms.filter(_mainGridFilter));

  const heroItems = (tmdbHome.hero && tmdbHome.hero.length) ? tmdbHome.hero : mainFilms.filter(f=>f.backdrop_url).slice(0,10);
  const heroFilm = heroItems[heroSlideIndex % Math.max(1, heroItems.length)] || allFilms.find(f=>f.backdrop_url) || allFilms[0];
  if(heroFilm){
    renderHeroSlide(heroFilm);
  }
  if(heroSlideTimer) clearInterval(heroSlideTimer);
  if(heroItems.length > 1){
    heroSlideTimer = setInterval(()=>{
      heroSlideIndex = (heroSlideIndex + 1) % heroItems.length;
      renderHeroSlide(heroItems[heroSlideIndex]);
    }, 6500);
  }

  renderContinueWatching();
  renderTmdbGrid('trendingMoviesGrid', tmdbHome.rows.trending_movies || []);
  renderTmdbGrid('trendingShowsGrid', tmdbHome.rows.trending_shows || []);
  renderTmdbGrid('topMoviesGrid', tmdbHome.rows.top_movies || []);
  renderTmdbGrid('topShowsGrid', tmdbHome.rows.top_shows || []);
}

function renderHeroSlide(heroFilm){
  const hero = document.getElementById('hero');
  const heroBg = document.getElementById('heroBg');
  const heroTitle = document.getElementById('heroTitle');
  hero.classList.remove('is-animated');
  heroBg.style.backgroundImage = heroFilm.backdrop_url ? `url('${heroFilm.backdrop_url}')` : (heroFilm.poster_url ? `url('${heroFilm.poster_url}')` : '');
  if(heroFilm.logo_url){
    heroTitle.innerHTML = `<img class="hero-logo-img" src="${escapeHtml(heroFilm.logo_url)}" alt="${escapeHtml(heroFilm.judul||'ZAEINSTREAM')}">`;
  }else{
    heroTitle.innerHTML = `<span class="hero-title-text">${escapeHtml(heroFilm.judul || 'ZAEINSTREAM')}</span>`;
  }
  document.getElementById('heroDesc').textContent = (heroFilm.overview||'').slice(0,170) || 'Platform streaming eksklusif.';
  hero._film = heroFilm;
  void hero.offsetWidth;
  requestAnimationFrame(()=>hero.classList.add('is-animated'));
}

/* ════════════════════════════════════════════════════════════════════
   CONTINUE WATCHING
   ════════════════════════════════════════════════════════════════════ */
const CW_KEY = 'zaein_continue_watching';

function getContinueWatching(){
  try{ return JSON.parse(localStorage.getItem(CW_KEY)||'[]'); }catch{ return []; }
}
function saveContinueWatching(list){
  // Sort by lastWatched desc, max 12 entries
  list.sort((a,b)=>(b.lastWatched||0)-(a.lastWatched||0));
  localStorage.setItem(CW_KEY, JSON.stringify(list.slice(0,12)));
}
function upsertContinueWatching(filmId, currentTime, duration){
  if(!filmId || !duration || currentTime<5) return; // skip jika baru mulai
  const progress = Math.min(0.99, currentTime/duration);
  if(progress > 0.95) return removeContinueWatching(filmId); // hampir selesai → hapus
  const list = getContinueWatching();
  const idx = list.findIndex(x=>String(x.id)===String(filmId));
  const entry = { id: filmId, position: currentTime, duration, progress, lastWatched: Date.now() };
  if(idx>=0) list[idx]=entry; else list.push(entry);
  saveContinueWatching(list);
}

// Iframe player (player4me) is cross-origin so we can't read currentTime.
// Instead, mark the film as "in progress" the moment it's opened: progress
// stays at a fake low value but the entry shows up in Continue Watching so
// the user can re-open it from home. Caller should pass the LOCAL film id.
let _hostCwTimer = null;
function markFilmOpenedForCw(filmId){
  if(!filmId) return;
  const list = getContinueWatching();
  const sid = String(filmId);
  const idx = list.findIndex(x=>String(x.id)===sid);
  // If we already have a real progress entry from a non-iframe engine, keep it.
  if(idx >= 0 && list[idx].duration && list[idx].position > 5){
    list[idx].lastWatched = Date.now();
  } else {
    // Synthesised entry — duration unknown. Use a tiny non-zero progress so
    // the bar shows something. Real engines will overwrite this if/when the
    // user moves to a multitrack/Vidstack-backed film.
    const entry = idx>=0 ? list[idx] : { id: sid };
    entry.position = entry.position || 1;
    entry.duration = entry.duration || 0;
    entry.progress = entry.progress || 0.01;
    entry.lastWatched = Date.now();
    if(idx >= 0) list[idx] = entry; else list.push(entry);
  }
  saveContinueWatching(list);
}
function removeContinueWatching(filmId){
  const list = getContinueWatching().filter(x=>String(x.id)!==String(filmId));
  localStorage.setItem(CW_KEY, JSON.stringify(list));
  renderContinueWatching();
  showToast('Dihapus dari Continue Watching');
}
function renderContinueWatching(){
  const row = document.getElementById('continueWatchingRow');
  const grid = document.getElementById('continueWatchingGrid');
  if(!row || !grid) return;
  const list = getContinueWatching();
  const items = list.map(cw=>{
    const film = allFilms.find(f=>String(f.id)===String(cw.id));
    return film ? { film, cw } : null;
  }).filter(Boolean);
  if(!items.length){ row.style.display='none'; return; }
  row.style.display='block';
  grid.innerHTML = items.map(({film,cw})=>cardHTML(film, false, { cw })).join('');
  grid.querySelectorAll('[data-film-id]').forEach(el=>{
    el.addEventListener('click', ev=>{
      if(ev.target.closest('[data-cw-delete]')) return;
      const id=el.dataset.filmId;
      const film=allFilms.find(x=>String(x.id)===String(id));
      if(film) openFilm(film, { resumeFrom: list.find(x=>String(x.id)===String(id))?.position||0 });
    });
  });
}

function renderGrid(id, items){
  const g=document.getElementById(id);
  if(!g) return;
  if(!items.length){
    g.innerHTML='<div class="empty-state" style="grid-column:1/-1;"><div class="emoji">🎬</div><h3>Belum ada film</h3><p>Admin belum menambahkan film. Hubungi admin.</p></div>';
    return;
  }
  g.innerHTML = items.map(f=>cardHTML(f)).join('');
  // Click handlers
  g.querySelectorAll('[data-film-id]').forEach(el=>{
    el.addEventListener('click',()=>{
      const id=el.dataset.filmId;
      const film = allFilms.find(x=>String(x.id)===String(id));
      if(film) openFilm(film);
    });
  });
}

function renderTmdbGrid(id, items){
  const g=document.getElementById(id);
  if(!g) return;
  if(!items.length){
    g.innerHTML='<div class="empty-state" style="min-width:260px;"><div class="emoji">🎬</div><h3>TMDB kosong</h3><p>Coba refresh lagi nanti.</p></div>';
    return;
  }
  g.innerHTML = items.slice(0,20).map(f=>cardHTML(f, false, { tmdb:true })).join('');
  g.querySelectorAll('[data-film-id]').forEach(el=>{
    el.addEventListener('click',()=>{
      const localId = el.dataset.localId;
      if(localId){
        const film = allFilms.find(x=>String(x.id)===String(localId));
        if(film) return openFilm(film);
      }
      // Card has no local catalog match — silently do nothing.
      // The inline "Belum ada di katalog" badge under the card already
      // tells the user the film isn't available; no toast required.
    });
  });
}

function lucideStarIcon(low){
  return `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.751a.53.53 0 0 1 .294.904l-3.738 3.644a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.77.56l-4.62-2.428a2.12 2.12 0 0 0-1.973 0L6.39 21.01a.53.53 0 0 1-.77-.56l.882-5.14a2.12 2.12 0 0 0-.611-1.878L2.154 9.79a.53.53 0 0 1 .294-.904l5.166-.751a2.12 2.12 0 0 0 1.595-1.16z"/></svg>`;
}

function lucideTrashIcon(){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
}

function cardHTML(f, vipStyle, opts){
  opts = opts || {};
  const poster = f.poster_url || '';
  const year = f.tahun || '—';
  const type = (f.tipe==='series'?'TV':'MOVIE');
  const lowRating = Number(f.rating || 0) < 7;
  const rating = f.rating ? `<div class="rating-badge${lowRating?' low':''}">${lucideStarIcon(lowRating)}${f.rating}</div>` : '';
  const tier = (f.tier==='vip') ? '<div class="tier-badge">👑 VIP</div>' : '';
  const cls = 'card' + (vipStyle ? ' vip-card' : '');
  const idAttr = opts.tmdb ? `data-film-id="${escapeHtml(f.id)}" data-local-id="${f.local_id ? escapeHtml(f.local_id) : ''}"` : `data-film-id="${f.id}"`;
  const posterHTML = poster
    ? `<img src="${poster}" loading="lazy" alt="${escapeHtml(f.judul||'')}"/>`
    : '';
  const placeholder = poster ? '' : `<div class="card-poster-placeholder">${escapeHtml(f.judul||'No image')}</div>`;
  const cwDelete = opts.cw ? `<button class="card-cw-delete show" data-cw-delete="${f.id}" aria-label="Hapus dari Continue Watching" onclick="event.stopPropagation();removeContinueWatching('${f.id}');">${lucideTrashIcon()}</button>` : '';
  const progressPct = (opts.cw && opts.cw.progress) ? Math.min(100, Math.max(2, opts.cw.progress*100)) : 0;
  const progress = progressPct ? `<div class="card-progress-bar"><span style="width:${progressPct}%"></span></div>` : '';
  const tmdbNote = opts.tmdb && !f.is_available ? '<div class="tmdb-locked-note">Belum ada di katalog</div>' : '';
  // Watchlist toggle (top-right corner, inside the poster).
  // Persist against the LOCAL catalog id when one exists (TMDB tiles include
  // local_id). Without that, clicking "+" on a TMDB-rendered card would write
  // a tmdb-* id that the watchlist page (which iterates allFilms) couldn't
  // match. TMDB tiles with no local match get no button at all.
  let wlBtn = '';
  const wlId = opts.tmdb ? (f.local_id || '') : f.id;
  if(wlId){
    const inList = isInWatchlist(wlId);
    const wlIcon = inList
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    wlBtn = `<button class="card-wl-btn${inList?' in-list':''}" data-wl-toggle="${escapeHtml(wlId)}" aria-label="${inList?'Edit watchlist status':'Add to watchlist'}" onclick="event.stopPropagation();openWatchlistMenu('${escapeHtml(wlId)}', this);">${wlIcon}</button>`;
  }
  return `
    <div class="${cls}" ${idAttr} tabindex="0">
      <div class="card-poster">
        ${cwDelete}${rating}${tier}${wlBtn}
        <div class="type-badge">${type}</div>
        ${posterHTML}${placeholder}
        <div class="card-play-overlay"><div class="play-circle"></div></div>
        ${progress}
      </div>
      <div class="card-meta"><span>${type}</span><span>${year}</span></div>
      <div class="card-title">${escapeHtml(f.judul||'')}</div>
      ${tmdbNote}
    </div>
  `;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function rowScroll(id, dir){
  const el=document.getElementById(id);
  if(!el) return;
  el.scrollBy({left:dir*(el.clientWidth*.8), behavior:'smooth'});
}

function renderMoviesPage(){
  const q=(document.getElementById('moviesSearchInput')?.value||'').toLowerCase().trim();
  let items = _dedupeSeries(allFilms.filter(f=>f.tipe!=='series' && _mainGridFilter(f)));
  if(q) items = items.filter(f=>(f.judul||'').toLowerCase().includes(q));
  renderPagedGrid('movies', 'moviesPageGrid', 'moviesPagination', items);
}
function renderTvPage(){
  const q=(document.getElementById('tvSearchInput')?.value||'').toLowerCase().trim();
  let arr = _dedupeSeries(allFilms.filter(f=>f.tipe==='series' && _mainGridFilter(f)));
  if(q) arr = arr.filter(f=>(f.judul||'').toLowerCase().includes(q));
  renderPagedGrid('tv', 'tvPageGrid', 'tvPagination', arr);
}
function renderBrowsePage(){
  // Browse tampilkan semua kecuali film VIP-only (yang khusus di VIP Zone)
  renderPagedGrid('browse', 'browseGrid', 'browsePagination', _dedupeSeries(allFilms.filter(_mainGridFilter)));
}
function renderWatchlistPage(){
  // Read user-selected filters (defaults to "all"/"all")
  const statusFilter = (document.querySelector('.wl-status-tab.active')?.dataset.status) || 'all';
  const typeFilter = (document.querySelector('.wl-type-tab.active')?.dataset.type) || 'all';

  let entries = Object.entries(watchlist).map(([id, meta]) => ({
    id, status: (meta && meta.status) || 'plan', addedAt: (meta && meta.addedAt) || 0
  }));
  if(statusFilter !== 'all') entries = entries.filter(e => e.status === statusFilter);

  let items = entries
    .map(e => {
      const film = allFilms.find(f => String(f.id) === String(e.id));
      return film ? { ...film, _wlStatus: e.status, _wlAddedAt: e.addedAt } : null;
    })
    .filter(Boolean);

  if(typeFilter === 'movie') items = items.filter(f => f.tipe !== 'series');
  if(typeFilter === 'tv') items = items.filter(f => f.tipe === 'series');

  items = _dedupeSeries(items);
  items.sort((a, b) => (b._wlAddedAt || 0) - (a._wlAddedAt || 0));

  const grid = document.getElementById('watchlistGrid');
  const empty = document.getElementById('watchlistEmpty');
  if(!items.length){
    grid.innerHTML = '';
    empty.style.display = 'block';
  }else{
    empty.style.display = 'none';
    renderGrid('watchlistGrid', items);
  }
}

// Filter tab handlers (called from inline onclick in index.html)
function setWlStatusFilter(status){
  document.querySelectorAll('.wl-status-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.status === status);
  });
  renderWatchlistPage();
}
function setWlTypeFilter(type){
  document.querySelectorAll('.wl-type-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  renderWatchlistPage();
}
function renderSearchInitial(){
  document.getElementById('searchTitle').textContent='Trending Now';
  renderGrid('searchGrid', _dedupeSeries(allFilms).slice(0,28));
}
function onSearchInput(){
  const q=(document.getElementById('searchInput')?.value||'').toLowerCase().trim();
  const type=(document.getElementById('searchType')?.value||'all');
  let items=_dedupeSeries(allFilms);
  if(type==='movie') items=items.filter(f=>f.tipe!=='series');
  if(type==='series') items=items.filter(f=>f.tipe==='series');
  if(q){
    items=items.filter(f=>(f.judul||'').toLowerCase().includes(q));
    document.getElementById('searchTitle').textContent='Hasil pencarian';
  }else{
    document.getElementById('searchTitle').textContent='Trending Now';
  }
  renderGrid('searchGrid', items);
}

/* ════════════════════════════════════════════════════════════════════
   HERO actions
   ════════════════════════════════════════════════════════════════════ */
function heroPlay(){
  const f=document.getElementById('hero')._film;
  if(!f) return;
  const film = f.local_id ? allFilms.find(x=>String(x.id)===String(f.local_id)) : f;
  if(film && !film.source) openFilm(film);
  // else: hero film isn't in the local catalog — silently do nothing.
}
function heroAddWatchlist(){
  const f=document.getElementById('hero')._film;
  const film = f && f.local_id ? allFilms.find(x=>String(x.id)===String(f.local_id)) : f;
  if(film && !film.source) toggleWatchlist(film.id);
  // else: same as heroPlay — silently do nothing.
}

/* ════════════════════════════════════════════════════════════════════
   WATCHLIST
   Storage: { id: { status, addedAt } } in localStorage 'zaein_watchlist'.
   ════════════════════════════════════════════════════════════════════ */
function isInWatchlist(id){
  return !!watchlist[String(id)];
}
function getWatchlistStatus(id){
  const e = watchlist[String(id)];
  return e ? e.status : null;
}
function setWatchlistStatus(id, status){
  if(!WL_STATUSES.includes(status)) return;
  const sid = String(id);
  const existed = !!watchlist[sid];
  watchlist[sid] = { status, addedAt: existed ? watchlist[sid].addedAt : Date.now() };
  try{ localStorage.setItem('zaein_watchlist', JSON.stringify(watchlist)); }catch{}
  showToast(existed ? 'Status diubah ke ' + WL_STATUS_LABELS[status] : 'Ditambahkan ke ' + WL_STATUS_LABELS[status], 'success');
  refreshAllWatchlistIcons();
  if(document.getElementById('page-watchlist')?.classList.contains('active')) renderWatchlistPage();
}
function removeFromWatchlist(id){
  const sid = String(id);
  if(!watchlist[sid]) return;
  delete watchlist[sid];
  try{ localStorage.setItem('zaein_watchlist', JSON.stringify(watchlist)); }catch{}
  showToast('Dihapus dari watchlist');
  refreshAllWatchlistIcons();
  if(document.getElementById('page-watchlist')?.classList.contains('active')) renderWatchlistPage();
}
const WL_STATUS_LABELS = {
  plan:     'Plan to Watch',
  watching: 'Watching',
  onhold:   'On Hold',
  finished: 'Finished',
  dropped:  'Dropped',
};
// Lucide-style stroke icons rendered inline in the menu.
const WL_STATUS_ICONS = {
  plan:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  watching: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  onhold:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="4" x2="6" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/></svg>',
  finished: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  dropped:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};
const WL_FULL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>';

// Open the popup that lets the user pick a status. The first row is
// "Get Full Access" which routes to the buy flow (cart + buy-now).
function openWatchlistMenu(filmId, anchorEl){
  closeWatchlistMenu();
  const film = allFilms.find(f => String(f.id) === String(filmId));
  if(!film) return;
  const current = getWatchlistStatus(filmId);

  const menu = document.createElement('div');
  menu.className = 'wl-menu';
  menu.id = 'wlMenu';
  menu.innerHTML = `
    <button class="wl-menu-item wl-menu-full" type="button" data-act="full">
      ${WL_FULL_ICON}<span>Get Full Access</span>
    </button>
    <div class="wl-menu-divider"></div>
    ${WL_STATUSES.map(s => `
      <button class="wl-menu-item${current === s ? ' active' : ''}" type="button" data-act="status" data-status="${s}">
        ${WL_STATUS_ICONS[s]}<span>${WL_STATUS_LABELS[s]}</span>
      </button>
    `).join('')}
    ${current ? `<div class="wl-menu-divider"></div>
      <button class="wl-menu-item wl-menu-remove" type="button" data-act="remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
        <span>Remove from list</span>
      </button>` : ''}
  `;
  document.body.appendChild(menu);

  // Position near the anchor (clipped to viewport).
  const r = anchorEl.getBoundingClientRect();
  const mw = 220, mh = menu.offsetHeight || 240;
  let left = r.right + 6;
  let top = r.top;
  if(left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 6);
  if(top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  menu.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if(!btn) return;
    ev.stopPropagation();
    const act = btn.dataset.act;
    if(act === 'full'){
      closeWatchlistMenu();
      try{ openAccessModal(film); }catch{ showToast('Buka detail film dulu untuk beli akses', 'error'); }
    } else if(act === 'status'){
      setWatchlistStatus(filmId, btn.dataset.status);
      closeWatchlistMenu();
    } else if(act === 'remove'){
      removeFromWatchlist(filmId);
      closeWatchlistMenu();
    }
  });

  // Close on outside click / esc / scroll.
  setTimeout(() => {
    document.addEventListener('click', _wlMenuOutside, true);
    document.addEventListener('keydown', _wlMenuEsc, true);
    window.addEventListener('scroll', closeWatchlistMenu, true);
  }, 0);
}
function _wlMenuOutside(ev){
  const menu = document.getElementById('wlMenu');
  if(menu && !menu.contains(ev.target) && !ev.target.closest('[data-wl-toggle]')) closeWatchlistMenu();
}
function _wlMenuEsc(ev){ if(ev.key === 'Escape') closeWatchlistMenu(); }
function closeWatchlistMenu(){
  const menu = document.getElementById('wlMenu');
  if(menu) menu.remove();
  document.removeEventListener('click', _wlMenuOutside, true);
  document.removeEventListener('keydown', _wlMenuEsc, true);
  window.removeEventListener('scroll', closeWatchlistMenu, true);
}

// Refresh the + / check icon on every visible card after a state change,
// so the icon flips immediately without re-rendering whole rails.
function refreshAllWatchlistIcons(){
  document.querySelectorAll('[data-wl-toggle]').forEach(btn => {
    const id = btn.dataset.wlToggle;
    const inList = isInWatchlist(id);
    btn.classList.toggle('in-list', inList);
    btn.setAttribute('aria-label', inList ? 'Edit watchlist status' : 'Add to watchlist');
  });
}

// Legacy callers (e.g. heroAddWatchlist) — keep working but route through
// the new menu when an anchor is available, otherwise quick-add as 'plan'.
function toggleWatchlist(id, anchorEl){
  if(anchorEl){ openWatchlistMenu(id, anchorEl); return; }
  if(isInWatchlist(id)) removeFromWatchlist(id);
  else setWatchlistStatus(id, 'plan');
}


/* ════════════════════════════════════════════════════════════════════
   PLAYER
   ════════════════════════════════════════════════════════════════════ */
async function fetchPlayback(film) {
  if (!session) throw new Error('Login dulu');
  const r = await fetch('/api/playback/' + encodeURIComponent(film.id), {
    headers: { Authorization: 'Bearer ' + session.access_token },
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 403 && d && d.locked) return d;
  if (!r.ok || !d.ok) throw new Error(d.error || d.message || 'Gagal membuka video');
  return d;
}
async function openFilm(film, opts){
  opts = opts || {};
  // VIP playback context: kalau user-nya VIP active, ATAU caller minta
  // vipMode (mis. dari grid VIP / hero VIP), gunakan domain VIP (ad-free).
  // Sebelumnya kita gate di `film.tier === 'vip'`, tapi VIP page sengaja
  // ikut nampilin film free supaya VIP-user tetap nonton ad-free juga.
  const vipMode = !!opts.vipMode || currentTier === 'vip';
  currentPlayerTier = vipMode ? 'vip' : 'basic';
  // Tier check — show fancy locked modal instead of toast
  if(film.tier === 'vip' && currentTier !== 'vip'){
    showVipLocked(film);
    return;
  }

  currentFilm = film;
  let playback;
  try{
    playback = await fetchPlayback(film);
  }catch(e){
    // Guest user yang gak login masih bisa nonton film FREE yang punya R2 source
    if(film.r2_bucket && film.tier === 'free'){
      // Lanjut tanpa _playback — loadVideo pake r2_bucket + r2_path langsung
      playback = null;
    }else{
      showToast(e.message, 'error');
      return;
    }
  }
  if(playback){
    if(playback.locked){
      if(playback.reason === 'episode_locked' || playback.reason === 'preview_expired') openAccessModal(film);
      else showVipLocked(film);
      showToast(playback.message || 'Konten terkunci', 'error');
      return;
    }
    currentFilm._playback = playback;
  }
  currentResumeFrom = opts.resumeFrom || 0;
  // Kalau gak ada explicit resume, ambil dari Continue Watching kalau ada
  if(!opts.resumeFrom){
    const cw = getContinueWatching().find(x=>String(x.id)===String(film.id));
    if(cw && cw.position) currentResumeFrom = cw.position;
  }

  document.getElementById('playerModal').classList.add('open');
  document.body.style.overflow='hidden';
  document.getElementById('playerTitle').textContent = film.judul || '—';

  // Update URL to /film/{id} (clean, shareable)
  if(!opts.fromPopState){
    const filmPath = vipMode
      ? '/film/vip/' + encodeURIComponent(film.id)
      : '/film/' + encodeURIComponent(film.id);

    if(location.pathname !== filmPath){
      history.pushState(
        { kind:'film', id: String(film.id), vipMode },
        '',
        filmPath
      );
    }
  }
  // Populate right panel with whatever we have from the local film record.
  // loadFilmExtras() will enrich with TMDB data (status, production, genres, cast, trailer).
  const poster = film.poster_url || '';
  const prImg = document.getElementById('prPoster');
  if(poster){ prImg.src = poster; prImg.style.display='block'; } else { prImg.removeAttribute('src'); prImg.style.display='none'; }
  document.getElementById('prTitle').textContent = film.judul || '—';
  document.getElementById('prOverview').textContent = film.overview || '';
  document.getElementById('prStatus').textContent = '—';
  document.getElementById('prProduction').textContent = '—';
  document.getElementById('prAired').textContent = film.tahun || '—';
  document.getElementById('prGenres').innerHTML = '';
  if(film.rating){
    document.getElementById('prRatingRow').style.display='flex';
    document.getElementById('prRating').textContent = film.rating;
  } else {
    document.getElementById('prRatingRow').style.display='none';
  }
  document.getElementById('prTrailerSection').style.display='none';
  document.getElementById('prCastSection').style.display='none';

  // Episode list (series)
  if(film.tipe==='series'){
    renderEpisodeList(film);
  }else{
    document.getElementById('epPicker').style.display='none';
    document.getElementById('nowPlayingBar').style.display='none';
    document.getElementById('nowPlayingCard').style.display='none';
    // No episodes for a movie — hide the drawer trigger and dismiss
    // the drawer if it happens to be open from a previous series view.
    const _epBtn = document.getElementById('playerEpBtn');
    if(_epBtn) _epBtn.style.display = 'none';
    try{ closeEpDrawer(); }catch(_){ }
  }

  // Init video player
  await loadVideo(film);

  // Reset subs panel state
  document.getElementById('subsPanel').classList.remove('open');
  document.getElementById('toolBtnSubs').classList.remove('active');
  document.getElementById('subsList').innerHTML='';
  document.getElementById('subsLangPick').innerHTML='';
  document.getElementById('subsStatus').textContent='';
  document.getElementById('subsSearchInput').value=film.judul||'';

  // Auto search subsource — only for legacy (non-iframe) films. The iframe
  // ships its own subtitle picker so we don't need ours.
  if(!(film._playback && film._playback.video_url)){
    setTimeout(()=>subsourceSearch(), 300);
  }

  // Load TMDB extra (cast, trailer, recommended)
  loadFilmExtras(film);
}

/* ════════════════════════════════════════════════════════════════════
   EPISODE PICKER (Netflix-style sidebar)
   ════════════════════════════════════════════════════════════════════ */
let epPickerState = {
  view: (localStorage.getItem('zaein_ep_view') || 'grid'), // 'grid' | 'list'
  currentSeason: 1,
  seriesFilms: [],          // semua episode (allFilms filtered by judul)
  tmdbBySeason: {},         // { season → [{episode_number, name, still_path}] }
  tmdbId: null,
};

async function renderEpisodeList(film){
  const picker = document.getElementById('epPicker');
  const npb = document.getElementById('nowPlayingBar');
  const npc = document.getElementById('nowPlayingCard');
  const epBtn = document.getElementById('playerEpBtn');

  // Defensive: if a previous close is still mid-transition and the
  // picker is parked in the drawer slot, restore it to .player-right
  // so the right column has its episode list right away.
  const drawerRoot = document.getElementById('epDrawerRoot');
  if(picker && drawerRoot && (drawerRoot.hidden || !drawerRoot.classList.contains('open'))){
    if(picker._origParent && picker.parentNode !== picker._origParent){
      if(_epDrawerCloseTimer){ clearTimeout(_epDrawerCloseTimer); _epDrawerCloseTimer = null; }
      _epDrawerRestorePicker();
      drawerRoot.hidden = true;
    }
  }

  // Group all films with same judul where tipe==='series'
  const eps = allFilms.filter(f=>f.tipe==='series' && f.judul===film.judul);
  if(!eps.length){
    picker.style.display='none';
    npb.style.display='none';
    npc.style.display='none';
    if(epBtn) epBtn.style.display='none';
    try{ closeEpDrawer(); }catch(_){ }
    return;
  }
  picker.style.display='flex';
  npb.style.display='flex';
  npc.style.display='block';
  if(epBtn) epBtn.style.display='inline-flex';

  epPickerState.seriesFilms = eps;
  epPickerState.currentSeason = film.season || 1;
  epPickerState.tmdbId = film.tmdb_id || null;
  epPickerState.tmdbBySeason = {};

  console.log('[ep-picker] open series', {
    judul: film.judul,
    tmdb_id_in_db: film.tmdb_id,
    current_season: epPickerState.currentSeason,
    episode_count: eps.length,
    seasons: Array.from(new Set(eps.map(e=>e.season||1))).sort(),
  });

  // Apply view mode
  applyEpView();

  // Build season dropdown
  const seasons = Array.from(new Set(eps.map(e=>e.season||1))).sort((a,b)=>a-b);
  const sel = document.getElementById('epSeasonSel');
  sel.innerHTML = seasons.map(s => {
    const count = eps.filter(e=>(e.season||1)===s).length;
    return `<option value="${s}" ${s===epPickerState.currentSeason?'selected':''}>Season ${s} (${count} ep)</option>`;
  }).join('');

  // Set episode number input
  document.getElementById('epNumInput').value = film.episode || '';

  // Update bottom info bar
  updateNowPlayingBar(film);

  // Render the list synchronously with whatever metadata we have, then enrich w/ TMDB async
  renderEpListForSeason(epPickerState.currentSeason, film.id);

  // Try to fetch TMDB tmdb_id if we don't have one — use the same pattern as loadFilmExtras
  if(!epPickerState.tmdbId){
    try{
      if(session){
        console.log('[ep-picker] tmdb search by judul', film.judul);
        const r = await fetch(`${apiBase()}/api/tmdb/search?type=tv&query=${encodeURIComponent(film.judul||'')}`, {
          headers: { Authorization: 'Bearer '+session.access_token },
        });
        const d = await r.json();
        console.log('[ep-picker] tmdb search result', d);
        if(d.ok && d.data && d.data.results && d.data.results.length){
          epPickerState.tmdbId = d.data.results[0].id;
          console.log('[ep-picker] resolved tmdb_id from search:', epPickerState.tmdbId, 'name:', d.data.results[0].name);
        }
      }
    }catch(e){ console.warn('[ep-picker] tmdb search err', e); }
  }
  if(epPickerState.tmdbId){
    fetchTmdbSeasonAndRerender(epPickerState.currentSeason, film.id);
  } else {
    console.warn('[ep-picker] no tmdb_id resolved — chapter titles will fall back to filename or "Episode N"');
  }
}

function applyEpView(){
  const list = document.getElementById('epList');
  if(epPickerState.view === 'grid'){
    list.classList.add('grid-mode');
    document.getElementById('epViewGridBtn').classList.add('active');
    document.getElementById('epViewListBtn').classList.remove('active');
  } else {
    list.classList.remove('grid-mode');
    document.getElementById('epViewListBtn').classList.add('active');
    document.getElementById('epViewGridBtn').classList.remove('active');
  }
}

function setEpView(v){
  epPickerState.view = v;
  localStorage.setItem('zaein_ep_view', v);
  applyEpView();
}

/* ════════════════════════════════════════════════════════════════════
   EPISODE DRAWER (slide-in panel from the right)

   Tactic: instead of cloning the episode list, we physically move the
   existing #epPicker element into the drawer's body when opened, and
   move it back to its original home (inside .player-right) on close.
   This way the existing render/season/view-switch logic keeps writing
   to the same DOM nodes — no parallel state to maintain. The iframe
   is never touched so playback keeps running.
   ════════════════════════════════════════════════════════════════════ */
let _epDrawerCloseTimer = null;
function _epDrawerEscHandler(e){
  if(e.key === 'Escape'){ closeEpDrawer(); }
}
function _epDrawerRestorePicker(){
  const picker = document.getElementById('epPicker');
  if(!picker || !picker._origParent) return;
  try{
    if(picker._origNext && picker._origNext.parentNode === picker._origParent){
      picker._origParent.insertBefore(picker, picker._origNext);
    } else {
      picker._origParent.appendChild(picker);
    }
  }catch(_){ /* parent may have been detached — leave it where it is */ }
}

function openEpDrawer(){
  const root   = document.getElementById('epDrawerRoot');
  const slot   = document.getElementById('epDrawerSlot');
  const picker = document.getElementById('epPicker');
  if(!root || !slot || !picker) return;
  // Cancel any pending close so quick toggles don't fight each other.
  if(_epDrawerCloseTimer){ clearTimeout(_epDrawerCloseTimer); _epDrawerCloseTimer = null; }
  // Remember where the picker normally lives so we can put it back.
  if(!picker._origParent){
    picker._origParent = picker.parentNode;
    picker._origNext   = picker.nextSibling;
  }
  if(picker.parentNode !== slot){
    slot.appendChild(picker);
  }
  picker.style.display = 'flex';
  root.hidden = false;
  // Force a layout flush so the transform transition runs from the
  // off-screen state instead of snapping straight to open.
  void root.offsetWidth;
  root.classList.add('open');
  document.body.classList.add('ep-drawer-open');
  document.addEventListener('keydown', _epDrawerEscHandler);
}

function closeEpDrawer(){
  const root = document.getElementById('epDrawerRoot');
  if(!root || root.hidden) return;
  root.classList.remove('open');
  document.body.classList.remove('ep-drawer-open');
  document.removeEventListener('keydown', _epDrawerEscHandler);
  // Wait for the slide-out transition before hiding the root and
  // returning the picker to its original parent.
  if(_epDrawerCloseTimer){ clearTimeout(_epDrawerCloseTimer); }
  _epDrawerCloseTimer = setTimeout(() => {
    _epDrawerCloseTimer = null;
    if(root.classList.contains('open')) return; // re-opened mid-transition
    _epDrawerRestorePicker();
    root.hidden = true;
  }, 430);
}

/* ════════════════════════════════════════════════════════════════════
   PLAYER FULLSCREEN

   We fullscreen #playerWrap (not the iframe alone) so the overlay
   Episode button + drawer ride along with the fullscreen view. The
   iframe is a descendant of the wrap and naturally fills the screen.

   If the user happens to tap the iframe's own native fullscreen button
   (which fullscreens just the iframe element), we try to redirect by
   exiting and re-requesting fullscreen on the wrap. That may fail on
   browsers that don't carry user-activation across the cross-origin
   boundary — in which case the user can press Esc and use our button
   instead.
   ════════════════════════════════════════════════════════════════════ */
function _fsRequest(el){
  if(!el) return null;
  const fn = el.requestFullscreen
          || el.webkitRequestFullscreen
          || el.webkitRequestFullScreen
          || el.msRequestFullscreen;
  if(!fn) return null;
  try{ return Promise.resolve(fn.call(el)); }catch(e){ return Promise.reject(e); }
}
function _fsExit(){
  const fn = document.exitFullscreen
          || document.webkitExitFullscreen
          || document.webkitCancelFullScreen
          || document.msExitFullscreen;
  if(!fn) return null;
  try{ return Promise.resolve(fn.call(document)); }catch(e){ return Promise.reject(e); }
}
function _fsCurrent(){
  return document.fullscreenElement
      || document.webkitFullscreenElement
      || document.webkitCurrentFullScreenElement
      || document.msFullscreenElement
      || null;
}

function toggleWrapFullscreen(){
  const wrap = document.getElementById('playerWrap');
  if(!wrap) return;
  const cur = _fsCurrent();
  if(!cur){
    const p = _fsRequest(wrap);
    if(p && p.catch) p.catch(err => console.warn('[fs] request failed', err));
  } else {
    const p = _fsExit();
    if(p && p.catch) p.catch(err => console.warn('[fs] exit failed', err));
  }
}

let _fsRedirecting = false;
function _onFullscreenChange(){
  const fsEl = _fsCurrent();
  const wrap = document.getElementById('playerWrap');
  const vh   = document.getElementById('vhFrame');
  if(wrap){
    wrap.classList.toggle('is-fullscreen', fsEl === wrap);
  }
  // Iframe took fullscreen by itself (user hit the player4me fullscreen
  // button). Try to upgrade to wrap fullscreen so the overlay survives.
  if(fsEl && vh && fsEl === vh && wrap && !_fsRedirecting){
    _fsRedirecting = true;
    const exit = _fsExit();
    if(!exit){ _fsRedirecting = false; return; }
    exit
      .then(() => _fsRequest(wrap))
      .catch(err => console.warn('[fs] iframe \u2192 wrap redirect failed', err))
      .finally(() => { _fsRedirecting = false; });
  }
}
document.addEventListener('fullscreenchange',        _onFullscreenChange);
document.addEventListener('webkitfullscreenchange',  _onFullscreenChange);
document.addEventListener('mozfullscreenchange',     _onFullscreenChange);
document.addEventListener('MSFullscreenChange',      _onFullscreenChange);

function onEpSeasonChange(seasonStr){
  const season = parseInt(seasonStr, 10) || 1;
  epPickerState.currentSeason = season;
  // Pick first available episode in this season as new "current"
  const epsInSeason = epPickerState.seriesFilms.filter(e=>(e.season||1)===season).sort((a,b)=>(a.episode||0)-(b.episode||0));
  const firstEp = epsInSeason[0];
  if(firstEp && firstEp.id !== (currentFilm && currentFilm.id)){
    openFilm(firstEp, { vipMode: currentPlayerTier === 'vip' });
    return;
  }
  renderEpListForSeason(season, currentFilm && currentFilm.id);
  if(epPickerState.tmdbId) fetchTmdbSeasonAndRerender(season, currentFilm && currentFilm.id);
}

function onEpNumGo(){
  const epNum = parseInt(document.getElementById('epNumInput').value, 10);
  if(!epNum || epNum < 1) return;
  const target = epPickerState.seriesFilms.find(e =>
    (e.season||1) === epPickerState.currentSeason && (e.episode||0) === epNum
  );
  if(target) openFilm(target, { vipMode: currentPlayerTier === 'vip' });
}

function onEpNumInput(){
  // (UX) Soft-scroll active card into view if the typed episode exists
  const epNum = parseInt(document.getElementById('epNumInput').value, 10);
  if(!epNum) return;
  const card = document.querySelector(`#epList [data-ep="${epNum}"]`);
  if(card) card.scrollIntoView({ block:'center', behavior:'smooth' });
}

// Ambil nama file dari drive_path tanpa ext (.mp4 / .mkv / .webm / .avi / .m4v / .mov)
function _filenameFromDrivePath(drivePath){
  if(!drivePath) return '';
  const last = String(drivePath).split('/').filter(Boolean).pop() || '';
  return last.replace(/\.(mp4|mkv|webm|avi|m4v|mov)$/i, '');
}

function renderEpListForSeason(season, activeId){
  const eps = epPickerState.seriesFilms
    .filter(e=>(e.season||1)===season)
    .sort((a,b)=>(a.episode||0)-(b.episode||0));
  const tmdbEps = epPickerState.tmdbBySeason[season] || [];
  const tmdbByNum = {};
  tmdbEps.forEach(t => { tmdbByNum[t.episode_number] = t; });

  const STILL_BASE = 'https://image.tmdb.org/t/p/w300';
  const list = document.getElementById('epList');
  if(!eps.length){
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.85rem;">Tidak ada episode di Season '+season+'</div>';
    return;
  }
  list.innerHTML = eps.map(ep => {
    const num = ep.episode || 0;
    const t = tmdbByNum[num];
    // Title = TMDB episode name. Falls back to "Episode N" if TMDB hasn't
    // returned the season yet (renderEpListForSeason runs synchronously
    // before fetchTmdbSeasonAndRerender resolves; the second pass replaces
    // these placeholders with real names).
    const epTitle = (t && t.name) ? t.name : `Episode ${num || '?'}`;
    const still = t && t.still_path ? STILL_BASE + t.still_path : '';
    const active = String(ep.id) === String(activeId);
    const thumbStyle = still ? `style="background-image:url('${still}')"` : '';
    const placeholder = still ? '' : `<div class="ph">Ep ${num || '?'}</div>`;
    return `
      <div class="ep-card${active?' active':''}" data-id="${ep.id}" data-ep="${num}">
        <div class="ep-card-thumb" ${thumbStyle}>${placeholder}</div>
        <div class="ep-card-info">
          <div class="ep-card-num">Ep ${num || '?'} ${active?'<span class="play-arrow">▶</span>':''}</div>
          <div class="ep-card-title" title="${escapeHtml(epTitle)}">${escapeHtml(epTitle)}</div>
        </div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.ep-card').forEach(card => {
  card.addEventListener('click', () => {
    const id = card.dataset.id;
    const next = eps.find(e => String(e.id) === String(id));

    if(!next) return;

    // Jangan reload kalau klik episode yang sama.
    if(currentFilm && String(currentFilm.id) === String(next.id)) return;

    openFilm(next, {
      vipMode: currentPlayerTier === 'vip',
      resumeFrom: 0
    });
  });
});
}

async function fetchTmdbSeasonAndRerender(season, activeId){
  if(!epPickerState.tmdbId) return;
  if(epPickerState.tmdbBySeason[season]){
    renderEpListForSeason(season, activeId);
    return;
  }
  if(!session) return;
  try{
    console.log('[ep-picker] fetch tmdb season', { tmdbId: epPickerState.tmdbId, season });
    const r = await fetch(`${apiBase()}/api/tmdb/tv/${epPickerState.tmdbId}/season/${season}`, {
      headers: { Authorization: 'Bearer '+session.access_token },
    });
    const d = await r.json();
    if(!d.ok){
      console.warn('[ep-picker] tmdb season fetch failed', d);
      return;
    }
    if(d.data && Array.isArray(d.data.episodes)){
      epPickerState.tmdbBySeason[season] = d.data.episodes.map(e => ({
        episode_number: e.episode_number,
        name: e.name,
        still_path: e.still_path,
      }));
      console.log('[ep-picker] tmdb season loaded', {
        season,
        episodes_returned: d.data.episodes.length,
        first_ep: d.data.episodes[0] ? { num: d.data.episodes[0].episode_number, name: d.data.episodes[0].name, has_still: !!d.data.episodes[0].still_path } : null,
      });
      renderEpListForSeason(season, activeId);
      // Refresh "Now Playing" card so the placeholder "Episode N" gets
      // replaced with the real TMDB title once it's available.
      if(currentFilm && (currentFilm.season || 1) === season){
        updateNowPlayingBar(currentFilm);
      }
    } else {
      console.warn('[ep-picker] tmdb season returned no episodes', d);
    }
  }catch(e){ console.warn('[ep-picker] tmdb season err', e); }
}

function updateNowPlayingBar(film){
  if(!film || film.tipe!=='series') return;
  const totalEpsInSeason = epPickerState.seriesFilms.filter(e=>(e.season||1)===(film.season||1)).length;
  document.getElementById('npbLeft').textContent =
    `Season ${film.season||1} • Episode ${film.episode||'?'}`;
  document.getElementById('npbRight').textContent =
    `${totalEpsInSeason} Episode${totalEpsInSeason>1?'s':''}`;
  // Now playing card subtitle = TMDB episode title for the current season,
  // matching the right-hand episode picker. Fallback to "Episode N" while
  // the TMDB season fetch is still in flight.
  const tmdbEps = epPickerState.tmdbBySeason[film.season || 1] || [];
  const tmdbEp = tmdbEps.find(e => e.episode_number === (film.episode || 0));
  const epTitle = (tmdbEp && tmdbEp.name) ? tmdbEp.name : `Episode ${film.episode||'?'}`;
  document.getElementById('npcSubtitle').textContent = epTitle;
}

/* ────────────────────────────────────────────────────────────────────
   loadVideo — initialise Multitrack.JS player with multi-quality video,
   multi-dub audio, and multi-subtitle tracks (resolved from Drive Index).
   ──────────────────────────────────────────────────────────────────── */
async function _resolveDrivePath(drivePath){
  if(!drivePath) return null;
  try{
    const r = await fetch('/api/drive/resolve?path='+encodeURIComponent(drivePath), {
      headers: await authHeaders(),
    });
    const d = await r.json();
    return d && d.ok ? d.stream_url : null;
  }catch{ return null; }
}

async function loadVideo(film){
  // ── HARD DEFENSE: R2 films ALWAYS use native player ──
  // Any film with r2_bucket set is an R2-sourced film (not Player4Me iframe).
  // This check runs before everything else to prevent ANY possible path
  // reaching loadVideoHost for R2 films.
  if(film && film.r2_bucket){
    console.log('[loadVideo] FORCE r2_bucket=' + film.r2_bucket + ' → loadNativeDrivePlayer');
    return loadNativeDrivePlayer(film);
  }

  // ── Drive-source detection ──
  // NOTE: catalog strips film.video_url for non-admin users, so we check
  // both film.video_url AND film._playback.video_url (resolved from /api/playback).
  const r2VideoUrl = film.video_url || (film._playback && film._playback.video_url);
  const isR2VideoUrl = !!(r2VideoUrl && /r2\.dev|\/api\/r2-stream|\.mp4|\.m4a/i.test(String(r2VideoUrl)));
  const hasR2Source = !!(film.r2_bucket || isR2VideoUrl);
  const hasDriveSource = !!(film && (film.drive_path || film.drive_link || (Array.isArray(film.videos) && film.videos.length)));
  console.log('[loadVideo] filmId=' + film.id, 'hasR2=' + hasR2Source, 'hasDrive=' + hasDriveSource, 'r2VideoUrl=' + (r2VideoUrl ? String(r2VideoUrl).slice(0,60) : 'NULL'), 'r2_bucket=' + (film.r2_bucket||'none'), 'playback=' + !!(film._playback));
  if(hasR2Source || hasDriveSource){
    return loadNativeDrivePlayer(film);
  }

  // Fallback: films that only have a hosted Player4Me URL still use iframe.
  if(film && film._playback && film._playback.video_url){
    return loadVideoHost(film);
  }
  showToast('Film ini belum punya video. Hubungi admin.', 'error');
}

// Stub kept so any stale UI handlers don't crash. There is only one player
// engine now (video host iframe).
function switchPlayerEngine(){ /* no-op */ }
function applyEngineButtons(){ /* no-op */ }

function setHostContextShield(enabled){
  const shield = document.getElementById('hostContextShield');
  if(!shield) return;
  // The shield used to sit above the cross-origin host player to block the
  // context menu. It also made the Play button feel hard to click, so keep it
  // permanently disabled and let the iframe/video receive mouse events.
  shield.classList.remove('show');
  shield.dataset.enabled = '0';
  shield.style.pointerEvents = 'none';
}

// Show legacy Vidstack/Multitrack players after a host-iframe film closes.
function _showLegacyPlayer(){
  releaseVipDownloadSlot();
  const fr = document.getElementById('vhFrame');
  if(fr){ fr.src = 'about:blank'; fr.style.display='none'; }
  setHostContextShield(false);
  const peBar = document.getElementById('playerEngineBar');
  if(peBar) peBar.style.display = '';
  const mp = document.getElementById('multitrackPlayer');
  if(mp) mp.style.display = '';
  const p2 = document.getElementById('player2Wrap');
  if(p2) p2.style.display = '';
  const sw = document.getElementById('shakaPlayerWrap');
  if(sw) sw.style.display = 'none';
  const sp = document.getElementById('subsPanel');
  if(sp) sp.style.display = '';
  const subBtn = document.getElementById('toolBtnSubs');
  if(subBtn) subBtn.style.display = '';
}

async function loadNativeDrivePlayer(film){
  releaseVipDownloadSlot();
  setHostContextShield(false);

  const fr = document.getElementById('vhFrame');
  if(fr){
    fr.src = 'about:blank';
    fr.dataset.currentSrc = '';
    fr.style.display = 'none';
  }

  const peBar = document.getElementById('playerEngineBar');
  if(peBar) peBar.style.display = 'none';
  const mp = document.getElementById('multitrackPlayer');
  if(mp) mp.style.display = 'none';
  const p2 = document.getElementById('player2Wrap');
  const shakaWrap = document.getElementById('shakaPlayerWrap');
  if(p2) p2.style.display = 'none';
  if(shakaWrap) shakaWrap.style.display = 'none';

  const subsPanel = document.getElementById('subsPanel');
  if(subsPanel){ subsPanel.classList.remove('open'); subsPanel.style.display = 'none'; }
  const subBtn = document.getElementById('toolBtnSubs');
  if(subBtn) subBtn.style.display = 'none';

  resetPreviewGate();
  const hasFullAccess = film._playback && film._playback.access === 'full';
  const fullBar = document.getElementById('fullAccessBar');
  if(fullBar) fullBar.style.display = hasFullAccess ? 'none' : 'flex';

  const sources = await _resolveFilmSources(film);
  if(!sources){
    // ── HARD DEFENSE: R2 films NEVER fallback to loadVideoHost ──
    // The old code redirected to loadVideoHost when _playback existed,
    // which caused "URL video tidak valid" for R2 films because the
    // host embed URL normalization always fails on R2 URLs.
    if(film && film.r2_bucket){
      console.error('[loadNativeDrivePlayer] _resolveFilmSources returned null for R2 film, but ignoring fallback to loadVideoHost');
      showToast('Gagal memuat sumber video R2. Coba refresh.', 'error');
      return;
    }
    if(film && film._playback && film._playback.video_url) return loadVideoHost(film);
    return;
  }

  film._sources = sources;

  // Pilih engine: Simple R2 (1 video) → Vidstack (2) for proper controls.
  // Multi-video → Shaka (3) for DASH MPD quality switching.
  const isR2 = !!(film.video_url || film.r2_bucket || (film._playback && film._playback.video_url));

  try{ teardownEngine1(); }catch{}
  try{ teardownEngine2(); }catch{}
  try{ teardownEngine3(); }catch{}

  // Simple R2 (1 video, maybe multi-audio) → Engine 2 (Vidstack) for proper controls.
  // Multi-video or DASH-manifest → Engine 3 (Shaka) for quality switching.
  if(typeof shaka !== 'undefined' && !isR2 && sources.videos.length > 1){
    activeEngine = 3;
    await loadVideoEngine3(film, sources);
  }else{
    activeEngine = 2;
    if(p2) p2.style.display = '';
    await loadVideoEngine2(film, sources);
  }

  if(sources.videos && sources.videos[0] && sources.videos[0].path){
    try{ setStreamActions(sources.videos[0].path, film.judul || film.title || ''); }catch(e){}
  }
  armPreviewGate(film);
}

// Hide legacy players + show video host iframe. Set up Drive Index extras
// (download + external player) ONLY for VIP films.
async function loadVideoHost(film){
  releaseVipDownloadSlot();
  // Mark in Continue Watching after 30 s — gives user time to bail without
  // polluting the rail. Cleared if user navigates to another film inside the
  // same session via the timeout being reset on each loadVideoHost call.
  if(_hostCwTimer){ clearTimeout(_hostCwTimer); _hostCwTimer = null; }
  if(film && film.id){
    _hostCwTimer = setTimeout(()=>{
      _hostCwTimer = null;
      // Only mark if this film is still the one playing.
      if(currentFilm && String(currentFilm.id) === String(film.id)){
        markFilmOpenedForCw(film.id);
      }
    }, 30 * 1000);
  }
  // Tear down whichever legacy engine was last active so it doesn't keep
  // playing audio / consuming bandwidth in the background.
  try { teardownEngine1(); } catch {}
  try { teardownEngine2(); } catch {}

  // Hide legacy players + chrome
  const peBar = document.getElementById('playerEngineBar');
  if(peBar) peBar.style.display = 'none';
  const mp = document.getElementById('multitrackPlayer');
  if(mp) mp.style.display = 'none';
  const p2 = document.getElementById('player2Wrap');
  if(p2) p2.style.display = 'none';
  // The host has its own subtitle picker — hide ours.
  const subsPanel = document.getElementById('subsPanel');
  if(subsPanel){ subsPanel.classList.remove('open'); subsPanel.style.display = 'none'; }
  const subBtn = document.getElementById('toolBtnSubs');
  if(subBtn) subBtn.style.display = 'none';

  resetPreviewGate();
  const hasFullAccess = film._playback && film._playback.access === 'full';
  const fullBar = document.getElementById('fullAccessBar');
  if(fullBar) fullBar.style.display = hasFullAccess ? 'none' : 'flex';

  // Show video host iframe
  const fr = document.getElementById('vhFrame');
  if(fr){
    // film.video_url may be the share URL, an embed URL, or — historically
    // — even a full <iframe…> tag the admin accidentally pasted. Always
    // normalize. If we cannot extract a host video id, refuse to render
    // the iframe instead of feeding a relative path that would self-embed
    // webstream.
    const rawVideoUrl = (film._playback && film._playback.video_url) || film.video_url;
    const src = _normalizeHostEmbedUrl(rawVideoUrl, currentPlayerTier === 'vip');
    if(src){
  fr.style.display = 'block';
  setHostContextShield(true);

  // Player4Me memakai URL hash: https://domain/#videoid.
  // Kalau cuma ganti hash di iframe yang sama, browser kadang tidak reload player.
  // Jadi kita paksa reload iframe dengan about:blank dulu, lalu set URL baru.
  const lastSrc = fr.dataset.currentSrc || '';

  if(lastSrc !== src){
    fr.dataset.currentSrc = src;
    fr.src = 'about:blank';

    setTimeout(() => {
      fr.src = src;
    }, 80);
  } else {
    fr.src = src;
  }
} else {
  fr.removeAttribute('src');
  fr.dataset.currentSrc = '';
  fr.style.display = 'none';
  setHostContextShield(false);
  // DEBUG: trace why normalize failed
  const _dbg = {
    filmId: film.id,
    hasVideoUrl: !!film.video_url,
    hasPlayback: !!(film._playback),
    playbackVideoUrl: film._playback ? film._playback.video_url : null,
    rawVideoUrl: rawVideoUrl,
    tier: currentPlayerTier,
  };
  console.error('[loadVideoHost] normalize failed', _dbg);
  showToast('URL video tidak valid. [DEBUG] video_url=' + (film.video_url ? 'YES' : 'NO') + ' _playback=' + (film._playback ? 'YES' : 'NO') + ' pb_url=' + (film._playback && film._playback.video_url ? String(film._playback.video_url).slice(0, 50) : 'NULL'), 'error');
}
  }

  armPreviewGate(film);

  // VIP extras (download + external player + drive/gdrive link) — ONLY when
  // the user is on a VIP plan AND the film row has a drive backend. Basic
  // users see NOTHING below the player, per spec:
  //   "di basic gaada lagi yg didalam kotak saya tandain itu, itu hanya ada
  //    di video player yg bagian vip"
  // Note: we do NOT acquire a download slot here. Just resolve the stream
  // URL so external players + URL copy work. The actual slot is acquired
  // ON CLICK of the DOWNLOAD button via beginVipDownload().
  const userIsVip = currentTier === 'vip';
  const showVipExtras = userIsVip && (film.drive_path || film.drive_link);

  if(showVipExtras){
    try{
      const param = film.drive_path
        ? 'path='+encodeURIComponent(film.drive_path)
        : 'link='+encodeURIComponent(film.drive_link);
      const r = await fetch('/api/drive/resolve?'+param, {
        headers: await authHeaders(),
      });
      const d = await r.json();
      if(d.ok && d.stream_url){
        setStreamActions(d.stream_url, film.judul || film.title || '', '');
      }else{
        document.getElementById('streamActions').style.display = 'none';
        if(d && d.error) showToast(d.error, 'error');
      }
    }catch{
      document.getElementById('streamActions').style.display = 'none';
    }
  }else{
    // Hide the entire stream actions row for basic / non-vip
    document.getElementById('streamActions').style.display = 'none';
  }
}

// Extract the video host id from any URL/string the admin might have
// saved in the DB. Handles:
//   - https://<custom-domain>/#<id>      (white-label, current default)
//   - <iframe src="https://<custom-domain>/#<id>" …></iframe>   (admin
//        pasted the full iframe tag instead of just the URL — recover
//        gracefully instead of breaking the page)
//   - bare id like "allnx"
function _extractHostId(rawUrl){
  if(!rawUrl) return null;
  let u = String(rawUrl).trim();

  // If the admin pasted a full <iframe …> tag, pull the src out first.
  // This is what used to send the player into a self-embedding loop:
  // iframe.src starting with `<` resolves as a relative path, which
  // loaded webstream itself inside webstream ("web dalam web").
  const iframeMatch = u.match(/<\s*iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (iframeMatch) u = iframeMatch[1].trim();

  // Custom domain hash style: https://my.domain/#abc123
  let m = u.match(/^https?:\/\/[^\/]+\/#\/?([A-Za-z0-9_-]+)/i);
  if(m) return m[1];
  if(/^[A-Za-z0-9_-]{4,}$/.test(u)) return u;
  return null;
}

// Build the iframe URL for a film. Uses the admin's branded custom
// domain exposed by the worker as CONFIG.video_host_domain. Both VIP
// and Basic tiers play through the same domain. If we can't extract a
// host id, or the custom domain isn't configured, return '' so the
// caller shows a friendly toast instead of producing a broken iframe.
function _normalizeHostEmbedUrl(rawUrl, vipMode){
  if(!rawUrl) return '';

  const id = _extractHostId(rawUrl);
  if(!id) return '';

  // If rawUrl already has a full domain (https://custom-domain/#id),
  // use it directly — no CONFIG lookup needed.
  // CONFIG.video_host_domain was removed with player4me_domains table (migration 0014).
  var _srcUrl = String(rawUrl).trim();
  var _ifm = _srcUrl.match(/<\s*iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if(_ifm) _srcUrl = _ifm[1].trim();
  if(/^https?:\/\//i.test(_srcUrl)){
    // Strip trailing /#id or /id from original URL, append our id
    return _srcUrl.replace(/#\/?[A-Za-z0-9_-]+$/, '') + '/#' + id;
  }

  // Fallback for bare ids: use CONFIG lookup
  var rawDom = vipMode
    ? ((CONFIG && CONFIG.player4me_vip_domain) || (CONFIG && CONFIG.video_host_domain) || '')
    : ((CONFIG && CONFIG.player4me_basic_domain) || (CONFIG && CONFIG.video_host_domain) || '');
  var customDomain = String(rawDom).trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if(!customDomain) return '';
  return 'https://' + customDomain + '/#' + id;
}

async function _resolveFilmSources(film){
  // ── Build videos array (multi-resolution) ──
  const videos = [];
  // ── R2 source: map video_url / r2_bucket+r2_path / audio_url / subtitle_urls ke arrays ──
  // Catalog strips video_url for non-admin → fallback to playback response or r2_bucket+r2_path
  const r2VideoUrl = film.video_url || (film._playback && film._playback.video_url);
  const r2RawPath = (film.r2_bucket && film.r2_path) ? ('/api/r2-stream/' + film.r2_bucket + '/' + film.r2_path + '/video/video.mp4') : null;
  if((r2VideoUrl || r2RawPath) && !videos.length){
    // R2 video (maybe muxed with audio tracks embedded)
    // Proxy via /api/r2-stream/ to bypass CORS
    // When r2_bucket is set, r2VideoUrl might be a Player4Me embed URL (admin),
    // so prefer r2RawPath (built from r2_bucket+r2_path) which is always correct.
    var r2ProxiedUrl = r2RawPath;
    if(!r2ProxiedUrl && r2VideoUrl) r2ProxiedUrl = r2VideoUrl.replace(/^https:\/\/pub-[^/]+\.r2\.dev/, '/api/r2-stream');
    videos.push({ name: 'R2 Video', path: r2ProxiedUrl });
    // Audio tracks: check film.audio_tracks first, or parse film.audio_url
    if(!Array.isArray(film.audio_tracks) || !film.audio_tracks.length){
      if(film.audio_url){
        // legacy single audio URL, proxy via /media-proxy/
        const ap = film.audio_url.replace(/^https:\/\/pub-[^/]+\.r2\.dev/, '/api/r2-stream');
        try{ film.audio_tracks = [{ name: 'Audio R2', url: ap, language: 'und' }]; }catch(e){}
      }
    }
    // Subtitles: check film.subtitles first, or parse film.subtitle_urls (JSON string)
    if(!Array.isArray(film.subtitles) || !film.subtitles.length){
      if(film.subtitle_urls){
        try{
          let parsed = film.subtitle_urls;
          if(typeof parsed === 'string') parsed = JSON.parse(parsed);
          if(Array.isArray(parsed)){
            film.subtitles = parsed.map(function(s,i){
              const su = (s.url || '').replace(/^https:\/\/pub-[^/]+\.r2\.dev/, '/api/r2-stream');
              return { name: s.label || s.language || ('Sub '+(i+1)), url: su, language: s.language || '' };
            });
          }
        }catch(e){}
      }
    }
  }
  if(Array.isArray(film.videos)){
    for(const v of film.videos){
      if(!v) continue;
      const url = v.url || v.stream_url || await _resolveDrivePath(v.drive_path);
      if(url) videos.push({ name: v.name || v.label || 'Default', path: url });
    }
  }
  if(!videos.length){
    const driveRef = film.drive_path || film.drive_link;
    if(!driveRef){
      showToast('Film ini belum punya path Drive. Hubungi admin.', 'error');
      return null;
    }
    const param = film.drive_path ? 'path='+encodeURIComponent(film.drive_path) : 'link='+encodeURIComponent(film.drive_link);
    try{
      const r = await fetch('/api/drive/resolve?'+param, {
        headers: await authHeaders(),
      });
      const d = await r.json();
      if(!d.ok){ showToast('Drive: '+(d.error||'gagal resolve'), 'error'); return null; }
      videos.push({ name: 'Default', path: d.stream_url });
    }catch(e){ showToast('Drive resolve error: '+e.message, 'error'); return null; }
  }
  // ── Build audios array (multi-dub) ──
  const audios = [];
  if(Array.isArray(film.audio_tracks)){
    for(const t of film.audio_tracks){
      if(!t) continue;
      const url = t.url || t.stream_url || await _resolveDrivePath(t.drive_path);
      if(url) audios.push({ name: t.name || t.language || 'Audio', path: url, language: t.language || 'und' });
    }
  }
  if(!audios.length){
    audios.push({ name: 'Original', path: videos[0].path, language: 'und' });
  }
  // ── Build subtitles array ──
  // Merges manual subtitles (from admin upload) with auto-extracted subtitles
  // (from zaeinstore-processor → zaeinstore-subtitles via jsDelivr).
  const subtitles = [];
  if(Array.isArray(film.subtitles)){
    for(const s of film.subtitles){
      if(!s) continue;
      const url = s.url || s.stream_url || await _resolveDrivePath(s.drive_path);
      if(url) subtitles.push({ name: s.name || s.language || 'Subtitle', path: url, language: s.language || '' });
    }
  }
  if(Array.isArray(film.auto_subtitle_tracks)){
    const seen = new Set(subtitles.map(s => (s.language||'').toLowerCase()));
    for(const t of film.auto_subtitle_tracks){
      if(!t || !t.url) continue;
      const lang = (t.language || '').toLowerCase();
      if(seen.has(lang)) continue; // manual subtitle wins if same language present
      seen.add(lang);
      subtitles.push({ name: t.label || t.language || 'Auto', path: t.url, language: t.language || '' });
    }
  }
  return { videos, audios, subtitles };
}

function applyEngineButtons(){
  const b1 = document.getElementById('peBtn1');
  const b2 = document.getElementById('peBtn2');
  if(b1) b1.classList.toggle('active', activeEngine === 1);
  if(b2) b2.classList.toggle('active', activeEngine === 2);
}

function switchPlayerEngine(engine){
  if(engine !== 1 && engine !== 2) return;
  if(engine === activeEngine) return;
  activeEngine = engine;
  try{ localStorage.setItem(PLAYER_ENGINE_KEY, String(engine)); }catch{}
  applyEngineButtons();
  if(currentFilm && currentFilm._sources){
    // Preserve playback time across engine swap
    const t = (videoPlayer && typeof videoPlayer.currentTime === 'function') ? videoPlayer.currentTime() : 0;
    currentResumeFrom = t || 0;
    if(engine === 2){
      teardownEngine1();
      loadVideoEngine2(currentFilm, currentFilm._sources);
    }else{
      teardownEngine2();
      loadVideoEngine1(currentFilm, currentFilm._sources);
    }
  }
}

function teardownEngine1(){
  if(mtPlayer){
    try{ mtPlayer.pause(); }catch{}
    try{ mtPlayer.trySync = false; }catch{}
    mtPlayer = null;
  }
  const cont = document.getElementById('multitrackPlayer');
  if(cont){ cont.innerHTML=''; cont.classList.remove('mjs','mjs__settings_show'); }
}

function teardownEngine2(){
  const wrap = document.getElementById('player2Wrap');
  if(!wrap) return;
  wrap.classList.remove('show');
  const vsPlayer = document.getElementById('p2VsPlayer');
  const aux = document.getElementById('p2AuxAudio');
  try{
    if(vsPlayer){
      vsPlayer.pause && vsPlayer.pause();
      // Clear sources / tracks
      vsPlayer.src = [];
      // Remove dynamically added <track> children (they live on <media-provider>)
      const provider = vsPlayer.querySelector('media-provider');
      if(provider){
        provider.querySelectorAll('track').forEach(t=>t.remove());
      }
    }
  }catch{}
  try{ if(aux){ aux.pause(); aux.removeAttribute('src'); aux.load(); } }catch{}
  if(p2State){
    if(p2State.subBlobUrls){
      for(const u of p2State.subBlobUrls){ try{ URL.revokeObjectURL(u); }catch{} }
    }
    if(p2State.qualityChip){ try{ p2State.qualityChip.remove(); }catch{} }
    if(p2State.audioChip){ try{ p2State.audioChip.remove(); }catch{} }
    const p2ov=document.getElementById('p2OverlayMenus');
    if(p2ov) try{ p2ov.remove(); }catch{}
    if(p2State.mse){
      p2State.mse.teardown = true;
      try{ p2State.mse.ms.endOfStream(); }catch{}
      try{ URL.revokeObjectURL(p2State.mse.blobUrl); }catch{}
    }
  }
  p2State = null;
}

async function loadVideoEngine1(film, sources){
  const { videos, audios, subtitles } = sources;
  const container = document.getElementById('multitrackPlayer');
  container.innerHTML = '';
  container.classList.remove('mjs');

  // ── Construct Multitrack.JS player ──
  try{
    mtPlayer = new MultitrackJS('#multitrackPlayer', {
      videos,
      audios,
      subtitles,
      title: (film.judul || film.title || ''),
      placeholder: film.poster_url || '',
    });
  }catch(e){
    console.error('MultitrackJS init failed:', e);
    showToast('Player init failed: '+e.message, 'error');
    return;
  }

  // ── Compat shim so legacy code referencing `videoPlayer` still works ──
  videoPlayer = {
    pause: ()=>{ try{ mtPlayer && mtPlayer.pause(); }catch{} },
    play:  ()=>{ try{ mtPlayer && mtPlayer.play();  }catch{} },
    paused:()=> mtPlayer ? mtPlayer.paused : true,
    currentTime: function(v){ if(!mtPlayer) return 0; if(v===undefined) return mtPlayer.currentTime; mtPlayer.currentTime = v; },
    duration: function(){ return mtPlayer ? mtPlayer.duration : 0; },
    playbackRate: function(v){ if(!mtPlayer) return 1; if(v===undefined) return mtPlayer.playbackRate; mtPlayer.playbackRate = v; },
    muted: function(v){ if(!mtPlayer) return false; if(v===undefined) return mtPlayer.muted; mtPlayer.muted = v; },
    volume: function(v){ if(!mtPlayer) return 1; if(v===undefined) return mtPlayer.volume; mtPlayer.volume = v; },
    src: ()=>{}, load: ()=>{}, on: ()=>{},
    audioTracks: ()=>null,
    addRemoteTextTrack: ()=>{}, remoteTextTracks: ()=>[], removeRemoteTextTrack: ()=>{},
  };

  // ── Resume position ──
  if(currentResumeFrom && currentResumeFrom > 5){
    setTimeout(()=>{ try{ mtPlayer.currentTime = currentResumeFrom; }catch{} }, 600);
  }

  // ── Hook Continue Watching save (every ~8s via audio.timeupdate) ──
  const audioEl = mtPlayer._ && mtPlayer._.form && mtPlayer._.form.audio;
  if(audioEl){
    let lastSave = 0;
    audioEl.addEventListener('timeupdate', ()=>{
      const now = Date.now();
      if(now - lastSave < 8000) return;
      lastSave = now;
      if(!currentFilm) return;
      const t = mtPlayer.currentTime, d = mtPlayer.duration;
      if(t && d) upsertContinueWatching(currentFilm.id, t, d);
    });
    audioEl.addEventListener('ended', ()=>{
      if(currentFilm) removeContinueWatching(currentFilm.id);
    });
  }

  // ── Stream actions (download + external player) — use first quality URL ──
  setStreamActions(videos[0].path, film.judul || film.title || '');

  // Resize player after layout settles
  setTimeout(()=>{ try{ mtPlayer && mtPlayer.resize(); }catch{} }, 200);
}

// ── Stream actions: download + external player URL schemes ──
function setStreamActions(url, title, downloadToken){
  const dl = document.getElementById('streamDlBtn');
  if(!dl){ return; } // Stream actions HTML removed — skip gracefully
  if(!url){ document.getElementById('streamActions').style.display='none'; return; }
  const enc = encodeURIComponent(title || '');
  let b64 = '';
  try{ b64 = btoa(unescape(encodeURIComponent(url))); }catch{}
  dl.href = url;
  dl.dataset.downloadToken = downloadToken || '';
  // Hint filename agar browser pakai nama film, bukan "download.aspx"
  dl.setAttribute('download', (title || 'video') + '.mp4');
  document.getElementById('streamUrlField').value = url;
  // Player schemes
  document.getElementById('externalPlayerIINA').href       = 'iina://weblink?url='+url;
  document.getElementById('externalPlayerPotPlayer').href  = 'potplayer://'+url;
  document.getElementById('externalPlayerVLCMobile').href  = 'vlc://'+url;
  document.getElementById('externalPlayerVLCDesk').href    = url;
  document.getElementById('externalPlayerNPlayer').href    = 'nplayer-'+url;
  document.getElementById('externalPlayerMpvAndroid').href = 'intent://'+url+'#Intent;type=video/any;package=is.xyz.mpv;scheme=https;end;';
  document.getElementById('externalPlayerMpvX64').href     = 'mpv://'+b64;
  document.getElementById('externalPlayerMXFree').href     = 'intent:'+url+'#Intent;package=com.mxtech.videoplayer.ad;S.title='+enc+';end';
  document.getElementById('externalPlayerMXPro').href      = 'intent:'+url+'#Intent;package=com.mxtech.videoplayer.pro;S.title='+enc+';end';
  document.getElementById('externalPlayer1DMFree').href    = 'intent:'+url+'#Intent;component=idm.internet.download.manager/idm.internet.download.manager.Downloader;S.title='+enc+';end';
  document.getElementById('externalPlayer1DMLite').href    = 'intent:'+url+'#Intent;component=idm.internet.download.manager.adm.lite/idm.internet.download.manager.Downloader;S.title='+enc+';end';
  document.getElementById('externalPlayer1DMPlus').href    = 'intent:'+url+'#Intent;component=idm.internet.download.manager.plus/idm.internet.download.manager.Downloader;S.title='+enc+';end';
  document.getElementById('streamActions').style.display = 'block';
}

function releaseVipDownloadSlot(){
  const dl = document.getElementById('streamDlBtn');
  const token = dl ? dl.dataset.downloadToken : '';
  if(!token) return;
  if(dl) dl.dataset.downloadToken = '';
  try{
    const blob = new Blob([JSON.stringify({ token })], { type:'application/json' });
    if(navigator.sendBeacon){
      navigator.sendBeacon('/api/drive/release', blob);
      return;
    }
  }catch{}
  fetch('/api/drive/release', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ token }),
    keepalive:true,
  }).catch(()=>{});
}

// Track active download slots per session, so we can show a clear message
// when the server says "max 2 concurrent" instead of letting the click fall
// through to a broken URL.
let _vipActiveDownloads = 0;

// Click handler for the DOWNLOAD button. Acquires a server-side slot first
// (max 2 concurrent per user, enforced in worker via active_downloads RPC).
// On 429 we toast and cancel the navigation. On success we follow the
// stream URL the server returned and schedule the slot release.
async function beginVipDownload(event, btn){
  if(!event || !btn) return false;
  event.preventDefault();
  if(btn.dataset.busy === '1') return false;
  if(currentTier !== 'vip'){ showToast('Download hanya untuk member VIP', 'error'); return false; }
  const film = currentFilm;
  if(!film || !(film.drive_path || film.drive_link)){
    showToast('File Drive belum terdaftar', 'error');
    return false;
  }
  if(_vipActiveDownloads >= 2){
    showToast('Maksimal 2 download berjalan sekaligus. Tunggu salah satunya selesai dulu.', 'error');
    return false;
  }

  btn.dataset.busy = '1';
  const labelEl = btn.querySelector('span');
  const origLabel = labelEl ? labelEl.textContent : '';
  if(labelEl) labelEl.textContent = 'PREPARING…';

  try{
    const param = film.drive_path
      ? 'path='+encodeURIComponent(film.drive_path)
      : 'link='+encodeURIComponent(film.drive_link);
    const r = await fetch('/api/drive/resolve?download=1&'+param, { headers: await authHeaders() });
    const d = await r.json();
    if(r.status === 429){
      showToast(d?.error || 'Maksimal 2 download berjalan sekaligus. Tunggu dulu.', 'error');
      return false;
    }
    if(!d || !d.ok || !d.stream_url){
      showToast(d?.error || 'Gagal siapkan download', 'error');
      return false;
    }
    _vipActiveDownloads++;
    btn.dataset.downloadToken = d.download_token || '';
    btn.href = d.stream_url;
    // Auto-release the slot after a generous TTL (server side TTL is the
    // authoritative one; this just cleans up the local counter).
    const releaseLater = (token) => {
      if(!token) return;
      _vipActiveDownloads = Math.max(0, _vipActiveDownloads - 1);
      // best-effort release on the server
      try{
        fetch('/api/drive/release', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ token }),
          keepalive:true,
        }).catch(()=>{});
      }catch{}
    };
    setTimeout(() => releaseLater(d.download_token), 30 * 60 * 1000);

    // Trigger the actual download by simulating a fresh anchor click. The
    // <a> already has the href set — but we need to bypass our own onclick
    // guard, so we open the URL via a temp link without the handler.
    const tmp = document.createElement('a');
    tmp.href = d.stream_url;
    tmp.download = btn.getAttribute('download') || '';
    document.body.appendChild(tmp);
    tmp.click();
    tmp.remove();
    showToast('Download dimulai. Maksimal 2 berjalan bersamaan.', 'success');
    return false;
  }catch(e){
    showToast('Network error: '+(e.message||'unknown'), 'error');
    return false;
  }finally{
    if(labelEl) labelEl.textContent = origLabel;
    btn.dataset.busy = '';
  }
}

function toggleExternalPlayerMenu(){
  const m = document.getElementById('externalPlayerMenu');
  m.style.display = (m.style.display === 'block') ? 'none' : 'block';
}

function copyStreamUrl(){
  const f = document.getElementById('streamUrlField');
  if(!f || !f.value) return;
  navigator.clipboard.writeText(f.value)
    .then(()=>{ const b=document.getElementById('streamCopyBtn'); if(b){ b.textContent='✓'; setTimeout(()=>b.textContent='⧉',1500); } })
    .catch(()=>{ try{ f.select(); document.execCommand('copy'); }catch{} });
}

// Tutup dropdown player eksternal saat klik di luar
document.addEventListener('click', function(e){
  const m = document.getElementById('externalPlayerMenu');
  const b = document.getElementById('externalPlayerBtn');
  if(!m || !b) return;
  if(!b.contains(e.target) && !m.contains(e.target)) m.style.display='none';
});
window.addEventListener('beforeunload', releaseVipDownloadSlot);

/* ═══════════════════════════════════════════════════════════════════
   PLAYER 2 — Vidstack web components.
   Default-theme video layout provides the entire player UI:
     play/pause/seek/volume/captions/PiP/fullscreen/keyboard/gestures.
   Multi-quality + multi-audio dropdowns are added next to the engine
   toggle (since native MP4 sources don't expose those to Vidstack).
   ═══════════════════════════════════════════════════════════════════ */

async function loadVideoEngine2(film, sources){
  const { videos, audios, subtitles } = sources;
  const wrap = document.getElementById('player2Wrap');
  const player = document.getElementById('p2VsPlayer');
  const aux = document.getElementById('p2AuxAudio');
  if(!wrap || !player || !aux){ console.error('Player 2 DOM missing'); return; }

  // Ensure no stale chips / blob URLs from a previous film when reloading on
  // the same engine (loadVideo path doesn't auto-teardown engine 2).
  if(p2State){
    if(p2State.subBlobUrls){
      for(const u of p2State.subBlobUrls){ try{ URL.revokeObjectURL(u); }catch{} }
    }
    if(p2State.qualityChip){ try{ p2State.qualityChip.remove(); }catch{} }
    if(p2State.audioChip){ try{ p2State.audioChip.remove(); }catch{} }
    const p2ov=document.getElementById('p2OverlayMenus');
    if(p2ov) try{ p2ov.remove(); }catch{}
    if(p2State.mse){
      p2State.mse.teardown = true;
      try{ p2State.mse.ms.endOfStream(); }catch{}
      try{ URL.revokeObjectURL(p2State.mse.blobUrl); }catch{}
    }
  }

  wrap.classList.add('show');

  // Convert any subtitle (SRT/VTT/ASS) to a VTT blob URL so Vidstack
  // can render it via the standard <track> element + native cues UI.
  const subBlobUrls = [];
  const trackEntries = [];
  for(let i = 0; i < subtitles.length; i++){
    const s = subtitles[i];
    try{
      const r = await fetch(s.path);
      const raw = await r.text();
      const vtt = _p2ToVtt(raw, s.path);
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      subBlobUrls.push(url);
      trackEntries.push({ src: url, label: s.name || ('Subtitle ' + (i+1)), language: s.language || '' });
    }catch(e){
      console.warn('subtitle load failed', s.path, e);
    }
  }

  // Initialise runtime state (used by chip menus)
  p2State = {
    film,
    videos,
    audios,
    subtitles,
    qualityIdx: 0,
    audioIdx: 0,
    subBlobUrls,
    qualityChip: null,
    audioChip: null,
    lastSavedAt: 0,
    _hookedTime: false,
    _useAux: audios.length > 1,   // only sync aux audio when there are multiple dub tracks
  };

  // Set Vidstack title + provider source. Pass an explicit type so URLs
  // without extensions (e.g. /download.aspx) resolve to the video provider.
  player.title = film.judul || film.title || '';

  // Try mp4box.js client-side demux when:
  //   - admin uploaded only ONE video file
  //   - admin did NOT upload separate audio_tracks
  // If the file turns out to be a multi-audio MP4, _p2TryMseMode wires
  // MediaSource Extensions and exposes the embedded audio tracks. If it
  // fails or returns false, fall back to the normal Vidstack <video> src.
  const canProbe = videos.length === 1 && audios.length <= 1 && typeof MP4Box !== 'undefined';
  let mseHandled = false;
  if(canProbe){
    try{
      mseHandled = await _p2TryMseMode(player, videos[0].path);
    }catch(e){
      console.warn('[p2] mp4box probe failed:', e);
      mseHandled = false;
    }
  }
  if(!mseHandled){
    player.src = { src: videos[0].path, type: _p2GuessVideoType(videos[0].path) };
  }

  // Build subtitle <track> children inside <media-provider>
  const provider = player.querySelector('media-provider');
  if(provider){
    provider.querySelectorAll('track').forEach(t=>t.remove());
  }
  // Also register subtitles via Vidstack API so hasCaptions()=true
  // and the built-in captions menu appears in the settings gear.
  // Clear old text tracks first.
  try{
    while(player.textTracks && player.textTracks.length){
      player.textTracks.remove(0);
    }
  }catch(e){}
  for(const t of trackEntries){
    try{
      player.textTracks.add({
        src: t.src,
        label: t.label,
        language: t.language || 'und',
        kind: 'subtitles',
      });
    }catch(e){
      console.warn('[p2] textTracks.add failed:', e);
      // Fallback: raw <track> element in provider
      if(provider){
        const tr = document.createElement('track');
        tr.kind = 'subtitles';
        tr.src = t.src;
        tr.label = t.label;
        if(t.language) tr.srclang = t.language;
        provider.appendChild(tr);
      }
    }
  }

  // Multi-dub auxiliary audio
  if(p2State._useAux){
    aux.src = audios[0].path;
    aux.muted = false;
    aux.volume = 1;
    aux.load();
  }else{
    aux.removeAttribute('src');
    aux.load();
  }

  // Wire Vidstack <-> aux audio sync, and build quality/audio chips next to engine toggle
  _p2WireVidstack(player, aux, film);

  // Compat shim so legacy code referring to videoPlayer keeps working
  videoPlayer = {
    pause: ()=>{ try{ player.pause(); }catch{} },
    play:  ()=>{ try{ player.play();  }catch{} },
    paused: ()=> player.paused,
    currentTime: function(t){
      if(t === undefined) return player.currentTime || 0;
      try{ player.currentTime = t; }catch{}
    },
    duration: function(){ return player.duration || 0; },
    playbackRate: function(r){
      if(r === undefined) return player.playbackRate || 1;
      try{ player.playbackRate = r; }catch{}
    },
    muted: function(m){ if(m === undefined) return player.muted; try{ player.muted = m; }catch{} },
    volume: function(vol){ if(vol === undefined) return player.volume; try{ player.volume = vol; }catch{} },
    src: ()=>{}, load: ()=>{}, on: ()=>{},
    audioTracks: ()=>null,
    addRemoteTextTrack: ()=>{}, remoteTextTracks: ()=>[], removeRemoteTextTrack: ()=>{},
  };

  // Resume position once metadata is loaded
  if(currentResumeFrom && currentResumeFrom > 5){
    const seek = ()=>{ try{ player.currentTime = currentResumeFrom; }catch{} };
    player.addEventListener('loaded-metadata', seek, { once: true });
  }

  setStreamActions(videos[0].path, film.judul || film.title || '');
}

/* ─── P2 Overlay Menus — Audio & Quality buttons inside the player ─── */
// Creates or updates overlay audio/quality buttons on the player.
// These appear in the top-right area of the player (same zone as Vidstack's gear).
function _p2InjectOverlays(){
  const old = document.getElementById('p2OverlayMenus');
  if(old) old.remove();
  const wrap = document.getElementById('player2Wrap');
  if(!wrap || !p2State) return;
  const hasMultiAudio = p2State.audios && p2State.audios.length > 1 && p2State._useAux;
  const hasMultiVideo = p2State.videos && p2State.videos.length > 1;
  const hasMseAudio = p2State.mse && p2State.mse.audioTracks && p2State.mse.audioTracks.length > 1;
  if(!hasMultiAudio && !hasMultiVideo && !hasMseAudio) return;
  const div = document.createElement('div');
  div.id = 'p2OverlayMenus';
  // Audio button (aux multi-dub)
  if(hasMultiAudio){
    const label = p2State.audios[p2State.audioIdx]?.name || ('Audio '+(p2State.audioIdx+1));
    const dd = _p2BuildOverlayDropdown(label, p2State.audios.map((a,i)=>({label:a.name||('Audio '+(i+1)),active:i===p2State.audioIdx,onSelect:()=>{_p2SwitchAudio(i);_p2InjectOverlays();}})));
    div.appendChild(dd);
  }
  // Audio button (MSE embedded multi-audio)
  if(hasMseAudio){
    const mse=p2State.mse; const at=mse.audioTracks.find(t=>t.id===mse.activeAudioId);
    const label=(at?.name||at?.language||'').replace(/und/i,'').trim()||'Audio1';
    const dd=_p2BuildOverlayDropdown(label,mse.audioTracks.map((t,i)=>({label:(t.name||t.language||'A'+(i+1)).replace(/und/i,'').trim().toUpperCase()||'A'+(i+1),active:t.id===mse.activeAudioId,onSelect:()=>{_p2MseSwitchAudio(t.id).catch(console.error);}})));
    div.appendChild(dd);
  }
  // Quality button
  if(hasMultiVideo){
    const label=p2State.videos[p2State.qualityIdx]?.name||('Q'+(p2State.qualityIdx+1));
    const dd=_p2BuildOverlayDropdown(label,p2State.videos.map((v,i)=>({label:v.name||'Kualitas '+(i+1),active:i===p2State.qualityIdx,onSelect:()=>{_p2SwitchQuality(i);_p2InjectOverlays();}})));
    div.appendChild(dd);
  }
  wrap.appendChild(div);
}
// Build a single dropdown button (label + chevron + dropdown menu)
function _p2BuildOverlayDropdown(currentLabel, items){
  const c=document.createElement('div'); c.className='p2-overlay-dropdown';
  const btn=document.createElement('button'); btn.className='p2-overlay-btn';
  btn.innerHTML='<span class="p2-overlay-label">'+currentLabel+'</span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" class="p2-overlay-chevron"><path d="M7 10l5 5 5-5z"/></svg>';
  const menu=document.createElement('div'); menu.className='p2-overlay-menu';
  for(let i=0;i<items.length;i++){
    const it=items[i],el=document.createElement('div'); el.className='p2-overlay-item'+(it.active?' active':'');
    el.textContent=it.label; el.addEventListener('click',e=>{e.stopPropagation();c.classList.remove('open');it.onSelect();});
    menu.appendChild(el);
  }
  btn.addEventListener('click',e=>{e.stopPropagation();c.classList.toggle('open');});
  function ch(e){if(!c.contains(e.target))c.classList.remove('open');}
  document.addEventListener('click',ch); c._p2CloseHandler=ch;
  c.appendChild(btn); c.appendChild(menu); return c;
}

function _p2WireVidstack(player, aux, film){
  // Inject custom audio & quality overlays INTO the player (top-right area)
  if(p2State){
    _p2InjectOverlays();
  }

  // When aux audio is in use, mute provider so only <audio> drives sound.
  try{ player.muted = !!p2State._useAux; }catch{}

  // Wire all event listeners ONCE per player element (they read live p2State)
  if(player._p2VsHooked) return;
  player._p2VsHooked = true;

  const sync = ()=>{
    if(!p2State || !p2State._useAux) return;
    try{
      const dt = aux.currentTime - player.currentTime;
      if(Math.abs(dt) > 0.25) aux.currentTime = player.currentTime;
      else if(Math.abs(dt) > 0.05) aux.playbackRate = (player.playbackRate || 1) * (dt > 0 ? 0.97 : 1.03);
      else aux.playbackRate = (player.playbackRate || 1);
    }catch{}
  };
  player.addEventListener('play', ()=>{
    if(p2State && p2State._useAux){
      try{ aux.currentTime = player.currentTime; }catch{}
      aux.play().catch(()=>{});
    }
  });
  player.addEventListener('pause', ()=>{
    if(p2State && p2State._useAux){ try{ aux.pause(); }catch{} }
  });
  player.addEventListener('seeking', ()=>{
    if(p2State && p2State._useAux){ try{ aux.currentTime = player.currentTime; }catch{} }
  });
  player.addEventListener('seeked',  ()=>{
    if(p2State && p2State._useAux){ try{ aux.currentTime = player.currentTime; }catch{} }
  });
  player.addEventListener('rate-change', ()=>{
    if(p2State && p2State._useAux){ try{ aux.playbackRate = player.playbackRate; }catch{} }
  });
  player.addEventListener('volume-change', ()=>{
    if(p2State && p2State._useAux){
      try{ aux.volume = player.volume; aux.muted = player.muted ? false : aux.muted; }catch{}
    }
  });

  // Save Continue Watching every ~8s + sync aux audio
  player.addEventListener('time-update', ()=>{
    if(!p2State) return;
    sync();
    const now = Date.now();
    if(now - p2State.lastSavedAt < 8000) return;
    p2State.lastSavedAt = now;
    const t = player.currentTime, d = player.duration;
    if(currentFilm && t && d) upsertContinueWatching(currentFilm.id, t, d);
  });
  player.addEventListener('ended', ()=>{
    if(currentFilm) removeContinueWatching(currentFilm.id);
  });
}

function _p2BuildChip(label, items){
  // Small dropdown chip styled to match .player-engine-bar
  const chip = document.createElement('div');
  chip.className = 'player-engine-chip';
  chip.innerHTML =
    '<button type="button" class="player-engine-chip-btn">'+
      '<span class="player-engine-chip-label">'+label+':</span>' +
      '<span class="player-engine-chip-val">'+(items.find(i=>i.active)||items[0]||{}).label+'</span>' +
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>' +
    '</button>' +
    '<div class="player-engine-chip-menu"></div>';
  const menu = chip.querySelector('.player-engine-chip-menu');
  const valEl = chip.querySelector('.player-engine-chip-val');
  const btn = chip.querySelector('.player-engine-chip-btn');
  function rebuildMenu(){
    menu.innerHTML = items.map((it, i)=>(
      '<div class="player-engine-chip-item '+(it.active?'active':'')+'" data-idx="'+i+'">'+it.label+'</div>'
    )).join('');
    menu.querySelectorAll('.player-engine-chip-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const i = parseInt(el.dataset.idx, 10);
        items.forEach((it, j)=>{ it.active = (j === i); });
        valEl.textContent = items[i].label;
        chip.classList.remove('open');
        items[i].onSelect();
      });
    });
  }
  rebuildMenu();
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    chip.classList.toggle('open');
  });
  document.addEventListener('click', (e)=>{
    if(!chip.contains(e.target)) chip.classList.remove('open');
  });
  return chip;
}

/* ─────────────────────────────────────────────────────────────────
   mp4box.js + MediaSource Extensions client-side demuxer.
   When a film is uploaded as one MP4 with multiple audio tracks
   embedded (e.g. ENG + IND in a single file), Chrome's HTMLMediaElement
   will only expose track 0. This routine bypasses that limitation by:
     1. Streaming the MP4 in 4 MB chunks via HTTP Range requests.
     2. Feeding chunks to mp4box.js so it can parse the moov atom.
     3. On 'ready', enumerating the file's audio tracks.
     4. If 2+ audio tracks: setting up a MediaSource with one video
        SourceBuffer + one audio SourceBuffer (the user-selected track).
     5. Audio chip menu ("Audio: ENG ▾") swaps the active audio track —
        we detach the audio SourceBuffer, recreate it for the new track,
        and replay buffered samples from current time.
   Returns true if MSE mode was activated (caller skips the normal
   Vidstack src assignment), false otherwise.
   ───────────────────────────────────────────────────────────────── */

const _P2_CHUNK = 4 * 1024 * 1024;     // 4 MB per Range request

async function _p2TryMseMode(player, url){
  // 1. Quick guard: only attempt if browser supports MediaSource + MP4
  if(typeof MediaSource === 'undefined') return false;
  const mp4MimeProbe = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
  if(!MediaSource.isTypeSupported(mp4MimeProbe)) return false;

  // 2. Probe the file: feed Range chunks to mp4box.js until onReady fires.
  //    Most fast-start MP4s yield moov within the first few MB.
  const mp4 = MP4Box.createFile();
  let info = null;
  let probeAborted = false;
  const onReadyP = new Promise((resolve, reject)=>{
    mp4.onError = (e)=>{ if(!info) reject(new Error('mp4box: '+e)); };
    mp4.onReady = (i)=>{ info = i; resolve(i); };
  });

  let nextStart = 0;
  let totalSize = -1;
  let probedBytes = 0;
  const PROBE_BUDGET = 30 * 1024 * 1024;   // give up if no moov in first 30 MB

  async function fetchRange(start, end){
    const r = await fetch(url, { headers: { 'Range': 'bytes='+start+'-'+end } });
    if(!r.ok && r.status !== 206) throw new Error('Range fetch failed: '+r.status);
    if(totalSize < 0){
      const cr = r.headers.get('Content-Range');
      if(cr){ const m = cr.match(/\/(\d+)\s*$/); if(m) totalSize = parseInt(m[1], 10); }
    }
    return r.arrayBuffer();
  }

  // Probe loop — run until onReady or budget exhausted.
  while(!info && probedBytes < PROBE_BUDGET && !probeAborted){
    const buf = await fetchRange(nextStart, nextStart + _P2_CHUNK - 1);
    if(buf.byteLength === 0) break;
    buf.fileStart = nextStart;
    mp4.appendBuffer(buf);
    nextStart += buf.byteLength;
    probedBytes += buf.byteLength;
    // Yield to the microtask queue so onReady can fire if moov landed
    await new Promise(r => setTimeout(r, 0));
  }
  // moov could be at the end of the file (non-faststart). Try the tail too.
  if(!info && totalSize > 0){
    const tailStart = Math.max(0, totalSize - 8 * 1024 * 1024);
    if(tailStart > nextStart){
      const tailBuf = await fetchRange(tailStart, totalSize - 1);
      tailBuf.fileStart = tailStart;
      mp4.appendBuffer(tailBuf);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if(!info){ try{ mp4.flush(); }catch{} }
  if(!info){ console.info('[p2] mp4box: no moov detected, falling back'); return false; }

  // 3. Inspect audio track count
  const audioTracks = info.tracks.filter(t => t.type === 'audio' || (t.codec && /^mp4a|^opus|^vorbis|^ec-3|^ac-3/.test(t.codec)));
  const videoTracks = info.tracks.filter(t => t.type === 'video' || (t.codec && /^avc|^hev|^hvc|^vp0?9|^av01/.test(t.codec)));
  if(audioTracks.length < 2 || videoTracks.length === 0){
    console.info('[p2] mp4box: not multi-audio (audios='+audioTracks.length+'); falling back');
    return false;
  }
  console.info('[p2] mp4box: multi-audio MP4 detected:', audioTracks.length, 'audio tracks');

  // 4. Set up MediaSource pipeline
  const ms = new MediaSource();
  const blobUrl = URL.createObjectURL(ms);
  player.src = { src: blobUrl, type: 'video/mp4' };

  // Honour an explicit pre-selected audio track (used during track switch)
  const overrideId = p2State && p2State._mseOverrideAudioId;
  const initialAudioTrack = (overrideId && audioTracks.find(t => t.id === overrideId)) || audioTracks[0];

  const mseState = {
    url, totalSize, info, mp4,
    ms, blobUrl,
    videoTrack: videoTracks[0],
    audioTracks,
    activeAudioId: initialAudioTrack.id,
    videoSb: null,
    audioSb: null,
    nextDownloadStart: nextStart,
    downloading: false,
    teardown: false,
    queueV: [], queueA: [],
  };
  p2State.mse = mseState;

  // Refresh overlay buttons instead of building external chips
  _p2InjectOverlays();

  await new Promise((resolve)=>{
    ms.addEventListener('sourceopen', ()=>{
      try{
        const vMime = 'video/mp4; codecs="' + mseState.videoTrack.codec + '"';
        const aMime = 'audio/mp4; codecs="' + audioTracks.find(t=>t.id===mseState.activeAudioId).codec + '"';
        if(!MediaSource.isTypeSupported(vMime) || !MediaSource.isTypeSupported(aMime)){
          throw new Error('codec not supported by browser: '+vMime+' / '+aMime);
        }
        mseState.videoSb = ms.addSourceBuffer(vMime);
        mseState.audioSb = ms.addSourceBuffer(aMime);
        mseState.videoSb.addEventListener('updateend', ()=> _p2MseDrain(mseState, 'v'));
        mseState.audioSb.addEventListener('updateend', ()=> _p2MseDrain(mseState, 'a'));
        // Tell mp4box which tracks to extract and how many samples per segment
        mp4.setSegmentOptions(mseState.videoTrack.id, mseState.videoSb, { nbSamples: 100 });
        mp4.setSegmentOptions(mseState.activeAudioId,  mseState.audioSb, { nbSamples: 100 });
        // Handle init segments
        const initSegs = mp4.initializeSegmentation();
        for(const seg of initSegs){
          if(seg.user === mseState.videoSb)      mseState.queueV.push(seg.buffer);
          else if(seg.user === mseState.audioSb) mseState.queueA.push(seg.buffer);
        }
        // mp4box extraction callback for media segments
        mp4.onSegment = (id, user, buffer, sampleNum, isLast)=>{
          if(mseState.teardown) return;
          if(user === mseState.videoSb)      mseState.queueV.push(buffer);
          else if(user === mseState.audioSb) mseState.queueA.push(buffer);
          _p2MseDrain(mseState, 'v');
          _p2MseDrain(mseState, 'a');
        };
        mp4.start();
        _p2MseDrain(mseState, 'v');
        _p2MseDrain(mseState, 'a');
        // Continue downloading the rest of the file in the background
        _p2MseDownloadLoop(mseState);
        resolve();
      }catch(e){
        console.error('[p2] sourceopen wiring failed:', e);
        // Best-effort fallback: nuke MSE, let caller retry with native src
        try{ URL.revokeObjectURL(blobUrl); }catch{}
        p2State.mse = null;
        resolve();
      }
    }, { once: true });
  });

  // If sourceopen failed and cleared mse, signal caller to fall back
  return !!p2State.mse;
}

function _p2MseDrain(state, which){
  if(state.teardown) return;
  const sb = which === 'v' ? state.videoSb : state.audioSb;
  const q  = which === 'v' ? state.queueV  : state.queueA;
  if(!sb || sb.updating || q.length === 0) return;
  try{ sb.appendBuffer(q.shift()); }
  catch(e){ console.warn('[p2] sb.appendBuffer error', e); }
}

async function _p2MseDownloadLoop(state){
  if(state.downloading) return;
  state.downloading = true;
  try{
    while(!state.teardown && (state.totalSize < 0 || state.nextDownloadStart < state.totalSize)){
      const start = state.nextDownloadStart;
      const end = state.totalSize > 0 ? Math.min(start + _P2_CHUNK - 1, state.totalSize - 1) : (start + _P2_CHUNK - 1);
      const r = await fetch(state.url, { headers: { 'Range': 'bytes='+start+'-'+end } });
      if(!r.ok && r.status !== 206) throw new Error('range fetch failed: '+r.status);
      if(state.totalSize < 0){
        const cr = r.headers.get('Content-Range');
        if(cr){ const m = cr.match(/\/(\d+)\s*$/); if(m) state.totalSize = parseInt(m[1], 10); }
      }
      const buf = await r.arrayBuffer();
      if(buf.byteLength === 0) break;
      buf.fileStart = start;
      state.mp4.appendBuffer(buf);
      state.nextDownloadStart += buf.byteLength;
      // small tick so we don't peg the main thread
      await new Promise(r => setTimeout(r, 0));
    }
    if(!state.teardown){
      state.mp4.flush();
      try{ state.ms.endOfStream(); }catch{}
    }
  }catch(e){
    console.error('[p2] mse download loop failed:', e);
  }finally{
    state.downloading = false;
  }
}

async function _p2MseSwitchAudio(newAudioId){
  if(!p2State || !p2State.mse) return;
  const state = p2State.mse;
  if(state.activeAudioId === newAudioId) return;
  const newTrack = state.audioTracks.find(t=>t.id===newAudioId);
  if(!newTrack){ return; }
  const aMime = 'audio/mp4; codecs="' + newTrack.codec + '"';
  if(!MediaSource.isTypeSupported(aMime)){
    showToast('Codec audio tidak didukung browser: '+newTrack.codec, 'error');
    return;
  }
  const player = document.getElementById('p2VsPlayer');
  const t = player.currentTime || 0;
  const wasPlaying = !player.paused;
  // mp4box does not support live re-segmenting of an additional track on
  // an already-running file. Simplest reliable path: tear down the MSE,
  // re-probe & re-init with the new selected track. This re-downloads
  // the moov + initial chunks but re-uses HTTP cache for everything else.
  state.teardown = true;
  try{ state.ms.endOfStream(); }catch{}
  try{ URL.revokeObjectURL(state.blobUrl); }catch{}
  p2State.mse = null;

  // Spin up a fresh MSE pipeline preferring the requested audio track
  await _p2TryMseModeWithAudio(player, state.url, newAudioId, t, wasPlaying);
}

async function _p2TryMseModeWithAudio(player, url, preferredAudioId, resumeTime, wasPlaying){
  // Wrapper that calls _p2TryMseMode but seeds the active audio choice.
  // Implemented by setting a one-shot override on p2State so the next
  // probe picks `preferredAudioId` as the default audio.
  p2State._mseOverrideAudioId = preferredAudioId;
  p2State._mseResumeTime = resumeTime;
  p2State._mseResumeWasPlaying = !!wasPlaying;
  const ok = await _p2TryMseMode(player, url);
  if(ok){
    const seek = ()=>{
      try{ player.currentTime = resumeTime; }catch{}
      if(wasPlaying){ try{ player.play(); }catch{} }
    };
    player.addEventListener('loaded-metadata', seek, { once: true });
    setTimeout(seek, 800);  // safety net if event already fired
  }
  delete p2State._mseOverrideAudioId;
}

function _p2GuessVideoType(url){
  const lower = (url || '').toLowerCase().split('?')[0];
  if(lower.endsWith('.m3u8')) return 'application/x-mpegurl';
  if(lower.endsWith('.mpd'))  return 'application/dash+xml';
  if(lower.endsWith('.webm')) return 'video/webm';
  if(lower.endsWith('.ogv') || lower.endsWith('.ogg')) return 'video/ogg';
  if(lower.endsWith('.mkv'))  return 'video/x-matroska';
  // Default — Chrome will try the file as MP4 and most non-MP4 files will
  // surface a normal "format not supported" media error from Vidstack.
  return 'video/mp4';
}

function _p2SwitchQuality(i){
  if(!p2State || i < 0 || i >= p2State.videos.length || i === p2State.qualityIdx) return;
  const player = document.getElementById('p2VsPlayer');
  const t = player.currentTime || 0;
  const wasPlaying = !player.paused;
  p2State.qualityIdx = i;
  player.src = { src: p2State.videos[i].path, type: _p2GuessVideoType(p2State.videos[i].path) };
  // Restore time once new source is ready
  player.addEventListener('loaded-metadata', ()=>{
    try{ player.currentTime = t; }catch{}
    if(wasPlaying){ try{ player.play(); }catch{} }
  }, { once: true });
}

function _p2SwitchAudio(i){
  if(!p2State || i < 0 || i >= p2State.audios.length || i === p2State.audioIdx) return;
  const aux = document.getElementById('p2AuxAudio');
  const player = document.getElementById('p2VsPlayer');
  const t = player.currentTime || 0;
  const wasPlaying = !player.paused;
  p2State.audioIdx = i;
  aux.src = p2State.audios[i].path;
  aux.load();
  aux.addEventListener('loadedmetadata', ()=>{
    try{ aux.currentTime = t; }catch{}
    if(wasPlaying){ aux.play().catch(()=>{}); }
  }, { once: true });
}

// Convert SRT or ASS subtitle text to WebVTT so it can be assigned to a
// native <track> element. VTT input is returned unchanged.
function _p2ToVtt(txt, path){
  const lower = (path || '').toLowerCase();
  if(/^WEBVTT/.test(txt.trim())) return txt;
  if(lower.endsWith('.ass') || lower.endsWith('.ssa') || /^\[Script Info\]/m.test(txt)){
    return _p2AssToVtt(txt);
  }
  return _p2SrtToVtt(txt);
}
function _p2SrtToVtt(srt){
  // Basic SRT → VTT: replace "," with "." in timestamps, drop numeric indices.
  const out = ['WEBVTT', ''];
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  for(const b of blocks){
    const lines = b.split('\n').filter(Boolean);
    if(!lines.length) continue;
    let i = 0;
    if(/^\d+$/.test(lines[0])) i = 1;
    if(!lines[i]) continue;
    const tline = lines[i].replace(/,/g, '.');
    out.push(tline);
    for(let j = i + 1; j < lines.length; j++) out.push(lines[j]);
    out.push('');
  }
  return out.join('\n');
}
function _p2AssToVtt(ass){
  const out = ['WEBVTT', ''];
  const lines = ass.split(/\r?\n/);
  let format = null;
  function fmtTs(s){
    // ASS time: H:MM:SS.cc (centiseconds) → HH:MM:SS.mmm
    const m = s.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})$/);
    if(!m) return s;
    const h = String(parseInt(m[1],10)).padStart(2,'0');
    const mi = String(parseInt(m[2],10)).padStart(2,'0');
    const se = String(parseInt(m[3],10)).padStart(2,'0');
    const ms = String(parseInt(m[4],10)*10).padStart(3,'0');
    return h+':'+mi+':'+se+'.'+ms;
  }
  for(const ln of lines){
    if(/^Format:/i.test(ln) && /Start/i.test(ln) && /End/i.test(ln)){
      format = ln.replace(/^Format:\s*/i,'').split(',').map(s=>s.trim());
    }else if(/^Dialogue:/i.test(ln) && format){
      const fields = ln.replace(/^Dialogue:\s*/i,'').split(',');
      const sIdx = format.indexOf('Start');
      const eIdx = format.indexOf('End');
      const tIdx = format.indexOf('Text');
      if(sIdx < 0 || eIdx < 0 || tIdx < 0) continue;
      const text = fields.slice(tIdx).join(',')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N|\\n/gi, '\n')
        .trim();
      if(!text) continue;
      out.push(fmtTs(fields[sIdx]) + ' --> ' + fmtTs(fields[eIdx]));
      out.push(text);
      out.push('');
    }
  }
  return out.join('\n');
}


// ════════════════════════════════════════════════════════════════════
// ENGINE 3 — Shaka Player (multi-track, multi-audio, multi-sub native)
// ════════════════════════════════════════════════════════════════════
let shakaPlayer = null;
let shakaState = null;
let shakaUi = null;
const _manifestStore = {};

// Escape XML special chars for MPD generation
function escXml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

// ── Probe MP4 init range (ftyp + moov) for correct DASH SegmentBase ──
async function _probeMp4InitRange(url){
  try{
    const resp = await fetch(url, { headers: { Range: 'bytes=0-63' } });
    const buf = await resp.arrayBuffer();
    const dv = new DataView(buf);
    // Parse ftyp box
    const ftypSize = dv.getUint32(0);
    if(ftypSize < 8 || ftypSize > 64) return null;
    // Parse moov box (right after ftyp)
    const moovOffset = ftypSize;
    if(moovOffset + 8 > buf.byteLength) return null;
    const moovSize = dv.getUint32(moovOffset);
    const moovType = String.fromCharCode(
      dv.getUint8(moovOffset+4), dv.getUint8(moovOffset+5),
      dv.getUint8(moovOffset+6), dv.getUint8(moovOffset+7)
    );
    if(moovType !== 'moov') return null;
    return '0-' + (ftypSize + moovSize - 1);
  }catch(e){
    console.warn('MP4 probe failed for', url, e);
    return null;
  }
}

// ── Convert SRT subtitle to VTT blob URL ──
async function _srtToVttBlobUrl(srtUrl){
  try{
    const resp = await fetch(srtUrl);
    const srt = await resp.text();
    // SRT → VTT: add WEBVTT header, replace comma with dot in timestamps
    const vtt = 'WEBVTT\n\n' + srt
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    const blob = new Blob([vtt], { type: 'text/vtt' });
    return URL.createObjectURL(blob);
  }catch(e){
    console.warn('SRT→VTT conversion failed:', e);
    return null;
  }
}

// ── Language display name mapping ──
function _langName(lang, fallback){
  const M = { id:'Indonesia', en:'English', ja:'Japanese', ko:'Korean', zh:'Chinese', ar:'Arabic', und:'Original', hi:'Hindi', th:'Thai', vi:'Vietnamese', ms:'Melayu', fr:'French', es:'Spanish', de:'German', ru:'Russian', pt:'Portuguese', tr:'Turkish' };
  return M[(lang||'').toLowerCase()] || fallback || 'Track';
}

// ── VTT time parser for fallback subtitle overlay ──
function _parseVttTime(t){
  var parts = t.split(':');
  if(parts.length === 3){
    return parseFloat(parts[0])*3600 + parseFloat(parts[1])*60 + parseFloat(parts[2].replace(',','.'));
  }else if(parts.length === 2){
    return parseFloat(parts[0])*60 + parseFloat(parts[1].replace(',','.'));
  }
  return parseFloat(t.replace(',','.')) || 0;
}

// ── Inject custom audio/subtitle track controls (always visible) ──
// Shaka UI auto-hides audio_language/text_language buttons when ≤1 track.
// This builds custom dropdowns that always show, with proper display names.
function _injectTrackControls(wrap, player, audios, vttSubs, fallbackObj){
  // Remove existing custom controls
  const ex = wrap.querySelector('.ctc');
  if(ex) ex.remove();
  if(!audios.length && !vttSubs.length) return;

  // Ensure wrap is positioned for absolute overlay
  if(getComputedStyle(wrap).position === 'static'){
    wrap.style.position = 'relative';
  }

  const div = document.createElement('div');
  div.className = 'ctc';
  div.innerHTML = '<style>' +
    '.ctc { position:absolute; bottom:52px; right:12px; display:flex; gap:8px; z-index:25; }' +
    '.ctc .tc { position:relative; }' +
    '.ctc .tb { background:rgba(0,0,0,.7); color:#fff; border:1px solid rgba(255,255,255,.25); border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:5px; font-family:inherit; white-space:nowrap; }' +
    '.ctc .tb:hover { background:rgba(0,0,0,.9); }' +
    '.ctc .tm { display:none; position:absolute; bottom:100%; right:0; margin-bottom:4px; background:rgba(0,0,0,.95); border:1px solid rgba(255,255,255,.2); border-radius:6px; min-width:130px; max-height:220px; overflow-y:auto; z-index:26; }' +
    '.ctc .tm.o { display:block; }' +
    '.ctc .to { padding:8px 14px; color:#fff; font-size:12px; cursor:pointer; white-space:nowrap; }' +
    '.ctc .to:hover { background:rgba(255,255,255,.15); }' +
    '.ctc .to.a { background:rgba(100,149,237,.3); font-weight:600; }' +
    '</style>';

  function closeAllMenus(){
    div.querySelectorAll('.tm').forEach(function(m){ m.classList.remove('o'); });
  }

  // Audio control
  if(audios.length){
    const tc = document.createElement('div');
    tc.className = 'tc';
    var audioBtn = document.createElement('button');
    audioBtn.className = 'tb';
    var a0 = audios[0];
    var a0name = _langName(a0.language, a0.name);
    audioBtn.innerHTML = '<span>🎤</span><span class="tn">' + a0name + '</span>';
    var audioMenu = document.createElement('div');
    audioMenu.className = 'tm';
    audios.forEach(function(a, i){
      var opt = document.createElement('div');
      opt.className = 'to' + (i === 0 ? ' a' : '');
      var dn = _langName(a.language, a.name);
      opt.textContent = dn;
      opt.addEventListener('click', function(e){
        e.stopPropagation();
        try{ player.selectAudioLanguage(a.language || 'und'); }catch(err){ console.warn('audio select failed', err); }
        audioBtn.querySelector('.tn').textContent = dn;
        audioMenu.querySelectorAll('.to').forEach(function(o){ o.classList.remove('a'); });
        opt.classList.add('a');
        closeAllMenus();
      });
      audioMenu.appendChild(opt);
    });
    audioBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = audioMenu.classList.contains('o');
      closeAllMenus();
      if(!open) audioMenu.classList.add('o');
    });
    tc.appendChild(audioBtn);
    tc.appendChild(audioMenu);
    div.appendChild(tc);
  }

  // Subtitle control
  // ── Null-guard: player may be null (Engine3 fallback path) ──
  var _playerHasTextTracks = player && typeof player.getTextTracks === 'function';
  if(vttSubs.length && _playerHasTextTracks){
    var textTracks = player.getTextTracks();
    var subBtn = document.createElement('button');
    subBtn.className = 'tb';
    subBtn.innerHTML = '<span>💬</span><span class="tn">Off</span>';
    var subMenu = document.createElement('div');
    subMenu.className = 'tm';

    var offOpt = document.createElement('div');
    offOpt.className = 'to a';
    offOpt.textContent = 'Off';
    offOpt.addEventListener('click', function(e){
      e.stopPropagation();
      try{ player.setTextTrackVisibility(false); }catch(err){}
      subBtn.querySelector('.tn').textContent = 'Off';
      subMenu.querySelectorAll('.to').forEach(function(o){ o.classList.remove('a'); });
      offOpt.classList.add('a');
      closeAllMenus();
    });
    subMenu.appendChild(offOpt);

    vttSubs.forEach(function(s, i){
      var opt = document.createElement('div');
      opt.className = 'to';
      var dn = _langName(s.language, s.label);
      opt.textContent = dn;
      opt.addEventListener('click', function(e){
        e.stopPropagation();
        // Use selectTextTrack with track object (more reliable than selectTextLanguage)
        var track = textTracks[i];
        if(track){
          try{ player.selectTextTrack(track); }catch(err){
            // Fallback: selectTextLanguage
            try{ player.selectTextLanguage(s.language || 'und'); }catch(err2){}
          }
        } else {
          try{ player.selectTextLanguage(s.language || 'und'); }catch(err){}
        }
        try{ player.setTextTrackVisibility(true); }catch(err){}
        subBtn.querySelector('.tn').textContent = dn;
        subMenu.querySelectorAll('.to').forEach(function(o){ o.classList.remove('a'); });
        opt.classList.add('a');
        closeAllMenus();
      });
      subMenu.appendChild(opt);
    });

    // Check initial subtitle state (Shaka may auto-enable via preferredTextLanguage)
    try{
      if(player.isTextTrackVisible() && textTracks.length){
        var activeT = textTracks.find(function(t){ return t.active === true; });
        if(activeT){
          var idx = textTracks.indexOf(activeT);
          if(idx >= 0 && idx < vttSubs.length){
            subBtn.querySelector('.tn').textContent = _langName(vttSubs[idx].language, vttSubs[idx].label);
            subMenu.querySelectorAll('.to').forEach(function(o){ o.classList.remove('a'); });
            subMenu.children[idx + 1].classList.add('a'); // +1 offset for "Off" option
          }
        }
      }
    }catch(e){}

    subBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var open = subMenu.classList.contains('o');
      closeAllMenus();
      if(!open) subMenu.classList.add('o');
    });

    var stc = document.createElement('div');
    stc.className = 'tc';
    stc.appendChild(subBtn);
    stc.appendChild(subMenu);
    div.appendChild(stc);
  }

  // Close menus on outside click (auto-cleans when div removed)
  document.addEventListener('click', function handler(){
    if(!div.parentNode){
      document.removeEventListener('click', handler);
      return;
    }
    closeAllMenus();
  });

  wrap.appendChild(div);
}

// ── Native fallback for R2 files (play video + separate audio with RAF sync) ──
var _fallbackAudioEl = null;
var _fallbackAudioIdx = 0;
var _fallbackRafId = null;
var _fallbackSyncActive = false;

function _startFallbackSync(audioEl, videoEl){
  _fallbackAudioEl = audioEl;
  function syncLoop(){
    if(!_fallbackSyncActive || !videoEl || !audioEl || !audioEl.src){ _fallbackRafId = null; return; }
    // Precise RAF-based sync: correct drift every frame
    if(audioEl.readyState >= 2 && videoEl.readyState >= 2){
      var diff = audioEl.currentTime - videoEl.currentTime;
      if(Math.abs(diff) > 0.3){
        audioEl.currentTime = videoEl.currentTime;
      }
    }
    _fallbackRafId = requestAnimationFrame(syncLoop);
  }
  _fallbackSyncActive = true;
  if(_fallbackRafId) cancelAnimationFrame(_fallbackRafId);
  _fallbackRafId = requestAnimationFrame(syncLoop);
}

function _stopFallbackSync(){
  _fallbackSyncActive = false;
  if(_fallbackRafId){ cancelAnimationFrame(_fallbackRafId); _fallbackRafId = null; }
}

// ── Engine 3 overlay buttons (inside player, same style as Engine 2) ──
// Replaces _injectTrackControls external chips with overlay dropdowns.
function _p3InjectOverlays(wrap, video, videoInits, audios, vttSubs, fbc){
  // Clean old overlays
  const old = document.getElementById('p3OverlayMenus');
  if(old) old.remove();
  if(!audios.length && !vttSubs.length) return;
  const div = document.createElement('div');
  div.id = 'p3OverlayMenus';
  div.style.cssText = 'position:absolute; top:12px; right:60px; z-index:8; display:flex; gap:6px; align-items:center; pointer-events:none;';
  // Audio button
  if(audios.length > 1){
    const label = _langName(audios[0].language, audios[0].name) || 'Audio';
    const items = audios.map(function(a,i){
      return {
        label: _langName(a.language, a.name),
        active: i === 0,
        onSelect: function(){
          fbc.switchAudio(i, a, _langName(a.language, a.name), null, null);
          _p3RefreshAudioLabel(div, _langName(a.language, a.name));
        }
      };
    });
    const dd = _p2BuildOverlayDropdown(label, items);
    div.appendChild(dd);
  }
  // Subtitle button
  if(vttSubs.length){
    var subLabel = 'Off';
    var subItems = [{label:'Off', active:true, onSelect:function(){
      fbc.setSubVisibility(false, null, null, -1, null);
      _p3RefreshSubLabel(div, 'Off');
    }}];
    vttSubs.forEach(function(s,i){
      var dn = _langName(s.language, s.label);
      subItems.push({label:dn, active:false, onSelect:function(){
        fbc.setSubVisibility(true, null, null, i, s);
        _p3RefreshSubLabel(div, dn);
      }});
    });
    var dd2 = _p2BuildOverlayDropdown('💬 '+subLabel, subItems);
    div.appendChild(dd2);
  }
  wrap.appendChild(div);
}
function _p3RefreshAudioLabel(div, label){
  var btn = div && div.querySelector('.p2-overlay-dropdown:first-child .p2-overlay-btn .p2-overlay-label');
  if(btn) btn.textContent = label;
}
function _p3RefreshSubLabel(div, label){
  var btns = div && div.querySelectorAll('.p2-overlay-dropdown .p2-overlay-btn .p2-overlay-label');
  if(btns && btns.length){
    btns[btns.length - 1].textContent = '💬 '+label;
  }
}

function _nativeFallback(video, videos, audios){
  // Enable native HTML5 controls since Shaka UI overlay is not available
  video.controls = true;
  if(videos.length){
    video.src = videos[0].path;
    video.load();
  }
  if(audios.length && audios[0].path !== (videos[0] && videos[0].path)){
    try{
      const audioEl = document.getElementById('shakaAudio') || document.createElement('audio');
      audioEl.id = 'shakaAudio';
      audioEl.crossOrigin = 'anonymous';
      audioEl.src = audios[0].path;
      audioEl.preload = 'auto';
      audioEl.loop = false;
      _fallbackAudioEl = audioEl;
      video.addEventListener('play', function(){ audioEl.play().catch(function(){}); });
      video.addEventListener('pause', function(){ audioEl.pause(); });
      video.addEventListener('seeking', function(){ audioEl.currentTime = video.currentTime; });
      video.addEventListener('ended', function(){ audioEl.pause(); audioEl.currentTime = 0; });
      audioEl.addEventListener('ended', function(){ video.pause(); });
      _startFallbackSync(audioEl, video);
      audioEl.play().catch(function(){});
      video.addEventListener('volumechange', function(){
        audioEl.volume = video.volume;
        audioEl.muted = video.muted;
      });
      audioEl.volume = video.volume;
      audioEl.muted = video.muted;
    }catch(audioErr){
      console.warn('Fallback audio failed:', audioErr);
    }
  }
}

async function loadVideoEngine3(film, sources){
  const { videos, audios, subtitles } = sources;
  const wrap = document.getElementById('shakaPlayerWrap');
  const video = document.getElementById('shakaVideo');
  if(!wrap || !video){ console.error('Shaka DOM missing'); return; }

  // Hide other engines
  const p2 = document.getElementById('player2Wrap');
  const mp = document.getElementById('multitrackPlayer');
  if(p2) p2.style.display = 'none';
  if(mp) mp.style.display = 'none';
  wrap.style.display = 'block';

  // Cleanup previous instance
  if(shakaPlayer){
    try{ await shakaPlayer.destroy(); }catch(e){}
    shakaPlayer = null;
  }
  if(shakaUi){
    try{ shakaUi.destroy(); }catch(e){}
    shakaUi = null;
  }
  // Cleanup old VTT blob URLs
  if(_manifestStore.vttUrls){
    for(const u of _manifestStore.vttUrls){ try{ URL.revokeObjectURL(u); }catch(e){} }
  }
  _manifestStore.vttUrls = [];

  // Install shaka polyfills
  shaka.polyfill.installAll();

  shakaPlayer = new shaka.Player();

  // Request filter: blob: URLs don't support HEAD → convert to GET
  // Note: /api/r2-stream/ HEAD handled by worker (returns 200 + Content-Length)
  const _netEngine = shakaPlayer.getNetworkingEngine();
  if(_netEngine){
    _netEngine.registerRequestFilter(function(type, request, context){
      if(request.method === 'HEAD' && request.uris){
        for(var i = 0; i < request.uris.length; i++){
          if(request.uris[i].indexOf('blob:') === 0){
            request.method = 'GET';
            break;
          }
        }
      }
    });
  }

  // ═══ Probe MP4 init ranges for video & audio files ═══
  const videoInits = [];
  for(let i = 0; i < videos.length; i++){
    const ir = await _probeMp4InitRange(videos[i].path);
    videoInits.push(ir);
    console.log('Video init range for', videos[i].name, ':', ir);
  }
  const audioInits = [];
  for(let i = 0; i < audios.length; i++){
    const ir = await _probeMp4InitRange(audios[i].path);
    audioInits.push(ir);
    console.log('Audio init range for', audios[i].name, ':', ir);
  }

  // ═══ Convert SRT subtitles to VTT blob URLs ═══
  const vttSubs = [];
  for(let i = 0; i < subtitles.length; i++){
    const s = subtitles[i];
    const vttUrl = await _srtToVttBlobUrl(s.path);
    if(vttUrl){
      vttSubs.push({ url: vttUrl, language: s.language || 'und', label: s.name || s.language || ('Sub ' + (i+1)) });
      _manifestStore.vttUrls.push(vttUrl);
    }
  }

  // ═══ Build DASH MPD ═══

  // Profile: isoff-main (progressive MP4, no SIDX required).
  // Previous bug: used isoff-on-demand + indexRange=initRange → Shaka tried
  // to parse SIDX from moov box → audio/video failed to load → no sound.
  // Fix: use <SegmentBase><Initialization range="X"/></SegmentBase> WITHOUT
  // indexRange → Shaka treats as progressive single-segment download.

  // ═══ Inject custom controls BEFORE Shaka (so they always show) ═══
  var _fallbackCtrl = {
    switchAudio: function(idx, track, displayName, btn, menu){
      _fallbackAudioIdx = idx;
      if(_fallbackAudioEl && _fallbackAudioEl.src !== track.path){
        var wasPlaying = _fallbackAudioEl && !_fallbackAudioEl.paused;
        var ct = video.currentTime;
        _fallbackAudioEl.src = track.path;
        _fallbackAudioEl.load();
        _fallbackAudioEl.currentTime = ct;
        if(wasPlaying) _fallbackAudioEl.play().catch(function(){});
      }
    },
    setSubVisibility: function(show, btn, menu, idx, track){
      // VTT subtitles via overlay
      var existing = video.parentNode.querySelector('.fb-sub-overlay');
      if(existing) existing.remove();
      if(show && track){
        var overlay = document.createElement('div');
        overlay.className = 'fb-sub-overlay';
        overlay.style.cssText = 'position:absolute;bottom:80px;left:0;right:0;text-align:center;z-index:24;pointer-events:none;color:#fff;font-size:18px;text-shadow:2px 2px 4px rgba(0,0,0,.8);';
        video.parentNode.appendChild(overlay);
        // Simple VTT parser for display
        fetch(track.url).then(function(r){ return r.text(); }).then(function(vtt){
          var cues = [];
          var lines = vtt.split('\n');
          var i = 0;
          while(i < lines.length){
            if(lines[i].indexOf('-->') >= 0){
              var parts = lines[i].split('-->');
              var start = _parseVttTime(parts[0].trim());
              var end = _parseVttTime(parts[1].trim());
              var text = '';
              i++;
              while(i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('-->') < 0){
                text += lines[i] + ' ';
                i++;
              }
              if(text.trim()) cues.push({s: start, e: end, t: text.trim()});
            }
            i++;
          }
          var lastCue = '';
          video.addEventListener('timeupdate', function(){
            var ct = video.currentTime;
            var found = null;
            for(var j = 0; j < cues.length; j++){
              if(ct >= cues[j].s && ct <= cues[j].e){ found = cues[j].t; break; }
            }
            if(found !== lastCue){
              overlay.textContent = found || '';
              lastCue = found;
            }
          });
        }).catch(function(){});
      }
    }
  };
  // For simple R2 (1 video + separate audio), skip Shaka entirely.
  // Progressive MP4 can't form a valid DASH MPD — Shaka Error 4002 is inevitable.
  if(film && film.r2_bucket && videos.length === 1 && audios.length >= 1){
    console.log('[Engine3] Simple R2 detected — skipping Shaka MPD, using native fallback (subtitles via _fallbackCtrl)');
    _p3InjectOverlays(wrap, video, videoInits, audios, vttSubs, _fallbackCtrl);
    _nativeFallback(video, videos, audios);
    shakaState = { film, videos, audios, subtitles, qualityIdx: 0, audioIdx: 0 };
    return;
  }

  try{
    var mpd = '<?xml version="1.0" encoding="utf-8"?>';
    mpd += '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-main:2011" type="static" mediaPresentationDuration="PT3600S">';
    mpd += '<Period id="1">';

    // Video AdaptationSet
    if(videos.length){
      mpd += '<AdaptationSet contentType="video" mimeType="video/mp4" startWithSAP="1" segmentAlignment="true">';
      for(let i = 0; i < videos.length; i++){
        const v = videos[i];
        let width = 1920, height = 1080;
        const nm = (v.name || '').toLowerCase();
        if(nm.includes('720')){ width = 1280; height = 720; }
        else if(nm.includes('480')){ width = 854; height = 480; }
        else if(nm.includes('360')){ width = 640; height = 360; }
        const ir = videoInits[i] || '0-1000';
        mpd += '<Representation id="v'+i+'" bandwidth="3000000" width="'+width+'" height="'+height+'" codecs="avc1.640028">';
        mpd += '<BaseURL>'+escXml(v.path)+'</BaseURL>';
        mpd += '<SegmentBase>';
        mpd += '<Initialization range="'+ir+'"/>';
        mpd += '</SegmentBase>';
        mpd += '</Representation>';
      }
      mpd += '</AdaptationSet>';
    }

    // Audio AdaptationSet
    if(audios.length){
      mpd += '<AdaptationSet contentType="audio" mimeType="audio/mp4" startWithSAP="1" segmentAlignment="true">';
      for(let i = 0; i < audios.length; i++){
        const a = audios[i];
        const lang = a.language || 'und';
        const label = a.name || ('Audio ' + (i+1));
        const ir = audioInits[i] || '0-500';
        mpd += '<Representation id="a'+i+'" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="44100" lang="'+escXml(lang)+'">';
        mpd += '<Label>'+escXml(label)+'</Label>';
        mpd += '<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration" value="2"/>';
        mpd += '<BaseURL>'+escXml(a.path)+'</BaseURL>';
        mpd += '<SegmentBase>';
        mpd += '<Initialization range="'+ir+'"/>';
        mpd += '</SegmentBase>';
        mpd += '</Representation>';
      }
      mpd += '</AdaptationSet>';
    }

    // NOTE: Subtitles are NOT in the DASH MPD. Blob URLs don't work reliably
    // in DASH text AdaptationSet context. Instead, add them via
    // addTextTrackAsync() after Shaka load — more reliable, and the
    // text_language UI button appears automatically when tracks exist.

    mpd += '</Period></MPD>';

    // Create blob URL for MPD
    // ⚠️ BaseURL is relative (/api/r2-stream/...) — Shaka resolves it against the blob: URL
    // which fails (blob: has no origin-based resolution). Fix: make BaseURL absolute.
    if(_manifestStore.blobUrl){ try{ URL.revokeObjectURL(_manifestStore.blobUrl); }catch(e){} }
    const origin = window.location.origin;
    mpd = mpd.replace(/(<BaseURL>)(\/api\/r2-stream\/)/g, '$1' + origin + '$2');
    const blob = new Blob([mpd], { type: 'application/dash+xml' });
    _manifestStore.blobUrl = URL.createObjectURL(blob);

    // Attach player to video
    await shakaPlayer.attach(video);

    // Configure player
    shakaPlayer.configure({
      preferredAudioLanguage: 'id',
      preferredTextLanguage: 'id',
      abr: { enabled: true },
      streaming: {
        retryParameters: {
          timeout: 30000,
          maxAttempts: 5,
        },
      },
    });

    // Initialize Shaka UI overlay (wrapped so UI failure doesn't block playback)
    if(typeof shaka.ui !== 'undefined' && shaka.ui.Overlay){
      try{
        shakaUi = new shaka.ui.Overlay(shakaPlayer, wrap, video);
        shakaUi.configure({
          addSeekBar: true,
          enableFullscreenOnRotation: true,
          controlPanelElements: [
            'play_pause', 'time_and_duration', 'spacer', 'mute', 'volume',
            'quality', 'fullscreen', 'overflow_menu'
          ],
          overflowMenuButtons: [
            'picture_in_picture'
          ],
        });
      }catch(uiErr){
        console.warn('Shaka UI init failed, continuing without UI:', uiErr);
      }
    }

    // Load manifest
    await shakaPlayer.load(_manifestStore.blobUrl);
    console.log('Shaka loaded. Audio langs:', shakaPlayer.getAudioLanguages());
    console.log('Shaka variant audio tracks:', shakaPlayer.getVariantTracks().filter(t => t.type === 'audio').length);

    // ═══ Add subtitles via addTextTrackAsync (reliable, not DASH blob) ═══
    for(let i = 0; i < vttSubs.length; i++){
      const s = vttSubs[i];
      try{
        await shakaPlayer.addTextTrackAsync(s.url, s.language, 'subtitle', 'text/vtt', s.language, s.label);
        console.log('Subtitle added:', s.label, s.language);
      }catch(e){
        console.warn('Failed to add subtitle', s.label, e);
      }
    }
    console.log('Shaka text tracks:', shakaPlayer.getTextTracks().length);

  }catch(e){
    console.warn('Shaka MPD build failed, falling back. Error:', e, '| message:', e && e.message, '| code:', e && e.code, '| category:', e && e.category, '| stack:', e && e.stack);
    // Fallback: play video with optional separate audio
    if(videos.length){
      video.src = videos[0].path;
      video.load();
    }
    // Play audio separately if available (video.mp4 may not have embedded audio)
    // Uses requestAnimationFrame sync for sub-100ms drift correction
    if(audios.length && audios[0].path !== (videos[0] && videos[0].path)){
      try{
        const audioEl = document.getElementById('shakaAudio') || document.createElement('audio');
        audioEl.id = 'shakaAudio';
        audioEl.crossOrigin = 'anonymous';
        audioEl.src = audios[0].path;
        audioEl.preload = 'auto';
        audioEl.loop = false;
        _fallbackAudioEl = audioEl;
        // Sync audio with video play/pause
        video.addEventListener('play', function(){ audioEl.play().catch(function(){}); });
        video.addEventListener('pause', function(){ audioEl.pause(); });
        video.addEventListener('seeking', function(){ audioEl.currentTime = video.currentTime; });
        video.addEventListener('ended', function(){ audioEl.pause(); audioEl.currentTime = 0; });
        audioEl.addEventListener('ended', function(){ video.pause(); });
        // RAF sync (precise per-frame, corrects drift every frame)
        _startFallbackSync(audioEl, video);
        audioEl.play().catch(function(){});
        // Volume sync
        video.addEventListener('volumechange', function(){
          audioEl.volume = video.volume;
          audioEl.muted = video.muted;
        });
        audioEl.volume = video.volume;
        audioEl.muted = video.muted;
      }catch(audioErr){
        console.warn('Fallback audio failed:', audioErr);
      }
    }
  }

  // ═══ Save state ═══
  shakaState = { film, videos, audios, subtitles, qualityIdx: 0, audioIdx: 0 };

  // ═══ Compat shim ═══
  videoPlayer = {
    pause: function(){ try{ video.pause(); }catch{} },
    play: function(){ try{ video.play(); }catch{} },
    paused: function(){ return video.paused; },
    currentTime: function(v){ if(v===undefined) return video.currentTime; video.currentTime = v; },
    duration: function(){ return video.duration || 0; },
    playbackRate: function(r){ if(r===undefined) return video.playbackRate; video.playbackRate = r; },
    muted: function(m){ if(m===undefined) return video.muted; video.muted = m; },
    volume: function(v){ if(v===undefined) return video.volume; video.volume = v; },
    src: function(){}, load: function(){}, on: function(){},
    audioTracks: function(){ return null; },
    addRemoteTextTrack: function(){},
    remoteTextTracks: function(){ return []; },
    removeRemoteTextTrack: function(){},
  };

  // Resume position
  if(currentResumeFrom && currentResumeFrom > 5){
    video.addEventListener('loadedmetadata', function seek(){
      video.currentTime = currentResumeFrom;
    }, { once: true });
  }

  // Stream actions (now hidden, but keep for compat)
  try{ setStreamActions(videos[0].path, film.judul || film.title || ''); }catch(e){}

  // Hook continue watching
  var lastSave = 0;
  video.addEventListener('timeupdate', function(){
    var now = Date.now();
    if(now - lastSave < 8000) return;
    lastSave = now;
    if(!currentFilm || !video.duration) return;
    upsertContinueWatching(currentFilm.id, video.currentTime, video.duration);
  });
  video.addEventListener('ended', function(){
    if(currentFilm) removeContinueWatching(currentFilm.id);
  });
}



function teardownEngine3(){
  const wrap = document.getElementById('shakaPlayerWrap');
  if(wrap){ wrap.style.display = 'none'; var ctc = wrap.querySelector('.ctc'); if(ctc) ctc.remove(); }
  _stopFallbackSync();
  const ov3 = document.getElementById('p3OverlayMenus');
  if(ov3){ ov3.remove(); }
  if(shakaUi){
    try{ shakaUi.destroy(); }catch(e){}
    shakaUi = null;
  }
  if(shakaPlayer){
    try{ shakaPlayer.destroy(); }catch(e){}
    shakaPlayer = null;
  }
  if(_manifestStore.blobUrl){ try{ URL.revokeObjectURL(_manifestStore.blobUrl); }catch(e){} _manifestStore.blobUrl = null; }
  if(_manifestStore.vttUrls){
    for(const u of _manifestStore.vttUrls){ try{ URL.revokeObjectURL(u); }catch(e){} }
    _manifestStore.vttUrls = [];
  }
  const video = document.getElementById('shakaVideo');
  if(video){ video.src = ''; video.load(); video.querySelectorAll('track').forEach(function(t){ t.remove(); }); }
  shakaState = null;
}

function closePlayer(opts){
  persistPreviewStop(currentFilm);
  resetPreviewGate();
  const fullBar = document.getElementById('fullAccessBar');
  if(fullBar) fullBar.style.display = 'none';
  opts = opts || {};
  releaseVipDownloadSlot();
  // Exit fullscreen if we were in wrap-fullscreen mode so closing the
  // player drops us back to the normal browser chrome.
  try{ if(_fsCurrent()){ _fsExit(); } }catch(_){ }
  // Dismiss the episode drawer if it was open so it doesn't bleed
  // into the next player open or stay floating after navigation.
  try{ closeEpDrawer(); }catch(_){ }
  const _epBtn = document.getElementById('playerEpBtn');
  if(_epBtn) _epBtn.style.display = 'none';
  document.getElementById('playerModal').classList.remove('open');
  document.body.style.overflow='';
  // If we pushed a /film/{id} URL, navigate back one step so URL reverts
  // to whatever page the user was on before opening the film.
  // Skip when caller (e.g. goPage) will handle history itself.
  if(!opts.fromPopState && !opts.skipHistoryBack){
    if(location.pathname.startsWith('/film/')){
      // history.back() triggers popstate → applyRoute() restores previous page
      history.back();
    }
  }
  // Tear down active engine
  teardownEngine1();
  teardownEngine2();
  videoPlayer = null;
  // Stop video host iframe (avoid background audio after close).
  const fr = document.getElementById('vhFrame');
  if(fr){ fr.src = 'about:blank'; fr.style.display='none'; }
  const sa = document.getElementById('streamActions');
  if(sa) sa.style.display='none';
  const sm = document.getElementById('externalPlayerMenu');
  if(sm) sm.style.display='none';
  if(_currentSubBlobUrl){
    URL.revokeObjectURL(_currentSubBlobUrl);
    _currentSubBlobUrl=null;
  }
  // Stop trailer iframe overlay
  closeTrailerOverlay();
  document.getElementById('prTrailerSection').style.display='none';
  document.getElementById('prCastSection').style.display='none';
  document.getElementById('recBox').style.display='none';
  currentTmdbExtras = null;
  currentTrailerKey = null;
  // Refresh continue watching list
  renderContinueWatching();
}

/* ════════════════════════════════════════════════════════════════════
   TMDB EXTRAS — cast, trailer, recommendations
   ════════════════════════════════════════════════════════════════════ */
async function loadFilmExtras(film){
  document.getElementById('prTrailerSection').style.display='none';
  document.getElementById('prCastSection').style.display='none';
  document.getElementById('recBox').style.display='none';
  currentTmdbExtras = null;
  currentTrailerKey = null;

  // ALWAYS pre-populate the trailer button from `film.trailer_url` first so
  // the button shows up immediately even if TMDB isn't reachable (no session,
  // no tmdb_id, network error, etc). TMDB will override below when available.
  const _extractYouTubeId = (u) => {
    if(!u) return null;
    const m = String(u).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  };
  if(film.trailer_url){
    const key = _extractYouTubeId(film.trailer_url);
    if(key){
      currentTrailerKey = key;
      document.getElementById('prTrailerLabel').textContent = 'Trailer';
      document.getElementById('prTrailerSection').style.display='block';
    }
  }

  if(!session) return; // butuh login (TMDB endpoint butuh auth)

  let tmdbId = film.tmdb_id;
  const mediaType = film.tipe==='series' ? 'tv' : 'movie';
  // Kalau tidak ada tmdb_id → search by judul dulu
  if(!tmdbId){
    try{
      const r = await fetch(`${apiBase()}/api/tmdb/search?type=${mediaType}&query=${encodeURIComponent(film.judul||'')}`, {
        headers: { Authorization: 'Bearer '+session.access_token },
      });
      const d = await r.json();
      if(d.ok && d.data && d.data.results && d.data.results.length){
        tmdbId = d.data.results[0].id;
      }
    }catch{}
  }
  // Bagikan tmdb_id ke episode picker (untuk fetch season episodes) — kalau series & belum ke-set
  if(film.tipe==='series' && tmdbId && !epPickerState.tmdbId){
    epPickerState.tmdbId = tmdbId;
    fetchTmdbSeasonAndRerender(epPickerState.currentSeason, film.id);
  }

  if(!tmdbId) return;

  try{
    const r = await fetch(`${apiBase()}/api/tmdb/${mediaType}/${tmdbId}`, {
      headers: { Authorization: 'Bearer '+session.access_token },
    });
    const d = await r.json();
    if(!d.ok) return; // manual trailer already shown above if available
    currentTmdbExtras = d.data;

    // Enrich right panel with TMDB details
    const tmdb = d.data;
    const IMG = (CONFIG && CONFIG.tmdb_image_base) || 'https://image.tmdb.org/t/p/w500';

    // Poster (use TMDB if local poster missing)
    if(tmdb.poster_path){
      const prImg = document.getElementById('prPoster');
      prImg.src = IMG + tmdb.poster_path;
      prImg.style.display = 'block';
    }
    // Title (TMDB canonical)
    const tmdbTitle = tmdb.title || tmdb.name || film.judul;
    if(tmdbTitle) document.getElementById('prTitle').textContent = tmdbTitle;
    // Overview
    if(tmdb.overview) document.getElementById('prOverview').textContent = tmdb.overview;
    // Status
    document.getElementById('prStatus').textContent = tmdb.status || 'Released';
    // Rating (TMDB vote_average)
    if(tmdb.vote_average && tmdb.vote_average > 0){
      document.getElementById('prRatingRow').style.display='flex';
      document.getElementById('prRating').textContent = tmdb.vote_average.toFixed(1);
    }
    // Production companies (first 2)
    const prods = (tmdb.production_companies || []).map(p=>p.name).slice(0,2);
    document.getElementById('prProduction').textContent = prods.length ? prods.join(', ') : '—';
    // Aired / release date
    const releaseDate = tmdb.release_date || tmdb.first_air_date || '';
    if(releaseDate){
      const d2 = new Date(releaseDate);
      if(!isNaN(d2)){
        const opts = { year:'numeric', month:'short', day:'numeric' };
        document.getElementById('prAired').textContent = d2.toLocaleDateString('en-US', opts);
      } else {
        document.getElementById('prAired').textContent = releaseDate;
      }
    }
    // Genres
    const genres = tmdb.genres || [];
    if(genres.length){
      document.getElementById('prGenres').innerHTML = genres.slice(0,6).map(g=>
        `<span class="pr-genre">${escapeHtml(g.name)}</span>`
      ).join('');
    }

    // Trailer — coba TMDB dulu, fallback ke film.trailer_url (YouTube link manual dari admin)
    const videos = (tmdb.videos && tmdb.videos.results) || [];
    const trailer = videos.find(v=>v.site==='YouTube' && v.type==='Trailer') || videos.find(v=>v.site==='YouTube');
    if(trailer){
      currentTrailerKey = trailer.key;
      document.getElementById('prTrailerLabel').textContent = trailer.name || 'Official Trailer';
    } else if(film.trailer_url){
      const m = film.trailer_url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
      if(m) currentTrailerKey = m[1];
    }
    if(currentTrailerKey){
      document.getElementById('prTrailerSection').style.display='block';
    }

    // Cast — vertical rows in right panel
    const cast = (tmdb.credits && tmdb.credits.cast) || [];
    if(cast.length){
      document.getElementById('prCastSection').style.display='block';
      const PROFILE = IMG.replace('w500','w185');
      document.getElementById('prCastGrid').innerHTML = cast.slice(0,8).map(c=>`
        <div class="pr-cast-row">
          <div class="pr-cast-photo">
            ${c.profile_path ? `<img src="${PROFILE}${c.profile_path}" loading="lazy"/>` : `<div class="ph">👤</div>`}
          </div>
          <div class="pr-cast-info">
            <div class="pr-cast-name">${escapeHtml(c.name||'')}</div>
            <div class="pr-cast-char">${escapeHtml(c.character||'')}</div>
          </div>
        </div>
      `).join('');
    }

    // Recommendations
    const recs = (d.data.recommendations && d.data.recommendations.results) || [];
    if(recs.length){
      document.getElementById('recBox').style.display='block';
      const IMG = (CONFIG && CONFIG.tmdb_image_base) || 'https://image.tmdb.org/t/p/w500';
      document.getElementById('recGrid').innerHTML = recs.slice(0,12).map(r=>{
        // Cek apakah film ada di katalog kita
        const localFilm = allFilms.find(f=>String(f.tmdb_id)===String(r.id));
        const poster = r.poster_path ? `${IMG}${r.poster_path}` : '';
        const title = r.title || r.name || '';
        const year = (r.release_date||r.first_air_date||'').slice(0,4) || '';
        const inLib = localFilm ? '<div style="position:absolute;top:6px;left:6px;background:var(--accent);color:#fff;font-size:.6rem;padding:2px 6px;border-radius:4px;font-weight:700;">DI KATALOG</div>' : '';
        return `
          <div class="rec-card" data-tmdb-id="${r.id}" data-local-id="${localFilm?localFilm.id:''}" style="cursor:pointer;">
            <div style="position:relative;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border);">
              ${inLib}
              ${poster ? `<img src="${poster}" loading="lazy" style="width:100%;height:100%;object-fit:cover;"/>` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted-2);font-size:.7rem;text-align:center;padding:8px;">${escapeHtml(title)}</div>`}
            </div>
            <div style="font-size:.8rem;font-weight:600;margin-top:6px;line-height:1.2;">${escapeHtml(title)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px;">${year}</div>
          </div>
        `;
      }).join('');
      document.getElementById('recGrid').querySelectorAll('.rec-card').forEach(el=>{
        el.addEventListener('click', ()=>{
          const localId = el.dataset.localId;
          if(localId){
            const f = allFilms.find(x=>String(x.id)===String(localId));
            if(f) openFilm(f);
          }
          // else: recommendation isn't in catalog — silently do nothing.
        });
      });
    }
  }catch(e){
    console.warn('TMDB extras failed:', e);
  }
}

function playTrailerInPlayer(){
  if(!currentTrailerKey) return;
  const ifr = document.getElementById('trailerIframe');
  ifr.src = `https://www.youtube.com/embed/${currentTrailerKey}?autoplay=1&rel=0`;
  ifr.style.display='block';
  document.getElementById('trailerCloseBtn').style.display='block';
  try{ videoPlayer?.pause(); }catch{}
}
function closeTrailerOverlay(){
  const ifr = document.getElementById('trailerIframe');
  if(ifr){ ifr.src=''; ifr.style.display='none'; }
  const btn = document.getElementById('trailerCloseBtn');
  if(btn) btn.style.display='none';
}

// Toggle right info panel collapse
function togglePlayerRight(){
  const pm = document.getElementById('playerModal');
  const collapsed = pm.classList.toggle('right-collapsed');
  try{ localStorage.setItem('ui.player.right.collapsed', collapsed ? '1' : '0'); }catch{}
}
// Restore right panel state when modal opens
(function(){
  try{
    if(localStorage.getItem('ui.player.right.collapsed') === '1'){
      document.addEventListener('DOMContentLoaded', ()=>{
        document.getElementById('playerModal')?.classList.add('right-collapsed');
      });
    }
  }catch{}
})();

function apiBase(){
  // Worker melayani frontend dari domain yg sama, tapi kita pakai relative URL
  return '';
}

function togglePanel(name){
  if(name==='subs'){
    const p=document.getElementById('subsPanel');
    p.classList.toggle('open');
    document.getElementById('toolBtnSubs').classList.toggle('active', p.classList.contains('open'));
    // Tutup panel lain
    document.getElementById('audioPanel').classList.remove('open');
  } else if(name==='audio'){
    const p=document.getElementById('audioPanel');
    p.classList.toggle('open');
    document.getElementById('subsPanel').classList.remove('open');
    document.getElementById('toolBtnSubs').classList.remove('active');
  }
}

const RATES=[1, 1.25, 1.5, 1.75, 2, 0.75, 0.5];
let _rateIdx=0;
function cyclePlaybackRate(){
  _rateIdx=(_rateIdx+1)%RATES.length;
  const r=RATES[_rateIdx];
  if(videoPlayer) videoPlayer.playbackRate(r);
  document.getElementById('toolBtnSpeed').textContent=r+'x';
}

function switchSubsTab(name){
  document.querySelectorAll('.subs-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.subs-section').forEach(s=>s.classList.remove('active'));
  if(name==='online'){
    document.querySelectorAll('.subs-tab')[0].classList.add('active');
    document.getElementById('subsSecOnline').classList.add('active');
  }else{
    document.querySelectorAll('.subs-tab')[1].classList.add('active');
    document.getElementById('subsSecUpload').classList.add('active');
  }
}

/* ════════════════════════════════════════════════════════════════════
   SUBSOURCE
   ════════════════════════════════════════════════════════════════════ */
let _subsLastSearch = null;
let _subsAvailableLangs = [];
let _subsSelectedLang = 'indonesian';
let _subsCurrentMovieId = null;

async function subsourceSearch(){
  const q = document.getElementById('subsSearchInput').value.trim();
  if(!q) return;
  const status = document.getElementById('subsStatus');
  const list = document.getElementById('subsList');
  const langPick = document.getElementById('subsLangPick');
  status.className='subs-status';
  status.textContent='Mencari subtitle…';
  list.innerHTML='';langPick.innerHTML='';

  const type = currentFilm?.tipe==='series' ? 'series' : 'movie';
  const year = currentFilm?.tahun || '';
  try{
    const r = await fetch(`/api/subsource/search?q=${encodeURIComponent(q)}${year?`&year=${year}`:''}&type=${type}`);
    const d = await r.json();
    if(!d.ok){ throw new Error(d.error||'gagal'); }
    // Response Subsource: { data: [ {movieId, title, type, releaseYear, season, posters{...}}, ... ] }
    const arr = (d.data && (d.data.data || d.data.results || d.data.movies || (Array.isArray(d.data)?d.data:[]))) || [];
    if(!arr.length){
      status.className='subs-status error';
      status.textContent='Tidak ada hasil. Coba ganti kata kunci.';
      _subsLastSearch=null;
      return;
    }
    // Pilih hasil paling match — kalau series & ada season, prioritaskan yg cocok
    let best = arr[0];
    if(currentFilm?.tipe==='series' && currentFilm?.season){
      const m = arr.find(x => Number(x.season) === Number(currentFilm.season));
      if(m) best = m;
    }
    _subsLastSearch = best;
    _subsCurrentMovieId = best.movieId || best.id || best.movie_id || best._id;
    // Load list subtitle
    await subsourceLoadSubtitles();
    status.textContent='';
  }catch(e){
    status.className='subs-status error';
    status.textContent='Error: '+e.message;
  }
}

async function subsourceLoadSubtitles(){
  const status = document.getElementById('subsStatus');
  const list = document.getElementById('subsList');
  const langPick = document.getElementById('subsLangPick');
  if(!_subsCurrentMovieId){ return; }
  status.textContent='Memuat daftar subtitle…';
  try{
    const params = new URLSearchParams({ movie_id: _subsCurrentMovieId, limit: '200' });
    const r = await fetch(`/api/subsource/subtitles?${params.toString()}`);
    const d = await r.json();
    if(!d.ok) throw new Error(d.error||'gagal');
    // Subsource pagination: { data: [...], pagination: {...} } atau { results: [...] }
    const subs = (d.data && (d.data.data || d.data.results || d.data.subtitles || (Array.isArray(d.data)?d.data:[]))) || [];
    if(!Array.isArray(subs) || !subs.length){
      status.className='subs-status error';
      status.textContent='Tidak ada subtitle untuk judul ini.';
      return;
    }
    // Build language picker
    const langs = Array.from(new Set(subs.map(s=>(s.language||s.lang||'').toLowerCase()))).filter(Boolean);
    _subsAvailableLangs = langs;
    // default ke Indonesia kalau ada, kalau tidak Inggris, kalau tidak yang pertama
    if(!langs.includes(_subsSelectedLang)){
      _subsSelectedLang = langs.includes('indonesian') ? 'indonesian'
                       : langs.includes('english') ? 'english'
                       : (langs[0] || '');
    }
    renderLangPicker(langs, subs);
    renderSubList(subs.filter(s=>(s.language||s.lang||'').toLowerCase()===_subsSelectedLang));
    status.textContent = `${subs.length} subtitle ditemukan.`;
  }catch(e){
    status.className='subs-status error';
    status.textContent='Error: '+e.message;
  }
}

const LANG_FLAGS = {
  english:'🇬🇧', indonesian:'🇮🇩', arabic:'🇸🇦', spanish:'🇪🇸', french:'🇫🇷',
  german:'🇩🇪', portuguese:'🇧🇷', dutch:'🇳🇱', russian:'🇷🇺', japanese:'🇯🇵',
  korean:'🇰🇷', chinese:'🇨🇳', italian:'🇮🇹', turkish:'🇹🇷', vietnamese:'🇻🇳',
  thai:'🇹🇭', malay:'🇲🇾', tagalog:'🇵🇭', persian:'🇮🇷', hindi:'🇮🇳',
};

function renderLangPicker(langs, allSubs){
  const langPick = document.getElementById('subsLangPick');
  langPick.innerHTML = langs.map(l=>{
    const flag = LANG_FLAGS[l] || '🌐';
    const active = (l===_subsSelectedLang)?'active':'';
    return `<button class="subs-lang-chip ${active}" data-lang="${l}">${flag} ${l}</button>`;
  }).join('');
  langPick.querySelectorAll('.subs-lang-chip').forEach(c=>{
    c.addEventListener('click',()=>{
      _subsSelectedLang = c.dataset.lang;
      langPick.querySelectorAll('.subs-lang-chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
      renderSubList(allSubs.filter(s=>(s.language||s.lang||'').toLowerCase()===_subsSelectedLang));
    });
  });
}

function renderSubList(subs){
  const list = document.getElementById('subsList');
  if(!subs.length){
    list.innerHTML='<div class="subs-status">Tidak ada subtitle untuk bahasa ini.</div>';
    return;
  }
  list.innerHTML = subs.map(s=>{
    const id = s.subtitleId || s.id || s._id;
    const releaseArr = Array.isArray(s.releaseInfo) ? s.releaseInfo : [];
    const release = releaseArr[0] || s.release_name || s.release || s.title || 'Subtitle';
    const otherReleases = releaseArr.length>1 ? `+${releaseArr.length-1}` : '';
    const dl = s.downloads ? `${s.downloads.toLocaleString('id-ID')} ⬇` : '';
    const hi = s.hearingImpaired ? '🎧' : '';
    const flag = LANG_FLAGS[(s.language||'').toLowerCase()] || '🌐';
    const fps = s.framerate ? `${s.framerate}fps` : '';
    const meta = [dl, fps, hi, s.releaseType].filter(Boolean).join(' · ');
    return `
      <div class="subs-list-item" data-id="${id}" data-name="${escapeHtml(release)}">
        <span class="subs-flag">${flag}</span>
        <div class="subs-list-item-info">
          <div class="subs-list-item-title">${escapeHtml(release)} ${otherReleases?`<span style="color:var(--muted-2);font-size:.78rem;">${otherReleases}</span>`:''}</div>
          <div class="subs-list-item-meta">${meta}</div>
        </div>
        <span class="subs-tag">SRT</span>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.subs-list-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      list.querySelectorAll('.subs-list-item').forEach(x=>x.classList.remove('active'));
      el.classList.add('active');
      loadSubtitleById(el.dataset.id, el.dataset.name);
    });
  });
}

async function loadSubtitleById(id, label){
  const status = document.getElementById('subsStatus');
  status.className='subs-status';
  status.textContent='Memuat subtitle…';
  try{
    const r = await fetch(`/api/subsource/download/${encodeURIComponent(id)}`);
    if(!r.ok) throw new Error('HTTP '+r.status);
    let text = await r.text();
    // Subsource returns SRT — convert to VTT
    if(!text.startsWith('WEBVTT')){
      text = srtToVtt(text);
    }
    if(_currentSubBlobUrl) URL.revokeObjectURL(_currentSubBlobUrl);
    const blob = new Blob([text], { type:'text/vtt' });
    _currentSubBlobUrl = URL.createObjectURL(blob);
    applySubTrack(_currentSubBlobUrl, label);
    status.textContent='Subtitle dimuat ✓';
  }catch(e){
    status.className='subs-status error';
    status.textContent='Gagal: '+e.message;
  }
}

function srtToVtt(srt){
  return 'WEBVTT\n\n'+srt
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g,'$1.$2')
    .trim();
}

function applySubTrack(url, label){
  // Multitrack.JS: dynamically attach external subtitle URL into the
  // built-in Settings → Subtitle picker, and select it.
  if(!mtPlayer || !mtPlayer._ || !mtPlayer._.form || !mtPlayer._.form.settings) return;
  const menu = mtPlayer._.form.settings.menu && mtPlayer._.form.settings.menu.subtitles;
  if(!menu || typeof menu.appendButton !== 'function') return;
  // Avoid duplicates of same dynamic label
  for(const b of menu.Buttons || []){ if(b && b.innerText === (label||'Subtitle')) { try{ b.click(); }catch{} return; } }
  menu.appendButton(label||'Subtitle', ()=>{
    // Fetch text manually then build an ASS-rendered overlay (Multitrack uses assjs).
    // For VTT/SRT (non-ASS) we fall back to a basic <track> overlay on the inner video.
    fetch(url).then(r=>r.text()).then(text=>{
      const v = mtPlayer._.form.video;
      if(!v) return;
      // Strip any existing dynamic <track>
      Array.from(v.querySelectorAll('track[data-dynamic]')).forEach(t=>t.remove());
      const blob = new Blob([text], {type:'text/vtt'});
      const turl = URL.createObjectURL(blob);
      const tr = document.createElement('track');
      tr.kind='subtitles'; tr.label=label||'Subtitle'; tr.srclang='id';
      tr.src=turl; tr.default=true; tr.setAttribute('data-dynamic','1');
      v.appendChild(tr);
      try{ v.textTracks[v.textTracks.length-1].mode='showing'; }catch{}
    }).catch(()=>{});
  });
}

function onSubFile(file){
  if(!file) return;
  const status = document.getElementById('subsUploadStatus');
  if(!/\.(srt|vtt)$/i.test(file.name)){
    status.className='subs-status error';
    status.textContent='Format tidak didukung. Gunakan .srt atau .vtt';
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e){
    let text = e.target.result;
    if(/\.srt$/i.test(file.name)) text = srtToVtt(text);
    if(_currentSubBlobUrl) URL.revokeObjectURL(_currentSubBlobUrl);
    _currentSubBlobUrl = URL.createObjectURL(new Blob([text], {type:'text/vtt'}));
    applySubTrack(_currentSubBlobUrl, file.name.replace(/\.(srt|vtt)$/i,''));
    status.className='subs-status';
    status.textContent='✓ '+file.name;
  };
  reader.onerror = function(){
    status.className='subs-status error';
    status.textContent='Gagal membaca file.';
  };
  reader.readAsText(file, 'UTF-8');
}

/* ════════════════════════════════════════════════════════════════════
   TOAST
   ════════════════════════════════════════════════════════════════════ */
function showToast(msg, type){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.className='toast'+(type?' '+type:'')+' show';
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>{ el.className='toast'+(type?' '+type:''); }, 2400);
}

/* ════════════════════════════════════════════════════════════════════
   START
   ════════════════════════════════════════════════════════════════════ */

/* Payments, cart, collections, and preview gate */
let previewGateTimer = null;
let previewCountdownTimer = null;
let paySeasonSelection = { filmId: null, selected: new Set() };
function rupiah(n){ return 'Rp' + Number(n||0).toLocaleString('id-ID'); }
function filmEntitlementKey(f){ if(!f) return ''; if(f.tipe === 'series') return `series:${f.judul || f.tmdb_id || f.id}:season:${f.season || 1}`; return `movie:${f.id}`; }
function userHasFilmAccess(f){ if(!f) return false; if(currentTier === 'vip') return true; const key = filmEntitlementKey(f); return currentEntitlements.some(e => e.entitlement_key === key); }
function isSeriesLockedForFree(f){ return f && f.tipe === 'series' && Number(f.episode || 1) > 1 && !userHasFilmAccess(f); }
function accessPrice(f){ return f && f.tipe === 'series' ? 5000 : 2500; }
function accessLabel(f){ return f && f.tipe === 'series' ? `Season ${f.season || 1}` : 'Movie'; }
function isVipOnlyFilm(f){ return f && f.tier === 'vip'; }
function seriesIdentity(f){
  if(!f) return '';
  return f.tmdb_id ? `tmdb:${f.tmdb_id}` : `title:${String(f.judul || '').trim().toLowerCase()}`;
}
function seriesSeasonOptions(film){
  if(!film || film.tipe !== 'series') return [];
  const key = seriesIdentity(film);
  const bySeason = new Map();
  allFilms.forEach(item => {
    if(!item || item.tipe !== 'series' || seriesIdentity(item) !== key) return;
    if(isVipOnlyFilm(item)) return;
    const season = Number(item.season || 1);
    const prev = bySeason.get(season);
    if(!prev || Number(item.episode || 1) < Number(prev.episode || 1)) bySeason.set(season, item);
  });
  if(!bySeason.size && !isVipOnlyFilm(film)) bySeason.set(Number(film.season || 1), film);
  return Array.from(bySeason.entries())
    .map(([season, item]) => ({ season, film: item, price: accessPrice(item) }))
    .sort((a,b)=>a.season-b.season);
}
function selectedSeasonFilms(film){
  if(!film || film.tipe !== 'series') return film ? [film] : [];
  const selected = paySeasonSelection.selected || new Set();
  const opts = seriesSeasonOptions(film).filter(opt => selected.has(opt.season));
  return opts.length ? opts.map(opt => opt.film) : [film];
}
function renderPaySeasonSummary(film){
  const selectedFilms = selectedSeasonFilms(film);
  const total = selectedFilms.reduce((sum, item)=>sum+accessPrice(item), 0);
  const count = selectedFilms.length;
  const sub = document.getElementById('paySub');
  const buyPrice = document.getElementById('payBuyPrice');
  const seasonCount = document.getElementById('paySeasonCount');
  const cartNote = document.getElementById('payCartNote');
  if(sub) sub.textContent = `${film.judul || 'Series'} • ${count} season dipilih • ${rupiah(total)}`;
  if(buyPrice) buyPrice.textContent = rupiah(total);
  if(seasonCount) seasonCount.textContent = `${count} season`;
  if(cartNote) cartNote.textContent = `Simpan ${count} season dulu, bayar nanti.`;
}
function togglePaySeason(filmId, season){
  const film = allFilms.find(x=>String(x.id)===String(filmId));
  if(!film) return;
  const s = Number(season || 1);
  if(paySeasonSelection.filmId !== String(filmId)) paySeasonSelection = { filmId: String(filmId), selected: new Set([Number(film.season || 1)]) };
  if(paySeasonSelection.selected.has(s) && paySeasonSelection.selected.size > 1) paySeasonSelection.selected.delete(s);
  else paySeasonSelection.selected.add(s);
  document.querySelectorAll('[data-pay-season]').forEach(btn => {
    const active = paySeasonSelection.selected.has(Number(btn.dataset.paySeason || 1));
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  renderPaySeasonSummary(film);
}
function paySeasonPickerHtml(film){
  if(!film || film.tipe !== 'series') return '';
  const opts = seriesSeasonOptions(film);
  if(opts.length <= 1) return '';
  return `<div class="pay-season-panel">
    <div class="pay-section-label">Pilih season yang mau dibuka</div>
    <div class="pay-season-list">
      ${opts.map(opt=>{
        const selected = paySeasonSelection.selected.has(opt.season);
        return `<button type="button" class="pay-season-chip${selected?' selected':''}" data-pay-season="${opt.season}" aria-pressed="${selected?'true':'false'}" onclick="togglePaySeason('${film.id}', ${opt.season})">
          <b>Season ${opt.season}</b><span>${rupiah(opt.price)}</span>
        </button>`;
      }).join('')}
    </div>
  </div>`;
}
function openAccessModal(film){
  if(!film) return;
  const modal = document.getElementById('payModal');
  if(isVipOnlyFilm(film)){
    document.getElementById('payTitle').textContent = 'Khusus Member VIP';
    document.getElementById('paySub').textContent = `${film.judul || 'Judul ini'} hanya tersedia di paket VIP.`;
    document.getElementById('payActions').innerHTML = `
      <div class="pay-access-copy pay-access-copy-vip">Judul ini tidak tersedia untuk pembelian Full Access satuan. Gabung VIP untuk membuka semua koleksi premium, termasuk movie dan series VIP, tanpa iklan selama masa VIP aktif.</div>
      <button class="pay-choice premium" onclick="checkoutVip('vip_month')"><b>VIP 1 bulan</b><span><span class="pay-strike">Rp99.000</span></span><span class="pay-price">Rp49.000</span></button>
      <button class="pay-choice" onclick="checkoutVip('vip_week')"><b>VIP 1 minggu</b><span><span class="pay-strike">Rp25.000</span></span><span class="pay-price">Rp19.000</span></button>`;
    modal.classList.add('show');
    return;
  }
  paySeasonSelection = { filmId: String(film.id), selected: new Set([Number(film.season || 1)]) };
  const selectedTotal = selectedSeasonFilms(film).reduce((sum, item)=>sum+accessPrice(item), 0);
  document.getElementById('payTitle').textContent = 'Pilih akses nonton';
  document.getElementById('paySub').textContent = film.tipe === 'series'
    ? `${film.judul || 'Series'} • 1 season dipilih • ${rupiah(selectedTotal)}`
    : `${film.judul || 'Film'} • ${accessLabel(film)} • ${rupiah(selectedTotal)}`;
  document.getElementById('payActions').innerHTML = `
    <div class="pay-access-copy pay-access-copy-full">Akses Full per movie atau per series. Cocok kalau kamu ingin membuka judul pilihanmu selamanya.</div>
    ${paySeasonPickerHtml(film)}
    <button class="pay-choice premium" onclick="checkoutSelectedAccess('${film.id}')"><b>Bayar sekarang</b><span id="paySeasonCount">${film.tipe === 'series' ? '1 season' : '1 movie'}</span><span class="pay-price" id="payBuyPrice">${rupiah(selectedTotal)}</span></button>
    <button class="pay-choice" onclick="addSelectedAccessToCart('${film.id}')"><b>Masukkan keranjang</b><span id="payCartNote">Simpan dulu, bayar nanti.</span></button>
    <div class="pay-access-copy pay-access-copy-vip">Akses VIP membuka semua film dan series, tanpa iklan, semua unlock selama masa VIP aktif.</div>
    <button class="pay-choice premium" onclick="checkoutVip('vip_month')"><b>VIP 1 bulan</b><span><span class="pay-strike">Rp99.000</span></span><span class="pay-price">Rp49.000</span></button>
    <button class="pay-choice" onclick="checkoutVip('vip_week')"><b>VIP 1 minggu</b><span><span class="pay-strike">Rp25.000</span></span><span class="pay-price">Rp19.000</span></button>`;
  modal.classList.add('show');
}
function openVipPlans(){
  // Tutup modal "VIP Zone Terkunci" dulu tanpa side-effect redirect ke /home —
  // closeVipLocked() membawa user kembali ke /home kalau user di /vip & bukan VIP,
  // yang akan menutup juga payModal yang baru saja kita buka.
  document.getElementById('vipLockedModal')?.classList.remove('show');
  const modal = document.getElementById('payModal');
  document.getElementById('payTitle').textContent = 'Upgrade Premium';
  document.getElementById('paySub').textContent = 'VIP otomatis aktif setelah pembayaran berhasil.';
  document.getElementById('payActions').innerHTML =
    `<button class="pay-choice premium" onclick="checkoutVip('vip_month')"><b>VIP Premium 1 bulan</b><span><span class="pay-strike">Rp99.000</span></span><span class="pay-price">Rp49.000</span></button>`
  + `<button class="pay-choice" onclick="checkoutVip('vip_week')"><b>VIP 1 minggu</b><span><span class="pay-strike">Rp25.000</span></span><span class="pay-price">Rp19.000</span></button>`;
  modal.classList.add('show');
}
function closePayModal(){ document.getElementById('payModal')?.classList.remove('show'); }
async function startCheckout(payload){
  if(!session){ showToast('Login dulu','error'); return; }
  try{
    const r=await fetch('/api/payments/checkout',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},
      body:JSON.stringify(payload)
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok) throw new Error(d.error||'Checkout gagal');
    if(!d.checkout_url){ showToast('Checkout dibuat, tapi URL pembayaran kosong.','error'); return; }

    // Hindari full reload yang kadang kena route/cache mismatch.
    // Kalau checkout internal (/payment/checkout), pindahkan via SPA route.
    const target = new URL(String(d.checkout_url), location.origin);
    if(target.origin === location.origin && target.pathname.startsWith('/payment/checkout')){
      history.pushState({ kind:'page', name:'payment' }, '', target.pathname + target.search);
      applyRoute({ fromPopState:true });
      return;
    }
    // Untuk checkout eksternal (Violet), lanjut hard redirect normal.
    location.href = target.toString();
  }catch(e){
    showToast(e.message,'error');
  }
}
function checkoutFilm(id){
  const film = allFilms.find(x=>String(x.id)===String(id));
  if(isVipOnlyFilm(film)){ openAccessModal(film); return; }
  closePayModal();
  startCheckout({ type:'film', film_id:id });
}
function checkoutSelectedAccess(id){
  const film = allFilms.find(x=>String(x.id)===String(id));
  if(!film) return;
  if(isVipOnlyFilm(film)){ openAccessModal(film); return; }
  const selected = selectedSeasonFilms(film);
  if(!selected.length){ showToast('Season ini hanya tersedia untuk member VIP. Silakan gabung VIP untuk membukanya.', 'error'); return; }
  closePayModal();
  if(film.tipe === 'series' && selected.length > 1) startCheckout({ type:'cart', items:selected.map(item=>item.id) });
  else startCheckout({ type:'film', film_id:selected[0].id });
}
function checkoutVip(type){ closePayModal(); startCheckout({ type }); }
function ensurePaymentCheckoutStyles(){
  if(document.getElementById('paymentCheckoutStyles')) return;
  const style = document.createElement('style');
  style.id = 'paymentCheckoutStyles';
  style.textContent = `
    .pay-shell{display:grid;gap:14px;max-width:900px;margin:0 auto;animation:payFadeIn .22s ease;}
    .pay-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:14px 16px;border-radius:14px;border:1px solid var(--border);background:linear-gradient(135deg,rgba(126,151,255,.16),rgba(126,151,255,.04));}
    .pay-head-title{font-size:1.24rem;font-weight:900;letter-spacing:.01em;}
    .pay-chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:6px 10px;font-size:.78rem;color:var(--muted);}
    .pay-layout{display:grid;gap:12px;grid-template-columns:1.1fr .9fr;}
    .pay-card{border:1px solid var(--border);border-radius:14px;background:var(--surface-2);padding:14px;}
    .pay-card-title{font-weight:900;margin-bottom:10px;}
    .pay-channel-list{display:grid;gap:10px;}
    .pay-chan-card input{display:none;}
    .pay-chan-body{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);cursor:pointer;transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease;}
    .pay-chan-body:hover{transform:translateY(-1px);border-color:var(--accent-2);}
    .pay-chan-card input:checked + .pay-chan-body{border-color:var(--accent-2);box-shadow:0 0 0 1px var(--accent-2),0 10px 22px rgba(126,151,255,.18);}
    .pay-chan-icon{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:1.12rem;background:linear-gradient(135deg,rgba(126,151,255,.24),rgba(126,151,255,.08));}
    .pay-chan-name{font-weight:800;}
    .pay-chan-meta{font-size:.83rem;color:var(--muted);margin-top:2px;}
    .pay-chan-fee{font-size:.82rem;color:var(--muted);margin-top:4px;}
    .pay-items{display:grid;gap:8px;}
    .pay-item-row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;}
    .pay-item-row + .pay-item-row{border-top:1px dashed var(--border);}
    .pay-summary-line{display:flex;justify-content:space-between;gap:10px;}
    .pay-summary-muted{color:var(--muted);}
    .pay-summary-total{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:1.12rem;}
    .pay-note{font-size:.82rem;color:var(--muted);margin-top:8px;}
    .pay-btn-wrap{display:flex;justify-content:center;}
    @keyframes payFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
    @media (max-width:860px){.pay-layout{grid-template-columns:1fr;}}
  `;
  document.head.appendChild(style);
}
function paymentChannelIcon(ch){
  const code = String(ch?.code || '').toUpperCase();
  const tipe = String(ch?.tipe || '').toLowerCase();
  if(code.includes('QRIS')) return '🔳';
  if(tipe === 'va') return '🏦';
  if(tipe === 'retail') return '🏪';
  if(tipe === 'ewallet') return '📱';
  return '💳';
}
async function renderPaymentCheckoutPage(){
  const mount = document.getElementById('paymentMount');
  if(!mount) return;
  ensurePaymentCheckoutStyles();
  const q = new URLSearchParams(location.search || '');
  const ref = (q.get('ref') || q.get('ref_kode') || q.get('reference') || q.get('order_ref') || '').trim();
  if(!ref){
    mount.innerHTML = `<div style="text-align:center;color:var(--red);font-weight:700;">Parameter ref tidak ditemukan di URL.</div>`;
    return;
  }
  if(!session){
    mount.innerHTML = `<div style="text-align:center;color:var(--muted);font-weight:600;">Login dulu untuk melanjutkan pembayaran.</div>`;
    return;
  }
  mount.innerHTML = `<div style="text-align:center;color:var(--muted);">Memuat detail pembayaran...</div>`;
  try{
    const r = await fetch('/api/payments/order?ref=' + encodeURIComponent(ref), {
      headers: { Authorization: 'Bearer ' + session.access_token },
    });
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok || !d.order){
      mount.innerHTML = `<div style="text-align:center;color:var(--red);font-weight:700;">${escapeHtml(d.error || 'Order tidak ditemukan.')}</div>`;
      return;
    }
    const order = d.order;
    const meta = (order && typeof order.metadata === 'object' && order.metadata) ? order.metadata : {};
    const orderItems = Array.isArray(meta.cart_items) ? meta.cart_items : [];
    const channels = Array.isArray(d.channels) ? d.channels : [];
    if(order.status === 'success'){
      mount.innerHTML = `<div style="text-align:center;color:var(--ok);font-weight:700;">Order ini sudah dibayar.</div>`;
      return;
    }
    const first = channels[0] || null;
    const safeFee = n => Number(n || 0);
    const safeTotal = n => Number(n || 0);
    const safeAmount = Number(order.amount || 0);
    const itemCount = orderItems.length || 1;
    const channelOptions = channels.map(ch => {
      const code = String(ch.code || '').toUpperCase();
      const label = code === 'QRIS2' ? 'QRIS2' : (ch.label || ch.code || '-');
      return `<label class="pay-chan-card">
        <input type="radio" name="payChannel" value="${escapeHtml(code)}" data-fee="${safeFee(ch.fee)}" data-total="${safeTotal(ch.total)}" ${first && code===String(first.code||'').toUpperCase() ? 'checked' : ''}/>
        <div class="pay-chan-body">
          <div class="pay-chan-icon">${paymentChannelIcon(ch)}</div>
          <div style="flex:1;">
            <div class="pay-chan-name">${escapeHtml(label)}</div>
            <div class="pay-chan-meta">${escapeHtml(ch.metode || ch.tipe || '')}</div>
            <div class="pay-chan-fee">Fee: ${rupiah(ch.fee || 0)}</div>
          </div>
        </div>
      </label>`;
    }).join('');
    const itemListHtml = orderItems.length
      ? `<div class="pay-card">
          <div class="pay-card-title">Produk yang dibeli (${orderItems.length})</div>
          <div class="pay-items">
          ${orderItems.map(item=>`
            <div class="pay-item-row">
              <span>${escapeHtml(item.title || 'Film')}</span>
              <b>${rupiah(item.price || 0)}</b>
            </div>
          `).join('')}
          </div>
        </div>`
      : `<div class="pay-card">
          <div class="pay-card-title">Produk yang dibeli (1)</div>
          <div class="pay-item-row">
            <span>${escapeHtml(order.product_name || 'Pembayaran')}</span>
            <b>${rupiah(safeAmount)}</b>
          </div>
        </div>`;
    mount.innerHTML = `
      <div class="pay-shell">
        <div class="pay-head">
          <div>
            <div class="pay-head-title">Checkout Pembayaran</div>
            <div style="color:var(--muted);font-size:.86rem;">Ref: <b style="color:var(--text);">${escapeHtml(order.ref || ref)}</b></div>
          </div>
          <div class="pay-chip">🧾 ${itemCount} Produk</div>
        </div>

        <div class="pay-layout">
          <div class="pay-card">
            <div class="pay-card-title">Pilih Metode Pembayaran</div>
            <div class="pay-channel-list">
              ${channelOptions || '<div style="color:var(--red);">Channel pembayaran tidak tersedia.</div>'}
            </div>
          </div>
          ${itemListHtml}
        </div>

        <div class="pay-card">
          <div class="pay-summary-line"><span>Harga Produk</span><b id="payBase">${rupiah(safeAmount)}</b></div>
          <div class="pay-summary-line pay-summary-muted" style="margin-top:6px;"><span>Fee Channel</span><b id="payFee">${rupiah(first ? (first.fee || 0) : 0)}</b></div>
          <div class="pay-summary-line pay-summary-total"><span><b>Total Estimasi Pembayaran</b></span><b id="payTotal">${rupiah(first ? (first.total || safeAmount) : safeAmount)}</b></div>
          <div class="pay-note">Harga produk sistem tetap <b>${rupiah(safeAmount)}</b>. Fee mengikuti channel Violet (QRIS2 = 0.8%).</div>
        </div>

        <div class="pay-btn-wrap">
          <button id="payNowBtn" class="btn-primary" style="width:100%;max-width:420px;">Bayar Sekarang</button>
        </div>
      </div>
    `;
    const radios = Array.from(document.querySelectorAll('input[name="payChannel"]'));
    const feeEl = document.getElementById('payFee');
    const totalEl = document.getElementById('payTotal');
    const syncSummary = () => {
      const selected = document.querySelector('input[name="payChannel"]:checked');
      const fee = selected ? Number(selected.dataset.fee || 0) : 0;
      const total = selected ? Number(selected.dataset.total || (order.amount || 0)) : Number(order.amount || 0);
      if(feeEl) feeEl.textContent = rupiah(fee);
      if(totalEl) totalEl.textContent = rupiah(total);
    };
    radios.forEach(radio => radio.addEventListener('change', syncSummary));
    syncSummary();
    const payBtn = document.getElementById('payNowBtn');
    if(payBtn){
      payBtn.onclick = async () => {
        const selected = document.querySelector('input[name="payChannel"]:checked');
        const channel = selected ? selected.value : '';
        if(!channel){ showToast('Pilih metode pembayaran dulu.','error'); return; }
        payBtn.disabled = true;
        payBtn.textContent = 'Memproses...';
        try{
          const rs = await fetch('/api/payments/start', {
            method:'POST',
            headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+session.access_token },
            body: JSON.stringify({ ref, channel }),
          });
          const ds = await rs.json().catch(()=>({}));
          if(!rs.ok || !ds.ok || !ds.checkout_url) throw new Error(ds.error || 'Gagal memulai pembayaran.');
          location.href = ds.checkout_url;
        }catch(e){
          showToast(e.message || 'Gagal memulai pembayaran','error');
          payBtn.disabled = false;
          payBtn.textContent = 'Bayar Sekarang';
        }
      };
    }
  }catch(e){
    mount.innerHTML = `<div style="text-align:center;color:var(--red);font-weight:700;">Gagal memuat order: ${escapeHtml(e.message || 'Unknown error')}</div>`;
  }
}
function addFilmToCartItem(f){
  if(!f) return false;
  if(isVipOnlyFilm(f)) return false;
  const key=filmEntitlementKey(f);
  if(cart.some(i=>i.key===key)) return false;
  cart.push({id:String(f.id),key,title:f.judul||'Film',type:f.tipe||'movie',season:f.season||null,price:accessPrice(f),selected:true});
  return true;
}
function addToCart(id){
  const f=allFilms.find(x=>String(x.id)===String(id));
  if(!f) return;
  if(isVipOnlyFilm(f)){ openAccessModal(f); return; }
  const added = addFilmToCartItem(f);
  localStorage.setItem('zaein_cart',JSON.stringify(cart));
  updateCartCount();
  closePayModal();
  showToast(added ? 'Masuk keranjang' : 'Sudah ada di keranjang', added ? 'success' : '');
}
function addSelectedAccessToCart(id){
  const film=allFilms.find(x=>String(x.id)===String(id));
  if(!film) return;
  if(isVipOnlyFilm(film)){ openAccessModal(film); return; }
  const selected = selectedSeasonFilms(film);
  const addedCount = selected.reduce((count, item)=>count+(addFilmToCartItem(item)?1:0), 0);
  localStorage.setItem('zaein_cart',JSON.stringify(cart));
  updateCartCount();
  closePayModal();
  showToast(addedCount ? `${addedCount} item masuk keranjang` : 'Semua pilihan sudah ada di keranjang', addedCount ? 'success' : '');
}
function updateCartCount(){ const el=document.getElementById('cartCount'); if(!el) return; el.textContent=cart.length; el.style.display=cart.length?'inline-flex':'none'; }
function saveCart(){ localStorage.setItem('zaein_cart',JSON.stringify(cart)); updateCartCount(); }
function removeCartItem(key){ cart=cart.filter(i=>i.key!==key); saveCart(); renderCartPage(); }
function clearCart(){ if(!cart.length) return; if(!confirm('Kosongkan semua isi keranjang?')) return; cart=[]; saveCart(); renderCartPage(); }
function selectAllCart(val){ cart=cart.map(i=>({...i,selected:!!val})); saveCart(); renderCartPage(); }
function toggleCartItem(key, val){ cart=cart.map(i=>i.key===key?{...i,selected:!!val}:i); saveCart(); renderCartPage(); }
function selectedCartItems(){ return cart.filter(i=>i.selected !== false); }
function renderCartPage(){
  const list=document.getElementById('cartList');
  if(!list) return;
  const totalEl=document.getElementById('cartTotal');
  if(!cart.length){
    list.innerHTML='<div class="empty-state">Your cart is empty.</div>';
    if(totalEl) totalEl.textContent='Rp0';
    return;
  }
  const selected=selectedCartItems();
  const allChecked = selected.length === cart.length;
  list.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
      <button class="action-btn action-extend" onclick="selectAllCart(true)">Pilih semua</button>
      <button class="action-btn action-edit" onclick="selectAllCart(false)">Batalkan semua</button>
      <button class="action-btn action-delete" onclick="clearCart()">Hapus semua</button>
      <span style="margin-left:auto;color:var(--muted);font-size:.86rem;">Dipilih ${selected.length}/${cart.length}</span>
    </div>
    ${cart.map(i=>`<div class="cart-row">
      <label style="display:flex;align-items:center;gap:10px;min-width:0;">
        <input type="checkbox" ${i.selected!==false?'checked':''} onchange="toggleCartItem('${escapeHtml(i.key)}', this.checked)"/>
        <div>
          <div class="cart-row-title">${escapeHtml(i.title)}</div>
          <div class="cart-row-meta">${i.type==='series'?'Season '+(i.season||1):'Movie'} • ${rupiah(i.price)}</div>
        </div>
      </label>
      <button class="action-btn action-delete" onclick="removeCartItem('${escapeHtml(i.key)}')">Hapus</button>
    </div>`).join('')}
  `;
  if(totalEl) totalEl.textContent=rupiah(selected.reduce((s,i)=>s+Number(i.price||0),0));
}
async function checkoutCart(){
  const selected=selectedCartItems();
  if(!cart.length){ showToast('Cart is empty','error'); return; }
  if(!selected.length){ showToast('Pilih minimal 1 item di keranjang','error'); return; }
  await startCheckout({ type:'cart', items:selected.map(i=>i.id) });
}
function renderMyCollectionsPage(){ const grid=document.getElementById('collectionsGrid'); const empty=document.getElementById('collectionsEmpty'); const keys=new Set(currentEntitlements.map(e=>e.entitlement_key)); const items=_dedupeSeries(allFilms.filter(f=>keys.has(filmEntitlementKey(f)))); if(!items.length){ grid.innerHTML=''; empty.style.display='block'; return; } empty.style.display='none'; renderGrid('collectionsGrid', items); }

/* ════════════════════════════════════════════════════════════════════
   COLLECTIONS — public browse + detail (curated by admin)
   ════════════════════════════════════════════════════════════════════ */
let _collectionsCache = null;

async function renderCollectionsBrowsePage(){
  const grid = document.getElementById('collectionsBrowseGrid');
  const empty = document.getElementById('collectionsBrowseEmpty');
  const sub = document.getElementById('collectionsBrowseSub');
  if(!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);">Memuat koleksi...</div>';
  try{
    const r = await fetch('/api/collections');
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || 'Gagal memuat collections');
    _collectionsCache = d.collections || [];
    if(!_collectionsCache.length){
      grid.innerHTML = '';
      empty.style.display = 'block';
      sub.textContent = 'Browse popular movie franchises';
      return;
    }
    empty.style.display = 'none';
    sub.textContent = `Browse ${_collectionsCache.length} popular movie ${_collectionsCache.length === 1 ? 'collection' : 'collections'}`;
    grid.innerHTML = _collectionsCache.map(c => collectionCardHTML(c)).join('');
    grid.querySelectorAll('[data-coll-id]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const id = el.dataset.collId;
        openCollection(id);
      });
    });
  }catch(e){
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--red);">${escapeHtml(e.message || 'Error')}</div>`;
  }
}

function collectionCardHTML(c){
  const cover = c.cover_url ? `<div class="collection-card-img" style="background-image:url('${escapeHtml(c.cover_url)}')"></div>` : `<div class="collection-card-empty">${escapeHtml(c.title)}</div>`;
  // Show "3 Movies · 1 Series" instead of one collapsed count. Older API
  // responses without the split fields fall back to film_count.
  const movieCount = Number(c.movie_count || 0);
  const seriesCount = Number(c.series_count || 0);
  let countLabel;
  if (movieCount || seriesCount) {
    const parts = [];
    if (movieCount) parts.push(`${movieCount} ${movieCount === 1 ? 'Movie' : 'Movies'}`);
    if (seriesCount) parts.push(`${seriesCount} ${seriesCount === 1 ? 'Series' : 'Series'}`);
    countLabel = parts.join(' · ');
  } else {
    const count = c.film_count || 0;
    countLabel = count === 1 ? '1 movie' : `${count} movies`;
  }
  return `
    <div class="collection-card" data-coll-id="${escapeHtml(c.id)}" tabindex="0" role="button">
      ${cover}
      <div class="collection-card-shade"></div>
      <div class="collection-card-content">
        <div class="collection-card-title">${escapeHtml(c.title)}</div>
        <div class="collection-card-count">${countLabel}</div>
      </div>
    </div>
  `;
}

function openCollection(id){
  const path = '/collection/' + encodeURIComponent(id);
  if(location.pathname !== path){
    history.pushState({ kind:'collection', id: String(id) }, '', path);
  }
  goPage('collection', { fromPopState:true });
  loadCollectionDetail(id);
}

function collectionBack(){
  if(history.length > 1){ history.back(); return; }
  goPage('collections');
}

async function loadCollectionDetail(id){
  const heroBg = document.getElementById('collectionHeroBg');
  const titleEl = document.getElementById('collectionHeroTitle');
  const metaEl = document.getElementById('collectionHeroMeta');
  const descEl = document.getElementById('collectionDesc');
  const grid = document.getElementById('collectionFilmsGrid');
  if(!grid) return;
  titleEl.textContent = 'Memuat...';
  metaEl.textContent = '';
  descEl.style.display = 'none';
  grid.innerHTML = '';
  if(heroBg){ heroBg.style.backgroundImage = ''; }
  try{
    const r = await fetch('/api/collections/' + encodeURIComponent(id));
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || 'Collection tidak ditemukan');
    const c = d.collection;
    titleEl.textContent = c.title || '';
    // Hero meta uses the same split-count pattern as the collection cards.
    const heroParts = [];
    if (c.movie_count) heroParts.push(`${c.movie_count} ${c.movie_count === 1 ? 'Movie' : 'Movies'}`);
    if (c.series_count) heroParts.push(`${c.series_count} ${c.series_count === 1 ? 'Series' : 'Series'}`);
    if (heroParts.length) {
      metaEl.textContent = heroParts.join(' · ') + ' in this collection';
    } else {
      const count = c.film_count || (Array.isArray(d.films) ? d.films.length : 0);
      metaEl.textContent = (count === 1 ? '1 title' : `${count} titles`) + ' in this collection';
    }
    if(heroBg && c.cover_url){
      heroBg.style.backgroundImage = `url('${c.cover_url}')`;
    }
    if(c.description){
      descEl.textContent = c.description;
      descEl.style.display = 'block';
    }
    const films = Array.isArray(d.films) ? d.films.slice() : [];
    if(!films.length){
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="emoji">🎬</div><h3>Belum ada film</h3><p>Admin belum menambah film ke koleksi ini.</p></div>';
      return;
    }
    // Series dedupe: kalau admin sudah masukin satu series ke collection,
    // kita tampilkan SATU poster aja walau punya banyak season/episode.
    // _dedupeSeries pilih S01E01 sebagai cover. Klik poster → openFilm
    // → episode picker muncul kayak biasa.
    const dedupedFilms = _dedupeSeries(films);
    // Selalu urut berdasarkan tahun rilis (asc), terlepas dari urutan input admin.
    // Film tanpa tahun (null/0/NaN) ditaro paling belakang. Tie-breaker: judul A→Z
    // biar deterministic.
    dedupedFilms.sort((a, b) => {
      const ya = Number(a && a.tahun) || 0;
      const yb = Number(b && b.tahun) || 0;
      if(ya && yb && ya !== yb) return ya - yb;
      if(ya && !yb) return -1;
      if(!ya && yb) return 1;
      const ta = String(a && a.judul || '').toLowerCase();
      const tb = String(b && b.judul || '').toLowerCase();
      return ta.localeCompare(tb);
    });
    // Server already returns split counts in `c.movie_count`/`c.series_count`,
    // which we used above. dedupedFilms.length is just for sanity — only
    // overwrite the meta text if the server didn't supply split fields.
    if (!c.movie_count && !c.series_count) {
      metaEl.textContent = (dedupedFilms.length === 1 ? '1 title' : `${dedupedFilms.length} titles`) + ' in this collection';
    }
    grid.innerHTML = dedupedFilms.map(f => cardHTML(f)).join('');
    grid.querySelectorAll('[data-film-id]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const filmId = el.dataset.filmId;
        // Films in collections are returned with full local DB id; reuse the
        // cached `allFilms` so streaming sources resolve against the user's
        // tier / entitlement.
        const film = allFilms.find(x => String(x.id) === String(filmId));
        if(film) openFilm(film);
      });
    });
  }catch(e){
    titleEl.textContent = 'Error';
    metaEl.textContent = e.message || 'Gagal memuat collection';
  }
}
async function renderOrdersPage(){
  const wrap = document.getElementById('ordersList');
  if(!wrap) return;
  if(!session){ wrap.innerHTML = '<div class="empty-state">Login dulu untuk melihat riwayat pembelian.</div>'; return; }
  wrap.innerHTML = '<div class="empty-state">Memuat riwayat pembelian...</div>';
  try{
    const r = await fetch('/api/payments/my-orders', { headers:{ Authorization:'Bearer '+session.access_token }});
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || 'Gagal memuat riwayat');
    const orders = Array.isArray(d.orders) ? d.orders : [];
    if(!orders.length){ wrap.innerHTML = '<div class="empty-state">Belum ada pembelian.</div>'; return; }
    wrap.innerHTML = orders.map(o=>{
      const st = String(o.status||'pending').toLowerCase();
      const stColor = st==='success' ? 'var(--green)' : (st==='failed' ? 'var(--red)' : 'var(--gold)');
      const items = Array.isArray(o.items) ? o.items : [];
      const itemRows = items.map(i=>`<li style="display:flex;justify-content:space-between;gap:10px;"><span>${escapeHtml(i.title || 'Produk')}</span><b>${rupiah(i.price||0)}</b></li>`).join('');
      return `<div class="profile-card" style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div><b>${escapeHtml(o.product_name || 'Transaction')}</b><div style="color:var(--muted);font-size:.85rem;">Ref: ${escapeHtml(o.ref || '-')}</div></div>
          <div style="text-align:right;"><div style="font-weight:800;color:${stColor};text-transform:uppercase;">${escapeHtml(st)}</div><div style="font-size:.82rem;color:var(--muted);">${new Date(o.created_at).toLocaleString('id-ID')}</div></div>
        </div>
        <ul style="margin:10px 0 0;padding-left:18px;display:grid;gap:6px;">${itemRows || '<li>—</li>'}</ul>
        <div style="display:flex;justify-content:space-between;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <span style="color:var(--muted);">Metode: ${escapeHtml(o.channel || '-')}</span>
          <b>${rupiah(o.amount || 0)}</b>
        </div>
      </div>`;
    }).join('');
  }catch(e){
    wrap.innerHTML = `<div class="empty-state" style="color:var(--red);">${escapeHtml(e.message || 'Error')}</div>`;
  }
}
function fmtPreviewTime(totalSeconds){
  const s = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
}
function stopPreviewCountdown(){
  clearInterval(previewCountdownTimer);
  previewCountdownTimer = null;
  const el = document.getElementById('previewCountdown');
  if(el) el.classList.remove('show','danger');
}
function startPreviewCountdown(film){
  stopPreviewCountdown();
  const pb = film && film._playback;
  if(!pb || pb.access !== 'preview' || !pb.preview_expires_at) return;
  const box = document.getElementById('previewCountdown');
  const time = document.getElementById('previewCountdownTime');
  if(!box || !time) return;
  const label = box.querySelector('small');
  if(label) label.textContent = film && film.tipe === 'series' ? 'Preview 7 menit' : 'Preview 5 menit';
  const tick = () => {
    const left = Math.ceil((new Date(pb.preview_expires_at).getTime() - Date.now()) / 1000);
    time.textContent = fmtPreviewTime(left);
    box.classList.add('show');
    box.classList.toggle('danger', left <= 30);
    if(left <= 0){
      showPreviewGate(film && film.tipe === 'series' ? 'Preview 7 menit selesai' : 'Preview 5 menit selesai');
    }
  };
  tick();
  previewCountdownTimer = setInterval(tick, 1000);
}
function showPreviewGate(reason){
  stopPreviewCountdown();
  const gate=document.getElementById('previewGate');
  if(!gate) return;
  document.getElementById('previewGateTitle').textContent=reason||'Preview selesai';
  document.getElementById('previewGateMsg').textContent='Silahkan daftar VIP atau beli akses full untuk lanjut menonton.';
  gate.classList.add('show');
  try{ document.getElementById('vhFrame').src='about:blank'; }catch{}
}
function resetPreviewGate(){
  clearTimeout(previewGateTimer);
  previewGateTimer=null;
  stopPreviewCountdown();
  document.getElementById('previewGate')?.classList.remove('show');
}
function armPreviewGate(film){
  resetPreviewGate();
  const pb = film && film._playback;
  if(!pb || pb.access !== 'preview') return;
  startPreviewCountdown(film);
  const fallbackSeconds = pb.preview_remaining_seconds || pb.preview_seconds || (film && film.tipe === 'series' ? 420 : 300);
  const expiresAt = pb.preview_expires_at ? new Date(pb.preview_expires_at).getTime() : Date.now() + (fallbackSeconds * 1000);
  const limit = Math.max(0, expiresAt - Date.now());
  previewGateTimer=setTimeout(()=>showPreviewGate(film && film.tipe === 'series' ? 'Preview 7 menit selesai' : 'Preview 5 menit selesai'), limit);
}
function persistPreviewStop(film){
  const pb = film && film._playback;
  if(!session || !film || !pb || pb.access !== 'preview') return;
  const headers = { Authorization: 'Bearer ' + session.access_token };
  fetch('/api/playback/' + encodeURIComponent(film.id) + '/stop', {
    method:'POST',
    headers,
    keepalive:true,
  }).then(r=>r.json().catch(()=>null)).then(d=>{
    if(d && d.ok && Number.isFinite(Number(d.preview_remaining_seconds))){
      film._playback.preview_remaining_seconds = Number(d.preview_remaining_seconds);
      delete film._playback.preview_expires_at;
    }
  }).catch(()=>{});
}
window.addEventListener('beforeunload', () => {
  persistPreviewStop(currentFilm);
});

/* ════════════════════════════════════════════════════════════════════
   ROW RAIL — drag-to-scroll (desktop) + native swipe (touch)
   Replaces the old arrow buttons on the Trending/Top rows.
   ════════════════════════════════════════════════════════════════════ */
(function attachRowDragScroll(){
  const SELECTOR = '.tmdb-rail';
  const DRAG_THRESHOLD = 6; // px before we count it as a drag (vs a click)

  function attach(rail){
    if(rail.dataset.dragBound) return;
    rail.dataset.dragBound = '1';
    let isDown = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;

    rail.addEventListener('pointerdown', (e)=>{
      // Only handle primary mouse button or pen; let touch fall back to native scroll
      if(e.pointerType === 'touch') return;
      if(e.button !== 0) return;
      isDown = true;
      moved = false;
      startX = e.clientX;
      startScroll = rail.scrollLeft;
      // NOTE: do NOT call setPointerCapture here. Capturing the pointer on a
      // pointerdown that is actually just a click re-targets the subsequent
      // click event to the rail, so the card's click handler never fires
      // (Home cards became unclickable on desktop). Capture only AFTER we
      // confirm the gesture is a horizontal drag.
    });
    rail.addEventListener('pointermove', (e)=>{
      if(!isDown) return;
      const dx = e.clientX - startX;
      if(!moved && Math.abs(dx) > DRAG_THRESHOLD){
        moved = true;
        rail.classList.add('dragging');
        try{ rail.setPointerCapture(e.pointerId); }catch(_){}
      }
      if(moved){
        rail.scrollLeft = startScroll - dx;
        e.preventDefault();
      }
    });
    function endDrag(e){
      if(!isDown) return;
      isDown = false;
      if(moved){
        rail.classList.remove('dragging');
        // Swallow the click that follows the drag so cards don't open by accident.
        const swallow = (ev)=>{ ev.stopPropagation(); ev.preventDefault(); rail.removeEventListener('click', swallow, true); };
        rail.addEventListener('click', swallow, true);
        setTimeout(()=>rail.removeEventListener('click', swallow, true), 50);
      }
      moved = false;
      try{ if(e && e.pointerId != null) rail.releasePointerCapture(e.pointerId); }catch(_){}
    }
    rail.addEventListener('pointerup', endDrag);
    rail.addEventListener('pointercancel', endDrag);
    rail.addEventListener('pointerleave', endDrag);
    // Mouse wheel: convert vertical wheel into horizontal scroll for nicer desktop UX
    rail.addEventListener('wheel', (e)=>{
      if(Math.abs(e.deltaY) > Math.abs(e.deltaX)){
        rail.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive:false });
  }

  function bindAll(){ document.querySelectorAll(SELECTOR).forEach(attach); }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }
  // New rails appear after data loads — observe DOM for new ones.
  const mo = new MutationObserver(bindAll);
  mo.observe(document.documentElement, { childList:true, subtree:true });
})();

/* ════════════════════════════════════════════════════════════════════
   ANTI-INSPECT — block context menu, common devtools shortcuts,
   drag / select / copy / cut / paste outside form fields, etc.
   Typing inside <input> / <textarea> / contenteditable is preserved.
   ════════════════════════════════════════════════════════════════════ */
(function antiInspect(){
  const REDIRECT_URL = 'https://youtube.com';

  function isEditable(target){
    if(!target) return false;
    const tag = (target.tagName||'').toUpperCase();
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if(target.isContentEditable) return true;
    // Some custom elements (e.g. vidstack player inputs) — be permissive
    if(target.closest && target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]')) return true;
    return false;
  }

  function isPlayerSurface(target, ev){
    const sels = '#playerWrap,#vhFrame,#trailerIframe,#multitrackPlayer,#player2Wrap,#p2VsPlayer,media-player,video,iframe,.mjs,.mjs__video';
    try{
      const path = ev && typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      for(const node of path){
        if(!node || node.nodeType !== 1) continue;
        if(node.matches && node.matches(sels)) return true;
        if(node.closest && node.closest(sels)) return true;
      }
    }catch{}
    try{ return !!(target && target.closest && target.closest(sels)); }catch{}
    return false;
  }

  // 1) Block right-click context menu silently (no redirect).
  const contextMenuGate = (e)=> isPlayerSurface(e && e.target, e) ? true : false;
  try{ window.oncontextmenu = contextMenuGate; }catch{}
  try{ document.oncontextmenu = contextMenuGate; }catch{}
  try{ document.documentElement.oncontextmenu = contextMenuGate; }catch{}
  window.addEventListener('contextmenu', (e)=>{
    if(isPlayerSurface(e.target, e)) return true;
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);
  document.addEventListener('contextmenu', (e)=>{
    if(isPlayerSurface(e.target, e)) return true;
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);

  // 1b) Extra-hard block for media player surfaces (video / iframe /
  //     web-component shadow roots). Some player internals don't always
  //     bubble `contextmenu` to the main document.
  const mediaBlocker = (ev)=>{
    if(isPlayerSurface(ev.target, ev)) return true;
    if(isEditable(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    return false;
  };
  const mediaRightButtonBlocker = (ev)=>{
    if(ev.button !== 2) return;
    return mediaBlocker(ev);
  };
  const _boundMediaNodes = new WeakSet();
  const bindMediaNode = (node)=>{
    if(!node || _boundMediaNodes.has(node)) return;
    _boundMediaNodes.add(node);
    try{ node.oncontextmenu = null; }catch{}
    try{ node.addEventListener('contextmenu', mediaBlocker, true); }catch{}
    try{ node.addEventListener('auxclick', mediaRightButtonBlocker, true); }catch{}
    try{ node.addEventListener('mousedown', mediaRightButtonBlocker, true); }catch{}
    try{ node.addEventListener('pointerdown', mediaRightButtonBlocker, true); }catch{}
    try{ node.addEventListener('mouseup', mediaRightButtonBlocker, true); }catch{}

    // If this is an open shadow host (e.g. web component player), bind
    // inside the shadow root too.
    try{
      if(node.shadowRoot){
        bindMediaNode(node.shadowRoot);
      }
    }catch{}

    // Try same-origin iframe document (cross-origin will throw; ignore).
    try{
      if(node.tagName === 'IFRAME'){
        const doc = node.contentWindow && node.contentWindow.document;
        if(doc){
          bindMediaNode(doc);
          bindMediaNode(doc.documentElement);
          bindMediaNode(doc.body);
        }
      }
    }catch{}
  };
  const bindAllMediaSurfaces = ()=>{
    const sels = [
      '#playerWrap',
      '#hostContextShield',
      '#multitrackPlayer',
      '#player2Wrap',
      '#p2VsPlayer',
      '#vhFrame',
      '#trailerIframe',
      'media-player',
      'video',
      'iframe'
    ];
    document.querySelectorAll(sels.join(',')).forEach(bindMediaNode);
    document.querySelectorAll('video').forEach((v)=>{
      try{ v.removeAttribute('oncontextmenu'); }catch{}
      try{ v.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback'); }catch{}
      try{ v.setAttribute('disablepictureinpicture', ''); }catch{}
      try{ v.setAttribute('disableremoteplayback', ''); }catch{}
      try{ v.oncontextmenu = null; }catch{}
    });
  };
  bindAllMediaSurfaces();
  const mediaMo = new MutationObserver(bindAllMediaSurfaces);
  mediaMo.observe(document.documentElement, { childList:true, subtree:true });
  // Some players replace inner nodes lazily; refresh binder periodically.
  setInterval(bindAllMediaSurfaces, 1200);
  document.addEventListener('fullscreenchange', bindAllMediaSurfaces);

  const bindHostContextShield = ()=>{
    const shield = document.getElementById('hostContextShield');
    const frame = document.getElementById('vhFrame');
    if(!shield || shield.dataset.bound === '1') return;
    shield.dataset.bound = '1';

    const blockShieldEvent = (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    };
    const blockRightButton = (ev)=>{
      if(ev.button === 2) return blockShieldEvent(ev);
      return undefined;
    };

    shield.addEventListener('contextmenu', blockShieldEvent, true);
    shield.addEventListener('auxclick', blockRightButton, true);
    shield.addEventListener('mousedown', blockRightButton, true);
    shield.addEventListener('mouseup', blockRightButton, true);
    let shieldRestoreTimer = null;
    const armShieldRestore = (ms)=>{
      clearTimeout(shieldRestoreTimer);
      shield.style.pointerEvents = 'none';
      shieldRestoreTimer = setTimeout(()=>{ shield.style.pointerEvents = ''; }, ms);
    };
    const restoreShieldNow = ()=>{
      clearTimeout(shieldRestoreTimer);
      shieldRestoreTimer = null;
      shield.style.pointerEvents = '';
    };
    shield.addEventListener('pointerdown', (ev)=>{
      if(ev.button === 2) return blockShieldEvent(ev);
      if(ev.button !== 0 || !frame || frame.style.display === 'none') return undefined;
      // Cross-origin iframe context menus cannot be cancelled from the parent,
      // so the shield covers the full player. On left-click we briefly yield
      // to the iframe so native controls, settings, and subtitles stay usable.
      // Window kept short (300ms) so a sneaky right-click after a left-click
      // can't slip through to the iframe and surface "View frame source" /
      // "Inspect" via Chrome's native menu.
      armShieldRestore(300);
      return undefined;
    }, true);
    // If the user moves the mouse out of the player while the shield is
    // yielded, snap it back instantly — they're done interacting.
    shield.addEventListener('mouseleave', restoreShieldNow);
    shield.addEventListener('touchstart', ()=>{
      if(!frame || frame.style.display === 'none') return;
      // Touch needs a slightly longer window because tap → menu → option
      // takes more wall-time on mobile, but still well under the old 2.2s.
      armShieldRestore(600);
    }, { capture:true, passive:true });
  };
  bindHostContextShield();
  document.addEventListener('DOMContentLoaded', bindHostContextShield);

  // 2) Block keyboard shortcuts that are commonly used to inspect / steal /
  //    print / save / view source. Redirect to YouTube on hit.
  function redirectAway(){
    try{ window.location.replace(REDIRECT_URL); }
    catch(_){ window.location.href = REDIRECT_URL; }
  }
  document.addEventListener('keydown', (e)=>{
    const k = (e.key||'').toLowerCase();
    const ctrl = e.ctrlKey;
    const meta = e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    const editable = isEditable(e.target);

    // F12 — always blocked (devtools)
    if(k === 'f12' || e.keyCode === 123){
      e.preventDefault(); e.stopPropagation();
      redirectAway();
      return;
    }

    // Ctrl/Cmd + Shift + (I/J/C/K) — devtools / inspect / console
    if((ctrl || meta) && shift && (k === 'i' || k === 'j' || k === 'c' || k === 'k')){
      e.preventDefault(); e.stopPropagation();
      redirectAway();
      return;
    }

    // Cmd + Option + I (macOS devtools)
    if(meta && alt && k === 'i'){
      e.preventDefault(); e.stopPropagation();
      redirectAway();
      return;
    }

    // Plain Ctrl/Cmd + key combos. Allow typing keys inside form fields.
    if(ctrl || meta){
      // Always-block (regardless of editable): view source, save, print
      if(k === 'u' || k === 's' || k === 'p'){
        e.preventDefault(); e.stopPropagation();
        redirectAway();
        return;
      }
      // Block reload (Ctrl/Cmd + R)
      if(k === 'r'){
        e.preventDefault(); e.stopPropagation();
        redirectAway();
        return;
      }
      // Find / select-all / copy / cut — block on body but allow inside form fields
      if((k === 'f' || k === 'a' || k === 'c' || k === 'x') && !editable){
        e.preventDefault(); e.stopPropagation();
        redirectAway();
        return;
      }
    }
  }, true);

  // 3) Block drag-start globally (images, links, etc.). Inputs are fine —
  //    they don't fire dragstart for plain text selection most of the time,
  //    but we still skip editable to be safe.
  document.addEventListener('dragstart', (e)=>{
    if(isEditable(e.target)) return;
    e.preventDefault();
  }, true);

  // 4) Block text selection outside form fields.
  document.addEventListener('selectstart', (e)=>{
    if(isEditable(e.target)) return;
    e.preventDefault();
  }, true);

  // 5) Block copy / cut / paste outside form fields. Inside inputs/textareas,
  //    the user can still copy/paste normally (so login & search keep working).
  ['copy','cut','paste'].forEach(type=>{
    document.addEventListener(type, (e)=>{
      if(isEditable(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  });

  // 6) CSS hint — prevent visible selection outline app-wide except in forms.
  try{
    const style = document.createElement('style');
    style.textContent = ''+
      'html,body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}'+
      'input,textarea,select,[contenteditable="true"],[contenteditable=""]{-webkit-user-select:text;user-select:text;}';
    document.head.appendChild(style);
  }catch(_){}
})();

bootstrap();
