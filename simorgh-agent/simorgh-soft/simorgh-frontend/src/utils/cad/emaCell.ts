// src/utils/cad/emaCell.ts
//
// A template's cell as an EPLAN window macro whose devices are EPLAN's own —
// functions placed from the office's SLD library, joined by EPLAN itself.
//
// `renderEma` writes a drawing as lines and texts: EPLAN shows it, but to
// EPLAN it is a picture. Here nothing that carries current is drawn. Each
// device is placed as the office's macros place it (a copy of the device out
// of one of them, moved and renumbered — `PROTOS`), and laid out so its
// connection points face the next device's on one line; where a line turns
// or branches, one of EPLAN's corners or T-nodes stands (`CONNS`). EPLAN's
// autoconnecting then draws every wire on insertion, as it does for the
// office's own macros, and the devices are devices: tagged when the project
// is numbered, in the parts and connection lists.
//
// The geometry is the SLD library's (`PINS`, read out of SLD.sdb): where each
// variant's connection points are and which way they face. Nothing is
// estimated; a device the library has no variant for is left out of the
// macro and named in a note on it instead.
//
// Laid out in millimetres, y up: the main line runs down x = 0 from the
// busbar at y = 0, what hangs off it to the side of it, and each CT core runs
// out to the right along its own row through what it feeds.
import { PINS, FD, PROTOS, CONNS } from './emaParts';
import { num, multi, HEAD, emaDocument } from './ema';
import { templateCell, breakLabel, signalList, type ChainItem } from '../eplanSingleLine';
import type { SymbolId } from '../iecSymbols';
import type { Tier } from '../tiers';

type Pin = { x: number; y: number; dir: number };
const UP = 1, RIGHT = 2, DOWN = 4, LEFT = 8;

/** Our kind of device → the SLD library's symbol and variant. */
const EPLAN_OF: Partial<Record<SymbolId, [number, number]>> = {
  vcb: [1, 1], 'vcb-racking': [1, 1], 'withdrawable-cb': [1, 1], 'circuit-breaker': [1, 1],
  'vacuum-contactor-fuse': [1, 1], disconnector: [1, 1], 'switch-disconnector': [1, 1], mcb: [1, 1],
  contactor: [12, 1],
  'earthing-switch': [1, 7],
  'capacitive-divider': [7, 0],
  'surge-arrester': [14, 3], 'surge-limiter': [14, 3],
  magnet: [13, 1],
  'voltage-transformer': [3, 1],
  'test-block': [50, 0],
  ammeter: [9, 1], voltmeter: [9, 1], 'frequency-meter': [9, 1],
  multimeter: [23, 1], 'watt-meter': [23, 1], 'var-meter': [23, 1], 'power-factor-meter': [23, 1],
  'kwh-meter': [23, 1], 'kvarh-meter': [23, 1], transducer: [23, 1],
  'alarm-annunciator': [24, 0],
  lamp: [10, 1],
};
const RELAYS: SymbolId[] = ['protection-relay', 'earth-fault-relay'];
const SWITCHES: SymbolId[] = ['vcb', 'vcb-racking', 'withdrawable-cb', 'circuit-breaker',
  'vacuum-contactor-fuse', 'disconnector', 'switch-disconnector', 'mcb', 'contactor'];
const METERS: SymbolId[] = ['ammeter', 'multimeter', 'watt-meter', 'var-meter', 'power-factor-meter',
  'kwh-meter', 'kvarh-meter', 'transducer'];
const VOLTS: SymbolId[] = ['voltmeter', 'frequency-meter'];
/** A CT by how many cores leave it: its variant of SLD 2. */
const CT_VARIANT = (cores: number) => (cores <= 0 ? 3 : cores === 1 ? 5 : cores === 2 ? 1 : 2);

const pinsOf = (n: number, v: number): Pin[] | undefined =>
  PINS[`${n}:${v}`]?.map(([x, y, dir]) => ({ x, y, dir }));

/** The page being written: objects in mm about the cell's own origin. */
class Page {
  readonly out: string[] = [];
  private id = 300000;
  box = { l: Infinity, t: -Infinity, r: -Infinity, b: Infinity };
  /** Devices the library had no variant for — named on the macro. */
  readonly missing: string[] = [];

  constructor(private ox: number, private oy: number) {}

  next(type: string) { return `${type}/${this.id++}`; }
  private at(x: number, y: number) { return `${num(this.ox + x)}/${num(this.oy + y)}`; }
  grow(x: number, y: number, pad = 0) {
    this.box.l = Math.min(this.box.l, x - pad); this.box.r = Math.max(this.box.r, x + pad);
    this.box.t = Math.max(this.box.t, y + pad); this.box.b = Math.min(this.box.b, y - pad);
  }

  /** A text: `align` 1–9 from the top left, row by row, as EPLAN numbers it. */
  textXml(x: number, y: number, s: string, align = 7, height = 1.8, rad = 0): string {
    const lines = s.split('\n').length;
    this.grow(x, y, 2);
    this.grow(x + (align % 3 === 0 ? -1 : 1) * s.split('\n').reduce((m, l) => Math.max(m, l.length), 0) * height * 0.7,
      y + (align <= 3 ? -1 : 1) * lines * height * 1.4);
    return `  <O30 Build="15117" A1="${this.next('30')}" ${HEAD} A411="108" A412="L" A413="L" A414="L" A415="L" ` +
      `A416="0" A501="${this.at(x, y)}" A503="0" A506="0" A511="${multi(s)}">\r\n` +
      `  <S54x505 A961="${num(height)}" A962="${num(rad)}" A963="0" A964="L" A965="0" A966="${align}" ` +
      'A967="0" A968="0" A969="0" A4000="L" A4001="L" A4013="0"/>\r\n  </O30>';
  }
  text(x: number, y: number, s: string, align = 7, height = 1.8, rad = 0) {
    if (s.trim()) this.out.push(this.textXml(x, y, s, align, height, rad));
  }
  line(x1: number, y1: number, x2: number, y2: number, dashed = false) {
    this.grow(x1, y1); this.grow(x2, y2);
    const pen = dashed ? 'A411="100" A412="1" A413="L" A414="0.13" A415="-3" A416="0"'
      : 'A411="100" A412="L" A413="L" A414="L" A415="L" A416="0"';
    this.out.push(`  <O31 Build="15117" A1="${this.next('31')}" ${HEAD} ${pen} ` +
      `A531="${this.at(x1, y1)}" A532="${this.at(x2, y2)}"/>`);
  }
  poly(pts: [number, number][], close = false) {
    pts.forEach(([x, y]) => this.grow(x, y));
    const all = close ? [...pts, pts[0]] : pts;
    this.out.push(`  <O34 Build="15117" A1="${this.next('34')}" ${HEAD} A411="100" A412="L" A413="L" A414="L" ` +
      `A415="L" A416="0" A621="${all.map(([x, y]) => this.at(x, y)).join(';')}" A623="0" A624="0"/>`);
  }
  dashedPath(pts: [number, number][]) {
    for (let k = 1; k < pts.length; k++) this.line(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], true);
  }
  rect(x1: number, y1: number, x2: number, y2: number) {
    this.grow(x1, y1); this.grow(x2, y2);
    this.out.push(`  <O89 Build="15117" A1="${this.next('89')}" ${HEAD} A411="100" A412="L" A413="L" A414="L" ` +
      `A415="L" A416="0" A1651="${this.at(x1, y1)}" A1652="${this.at(x2, y2)}" A1653="0" A1654="0" A1655="0" ` +
      'A1656="0" A1657="0"/>');
  }

  /** One of EPLAN's corners or T-nodes. */
  conn(n: number, v: number, x: number, y: number) {
    const proto = CONNS[`${n}:${v}`] ?? (CONNS[`${n}:0`] ? CONNS[`${n}:0`].replace(/A1263="\d+"/, `A1263="${v}"`) : '');
    if (!proto) return;
    this.grow(x, y, 2);
    this.out.push(this.copy(proto, x, y, 'O42'));
  }

  /**
   * A device out of the office's macros, its insertion point at (x, y), with
   * its own texts. `key` is library:number:variant; a variant no macro had is
   * made from one of the same symbol, or of a symbol with the same points.
   */
  device(lib: string, n: number, v: number, x: number, y: number, texts: string[] = [], given?: string) {
    const own = given ?? PROTOS[`${lib}:${n}:${v}`];
    let proto = own;
    if (!proto) {
      const pins = lib === 'SLD' ? pinsOf(n, v) : undefined;
      const sameSymbol = Object.keys(PROTOS).find(k => k.startsWith(`${lib}:${n}:`));
      const base = sameSymbol ?? (pins?.length === 1 ? 'SLD:7:0'
        : pins?.length === 2 && pins.every(p => p.dir === LEFT || p.dir === RIGHT) ? 'SLD:50:0'
          : pins?.length === 2 ? 'SLD:13:1' : 'SLD:2:1');
      proto = PROTOS[base];
      if (!proto) return;
      proto = this.retarget(proto, n, v, pins?.length ?? 0);
    }
    const pins = lib === 'SLD' ? pinsOf(n, v) ?? [] : [];
    for (const p of pins) this.grow(x + p.x, y + p.y, 3);
    this.grow(x, y, 4);
    this.out.push(this.copy(proto, x, y, 'O17', texts));
  }

  /** A copy of a prototype made into another symbol or variant. */
  private retarget(proto: string, n: number, v: number, pinCount: number): string {
    const doc = new DOMParser().parseFromString(`<r>${proto}</r>`, 'application/xml');
    const f = doc.getElementsByTagName('O17')[0];
    if (!f) return proto;
    f.setAttribute('A1262', String(n));
    f.setAttribute('A1263', String(v));
    if (FD[String(n)] != null) f.setAttribute('A1381', String(FD[String(n)]));
    // Its connection points, one entry each.
    const list = f.getElementsByTagName('S61x183')[0];
    if (list) {
      const entries = Array.from(list.getElementsByTagName('S16x1062'));
      const first = entries[0];
      entries.forEach(e => e.parentNode?.removeChild(e));
      if (first) {
        for (let k = 1; k <= pinCount; k++) {
          const e = first.cloneNode(true) as Element;
          e.setAttribute('A161', String(k));
          list.appendChild(e);
        }
      }
      list.setAttribute('A1061', String(pinCount));
    }
    // A designation placed at a connection point it no longer has.
    Array.from(f.getElementsByTagName('S53x5')).forEach(e => {
      const c = Number(e.getAttribute('A772') ?? 0);
      if (c > pinCount) e.parentNode?.removeChild(e);
    });
    return serialize(doc);
  }

  /**
   * A prototype moved so its `anchor` object stands at (x, y), renumbered,
   * its own texts swapped for `texts`.
   */
  private copy(proto: string, x: number, y: number, anchor: 'O17' | 'O42', texts: string[] = []): string {
    const doc = new DOMParser().parseFromString(`<r>${proto}</r>`, 'application/xml');
    const root = doc.documentElement;
    const all = Array.from(root.getElementsByTagName('*'));
    const a = root.getElementsByTagName(anchor)[0];
    const pos = a && Array.from(a.children).find(c => c.tagName === 'S40x1201')?.getAttribute('A762');
    if (!a || !pos) return '';
    const [px, py] = pos.split('/').map(Number);
    const dx = this.ox + x - px;
    const dy = this.oy + y - py;
    const shift = (el: Element, attr: string) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      const [vx, vy, ...rest] = v.split('/');
      el.setAttribute(attr, [num(Number(vx) + dx), num(Number(vy) + dy), ...rest].join('/'));
    };
    // New ids, and every reference to an old one follows it.
    const ids = new Map<string, string>();
    for (const el of all) {
      const id = el.getAttribute('A1');
      if (id && /^\d+\/\d+$/.test(id)) ids.set(id, this.next(id.split('/')[0]));
    }
    for (const el of all) {
      for (const at of Array.from(el.attributes)) {
        if (at.name !== 'A1' && !/^R\d+$/.test(at.name) && at.name !== 'A502' && at.name !== 'A683') continue;
        const m = /^(\d+\/\d+)(\/\d+)?$/.exec(at.value);
        if (m && ids.has(m[1])) el.setAttribute(at.name, ids.get(m[1]) + (m[2] ?? ''));
      }
      if (el.tagName === 'S40x1201') shift(el, 'A762');
      if (el.tagName === 'O30') shift(el, 'A501');
      if (el.tagName === 'O32') shift(el, 'A555');
    }
    // The prototype's own texts said its job's tags; ours go in their place.
    const group = root.firstElementChild;
    if (group?.tagName === 'O26') {
      Array.from(group.children).filter(c => c.tagName === 'O30').forEach(c => group.removeChild(c));
      for (const t of texts) {
        const tdoc = new DOMParser().parseFromString(`<r>${t}</r>`, 'application/xml');
        const el = tdoc.documentElement.firstElementChild;
        if (el) group.insertBefore(doc.importNode(el, true), group.firstChild);
      }
      return '  ' + serialize(doc);
    }
    // A device that is not grouped: its texts stand beside it.
    return ['  ' + serialize(doc), ...texts].join('\r\n');
  }
}

const serialize = (doc: Document) => {
  const s = new XMLSerializer();
  return Array.from(doc.documentElement.childNodes)
    .filter(n => n.nodeType === 1)
    .map(n => s.serializeToString(n).replace(/ xmlns="[^"]*"/g, ''))
    .join('\r\n');
};

/** Whether the macro being written carries the SIM-TABLE, or the letters alone. */
let WITH_SIM = true;

/** The text a device carries: its letter and SIM-TABLE, broken as the sheet breaks it. */
const labelOf = (item: ChainItem, wrap = 26) =>
  breakLabel(item.simTable && WITH_SIM ? `${item.label} : ${item.simTable}` : item.label, wrap).join('\n');

/** A template's cell as an EPLAN window macro of EPLAN's own devices —
 *  with each device's SIM-TABLE, or (simTable false) its letter alone. */
export function renderEmaCell(template: { name?: string } & Record<string, any>, tier: Tier, opts: { simTable?: boolean } = {}): string {
  const prev = WITH_SIM;
  WITH_SIM = opts.simTable !== false;
  try {
    return renderEmaCellBody(template, tier);
  } finally {
    WITH_SIM = prev;
  }
}

function renderEmaCellBody(template: { name?: string } & Record<string, any>, tier: Tier): string {
  const { chain, answers, family, cores: coresFor } = templateCell(template as any, tier);
  const page = new Page(60, 280);
  const skipped = (item: ChainItem) => page.missing.push(`${item.label} (${item.id})`);

  const take = (pred: (i: ChainItem) => boolean) => chain.filter(pred);
  const sw = chain.find(i => SWITCHES.includes(i.id));
  const earth = take(i => i.id === 'earthing-switch');
  const left = [...earth, ...take(i => i.id === 'magnet')];
  const right = take(i => ['capacitive-divider', 'surge-arrester', 'surge-limiter', 'voltage-transformer'].includes(i.id));
  // The CT the cores leave first, the core-balance CT after it — the order
  // the sheet draws them in.
  const cts = [...take(i => i.id === 'current-transformer'), ...take(i => i.id === 'core-balance-ct')];
  const relays = take(i => RELAYS.includes(i.id));
  const relay = relays.find(r => r.relayRole === 'main') ?? relays.find(r => r.relayRole !== 'auxiliary') ?? relays[0];
  const testBlock = chain.find(i => i.id === 'test-block');
  const meters = take(i => METERS.includes(i.id));
  const volts = take(i => VOLTS.includes(i.id));
  const others = take(i => ['alarm-annunciator', 'lamp'].includes(i.id));
  const placed = new Set<ChainItem>([...(sw ? [sw] : []), ...left, ...right, ...cts, ...relays,
    ...(testBlock ? [testBlock] : []), ...meters, ...volts, ...others]);
  chain.filter(i => !placed.has(i)).forEach(skipped);

  // ── Down the main line ────────────────────────────────────────────────
  /** Each row of the secondary side: where it leaves and what it is for. */
  const rows: { item: ChainItem; y: number; x: number; purpose: string; text?: string }[] = [];
  page.conn(64, 0, 0, 0);
  let y = -10;
  /** The lowest point the main line reaches: where it goes on to the load. */
  let lineEnd = 0;
  /** A device on the line: its top point at `y`, the line on from its bottom. */
  const onLine = (item: ChainItem, n: number, v: number, lx = -14, ly = 0): number | null => {
    const pins = pinsOf(n, v);
    const top = pins?.find(p => p.dir === UP);
    if (!pins || !top) { skipped(item); return null; }
    const insY = y - top.y;
    page.device('SLD', n, v, 0, insY, [page.textXml(lx, insY + ly, labelOf(item, 22), ly ? 9 : 6)]);
    const bottom = pins.find(p => p.dir === DOWN);
    y = (bottom ? insY + bottom.y : insY - 8) - 10;
    lineEnd = bottom ? insY + bottom.y : lineEnd;
    return insY;
  };

  /** Where the switch, the earth switch and the magnet stand, for the
   *  mechanical interlock between them. */
  let swMid: number | null = null;
  let esMid: number | null = null;
  let mbAt: { x: number; y: number } | null = null;
  // The switch's label stands clear of its operating mechanism on its left,
  // as the office's macros place it.
  // Above it, the interlock's dashed line leaves under it.
  if (sw) {
    const at = onLine(sw, ...(EPLAN_OF[sw.id] ?? [1, 1]), -12, 8);
    // Its operating mechanism, where the office's macros take the
    // mechanical interlock from: 11 mm under its insertion point.
    swMid = at == null ? null : at - 11;
  }

  // What hangs to the left: the earth switch down from a corner, the magnet
  // beside it.
  // The earth switch's label on its right, between it and the line; the
  // magnet beside it on its left, its label further left.
  const ES_X = -30;
  for (const item of earth) {
    page.conn(67, 0, 0, y);
    page.conn(70, 0, ES_X, y);
    const [n, v] = EPLAN_OF[item.id]!;
    const top = pinsOf(n, v)?.find(p => p.dir === UP);
    const insY = y - 10 - (top?.y ?? 0);
    // Where the interlock comes into its side, as the office's macros
    // have it: 2 mm under its insertion point.
    esMid = insY - 2;
    page.device('SLD', n, v, ES_X, insY, [page.textXml(ES_X + 4, insY - 4, labelOf(item, 13), 4, 1.6)]);
    y -= 34;
  }
  // The magnet under the earth switch and to its left: the earth switch's
  // contact lets it open the door.
  for (const item of take(i => i.id === 'magnet')) {
    const [n, v] = EPLAN_OF[item.id]!;
    const mx = ES_X - 10;
    const my = (esMid ?? y + 30) - 18;
    page.device('SLD', n, v, mx, my, [page.textXml(mx - 6, my, labelOf(item, 14), 6, 1.6)]);
    mbAt = { x: mx, y: my };
  }

  // What is tapped off to the right: the detector, the arrester and its
  // earth, the VT — each on its own row from a T on the line.
  const tapRight = (item: ChainItem) => {
    const [n, v] = EPLAN_OF[item.id]!;
    const pins = pinsOf(n, v) ?? [];
    const inPin = pins.find(p => p.dir === LEFT);
    if (!inPin) { skipped(item); return; }
    page.conn(66, 0, 0, y);
    lineEnd = y;
    const insX = 24 - inPin.x;
    page.device('SLD', n, v, insX, y, [page.textXml(insX, y + 6, labelOf(item, 22), 8)]);
    if (item.id === 'surge-arrester' || item.id === 'surge-limiter') {
      page.device('IEC_symbol', 300, 1, insX + 10, y);
    }
    if (item.id === 'voltage-transformer') {
      pins.filter(p => p.dir === RIGHT).forEach(p =>
        rows.push({ item, x: insX + p.x, y: y + p.y, purpose: 'voltage' }));
    }
    y -= 20;
  };
  // EK36 puts the capacitive detector before the CT, as its sheets do.
  const before = family === 'EK36' ? right.filter(i => i.id === 'capacitive-divider') : [];
  before.forEach(tapRight);

  // The CTs on the line, each core out to the right on its own row.
  for (const ct of cts) {
    const list = coresFor(ct, Boolean(relay), meters.length > 0);
    const v = ct.id === 'core-balance-ct' ? 5 : CT_VARIANT(list.length);
    const insY = onLine(ct, 2, v);
    if (insY == null) continue;
    const outs = (pinsOf(2, v) ?? []).filter(p => p.dir === RIGHT);
    list.slice(0, outs.length).forEach((core, k) => rows.push({
      item: ct, x: outs[k].x, y: insY + outs[k].y, purpose: core.purpose, text: core.text,
    }));
  }

  right.filter(i => !before.includes(i)).forEach(tapRight);
  // The line on to the load: its arrow, and what it goes to — as the sheet
  // writes it, or as the cell names it.
  {
    const tip = lineEnd - 12;
    page.line(0, lineEnd, 0, tip);
    page.poly([[-1.5, tip + 3], [0, tip], [1.5, tip + 3]], true);
    page.text(3, tip + 1.5, String(answers.connectedTo ?? '').trim() || 'to the load', 4, 2);
  }

  // ── Each row of the secondary side ────────────────────────────────────
  // The devices on a row in series, one's right point facing the next one's
  // left, so EPLAN joins them; the relay last on a protection row.
  const measuring = rows.filter(r => r.purpose === 'measurement').length;
  let measSeen = 0;
  // One relay for every protection core: it stands right of all of them, the
  // first core straight into its connection point, each other one round two
  // corners into a connection point of its own on the same box.
  const protection = relay ? rows.filter(r => r.purpose === 'protection') : [];
  // What each row carries, worked out first: the relay stands right of the
  // longest of them, so no core on its way to it crosses another row.
  const span = (item: ChainItem) => {
    const pins = pinsOf(...(EPLAN_OF[item.id] ?? [0, 0]));
    const l = pins?.find(p => p.dir === LEFT);
    const r = pins?.find(p => p.dir === RIGHT);
    return l ? (r ? r.x : 6) - l.x + 14 : 0;
  };
  let measPlan = 0;
  const carries = new Map(rows.map(row => {
    const list: ChainItem[] = [];
    if (row.purpose !== 'remark' && row.purpose !== 'voltage' && testBlock) list.push(testBlock);
    if (row.purpose === 'measurement') {
      const j = measPlan++;
      list.push(...(j === measuring - 1 ? meters.slice(j) : meters.slice(j, j + 1)));
    }
    if (row.purpose === 'voltage') list.push(...volts);
    return [row, list] as const;
  }));
  const rowEnd = (row: typeof rows[number]) =>
    row.x + 12 + (carries.get(row) ?? []).reduce((w, i) => w + span(i), 0) + (row.purpose === 'remark' ? 40 : 0);
  const relayX = Math.max(0, ...rows.map(rowEnd)) + 4 + protection.length * 3;
  const relayY = protection[0]?.y ?? 0;
  const DCP_STEP = 3;
  let relayBox: { x: number; y: number } | null = null;
  if (relay && protection.length) {
    relayBox = placeRelay(page, relay, relayX, relayY, protection.slice(1).map((_, k) => -(k + 1) * DCP_STEP));
  }
  /** Signals down to the foot of the cell, drawn once everything stands. */
  const signals: { x: number; from: number; text: string; up?: boolean }[] = [];
  for (const row of rows) {
    let cx = row.x + 12;
    const put = (item: ChainItem) => {
      const [n, v] = EPLAN_OF[item.id] ?? [0, 0];
      const pins = pinsOf(n, v);
      const l = pins?.find(p => p.dir === LEFT);
      if (!pins || !l) { skipped(item); return; }
      const insX = cx - l.x;
      page.device('SLD', n, v, insX, row.y, [page.textXml(insX, row.y + 5, labelOf(item, 18), 8, 1.6)]);
      signalList(item).forEach((t, k) => signals.push({ x: insX + 2 + k * 3, from: row.y - 4, text: t.text, up: t.up }));
      const r = pins.find(p => p.dir === RIGHT);
      cx = (r ? insX + r.x : insX + 6) + 14;
    };
    if (row.purpose === 'remark' || (row.purpose === 'measurement' && !meters.length)) {
      page.line(row.x, row.y, row.x + 20, row.y);
      page.poly([[row.x + 20, row.y + 1], [row.x + 22, row.y], [row.x + 20, row.y - 1]], true);
      page.text(row.x + 24, row.y, (row.text || (row.purpose === 'remark' ? '' : 'MEASURING')).toUpperCase(), 4);
      continue;
    }
    if (testBlock && row.purpose !== 'voltage') put(testBlock);
    if (row.purpose === 'protection' && relay) {
      const k = protection.indexOf(row);
      if (k > 0) {
        const lane = relayX - k * 3;
        const dy = relayY - k * DCP_STEP;
        if (row.y < dy) { page.conn(70, 2, lane, row.y); page.conn(70, 0, lane, dy); }
        else { page.conn(70, 3, lane, row.y); page.conn(70, 1, lane, dy); }
      }
      continue;
    }
    if (row.purpose === 'measurement') {
      const j = measSeen++;
      const mine = j === measuring - 1 ? meters.slice(j) : meters.slice(j, j + 1);
      mine.forEach(put);
    }
    if (row.purpose === 'voltage') volts.forEach(put);
  }
  if (!rows.some(r => r.purpose === 'voltage')) volts.forEach(skipped);
  // The alarm window and lamps hang under the relay's box on its control
  // line; with no relay, beside the line's foot.
  const hangX = relayBox ? relayBox.x + 6 : 60;
  let hangY = relayBox ? relayBox.y - 12 : y;
  for (const item of others) {
    const [n, v] = EPLAN_OF[item.id]!;
    const pins = pinsOf(n, v) ?? [];
    const top = pins.find(p => p.dir === UP) ?? pins.find(p => p.dir === LEFT);
    const ins = { x: hangX - (top?.dir === UP ? top.x : 0), y: hangY - 10 - (top?.y ?? 0) };
    page.dashedPath([[hangX, hangY], [hangX, ins.y + (top?.y ?? 0)]]);
    page.device('SLD', n, v, ins.x, ins.y, [page.textXml(ins.x + 8, ins.y, labelOf(item, 16), 4, 1.6)]);
    const bottom = pins.find(p => p.dir === DOWN);
    hangY = ins.y + (bottom?.y ?? -8) - 2;
  }
  // The relay's serial link and statuses, down from the bottom of its box.
  if (relayBox && relay) {
    // Out of the box's right side, clear of what hangs under it.
    const sigs = signalList(relay);
    const out = relayBox.x + 32;
    const sy = relayBox.y - 8;
    if (sigs.length) page.dashedPath([[out, sy], [out + 4 + (sigs.length - 1) * 4, sy]]);
    sigs.forEach((t, k) => signals.push({ x: out + 4 + k * 4, from: sy, text: t.text, up: t.up }));
  }

  // ── Beside the breaker: 94 / CR / 74 / 86 ─────────────────────────────
  const boxes = (answers.breakerAttachments ?? []).map(a => String(a.text ?? a.kind ?? '').toUpperCase()).filter(Boolean);
  boxes.forEach((t, k) => {
    const by = -10 - 6 - k * 5;
    page.rect(20, by, 24, by + 4);
    page.text(22, by + 2, t, 5, 1.5);
  });
  // The upstream key interlock: down from under the boxes, to the foot.
  if (answers.upstreamInterlock) {
    signals.push({ x: 22, from: -10 - 6 - Math.max(0, boxes.length - 1) * 5,
      text: String(answers.upstreamText || 'INCOMING FEEDER'), up: answers.upstreamDir === 'up' });
  }
  // The mechanical interlock: from the switch to the earth switch and on to
  // the magnet, and the magnet's own line to the feeder below.
  // Out of the switch's operating mechanism on its left, down between the
  // magnet and the earth switch, across into both.
  // As the office's macros draw it: out of the switch's operating mechanism
  // to the left, down through the interlock's triangle, and into the earth
  // switch's side — the two change over together. Then from the earth
  // switch's contact down to the magnet.
  const spine = ES_X - 15;
  if (swMid != null && esMid != null) {
    page.dashedPath([[-4, swMid], [spine, swMid], [spine, esMid], [ES_X - 4, esMid]]);
    const mid = swMid - 8;
    page.poly([[spine - 2, mid + 4], [spine - 2, mid], [spine - 2, mid - 4], [spine + 4, mid], [spine - 2, mid + 4]]);
  }
  if (mbAt) {
    const from = esMid != null ? esMid - 6 : (swMid ?? mbAt.y + 10);
    page.dashedPath([[esMid != null ? ES_X - 4 : -4, from], [mbAt.x, from], [mbAt.x, mbAt.y + 4]]);
  }
  if (mbAt && answers.downstreamInterlock !== false) {
    signals.push({ x: mbAt.x, from: mbAt.y - 4, text: String(answers.downstreamText || 'OUTGOING FEEDER'),
      up: answers.downstreamDir === 'up' });
  }
  // The breaker's statuses: on along the interlock's line, out to the left of
  // everything, each down to the foot.
  const swSignals = sw ? signalList({ statuses: sw.statuses, sld: sw.sld }) : [];
  const swStatuses = swSignals.map(sg => sg.text);
  if (sw && swMid != null && swStatuses.length) {
    // The interlock's line carries on out to the left, just past everything
    // on that side, and each status drops from it.
    const first = page.box.l - 4;
    const lanes = swStatuses.map((_, k) => first - k * 4);
    const from = esMid != null ? spine : -4;
    page.dashedPath([[from, swMid], [lanes[lanes.length - 1], swMid]]);
    swSignals.forEach((t, k) => signals.push({ x: lanes[k], from: swMid!, text: t.text, up: t.up }));
  }
  // Every signal ends on one floor, low enough for the longest text.
  if (signals.length) {
    const len = (t: string) => t.length * 1.8 * 0.72;
    const floor = Math.min(page.box.b - 6, ...signals.map(sg => sg.from - len(sg.text) - 14));
    for (const sg of signals) {
      const t = sg.text.trim().toUpperCase();
      const mid = (sg.from + floor) / 2;
      const half = len(t) / 2 + 1.5;
      page.line(sg.x, sg.from, sg.x, mid + half, true);
      page.line(sg.x, mid - half, sg.x, floor + 2, true);
      // Down: a signal going out; up: one coming in.
      page.poly(sg.up
        ? [[sg.x - 1, floor], [sg.x, floor + 2], [sg.x + 1, floor]]
        : [[sg.x - 1, floor + 2], [sg.x, floor], [sg.x + 1, floor + 2]], true);
      page.text(sg.x, mid, t, 5, 1.8, Math.PI / 2);
    }
  }
  if (page.missing.length) {
    page.text(0, page.box.b - 6, `NOT IN THE SLD LIBRARY: ${page.missing.join(', ')}`, 1, 1.8);
  }

  const name = String(template?.name ?? 'CELL').trim() || 'CELL';
  const area = { left: 60 + page.box.l - 4, top: 280 + Math.max(page.box.t, 4), right: 60 + page.box.r + 4, bottom: 280 + page.box.b - 4 };
  return emaDocument(name, page.out, area, { x: 60, y: 280 });

  function placeRelay(p: Page, item: ChainItem, x: number, rowY: number, more: number[] = []) {
    // The office's relay: a black box, the core in at its device connection
    // point; its functions written in it. Each further core gets a connection
    // point of its own on the box, `more` mm above or below the first.
    let proto = PROTOS['SPECIAL:0:0'];
    const point = /<O130 [\s\S]*?<\/O130>/.exec(proto ?? '')?.[0];
    if (proto && point) {
      const own = /A1="(130\/\d+)"/.exec(point)?.[1] ?? '';
      const copies = more.map((dy, k) => point
        .split(own).join(`130/${990001 + k}`)
        .replace(/A762="([-\d.]+)\/([-\d.]+)"/, (_, px, py) => `A762="${px}/${num(Number(py) + dy)}"`));
      proto = proto.replace(point, [point, ...copies].join('\n'));
    }
    const fn = String(item.functions ?? '').trim() || 'PROTECTION RELAY';
    const dcp = /<O130[\s\S]*?A762="([-\d.]+)\/([-\d.]+)"/.exec(proto ?? '');
    const box = /<O17[\s\S]*?A762="([-\d.]+)\/([-\d.]+)"/.exec(proto ?? '');
    if (!proto || !dcp || !box) { skipped(item); return null; }
    const ox = Number(box[1]) - Number(dcp[1]);
    const oy = Number(box[2]) - Number(dcp[2]);
    const bx = x + ox;
    const by = rowY + oy;
    p.device('SPECIAL', 0, 0, bx, by, [
      p.textXml(bx + 16, by - 6, breakLabel(fn.replace(/\s*,\s*/g, ','), 22).join('\n'), 5, 1.8),
      p.textXml(bx, by + 2, labelOf(item, 22), 7, 1.8),
    ], proto);
    p.grow(bx + 32, by - 12);
    return { x: bx, y: by };
  }

}
