# Simorgh Design Suite — Windows desktop client

A desktop window for the suite: the app's own icon, menu, zoom and full-screen,
pointed at the server that serves `/simorgh-design-suite/`. The suite itself
keeps running in the `simorgh-soft` container (nginx + Express + MongoDB) — the
installer does not carry a database or a backend, so every machine sees the same
projects and revisions, exactly as it does in the browser today.

On first launch it asks for the server address and remembers it in the user's
data folder (`%APPDATA%\Simorgh Design Suite\config.json`). It can be changed
later from **File → Change server address…**.

## Building the installer

The `.exe` is an NSIS installer. Any of these three produce the same file.

**On the Linux server (one command)**

```bash
cd simorgh-agent/simorgh-soft/desktop
./build-win.sh                                        # asks for the server on first run
./build-win.sh http://192.168.1.68/simorgh-design-suite/   # or opens it by itself
```

It needs wine once — including its 32-bit side, because the NSIS stub and
rcedit (which writes the icon and version into the .exe) are 32-bit programs:

```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine libgd3:i386 wine32:i386
```

Everything else — the Electron binaries, NSIS, rcedit — electron-builder
downloads on the first run and keeps in `~/.cache/electron-builder`. The build
takes about two minutes and lands in
`release/SimorghDesignSuite-Setup-<version>.exe` (~76 MB).

**From GitHub Actions — there is always one waiting**

Every push that touches this folder builds the installer, so the newest run
already has one:

> Actions → **Desktop installer (Windows)** → the newest run → **Artifacts** →
> `SimorghDesignSuite-Setup-<version>` → unzip → the `.exe` is inside.

**Building one on demand**

1. Actions → **Desktop installer (Windows)** → *Run workflow*.
   * **Server address** — the site this build should open, e.g.
     `http://192.168.1.68/simorgh-design-suite/`. Leave it blank and the app
     asks on first run, as it always has.
   * Run it on whichever branch carries the version you want to ship.
2. Download **SimorghDesignSuite-Setup-<version>** from the finished run
   and unzip it — the `.exe` is inside.

   * **Also publish it as a GitHub release** — ticking this attaches the `.exe`
     to a release tagged `desktop-v<version>`, which gives it a plain URL to
     hand out instead of a zipped artifact.

**Serving it from the app itself**

The suite offers the installer for download from its own footer. Put the `.exe`
in `simorgh-backend/downloads/` on the server — the folder is mounted into the
container, so it is a copy, not a rebuild:

```bash
scp SimorghDesignSuite-Setup-1.0.0.exe \
    ubuntu@server:~/simorgh-chatbot-ekc-deploy/simorgh-agent/simorgh-soft/simorgh-backend/downloads/
```

Whatever `.exe` is newest in that folder is what `/api/desktop/latest` reports
and the download button serves.

**On a Windows machine**

```powershell
cd simorgh-agent\simorgh-soft\desktop
npm install
npm run dist:win
```

To have that build open a particular server by itself, write the address beside
`main.js` before building:

```powershell
'{ "url": "http://192.168.1.68/simorgh-design-suite/" }' | Set-Content server.json
```

The installer lands in `desktop\release\SimorghDesignSuite-Setup-<version>.exe`.
It installs per-user (no admin rights), lets the user pick the folder, and adds
Desktop and Start-menu shortcuts.

## Running it during development

```bash
cd simorgh-agent/simorgh-soft/desktop
npm install
SIMORGH_URL=http://localhost/simorgh-design-suite/ npm start
```

`SIMORGH_URL` only sets what the first-run dialog suggests; once an address is
saved, the saved one wins. The order is: the address the user saved →
`SIMORGH_URL` → `server.json` baked into the build → `http://localhost/simorgh-design-suite/`.

## Version

The version shown in Help → About and used in the installer's file name comes
from `version` in `package.json`.
