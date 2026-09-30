// src/utils/lockHeaderRow.ts
//
// A Device Selection sheet whose header row cannot be renamed.
//
// The sheet goes out to be filled in and comes back through Update, which finds
// each column by its heading. A heading typed over in Excel is a column that no
// longer lands anywhere. So the header row is locked and everything else is
// not: the sheet is protected, with no password, and every cell but the
// headings is unlocked — values, rows added or removed, widths, heights,
// colours, sorting and filtering all stay free.
//
// The Excel writer here protects a sheet but drops a cell's own "unlocked"
// flag, so that part is written into the file afterwards: every cell format
// in styles.xml is unlocked except the ones the header row uses. The header
// cells are given a format of their own for that — bottom alignment, which is
// Excel's default and changes nothing on screen — so no data cell shares it.
import * as XLSX from 'xlsx-js-style';

/** The style that sets the header cells apart; looks exactly like no style. */
export const HEADER_CELL_STYLE = { alignment: { vertical: 'bottom' } };

/** What stays allowed on the protected sheet (false = allowed). */
export const PROTECTION = {
  formatCells: false,
  formatColumns: false,
  formatRows: false,
  insertRows: false,
  deleteRows: false,
  sort: false,
  autoFilter: false,
};

/** Give the header row its own style and protect the sheet. */
export function prepareLockedHeader(ws: XLSX.WorkSheet, columns: number): void {
  for (let c = 0; c < columns; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[ref]) ws[ref] = { t: 's', v: '' };
    ws[ref].s = { ...(ws[ref].s ?? {}), ...HEADER_CELL_STYLE };
  }
  ws['!protect'] = { ...PROTECTION };
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * The written workbook with every cell format unlocked but the header row's.
 * `sheetPath` is the protected sheet inside the package.
 */
export function unlockAllButHeader(
  xlsx: ArrayBuffer | Uint8Array, sheetPath = 'xl/worksheets/sheet1.xml',
): Uint8Array {
  const CFB = (XLSX as unknown as { CFB: any }).CFB;
  const zip = CFB.read(xlsx instanceof Uint8Array ? xlsx : new Uint8Array(xlsx), { type: 'array' });
  // Entries are kept under "Root Entry/…"; found by the end of their path.
  const entry = (path: string) => {
    const i = (zip.FullPaths as string[]).findIndex(p => p.endsWith(`/${path}`));
    return i >= 0 ? zip.FileIndex[i] : null;
  };
  const sheetEntry = entry(sheetPath);
  const stylesEntry = entry('xl/styles.xml');
  if (!sheetEntry || !stylesEntry) return xlsx instanceof Uint8Array ? xlsx : new Uint8Array(xlsx);

  // The formats the header row's cells use.
  const sheet = text(sheetEntry.content);
  const firstRow = /<row [^>]*r="1"[^>]*>([\s\S]*?)<\/row>/.exec(sheet)?.[1] ?? '';
  const headerXfs = new Set<number>();
  for (const m of firstRow.matchAll(/<c [^>]*?\bs="(\d+)"/g)) headerXfs.add(Number(m[1]));
  // A header cell with no format would share format 0 with every plain data
  // cell; that one cannot be both locked and not, so nothing is changed.
  if (headerXfs.size === 0 || headerXfs.has(0)) {
    return xlsx instanceof Uint8Array ? xlsx : new Uint8Array(xlsx);
  }

  const styles = text(stylesEntry.content);
  const patched = styles.replace(/<cellXfs([^>]*)>([\s\S]*?)<\/cellXfs>/, (_all, attrs, body) => {
    let index = 0;
    const xfs = body.replace(/<xf\b([^>]*?)(\/>|>([\s\S]*?)<\/xf>)/g,
      (xf: string, xfAttrs: string, _end: string, inner?: string) => {
        const i = index++;
        if (headerXfs.has(i)) return xf;
        const a = /applyProtection=/.test(xfAttrs) ? xfAttrs : `${xfAttrs} applyProtection="1"`;
        const rest = (inner ?? '').replace(/<protection[^>]*\/>/, '');
        return `<xf${a}>${rest}<protection locked="0"/></xf>`;
      });
    return `<cellXfs${attrs}>${xfs}</cellXfs>`;
  });
  stylesEntry.content = bytes(patched);
  return new Uint8Array(CFB.write(zip, { fileType: 'zip', type: 'array' }));
}
