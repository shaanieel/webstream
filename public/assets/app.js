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
let watchlist = JSON.parse(localStorage.getItem('zaein_watchlist')||'[]');
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
          showToast('Pembayaran berhasil — akses sudah aktif.', 'success');
          // Refresh profil + entitlements supaya VIP/film akses langsung kelihatan.
          try{ if(typeof onAuthSuccess === 'function' && session) await onAuthSuccess(session); }catch(_){}
          try{ if(typeof renderProfilePage === 'function') renderProfilePage(); }catch(_){}
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
      return;
    }
    await onAuthSuccess(data.session);
  }catch(e){
    msg.textContent='Error: '+e.message;
    msg.className='auth-msg error';
    msg.style.display='block';
    btn.disabled=false; btn.textContent='Masuk';
  }
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
let _vipHeroTimer = null;
let _vipHeroIndex = 0;

function renderVipPage(){
  // VIP Zone: tampilkan film tier 'vip' (VIP saja) + 'free' (Basic + VIP) — series di-dedupe
  const vipFilms = _dedupeSeries(allFilms.filter(f=>f.tier==='vip' || f.tier==='free' || !f.tier));
  const grid = document.getElementById('vipGrid');
  const empty = document.getElementById('vipEmpty');
  const heroDesc = document.getElementById('vipHeroDesc');
  const heroFeatured = document.getElementById('vipHeroFeatured');
  const heroBg = document.getElementById('vipHeroBg');

  // Non-VIP: tampilkan modal langsung (gak boleh akses isi halaman)
  if(currentTier!=='vip'){
    showVipLocked({page:true});
    heroDesc.innerHTML = `<strong style="color:#facc15">Halaman ini hanya untuk member VIP.</strong>`;
    if(heroFeatured) heroFeatured.style.display = 'none';
    if(heroBg){ heroBg.classList.remove('show'); heroBg.style.backgroundImage = ''; }
    if(_vipHeroTimer){ clearInterval(_vipHeroTimer); _vipHeroTimer = null; }
    grid.innerHTML = '';
    empty.style.display = 'none';
    return;
  }

  heroDesc.textContent = 'Selamat datang VIP — semua film premium sudah unlock.';

  // ── Hero featured rotation: pick films with backdrops, prefer VIP-only ──
  const heroPool = vipFilms
    .filter(f => f.backdrop_url || f.poster_url)
    .sort((a, b) => {
      const av = a.tier === 'vip' ? 0 : 1;
      const bv = b.tier === 'vip' ? 0 : 1;
      if(av !== bv) return av - bv;
      return (Number(b.rating) || 0) - (Number(a.rating) || 0);
    })
    .slice(0, 6);

  const renderHeroSlot = ()=>{
    if(!heroPool.length){
      if(heroFeatured) heroFeatured.style.display = 'none';
      if(heroBg){ heroBg.classList.remove('show'); heroBg.style.backgroundImage = ''; }
      return;
    }
    const film = heroPool[_vipHeroIndex % heroPool.length];
    const bgUrl = film.backdrop_url || film.poster_url || '';
    if(heroBg){
      heroBg.style.backgroundImage = bgUrl ? `url('${bgUrl}')` : '';
      heroBg.classList.toggle('show', !!bgUrl);
    }
    if(heroFeatured){
      heroFeatured.style.display = 'flex';
      document.getElementById('vipHeroFeaturedTitle').textContent = film.judul || '';
      const cta = document.getElementById('vipHeroCta');
      if(cta){
        cta.onclick = ()=>openFilm(film, { vipMode: true });
      }
    }
  };
  renderHeroSlot();
  if(_vipHeroTimer){ clearInterval(_vipHeroTimer); _vipHeroTimer = null; }
  if(heroPool.length > 1){
    _vipHeroTimer = setInterval(()=>{
      _vipHeroIndex = (_vipHeroIndex + 1) % heroPool.length;
      renderHeroSlot();
    }, 7000);
  }

  // Cache full list for filter/search re-render without recomputing.
  document.getElementById('vipGrid')._vipFilms = vipFilms;
  applyVipFilter();
}

function applyVipFilter(){
  const grid = document.getElementById('vipGrid');
  const empty = document.getElementById('vipEmpty');
  if(!grid) return;
  const all = grid._vipFilms || [];
  const q = (_vipQuery || '').toLowerCase().trim();
  let items = all;
  if(_vipFilter === 'movie') items = items.filter(f => f.tipe !== 'series');
  else if(_vipFilter === 'series') items = items.filter(f => f.tipe === 'series');
  if(q) items = items.filter(f => (f.judul || '').toLowerCase().includes(q));
  if(!items.length){
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('h3').textContent = q ? 'Tidak ada hasil' : 'Belum ada film VIP';
    empty.querySelector('p').textContent = q
      ? `Tidak ada judul yang cocok dengan "${q}".`
      : 'Admin belum menambahkan koleksi VIP. Cek lagi nanti.';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = items.map(f=>cardHTML(f, /*vipStyle=*/true)).join('');
  grid.querySelectorAll('[data-film-id]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.filmId;
      const film = allFilms.find(x=>String(x.id)===String(id));
      if(film) openFilm(film, { vipMode: true });
    });
  });
}

function setVipFilter(filter){
  if(filter !== 'all' && filter !== 'movie' && filter !== 'series') filter = 'all';
  _vipFilter = filter;
  document.querySelectorAll('.vip-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.vipFilter === filter);
  });
  applyVipFilter();
}

function onVipSearchInput(){
  _vipQuery = document.getElementById('vipSearchInput').value || '';
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
const VALID_PAGES = ['home','search','browse','movies','tv','watchlist','cart','collections','my-collections','collection','orders','vip','profile','payment'];
let _currentPage = 'home';

function pagePath(name){
  if(name === 'home') return '/';
  if(name === 'payment') return '/payment/checkout';
  return '/' + name;
}

function goPage(name, opts){
  opts = opts || {};
  if(!VALID_PAGES.includes(name)) name = 'home';
  _currentPage = name;
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
    const target = pagePath(name);
    if(location.pathname !== target){
      history.pushState({ kind:'page', name }, '', target);
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
    // Kalau direct ke /film/vip/:id, buka VIP page di belakang modal.
    // Kalau /film/:id, tetap home.
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
    goPage(r.name, { fromPopState:true });
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
  const TMDB_KEY='5089f91e3e263d00a7bdcd3fcb0810d3';
  const IMG = CONFIG.tmdb_image_base || 'https://image.tmdb.org/t/p/w500';
  const tasks = allFilms.filter(f=>(!f.poster_url || !f.backdrop_url || !f.logo_url) && (f.tmdb_id || f.judul)).map(async (f)=>{
    try{
      let url;
      if(f.tmdb_id){
        const mt = f.tipe==='series' ? 'tv':'movie';
        url=`https://api.themoviedb.org/3/${mt}/${f.tmdb_id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=images`;
      }else{
        const mt = f.tipe==='series' ? 'tv':'movie';
        url=`https://api.themoviedb.org/3/search/${mt}?api_key=${TMDB_KEY}&query=${encodeURIComponent(f.judul)}${f.tahun?`&year=${f.tahun}`:''}&language=en-US`;
      }
      const r=await fetch(url);
      const d=await r.json();
      let m = f.tmdb_id ? d : (d.results && d.results[0]);
      if(!f.tmdb_id && m && m.id){
        const mt = f.tipe==='series' ? 'tv':'movie';
        const rd = await fetch(`https://api.themoviedb.org/3/${mt}/${m.id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=images`).then(x=>x.json()).catch(()=>null);
        if(rd && (rd.poster_path || rd.backdrop_path || rd.images)) m = { ...m, ...rd };
      }
      if(m){
        if(m.poster_path) f.poster_url = IMG + m.poster_path;
        if(m.backdrop_path) f.backdrop_url = IMG.replace('w500','w1280') + m.backdrop_path;
        const logoPath = pickTmdbLogoPath(m.images);
        if(logoPath) f.logo_url = IMG + logoPath;
        f.overview = f.overview || m.overview || '';
        f.rating = m.vote_average ? m.vote_average.toFixed(1) : null;
        f.tahun = f.tahun || (m.release_date||m.first_air_date||'').slice(0,4);
      }
    }catch{}
  });
  await Promise.all(tasks);
}

function pickTmdbLogoPath(images){
  const logos = images && Array.isArray(images.logos) ? images.logos : [];
  if(!logos.length) return '';
  const preferred = logos.find(x => x.iso_639_1 === 'en') || logos.find(x => x.iso_639_1 === null) || logos[0];
  return preferred && preferred.file_path ? preferred.file_path : '';
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
  const cwDelete = opts.cw ? `<button class="card-cw-delete show" data-cw-delete="${f.id}" aria-label="Hapus dari Continue Watching" onclick="event.stopPropagation();removeContinueWatching('${f.id}');">×</button>` : '';
  const progressPct = (opts.cw && opts.cw.progress) ? Math.min(100, Math.max(2, opts.cw.progress*100)) : 0;
  const progress = progressPct ? `<div class="card-progress-bar"><span style="width:${progressPct}%"></span></div>` : '';
  const tmdbNote = opts.tmdb && !f.is_available ? '<div class="tmdb-locked-note">Belum ada di katalog</div>' : '';
  return `
    <div class="${cls}" ${idAttr} tabindex="0">
      <div class="card-poster">
        ${rating}${tier}${cwDelete}
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
  renderGrid('moviesPageGrid', items);
}
function renderTvPage(){
  const q=(document.getElementById('tvSearchInput')?.value||'').toLowerCase().trim();
  let arr = _dedupeSeries(allFilms.filter(f=>f.tipe==='series' && _mainGridFilter(f)));
  if(q) arr = arr.filter(f=>(f.judul||'').toLowerCase().includes(q));
  renderGrid('tvPageGrid', arr);
}
function renderBrowsePage(){
  // Browse tampilkan semua kecuali film VIP-only (yang khusus di VIP Zone)
  renderGrid('browseGrid', _dedupeSeries(allFilms.filter(_mainGridFilter)));
}
function renderWatchlistPage(){
  const items = _dedupeSeries(allFilms.filter(f=>watchlist.includes(String(f.id))));
  if(!items.length){
    document.getElementById('watchlistGrid').innerHTML='';
    document.getElementById('watchlistEmpty').style.display='block';
  }else{
    document.getElementById('watchlistEmpty').style.display='none';
    renderGrid('watchlistGrid', items);
  }
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
   ════════════════════════════════════════════════════════════════════ */
function toggleWatchlist(id){
  const sid=String(id);
  const idx=watchlist.indexOf(sid);
  if(idx>=0){ watchlist.splice(idx,1); showToast('Dihapus dari watchlist'); }
  else{ watchlist.push(sid); showToast('Ditambahkan ke watchlist','success'); }
  localStorage.setItem('zaein_watchlist', JSON.stringify(watchlist));
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
     const vipMode = !!opts.vipMode;
currentPlayerTier = vipMode ? 'vip' : 'basic';
  // Tier check — show fancy locked modal instead of toast
  if((vipMode || film.tier === 'vip') && currentTier !== 'vip'){
  showVipLocked(film);
  return;
}

  currentFilm = film;
  let playback;
  try{
    playback = await fetchPlayback(film);
  }catch(e){
    showToast(e.message, 'error');
    return;
  }
  if(playback.locked){
    if(playback.reason === 'episode_locked' || playback.reason === 'preview_expired') openAccessModal(film);
    else showVipLocked(film);
    showToast(playback.message || 'Konten terkunci', 'error');
    return;
  }
  currentFilm._playback = playback;
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

  // Group all films with same judul where tipe==='series'
  const eps = allFilms.filter(f=>f.tipe==='series' && f.judul===film.judul);
  if(!eps.length){
    picker.style.display='none';
    npb.style.display='none';
    npc.style.display='none';
    return;
  }
  picker.style.display='flex';
  npb.style.display='flex';
  npc.style.display='block';

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
  // Prefer the native in-page player whenever we have a Drive source. Its
  // controls live in this document, so right-click blocking works without
  // sacrificing settings/subtitle interaction.
  const hasDriveSource = !!(film && (film.drive_path || film.drive_link || (Array.isArray(film.videos) && film.videos.length)));
  if(hasDriveSource){
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
  shield.classList.toggle('show', !!enabled);
  shield.dataset.enabled = enabled ? '1' : '0';
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
  if(p2) p2.style.display = '';

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
    if(film && film._playback && film._playback.video_url) return loadVideoHost(film);
    return;
  }

  film._sources = sources;
  activeEngine = 2;
  try{ teardownEngine1(); }catch{}
  try{ teardownEngine2(); }catch{}
  await loadVideoEngine2(film, sources);
  if(sources.videos && sources.videos[0] && sources.videos[0].path){
    setStreamActions(sources.videos[0].path, film.judul || film.title || '');
  }
  armPreviewGate(film);
}

// Hide legacy players + show video host iframe. Set up Drive Index extras
// (download + external player) ONLY for VIP films.
async function loadVideoHost(film){
  releaseVipDownloadSlot();
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
  showToast('URL video film ini tidak valid. Hubungi admin untuk memperbaiki.', 'error');
}
  }

  armPreviewGate(film);

  // VIP extras (download + external player + drive/gdrive link) — ONLY when
  // the user is on a VIP plan AND the film row has a drive backend. Basic
  // users see NOTHING below the player, per spec:
  //   "di basic gaada lagi yg didalam kotak saya tandain itu, itu hanya ada
  //    di video player yg bagian vip"
  const userIsVip = currentTier === 'vip';
  const showVipExtras = userIsVip && (film.drive_path || film.drive_link);

  if(showVipExtras){
    try{
      const param = film.drive_path
        ? 'path='+encodeURIComponent(film.drive_path)
        : 'link='+encodeURIComponent(film.drive_link);
      const r = await fetch('/api/drive/resolve?download=1&'+param, {
        headers: await authHeaders(),
      });
      const d = await r.json();
      if(d.ok && d.stream_url){
        setStreamActions(d.stream_url, film.judul || film.title || '', d.download_token || '');
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

  const rawDom = vipMode
    ? ((CONFIG && CONFIG.player4me_vip_domain) || (CONFIG && CONFIG.video_host_domain) || '')
    : ((CONFIG && CONFIG.player4me_basic_domain) || (CONFIG && CONFIG.video_host_domain) || '');

  const customDomain = String(rawDom)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');

  if(!customDomain) return '';

  return 'https://' + customDomain + '/#' + id;
}

async function _resolveFilmSources(film){
  // ── Build videos array (multi-resolution) ──
  const videos = [];
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
      if(url) audios.push({ name: t.name || t.language || 'Audio', path: url });
    }
  }
  if(!audios.length){
    audios.push({ name: 'Original', path: videos[0].path });
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
  if(!url){ document.getElementById('streamActions').style.display='none'; return; }
  const enc = encodeURIComponent(title || '');
  let b64 = '';
  try{ b64 = btoa(unescape(encodeURIComponent(url))); }catch{}
  const dl = document.getElementById('streamDlBtn');
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
    for(const t of trackEntries){
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.src = t.src;
      tr.label = t.label;
      if(t.language) tr.srclang = t.language;
      provider.appendChild(tr);
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

function _p2WireVidstack(player, aux, film){
  // Build extra chips (Quality + Audio) inside the engine toolbar so users
  // can switch even though Vidstack's built-in menu can't auto-detect them
  // for native MP4 sources.
  const bar = document.getElementById('playerEngineBar');
  if(bar && p2State){
    if(p2State.videos.length > 1){
      const chip = _p2BuildChip('Kualitas', p2State.videos.map((q, i)=>({
        label: q.name || ('Quality ' + (i+1)),
        active: i === p2State.qualityIdx,
        onSelect: ()=>{ _p2SwitchQuality(i); },
      })));
      bar.appendChild(chip);
      p2State.qualityChip = chip;
    }
    if(p2State.audios.length > 1){
      const chip = _p2BuildChip('Audio', p2State.audios.map((a, i)=>({
        label: a.name || ('Audio ' + (i+1)),
        active: i === p2State.audioIdx,
        onSelect: ()=>{ _p2SwitchAudio(i); },
      })));
      bar.appendChild(chip);
      p2State.audioChip = chip;
    }
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

  // Override the audio chip with track names from the demuxed MP4
  if(p2State.audioChip){ try{ p2State.audioChip.remove(); }catch{} p2State.audioChip = null; }
  const bar = document.getElementById('playerEngineBar');
  if(bar){
    const items = audioTracks.map((t, i)=>{
      const lang = (t.language || '').replace(/und/i,'').trim();
      const label = (t.name || lang || ('Audio '+(i+1))).toUpperCase();
      return {
        label,
        active: t.id === mseState.activeAudioId,
        onSelect: ()=>{ _p2MseSwitchAudio(t.id).catch(e=>console.error(e)); },
      };
    });
    const chip = _p2BuildChip('Audio', items);
    bar.appendChild(chip);
    p2State.audioChip = chip;
  }

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

function closePlayer(opts){
  persistPreviewStop(currentFilm);
  resetPreviewGate();
  const fullBar = document.getElementById('fullAccessBar');
  if(fullBar) fullBar.style.display = 'none';
  opts = opts || {};
  releaseVipDownloadSlot();
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
function rupiah(n){ return 'Rp' + Number(n||0).toLocaleString('id-ID'); }
function filmEntitlementKey(f){ if(!f) return ''; if(f.tipe === 'series') return `series:${f.judul || f.tmdb_id || f.id}:season:${f.season || 1}`; return `movie:${f.id}`; }
function userHasFilmAccess(f){ if(!f) return false; if(currentTier === 'vip') return true; const key = filmEntitlementKey(f); return currentEntitlements.some(e => e.entitlement_key === key); }
function isSeriesLockedForFree(f){ return f && f.tipe === 'series' && Number(f.episode || 1) > 1 && !userHasFilmAccess(f); }
function accessPrice(f){ return f && f.tipe === 'series' ? 10000 : 5000; }
function accessLabel(f){ return f && f.tipe === 'series' ? `Season ${f.season || 1}` : 'Movie'; }
function openAccessModal(film){
  if(!film) return;
  const modal = document.getElementById('payModal');
  document.getElementById('payTitle').textContent = 'Nonton full selamanya';
  document.getElementById('paySub').textContent = `${film.judul || 'Film'} • ${accessLabel(film)} • ${rupiah(accessPrice(film))}`;
  document.getElementById('payActions').innerHTML = `
    <button class="pay-choice premium" onclick="checkoutFilm('${film.id}')"><b>Bayar sekarang</b><span class="pay-price">${rupiah(accessPrice(film))}</span></button>
    <button class="pay-choice" onclick="addToCart('${film.id}')"><b>Masukkan keranjang</b><span>Simpan dulu, bayar nanti.</span></button>
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
function checkoutFilm(id){ closePayModal(); startCheckout({ type:'film', film_id:id }); }
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
function addToCart(id){ const f=allFilms.find(x=>String(x.id)===String(id)); if(!f) return; const key=filmEntitlementKey(f); if(!cart.some(i=>i.key===key)) cart.push({id:String(f.id),key,title:f.judul||'Film',type:f.tipe||'movie',season:f.season||null,price:accessPrice(f),selected:true}); localStorage.setItem('zaein_cart',JSON.stringify(cart)); updateCartCount(); closePayModal(); showToast('Masuk keranjang','success'); }
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
  const count = c.film_count || 0;
  const countLabel = count === 1 ? '1 movie' : `${count} movies`;
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
    const count = c.film_count || (Array.isArray(d.films) ? d.films.length : 0);
    metaEl.textContent = (count === 1 ? '1 movie' : `${count} movies`) + ' in this collection';
    if(heroBg && c.cover_url){
      heroBg.style.backgroundImage = `url('${c.cover_url}')`;
    }
    if(c.description){
      descEl.textContent = c.description;
      descEl.style.display = 'block';
    }
    const films = Array.isArray(d.films) ? d.films : [];
    if(!films.length){
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="emoji">🎬</div><h3>Belum ada film</h3><p>Admin belum menambah film ke koleksi ini.</p></div>';
      return;
    }
    grid.innerHTML = films.map(f => cardHTML(f)).join('');
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

  // 1) Block right-click context menu silently (no redirect).
  try{ window.oncontextmenu = ()=>false; }catch{}
  try{ document.oncontextmenu = ()=>false; }catch{}
  try{ document.documentElement.oncontextmenu = ()=>false; }catch{}
  window.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);
  document.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    e.stopPropagation();
    return false;
  }, true);

  // 1b) Extra-hard block for media player surfaces (video / iframe /
  //     web-component shadow roots). Some player internals don't always
  //     bubble `contextmenu` to the main document.
  const mediaBlocker = (ev)=>{
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
    try{ node.oncontextmenu = ()=>false; }catch{}
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
      try{ v.setAttribute('oncontextmenu', 'return false'); }catch{}
      try{ v.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback'); }catch{}
      try{ v.setAttribute('disablepictureinpicture', ''); }catch{}
      try{ v.setAttribute('disableremoteplayback', ''); }catch{}
      try{ v.oncontextmenu = ()=>false; }catch{}
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
