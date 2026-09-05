// Windows desktop client downloads.
//
// The installer is dropped into this folder (bind-mounted in compose, so a new
// build is published by copying the .exe in — no image rebuild). The app offers
// whatever the newest .exe there is, and says nothing when the folder is empty.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const DESKTOP_DIR = process.env.DESKTOP_DOWNLOAD_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'downloads');

export function latestInstaller(dir = DESKTOP_DIR) {
  try {
    const files = fs.readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.exe'))
      .map(name => {
        const full = path.join(dir, name);
        return { name, full, stat: fs.statSync(full) };
      })
      .filter(f => f.stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return files[0] || null;
  } catch {
    return null; // folder missing or unreadable — nothing published yet
  }
}

export function registerDesktopRoutes(app, dir = DESKTOP_DIR) {
  app.get('/api/desktop/latest', (req, res) => {
    const file = latestInstaller(dir);
    if (!file) return res.json({ available: false });
    // "SimorghDesignSuite-Setup-1.0.0.exe" -> "1.0.0"
    const version = (file.name.match(/(\d+\.\d+\.\d+)/) || [])[1] || '';
    res.json({
      available: true,
      fileName: file.name,
      size: file.stat.size,
      modified: file.stat.mtime.toISOString(),
      version,
    });
  });

  app.get('/api/desktop/download', (req, res) => {
    const file = latestInstaller(dir);
    if (!file) return res.status(404).json({ error: 'No installer published' });
    res.download(file.full, file.name, err => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Failed to send the installer' });
    });
  });
}
