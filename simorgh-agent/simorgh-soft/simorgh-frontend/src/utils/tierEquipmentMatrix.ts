// src/utils/tierEquipmentMatrix.ts
//
// Shared LV/MV "equipment × template property" matrix builder, used by both
// OutputTypesTab.tsx (report/export) and DeviceSelectionTab.tsx (the
// "Template Items" preview panel) so both stay in sync.
import { ProjectData } from '../types/project';

// ─── Per-tier template property lists (must mirror TemplateProperties.tsx) ───
export const LV_TEMPLATE_PROPERTIES = [
  'CB ORDER', 'ACCESSORY', 'CONTACTOR. ORDER', 'OVER LOAD RELAY',
  'EARTH FAULT', 'COREBALANCE CT', 'PROTECTION RELAY', 'CT RATING',
  'AMMETER', 'AMMETER selector', 'PT RATING', 'VOLTMETER',
  'VOLTMETER selector', 'MULTIMETER', 'TEST BLOCK', 'TRANSDUSER',
  'ALARM ANUNCIATOR',
  'SPARE 1', 'SPARE 2', 'SPARE 3', 'SPARE 4', 'SPARE 5', 'SPARE 6', 'SPARE 7',
];
export const MV_TEMPLATE_PROPERTIES = [
  'VCB OR VC/FUSE', 'ACCESSORY', 'VOLTAGE INDICATOR', 'COREBALANCE CT',
  'PROTECTION RELAY', 'CT RATING', 'AMMETER', 'AMMETER selector',
  'PT RATING', 'VOLTMETER', 'VOLTMETER selector', 'MULTIMETER',
  'TEST BLOCK', 'TRANSDUSER', 'ALARM WINDDOW', 'SURGE ARRESTER',
  'SPARE 1', 'SPARE 2', 'SPARE 3', 'SPARE 4', 'SPARE 5',
];
export const HV_TEMPLATE_PROPERTIES = [
  'BREAKER TYPE', 'NOMINAL VOLTAGE', 'NOMINAL CURRENT',
  'SHORT CIRCUIT CURRENT', 'PROTECTION RELAY', 'INSULATION LEVEL',
];

// Per-tier "device row identifier" columns (left side of the wide table).
// LV-only columns (SIZE, SFD/HFD, MODULE NO.) are absent in MV.
export interface DeviceColSpec { key: string; header: string; }
export const LV_DEVICE_COLS: DeviceColSpec[] = [
  { key: 'rowNumber',    header: 'ORDER NO.' },
  { key: 'templateName', header: 'TEMPLATE' },
  { key: 'size',         header: 'SIZE' },
  { key: 'sfdHfd',       header: 'SFD/HFD' },
  { key: 'cableSize',    header: 'CABLE SIZE' },
  { key: 'wiringType',   header: 'WIRING TYPE' },
  { key: 'ratingPower',  header: 'RATING POWER (kW/KVA)' },
  { key: 'flc',          header: 'FLC (A)' },
  { key: 'feederNo',     header: 'FEEDER NO.' },
  { key: 'busSection',   header: 'BUS SECTION' },
  { key: 'moduleNo',     header: 'MODULE NO.' },
  { key: 'tag',          header: 'TAG' },
  { key: 'description',  header: 'DESCRIPTION' },
];
export const MV_DEVICE_COLS: DeviceColSpec[] = [
  { key: 'rowNumber',    header: 'ORDER NO.' },
  { key: 'templateName', header: 'TEMPLATE' },
  { key: 'cableSize',    header: 'CABLE SIZE' },
  { key: 'wiringType',   header: 'WIRING TYPE' },
  { key: 'ratingPower',  header: 'RATING POWER (kW/KVA)' },
  { key: 'flc',          header: 'FLC (A)' },
  { key: 'feederNo',     header: 'FEEDER NO.' },
  { key: 'busSection',   header: 'BUS SECTION' },
  { key: 'tag',          header: 'TAG' },
  { key: 'description',  header: 'DESCRIPTION' },
];

// EPLAN keeps multilingual text as locale-tagged runs — "en_US@Motor@de_DE@…@"
// — and those tags leak straight into exports as literal "en_US@" prefixes.
// Take the English run when there is one, otherwise the first run, and fall
// back to stripping the tags out of whatever is left.
const LOCALE_RUN = /([a-z]{2}_[A-Z]{2})@([^@]*)@?/g;
export function stripLocaleTags(raw: any): string {
  const value = raw == null ? '' : String(raw);
  if (!/[a-z]{2}_[A-Z]{2}@/.test(value)) return value.trim();

  const runs: Record<string, string> = {};
  let first = '';
  let match: RegExpExecArray | null;
  LOCALE_RUN.lastIndex = 0;
  while ((match = LOCALE_RUN.exec(value)) !== null) {
    const text = match[2].trim();
    if (!runs[match[1]]) runs[match[1]] = text;
    if (!first && text) first = text;
  }
  return (
    runs['en_US'] ||
    first ||
    value.replace(/[a-z]{2}_[A-Z]{2}@/g, '').replace(/@/g, ' ').trim()
  );
}

// The "eplanix" value for a part: Order Number unless it's blank/'-'/'_',
// in which case it falls back to Designation 3. Mirrors the Eplanix cell in
// TemplateProperties.tsx (Create Template) so every place that shows this
// value derives it the same way.
export function getEplanixValue(fullData: any): string {
  const order = stripLocaleTags(fullData?.OrderNumber);
  if (order && order !== '-' && order !== '_') return order;
  return stripLocaleTags(fullData?.Designation3);
}

// One part's display text: "label:eplanixValue", falling back to just the
// label (or just the eplanix value) when the other side is empty. "xN" is
// appended only when quantity is greater than 1.
export function formatPartEntry(part: any): string {
  const label = stripLocaleTags(part?.label);
  const eplanix = getEplanixValue(part?.fullData);
  const base = label && eplanix ? `${label}:${eplanix}` : (label || eplanix);
  const q = part?.quantity ?? 1;
  return q > 1 ? `${base} x${q}` : base;
}

// Compose the multi-line text for one Property cell across export/preview
// targets. Multiple parts under the same property are stacked one per line
// with no filler between them, so a cell holding several codes reads as a
// simple vertical list (e.g. "Q:3RT2016-1BB41" above "Q:3RV2321-4EC10").
export function partsCellText(parts: any[], separator = '\n'): string {
  if (!parts || parts.length === 0) return '';
  return parts.map(p => formatPartEntry(p)).join(separator);
}

// Build {propKey → parts[]} for a single template, ignoring metadata keys.
export function templateParts(template: any): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  const props = (template?.properties ?? {}) as Record<string, any>;
  for (const [k, val] of Object.entries(props)) {
    if (k === '__displayNames' || k === '__locked') continue;
    if (val && Array.isArray((val as any).parts) && (val as any).parts.length > 0) {
      out[k] = (val as any).parts;
    }
  }
  return out;
}

// Flatten LV/MV equipment + device rows into a 2-D array for Excel + table
// rendering. The number of columns is fixed; cells without a matching
// template property come out empty.
export function buildTierMatrix(
  data: ProjectData,
  tier: 'LV' | 'MV'
): { headers: string[]; rows: (string | number)[][] } {
  const deviceCols = tier === 'LV' ? LV_DEVICE_COLS : MV_DEVICE_COLS;
  const propCols   = tier === 'LV' ? LV_TEMPLATE_PROPERTIES : MV_TEMPLATE_PROPERTIES;
  const headers = ['EQUIPMENT', ...deviceCols.map(c => c.header), ...propCols];

  const tierTemplates = (data.templates?.[tier] ?? []);
  const tmplById = new Map(tierTemplates.map(t => [t.id, t]));

  const rows: (string | number)[][] = [];
  const eqs = (data.equipments ?? []).filter(e => e.type === tier);
  for (const eq of eqs) {
    const devices = eq.devices ?? [];
    if (devices.length === 0) {
      rows.push([eq.name, ...deviceCols.map(() => ''), ...propCols.map(() => '')]);
      continue;
    }
    devices.forEach((row, ri) => {
      const tmpl  = row.templateId ? tmplById.get(row.templateId) : undefined;
      const parts = tmpl ? templateParts(tmpl) : {};
      const baseValues = deviceCols.map(c => {
        const raw = (row as any)[c.key];
        return raw == null ? '' : String(raw);
      });
      const propValues = propCols.map(p => partsCellText(parts[p] || []));
      rows.push([
        ri === 0 ? eq.name : '',
        ...baseValues,
        ...propValues,
      ]);
    });
  }
  return { headers, rows };
}
