// localDesktop.js — what only the Windows app's own copy of the backend does.
//
// In the Windows app's local mode this backend runs on the user's machine,
// started by the app, bound to 127.0.0.1 and nowhere else. Its Settings
// window needs three things the server never does:
//
//   • try a TPMS (MySQL) or SQL Server address before it is saved, so a typo
//     is found in Settings rather than as an empty project list later;
//   • check that an Access file really is a parts database;
//   • make that Access file: read tblPart from the office's SQL Server once
//     and write it into a new .mdb — after which the app needs no SQL Server
//     for parts at all.
//
// Registered only when SIMORGH_LOCAL=1, which only the app sets.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sql from 'mssql';
import mysql from 'mysql2/promise';
import { loadAccessParts, partsMode } from './partsAccess.js';

// A field left empty in Settings means "the office default" — the same
// defaults server.js connects with — so an untouched form still works.
let defaults = { sql: {}, mysql: {} };
const pick = (c, key, fallback) => (c && String(c[key] ?? '').trim()) || fallback;

const sqlServerConfig = c => ({
  user: pick(c, 'user', defaults.sql.user),
  password: pick(c, 'password', defaults.sql.password),
  server: pick(c, 'server', defaults.sql.server),
  database: pick(c, 'database', defaults.sql.database),
  port: parseInt(pick(c, 'port', defaults.sql.port)) || 1433,
  options: { encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 600000 },
});

async function withSqlServer(c, fn) {
  const pool = new sql.ConnectionPool(sqlServerConfig(c));
  await pool.connect();
  try { return await fn(pool); } finally { pool.close().catch(() => {}); }
}

// ── SQL Server → Access ─────────────────────────────────────────────────────
//
// Node cannot write an Access file by itself, and nothing needs installing to
// do it: every Windows carries the Jet 4.0 database engine (32-bit), which
// creates a .mdb and fills it from a text file in one statement. So tblPart is
// written as a CSV beside a schema.ini that fixes each column's type, and a
// 32-bit PowerShell runs Jet over it. A .mdb opens in every Access version
// and in EPLAN.

const TEXT_COLS = ['partnr', 'typenr', 'ordernr', 'manufacturer', 'productgroup',
  'productsubgroup', 'mountinglocation', 'mountingspace',
  'certificate_CE', 'certificate_UL', 'certificate_ATEX'];
const MEMO_COLS = ['description1', 'description2', 'description3'];
const NUM_COLS = ['width', 'height', 'depth', 'weight'];
const COLS = ['partnr', 'typenr', 'ordernr', 'manufacturer', 'description1', 'description2',
  'description3', 'productgroup', 'productsubgroup', 'width', 'height', 'depth', 'weight',
  'mountinglocation', 'mountingspace', 'certificate_CE', 'certificate_UL', 'certificate_ATEX'];

const csvCell = (col, v) => {
  if (v == null) return '';
  if (NUM_COLS.includes(col)) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : '';
  }
  let s = (Buffer.isBuffer(v) ? v.toString('utf8') : String(v))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
  if (TEXT_COLS.includes(col)) s = s.slice(0, 255);
  return `"${s.replace(/"/g, '""')}"`;
};

const SCHEMA_INI = [
  '[parts.csv]',
  'ColNameHeader=True',
  'Format=CSVDelimited',
  'CharacterSet=Unicode',
  'MaxScanRows=0',
  ...COLS.map((c, i) => `Col${i + 1}=${c} ${
    NUM_COLS.includes(c) ? 'Double' : MEMO_COLS.includes(c) ? 'LongChar' : 'Char Width 255'}`),
].join('\r\n') + '\r\n';

const PS_SCRIPT = `
param([string]$Db, [string]$Dir)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Db) { Remove-Item -LiteralPath $Db -Force }
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$Db"
$cat = New-Object -ComObject ADOX.Catalog
[void]$cat.Create($cs)
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($cat)
$cn = New-Object -ComObject ADODB.Connection
$cn.Open($cs)
[void]$cn.Execute("SELECT * INTO tblPart FROM [Text;DATABASE=$Dir].[parts#csv]")
[void]$cn.Execute("CREATE INDEX ix_partnr ON tblPart (partnr)")
[void]$cn.Execute("CREATE INDEX ix_manufacturer ON tblPart (manufacturer)")
$cn.Close()
`;

function runJet(dbFile, dir) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
    'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(dir, 'make-mdb.ps1');
  fs.writeFileSync(script, PS_SCRIPT, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Db', dbFile, '-Dir', dir], { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve()
      : reject(new Error(`Jet could not write the Access file (exit ${code}): ${err.trim().slice(-600)}`))));
  });
}

const jobs = new Map();
let nextJob = 1;

async function exportToAccess(job, conn, dbFile) {
  if (process.platform !== 'win32') throw new Error('Writing an Access file needs Windows.');
  job.step = 'Reading tblPart from SQL Server…';
  // SELECT *, as the parts search does: older EPLAN schemas lack some of
  // these columns, and naming one that is missing fails the whole query.
  const rows = await withSqlServer(conn, pool =>
    pool.request().query('SELECT * FROM tblPart WITH (NOLOCK) ORDER BY partnr'))
    .then(r => r.recordset.map(row => {
      const lower = {};
      for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
      return Object.fromEntries(COLS.map(c => [c, lower[c.toLowerCase()]]));
    }));
  job.count = rows.length;
  await writeAccessParts(rows, dbFile, step => { job.step = step; });
  job.step = 'Done';
}

/** Write parts rows (tblPart columns) into a new .mdb. Windows only. */
export async function writeAccessParts(rows, dbFile, progress = () => {}) {
  if (process.platform !== 'win32') throw new Error('Writing an Access file needs Windows.');
  progress(`Writing ${rows.length} parts…`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simorgh-parts-'));
  try {
    const lines = [COLS.join(',')];
    for (const r of rows) lines.push(COLS.map(c => csvCell(c, r[c])).join(','));
    // UTF-16 with its byte-order mark: the one Unicode text Jet reads everywhere.
    fs.writeFileSync(path.join(dir, 'parts.csv'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]));
    fs.writeFileSync(path.join(dir, 'schema.ini'), SCHEMA_INI, 'latin1');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });

    progress('Building the Access database…');
    await runJet(dbFile, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function registerLocalDesktopRoutes(app, { sqlDefaults = {}, mysqlDefaults = {} } = {}) {
  defaults = { sql: sqlDefaults, mysql: mysqlDefaults };

  app.get('/api/local/info', (req, res) => {
    res.json({ local: true, partsSource: partsMode(), accessFile: process.env.PARTS_ACCESS_FILE || '' });
  });

  app.post('/api/local/test/mysql', async (req, res) => {
    const c = req.body || {};
    let conn;
    try {
      const cfg = {
        host: pick(c, 'host', defaults.mysql.host),
        port: parseInt(pick(c, 'port', defaults.mysql.port)) || 3306,
        database: pick(c, 'database', defaults.mysql.database),
        user: pick(c, 'user', defaults.mysql.user),
        password: pick(c, 'password', defaults.mysql.password),
        connectTimeout: 10000,
      };
      conn = await mysql.createConnection(cfg);
      await conn.query('SELECT 1');
      res.json({ ok: true, message: `Connected to ${cfg.database} on ${cfg.host}.` });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    } finally {
      conn?.end().catch(() => {});
    }
  });

  app.post('/api/local/test/sqlserver', async (req, res) => {
    try {
      const n = await withSqlServer(req.body || {}, pool =>
        pool.request().query('SELECT COUNT(*) AS n FROM tblPart WITH (NOLOCK)'))
        .then(r => r.recordset[0].n);
      res.json({ ok: true, message: `Connected. tblPart has ${n} parts.` });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.post('/api/local/test/access', (req, res) => {
    try {
      const { rows, manufacturers } = loadAccessParts(req.body?.file);
      res.json({ ok: true, message: `${rows.length} parts from ${manufacturers.length} manufacturers.` });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  // Long enough to outlast an HTTP request, so it runs as a job and is polled.
  app.post('/api/local/parts/export-access', (req, res) => {
    const { sqlServer, file } = req.body || {};
    if (!file) return res.status(400).json({ ok: false, message: 'Choose where to save the Access file.' });
    const id = String(nextJob++);
    const job = { id, state: 'running', step: 'Starting…', count: 0, file, message: '' };
    jobs.set(id, job);
    exportToAccess(job, sqlServer || {}, file)
      .then(() => { job.state = 'done'; job.message = `${job.count} parts written to ${file}.`; })
      .catch(err => { job.state = 'failed'; job.message = err.message; });
    res.json({ ok: true, job: id });
  });

  app.get('/api/local/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, message: 'No such job.' });
    res.json(job);
  });
}
