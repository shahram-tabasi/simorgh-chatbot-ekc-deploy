/* =========================================================================
   Simorgh Admin Console — v2 — vanilla JS SPA
   ========================================================================= */

const API  = '/api/v2/admin';
const AUTH = '/api/auth/v2';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  token: localStorage.getItem('admin_jwt') || '',
  user:  null,
  page:  null,
};

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    state.token ? { Authorization: `Bearer ${state.token}` } : {},
    opts.headers || {},
  );
  const res = await fetch((path.startsWith('http') ? '' : API) + path, {
    ...opts,
    headers,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || res.statusText;
    const err = new Error(msg); err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

async function login(email, password) {
  const res = await fetch(AUTH + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || 'Login failed'); }
  return res.json();
}

// ── DOM helpers ────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class')      n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html')  n.innerHTML = v;
    else if (v != null)     n.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(message, kind = 'info', ms = 3500) {
  const host = $('#toast-host');
  const iconSvg = kind === 'ok'
    ? `<svg class="w-4 h-4 flex-shrink-0" style="color:#4ade80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>`
    : kind === 'bad'
    ? `<svg class="w-4 h-4 flex-shrink-0" style="color:#f87171" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>`
    : `<svg class="w-4 h-4 flex-shrink-0" style="color:#a78bfa" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
  const t = el('div', { class: `toast toast-${kind}`, html: `${iconSvg}<span class="flex-1 text-slate-200">${esc(message)}</span>` });
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(12px)'; }, ms - 220);
  setTimeout(() => t.remove(), ms);
}

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal(html, opts = {}) {
  const host = $('#modal-host'), card = $('#modal-card');
  card.innerHTML = html;
  host.classList.remove('hidden');
  card.style.maxWidth = opts.wide || '';
  host.querySelector('[data-modal-backdrop]').onclick = closeModal;
  if (opts.onMount) opts.onMount(card);
}
function closeModal() {
  $('#modal-host').classList.add('hidden');
  $('#modal-card').style.maxWidth = '';
  $('#modal-card').innerHTML = '';
}

function confirmAction({ title, message, danger, onConfirm, confirmLabel = 'Confirm' }) {
  openModal(`
    <div class="flex items-start gap-3 mb-4">
      <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5
        ${danger ? 'bg-red-500/12 text-red-400' : 'bg-accent-500/12 text-accent-400'}">
        ${danger
          ? `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`
          : `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`}
      </div>
      <div>
        <h3 class="font-semibold text-white leading-snug">${esc(title)}</h3>
        <p class="text-sm text-slate-500 mt-1">${esc(message)}</p>
      </div>
    </div>
    <div class="flex justify-end gap-2">
      <button id="cm-cancel" class="btn btn-secondary">Cancel</button>
      <button id="cm-ok" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmLabel)}</button>
    </div>
  `, {
    onMount(c) {
      c.querySelector('#cm-cancel').onclick = closeModal;
      c.querySelector('#cm-ok').onclick = async () => {
        closeModal();
        try { await onConfirm(); } catch (e) { toast(e.message || 'Failed', 'bad'); }
      };
    },
  });
}

// ── Formatters ─────────────────────────────────────────────────────────────
const fmtDate = (s) => s ? new Date(s).toLocaleString() : '—';
const fmtRel  = (s) => {
  if (!s) return '—';
  const d = (Date.now() - new Date(s).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
};

function badge(text, kind = 'mute') {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

// Avatar color for a string (deterministic)
const AVATAR_COLORS = [
  'from-violet-500 to-purple-700','from-blue-500 to-indigo-700',
  'from-emerald-500 to-teal-700','from-amber-500 to-orange-700',
  'from-pink-500 to-rose-700','from-cyan-500 to-sky-700',
];
function avatarGrad(str) {
  let h = 0; for (const c of String(str)) h = (h*31 + c.charCodeAt(0)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// Audit action → css class
function auditActClass(action) {
  const a = String(action || '');
  if (a.startsWith('user'))    return 'act-user';
  if (a.startsWith('project')) return 'act-project';
  if (a.startsWith('db'))      return 'act-db';
  if (a.startsWith('system'))  return 'act-system';
  if (a.startsWith('feature')) return 'act-feature';
  if (a.startsWith('setting')) return 'act-setting';
  return 'text-slate-400';
}

// ── Pages registry ─────────────────────────────────────────────────────────
const pages = {};

const ICONS = {
  dashboard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>',
  users:     '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>',
  projects:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>',
  services:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12H3m2 0a2 2 0 104 0m-4 0a2 2 0 014 0m4 0h2m-2 0a2 2 0 104 0m-4 0a2 2 0 014 0M9 5H7a2 2 0 00-2 2v.5M9 5a2 2 0 012 2v.5M9 5V3m6 2h2a2 2 0 012 2v.5M15 5a2 2 0 00-2 2v.5m0 0H9.5"/>',
  settings:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>',
  features:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>',
  audit:     '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>',
  shell:     '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>',
};

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'users',     label: 'Users',     icon: 'users' },
  { id: 'projects',  label: 'Projects',  icon: 'projects' },
  { id: 'services',  label: 'Services',  icon: 'services' },
  { id: 'settings',  label: 'Settings',  icon: 'settings' },
  { id: 'features',  label: 'Features',  icon: 'features' },
  { id: 'audit',     label: 'Audit Log', icon: 'audit' },
  { id: 'shell',     label: 'SQL Shell', icon: 'shell' },
];

const PAGE_SUBS = {
  dashboard: 'Live overview of the Simorgh stack',
  users:     'Manage accounts, roles, and quotas',
  projects:  'Cross-user project administration',
  services:  'Container health and lifecycle control',
  settings:  'Runtime configuration (DB-backed)',
  features:  'Feature flags and rollout control',
  audit:     'Who did what, when',
  shell:     'Direct Postgres query console',
};

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  if (!state.token) return showLogin();
  try {
    const me = await fetch(AUTH + '/me', { headers: { Authorization: `Bearer ${state.token}` } });
    if (!me.ok) throw 0;
    state.user = await me.json();
    const role = (state.user.user_role || '').toLowerCase();
    if (role !== 'admin' && !state.user.is_superuser) {
      localStorage.removeItem('admin_jwt'); state.token = '';
      return showLogin('You need an admin account to access this console.');
    }
    showApp();
  } catch {
    localStorage.removeItem('admin_jwt'); state.token = '';
    showLogin();
  }
}

function showLogin(msg) {
  $('#login-screen').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');
  if (msg) {
    const e = $('#login-error'); e.textContent = msg; e.classList.remove('hidden');
  }
  $('#login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#login-error'); err.classList.add('hidden');
    try {
      const r = await login($('#login-email').value, $('#login-password').value);
      state.token = r.access_token || r.token;
      localStorage.setItem('admin_jwt', state.token);
      $('#login-screen').classList.add('hidden');
      boot();
    } catch (e) {
      err.textContent = e.message; err.classList.remove('hidden');
    }
  };
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');

  // Build sidebar
  const nav = $('#sidebar-nav'); nav.innerHTML = '';
  NAV.forEach(item => {
    const node = el('div', { class: 'nav-item', onClick: () => go(item.id) });
    node.innerHTML = `<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS[item.icon]}</svg><span>${item.label}</span>`;
    node.dataset.page = item.id;
    nav.appendChild(node);
  });

  // User chip
  const u = state.user || {};
  const name = u.display_name || u.first_name || u.email || '—';
  $('#user-name').textContent    = name;
  $('#user-email').textContent   = u.email || '';
  $('#user-initial').textContent = (name[0] || '?').toUpperCase();

  $('#logout-btn').onclick  = () => { localStorage.removeItem('admin_jwt'); state.token = ''; location.reload(); };
  $('#refresh-btn').onclick = () => state.page && go(state.page, true);

  const hash = (location.hash || '#dashboard').replace('#', '');
  go(hash);
  startHealthPolling();
}

function go(pageId, force = false) {
  if (state.page === pageId && !force) return;
  if (!pages[pageId]) pageId = 'dashboard';
  state.page = pageId;
  location.hash = pageId;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === pageId));
  const meta = NAV.find(n => n.id === pageId);
  $('#page-title').textContent    = meta.label;
  $('#page-subtitle').textContent = PAGE_SUBS[pageId] || '';
  const host = $('#page-content');
  host.innerHTML = `<div class="flex items-center justify-center py-28"><span class="spinner"></span></div>`;
  Promise.resolve(pages[pageId](host)).catch(e => {
    host.innerHTML = `<div class="card text-red-400 text-sm">${esc(e.message || 'Failed to load page')}</div>`;
  });
}

// ── Health polling ─────────────────────────────────────────────────────────
async function pollHealth() {
  const pill = $('#health-pill');
  try {
    const r = await api('/system/health-rollup');
    pill.classList.remove('hidden');
    const allOk = r.healthy === r.total;
    const cls = allOk ? 'h-pill h-pill-ok' : 'h-pill h-pill-warn';
    const dotCls = allOk ? 'pulse-ok' : 'pulse-bad';
    pill.className = cls;
    pill.innerHTML = `<span class="pulse-dot ${dotCls}" style="vertical-align:middle"></span>${r.healthy}/${r.total} healthy`;
  } catch {
    pill.classList.remove('hidden');
    pill.className = 'h-pill h-pill-err';
    pill.textContent = 'health unknown';
  }
}
let _hTimer = null;
function startHealthPolling() {
  pollHealth();
  if (_hTimer) clearInterval(_hTimer);
  _hTimer = setInterval(pollHealth, 15000);
}

// ==========================================================================
// PAGE: Dashboard
// ==========================================================================
pages.dashboard = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-5' });
  host.appendChild(wrap);

  // Skeleton row
  const statRow = el('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4' });
  for (let i = 0; i < 4; i++) statRow.appendChild(el('div', { class: 'card', html: '<div class="skeleton h-20"></div>' }));
  wrap.appendChild(statRow);

  const gridRow = el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-5' });
  const leftCard  = el('div', { class: 'card' });
  const rightCard = el('div', { class: 'card' });
  gridRow.append(leftCard, rightCard);
  wrap.appendChild(gridRow);

  const [stats, health, recent] = await Promise.all([
    api('/stats').catch(() => null),
    api('/system/health-rollup').catch(() => null),
    api('/audit?limit=8').catch(() => ({ entries: [] })),
  ]);
  const entries = recent?.entries || recent?.logs || [];

  // Stat cards
  statRow.innerHTML = '';
  const statDefs = [
    {
      label: 'Total Users', value: stats?.users?.total ?? '—', sub: `${stats?.users?.active ?? '—'} active`,
      icon: ICONS.users, iconClass: 'stat-icon-violet',
    },
    {
      label: 'Admins', value: stats?.users?.by_role?.admin ?? 0, sub: 'privileged accounts',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>',
      iconClass: 'stat-icon-blue',
    },
    {
      label: 'Healthy Services', value: health ? `${health.healthy}/${health.total}` : '—', sub: 'last probe',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>',
      iconClass: 'stat-icon-green',
    },
    {
      label: 'Audit Events', value: stats?.audit_total ?? entries.length ?? 0, sub: 'all time',
      icon: ICONS.audit, iconClass: 'stat-icon-amber',
    },
  ];
  statDefs.forEach(s => {
    const card = el('div', { class: 'card stat-card' });
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="stat-icon ${s.iconClass}">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${s.icon}</svg>
        </div>
      </div>
      <div>
        <div class="stat-num">${esc(String(s.value))}</div>
        <div class="stat-lbl">${esc(s.label)}</div>
        <div class="stat-sub">${esc(s.sub)}</div>
      </div>
    `;
    statRow.appendChild(card);
  });

  // Services health tiles (left)
  leftCard.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold text-white">Service health</h3>
      <button id="dash-svc-link" class="btn btn-ghost" style="font-size:11.5px;padding:4px 8px">View all →</button>
    </div>
    <div class="svc-grid" id="dash-svc-grid"></div>
  `;
  const svcGrid = leftCard.querySelector('#dash-svc-grid');
  if (health?.services?.length) {
    health.services.slice(0, 16).forEach(s => {
      const tile = el('div', { class: `svc-tile ${s.ok ? 'svc-ok' : 'svc-bad'}` });
      tile.innerHTML = `
        <div class="svc-tile-name truncate" title="${esc(s.name)}">${esc(s.name)}</div>
        <div class="svc-tile-status">${s.ok ? badge('OK','ok') : badge('Down','bad')}</div>
      `;
      svcGrid.appendChild(tile);
    });
  } else {
    svcGrid.innerHTML = `<div class="empty-state" style="padding:30px 0"><p>No services found</p></div>`;
  }
  leftCard.querySelector('#dash-svc-link').onclick = () => go('services');

  // Recent activity (right)
  rightCard.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold text-white">Recent activity</h3>
      <button id="dash-audit-link" class="btn btn-ghost" style="font-size:11.5px;padding:4px 8px">View all →</button>
    </div>
    <div id="dash-activity" class="space-y-0"></div>
  `;
  const actFeed = rightCard.querySelector('#dash-activity');
  if (entries.length) {
    entries.forEach(ev => {
      actFeed.innerHTML += `
        <div class="flex items-start gap-3 py-2.5 border-b border-ink-700 last:border-0">
          <div class="w-7 h-7 rounded-lg bg-ink-700 flex items-center justify-center flex-shrink-0 mt-0.5">
            <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9" stroke-width="2"/></svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-mono ${auditActClass(ev.action)} truncate">${esc(ev.action)}</div>
            <div class="text-[11px] text-slate-600 mt-0.5">${esc(ev.actor_email || 'system')} · ${fmtRel(ev.created_at)}</div>
          </div>
        </div>
      `;
    });
  } else {
    actFeed.innerHTML = `<div class="empty-state" style="padding:30px 0"><p>No recent activity</p></div>`;
  }
  rightCard.querySelector('#dash-audit-link').onclick = () => go('audit');
};

// ==========================================================================
// PAGE: Users
// ==========================================================================
pages.users = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);

  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-4 gap-3">
      <div class="flex items-center gap-2 flex-1">
        <input id="usr-q" placeholder="Search email or name…" class="input max-w-xs" />
        <select id="usr-role" class="select" style="max-width:160px">
          <option value="">All roles</option>
          <option>admin</option><option>max</option><option>pro</option><option>free</option>
        </select>
      </div>
      <button id="usr-add" class="btn btn-primary">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New User
      </button>
    </div>
    <div class="card card-sm" id="usr-table"></div>
  `;

  const card = wrap.querySelector('#usr-table');

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const q = $('#usr-q').value, role = $('#usr-role').value;
    const p = new URLSearchParams();
    if (q) p.set('search', q);
    if (role) p.set('role', role);
    p.set('per_page', '100');
    const r   = await api(`/users?${p}`);
    const users = r.users || r;
    card.innerHTML = '';

    if (!users.length) {
      card.innerHTML = `<div class="empty-state">
        <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.users}</svg>
        <h3>No users found</h3><p>Try adjusting your search or filters.</p>
      </div>`;
      return;
    }

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr>
      <th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Last seen</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');
    users.forEach(u => {
      const role  = (u.user_role || 'free').toLowerCase();
      const rKind = { admin: 'purple', max: 'info', pro: 'ok', free: 'mute' }[role] || 'mute';
      const name  = u.display_name || u.first_name || u.email || '—';
      const grad  = avatarGrad(u.email || name);
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br ${grad} flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              ${esc((name[0] || '?').toUpperCase())}
            </div>
            <div class="min-w-0">
              <div class="font-medium text-slate-200 truncate">${esc(name)}</div>
              <div class="text-[11px] text-slate-500 truncate">${esc(u.email)}</div>
            </div>
          </div>
        </td>
        <td>${badge(role, rKind)}</td>
        <td>${u.is_active ? badge('active','ok') : badge('disabled','bad')}</td>
        <td class="text-xs text-slate-500">${fmtRel(u.created_at)}</td>
        <td class="text-xs text-slate-500">${fmtRel(u.last_login_at || u.updated_at)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-ghost btn-icon" data-act="role" data-id="${u.id}" title="Change role">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" data-act="pwd" data-id="${u.id}" title="Set password">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" data-act="toggle" data-id="${u.id}" data-active="${u.is_active}" title="${u.is_active ? 'Disable' : 'Enable'}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${u.is_active ? 'M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636' : 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'}"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" style="color:#f87171" data-act="del" data-id="${u.id}" data-email="${esc(u.email)}" title="Delete">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
          </button>
        </td>
      `;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'role')   return openRoleModal(id);
      if (act === 'pwd')    return openPwdModal(id);
      if (act === 'toggle') {
        const active = b.dataset.active === 'true';
        await api(`/users/${id}/active`, { method: 'PATCH', body: { is_active: !active } });
        toast(`User ${active ? 'disabled' : 'enabled'}`, 'ok'); load(); return;
      }
      if (act === 'del') {
        confirmAction({
          title: `Delete ${b.dataset.email}?`,
          message: 'Hard delete — permanently removes the account. Use Disable instead to preserve history.',
          danger: true, confirmLabel: 'Hard delete',
          onConfirm: async () => { await api(`/users/${id}`, { method: 'DELETE', body: { hard: true } }); toast('User deleted', 'ok'); load(); },
        });
      }
    });
  }

  wrap.querySelector('#usr-add').onclick = () => openCreateUserModal(load);
  wrap.querySelector('#usr-q').oninput   = debounce(load, 250);
  wrap.querySelector('#usr-role').onchange = load;
  load();
};

function openCreateUserModal(after) {
  openModal(`
    <div class="flex items-center gap-3 mb-5">
      <div class="w-9 h-9 rounded-xl bg-accent-500/12 text-accent-400 flex items-center justify-center">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/></svg>
      </div>
      <div>
        <h3 class="font-semibold text-white">Create user</h3>
        <p class="text-xs text-slate-500 mt-0.5">Add a new account to the system</p>
      </div>
    </div>
    <div class="space-y-3">
      <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Email</label><input id="cu-email" class="input" placeholder="user@example.com"></div>
      <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Password</label><input id="cu-pwd" type="password" class="input" placeholder="••••••••"></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">First name</label><input id="cu-first" class="input" placeholder="Jane"></div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Last name</label><input id="cu-last" class="input" placeholder="Smith"></div>
      </div>
      <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Role</label>
        <select id="cu-role" class="select"><option>free</option><option>pro</option><option>max</option><option>admin</option></select>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button id="cu-cancel" class="btn btn-secondary">Cancel</button>
      <button id="cu-ok" class="btn btn-primary">Create user</button>
    </div>
  `, {
    onMount(c) {
      c.querySelector('#cu-cancel').onclick = closeModal;
      c.querySelector('#cu-ok').onclick = async () => {
        try {
          await api('/users', { method: 'POST', body: {
            email:      c.querySelector('#cu-email').value,
            password:   c.querySelector('#cu-pwd').value,
            first_name: c.querySelector('#cu-first').value || null,
            last_name:  c.querySelector('#cu-last').value  || null,
            user_role:  c.querySelector('#cu-role').value,
          }});
          closeModal(); toast('User created', 'ok'); after && after();
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

function openRoleModal(userId) {
  openModal(`
    <h3 class="font-semibold text-white mb-4">Change role</h3>
    <select id="rm-role" class="select">
      <option>free</option><option>pro</option><option>max</option><option>admin</option>
    </select>
    <div class="flex justify-end gap-2 mt-5">
      <button id="rm-cancel" class="btn btn-secondary">Cancel</button>
      <button id="rm-ok" class="btn btn-primary">Update role</button>
    </div>
  `, {
    onMount(c) {
      c.querySelector('#rm-cancel').onclick = closeModal;
      c.querySelector('#rm-ok').onclick = async () => {
        try {
          await api(`/users/${userId}/role`, { method: 'PATCH', body: { user_role: c.querySelector('#rm-role').value } });
          closeModal(); toast('Role updated', 'ok'); go('users', true);
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

function openPwdModal(userId) {
  openModal(`
    <h3 class="font-semibold text-white mb-4">Set new password</h3>
    <input id="pm-pwd" type="password" placeholder="New password…" class="input">
    <div class="flex justify-end gap-2 mt-5">
      <button id="pm-cancel" class="btn btn-secondary">Cancel</button>
      <button id="pm-ok" class="btn btn-primary">Set password</button>
    </div>
  `, {
    onMount(c) {
      c.querySelector('#pm-cancel').onclick = closeModal;
      c.querySelector('#pm-ok').onclick = async () => {
        try {
          await api(`/users/${userId}/set-password`, { method: 'POST', body: { new_password: c.querySelector('#pm-pwd').value } });
          closeModal(); toast('Password updated', 'ok');
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

// ==========================================================================
// PAGE: Projects
// ==========================================================================
pages.projects = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);

  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-4 gap-3">
      <div class="flex items-center gap-2 flex-1">
        <input id="prj-q" placeholder="Search by name or description…" class="input max-w-xs" />
        <select id="prj-status" class="select" style="max-width:160px">
          <option value="">All statuses</option>
          <option>active</option><option>paused</option><option>completed</option><option>archived</option>
        </select>
      </div>
      <button id="prj-add" class="btn btn-primary">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New Project
      </button>
    </div>
    <div class="card card-sm" id="prj-table"></div>
  `;

  const card = wrap.querySelector('#prj-table');

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const p = new URLSearchParams();
    const q = wrap.querySelector('#prj-q').value;
    const st = wrap.querySelector('#prj-status').value;
    if (q) p.set('search', q);
    if (st) p.set('status', st);
    const r = await api(`/projects?${p}`);
    card.innerHTML = '';

    const count = el('div', { class: 'text-xs text-slate-600 mb-3 px-1' });
    count.textContent = `${r.total || r.projects?.length || 0} projects`;
    card.appendChild(count);

    if (!r.projects?.length) {
      card.innerHTML += `<div class="empty-state">
        <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.projects}</svg>
        <h3>No projects found</h3><p>Adjust your filters or create a new project.</p>
      </div>`;
      return;
    }

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr>
      <th>Project</th><th>Owner</th><th>Status</th><th>Sessions</th><th>Messages</th><th>Created</th><th></th>
    </tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);

    r.projects.forEach(p => {
      const stKind = { active:'ok', paused:'warn', completed:'info', archived:'mute' }[p.status] || 'mute';
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="font-medium text-slate-200">${esc(p.name)}</div>
          <div class="text-[11px] text-slate-600 truncate max-w-xs">${esc(p.description || '—')}</div>
        </td>
        <td class="text-xs text-slate-400">${esc(p.owner_email || p.owner_id?.slice(0,8)+'…')}</td>
        <td>${badge(p.status, stKind)}</td>
        <td class="text-xs text-slate-400 text-center">${p.session_count}</td>
        <td class="text-xs text-slate-400 text-center">${p.message_count}</td>
        <td class="text-xs text-slate-500">${fmtRel(p.created_at)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" data-act="ctn-start" data-id="${p.id}" title="Start container">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 8px" data-act="ctn-stop" data-id="${p.id}" title="Stop container">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
          </button>
          <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" data-act="del" data-id="${p.id}" data-name="${esc(p.name)}" title="Delete project">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
          </button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, act = b.dataset.act;
      try {
        if (act === 'ctn-start') { const r = await api(`/projects/${id}/container/start`, { method: 'POST' }); toast(`Container ${r.state || 'started'}`, 'ok'); }
        else if (act === 'ctn-stop')  { const r = await api(`/projects/${id}/container/stop`,  { method: 'POST' }); toast(`Container ${r.state || 'stopped'}`, 'ok'); }
        else if (act === 'del') {
          confirmAction({
            title: `Delete "${b.dataset.name}"?`,
            message: 'Deletes the project, all sessions, all messages, and tears down the session container.',
            danger: true, confirmLabel: 'Delete project',
            onConfirm: async () => { await api(`/projects/${id}`, { method: 'DELETE' }); toast('Project deleted', 'ok'); load(); },
          });
        }
      } catch (e) { toast(e.message, 'bad'); }
    });
  }

  wrap.querySelector('#prj-add').onclick = async () => {
    const usersRes = await api('/users?per_page=100');
    const users = usersRes.users || usersRes;
    openModal(`
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-accent-500/12 text-accent-400 flex items-center justify-center">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.projects}</svg>
        </div>
        <div>
          <h3 class="font-semibold text-white">Create project</h3>
          <p class="text-xs text-slate-500 mt-0.5">Create on behalf of a user</p>
        </div>
      </div>
      <div class="space-y-3">
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Owner</label>
          <select id="cp-owner" class="select">${users.map(u => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}</select>
        </div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Project name</label><input id="cp-name" class="input" placeholder="My project"></div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Description</label><textarea id="cp-desc" rows="2" class="textarea" placeholder="Optional description…"></textarea></div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Agent model</label><input id="cp-model" value="gpt-4o" class="input"></div>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <button id="cp-cancel" class="btn btn-secondary">Cancel</button>
        <button id="cp-ok" class="btn btn-primary">Create project</button>
      </div>
    `, {
      onMount(c) {
        c.querySelector('#cp-cancel').onclick = closeModal;
        c.querySelector('#cp-ok').onclick = async () => {
          try {
            await api('/projects', { method: 'POST', body: {
              owner_id:    c.querySelector('#cp-owner').value,
              name:        c.querySelector('#cp-name').value,
              description: c.querySelector('#cp-desc').value || null,
              agent_model: c.querySelector('#cp-model').value,
            }});
            closeModal(); toast('Project created', 'ok'); load();
          } catch (e) { toast(e.message, 'bad'); }
        };
      },
    });
  };

  wrap.querySelector('#prj-q').oninput = debounce(load, 250);
  wrap.querySelector('#prj-status').onchange = load;
  load();
};

// ==========================================================================
// PAGE: Services
// ==========================================================================
pages.services = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-5' });
  host.appendChild(wrap);

  const cap = await api('/system/capability').catch(() => ({ docker_control: false }));
  if (!cap.docker_control) {
    wrap.appendChild(el('div', {
      class: 'card text-amber-300 text-sm flex items-start gap-3',
      html: `<svg class="w-5 h-5 flex-shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <span>Docker socket not mounted. Start / stop / restart controls are disabled. Mount <code class="code" style="padding:1px 6px;font-size:11px">/var/run/docker.sock</code> to enable container control.</span>`,
    }));
  }

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const [health, ctns] = await Promise.all([
      api('/system/health-rollup'),
      cap.docker_control ? api('/system/services').catch(() => []) : Promise.resolve([]),
    ]);
    const byName = {};
    ctns.forEach(c => byName[c.name] = c);

    card.innerHTML = '';

    // Summary bar
    const allOk = health.healthy === health.total;
    card.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <span class="pulse-dot ${allOk ? 'pulse-ok' : 'pulse-bad'}"></span>
          <span class="text-sm font-semibold text-white">${health.healthy} of ${health.total} services healthy</span>
        </div>
        <button id="svc-reload" class="btn btn-secondary">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Refresh
        </button>
      </div>
    `;
    card.querySelector('#svc-reload').onclick = load;

    // Service detail table
    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr>
      <th>Service</th><th>Port</th><th>Health</th><th>Container</th><th>Status</th><th></th>
    </tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);
    health.services.forEach(s => {
      const ctn = byName[s.container] || {};
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="flex items-center gap-2.5">
            <span class="pulse-dot ${s.ok ? 'pulse-ok' : 'pulse-bad'}"></span>
            <span class="font-medium text-slate-200">${esc(s.name)}</span>
          </div>
        </td>
        <td class="text-xs text-slate-500 font-mono">${s.port}</td>
        <td>${s.ok ? badge('OK','ok') : badge('Down','bad')}</td>
        <td class="text-xs">${ctn.state ? badge(ctn.state, ctn.state === 'running' ? 'ok' : 'mute') : '<span class="text-slate-600">—</span>'}</td>
        <td class="text-xs text-slate-500">${esc(ctn.status || '—')}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-ghost btn-icon" data-act="logs" data-name="${esc(s.container)}" title="View logs">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </button>
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 9px" data-act="start" data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>Start</button>
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 9px" data-act="stop" data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>Stop</button>
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 9px" data-act="restart" data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>Restart</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const name = b.dataset.name, act = b.dataset.act;
      try {
        if (act === 'logs') return openLogsModal(name);
        await api(`/system/services/${name}/${act}`, { method: 'POST' });
        toast(`${act} ${name}`, 'ok');
        setTimeout(load, 700);
      } catch (e) { toast(e.message, 'bad'); }
    });
  }
  load();
};

function openLogsModal(name) {
  openModal(`
    <div class="flex items-center justify-between mb-3">
      <div>
        <h3 class="font-semibold text-white">Container logs</h3>
        <p class="text-xs text-slate-500 mt-0.5 font-mono">${esc(name)}</p>
      </div>
      <div class="flex gap-2">
        <button id="lm-refresh" class="btn btn-secondary btn-icon" title="Refresh">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </button>
        <button id="lm-close" class="btn btn-secondary btn-icon" title="Close">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    <div id="lm-body" class="code overflow-auto" style="max-height:60vh;min-height:200px">
      <div class="flex justify-center py-8"><span class="spinner"></span></div>
    </div>
  `, { wide: '62rem',
    onMount(c) {
      const loadLogs = async () => {
        try {
          const r = await api(`/system/services/${name}/logs?tail=400`);
          const body = c.querySelector('#lm-body');
          body.textContent = r.logs || '(no output)';
          body.scrollTop = body.scrollHeight;
        } catch (e) { c.querySelector('#lm-body').textContent = e.message; }
      };
      c.querySelector('#lm-close').onclick   = closeModal;
      c.querySelector('#lm-refresh').onclick = loadLogs;
      loadLogs();
    },
  });
}

// ==========================================================================
// PAGE: Settings
// ==========================================================================
pages.settings = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);

  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-4 gap-3">
      <div class="flex items-center gap-2 flex-1 flex-wrap">
        <input id="st-q" placeholder="Search key…" class="input" style="max-width:220px"/>
        <select id="st-cat" class="select" style="max-width:180px"><option value="">All categories</option></select>
        <label class="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
          <input type="checkbox" id="st-reveal" class="accent-accent-500"> Reveal secrets
        </label>
      </div>
      <button id="st-add" class="btn btn-primary">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New Setting
      </button>
    </div>
    <div class="card card-sm" id="st-table"></div>
  `;

  try {
    const cats = await api('/settings/categories');
    const sel = wrap.querySelector('#st-cat');
    cats.forEach(c => sel.appendChild(el('option', { value: c.category }, `${c.category} (${c.count})`)));
  } catch {}

  const card = wrap.querySelector('#st-table');

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const p = new URLSearchParams();
    const q = wrap.querySelector('#st-q').value.toLowerCase();
    const cat = wrap.querySelector('#st-cat').value;
    const reveal = wrap.querySelector('#st-reveal').checked;
    if (cat) p.set('category', cat);
    if (reveal) p.set('reveal', '1');
    const rows = await api(`/settings?${p}`);
    const filtered = q ? rows.filter(r => r.key.toLowerCase().includes(q)) : rows;
    card.innerHTML = '';

    if (!filtered.length) {
      card.innerHTML = `<div class="empty-state">
        <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.settings}</svg>
        <h3>No settings found</h3><p>Try a different search or category.</p>
      </div>`;
      return;
    }

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr>
      <th>Key</th><th>Scope</th><th>Value</th><th>Type</th><th>Flags</th><th></th>
    </tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);
    filtered.forEach(r => {
      const val = r.value == null
        ? `<span class="text-slate-600 italic text-xs">(unset)</span>`
        : `<span class="code" style="padding:2px 7px;font-size:11px;display:inline-block">${esc(String(r.value).slice(0,80))}</span>`;
      const flags = [];
      if (r.is_secret)        flags.push(badge('secret','purple'));
      if (r.requires_restart) flags.push(badge('restart','warn'));
      if (r.is_readonly)      flags.push(badge('readonly','mute'));
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="font-mono text-xs text-slate-200">${esc(r.key)}</div>
          <div class="text-[11px] text-slate-600 truncate max-w-xs">${esc(r.description || '')}</div>
        </td>
        <td class="text-xs text-slate-500">${esc(r.scope || '—')}</td>
        <td style="max-width:280px">${val}</td>
        <td>${badge(r.value_type,'mute')}</td>
        <td class="space-x-1">${flags.join('')}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-ghost" data-act="edit" data-key="${esc(r.key)}" data-scope="${esc(r.scope||'')}" ${r.is_readonly?'disabled':''} style="font-size:11.5px;padding:4px 9px">Edit</button>
          <button class="btn btn-ghost" data-act="del" data-key="${esc(r.key)}" data-scope="${esc(r.scope||'')}" ${r.is_readonly?'disabled':''} style="font-size:11.5px;padding:4px 9px;color:#f87171">Delete</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const key = b.dataset.key, scope = b.dataset.scope, act = b.dataset.act;
      if (act === 'edit') return openSettingModal(key, scope, load);
      if (act === 'del') confirmAction({
        title: `Delete setting "${key}"?`,
        message: `Scope: ${scope || 'global'}`,
        danger: true, confirmLabel: 'Delete',
        onConfirm: async () => {
          await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' });
          toast('Setting deleted', 'ok'); load();
        },
      });
    });
  }

  wrap.querySelector('#st-add').onclick    = () => openSettingModal(null, '', load);
  wrap.querySelector('#st-q').oninput     = debounce(load, 250);
  wrap.querySelector('#st-cat').onchange  = load;
  wrap.querySelector('#st-reveal').onchange = load;
  load();
};

async function openSettingModal(key, scope, after) {
  let c = {};
  if (key) { try { c = await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}&reveal=1`); } catch {} }
  openModal(`
    <div class="flex items-center gap-3 mb-5">
      <div class="w-9 h-9 rounded-xl bg-accent-500/12 text-accent-400 flex items-center justify-center">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.settings}</svg>
      </div>
      <h3 class="font-semibold text-white">${key ? 'Edit setting' : 'New setting'}</h3>
    </div>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Key</label>
          <input id="se-key" class="input font-mono text-xs" value="${esc(c.key||'')}" ${key?'disabled':''}></div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Scope</label>
          <input id="se-scope" class="input text-xs" value="${esc(c.scope||'')}" placeholder="empty = global"></div>
      </div>
      <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Value</label>
        <textarea id="se-val" rows="3" class="textarea">${esc(c.value ?? '')}</textarea></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Type</label>
          <select id="se-type" class="select">${['string','int','float','bool','json'].map(t=>`<option${c.value_type===t?' selected':''}>${t}</option>`).join('')}</select></div>
        <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Category</label>
          <input id="se-cat" class="input" value="${esc(c.category||'general')}"></div>
      </div>
      <div><label class="block text-xs text-slate-500 mb-1.5 font-medium">Description</label>
        <input id="se-desc" class="input" value="${esc(c.description||'')}" placeholder="What does this setting control?"></div>
      <div class="flex gap-5 text-xs text-slate-400 pt-1">
        <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="se-secret" ${c.is_secret?'checked':''} class="accent-accent-500"> Secret</label>
        <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="se-restart" ${c.requires_restart?'checked':''} class="accent-accent-500"> Requires restart</label>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button id="se-cancel" class="btn btn-secondary">Cancel</button>
      <button id="se-ok" class="btn btn-primary">${key ? 'Save changes' : 'Create setting'}</button>
    </div>
  `, {
    onMount(card) {
      card.querySelector('#se-cancel').onclick = closeModal;
      card.querySelector('#se-ok').onclick = async () => {
        const body = {
          key:              card.querySelector('#se-key').value,
          scope:            card.querySelector('#se-scope').value,
          value:            card.querySelector('#se-val').value,
          value_type:       card.querySelector('#se-type').value,
          category:         card.querySelector('#se-cat').value,
          description:      card.querySelector('#se-desc').value,
          is_secret:        card.querySelector('#se-secret').checked,
          requires_restart: card.querySelector('#se-restart').checked,
        };
        try {
          if (key) await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`, { method: 'PATCH', body });
          else     await api('/settings', { method: 'POST', body });
          closeModal(); toast('Saved', 'ok'); after && after();
        } catch (e) { toast(e.message, 'bad'); }
      };
    },
  });
}

// ==========================================================================
// PAGE: Features
// ==========================================================================
pages.features = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);
  const card = el('div', { class: 'card card-sm' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const rows = await api('/features');
    card.innerHTML = '';

    if (!rows.length) {
      card.innerHTML = `<div class="empty-state">
        <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.features}</svg>
        <h3>No features defined</h3><p>Feature flags will appear here once configured.</p>
      </div>`;
      return;
    }

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr>
      <th>Feature</th><th>Category</th><th>Min role</th><th>Enabled</th><th></th>
    </tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);

    rows.forEach(f => {
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="font-medium text-slate-200">${esc(f.name)}</div>
          <div class="text-[11px] text-slate-500 truncate max-w-sm">${esc(f.description || '—')}</div>
        </td>
        <td class="text-xs text-slate-400">${esc(f.category || '—')}</td>
        <td>${badge(f.min_role || 'free', f.min_role === 'admin' ? 'purple' : 'info')}</td>
        <td>
          <div class="toggle-track ${f.enabled ? 'tog-on' : ''}" data-act="toggle" data-name="${esc(f.name)}" data-on="${f.enabled}" style="cursor:pointer">
            <div class="toggle-thumb"></div>
          </div>
        </td>
        <td class="text-right">
          <button class="btn btn-ghost" data-act="role" data-name="${esc(f.name)}" style="font-size:11.5px;padding:4px 9px">Min role</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act="toggle"]').forEach(b => b.onclick = async () => {
      const isOn = b.dataset.on === 'true';
      try {
        await api(`/features/${b.dataset.name}`, { method: 'PATCH', body: { enabled: !isOn } });
        toast(`Feature ${isOn ? 'disabled' : 'enabled'}`, 'ok'); load();
      } catch (e) { toast(e.message, 'bad'); }
    });

    card.querySelectorAll('[data-act="role"]').forEach(b => b.onclick = () => {
      openModal(`
        <h3 class="font-semibold text-white mb-1">${esc(b.dataset.name)}</h3>
        <p class="text-xs text-slate-500 mb-4">Set the minimum role required to use this feature</p>
        <select id="fr-role" class="select"><option>free</option><option>pro</option><option>max</option><option>admin</option></select>
        <div class="flex justify-end gap-2 mt-5">
          <button id="fr-cancel" class="btn btn-secondary">Cancel</button>
          <button id="fr-ok" class="btn btn-primary">Update</button>
        </div>
      `, {
        onMount(c) {
          c.querySelector('#fr-cancel').onclick = closeModal;
          c.querySelector('#fr-ok').onclick = async () => {
            try {
              await api(`/features/${b.dataset.name}`, { method: 'PATCH', body: { min_role: c.querySelector('#fr-role').value } });
              closeModal(); toast('Updated', 'ok'); load();
            } catch (e) { toast(e.message, 'bad'); }
          };
        },
      });
    });
  }
  load();
};

// ==========================================================================
// PAGE: Audit
// ==========================================================================
pages.audit = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);

  wrap.innerHTML = `
    <div class="flex items-center gap-2 mb-4 flex-wrap">
      <input id="au-action" placeholder="Filter action (e.g. user.role_change)" class="input" style="max-width:280px"/>
      <input id="au-target" placeholder="Target type (user, project…)" class="input" style="max-width:200px"/>
      <select id="au-limit" class="select" style="max-width:110px">
        <option>50</option><option>100</option><option>200</option><option>500</option>
      </select>
    </div>
    <div class="card card-sm" id="au-table"></div>
  `;

  const card = wrap.querySelector('#au-table');

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-10"><span class="spinner"></span></div>`;
    const p = new URLSearchParams();
    if (wrap.querySelector('#au-action').value) p.set('action', wrap.querySelector('#au-action').value);
    if (wrap.querySelector('#au-target').value) p.set('target_type', wrap.querySelector('#au-target').value);
    p.set('limit', wrap.querySelector('#au-limit').value);
    const r = await api(`/audit?${p}`);
    const entries = r.entries || r.logs || [];
    card.innerHTML = '';

    if (!entries.length) {
      card.innerHTML = `<div class="empty-state">
        <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS.audit}</svg>
        <h3>No audit events</h3><p>Activity will appear here as actions are performed.</p>
      </div>`;
      return;
    }

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);

    entries.forEach(ev => {
      const tr = el('tr');
      const sqlDetail = ev.metadata?.sql
        ? `<div class="code mt-1.5" style="max-height:80px;overflow:auto;font-size:10.5px">${esc(ev.metadata.sql)}</div>`
        : '';
      tr.innerHTML = `
        <td class="whitespace-nowrap">
          <div class="text-xs text-slate-300">${fmtDate(ev.created_at)}</div>
          <div class="text-[10px] text-slate-600 mt-0.5">${fmtRel(ev.created_at)}</div>
        </td>
        <td class="text-xs text-slate-400">${esc(ev.actor_email || '—')}</td>
        <td>
          <span class="font-mono text-xs ${auditActClass(ev.action)}">${esc(ev.action)}</span>
          ${sqlDetail}
        </td>
        <td class="text-xs text-slate-500">${esc((ev.target_type || '') + ' ' + (ev.target_id || ''))}</td>
        <td class="text-xs text-slate-600 font-mono">${esc(ev.ip_address || '—')}</td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);
  }

  wrap.querySelector('#au-action').oninput = debounce(load, 250);
  wrap.querySelector('#au-target').oninput = debounce(load, 250);
  wrap.querySelector('#au-limit').onchange = load;
  load();
};

// ==========================================================================
// PAGE: SQL Shell
// ==========================================================================
pages.shell = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-4' });
  host.appendChild(wrap);

  // Warning banner
  wrap.innerHTML = `
    <div class="card" style="border-color:rgba(245,158,11,0.25);background:rgba(245,158,11,0.04)">
      <div class="flex items-start gap-3">
        <svg class="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        </svg>
        <p class="text-xs text-amber-300">
          Full read+write SQL access. Every query is audit-logged with the actor, SQL text, and elapsed time.
          DDL/DML runs in autocommit — there is no rollback. Use <code class="code" style="padding:1px 6px">SELECT</code> for exploration.
        </p>
      </div>
    </div>
  `;

  // Main split
  const split = el('div', { class: 'grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-4' });
  wrap.appendChild(split);

  // Tables pane
  const tablesPane = el('div', { class: 'card card-sm overflow-y-auto', style: 'max-height:80vh' });
  split.appendChild(tablesPane);

  // Right column
  const right = el('div', { class: 'space-y-4' });
  split.appendChild(right);

  // Editor card
  right.innerHTML = `
    <div class="terminal-wrap">
      <div class="terminal-bar">
        <div class="t-dot t-dot-r"></div>
        <div class="t-dot t-dot-y"></div>
        <div class="t-dot t-dot-g"></div>
        <span class="terminal-bar-title">SQL Console</span>
        <div class="flex items-center gap-2 ml-auto">
          <select id="sh-db" class="select" style="max-width:110px;background:#060710;font-size:12px;padding:5px 10px;border-color:#1a1d2e">
            <option value="auth">auth</option><option value="chat">chat</option>
          </select>
          <span id="sh-status" class="text-xs text-slate-600 font-mono"></span>
          <button id="sh-run" class="btn btn-primary" style="font-size:12px;padding:5px 12px">Run ⌘↵</button>
        </div>
      </div>
      <div style="padding:12px">
        <textarea id="sh-sql" class="textarea" rows="8" placeholder="SELECT * FROM users LIMIT 10;"
          style="background:transparent;border-color:#111420;resize:vertical;width:100%"></textarea>
      </div>
    </div>
    <div id="sh-out" class="card card-sm"></div>
  `;

  // Table browser
  async function loadTables() {
    tablesPane.innerHTML = `<div class="flex justify-center py-6"><span class="spinner"></span></div>`;
    try {
      const r = await api(`/db/tables?database=${$('#sh-db').value}`);
      tablesPane.innerHTML = `<div class="text-[10px] text-slate-600 uppercase tracking-widest font-semibold mb-2 px-1">Tables · ${esc(r.database)}</div>`;
      r.tables.forEach(t => {
        const item = el('div', {
          class: 'flex items-center justify-between text-xs px-2 py-1.5 rounded-lg cursor-pointer',
          style: 'transition:background 80ms',
        });
        item.innerHTML = `
          <span class="font-mono text-slate-400 truncate">${esc(t.name)}</span>
          <span class="text-slate-600 ml-2 flex-shrink-0">${t.est_rows ? `~${Number(t.est_rows).toLocaleString()}` : ''}</span>
        `;
        item.onmouseenter = () => item.style.background = 'rgba(255,255,255,0.04)';
        item.onmouseleave = () => item.style.background = '';
        item.onclick = () => { $('#sh-sql').value = `SELECT * FROM ${t.name} LIMIT 50;`; };
        tablesPane.appendChild(item);
      });
    } catch (e) {
      tablesPane.innerHTML = `<div class="text-xs text-red-400 p-2">${esc(e.message)}</div>`;
    }
  }

  async function run() {
    const sql = $('#sh-sql').value.trim();
    if (!sql) return;
    $('#sh-status').textContent = 'Running…';
    $('#sh-out').innerHTML = `<div class="flex items-center justify-center py-8"><span class="spinner"></span></div>`;
    try {
      const r = await api('/db/query', { method: 'POST', body: { sql, database: $('#sh-db').value } });
      const suffix = r.truncated ? ' <span style="color:#fbbf24">(truncated)</span>' : '';
      $('#sh-status').innerHTML = `<span style="color:#4ade80">${r.op}</span> · ${r.elapsed_ms} ms · ${r.rowcount ?? 0} rows${suffix}`;
      renderResult(r);
    } catch (e) {
      $('#sh-status').innerHTML = `<span style="color:#f87171">Error</span>`;
      $('#sh-out').innerHTML = `<div class="text-red-400 text-sm font-mono">${esc(e.message)}</div>`;
    }
  }

  function renderResult(r) {
    const out = $('#sh-out');
    if (r.error) {
      out.innerHTML = `<div class="code text-red-400">${esc(r.error)}</div>`;
      return;
    }
    if (!r.columns?.length) {
      out.innerHTML = `<div class="flex items-center gap-2 text-sm text-slate-400">
        <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        ${esc(r.op)} — ${r.rowcount ?? 0} rows affected
      </div>`;
      return;
    }
    out.innerHTML = '';
    const wrap = el('div', { class: 'overflow-auto', style: 'max-height:60vh' });
    const tbl = el('table', { class: 'table' });
    const head = '<thead><tr>' + r.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead>';
    const body = '<tbody>' + r.rows.map(row =>
      '<tr>' + row.map(v =>
        v === null
          ? `<td><span class="text-slate-600 italic" style="font-size:11px">NULL</span></td>`
          : `<td class="font-mono text-xs text-slate-300">${esc(String(v))}</td>`
      ).join('') + '</tr>'
    ).join('') + '</tbody>';
    tbl.innerHTML = head + body;
    wrap.appendChild(tbl);
    out.appendChild(wrap);
  }

  $('#sh-run').onclick = run;
  $('#sh-db').onchange = loadTables;
  $('#sh-sql').addEventListener('keydown', ev => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); run(); }
  });
  loadTables();
};

// ── Go ─────────────────────────────────────────────────────────────────────
boot();
