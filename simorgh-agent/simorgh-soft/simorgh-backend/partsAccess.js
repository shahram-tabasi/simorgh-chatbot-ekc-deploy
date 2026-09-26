// partsAccess.js — EPLAN parts from an Access file instead of SQL Server.
//
// The Windows app can run on a machine with no way to the office's SQL Server,
// so its parts can come from an Access database instead: the same tblPart
// EPLAN keeps, in a .mdb/.accdb file. That is also EPLAN's own format for a
// parts database, so a file EPLAN made works as it is, and one made here opens
// in EPLAN and in Microsoft Access — where parts can be added by hand.
//
// PARTS_SOURCE=access and PARTS_ACCESS_FILE=<path> switch it on. The routes
// answer exactly as the SQL ones do (same paths, same shapes), so nothing in
// the app knows which source it is reading. With PARTS_SOURCE unset they step
// aside and the SQL Server routes in server.js answer, as they always have.
//
// The file is read whole into memory and read again whenever it changes on
// disk, so a part added in Access shows up at the next search. Read-only:
// nothing here writes to the file.

import fs from 'fs';
import MDBReader from 'mdb-reader';

export const partsMode = () =>
  String(process.env.PARTS_SOURCE || 'sql').toLowerCase() === 'access' ? 'access' : 'sql';

const SEARCH_FIELDS = [
  'partnr', 'typenr', 'ordernr', 'description1', 'description2', 'description3',
  'manufacturer', 'productgroup',
];
const PART_FIELDS = [
  'partnr', 'typenr', 'ordernr', 'manufacturer',
  'description1', 'description2', 'description3',
  'productgroup', 'productsubgroup',
  'width', 'height', 'depth', 'weight',
  'mountinglocation', 'mountingspace',
  'certificate_CE', 'certificate_UL', 'certificate_ATEX',
];

let cache = { file: '', mtime: 0, rows: [], manufacturers: [] };

const text = v => (v == null ? '' : String(v));

// Access keeps the case a column was created with; SQL Server's tblPart is
// all lower case except the certificates. One spelling, whatever the file.
function normalise(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  const out = {};
  for (const f of PART_FIELDS) out[f] = lower[f.toLowerCase()] ?? null;
  return out;
}

/** The parts in the file, read again only when the file has changed. */
export function loadAccessParts(file = process.env.PARTS_ACCESS_FILE) {
  if (!file) throw new Error('No Access parts file is set. Choose one in Settings.');
  let stat;
  try { stat = fs.statSync(file); } catch {
    throw new Error(`The Access parts file was not found: ${file}`);
  }
  if (cache.file === file && cache.mtime === stat.mtimeMs) return cache;

  const reader = new MDBReader(fs.readFileSync(file));
  const table = reader.getTableNames().find(n => n.toLowerCase() === 'tblpart');
  if (!table) throw new Error(`${file} has no tblPart table — it is not an EPLAN parts database.`);

  const rows = reader.getTable(table).getData().map(normalise)
    .filter(r => text(r.partnr).trim() !== '')
    .sort((a, b) => text(a.partnr).localeCompare(text(b.partnr)));
  const manufacturers = [...new Set(rows.map(r => text(r.manufacturer).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  cache = { file, mtime: stat.mtimeMs, rows, manufacturers };
  console.log(`📦 Access parts: ${rows.length} parts from ${file}`);
  return cache;
}

// SQL Server's LIKE '%x%' under the default collation: anywhere, any case.
function filterParts(rows, search, man) {
  const needle = text(search).trim().toLowerCase();
  const maker = text(man);
  return rows.filter(r =>
    (!maker || text(r.manufacturer) === maker)
    && (!needle || SEARCH_FIELDS.some(f => text(r[f]).toLowerCase().includes(needle))));
}

/**
 * The parts routes, answered from the Access file when PARTS_SOURCE=access.
 * Registered ahead of the SQL Server routes; in SQL mode it passes every
 * request on untouched.
 */
export function registerAccessPartsRoutes(app, transformPartToFrontend) {
  const onlyInAccessMode = handler => async (req, res, next) => {
    if (partsMode() !== 'access') return next();
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`❌ Access parts (${req.method} ${req.path}):`, err.message);
      res.status(500).json({ success: false, error: err.message, data: [] });
    }
  };

  app.post('/api/eplan-parts', onlyInAccessMode((req, res) => {
    const { rows, manufacturers } = loadAccessParts();
    const { searchTerm = '', manufacturer = '', page = 1, pageSize = 100 } = req.body || {};
    const pageNum = Math.max(1, parseInt(page) || 1);
    const size = Math.min(500, Math.max(1, parseInt(pageSize) || 100));
    const hits = filterParts(rows, searchTerm, manufacturer);
    res.json({
      success: true,
      data: hits.slice((pageNum - 1) * size, pageNum * size).map(transformPartToFrontend),
      manufacturers: pageNum === 1 ? manufacturers : [],
      total: hits.length,
      page: pageNum,
      pageSize: size,
      totalPages: Math.ceil(hits.length / size) || 1,
    });
  }));

  app.get('/api/parts', onlyInAccessMode((req, res) => {
    const { rows, manufacturers } = loadAccessParts();
    const { search = '', man = '' } = req.query;
    const offset = parseInt(req.query.offset) || 0;
    const hits = filterParts(rows, search, man);
    res.json({
      success: true,
      total: hits.length,
      data: hits.slice(offset, offset + 50),
      manufacturers: offset === 0 ? manufacturers : null,
    });
  }));

  app.get('/api/manufacturers', onlyInAccessMode((req, res) => {
    const { manufacturers } = loadAccessParts();
    res.json({ success: true, count: manufacturers.length, manufacturers });
  }));

  app.get('/api/parts/:partnr', onlyInAccessMode((req, res) => {
    const { rows } = loadAccessParts();
    const part = rows.find(r => text(r.partnr) === req.params.partnr);
    if (!part) return res.status(404).json({ success: false, error: 'Part not found' });
    res.json({ success: true, data: part });
  }));
}
