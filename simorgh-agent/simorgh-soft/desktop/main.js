// Simorgh Design Suite — Windows desktop shell.
//
// The suite runs as a web app served by the simorgh-soft container (nginx in
// front of the Express backend and MongoDB). This app is the desktop client
// for it: a dedicated window with the app's own icon, menu and zoom controls,
// pointed at whichever server the site runs on. The address is asked for on
// first run and kept in the user's data folder, so a different site only has
// to change it once.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// The address the first-run dialog suggests. A build can carry the site's own
// address in server.json beside this file — the installer then already points
// at the right server and nobody has to type it — and SIMORGH_URL overrides
// even that, for running it from a terminal during development.
function packagedUrl() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8')).url || '');
  } catch {
    return '';
  }
}

// No fallback to localhost.
//
// It used to fall back to `http://localhost/simorgh-design-suite/`, and that is
// where this went wrong: the first-run box opened with localhost already
// filled in, which reads as "this is the answer" rather than "here is an
// example". Pressing Connect then saved it, and the app opened a blank window
// onto a server that is not on this machine — the suite runs on the site's
// server, and localhost is only ever right on the server itself.
//
// So when nothing is baked in and nothing is saved, the box opens empty and
// says what it wants. An empty field asks a question; a wrong field answers
// one.
const DEFAULT_URL = process.env.SIMORGH_URL || packagedUrl() || '';
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
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

let mainWindow = null;
let setupWindow = null;
let welcomeWindow = null;

// The welcome window, every time the app starts: the Simorgh artwork and
// "Opening your workspace…", up while the suite loads behind it in a hidden
// window. It is a local page, so it appears at once — before the server has
// answered — and the first thing seen is never a blank window.
//
// Held for at least WELCOME_MIN_MS so it is seen rather than flashed, and for
// at most WELCOME_MAX_MS so a server that never answers cannot keep the suite
// (or its error page) from being shown.
const WELCOME_MIN_MS = 3200;
const WELCOME_MAX_MS = 20000;

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
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  welcomeWindow.once('ready-to-show', () => welcomeWindow?.show());
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'), { query: { v: app.getVersion() } });
}

function createMainWindow(url, { welcome = false } = {}) {
  if (welcome) createWelcomeWindow();
  const openedAt = Date.now();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#060e1e', // the splash screen's ground, so no white flash
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Only so the error page can offer "Change server address…". The bridge
      // exposes two calls and nothing else; the suite's own pages never use it.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Shown when it is ready — and, while the welcome window is up, not before
  // the welcome has had its moment; the welcome closes as the suite appears.
  let shown = false;
  const reveal = () => {
    if (shown || !mainWindow) return;
    shown = true;
    mainWindow.show();
    if (welcomeWindow) welcomeWindow.close();
  };
  mainWindow.once('ready-to-show', () => {
    const wait = welcomeWindow ? Math.max(0, WELCOME_MIN_MS - (Date.now() - openedAt)) : 0;
    setTimeout(reveal, wait);
  });
  // Never left hidden: a server that neither answers nor fails would keep
  // ready-to-show from firing, and the app would look as if it never opened.
  setTimeout(reveal, WELCOME_MAX_MS);
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
    showErrorPage(validatedURL || url, errorDescription);
  });

  mainWindow.loadURL(url);
  return mainWindow;
}

function showErrorPage(url, reason) {
  if (!mainWindow) return;
  const html = `<!doctype html><meta charset="utf-8">
  <style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;
      background:radial-gradient(1200px 800px at 10% 10%,#14335f 0%,#0a1a33 45%,#060e1e 100%)}
    .card{max-width:560px;padding:28px 32px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(255,255,255,.04)}
    h1{margin:0 0 6px;font-size:20px}
    p{margin:6px 0;font-size:13px;line-height:1.6;color:#94a3b8}
    code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:4px;color:#bfdbfe}
    button{margin-top:16px;margin-right:8px;padding:8px 16px;border:0;border-radius:8px;
      background:#2563eb;color:#fff;font-size:13px;cursor:pointer}
    button.secondary{background:rgba(255,255,255,.12)}
  </style>
  <div class="card">
    <h1>Can't reach Simorgh Design Suite</h1>
    <p>Tried to open <code>${url}</code></p>
    <p>${reason || ''}</p>
    <p>Check that the server is running and reachable from this computer, then try again.
       If this is the wrong address, change it — the suite runs on the site's server,
       not on this computer.</p>
    <button onclick="location.reload()">Retry</button>
    <button class="secondary" onclick="window.simorgh && window.simorgh.changeServerUrl()">Change server address…</button>
    <button class="secondary" onclick="window.close()">Close</button>
  </div>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// First run (or "Change server address…"): a small window that asks where the
// suite is served from. Electron has no built-in prompt, so this is a page.
function createSetupWindow(currentUrl) {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 540,
    height: 330,
    resizable: false,
    minimizable: false,
    title: 'Server address',
    backgroundColor: '#0a1a33',
    icon: path.join(__dirname, 'build', 'icon.png'),
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'), {
    query: { url: currentUrl || DEFAULT_URL || '' },
  });
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Nothing configured and no window open — there is nothing to show.
    if (!mainWindow && !readConfig().serverUrl) app.quit();
  });
}

ipcMain.handle('simorgh:change-server-url', () => {
  createSetupWindow(readConfig().serverUrl || DEFAULT_URL);
});

ipcMain.handle('simorgh:save-server-url', (_event, raw) => {
  const url = normaliseUrl(raw);
  if (!url) {
    dialog.showErrorBox('Server address', 'That address could not be read. Try something like http://192.168.1.10/simorgh-design-suite/');
    return false;
  }
  writeConfig({ ...readConfig(), serverUrl: url });
  if (setupWindow) { setupWindow.close(); }
  if (mainWindow) mainWindow.loadURL(url);
  else createMainWindow(url, { welcome: true });
  return true;
});

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        {
          label: 'Change server address…',
          click: () => createSetupWindow(readConfig().serverUrl),
        },
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
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'Simorgh Design Suite',
            message: `Simorgh Design Suite ${app.getVersion()}`,
            detail: `Server: ${readConfig().serverUrl || DEFAULT_URL || '(not set)'}\n\n© تمامی حقوق متعلق به شرکت سیمرغ فناوری هوشمند ایرانیان است.`,
          }),
        },
      ],
    },
  ]));
}

// One window per machine: a second launch focuses the window already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (welcomeWindow) { welcomeWindow.focus(); return; }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    const saved = readConfig().serverUrl;
    if (saved) createMainWindow(saved, { welcome: true });
    else createSetupWindow(DEFAULT_URL);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const url = readConfig().serverUrl;
        if (url) createMainWindow(url, { welcome: true }); else createSetupWindow(DEFAULT_URL);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
