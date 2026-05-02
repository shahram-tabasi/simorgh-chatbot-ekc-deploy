// =============================================================================
// Simorgh admin SPA — vanilla JS, no build step.
// All API calls hit /api/v2/admin/*  via the same nginx that serves /ui/.
// JWT lives in localStorage as `simorgh.admin.jwt`.
// =============================================================================

const API = "/api/v2/admin";
const TOKEN_KEY = "simorgh.admin.jwt";
let CURRENT_USER = null;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts.headers || {},
  );
  if (token()) headers["Authorization"] = `Bearer ${token()}`;
  const res = await fetch(`${API}${path}`, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error("Not authenticated");
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.detail || JSON.stringify(j); } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Login flow — calls auth-service through the same gateway
// ---------------------------------------------------------------------------
function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}
function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    // auth-service is mounted at /api/auth/v2/* by the public nginx
    const r = await fetch("/api/auth/v2/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `${r.status}`);
    }
    const j = await r.json();
    if (!j.access_token) throw new Error("No token in response");
    setToken(j.access_token);
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showLogin();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TABS = ["dashboard", "users", "tiers", "ai", "features", "settings", "audit", "system"];
function switchTab(name) {
  TABS.forEach((t) => {
    document.getElementById(`tab-${t}`)?.classList.toggle("hidden", t !== name);
    document.querySelector(`[data-tab="${t}"]`)?.classList.toggle("active", t === name);
  });
  location.hash = `#${name}`;
  loaders[name]?.();
}
document.querySelectorAll(".tab-btn").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!token()) return showLogin();
  try {
    // /api/auth/v2/me — fetch current user
    const r = await fetch("/api/auth/v2/me", {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!r.ok) throw new Error("auth/me failed");
    CURRENT_USER = await r.json();
    if (!isAdmin(CURRENT_USER)) {
      alert("This account is not an admin.");
      clearToken();
      return showLogin();
    }
  } catch {
    return showLogin();
  }
  document.getElementById("user-email").textContent = CURRENT_USER.email;
  await loadCapability();
  showApp();
  const initial = (location.hash || "#dashboard").slice(1);
  switchTab(TABS.includes(initial) ? initial : "dashboard");
}

function isAdmin(u) {
  return u && (u.user_role === "admin" || u.is_superuser);
}

async function loadCapability() {
  try {
    const cap = await api("/system/capability");
    const row = document.getElementById("capability-badges");
    row.innerHTML = "";
    if (!cap.encryption_active) row.appendChild(badge("plaintext mode", "warn"));
    if (!cap.docker_control)    row.appendChild(badge("no docker socket", "warn"));
  } catch { /* ignore */ }
}

function badge(text, kind = "info") {
  const s = document.createElement("span");
  s.className = `badge badge-${kind}`;
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// Loaders per tab
// ---------------------------------------------------------------------------
const loaders = {
  dashboard: loadDashboard,
  users:     loadUsers,
  tiers:     loadTiers,
  ai:        loadAI,
  features:  loadFeatures,
  settings:  loadSettings,
  audit:     loadAudit,
  system:    loadSystem,
};

// ---------- Dashboard ----------
async function loadDashboard() {
  const grid = document.getElementById("stats-grid");
  grid.innerHTML = "";
  try {
    const s = await api("/stats");
    const cards = [
      ["Total users",       s.total_users],
      ["Active today",      s.active_today],
      ["Questions today",   s.questions_today],
      ["New (7d)",          s.new_users_7d],
      ["Expiring (7d)",     s.expiring_subscriptions_7d],
    ];
    cards.forEach(([label, val]) => {
      const el = document.createElement("div");
      el.className = "bg-white rounded shadow p-4";
      el.innerHTML = `<div class="text-2xl font-semibold">${val ?? "—"}</div><div class="text-xs text-slate-500 uppercase tracking-wide">${label}</div>`;
      grid.appendChild(el);
    });
  } catch (e) {
    grid.innerHTML = `<div class="col-span-4 text-red-600 text-sm">${e.message}</div>`;
  }

  const health = document.getElementById("health-rollup");
  health.textContent = "Loading…";
  try {
    const h = await api("/system/health-rollup");
    health.innerHTML = `<div class="mb-2">${h.healthy} / ${h.total} services healthy</div>` +
      `<div class="grid grid-cols-1 md:grid-cols-2 gap-1">` +
      h.services.map(s =>
        `<div class="flex items-center gap-2"><span class="badge badge-${s.ok ? 'ok' : 'bad'}">${s.ok ? 'ok' : 'down'}</span><span>${s.name}</span><span class="text-slate-400 text-xs ml-auto">${s.error || s.status || ''}</span></div>`
      ).join("") + `</div>`;
  } catch (e) {
    health.innerHTML = `<div class="text-red-600">${e.message}</div>`;
  }
}

// ---------- Users ----------
let userPage = 1;
async function loadUsers() {
  const search = document.getElementById("user-search").value;
  const role = document.getElementById("user-role-filter").value;
  const params = new URLSearchParams();
  params.set("page", userPage);
  params.set("per_page", 25);
  if (search) params.set("search", search);
  if (role) params.set("role", role);
  try {
    const data = await api(`/users?${params}`);
    const tbody = document.getElementById("users-tbody");
    tbody.innerHTML = "";
    data.users.forEach((u) => {
      const tr = document.createElement("tr");
      tr.className = "border-b last:border-0 hover:bg-slate-50";
      tr.innerHTML = `
        <td class="px-3 py-2">${u.email}</td>
        <td class="px-3 py-2">${[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}</td>
        <td class="px-3 py-2"><span class="badge badge-info">${u.user_role}</span></td>
        <td class="px-3 py-2">${u.is_active ? '<span class="badge badge-ok">active</span>' : '<span class="badge badge-bad">disabled</span>'}</td>
        <td class="px-3 py-2 text-slate-500">${(u.created_at || "").slice(0, 10)}</td>
        <td class="px-3 py-2">
          <button data-act="edit" data-id="${u.id}" class="text-blue-600 hover:underline mr-2">Edit</button>
          <button data-act="features" data-id="${u.id}" class="text-purple-600 hover:underline mr-2">Features</button>
          <button data-act="reset" data-id="${u.id}" class="text-amber-600 hover:underline mr-2">Reset</button>
          <button data-act="toggle" data-id="${u.id}" class="text-slate-600 hover:underline mr-2">${u.is_active ? "Disable" : "Enable"}</button>
          <button data-act="delete" data-id="${u.id}" class="text-red-600 hover:underline">Delete</button>
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", () => userAction(b.dataset.act, b.dataset.id)),
    );
    const pager = document.getElementById("users-pager");
    pager.innerHTML = `<span>page ${data.page} / ${data.pages}</span>` +
      ` <button class="ml-2 px-2 py-0.5 border rounded ${data.page <= 1 ? 'opacity-40' : ''}">‹</button>` +
      ` <button class="px-2 py-0.5 border rounded ${data.page >= data.pages ? 'opacity-40' : ''}">›</button>` +
      ` <span class="ml-2 text-slate-500">${data.total} total</span>`;
    pager.querySelectorAll("button")[0].onclick = () => { if (userPage > 1) { userPage--; loadUsers(); } };
    pager.querySelectorAll("button")[1].onclick = () => { if (userPage < data.pages) { userPage++; loadUsers(); } };
  } catch (e) {
    document.getElementById("users-tbody").innerHTML = `<tr><td colspan="6" class="text-red-600 px-3 py-2">${e.message}</td></tr>`;
  }
}
document.getElementById("user-search").addEventListener("input", debounce(() => { userPage = 1; loadUsers(); }, 300));
document.getElementById("user-role-filter").addEventListener("change", () => { userPage = 1; loadUsers(); });
document.getElementById("user-create-btn").addEventListener("click", openUserCreateModal);

async function userAction(act, id) {
  if (act === "delete") {
    if (!confirm("Delete this user? (soft delete — sets is_active=false)")) return;
    try { await api(`/users/${id}`, { method: "DELETE", body: JSON.stringify({ hard: false }) }); loadUsers(); }
    catch (e) { alert(e.message); }
  } else if (act === "toggle") {
    try { await api(`/users/${id}/active`, { method: "PATCH" }); loadUsers(); }
    catch (e) { alert(e.message); }
  } else if (act === "edit") {
    openUserEditModal(id);
  } else if (act === "features") {
    openUserFeaturesModal(id);
  } else if (act === "reset") {
    if (!confirm("Issue a one-time password reset token?")) return;
    try {
      const r = await api(`/users/${id}/force-password-reset`, { method: "POST" });
      prompt("Reset token (copy now — won't be shown again):", r.token);
    } catch (e) { alert(e.message); }
  }
}

function openUserCreateModal() {
  modal({
    title: "Create user",
    fields: [
      { name: "email",      label: "Email",      type: "email", required: true },
      { name: "password",   label: "Password",   type: "password", required: true },
      { name: "first_name", label: "First name", type: "text" },
      { name: "last_name",  label: "Last name",  type: "text" },
      { name: "user_role",  label: "Role",       type: "select", options: ["free","pro","max","admin"], value: "free" },
    ],
    submit: async (vals) => {
      await api("/users", { method: "POST", body: JSON.stringify(vals) });
      loadUsers();
    },
  });
}

async function openUserEditModal(id) {
  const u = await api(`/users/${id}`);
  modal({
    title: `Edit ${u.email}`,
    fields: [
      { name: "user_role",  label: "Role",  type: "select", options: ["free","pro","max","admin"], value: u.user_role || "free" },
      { name: "subscription_days", label: "Subscription days from now (optional)", type: "number" },
    ],
    submit: async (vals) => {
      const body = { user_role: vals.user_role };
      if (vals.subscription_days) body.subscription_days = parseInt(vals.subscription_days, 10);
      await api(`/users/${id}/role`, { method: "PATCH", body: JSON.stringify(body) });
      loadUsers();
    },
  });
}

async function openUserFeaturesModal(id) {
  const data = await api(`/users/${id}/features/resolved`);
  const overrides = await api(`/users/${id}/features`);
  const overrideMap = Object.fromEntries(overrides.overrides.map(o => [o.feature_name, o]));
  const rows = Object.entries(data.features).map(([name, enabled]) => {
    const ov = overrideMap[name];
    return `<tr class="border-b last:border-0">
      <td class="px-2 py-1">${name}</td>
      <td class="px-2 py-1"><span class="badge badge-${enabled ? 'ok' : 'bad'}">${enabled ? 'on' : 'off'}</span></td>
      <td class="px-2 py-1">${ov ? '<span class="badge badge-info">override</span>' : ''}</td>
      <td class="px-2 py-1 text-right">
        <button data-act="on"     data-name="${name}" class="text-green-600 hover:underline mr-1">Force on</button>
        <button data-act="off"    data-name="${name}" class="text-red-600 hover:underline mr-1">Force off</button>
        <button data-act="clear"  data-name="${name}" class="text-slate-500 hover:underline">Clear</button>
      </td>
    </tr>`;
  }).join("");
  const html = `<table class="w-full text-sm">${rows}</table>`;
  modalRaw({
    title: `Features for ${data.user_role}: ${id.slice(0,8)}…`,
    html,
    onMount: (root) => {
      root.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", async () => {
        const name = b.dataset.name;
        try {
          if (b.dataset.act === "clear") {
            await api(`/users/${id}/features/${name}`, { method: "DELETE" });
          } else {
            await api(`/users/${id}/features`, { method: "POST", body: JSON.stringify({ feature_name: name, enabled: b.dataset.act === "on" }) });
          }
          closeModal();
          openUserFeaturesModal(id);
        } catch (e) { alert(e.message); }
      }));
    },
  });
}

// ---------- Tiers ----------
async function loadTiers() {
  const grid = document.getElementById("tiers-grid");
  grid.innerHTML = "Loading…";
  try {
    const tiers = await api("/tiers");
    grid.innerHTML = "";
    tiers.forEach((t) => {
      const card = document.createElement("div");
      card.className = "bg-white rounded shadow p-4";
      card.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold">${t.tier_name}</h3>
          <button data-tier="${t.tier_name}" class="text-blue-600 text-sm hover:underline">Edit</button>
        </div>
        <pre class="text-xs bg-slate-50 rounded p-2 overflow-x-auto">${JSON.stringify(t, null, 2)}</pre>`;
      card.querySelector("button").addEventListener("click", () => editTier(t));
      grid.appendChild(card);
    });
  } catch (e) {
    grid.innerHTML = `<div class="text-red-600">${e.message}</div>`;
  }
}

function editTier(t) {
  const numericKeys = Object.keys(t).filter(k => typeof t[k] === "number");
  modal({
    title: `Edit tier ${t.tier_name}`,
    fields: numericKeys.map(k => ({ name: k, label: k, type: "number", value: t[k] })),
    submit: async (vals) => {
      const body = {};
      Object.entries(vals).forEach(([k, v]) => { if (v !== "") body[k] = parseInt(v, 10); });
      await api(`/tiers/${t.tier_name}`, { method: "PATCH", body: JSON.stringify(body) });
      loadTiers();
    },
  });
}

// ---------- AI Config ----------
async function loadAI() {
  const settings = await api("/settings?category=ai");
  const root = document.getElementById("ai-form");
  root.innerHTML = "";
  settings.forEach((s) => root.appendChild(settingRow(s, () => loadAI())));
}

function settingRow(s, refresh) {
  const wrap = document.createElement("div");
  wrap.className = "border-b border-slate-100 pb-3 last:border-0 last:pb-0";
  const flags = [];
  if (s.is_secret)        flags.push('<span class="badge badge-secret">secret</span>');
  if (s.requires_restart) flags.push('<span class="badge badge-restart">restart required</span>');
  if (s.is_readonly)      flags.push('<span class="badge badge-readonly">read-only</span>');
  wrap.innerHTML = `
    <div class="flex items-baseline justify-between gap-3 mb-1">
      <div>
        <code class="font-mono text-sm">${s.key}</code>
        ${s.scope ? `<span class="text-xs text-slate-400 ml-2">scope: ${s.scope}</span>` : ""}
        <span class="ml-2">${flags.join(" ")}</span>
      </div>
      <div class="text-xs text-slate-400">${s.value_type}</div>
    </div>
    <div class="text-xs text-slate-500 mb-2">${s.description || ""}</div>
    <div class="flex items-center gap-2">
      <input class="border rounded px-2 py-1 text-sm flex-1 ${s.is_readonly ? 'bg-slate-100' : ''}"
             type="${s.is_secret ? 'password' : 'text'}"
             value="${s.value ?? ''}" ${s.is_readonly ? 'disabled' : ''} />
      <button class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm ${s.is_readonly ? 'opacity-50 cursor-not-allowed' : ''}" ${s.is_readonly ? 'disabled' : ''}>Save</button>
    </div>`;
  const input = wrap.querySelector("input");
  const btn = wrap.querySelector("button");
  if (!s.is_readonly) {
    btn.addEventListener("click", async () => {
      try {
        const params = new URLSearchParams();
        if (s.scope) params.set("scope", s.scope);
        const url = `/settings/${encodeURIComponent(s.key)}${params.toString() ? '?' + params : ''}`;
        await api(url, { method: "PATCH", body: JSON.stringify({ value: input.value }) });
        btn.textContent = "Saved";
        setTimeout(() => { btn.textContent = "Save"; refresh && refresh(); }, 600);
      } catch (e) { alert(e.message); }
    });
  }
  return wrap;
}

// ---------- Features ----------
async function loadFeatures() {
  const flags = await api("/features");
  const root = document.getElementById("features-grid");
  root.innerHTML = "";
  const byCat = {};
  flags.forEach(f => { (byCat[f.category] ||= []).push(f); });
  Object.entries(byCat).forEach(([cat, list]) => {
    const sec = document.createElement("div");
    sec.className = "bg-white rounded shadow";
    sec.innerHTML = `<div class="px-4 py-2 border-b font-medium uppercase tracking-wide text-xs text-slate-500">${cat}</div>`;
    list.forEach(f => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-3 px-4 py-3 border-b last:border-0";
      row.innerHTML = `
        <label class="inline-flex items-center cursor-pointer">
          <input type="checkbox" class="sr-only" ${f.enabled ? "checked" : ""} />
          <span class="w-9 h-5 bg-slate-300 rounded-full relative inline-block transition ${f.enabled ? '!bg-blue-600' : ''}">
            <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition ${f.enabled ? 'translate-x-4' : ''}"></span>
          </span>
        </label>
        <div class="flex-1">
          <div class="font-medium">${f.name}</div>
          <div class="text-xs text-slate-500">${f.description || ""}</div>
        </div>
        <select class="border rounded px-2 py-1 text-xs">
          ${["free","pro","max","admin"].map(r => `<option ${f.min_role===r?'selected':''}>${r}</option>`).join("")}
        </select>`;
      const cb = row.querySelector("input");
      const sel = row.querySelector("select");
      cb.addEventListener("change", async () => {
        try { await api(`/features/${f.name}`, { method: "PATCH", body: JSON.stringify({ enabled: cb.checked }) }); loadFeatures(); }
        catch (e) { alert(e.message); cb.checked = !cb.checked; }
      });
      sel.addEventListener("change", async () => {
        try { await api(`/features/${f.name}`, { method: "PATCH", body: JSON.stringify({ min_role: sel.value }) }); }
        catch (e) { alert(e.message); }
      });
      sec.appendChild(row);
    });
    root.appendChild(sec);
  });
}

// ---------- All settings ----------
async function loadSettings() {
  const cats = await api("/settings/categories");
  const catSel = document.getElementById("settings-category");
  while (catSel.options.length > 1) catSel.remove(1);
  cats.forEach(c => { const o = document.createElement("option"); o.value = c.category; o.textContent = `${c.category} (${c.count})`; catSel.appendChild(o); });
  await refreshSettings();
}

async function refreshSettings() {
  const cat = document.getElementById("settings-category").value;
  const scope = document.getElementById("settings-scope").value;
  const reveal = document.getElementById("settings-reveal").checked ? 1 : 0;
  const params = new URLSearchParams();
  if (cat) params.set("category", cat);
  if (scope) params.set("scope", scope);
  params.set("reveal", reveal);
  const list = await api(`/settings?${params}`);
  // populate scopes from observed list
  const scopeSel = document.getElementById("settings-scope");
  const scopes = Array.from(new Set(list.map(s => s.scope))).sort();
  while (scopeSel.options.length > 1) scopeSel.remove(1);
  scopes.forEach(s => { const o = document.createElement("option"); o.value = s; o.textContent = s || "(global)"; if (s === scope) o.selected = true; scopeSel.appendChild(o); });

  const tbody = document.getElementById("settings-tbody");
  tbody.innerHTML = "";
  list.forEach((s) => {
    const tr = document.createElement("tr");
    tr.className = "border-b last:border-0 hover:bg-slate-50";
    const flags = [];
    if (s.is_secret)        flags.push('<span class="badge badge-secret">secret</span>');
    if (s.requires_restart) flags.push('<span class="badge badge-restart">restart</span>');
    if (s.is_readonly)      flags.push('<span class="badge badge-readonly">readonly</span>');
    tr.innerHTML = `
      <td class="px-3 py-2 font-mono text-xs">${s.key}</td>
      <td class="px-3 py-2 text-slate-500 text-xs">${s.scope || "(global)"}</td>
      <td class="px-3 py-2">
        <input class="border rounded px-2 py-0.5 text-xs w-full ${s.is_readonly ? 'bg-slate-100' : ''}" value="${s.value ?? ''}" ${s.is_readonly ? 'disabled' : ''} />
      </td>
      <td class="px-3 py-2 text-xs">${s.value_type}</td>
      <td class="px-3 py-2 text-xs">${s.category}</td>
      <td class="px-3 py-2">${flags.join(" ")}</td>
      <td class="px-3 py-2">
        ${s.is_readonly ? "" : `<button class="text-blue-600 hover:underline text-xs mr-2" data-act="save">Save</button>
        <button class="text-red-600 hover:underline text-xs" data-act="delete">Delete</button>`}
      </td>`;
    if (!s.is_readonly) {
      const input = tr.querySelector("input");
      tr.querySelector("[data-act='save']").addEventListener("click", async () => {
        try {
          const params = new URLSearchParams();
          if (s.scope) params.set("scope", s.scope);
          await api(`/settings/${encodeURIComponent(s.key)}${params.toString() ? '?' + params : ''}`,
                    { method: "PATCH", body: JSON.stringify({ value: input.value }) });
          refreshSettings();
        } catch (e) { alert(e.message); }
      });
      tr.querySelector("[data-act='delete']").addEventListener("click", async () => {
        if (!confirm(`Delete ${s.key}?`)) return;
        try {
          const params = new URLSearchParams();
          if (s.scope) params.set("scope", s.scope);
          await api(`/settings/${encodeURIComponent(s.key)}${params.toString() ? '?' + params : ''}`, { method: "DELETE" });
          refreshSettings();
        } catch (e) { alert(e.message); }
      });
    }
    tbody.appendChild(tr);
  });
}

document.getElementById("settings-category").addEventListener("change", refreshSettings);
document.getElementById("settings-scope").addEventListener("change", refreshSettings);
document.getElementById("settings-reveal").addEventListener("change", refreshSettings);
document.getElementById("setting-create-btn").addEventListener("click", () => modal({
  title: "Create setting",
  fields: [
    { name: "key", label: "Key", type: "text", required: true },
    { name: "scope", label: "Scope (blank = global)", type: "text" },
    { name: "value", label: "Value", type: "text" },
    { name: "value_type", label: "Type", type: "select", options: ["string","int","float","bool","json"], value: "string" },
    { name: "category", label: "Category", type: "text", value: "general" },
    { name: "description", label: "Description", type: "text" },
    { name: "is_secret", label: "Encrypt at rest?", type: "checkbox" },
    { name: "requires_restart", label: "Requires service restart?", type: "checkbox" },
  ],
  submit: async (v) => {
    v.is_secret = !!v.is_secret;
    v.requires_restart = !!v.requires_restart;
    if (v.value === "") v.value = null;
    await api("/settings", { method: "POST", body: JSON.stringify(v) });
    refreshSettings();
  },
}));

// ---------- Audit ----------
async function loadAudit() {
  try {
    const data = await api("/audit?limit=200");
    const tbody = document.getElementById("audit-tbody");
    tbody.innerHTML = "";
    data.entries.forEach(e => {
      const tr = document.createElement("tr");
      tr.className = "border-b last:border-0";
      tr.innerHTML = `
        <td class="px-3 py-2 text-xs text-slate-500">${(e.created_at || '').replace('T', ' ').slice(0, 19)}</td>
        <td class="px-3 py-2 text-xs">${e.actor_email || e.actor_id || '—'}</td>
        <td class="px-3 py-2"><span class="badge badge-info">${e.action}</span></td>
        <td class="px-3 py-2 text-xs">${e.target_type || ''}${e.target_id ? ': ' + e.target_id : ''}</td>
        <td class="px-3 py-2"><button class="text-blue-600 hover:underline text-xs">View</button></td>`;
      tr.querySelector("button").addEventListener("click", () => modalRaw({
        title: e.action,
        html: `<pre class="text-xs bg-slate-50 rounded p-2 overflow-x-auto whitespace-pre-wrap">${JSON.stringify({ before: e.before_state, after: e.after_state, metadata: e.metadata }, null, 2)}</pre>`,
      }));
      tbody.appendChild(tr);
    });
  } catch (e) {
    document.getElementById("audit-tbody").innerHTML = `<tr><td colspan="5" class="text-red-600 px-3 py-2">${e.message}</td></tr>`;
  }
}

// ---------- System ----------
async function loadSystem() {
  const cap = await api("/system/capability").catch(() => ({}));
  const capBox = document.getElementById("system-capability");
  capBox.classList.add("hidden");
  if (!cap.docker_control) {
    capBox.classList.remove("hidden");
    capBox.textContent = "Docker socket is not mounted into admin-service. Container restart is unavailable. Mount /var/run/docker.sock to enable.";
  }
  const tbody = document.getElementById("containers-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="px-3 py-2 text-slate-500">Loading…</td></tr>`;
  try {
    const list = await api("/system/services");
    tbody.innerHTML = "";
    list.forEach(c => {
      const tr = document.createElement("tr");
      tr.className = "border-b last:border-0";
      tr.innerHTML = `
        <td class="px-3 py-2">${c.name}</td>
        <td class="px-3 py-2"><span class="badge badge-${c.state==='running'?'ok':'bad'}">${c.state}</span> <span class="text-xs text-slate-500 ml-1">${c.status}</span></td>
        <td class="px-3 py-2 text-xs">${c.image}</td>
        <td class="px-3 py-2"><button class="text-blue-600 hover:underline text-xs">Restart</button></td>`;
      tr.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`Restart ${c.name}?`)) return;
        try { await api(`/system/services/${c.name}/restart`, { method: "POST" }); loadSystem(); }
        catch (e) { alert(e.message); }
      });
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-red-600 px-3 py-2">${e.message}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// Modal helper
// ---------------------------------------------------------------------------
function modal({ title, fields, submit }) {
  const root = document.getElementById("modal-root");
  const el = document.createElement("div");
  el.className = "modal-overlay";
  const fieldsHtml = fields.map(f => {
    const id = `m_${f.name}`;
    if (f.type === "select") {
      return `<label class="block mb-3"><span class="text-sm">${f.label}</span>
        <select id="${id}" class="w-full border rounded px-2 py-1 mt-1">${f.options.map(o => `<option ${f.value===o?'selected':''}>${o}</option>`).join("")}</select></label>`;
    }
    if (f.type === "checkbox") {
      return `<label class="flex items-center gap-2 mb-3"><input type="checkbox" id="${id}" ${f.value?'checked':''} /><span class="text-sm">${f.label}</span></label>`;
    }
    return `<label class="block mb-3"><span class="text-sm">${f.label}</span>
      <input id="${id}" type="${f.type}" value="${f.value ?? ''}" ${f.required?'required':''} class="w-full border rounded px-2 py-1 mt-1" /></label>`;
  }).join("");
  el.innerHTML = `<div class="modal-card">
    <h3 class="text-lg font-semibold mb-4">${title}</h3>
    <form>${fieldsHtml}
      <div class="flex justify-end gap-2 mt-4">
        <button type="button" data-act="cancel" class="px-3 py-1 rounded border">Cancel</button>
        <button type="submit" class="px-3 py-1 rounded bg-blue-600 text-white">Save</button>
      </div>
    </form></div>`;
  root.appendChild(el);
  el.querySelector("[data-act='cancel']").addEventListener("click", () => root.removeChild(el));
  el.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const vals = {};
    fields.forEach(f => {
      const inp = el.querySelector(`#m_${f.name}`);
      vals[f.name] = f.type === "checkbox" ? inp.checked : inp.value;
    });
    try { await submit(vals); root.removeChild(el); }
    catch (err) { alert(err.message); }
  });
}

function modalRaw({ title, html, onMount }) {
  const root = document.getElementById("modal-root");
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.innerHTML = `<div class="modal-card">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-lg font-semibold">${title}</h3>
      <button data-act="cancel" class="text-slate-500 hover:text-slate-700">×</button>
    </div>
    ${html}</div>`;
  root.appendChild(el);
  el.querySelector("[data-act='cancel']").addEventListener("click", () => root.removeChild(el));
  if (onMount) onMount(el);
}

function closeModal() {
  const root = document.getElementById("modal-root");
  while (root.firstChild) root.removeChild(root.firstChild);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
boot();
