/* =========================================================================
   Simorgh Admin Console — vanilla JS SPA
   ----------------------------------------------------------------------- */

const API = '/api/v2/admin';
const AUTH = '/api/auth/v2';

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const state = {
  token: localStorage.getItem('admin_jwt') || '',
  user:  null,
  page:  null,
};

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    state.token ? { Authorization: `Bearer ${state.token}` } : {},
    opts.headers || {},
  );
  const res = await fetch((path.startsWith('http') ? '' : API) + path, {
    ...opts, headers, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
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
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.detail || 'Login failed');
  }
  return res.json();
}

// --------------------------------------------------------------------------
// UI helpers
// --------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class')      n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html')  n.innerHTML = v;
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toast(message, kind = 'info', timeoutMs = 3500) {
  const host = $('#toast-host');
  const icon = kind === 'ok' ? '✓' : kind === 'bad' ? '✕' : 'i';
  const t = el('div', { class: `toast toast-${kind}` }, [
    el('div', { class: `pulse-dot pulse-${kind === 'bad' ? 'bad' : 'ok'}`, style: 'animation:none' }),
    el('div', { class: 'flex-1' }, message),
  ]);
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, timeoutMs - 200);
  setTimeout(() => t.remove(), timeoutMs);
}

function openModal(html, opts = {}) {
  const host = $('#modal-host'), card = $('#modal-card');
  card.innerHTML = html;
  host.classList.remove('hidden');
  host.querySelector('[data-modal-backdrop]').onclick = () => closeModal();
  if (opts.wide) card.style.maxWidth = opts.wide;
  if (opts.onMount) opts.onMount(card);
}
function closeModal() {
  $('#modal-host').classList.add('hidden');
  $('#modal-card').style.maxWidth = '';
  $('#modal-card').innerHTML = '';
}

function confirmAction({ title, message, danger, onConfirm, confirmLabel = 'Confirm' }) {
  openModal(`
    <h3 class="text-base font-semibold mb-2">${esc(title)}</h3>
    <p class="text-sm text-slate-400 mb-5">${esc(message)}</p>
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

const fmtDate = (s) => s ? new Date(s).toLocaleString() : '—';
const fmtRel = (s) => {
  if (!s) return '—';
  const diff = (Date.now() - new Date(s).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

function badge(text, kind = 'mute') {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

// --------------------------------------------------------------------------
// Pages registry
// --------------------------------------------------------------------------
const pages = {};

const ICONS = {
  dashboard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>',
  users:     '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>',
  projects:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>',
  services:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12V7a2 2 0 012-2h10a2 2 0 012 2v5M5 12h14M5 12v5a2 2 0 002 2h10a2 2 0 002-2v-5M9 8h.01M9 16h.01"/>',
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

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
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

  // Sidebar
  const nav = $('#sidebar-nav'); nav.innerHTML = '';
  NAV.forEach(item => {
    const node = el('div', { class: 'nav-item', onClick: () => go(item.id) }, []);
    node.innerHTML = `<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS[item.icon]}</svg><span>${item.label}</span>`;
    node.dataset.page = item.id;
    nav.appendChild(node);
  });

  // User chip
  const u = state.user || {};
  const name = u.display_name || u.first_name || u.email || '—';
  $('#user-name').textContent = name;
  $('#user-email').textContent = u.email || '';
  $('#user-initial').textContent = (name[0] || '?').toUpperCase();

  $('#logout-btn').onclick = () => {
    localStorage.removeItem('admin_jwt'); state.token = '';
    location.reload();
  };
  $('#refresh-btn').onclick = () => state.page && go(state.page, true);

  // Initial route via hash
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
  $('#page-title').textContent = meta.label;
  $('#page-subtitle').textContent = pageSubs[pageId] || '';
  const host = $('#page-content');
  host.innerHTML = '<div class="flex items-center justify-center py-24"><span class="spinner"></span></div>';
  Promise.resolve(pages[pageId](host)).catch(e => {
    host.innerHTML = `<div class="card text-red-400 text-sm">${esc(e.message || 'Failed to load')}</div>`;
  });
}

const pageSubs = {
  dashboard: 'Live overview of the Simorgh stack',
  users:     'Manage accounts, roles, and quotas',
  projects:  'Cross-user project administration',
  services:  'Container health and lifecycle control',
  settings:  'Runtime configuration (DB-backed env)',
  features:  'Feature flags and per-user overrides',
  audit:     'Who did what, when',
  shell:     'Direct Postgres query console',
};

// --------------------------------------------------------------------------
// Health polling (top-right pill)
// --------------------------------------------------------------------------
async function pollHealth() {
  try {
    const r = await api('/system/health-rollup');
    const pill = $('#health-pill');
    pill.classList.remove('hidden');
    const allOk = r.healthy === r.total;
    pill.className = `text-xs px-2.5 py-1 rounded-full border ${
      allOk ? 'border-green-500/40 text-green-400 bg-green-500/10'
            : 'border-amber-500/40 text-amber-400 bg-amber-500/10'}`;
    pill.innerHTML = `<span class="pulse-dot ${allOk ? 'pulse-ok' : 'pulse-bad'}" style="vertical-align:middle;margin-right:6px"></span>${r.healthy}/${r.total} services`;
  } catch {
    const pill = $('#health-pill');
    pill.classList.remove('hidden');
    pill.className = 'text-xs px-2.5 py-1 rounded-full border border-slate-500/40 text-slate-400 bg-slate-500/10';
    pill.textContent = 'Health unknown';
  }
}
let healthTimer = null;
function startHealthPolling() {
  pollHealth();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(pollHealth, 15000);
}

// ==========================================================================
// PAGE: Dashboard
// ==========================================================================
pages.dashboard = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-5' });
  host.appendChild(wrap);

  // Stat row
  const statsRow = el('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4' });
  wrap.appendChild(statsRow);

  // Two-column row
  const grid = el('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-5' });
  const left = el('div', { class: 'card' });
  const right = el('div', { class: 'card' });
  grid.append(left, right);
  wrap.appendChild(grid);

  // Parallel fetch
  const [stats, health, recent] = await Promise.all([
    api('/stats').catch(() => null),
    api('/system/health-rollup').catch(() => null),
    api('/audit?limit=8').catch(() => ({ entries: [] })),
  ]);
  const recentEntries = recent?.entries || recent?.logs || [];

  const cards = [
    { label: 'Total users',     value: stats?.users?.total ?? '—', sub: `${stats?.users?.active ?? '—'} active` },
    { label: 'Admins',          value: stats?.users?.by_role?.admin ?? 0, sub: 'role=admin' },
    { label: 'Healthy services',value: `${health?.healthy ?? '—'} / ${health?.total ?? '—'}`, sub: 'last probe' },
    { label: 'Audit events',    value: stats?.audit_total ?? recentEntries.length ?? 0, sub: 'recent' },
  ];
  for (const c of cards) {
    statsRow.appendChild(el('div', { class: 'card stat-card' }, [
      el('div', { class: 'label' }, c.label),
      el('div', { class: 'value' }, String(c.value)),
      el('div', { class: 'sub' }, c.sub),
    ]));
  }

  // Service health summary (left)
  left.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold">Service health</h3>
      <button class="btn btn-ghost" onclick="(${() => go('services')})()">View all →</button>
    </div>
  `;
  const list = el('div', { class: 'space-y-1.5 max-h-96 overflow-y-auto pr-1' });
  (health?.services || []).slice(0, 12).forEach(s => {
    list.appendChild(el('div', { class: 'flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-ink-700' }, [
      el('div', { class: 'flex items-center gap-2 min-w-0' }, [
        el('span', { class: `pulse-dot ${s.ok ? 'pulse-ok' : 'pulse-bad'}`, style: 'animation:none' }),
        el('span', { class: 'truncate' }, s.name),
      ]),
      el('span', { class: 'text-xs text-slate-500' }, s.ok ? 'OK' : `Down`),
    ]));
  });
  left.appendChild(list);
  left.querySelector('button').onclick = () => go('services');

  // Recent audit (right)
  right.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold">Recent activity</h3>
      <button class="btn btn-ghost">View all →</button>
    </div>
  `;
  const events = el('div', { class: 'space-y-1.5 max-h-96 overflow-y-auto pr-1' });
  recentEntries.forEach(ev => {
    events.appendChild(el('div', { class: 'flex items-start gap-3 text-sm py-2 border-b border-ink-700 last:border-0' }, [
      el('div', { class: 'flex-1 min-w-0' }, [
        el('div', { class: 'text-xs text-slate-300 truncate' }, ev.action),
        el('div', { class: 'text-[11px] text-slate-500 truncate' }, `${ev.actor_email || 'system'} · ${fmtRel(ev.created_at)}`),
      ]),
    ]));
  });
  right.appendChild(events);
  right.querySelector('button').onclick = () => go('audit');
};

// ==========================================================================
// PAGE: Users
// ==========================================================================
pages.users = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);

  const ctl = el('div', { class: 'flex items-center justify-between mb-4 gap-3' });
  ctl.innerHTML = `
    <div class="flex items-center gap-2 flex-1">
      <input id="usr-q" placeholder="Search email or name…" class="input max-w-xs">
      <select id="usr-role" class="select max-w-[160px]">
        <option value="">All roles</option>
        <option value="admin">admin</option><option value="max">max</option>
        <option value="pro">pro</option><option value="free">free</option>
      </select>
    </div>
    <button id="usr-add" class="btn btn-primary">+ New User</button>
  `;
  wrap.appendChild(ctl);

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const q = $('#usr-q').value, role = $('#usr-role').value;
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    if (role) params.set('role', role);
    params.set('per_page', '100');
    const r = await api(`/users?${params}`);
    const users = r.users || r;
    card.innerHTML = '';
    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>User</th><th>Role</th><th>Status</th><th>Created</th><th>Last seen</th><th></th>
      </tr></thead>
    `;
    const tb = el('tbody');
    tbl.appendChild(tb);
    users.forEach(u => {
      const tr = el('tr');
      const role = (u.user_role || 'free').toLowerCase();
      const roleBadge = { admin: 'badge-purple', max: 'badge-info', pro: 'badge-ok', free: 'badge-mute' }[role] || 'badge-mute';
      tr.innerHTML = `
        <td>
          <div class="font-medium">${esc(u.display_name || u.first_name || u.email)}</div>
          <div class="text-[11px] text-slate-500">${esc(u.email)}</div>
        </td>
        <td>${badge(role, roleBadge.replace('badge-', ''))}</td>
        <td>${u.is_active ? badge('active', 'ok') : badge('disabled', 'bad')}</td>
        <td class="text-xs text-slate-400">${fmtRel(u.created_at)}</td>
        <td class="text-xs text-slate-400">${fmtRel(u.last_login_at || u.updated_at)}</td>
        <td class="text-right">
          <button class="btn btn-ghost btn-icon" data-act="role" data-id="${u.id}" title="Change role">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" data-act="pwd" data-id="${u.id}" title="Set password">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon" data-act="toggle" data-id="${u.id}" data-active="${u.is_active}" title="${u.is_active ? 'Disable' : 'Enable'}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon text-red-400 hover:text-red-300" data-act="del" data-id="${u.id}" data-email="${esc(u.email)}" title="Delete">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
          </button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'role') return openRoleModal(id);
      if (act === 'pwd')  return openPwdModal(id);
      if (act === 'toggle') {
        const active = b.dataset.active === 'true';
        await api(`/users/${id}/active`, { method: 'PATCH', body: { is_active: !active } });
        toast(`User ${active ? 'disabled' : 'enabled'}`, 'ok'); load();
        return;
      }
      if (act === 'del') {
        confirmAction({
          title: `Delete ${b.dataset.email}?`,
          message: 'Hard delete — permanently removes the row. Choose Disable instead to keep history.',
          danger: true, confirmLabel: 'Hard delete',
          onConfirm: async () => { await api(`/users/${id}`, { method: 'DELETE', body: { hard: true } }); toast('User deleted', 'ok'); load(); },
        });
      }
    });
  }

  $('#usr-add').onclick = () => openCreateUserModal(load);
  $('#usr-q').oninput = debounce(load, 250);
  $('#usr-role').onchange = load;
  load();
};

function openCreateUserModal(after) {
  openModal(`
    <h3 class="text-base font-semibold mb-4">Create user</h3>
    <div class="space-y-3">
      <div><label class="block text-xs text-slate-400 mb-1">Email</label><input id="cu-email" class="input"></div>
      <div><label class="block text-xs text-slate-400 mb-1">Password</label><input id="cu-pwd" type="password" class="input"></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-400 mb-1">First name</label><input id="cu-first" class="input"></div>
        <div><label class="block text-xs text-slate-400 mb-1">Last name</label><input id="cu-last" class="input"></div>
      </div>
      <div><label class="block text-xs text-slate-400 mb-1">Role</label>
        <select id="cu-role" class="select"><option>free</option><option>pro</option><option>max</option><option>admin</option></select>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button id="cu-cancel" class="btn btn-secondary">Cancel</button>
      <button id="cu-ok" class="btn btn-primary">Create</button>
    </div>
  `, {
    onMount(c) {
      c.querySelector('#cu-cancel').onclick = closeModal;
      c.querySelector('#cu-ok').onclick = async () => {
        try {
          await api('/users', { method: 'POST', body: {
            email: c.querySelector('#cu-email').value,
            password: c.querySelector('#cu-pwd').value,
            first_name: c.querySelector('#cu-first').value || null,
            last_name:  c.querySelector('#cu-last').value || null,
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
    <h3 class="text-base font-semibold mb-4">Change role</h3>
    <select id="rm-role" class="select"><option>free</option><option>pro</option><option>max</option><option>admin</option></select>
    <div class="flex justify-end gap-2 mt-5">
      <button id="rm-cancel" class="btn btn-secondary">Cancel</button>
      <button id="rm-ok" class="btn btn-primary">Update</button>
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
    <h3 class="text-base font-semibold mb-4">Set new password</h3>
    <input id="pm-pwd" type="password" placeholder="New password" class="input">
    <div class="flex justify-end gap-2 mt-5">
      <button id="pm-cancel" class="btn btn-secondary">Cancel</button>
      <button id="pm-ok" class="btn btn-primary">Set</button>
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

  const ctl = el('div', { class: 'flex items-center justify-between mb-4 gap-3' });
  ctl.innerHTML = `
    <div class="flex items-center gap-2 flex-1">
      <input id="prj-q" placeholder="Search by name or description…" class="input max-w-xs">
      <select id="prj-status" class="select max-w-[160px]">
        <option value="">All statuses</option>
        <option>active</option><option>paused</option>
        <option>completed</option><option>archived</option>
      </select>
    </div>
    <button id="prj-add" class="btn btn-primary">+ New Project</button>
  `;
  wrap.appendChild(ctl);

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const params = new URLSearchParams();
    const q = $('#prj-q').value, st = $('#prj-status').value;
    if (q) params.set('search', q);
    if (st) params.set('status', st);
    const r = await api(`/projects?${params}`);
    card.innerHTML = '';

    const head = el('div', { class: 'flex items-center justify-between mb-3' });
    head.innerHTML = `<div class="text-xs text-slate-500">${r.total} projects</div>`;
    card.appendChild(head);

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>Project</th><th>Owner</th><th>Status</th>
        <th>Sessions</th><th>Messages</th><th>Created</th><th></th>
      </tr></thead>
    `;
    const tb = el('tbody'); tbl.appendChild(tb);
    r.projects.forEach(p => {
      const stKind = { active: 'ok', paused: 'warn', completed: 'info', archived: 'mute' }[p.status] || 'mute';
      const tr = el('tr');
      tr.innerHTML = `
        <td>
          <div class="font-medium">${esc(p.name)}</div>
          <div class="text-[11px] text-slate-500 truncate max-w-md">${esc(p.description || '—')}</div>
        </td>
        <td class="text-xs">${esc(p.owner_email || p.owner_id.slice(0, 8) + '…')}</td>
        <td>${badge(p.status, stKind)}</td>
        <td class="text-xs">${p.session_count}</td>
        <td class="text-xs">${p.message_count}</td>
        <td class="text-xs text-slate-400">${fmtRel(p.created_at)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-secondary" data-act="ctn-start" data-id="${p.id}" title="Start container">▶</button>
          <button class="btn btn-secondary" data-act="ctn-stop"  data-id="${p.id}" title="Stop container">■</button>
          <button class="btn btn-danger"    data-act="del"       data-id="${p.id}" data-name="${esc(p.name)}" title="Delete">✕</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const id = b.dataset.id, act = b.dataset.act;
      try {
        if (act === 'ctn-start') { const r = await api(`/projects/${id}/container/start`, { method: 'POST' }); toast(`Container ${r.state || 'started'}`, 'ok'); }
        else if (act === 'ctn-stop') { const r = await api(`/projects/${id}/container/stop`, { method: 'POST' }); toast(`Container ${r.state || 'stopped'}`, 'ok'); }
        else if (act === 'del') {
          confirmAction({
            title: `Delete project "${b.dataset.name}"?`,
            message: 'Deletes the project, all sessions, all messages, and tears down the session container. Remote git history is preserved.',
            danger: true, confirmLabel: 'Delete',
            onConfirm: async () => { await api(`/projects/${id}`, { method: 'DELETE' }); toast('Project deleted', 'ok'); load(); },
          });
        }
      } catch (e) { toast(e.message, 'bad'); }
    });
  }

  $('#prj-add').onclick = async () => {
    const usersRes = await api('/users?per_page=100');
    const users = usersRes.users || usersRes;
    openModal(`
      <h3 class="text-base font-semibold mb-4">Create project on behalf of user</h3>
      <div class="space-y-3">
        <div><label class="block text-xs text-slate-400 mb-1">Owner</label>
          <select id="cp-owner" class="select">${users.map(u => `<option value="${u.id}">${esc(u.email)}</option>`).join('')}</select></div>
        <div><label class="block text-xs text-slate-400 mb-1">Name</label><input id="cp-name" class="input"></div>
        <div><label class="block text-xs text-slate-400 mb-1">Description</label><textarea id="cp-desc" rows="2" class="textarea"></textarea></div>
        <div><label class="block text-xs text-slate-400 mb-1">Agent model</label><input id="cp-model" value="gpt-4o" class="input"></div>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <button id="cp-cancel" class="btn btn-secondary">Cancel</button>
        <button id="cp-ok" class="btn btn-primary">Create</button>
      </div>
    `, { onMount(c) {
      c.querySelector('#cp-cancel').onclick = closeModal;
      c.querySelector('#cp-ok').onclick = async () => {
        try {
          await api('/projects', { method: 'POST', body: {
            owner_id: c.querySelector('#cp-owner').value,
            name: c.querySelector('#cp-name').value,
            description: c.querySelector('#cp-desc').value || null,
            agent_model: c.querySelector('#cp-model').value,
          }});
          closeModal(); toast('Project created', 'ok'); load();
        } catch (e) { toast(e.message, 'bad'); }
      };
    }});
  };
  $('#prj-q').oninput = debounce(load, 250);
  $('#prj-status').onchange = load;
  load();
};

// ==========================================================================
// PAGE: Services
// ==========================================================================
pages.services = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-4' });
  host.appendChild(wrap);

  const cap = await api('/system/capability').catch(() => ({ docker_control: false }));
  if (!cap.docker_control) {
    wrap.appendChild(el('div', { class: 'card text-amber-400 text-sm' },
      'Docker socket is not mounted into admin-service. Start/stop/restart controls are disabled. Mount /var/run/docker.sock to enable.'));
  }

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const [health, ctns] = await Promise.all([
      api('/system/health-rollup'),
      cap.docker_control ? api('/system/services').catch(() => []) : Promise.resolve([]),
    ]);
    const stateByName = {};
    ctns.forEach(c => stateByName[c.name] = c);

    card.innerHTML = '';
    const head = el('div', { class: 'flex items-center justify-between mb-3' });
    head.innerHTML = `<div class="text-sm"><span class="text-slate-400">${health.healthy}/${health.total} healthy</span></div>`;
    card.appendChild(head);

    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>Service</th><th>Health</th><th>Container state</th><th>Container status</th><th></th>
      </tr></thead>
    `;
    const tb = el('tbody'); tbl.appendChild(tb);
    health.services.forEach(s => {
      const ctn = stateByName[s.container] || {};
      const tr = el('tr');
      tr.innerHTML = `
        <td><div class="font-medium">${esc(s.name)}</div><div class="text-[11px] text-slate-500">:${s.port}</div></td>
        <td>${s.ok ? badge('OK', 'ok') : badge('Down', 'bad')}</td>
        <td>${ctn.state ? badge(ctn.state, ctn.state === 'running' ? 'ok' : 'mute') : '—'}</td>
        <td class="text-xs text-slate-400">${esc(ctn.status || '—')}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-ghost" data-act="logs"    data-name="${esc(s.container)}">Logs</button>
          <button class="btn btn-secondary" data-act="start"   data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>▶ Start</button>
          <button class="btn btn-secondary" data-act="stop"    data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>■ Stop</button>
          <button class="btn btn-secondary" data-act="restart" data-name="${esc(s.container)}" ${!cap.docker_control ? 'disabled' : ''}>↻ Restart</button>
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
        setTimeout(load, 600);
      } catch (e) { toast(e.message, 'bad'); }
    });
  }
  load();
};

function openLogsModal(name) {
  openModal(`
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-base font-semibold">Logs · ${esc(name)}</h3>
      <button id="lm-refresh" class="btn btn-ghost btn-icon" title="Refresh">↻</button>
    </div>
    <div id="lm-body" class="code overflow-auto max-h-[60vh]"><div class="flex justify-center py-6"><span class="spinner"></span></div></div>
    <div class="flex justify-end mt-4"><button id="lm-close" class="btn btn-secondary">Close</button></div>
  `, { wide: '60rem',
    onMount(c) {
      const load = async () => {
        try {
          const r = await api(`/system/services/${name}/logs?tail=400`);
          c.querySelector('#lm-body').textContent = r.logs || '(no logs)';
          c.querySelector('#lm-body').scrollTop = c.querySelector('#lm-body').scrollHeight;
        } catch (e) {
          c.querySelector('#lm-body').textContent = e.message;
        }
      };
      c.querySelector('#lm-close').onclick = closeModal;
      c.querySelector('#lm-refresh').onclick = load;
      load();
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

  const ctl = el('div', { class: 'flex items-center justify-between mb-4 gap-3' });
  ctl.innerHTML = `
    <div class="flex items-center gap-2 flex-1">
      <input id="st-q" placeholder="Search key…" class="input max-w-xs">
      <select id="st-cat" class="select max-w-[180px]"><option value="">All categories</option></select>
      <label class="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" id="st-reveal"> Reveal secrets</label>
    </div>
    <button id="st-add" class="btn btn-primary">+ New Setting</button>
  `;
  wrap.appendChild(ctl);

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  // Load categories once for filter
  try {
    const cats = await api('/settings/categories');
    cats.forEach(c => $('#st-cat').appendChild(el('option', { value: c.category }, `${c.category} (${c.count})`)));
  } catch {}

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const params = new URLSearchParams();
    const q = $('#st-q').value.toLowerCase();
    const cat = $('#st-cat').value;
    const reveal = $('#st-reveal').checked;
    if (cat) params.set('category', cat);
    if (reveal) params.set('reveal', '1');
    const rows = await api(`/settings?${params}`);
    const filtered = q ? rows.filter(r => r.key.toLowerCase().includes(q)) : rows;

    card.innerHTML = '';
    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>Key</th><th>Scope</th><th>Value</th><th>Type</th><th>Category</th><th>Flags</th><th></th>
      </tr></thead>
    `;
    const tb = el('tbody'); tbl.appendChild(tb);
    filtered.forEach(r => {
      const tr = el('tr');
      const valDisplay = r.value === null || r.value === undefined
        ? '<span class="text-slate-500 italic">(unset)</span>'
        : `<span class="code" style="display:inline-block">${esc(String(r.value).slice(0, 80))}</span>`;
      const flags = [];
      if (r.is_secret) flags.push(badge('secret', 'purple'));
      if (r.requires_restart) flags.push(badge('restart', 'warn'));
      if (r.is_readonly) flags.push(badge('readonly', 'mute'));
      tr.innerHTML = `
        <td><div class="font-medium">${esc(r.key)}</div><div class="text-[11px] text-slate-500 truncate max-w-md">${esc(r.description || '')}</div></td>
        <td class="text-xs">${esc(r.scope || '<i>global</i>')}</td>
        <td>${valDisplay}</td>
        <td class="text-xs">${esc(r.value_type)}</td>
        <td class="text-xs">${esc(r.category)}</td>
        <td>${flags.join(' ')}</td>
        <td class="text-right">
          <button class="btn btn-ghost" data-act="edit" data-key="${esc(r.key)}" data-scope="${esc(r.scope || '')}" ${r.is_readonly ? 'disabled' : ''}>Edit</button>
          <button class="btn btn-ghost text-red-400" data-act="del" data-key="${esc(r.key)}" data-scope="${esc(r.scope || '')}" ${r.is_readonly ? 'disabled' : ''}>Delete</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);

    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const key = b.dataset.key, scope = b.dataset.scope, act = b.dataset.act;
      if (act === 'edit') return openSettingModal(key, scope, load);
      if (act === 'del') confirmAction({
        title: `Delete ${key}?`, message: `Scope: ${scope || 'global'}`,
        danger: true, confirmLabel: 'Delete',
        onConfirm: async () => {
          await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`, { method: 'DELETE' });
          toast('Setting deleted', 'ok'); load();
        },
      });
    });
  }

  $('#st-add').onclick = () => openSettingModal(null, '', load);
  $('#st-q').oninput = debounce(load, 250);
  $('#st-cat').onchange = load;
  $('#st-reveal').onchange = load;
  load();
};

async function openSettingModal(key, scope, after) {
  let current = null;
  if (key) {
    try { current = await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}&reveal=1`); } catch {}
  }
  const c = current || {};
  openModal(`
    <h3 class="text-base font-semibold mb-4">${key ? 'Edit setting' : 'New setting'}</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-400 mb-1">Key</label>
          <input id="se-key" class="input" value="${esc(c.key || '')}" ${key ? 'disabled' : ''}></div>
        <div><label class="block text-xs text-slate-400 mb-1">Scope</label>
          <input id="se-scope" class="input" value="${esc(c.scope || '')}" placeholder="empty = global"></div>
      </div>
      <div><label class="block text-xs text-slate-400 mb-1">Value</label>
        <textarea id="se-val" rows="3" class="textarea">${esc(c.value ?? '')}</textarea></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="block text-xs text-slate-400 mb-1">Type</label>
          <select id="se-type" class="select">
            ${['string','int','float','bool','json'].map(t => `<option ${c.value_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
        <div><label class="block text-xs text-slate-400 mb-1">Category</label>
          <input id="se-cat" class="input" value="${esc(c.category || 'general')}"></div>
      </div>
      <div><label class="block text-xs text-slate-400 mb-1">Description</label>
        <input id="se-desc" class="input" value="${esc(c.description || '')}"></div>
      <div class="flex gap-4 text-xs text-slate-400">
        <label class="flex items-center gap-2"><input type="checkbox" id="se-secret"  ${c.is_secret ? 'checked' : ''}> Secret</label>
        <label class="flex items-center gap-2"><input type="checkbox" id="se-restart" ${c.requires_restart ? 'checked' : ''}> Requires restart</label>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button id="se-cancel" class="btn btn-secondary">Cancel</button>
      <button id="se-ok" class="btn btn-primary">${key ? 'Save' : 'Create'}</button>
    </div>
  `, { onMount(card) {
    card.querySelector('#se-cancel').onclick = closeModal;
    card.querySelector('#se-ok').onclick = async () => {
      const body = {
        key: card.querySelector('#se-key').value,
        scope: card.querySelector('#se-scope').value,
        value: card.querySelector('#se-val').value,
        value_type: card.querySelector('#se-type').value,
        category: card.querySelector('#se-cat').value,
        description: card.querySelector('#se-desc').value,
        is_secret: card.querySelector('#se-secret').checked,
        requires_restart: card.querySelector('#se-restart').checked,
      };
      try {
        if (key) await api(`/settings/${encodeURIComponent(key)}?scope=${encodeURIComponent(scope)}`, { method: 'PATCH', body });
        else     await api('/settings', { method: 'POST', body });
        closeModal(); toast('Saved', 'ok'); after && after();
      } catch (e) { toast(e.message, 'bad'); }
    };
  }});
}

// ==========================================================================
// PAGE: Features
// ==========================================================================
pages.features = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade' });
  host.appendChild(wrap);
  const card = el('div', { class: 'card' });
  wrap.appendChild(card);
  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const rows = await api('/features');
    card.innerHTML = '';
    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr><th>Feature</th><th>Category</th><th>Min role</th><th>Enabled</th><th></th></tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);
    rows.forEach(f => {
      const tr = el('tr');
      tr.innerHTML = `
        <td><div class="font-medium">${esc(f.name)}</div><div class="text-[11px] text-slate-500 truncate max-w-md">${esc(f.description || '')}</div></td>
        <td class="text-xs">${esc(f.category || '—')}</td>
        <td>${badge(f.min_role || 'free', f.min_role === 'admin' ? 'purple' : 'info')}</td>
        <td>${f.enabled ? badge('on', 'ok') : badge('off', 'bad')}</td>
        <td class="text-right">
          <button class="btn btn-ghost" data-act="toggle" data-name="${esc(f.name)}" data-on="${f.enabled}">Toggle</button>
          <button class="btn btn-ghost" data-act="role"   data-name="${esc(f.name)}">Min role</button>
        </td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);
    card.querySelectorAll('[data-act="toggle"]').forEach(b => b.onclick = async () => {
      try {
        await api(`/features/${b.dataset.name}`, { method: 'PATCH', body: { enabled: b.dataset.on !== 'true' } });
        toast('Feature updated', 'ok'); load();
      } catch (e) { toast(e.message, 'bad'); }
    });
    card.querySelectorAll('[data-act="role"]').forEach(b => b.onclick = () => {
      openModal(`
        <h3 class="text-base font-semibold mb-4">Minimum role for ${esc(b.dataset.name)}</h3>
        <select id="fr-role" class="select"><option>free</option><option>pro</option><option>max</option><option>admin</option></select>
        <div class="flex justify-end gap-2 mt-5">
          <button id="fr-cancel" class="btn btn-secondary">Cancel</button>
          <button id="fr-ok" class="btn btn-primary">Update</button>
        </div>
      `, { onMount(c) {
        c.querySelector('#fr-cancel').onclick = closeModal;
        c.querySelector('#fr-ok').onclick = async () => {
          try {
            await api(`/features/${b.dataset.name}`, { method: 'PATCH', body: { min_role: c.querySelector('#fr-role').value } });
            closeModal(); toast('Updated', 'ok'); load();
          } catch (e) { toast(e.message, 'bad'); }
        };
      }});
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

  const ctl = el('div', { class: 'flex items-center gap-2 mb-4' });
  ctl.innerHTML = `
    <input id="au-action" placeholder="Filter by action (e.g. user.role_change)" class="input max-w-sm">
    <input id="au-target" placeholder="Target type (user, project…)" class="input max-w-xs">
    <select id="au-limit" class="select max-w-[120px]"><option>50</option><option>100</option><option>200</option><option>500</option></select>
  `;
  wrap.appendChild(ctl);

  const card = el('div', { class: 'card' });
  wrap.appendChild(card);

  async function load() {
    card.innerHTML = `<div class="flex justify-center py-8"><span class="spinner"></span></div>`;
    const p = new URLSearchParams();
    if ($('#au-action').value) p.set('action', $('#au-action').value);
    if ($('#au-target').value) p.set('target_type', $('#au-target').value);
    p.set('limit', $('#au-limit').value);
    const r = await api(`/audit?${p}`);
    card.innerHTML = '';
    const tbl = el('table', { class: 'table' });
    tbl.innerHTML = `<thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>`;
    const tb = el('tbody'); tbl.appendChild(tb);
    (r.entries || r.logs || []).forEach(ev => {
      const tr = el('tr');
      const detail = ev.metadata?.sql ? `<div class="code mt-1 max-h-24 overflow-auto">${esc(ev.metadata.sql)}</div>` : '';
      tr.innerHTML = `
        <td class="text-xs text-slate-400 whitespace-nowrap">${fmtDate(ev.created_at)}<div class="text-slate-600 text-[10px]">${fmtRel(ev.created_at)}</div></td>
        <td class="text-xs">${esc(ev.actor_email || '—')}</td>
        <td><span class="code">${esc(ev.action)}</span>${detail}</td>
        <td class="text-xs text-slate-400">${esc(ev.target_type || '')} ${esc(ev.target_id || '')}</td>
        <td class="text-xs text-slate-500">${esc(ev.ip_address || '')}</td>
      `;
      tb.appendChild(tr);
    });
    card.appendChild(tbl);
  }

  $('#au-action').oninput = debounce(load, 250);
  $('#au-target').oninput = debounce(load, 250);
  $('#au-limit').onchange = load;
  load();
};

// ==========================================================================
// PAGE: SQL Shell
// ==========================================================================
pages.shell = async (host) => {
  host.innerHTML = '';
  const wrap = el('div', { class: 'page-fade space-y-4' });
  host.appendChild(wrap);

  wrap.appendChild(el('div', { class: 'card text-xs text-amber-300 border-amber-500/40 bg-amber-500/5' },
    '⚠ Full read+write SQL access. Every query is audit-logged. DDL/DML runs in autocommit — there is no rollback. Use SELECT for exploration.'));

  const split = el('div', { class: 'grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4' });
  wrap.appendChild(split);

  // Tables sidebar
  const tablesPane = el('div', { class: 'card card-tight max-h-[80vh] overflow-y-auto' });
  split.appendChild(tablesPane);

  // Editor + results
  const main = el('div', { class: 'space-y-4' });
  split.appendChild(main);

  main.innerHTML = `
    <div class="card card-tight">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <select id="sh-db" class="select max-w-[120px]"><option value="auth">auth</option><option value="chat">chat</option></select>
        </div>
        <div class="flex items-center gap-2">
          <span id="sh-status" class="text-xs text-slate-500"></span>
          <button id="sh-run" class="btn btn-primary">Run (⌘/Ctrl+↵)</button>
        </div>
      </div>
      <textarea id="sh-sql" class="textarea" rows="8" placeholder="SELECT * FROM users LIMIT 10;"></textarea>
    </div>
    <div id="sh-out" class="card"></div>
  `;

  async function loadTables() {
    tablesPane.innerHTML = `<div class="flex justify-center py-4"><span class="spinner"></span></div>`;
    try {
      const r = await api(`/db/tables?database=${$('#sh-db').value}`);
      tablesPane.innerHTML = `<div class="text-xs text-slate-500 mb-2 uppercase tracking-wider px-1">Tables · ${r.database}</div>`;
      r.tables.forEach(t => {
        const item = el('div', { class: 'flex items-center justify-between text-xs px-2 py-1.5 rounded hover:bg-ink-700 cursor-pointer' }, [
          el('span', { class: 'truncate font-mono' }, t.name),
          el('span', { class: 'text-slate-500' }, t.est_rows ? `~${t.est_rows}` : ''),
        ]);
        item.onclick = () => {
          $('#sh-sql').value = `SELECT * FROM ${t.name} LIMIT 50;`;
        };
        tablesPane.appendChild(item);
      });
    } catch (e) {
      tablesPane.innerHTML = `<div class="text-xs text-red-400">${esc(e.message)}</div>`;
    }
  }

  async function run() {
    const sql = $('#sh-sql').value.trim();
    if (!sql) return;
    $('#sh-status').textContent = 'Running…';
    $('#sh-out').innerHTML = `<div class="flex justify-center py-6"><span class="spinner"></span></div>`;
    try {
      const r = await api('/db/query', { method: 'POST', body: { sql, database: $('#sh-db').value } });
      $('#sh-status').textContent = `${r.op} · ${r.elapsed_ms} ms · ${r.rowcount ?? 0} row${r.rowcount === 1 ? '' : 's'}${r.truncated ? ' (truncated)' : ''}`;
      renderResult(r);
    } catch (e) {
      $('#sh-status').textContent = 'Error';
      $('#sh-out').innerHTML = `<div class="text-red-400 text-sm">${esc(e.message)}</div>`;
    }
  }

  function renderResult(r) {
    const out = $('#sh-out');
    if (r.error) {
      out.innerHTML = `<div class="code text-red-400">${esc(r.error)}</div>`;
      return;
    }
    if (!r.columns || r.columns.length === 0) {
      out.innerHTML = `<div class="text-sm text-slate-400">OK · ${r.op} · ${r.rowcount ?? 0} rows affected</div>`;
      return;
    }
    out.innerHTML = '';
    const wrap = el('div', { class: 'overflow-auto max-h-[60vh]' });
    const tbl = el('table', { class: 'table' });
    const th = '<thead><tr>' + r.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead>';
    const body = r.rows.map(row => '<tr>' + row.map(v => `<td class="font-mono text-xs">${v === null ? '<span class="text-slate-500 italic">NULL</span>' : esc(String(v))}</td>`).join('') + '</tr>').join('');
    tbl.innerHTML = th + '<tbody>' + body + '</tbody>';
    wrap.appendChild(tbl);
    out.appendChild(wrap);
  }

  $('#sh-run').onclick = run;
  $('#sh-db').onchange = loadTables;
  $('#sh-sql').addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); run(); }
  });
  loadTables();
};

// --------------------------------------------------------------------------
// Utility
// --------------------------------------------------------------------------
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --------------------------------------------------------------------------
// Go
// --------------------------------------------------------------------------
boot();
