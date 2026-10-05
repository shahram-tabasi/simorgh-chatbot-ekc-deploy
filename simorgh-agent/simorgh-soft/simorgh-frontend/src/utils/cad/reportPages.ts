// src/utils/cad/reportPages.ts
//
// The drawing set's reports, as pages of the set — after EPLAN's.
//
// EPLAN keeps its reports as graphical pages the project fills: a title page,
// a table of contents, the device and parts lists, the terminal diagrams, the
// connection list, the PLC overviews. They are worked out from the project, not
// drawn, and they are worked out again whenever they are generated, so the
// terminal diagram in the PDF is always the terminal diagram of the drawing
// that went with it. This does the same: each report is one or more A3 pages
// with the frame and the title block — signatures and logo included — and its
// list drawn as a table of real geometry, so it goes to the PDF and the SVG
// like any other page.
//
// The lists themselves are the ones `drawingReports` already reads off the
// pages (connections, terminals, devices, I/O); the parts list and the cable
// list are read off the project's device rows and templates, which is where
// a part and a cable size are kept. Nothing is invented: an empty report is a
// page that says it has nothing to list.
//
// The layout is our own — a heading, a ruled table, page n of m — and the
// title block is the one every page of the set carries (`cad/header`).

import { Drawing, Shape } from './shapes';
import { HeaderFields, drawingAreas, sheetHeader } from './header';
import { tableShapes } from './table';
import {
  ReportPage, connectionRows, deviceRows, ioRows, terminalRows,
} from './drawingReports';
import { ProjectData, ReportKind, Revision, TitleBlockSettings } from '../../types/project';
import { TIERS } from '../tiers';
import {
  LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, getEplanixValue, stripLocaleTags,
} from '../tierEquipmentMatrix';
import { templatePartsInOrder } from '../bpmsExport';

/** A3 landscape, in millimetres — reports are drawn one unit to the millimetre. */
const W = 420;
const H = 297;
const STYLE = { mmPerUnit: 1 };
/** Text in the tables, and the row it sits in. */
const TEXT = 2.6;
const ROW = 6;

export const REPORT_TITLES: Record<ReportKind, string> = {
  title: 'Title page',
  toc: 'Table of contents',
  devices: 'Scope tag list',
  parts: 'Summarized parts list',
  terminals: 'Terminal diagram',
  strips: 'Terminal strip overview',
  connections: 'Connection list',
  plc: 'PLC diagram',
  plcCards: 'PLC card overview',
  cables: 'Cable overview',
  revisions: 'Revision overview',
};

/** The order a set's reports come in, whichever were asked for. */
export const REPORT_ORDER: ReportKind[] = [
  'title', 'toc', 'devices', 'parts', 'terminals', 'strips',
  'connections', 'plc', 'plcCards', 'cables', 'revisions',
];

/** A page the set holds — drawn by hand — as the reports read it. */
export interface SetPage extends ReportPage {
  description?: string;
  type?: string;
}

export interface ReportSheet {
  kind: ReportKind;
  /** "Terminal diagram 2/3". */
  name: string;
  drawing: Drawing;
}

interface Table {
  /** Column headings. */
  head: string[];
  /** Share of the table's width each column takes. */
  widths: number[];
  rows: string[][];
}

const text = (v: unknown) => (v == null ? '' : String(v));

// ── The tables ──────────────────────────────────────────────────────────────

function partsTable(project: ProjectData): Table {
  const templates = new Map(TIERS.flatMap(t => project.templates?.[t] ?? []).map(t => [t.id, t]));
  const byPart = new Map<string, { order: string; what: string; spec: string; maker: string; qty: number; where: Set<string> }>();
  for (const eq of project.equipments ?? []) {
    const props = eq.type === 'MV' || eq.type === 'GIS' ? MV_TEMPLATE_PROPERTIES : LV_TEMPLATE_PROPERTIES;
    for (const row of eq.devices ?? []) {
      for (const part of templatePartsInOrder(templates.get(row.templateId), props)) {
        const d = part?.fullData ?? {};
        const order = text(getEplanixValue(d) || part?.partNumber).trim();
        if (!order) continue;
        const key = order.toUpperCase();
        const was = byPart.get(key) ?? {
          order,
          what: stripLocaleTags(d.Designation1) || text(part?.label),
          spec: stripLocaleTags(d.Designation2),
          maker: stripLocaleTags(d.Manufacturer),
          qty: 0,
          where: new Set<string>(),
        };
        was.qty += Number(part?.quantity) > 0 ? Number(part.quantity) : 1;
        was.where.add(eq.name);
        byPart.set(key, was);
      }
    }
  }
  const rows = [...byPart.values()]
    .sort((a, b) => a.maker.localeCompare(b.maker) || a.order.localeCompare(b.order, undefined, { numeric: true }))
    .map((p, i) => [String(i + 1), p.order, p.what, p.spec, p.maker, String(p.qty), [...p.where].join(', ')]);
  return {
    head: ['No.', 'Order number', 'Designation', 'Specification', 'Manufacturer', 'Qty', 'Used in'],
    widths: [0.04, 0.16, 0.2, 0.22, 0.12, 0.05, 0.21],
    rows,
  };
}

function cablesTable(project: ProjectData): Table {
  const rows: string[][] = [];
  for (const eq of project.equipments ?? []) {
    for (const row of eq.devices ?? []) {
      const size = text(row.cableSize).trim();
      if (!size) continue;
      rows.push([
        String(rows.length + 1), eq.name, text(row.feederNo), text(row.tag),
        text(row.description).replace(/\s+/g, ' ').trim(), size,
      ]);
    }
  }
  return {
    head: ['No.', 'Switchgear', 'Feeder', 'Tag', 'Description', 'Cable'],
    widths: [0.05, 0.2, 0.1, 0.15, 0.32, 0.18],
    rows,
  };
}

function revisionsTable(revisions: Revision[]): Table {
  return {
    head: ['Rev', 'Name', 'Description', 'By', 'Date'],
    widths: [0.06, 0.2, 0.46, 0.14, 0.14],
    rows: [...revisions]
      .sort((a, b) => Number(a.revisionNumber) - Number(b.revisionNumber))
      .map(r => [
        text(r.revisionNumber), text(r.revisionName), text(r.description),
        text(r.createdBy), text(r.createdOn).slice(0, 10),
      ]),
  };
}

function tableFor(kind: ReportKind, pages: SetPage[], project: ProjectData, revisions: Revision[]): Table | null {
  switch (kind) {
    case 'devices': return {
      head: ['Scope tag', 'What it is', 'Connection points', 'Page'],
      widths: [0.16, 0.38, 0.3, 0.16],
      rows: deviceRows(pages).map(r => [r.tag, r.what, r.pins, r.page]),
    };
    case 'parts': return partsTable(project);
    case 'terminals': return {
      head: ['Strip', 'Terminal', 'Upper side', 'Lower side', 'Page'],
      widths: [0.12, 0.1, 0.31, 0.31, 0.16],
      rows: terminalRows(pages).map(r => [r.strip, r.terminal, r.upper, r.lower, r.page]),
    };
    case 'strips': {
      const by = new Map<string, { count: number; pages: Set<string> }>();
      for (const r of terminalRows(pages)) {
        const e = by.get(r.strip) ?? { count: 0, pages: new Set<string>() };
        e.count += 1; e.pages.add(r.page);
        by.set(r.strip, e);
      }
      return {
        head: ['Strip', 'Terminals', 'Pages'],
        widths: [0.25, 0.15, 0.6],
        rows: [...by.entries()].map(([strip, e]) => [strip, String(e.count), [...e.pages].join(', ')]),
      };
    }
    case 'connections': return {
      head: ['No.', 'From', 'To', 'Page'],
      widths: [0.06, 0.36, 0.36, 0.22],
      rows: connectionRows(pages).map((r, i) => [String(i + 1), r.from, r.to, r.page]),
    };
    case 'plc': return {
      head: ['Address', 'Kind', 'Card', 'Terminal', 'Scope', 'Page'],
      widths: [0.12, 0.08, 0.16, 0.12, 0.34, 0.18],
      rows: ioRows(pages).map(r => [r.address, r.kind, r.card, r.terminal, r.device, r.page]),
    };
    case 'plcCards': {
      const by = new Map<string, { di: number; do: number; other: number; pages: Set<string> }>();
      for (const r of ioRows(pages)) {
        const e = by.get(r.card) ?? { di: 0, do: 0, other: 0, pages: new Set<string>() };
        if (r.kind === 'DI') e.di += 1; else if (r.kind === 'DO') e.do += 1; else e.other += 1;
        e.pages.add(r.page);
        by.set(r.card, e);
      }
      return {
        head: ['Card', 'DI', 'DO', 'Other', 'Pages'],
        widths: [0.25, 0.08, 0.08, 0.08, 0.51],
        rows: [...by.entries()].map(([card, e]) => [card, String(e.di), String(e.do), String(e.other), [...e.pages].join(', ')]),
      };
    }
    case 'cables': return cablesTable(project);
    case 'revisions': return revisionsTable(revisions);
    default: return null;
  }
}

// ── Pages ───────────────────────────────────────────────────────────────────

function fieldsOf(
  title: string, project: ProjectData, signoff: TitleBlockSettings | undefined, sheet: string,
): HeaderFields {
  return {
    title,
    project: project.projectName ?? '',
    number: project.projectNumber ? `OE ${project.projectNumber}` : '',
    revision: '',
    sheet,
    size: 'A3',
    scale: 'NTS',
    date: new Date().toISOString().slice(0, 10),
    ...(signoff?.drawn?.name ? { drawnBy: signoff.drawn.name } : {}),
    ...(signoff?.drawn?.sign ? { drawnSign: signoff.drawn.sign } : {}),
    ...(signoff?.checked?.name ? { checkedBy: signoff.checked.name } : {}),
    ...(signoff?.checked?.sign ? { checkedSign: signoff.checked.sign } : {}),
    ...(signoff?.approved?.name ? { approvedBy: signoff.approved.name } : {}),
    ...(signoff?.approved?.sign ? { approvedSign: signoff.approved.sign } : {}),
    ...(signoff?.company ? { owner: signoff.company } : {}),
    ...(signoff?.logo ? { logo: signoff.logo } : {}),
  };
}

/** The area under the heading a table may use, on a page with this title block. */
function area(fields: HeaderFields) {
  const a = drawingAreas(W, H, fields, STYLE)[0];
  return a ?? { x: 10, y: 10, w: W - 20, h: H - 60 };
}

function tablePages(
  kind: ReportKind, table: Table, project: ProjectData, signoff: TitleBlockSettings | undefined,
): Shape[][] {
  const probe = area(fieldsOf('', project, signoff, ''));
  const headingH = 12;
  const perPage = Math.max(1, Math.floor((probe.h - headingH) / ROW) - 1);
  const rows = table.rows.length ? table.rows : [['(nothing to list)']];
  const chunks: string[][][] = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  return chunks.map((chunk, n) => {
    const a = probe;
    const out: Shape[] = [];
    out.push({
      t: 'text', x: a.x, y: a.y + 6, s: REPORT_TITLES[kind], size: 5, bold: true, layer: 'TITLE',
    });
    out.push({
      t: 'text', x: a.x + a.w, y: a.y + 6, s: `${n + 1} / ${chunks.length}`, size: 3, anchor: 'end', layer: 'TITLE',
    });
    const widths = table.widths.map(f => f * a.w);
    out.push(...tableShapes([table.head, ...chunk.map(r => r.map((c, i) => fit(c, widthOf(widths, i))))],
      [a.x, a.y + headingH], { textSize: TEXT, width: 0.25, rowHeight: ROW, columnWidths: widths, header: true },
      `report-${kind}-${n + 1}`));
    return out;
  });
}

const widthOf = (widths: number[], i: number) => widths[Math.max(0, i)] ?? widths[widths.length - 1];
/** Clipped to the cell, so a long description does not write over the next column. */
function fit(value: string, width: number): string {
  const max = Math.max(2, Math.floor((width - TEXT) / (TEXT * 0.62)));
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function titlePage(project: ProjectData, signoff: TitleBlockSettings | undefined, pages: number): Shape[] {
  const a = area(fieldsOf('', project, signoff, ''));
  const out: Shape[] = [];
  const cx = a.x + a.w / 2;
  if (signoff?.logo) {
    out.push({ t: 'image', x: cx - 40, y: a.y + 10, w: 80, h: 40, href: signoff.logo, layer: 'TITLE' });
  }
  const lines: [string, number, boolean][] = [
    [project.projectName || 'Project', 10, true],
    [project.projectNumber ? `OE ${project.projectNumber}` : '', 5, false],
    [project.projectDescription ?? '', 4, false],
    [[project.client, project.location].filter(Boolean).join(' · '), 4, false],
    [signoff?.company ?? '', 4.5, true],
    [`${pages} pages · ${new Date().toISOString().slice(0, 10)}`, 3.2, false],
  ];
  let y = a.y + 75;
  for (const [s, size, bold] of lines) {
    if (!s) continue;
    out.push({ t: 'text', x: cx, y, s, size, bold, anchor: 'middle', layer: 'TITLE' });
    y += size * 2.2;
  }
  return out;
}

/**
 * Every report asked for, as pages, numbered on from the set's own pages.
 *
 * The table of contents is made last, once every other report knows how many
 * pages it took, and lists the set's pages first and the reports after them —
 * the order they are printed in.
 */
export function buildReportSheets(
  kinds: ReportKind[],
  pages: SetPage[],
  project: ProjectData,
  revisions: Revision[],
  signoff?: TitleBlockSettings,
): ReportSheet[] {
  const wanted = REPORT_ORDER.filter(k => kinds.includes(k));
  const bodies = new Map<ReportKind, Shape[][]>();
  for (const kind of wanted) {
    if (kind === 'title' || kind === 'toc') continue;
    const table = tableFor(kind, pages, project, revisions);
    if (table) bodies.set(kind, tablePages(kind, table, project, signoff));
  }

  // How many pages each report takes, the table of contents included — which
  // depends on how many entries it lists, so it is counted against the rest.
  const countOthers = wanted.reduce((n, k) => n + (k === 'toc' ? 0 : k === 'title' ? 1 : bodies.get(k)!.length), 0);
  const probe = area(fieldsOf('', project, signoff, ''));
  const tocPer = Math.max(1, Math.floor((probe.h - 12) / ROW) - 1);
  let tocCount = 0;
  if (wanted.includes('toc')) {
    tocCount = 1;
    while (Math.ceil((pages.length + countOthers + tocCount) / tocPer) > tocCount) tocCount += 1;
  }
  const total = pages.length + countOthers + tocCount;

  // Page numbers, in printed order: the set's pages, then the reports.
  const entries: string[][] = pages.map((p, i) => [String(i + 1), p.name, p.description ?? '', (p.type ?? '').toUpperCase()]);
  let next = pages.length + 1;
  const numbered: { kind: ReportKind; body: Shape[]; name: string; no: number }[] = [];
  for (const kind of wanted) {
    const body = kind === 'title' ? [titlePage(project, signoff, total)]
      : kind === 'toc' ? new Array(tocCount).fill([]) as Shape[][]
      : bodies.get(kind)!;
    body.forEach((b, i) => {
      const name = body.length > 1 ? `${REPORT_TITLES[kind]} ${i + 1}/${body.length}` : REPORT_TITLES[kind];
      numbered.push({ kind, body: b, name, no: next });
      entries.push([String(next), name, 'Report', '']);
      next += 1;
    });
  }
  if (wanted.includes('toc')) {
    const toc = tablePages('toc', {
      head: ['Page', 'Name', 'Description', 'Type'], widths: [0.08, 0.36, 0.44, 0.12], rows: entries,
    }, project, signoff);
    let t = 0;
    for (const n of numbered) if (n.kind === 'toc') n.body = toc[t++] ?? [];
  }

  return numbered.map(n => {
    const d = new Drawing(W, H, n.name);
    for (const s of sheetHeader(W, H, fieldsOf(n.name, project, signoff, `${n.no} / ${total}`), STYLE)) d.add(s);
    for (const s of n.body) d.add(s);
    return { kind: n.kind, name: n.name, drawing: d };
  });
}
