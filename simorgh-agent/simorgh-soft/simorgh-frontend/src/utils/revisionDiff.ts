// src/utils/revisionDiff.ts
//
// What changed between two revisions of a project.
//
// A revision carries a whole project as its snapshot, so comparing two
// revisions is comparing two projects: the master data, the technical
// settings, each switchgear's panel specification, its feeder lines, and the
// parts on the templates behind them.
//
// For a project that comes from TPMS, its revisions are TPMS's revisions —
// so this is also how the changes made in TPMS are read here.
import { ProjectData, DeviceTableRow, Equipment, TemplateItem } from '../types/project';
import { partsCellText, templateParts } from './tierEquipmentMatrix';
import { type Tier } from './tiers';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface FieldChange { field: string; from: string; to: string }

export interface LineChange {
  key: string;
  feederNo: string;
  description: string;
  templateName: string;
  kind: ChangeKind;
  changes: FieldChange[];
}

export interface EquipmentDiff {
  name: string;
  type: Tier;
  kind: ChangeKind;
  lines: LineChange[];
  panel: FieldChange[];
  counts: { added: number; removed: number; changed: number };
}

export interface TemplateDiff {
  name: string;
  type: Tier;
  kind: ChangeKind;
  changes: FieldChange[];
}

export interface RevisionDiff {
  project: FieldChange[];
  techSettings: FieldChange[];
  equipments: EquipmentDiff[];
  templates: TemplateDiff[];
  totals: { added: number; removed: number; changed: number };
  isEmpty: boolean;
}

const text = (v: any) => (v === null || v === undefined ? '' : String(v).trim());

// The columns of a feeder line that are worth reporting, in the order they are
// read on screen.
const LINE_FIELDS: { key: keyof DeviceTableRow; label: string }[] = [
  { key: 'templateName', label: 'Template' },
  { key: 'busSection',   label: 'Bus section' },
  { key: 'feederNo',     label: 'Feeder no.' },
  { key: 'wiringType',   label: 'Wiring type' },
  { key: 'ratingPower',  label: 'Rating power' },
  { key: 'flc',          label: 'FLC' },
  { key: 'tag',          label: 'Tag' },
  { key: 'description',  label: 'Description' },
  { key: 'moduleNo',     label: 'Module no.' },
  { key: 'size',         label: 'Size' },
  { key: 'sfdHfd',       label: 'SFD/HFD' },
  { key: 'cableSize',    label: 'Cable size' },
];

const PROJECT_FIELDS: { key: keyof ProjectData; label: string }[] = [
  { key: 'projectName',        label: 'Project name' },
  { key: 'projectId',          label: 'Project ID' },
  { key: 'projectNumber',      label: 'Project no. (OE)' },
  { key: 'projectDescription', label: 'Description' },
  { key: 'planner',            label: 'Planner' },
  { key: 'designOffice',       label: 'Design office' },
  { key: 'client',             label: 'Client' },
  { key: 'location',           label: 'Location' },
  { key: 'standard',           label: 'Standard' },
];

// A line is followed across revisions by its bus section and feeder number.
//
// A feeder number is not a key: a busbar section carries many rows under one
// number, and this office's sheets do. Keyed on the number, every row after
// the first with the same number was thrown away before it was compared, so a
// changed row could vanish from the report and an unchanged one appear as
// changed against its neighbour. Rows are paired instead — by id when the row
// kept its id, then in order among rows sharing a section and number, then in
// order among rows sharing a number — and every row is claimed once.
const norm = (v: any) => text(v).toLowerCase();

function pairRows<T>(
  a: T[], b: T[], keys: ((row: T) => string)[],
): { pairs: [T, T][]; onlyA: T[]; onlyB: T[] } {
  const leftA = new Set(a);
  const leftB = new Set(b);
  const pairs: [T, T][] = [];
  for (const keyOf of keys) {
    const queue = new Map<string, T[]>();
    for (const row of b) {
      if (!leftB.has(row)) continue;
      const k = keyOf(row);
      if (!k) continue;
      if (!queue.has(k)) queue.set(k, []);
      queue.get(k)!.push(row);
    }
    for (const row of a) {
      if (!leftA.has(row)) continue;
      const k = keyOf(row);
      const match = k ? queue.get(k)?.shift() : undefined;
      if (!match) continue;
      pairs.push([row, match]);
      leftA.delete(row);
      leftB.delete(match);
    }
  }
  return { pairs, onlyA: a.filter(r => leftA.has(r)), onlyB: b.filter(r => leftB.has(r)) };
}

const LINE_KEYS: ((row: DeviceTableRow) => string)[] = [
  row => (row.id ? `id:${row.id}` : ''),
  row => (text(row.feederNo) ? `${norm(row.busSection)}|${norm(row.feederNo)}` : ''),
  row => (text(row.feederNo) ? norm(row.feederNo) : ''),
  row => `#${row.rowNumber}`,
];

const EQUIPMENT_KEYS: ((eq: Equipment) => string)[] = [
  eq => (eq.id ? `id:${eq.id}` : ''),
  eq => `${eq.type}::${norm(eq.name)}`,
];

const TEMPLATE_KEYS: ((t: TemplateItem) => string)[] = [
  t => (t.id ? `id:${t.id}` : ''),
  t => `${t.type}::${norm(t.name)}`,
];

/** The row as it reads on screen: its template named by the template itself. */
function withTemplateName(row: DeviceTableRow, templates: Map<string, TemplateItem>): DeviceTableRow {
  const template = row.templateId ? templates.get(row.templateId) : undefined;
  return template ? { ...row, templateName: template.name } : row;
}

function fieldDiff(
  a: any, b: any, fields: { key: string; label: string }[],
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) {
    const from = text(a?.[f.key]);
    const to = text(b?.[f.key]);
    if (from !== to) out.push({ field: f.label, from, to });
  }
  return out;
}

// Technical settings are two levels deep (section → field).
function techDiff(a: any, b: any): FieldChange[] {
  const out: FieldChange[] = [];
  const sections = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const section of sections) {
    const keys = new Set([...Object.keys(a?.[section] ?? {}), ...Object.keys(b?.[section] ?? {})]);
    for (const key of keys) {
      const from = text(a?.[section]?.[key]);
      const to = text(b?.[section]?.[key]);
      if (from !== to) out.push({ field: `${section}.${key}`, from, to });
    }
  }
  return out;
}

// The panel specification behind a switchgear, as Device Library holds it.
function panelDiff(a: ProjectData, b: ProjectData, eq?: Equipment, eqB?: Equipment): FieldChange[] {
  const find = (data: ProjectData, equipment?: Equipment) => {
    if (!equipment) return undefined;
    const tier = (data.deviceLibrary?.[equipment.type] ?? []);
    const byId = equipment.properties?.deviceLibraryItemId;
    return tier.find(d => d.id === byId) ?? tier.find(d => d.name === equipment.name);
  };
  const from = find(a, eq)?.properties ?? {};
  const to = find(b, eqB ?? eq)?.properties ?? {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const out: FieldChange[] = [];
  for (const key of keys) {
    const l = text((from as any)[key]);
    const r = text((to as any)[key]);
    if (l !== r) out.push({ field: key, from: l, to: r });
  }
  return out;
}

/** Everything that differs between two project snapshots, base → target. */
export function diffProjectSnapshots(base: ProjectData, target: ProjectData): RevisionDiff {
  const project = fieldDiff(base, target, PROJECT_FIELDS as any);
  const techSettings = techDiff(base.techSettings, target.techSettings);

  // ── Switchgears and their lines ───────────────────────────────────────
  const templatesOf = (data: ProjectData) => new Map(
    Object.values(data.templates ?? {}).flat().map(t => [t.id, t as TemplateItem]));
  const baseTemplatesById = templatesOf(base);
  const targetTemplatesById = templatesOf(target);

  const eqPairing = pairRows(base.equipments ?? [], target.equipments ?? [], EQUIPMENT_KEYS);
  const eqPairs: [Equipment | undefined, Equipment | undefined][] = [
    ...eqPairing.pairs,
    ...eqPairing.onlyA.map(a => [a, undefined] as [Equipment, undefined]),
    ...eqPairing.onlyB.map(b => [undefined, b] as [undefined, Equipment]),
  ];
  const equipments: EquipmentDiff[] = [];
  const totals = { added: 0, removed: 0, changed: 0 };

  for (const [a, b] of eqPairs) {
    const eq = (b ?? a)!;
    const kind: ChangeKind = !a ? 'added' : !b ? 'removed' : 'changed';

    const aRows = (a?.devices ?? []).map(r => withTemplateName(r, baseTemplatesById));
    const bRows = (b?.devices ?? []).map(r => withTemplateName(r, targetTemplatesById));
    const linePairing = pairRows(aRows, bRows, LINE_KEYS);
    const linePairs: [DeviceTableRow | undefined, DeviceTableRow | undefined][] = [
      ...linePairing.pairs,
      ...linePairing.onlyA.map(r => [r, undefined] as [DeviceTableRow, undefined]),
      ...linePairing.onlyB.map(r => [undefined, r] as [undefined, DeviceTableRow]),
    ];
    const lines: LineChange[] = [];

    for (const [la, lb] of linePairs) {
      const lk = `${text((lb ?? la)!.busSection)}|${text((lb ?? la)!.feederNo)}|${(lb ?? la)!.rowNumber}`;
      if (la && lb) {
        const changes = fieldDiff(la, lb, LINE_FIELDS as any);
        if (changes.length > 0) {
          lines.push({
            key: lk, feederNo: text(lb.feederNo), description: text(lb.description),
            templateName: text(lb.templateName), kind: 'changed', changes,
          });
        }
      } else if (lb) {
        lines.push({
          key: lk, feederNo: text(lb.feederNo), description: text(lb.description),
          templateName: text(lb.templateName), kind: 'added',
          changes: LINE_FIELDS
            .map(f => ({ field: f.label, from: '', to: text((lb as any)[f.key]) }))
            .filter(c => c.to !== ''),
        });
      } else if (la) {
        lines.push({
          key: lk, feederNo: text(la.feederNo), description: text(la.description),
          templateName: text(la.templateName), kind: 'removed',
          changes: LINE_FIELDS
            .map(f => ({ field: f.label, from: text((la as any)[f.key]), to: '' }))
            .filter(c => c.from !== ''),
        });
      }
    }

    lines.sort((x, y) => x.feederNo.localeCompare(y.feederNo, undefined, { numeric: true }));
    const panelRenamed = a && b && text(a.name) !== text(b.name)
      ? [{ field: 'Name', from: text(a.name), to: text(b.name) }] : [];
    const panel = a && b ? [...panelRenamed, ...panelDiff(base, target, a, b)] : [];
    const counts = {
      added: lines.filter(l => l.kind === 'added').length,
      removed: lines.filter(l => l.kind === 'removed').length,
      changed: lines.filter(l => l.kind === 'changed').length,
    };

    if (kind !== 'changed' || lines.length > 0 || panel.length > 0) {
      equipments.push({ name: eq.name, type: eq.type, kind, lines, panel, counts });
      totals.added += counts.added + (kind === 'added' ? 1 : 0);
      totals.removed += counts.removed + (kind === 'removed' ? 1 : 0);
      totals.changed += counts.changed + (panel.length > 0 ? 1 : 0);
    }
  }

  equipments.sort((a, b) => a.name.localeCompare(b.name));

  // ── Templates: what a template puts on a line ─────────────────────────
  const tPairing = pairRows(
    [...baseTemplatesById.values()], [...targetTemplatesById.values()], TEMPLATE_KEYS);
  const tPairs: [TemplateItem | undefined, TemplateItem | undefined][] = [
    ...tPairing.pairs,
    ...tPairing.onlyA.map(t => [t, undefined] as [TemplateItem, undefined]),
    ...tPairing.onlyB.map(t => [undefined, t] as [undefined, TemplateItem]),
  ];
  const templates: TemplateDiff[] = [];

  for (const [a, b] of tPairs) {
    const t = (b ?? a)!;
    const aParts = a ? templateParts(a) : {};
    const bParts = b ? templateParts(b) : {};
    const props = new Set([...Object.keys(aParts), ...Object.keys(bParts)]);
    const changes: FieldChange[] = [];
    for (const prop of props) {
      const from = partsCellText(aParts[prop] ?? [], ' + ');
      const to = partsCellText(bParts[prop] ?? [], ' + ');
      if (from !== to) changes.push({ field: prop, from, to });
    }
    const kind: ChangeKind = !a ? 'added' : !b ? 'removed' : 'changed';
    if (a && b && text(a.name) !== text(b.name)) {
      changes.unshift({ field: 'Name', from: text(a.name), to: text(b.name) });
    }
    if (kind !== 'changed' || changes.length > 0) {
      templates.push({ name: t.name, type: t.type, kind, changes });
      if (kind === 'added') totals.added += 1;
      else if (kind === 'removed') totals.removed += 1;
      else totals.changed += 1;
    }
  }

  templates.sort((a, b) => a.name.localeCompare(b.name));
  totals.changed += project.length + techSettings.length;

  return {
    project, techSettings, equipments, templates, totals,
    isEmpty: project.length === 0 && techSettings.length === 0 &&
             equipments.length === 0 && templates.length === 0,
  };
}

/** The comparison as rows for a spreadsheet. */
export function buildDiffRows(
  diff: RevisionDiff,
  meta: { projectName: string; base: string; target: string },
): (string | number)[][] {
  const rows: (string | number)[][] = [];
  rows.push([`${meta.projectName} — REV ${meta.base} → REV ${meta.target}`]);
  rows.push([`Generated ${new Date().toLocaleString()}`]);
  rows.push([
    `${diff.totals.added} added`, `${diff.totals.removed} removed`, `${diff.totals.changed} changed`,
  ]);
  rows.push([]);
  rows.push(['SECTION', 'ITEM', 'CHANGE', 'FIELD', `REV ${meta.base}`, `REV ${meta.target}`]);

  for (const c of diff.project) rows.push(['Project', 'Master data', 'changed', c.field, c.from, c.to]);
  for (const c of diff.techSettings) rows.push(['Project', 'Technical settings', 'changed', c.field, c.from, c.to]);

  for (const eq of diff.equipments) {
    if (eq.kind !== 'changed') {
      rows.push(['Switchgear', `${eq.name} (${eq.type})`, eq.kind, '', '', '']);
    }
    for (const c of eq.panel) {
      rows.push(['Panel spec', `${eq.name} (${eq.type})`, 'changed', c.field, c.from, c.to]);
    }
    for (const line of eq.lines) {
      const item = `${eq.name} · ${line.feederNo || line.key}`;
      if (line.changes.length === 0) {
        rows.push(['Line', item, line.kind, '', '', '']);
        continue;
      }
      for (const c of line.changes) rows.push(['Line', item, line.kind, c.field, c.from, c.to]);
    }
  }

  for (const t of diff.templates) {
    if (t.changes.length === 0) {
      rows.push(['Template', `${t.name} (${t.type})`, t.kind, '', '', '']);
      continue;
    }
    for (const c of t.changes) rows.push(['Template', `${t.name} (${t.type})`, t.kind, c.field, c.from, c.to]);
  }

  if (diff.isEmpty) rows.push(['—', 'No differences', '', '', '', '']);
  return rows;
}
