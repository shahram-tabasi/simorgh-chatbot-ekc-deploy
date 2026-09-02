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

The `.exe` is an NSIS installer, which electron-builder can only produce on
Windows (or on Linux with wine, which the deploy environment does not have).

**Through GitHub Actions (no Windows machine needed)**

1. Actions → **Desktop installer (Windows)** → *Run workflow*.
   (Pushing a tag that starts with `desktop-v` runs it too.)
2. Download **SimorghDesignSuite-Windows-Setup** from the finished run.

**On a Windows machine**

```powershell
cd simorgh-agent\simorgh-soft\desktop
npm install
npm run dist:win
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
saved, the saved one wins.

## Version

The version shown in Help → About and used in the installer's file name comes
from `version` in `package.json`.
