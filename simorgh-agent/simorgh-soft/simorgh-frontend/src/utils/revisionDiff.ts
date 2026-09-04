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
  type: 'LV' | 'MV' | 'HV';
  kind: ChangeKind;
  lines: LineChange[];
  panel: FieldChange[];
  counts: { added: number; removed: number; changed: number };
}

export interface TemplateDiff {
  name: string;
  type: 'LV' | 'MV' | 'HV';
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

// A line is followed across revisions by its feeder number; a line without one
// is followed by its position, which is the best that can be done.
const lineKey = (row: DeviceTableRow) =>
  text(row.feederNo) ? `F:${text(row.feederNo).toLowerCase()}` : `#${row.rowNumber}`;

const equipmentKey = (eq: Equipment) => `${eq.type}::${text(eq.name).toLowerCase()}`;
const templateKey = (t: TemplateItem) => `${t.type}::${text(t.name).toLowerCase()}`;

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
  const baseEqs = new Map((base.equipments ?? []).map(e => [equipmentKey(e), e]));
  const targetEqs = new Map((target.equipments ?? []).map(e => [equipmentKey(e), e]));
  const equipments: EquipmentDiff[] = [];
  const totals = { added: 0, removed: 0, changed: 0 };

  for (const key of new Set([...baseEqs.keys(), ...targetEqs.keys()])) {
    const a = baseEqs.get(key);
    const b = targetEqs.get(key);
    const eq = (b ?? a)!;
    const kind: ChangeKind = !a ? 'added' : !b ? 'removed' : 'changed';

    const aLines = new Map((a?.devices ?? []).map(r => [lineKey(r), r]));
    const bLines = new Map((b?.devices ?? []).map(r => [lineKey(r), r]));
    const lines: LineChange[] = [];

    for (const lk of new Set([...aLines.keys(), ...bLines.keys()])) {
      const la = aLines.get(lk);
      const lb = bLines.get(lk);
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
    const panel = a && b ? panelDiff(base, target, a, b) : [];
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
  const allTemplates = (data: ProjectData) => [
    ...(data.templates?.LV ?? []), ...(data.templates?.MV ?? []), ...(data.templates?.HV ?? []),
  ];
  const baseTemplates = new Map(allTemplates(base).map(t => [templateKey(t), t]));
  const targetTemplates = new Map(allTemplates(target).map(t => [templateKey(t), t]));
  const templates: TemplateDiff[] = [];

  for (const key of new Set([...baseTemplates.keys(), ...targetTemplates.keys()])) {
    const a = baseTemplates.get(key);
    const b = targetTemplates.get(key);
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
