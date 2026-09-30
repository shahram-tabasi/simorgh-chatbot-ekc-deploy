// EPLAN symbols — the single-line symbol each part carries in EPLAN.
//
// A part in EPLAN's parts database (tblPart) carries one or more *function
// templates*, and each template names the symbol EPLAN places for it: a
// library (IEC_single_symbol for single-line), a symbol name, and a variant.
// That is exactly the schematic a template row already has, so the drawing
// should follow it instead of guessing from the slot the part sits in.
//
// EPLAN's schema differs between versions and installations, so nothing here
// is hard-coded: `/api/eplan-symbols/schema` looks the tables and columns up
// in INFORMATION_SCHEMA and reports what it finds, and the lookup uses
// whatever was found. Read-only throughout — every statement is a SELECT.
//
// The symbol *graphics* are not in SQL; they live in EPLAN's symbol libraries.
// Two things cover that:
//   · the app draws its own IEC single-line symbols, chosen by the EPLAN
//     symbol name (see src/utils/eplanSymbolShapes.ts on the frontend);
//   · anything exported from EPLAN as SVG and dropped into the symbol folder
//     is served by name and used instead, so the drawing can carry the very
//     symbols the office uses.
import fs from 'fs';
import path from 'path';

const clean = v => (v === null || v === undefined ? '' : String(v).trim());

// Columns that, when a table has them, make it the function-template table.
const SYMBOL_COLUMN_HINTS = ['symbolname', 'symbol', 'symbolmacro', 'symbollibrary', 'symbollib'];
const PART_KEY_HINTS = ['partid', 'part_id', 'idpart', 'partnr'];

/** Which table and columns in this EPLAN database name a part's symbol. */
export function pickSymbolSource(rows) {
  // rows: { table_name, column_name } from INFORMATION_SCHEMA.COLUMNS
  const byTable = new Map();
  for (const row of rows) {
    const table = clean(row.table_name || row.TABLE_NAME);
    const column = clean(row.column_name || row.COLUMN_NAME);
    if (!table || !column) continue;
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(column);
  }

  const candidates = [];
  for (const [table, columns] of byTable) {
    const lower = columns.map(c => c.toLowerCase());
    const symbol = SYMBOL_COLUMN_HINTS.map(h => lower.indexOf(h)).find(i => i >= 0);
    if (symbol === undefined) continue;
    const key = PART_KEY_HINTS.map(h => lower.indexOf(h)).find(i => i >= 0);
    candidates.push({
      table,
      symbolColumn: columns[symbol],
      partColumn: key === undefined ? '' : columns[key],
      libraryColumn: columns[lower.findIndex(c => c === 'symbollibrary' || c === 'symbollib')] || '',
      variantColumn: columns[lower.findIndex(c => c === 'symbolvariant' || c === 'variant')] || '',
      functionColumn: columns[lower.findIndex(c => c.includes('functiondefinition') || c === 'functiontemplate')] || '',
      columns,
    });
  }

  // A table that can be joined back to a part is worth more than one that
  // cannot; a function-template table more than anything else.
  candidates.sort((a, b) => {
    const score = c =>
      (c.partColumn ? 4 : 0) +
      (/function/i.test(c.table) ? 2 : 0) +
      (c.libraryColumn ? 1 : 0);
    return score(b) - score(a);
  });
  return candidates[0] || null;
}

/**
 * The EPLAN symbol of each part, keyed by BOTH its part number and its order
 * number — a template row here may carry either, depending on whether the part
 * came from the EPLAN browser or from TPMS.
 */
export function indexSymbolRows(rows) {
  const out = {};
  for (const row of rows || []) {
    const symbol = clean(row.symbolname);
    if (!symbol) continue;
    const entry = {
      symbol,
      library: clean(row.symbollibrary),
      variant: clean(row.symbolvariant),
      functionDefinition: clean(row.functiondefinition),
      partNumber: clean(row.partnr),
      orderNumber: clean(row.ordernr),
    };
    for (const key of [clean(row.partnr), clean(row.ordernr)]) {
      if (key && !out[key]) out[key] = entry;
    }
  }
  return out;
}

// How big a symbol in the pack is, and where its conductor runs — so the
// drawing can size it to the cell and put its own connection point on the
// branch line instead of guessing at the middle of the picture.
//
//   viewBox / width / height   the symbol's own coordinate box
//   data-pin-x / data-pin-y    the conductor's place in that box, optional
//
// Only the head of the file is read: an SVG carrying a bitmap can be large,
// and everything wanted here is in its opening tag.
export function readSymbolBox(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4096);
    const read = fs.readSync(fd, buffer, 0, 4096, 0);
    fs.closeSync(fd);
    head = buffer.slice(0, read).toString('utf8');
  } catch {
    return {};
  }
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
  const attr = name => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
  const number = value => {
    const n = parseFloat(String(value ?? '').replace(/[^0-9.+-].*$/, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const box = (attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const viewBox = box.length === 4 && box.every(Number.isFinite) ? box : null;
  const width = viewBox ? viewBox[2] : number(attr('width'));
  const height = viewBox ? viewBox[3] : number(attr('height'));
  const pinX = number(attr('data-pin-x'));
  const pinY = number(attr('data-pin-y'));
  const cells = number(attr('data-cells'));

  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(pinX != null ? { pinX } : {}),
    ...(pinY != null ? { pinY } : {}),
    ...(cells != null ? { cells } : {}),
    ...(attr('data-title') ? { title: attr('data-title') } : {}),
  };
}

export function registerEplanSymbolRoutes(app, getSqlPool, symbolDir) {
  const dir = symbolDir || path.join(process.cwd(), 'eplan-symbols');
  // Remembered after the first look-up so every request doesn't re-read
  // INFORMATION_SCHEMA.
  let source = null;

  const discover = async pool => {
    if (source) return source;
    const result = await pool.request().query(`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME LIKE '%function%' OR TABLE_NAME LIKE '%symbol%'
         OR COLUMN_NAME LIKE '%symbol%'`);
    source = pickSymbolSource(result.recordset || []);
    return source;
  };

  // What this EPLAN database calls its symbols — so a database that keeps
  // them somewhere else can be reported rather than silently skipped.
  app.get('/api/eplan-symbols/schema', async (req, res) => {
    try {
      const pool = await getSqlPool();
      source = null;                      // always a fresh look for this route
      const found = await discover(pool);
      res.json({
        success: true,
        found: !!found,
        table: found?.table || '',
        symbolColumn: found?.symbolColumn || '',
        partColumn: found?.partColumn || '',
        libraryColumn: found?.libraryColumn || '',
        variantColumn: found?.variantColumn || '',
        functionColumn: found?.functionColumn || '',
        columns: found?.columns || [],
      });
    } catch (err) {
      console.error('❌ Error in /api/eplan-symbols/schema:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // The symbol EPLAN uses for each of these part numbers.
  app.post('/api/eplan-symbols/lookup', async (req, res) => {
    const parts = Array.isArray(req.body?.parts)
      ? req.body.parts.map(clean).filter(Boolean).slice(0, 500)
      : [];
    if (parts.length === 0) return res.json({ success: true, symbols: {}, source: null });

    try {
      const pool = await getSqlPool();
      const found = await discover(pool);
      if (!found || !found.partColumn) {
        return res.json({
          success: true, symbols: {}, source: found?.table || null,
          note: 'This EPLAN database has no function-template table that can be joined to a part.',
        });
      }

      const request = pool.request();
      const names = parts.map((value, i) => {
        request.input(`p${i}`, value);
        return `@p${i}`;
      }).join(',');

      // tblPart is EPLAN's parts table; the template table points back at it
      // either by its id or by the part number itself.
      const extra =
        `${found.libraryColumn ? `, t.[${found.libraryColumn}] AS symbollibrary` : ''}` +
        `${found.variantColumn ? `, t.[${found.variantColumn}] AS symbolvariant` : ''}` +
        `${found.functionColumn ? `, t.[${found.functionColumn}] AS functiondefinition` : ''}`;

      // A row here may name the part by its part number or by its order
      // number — the code TPMS carries is often the order number — so both
      // are matched and both come back as keys.
      const joinById = /id/i.test(found.partColumn);
      const sql = joinById
        ? `SELECT p.partnr AS partnr, p.ordernr AS ordernr,
                  t.[${found.symbolColumn}] AS symbolname${extra}
           FROM tblPart p WITH (NOLOCK)
           JOIN [${found.table}] t WITH (NOLOCK) ON t.[${found.partColumn}] = p.id
           WHERE p.partnr IN (${names}) OR p.ordernr IN (${names})`
        : `SELECT t.[${found.partColumn}] AS partnr, '' AS ordernr,
                  t.[${found.symbolColumn}] AS symbolname${extra}
           FROM [${found.table}] t WITH (NOLOCK)
           WHERE t.[${found.partColumn}] IN (${names})`;

      const result = await request.query(sql);
      const symbols = indexSymbolRows(result.recordset || []);
      const distinct = new Set(Object.values(symbols).map(v => v.partNumber || v.symbol)).size;
      console.log(`✅ EPLAN symbols: ${distinct}/${parts.length} part(s) resolved ` +
        `from ${found.table}.${found.symbolColumn}`);
      res.json({ success: true, symbols, source: `${found.table}.${found.symbolColumn}` });
    } catch (err) {
      console.error('❌ Error in /api/eplan-symbols/lookup:', err.message);
      res.status(500).json({ success: false, error: err.message, symbols: {} });
    }
  });

  // ── The symbol pack ────────────────────────────────────────────────────
  // Symbols exported from EPLAN or drawn by the office, named after the symbol
  // (SG3.svg, Q1.svg, vcb.dxf …). Whatever is here is used in place of the
  // app's own drawing of it.
  //
  // An SVG is a picture and its box is read here, out of its opening tag. A
  // DXF is geometry, and geometry is read by the app itself — the same reader
  // the Simorgh Draw tab uses for a file the user picks — so the file is
  // listed and served, and its box, its conductor and its terminals come out
  // of the drawing rather than out of an attribute someone had to write.
  app.get('/api/eplan-symbols/pack', (req, res) => {
    try {
      if (!fs.existsSync(dir)) return res.json({ success: true, dir, symbols: [] });
      const symbols = fs.readdirSync(dir)
        // A leading dot is a hidden file or an upload still being written.
        .filter(f => !f.startsWith('.') && /\.(svg|dxf)$/i.test(f))
        .map(f => {
          const kind = path.extname(f).slice(1).toLowerCase();
          const entry = { name: path.basename(f, path.extname(f)), kind };
          return kind === 'svg' ? { ...entry, ...readSymbolBox(path.join(dir, f)) } : entry;
        });
      res.json({ success: true, dir, symbols });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, symbols: [] });
    }
  });

  // Only a plain name — never a path — can be asked for.
  const safeName = value => String(value || '').replace(/[^A-Za-z0-9_.-]/g, '');

  app.get('/api/eplan-symbols/svg/:name', (req, res) => {
    const name = safeName(req.params.name);
    const file = path.join(dir, `${name}.svg`);
    if (!name || !fs.existsSync(file)) return res.status(404).send('');
    res.type('image/svg+xml').send(fs.readFileSync(file, 'utf8'));
  });

  app.get('/api/eplan-symbols/dxf/:name', (req, res) => {
    const name = safeName(req.params.name);
    const file = path.join(dir, `${name}.dxf`);
    if (!name || !fs.existsSync(file)) return res.status(404).send('');
    res.type('image/vnd.dxf').send(fs.readFileSync(file, 'utf8'));
  });

  // ── Adding a symbol from the browser ───────────────────────────────────
  // Copying a file onto the server is still the way to add a symbol, and this
  // does the same thing for an office that has the drawing but not a shell on
  // the machine. It only ever writes: a symbol is removed by deleting the file,
  // deliberately, by someone who can see the folder.
  //
  // Whether it works at all depends on how the folder is mounted. It was
  // read-only for a long time, and on a server where it still is the write
  // fails and says so rather than looking as though it worked.
  const MAX_SYMBOL_BYTES = 8 * 1024 * 1024;

  app.post('/api/eplan-symbols/upload', (req, res) => {
    const asked = String(req.body?.name ?? '').trim();
    const kind = String(req.body?.kind || '').toLowerCase();
    const content = req.body?.content;

    // Checked rather than scrubbed. A name that had to be repaired to be safe
    // was not the name anybody meant, and writing it under some third name is
    // how a folder fills up with files nobody recognises.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(asked) || asked.includes('..')) {
      return res.status(400).json({
        success: false,
        error: 'A symbol name starts with a letter or digit and holds only letters, digits, _ . or -.',
      });
    }
    const name = asked;
    if (kind !== 'svg' && kind !== 'dxf') {
      return res.status(400).json({ success: false, error: 'A symbol is an .svg or a .dxf.' });
    }
    if (typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ success: false, error: 'The file was empty.' });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_SYMBOL_BYTES) {
      return res.status(413).json({ success: false, error: 'The file is over 8 MB.' });
    }

    const file = path.join(dir, `${name}.${kind}`);
    // Belt and braces over the scrubbed name: the file must land in the folder.
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
      return res.status(400).json({ success: false, error: 'That name is not allowed.' });
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const replaced = fs.existsSync(file);
      // Written beside and moved into place, so a half-written file is never
      // served to a browser that asks for it mid-upload.
      const temp = path.join(dir, `.${name}.${kind}.${process.pid}.tmp`);
      fs.writeFileSync(temp, content, 'utf8');
      fs.renameSync(temp, file);
      res.json({ success: true, name, kind, replaced });
    } catch (err) {
      const readOnly = err && (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM');
      res.status(readOnly ? 409 : 500).json({
        success: false,
        error: readOnly
          ? 'The symbol folder is read-only on this server. Copy the file into eplan-symbols/ instead, or take :ro off that mount in compose/soft-app.yml.'
          : err.message,
      });
    }
  });
}
