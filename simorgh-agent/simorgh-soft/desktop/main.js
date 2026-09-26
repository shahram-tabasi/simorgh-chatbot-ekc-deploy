// Simorgh Design Suite — Windows desktop app.
//
// Two ways to run, chosen on first start and changeable in Settings:
//
//   • On this computer (local). The app carries the whole suite: the built
//     frontend, the backend, and a MongoDB of its own. It starts the database
//     and the backend here, bound to 127.0.0.1, and opens the suite from them.
//     Projects live in this computer's database (or a MongoDB server named in
//     Settings); TPMS and the EPLAN parts are reached with the addresses in
//     Settings, and parts can come from an Access file instead of SQL Server.
//
//   • Company server. The window onto a suite served elsewhere, as this app
//     always was: the address of that server, and nothing runs here.
//
// Settings live in the user's data folder (config.json), so a reinstall or an
// update keeps them, and so does the local database beside them.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const BASE_PATH = '/simorgh-design-suite/';

// ── Settings ────────────────────────────────────────────────────────────────

// A build can carry a company server's address (server.json, from the
// workflow's server_url input); SIMORGH_URL overrides it from a terminal.
function packagedUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8')).url || '');
  } catch {
    return '';
  }
}
const DEFAULT_URL = process.env.SIMORGH_URL || packagedUrl() || '';

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const dataDir = (...p) => path.join(app.getPath('userData'), ...p);

const DEFAULT_LOCAL = {
  database: { kind: 'local', uri: '' },
  // Empty fields mean the office defaults the backend itself falls back to.
  tpms: { host: '', port: '', database: '', user: '', password: '' },
  parts: {
    source: 'access',
    accessFile: '',
    sqlServer: { server: '', port: '', database: '', user: '', password: '' },
  },
};

function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* first run */ }
  // Before local mode existed there was only an address: that is server mode.
  if (!cfg.mode && cfg.serverUrl) cfg.mode = 'server';
  const local = cfg.local || {};
  cfg.local = {
    database: { ...DEFAULT_LOCAL.database, ...(local.database || {}) },
    tpms: { ...DEFAULT_LOCAL.tpms, ...(local.tpms || {}) },
    parts: {
      ...DEFAULT_LOCAL.parts,
      ...(local.parts || {}),
      sqlServer: { ...DEFAULT_LOCAL.parts.sqlServer, ...((local.parts || {}).sqlServer || {}) },
    },
  };
  if (!cfg.local.parts.accessFile) cfg.local.parts.accessFile = dataDir('parts', 'EplanParts.mdb');
  return cfg;
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save the settings file:', err);
  }
}

// Accept "server", "server:3000", "http://server/path" — anything the user is
// likely to type — and normalise it to a URL the window can load.
function normaliseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return '';
  }
}

// ── The local suite: MongoDB and the backend, started here ─────────────────

// Beside the app once installed (extraResources), beside this file in a
// development checkout that has run the bundle step.
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, 'bundle')
  : path.join(__dirname, 'bundle');
const hasLocalBundle = () => fs.existsSync(path.join(BUNDLE, 'backend', 'server.js'));

const runtime = { mongo: null, backend: null, backendPort: 0, mongoUri: '', starting: null };

function logStream(name) {
  const file = dataDir('logs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.unlinkSync(file); } catch { /* none yet */ }
  return fs.createWriteStream(file, { flags: 'a' });
}

function freePort(preferred) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => {
      const any = net.createServer();
      any.listen(0, '127.0.0.1', () => { const { port } = any.address(); any.close(() => resolve(port)); });
    });
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(300);
  }
  throw new Error(`${what} did not start within ${Math.round(ms / 1000)} s.`);
}

const tcpOpen = port => new Promise(resolve => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

const httpOk = url => new Promise(resolve => {
  const req = http.get(url, res => { res.resume(); resolve(res.statusCode < 500); });
  req.on('error', () => resolve(false));
  req.setTimeout(2000, () => { req.destroy(); resolve(false); });
});

function exited(child) {
  return child && (child.exitCode !== null || child.signalCode !== null);
}

async function startMongo() {
  const mongod = path.join(BUNDLE, 'mongo', process.platform === 'win32' ? 'mongod.exe' : 'mongod');
  if (!fs.existsSync(mongod)) throw new Error(`The built-in database is missing (${mongod}). Reinstall the app, or use a MongoDB server in Settings.`);
  const dbPath = dataDir('database');
  fs.mkdirSync(dbPath, { recursive: true });
  const port = await freePort(27027);
  const log = logStream('mongod.log');
  // A desktop's database, not a server's: mongod would otherwise take half
  // the computer's memory for its cache, and write diagnostics all day.
  const child = spawn(mongod, ['--dbpath', dbPath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet',
    '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
    { windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  runtime.mongo = child;
  await waitFor(async () => {
    if (exited(child)) throw new Error(`The built-in database stopped (code ${child.exitCode}). See ${dataDir('logs', 'mongod.log')}.`);
    return tcpOpen(port);
  }, 60000, 'The built-in database');
  return `mongodb://127.0.0.1:${port}`;
}

async function startBackend(cfg, mongoUri) {
  const port = await freePort(3901);
  const { tpms, parts } = cfg.local;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    MONGODB_URI: mongoUri,
    STATIC_DIR: path.join(BUNDLE, 'frontend'),
    BASE_PATH,
    SIMORGH_LOCAL: '1',
    // Empty means "the office default", which the backend supplies.
    MYSQL_HOST: tpms.host, MYSQL_PORT: tpms.port, MYSQL_DATABASE: tpms.database,
    MYSQL_USER: tpms.user, MYSQL_PASSWORD: tpms.password,
    SQL_SERVER: parts.sqlServer.server, SQL_PORT: parts.sqlServer.port,
    SQL_DATABASE: parts.sqlServer.database, SQL_USER: parts.sqlServer.user,
    SQL_PASSWORD: parts.sqlServer.password,
    PARTS_SOURCE: parts.source,
    PARTS_ACCESS_FILE: parts.accessFile,
  };
  for (const k of Object.keys(env)) if (env[k] === '' || env[k] == null) delete env[k];
  const log = logStream('backend.log');
  const child = spawn(process.execPath, [path.join(BUNDLE, 'backend', 'server.js')],
    { cwd: path.join(BUNDLE, 'backend'), env, windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  runtime.backend = child;
  await waitFor(async () => {
    if (exited(child)) throw new Error(`The suite's backend stopped (code ${child.exitCode}). See ${dataDir('logs', 'backend.log')}.`);
    return httpOk(`http://127.0.0.1:${port}/`);
  }, 90000, "The suite's backend");
  runtime.backendPort = port;
  return `http://127.0.0.1:${port}${BASE_PATH}`;
}

function stopRuntime() {
  for (const key of ['backend', 'mongo']) {
    const child = runtime[key];
    if (child && !exited(child)) child.kill();
    runtime[key] = null;
  }
  runtime.backendPort = 0;
  runtime.mongoUri = '';
}

/** Start (or restart) the local suite; resolves with the address to open. */
function startRuntime(cfg) {
  runtime.starting = (async () => {
    stopRuntime();
    if (!hasLocalBundle()) throw new Error('This build does not carry the local suite. Use a company server, or install the full Windows build.');
    const uri = cfg.local.database.kind === 'server' && cfg.local.database.uri
      ? cfg.local.database.uri
      : await startMongo();
    runtime.mongoUri = uri;
    return startBackend(cfg, uri);
  })();
  const started = runtime.starting;
  started.catch(() => {}).finally(() => { if (runtime.starting === started) runtime.starting = null; });
  return started;
}

async function backendUrl() {
  if (runtime.starting) await runtime.starting;
  if (!runtime.backendPort) await startRuntime(readConfig());
  return `http://127.0.0.1:${runtime.backendPort}`;
}

async function backendCall(method, route, body) {
  const base = await backendUrl();
  const res = await fetch(base + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Windows ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let settingsWindow = null;
let welcomeWindow = null;

// The welcome window, every time the app starts: the artwork and "Opening
// your workspace…", up while the suite starts and loads behind it. Held for at
// least WELCOME_MIN_MS so it is seen rather than flashed; never for more than
// WELCOME_MAX_MS after the main window has something to show.
const WELCOME_MIN_MS = 3200;
const WELCOME_MAX_MS = 20000;
// Local mode starts a database and a backend first; the very first start of
// the database (creating its files) can take most of a minute.
const LOCAL_MAX_MS = 90000;
const ICON = path.join(__dirname, 'build', 'icon.png');

function createWelcomeWindow() {
  welcomeWindow = new BrowserWindow({
    width: 560,
    height: 420,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    backgroundColor: '#01112a',
    icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  welcomeWindow.once('ready-to-show', () => welcomeWindow?.show());
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'), { query: { v: app.getVersion() } });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#060e1e', // the splash screen's ground, so no white flash
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Only so the error page can offer Settings. The bridge exposes a few
      // calls and nothing else; the suite's own pages never use it.
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (welcomeWindow) welcomeWindow.close();
  });

  // Links to anywhere else open in the user's browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // -3 is an aborted navigation (e.g. a download), not a failure to show.
    if (errorCode === -3) return;
    showErrorPage(`Can't reach Simorgh Design Suite`, `Tried to open ${validatedURL}. ${errorDescription || ''}`);
  });

  // A page that asks before it is left (unsaved work) gets no question in
  // Electron — the navigation or the close is just cancelled, and the app
  // looks stuck. Ask here instead, and go ahead if the answer is yes.
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Simorgh Design Suite',
      message: 'Some changes have not been saved yet.',
      detail: 'Leave anyway? Changes not yet saved will be lost.',
    });
    if (choice === 0) event.preventDefault();
  });
  return mainWindow;
}

// Shown when the main window has something to show, and — while the welcome
// window is up — not before it has had its moment.
function revealWhenReady(openedAt, maxMs) {
  let shown = false;
  const reveal = () => {
    if (shown || !mainWindow) return;
    shown = true;
    mainWindow.show();
    if (welcomeWindow) welcomeWindow.close();
  };
  mainWindow.webContents.once('did-finish-load', () => {
    const wait = welcomeWindow ? Math.max(0, WELCOME_MIN_MS - (Date.now() - openedAt)) : 0;
    setTimeout(reveal, wait);
  });
  mainWindow.webContents.once('did-fail-load', () => setTimeout(reveal, 0));
  // Never left hidden: a server that neither answers nor fails would keep the
  // page from finishing, and the app would look as if it never opened.
  setTimeout(reveal, maxMs);
}

function showErrorPage(title, detail) {
  if (!mainWindow) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><meta charset="utf-8">
  <style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;
      background:radial-gradient(1200px 800px at 10% 10%,#14335f 0%,#0a1a33 45%,#060e1e 100%)}
    .card{max-width:620px;padding:28px 32px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(255,255,255,.04)}
    h1{margin:0 0 6px;font-size:20px}
    p{margin:6px 0;font-size:13px;line-height:1.6;color:#94a3b8;word-break:break-word}
    button{margin-top:16px;margin-right:8px;padding:8px 16px;border:0;border-radius:8px;
      background:#2563eb;color:#fff;font-size:13px;cursor:pointer}
    button.secondary{background:rgba(255,255,255,.12)}
  </style>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
    <p>Check the settings, then try again.</p>
    <button onclick="window.simorgh && window.simorgh.retry()">Retry</button>
    <button class="secondary" onclick="window.simorgh && window.simorgh.openSettings()">Settings…</button>
    <button class="secondary" onclick="window.close()">Close</button>
  </div>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/** Open the suite in the main window as the settings say — starting it here in local mode. */
async function openSuite({ welcome = false } = {}) {
  const cfg = readConfig();
  if (!mainWindow) createMainWindow();
  if (welcome && !welcomeWindow) createWelcomeWindow();
  revealWhenReady(Date.now(), cfg.mode === 'local' ? LOCAL_MAX_MS : WELCOME_MAX_MS);
  try {
    const url = cfg.mode === 'local' ? await startRuntime(cfg) : cfg.serverUrl;
    if (!url) throw new Error('No company server address is set.');
    await mainWindow?.loadURL(url);
  } catch (err) {
    showErrorPage(cfg.mode === 'local' ? 'The suite could not start on this computer' : "Can't reach Simorgh Design Suite",
      err.message || String(err));
  }
}

// Settings — also the first-run window, where the way the app runs is chosen.
function createSettingsWindow({ firstRun = false } = {}) {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    title: 'Settings — Simorgh Design Suite',
    backgroundColor: '#0a1a33',
    icon: ICON,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'), { query: { firstRun: firstRun ? '1' : '' } });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // Nothing chosen and nothing open — there is nothing to show.
    if (!mainWindow && !readConfig().mode) app.quit();
  });
}

// ── Bridge ──────────────────────────────────────────────────────────────────

ipcMain.handle('simorgh:get-settings', () => ({
  config: readConfig(),
  hasLocalBundle: hasLocalBundle(),
  defaultUrl: DEFAULT_URL,
  platform: process.platform,
}));

ipcMain.handle('simorgh:save-settings', async (_e, incoming) => {
  const cfg = readConfig();
  const mode = incoming.mode === 'server' ? 'server' : 'local';
  if (mode === 'server') {
    const url = normaliseUrl(incoming.serverUrl);
    if (!url) return { ok: false, message: 'That address could not be read. Try something like http://192.168.1.10/simorgh-design-suite/' };
    cfg.serverUrl = url;
  } else if (!hasLocalBundle()) {
    return { ok: false, message: 'This build does not carry the local suite.' };
  }
  cfg.mode = mode;
  if (incoming.local) cfg.local = incoming.local;
  writeConfig(cfg);
  // Restarted with what was just saved, whichever way it runs now. Opened
  // before Settings closes: with no window left for a moment, the app quits.
  if (mode === 'server') stopRuntime();
  openSuite({ welcome: !mainWindow || !mainWindow.isVisible() });
  if (settingsWindow) settingsWindow.close();
  return { ok: true };
});

ipcMain.handle('simorgh:test', async (_e, kind, cfg) => {
  try {
    return await backendCall('POST', `/api/local/test/${kind}`, cfg);
  } catch (err) {
    return { ok: false, message: `The local suite is not running: ${err.message}` };
  }
});

ipcMain.handle('simorgh:export-access', async (_e, sqlServer, file) => {
  try {
    return await backendCall('POST', '/api/local/parts/export-access', { sqlServer, file });
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('simorgh:job', async (_e, id) => {
  try {
    return await backendCall('GET', `/api/local/jobs/${encodeURIComponent(id)}`);
  } catch (err) {
    return { state: 'failed', message: err.message };
  }
});

ipcMain.handle('simorgh:choose-access-file', async (_e, current, forSaving) => {
  const opts = {
    title: forSaving ? 'Save the Access parts file as' : 'Choose an Access parts file',
    defaultPath: current || dataDir('parts', 'EplanParts.mdb'),
    filters: [{ name: 'Access database', extensions: ['mdb', 'accdb'] }],
  };
  const parent = settingsWindow || undefined;
  if (forSaving) {
    const r = await dialog.showSaveDialog(parent, { ...opts, filters: [{ name: 'Access database', extensions: ['mdb'] }] });
    return r.canceled ? '' : r.filePath;
  }
  const r = await dialog.showOpenDialog(parent, { ...opts, properties: ['openFile'] });
  return r.canceled ? '' : r.filePaths[0];
});

ipcMain.handle('simorgh:open-path', async (_e, file) => {
  if (!file || !fs.existsSync(file)) return 'The file does not exist yet.';
  return shell.openPath(file); // '' when it opened
});

ipcMain.handle('simorgh:open-settings', () => createSettingsWindow());
ipcMain.handle('simorgh:retry', () => openSuite());
ipcMain.handle('simorgh:close-window', e => BrowserWindow.fromWebContents(e.sender)?.close());

// ── Menu ────────────────────────────────────────────────────────────────────

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => createSettingsWindow() },
        { label: 'Open logs folder', click: () => shell.openPath(dataDir('logs')) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            const cfg = readConfig();
            dialog.showMessageBox({
              type: 'info',
              title: 'Simorgh Design Suite',
              message: `Simorgh Design Suite ${app.getVersion()}`,
              detail: `${cfg.mode === 'local' ? 'Running on this computer' : `Server: ${cfg.serverUrl || '(not set)'}`}\n\n© تمامی حقوق متعلق به شرکت سیمرغ فناوری هوشمند ایرانیان است.`,
            });
          },
        },
      ],
    },
  ]));
}

// ── Start ───────────────────────────────────────────────────────────────────

// One window per machine: a second launch focuses the window already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = welcomeWindow || settingsWindow || mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    if (readConfig().mode) openSuite({ welcome: true });
    else createSettingsWindow({ firstRun: true });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (readConfig().mode) openSuite({ welcome: true }); else createSettingsWindow({ firstRun: true });
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', stopRuntime);
}
