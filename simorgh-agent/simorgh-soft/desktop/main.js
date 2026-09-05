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

const DEFAULT_URL = process.env.SIMORGH_URL || 'http://localhost/simorgh-design-suite/';
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

function createMainWindow(url) {
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
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

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
    <p>Check that the server is running and reachable from this computer, then try again.</p>
    <button onclick="location.reload()">Retry</button>
    <button class="secondary" onclick="window.close()">Close</button>
  </div>`;
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// First run (or "Change server address…"): a small window that asks where the
// suite is served from. Electron has no built-in prompt, so this is a page.
function createSetupWindow(currentUrl) {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 300,
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
    query: { url: currentUrl || DEFAULT_URL },
  });
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Nothing configured and no window open — there is nothing to show.
    if (!mainWindow && !readConfig().serverUrl) app.quit();
  });
}

ipcMain.handle('simorgh:save-server-url', (_event, raw) => {
  const url = normaliseUrl(raw);
  if (!url) {
    dialog.showErrorBox('Server address', 'That address could not be read. Try something like http://192.168.1.10/simorgh-design-suite/');
    return false;
  }
  writeConfig({ ...readConfig(), serverUrl: url });
  if (setupWindow) { setupWindow.close(); }
  if (mainWindow) mainWindow.loadURL(url);
  else createMainWindow(url);
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
            detail: `Server: ${readConfig().serverUrl || DEFAULT_URL}\n\n© تمامی حقوق متعلق به شرکت سیمرغ فناوری هوشمند ایرانیان است.`,
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    const saved = readConfig().serverUrl;
    if (saved) createMainWindow(saved);
    else createSetupWindow(DEFAULT_URL);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const url = readConfig().serverUrl;
        if (url) createMainWindow(url); else createSetupWindow(DEFAULT_URL);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
