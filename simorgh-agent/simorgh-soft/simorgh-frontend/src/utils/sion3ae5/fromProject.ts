// src/utils/sion3ae5/fromProject.ts
//
// The breaker specification, written from what the project already says.
//
// A MV scope carries its ratings in its specification (Scope Library): rated
// voltage, short-circuit current, busbar current, control and motor voltages,
// frequency. A feeder of that scope may carry its breaker as a template part,
// whose designation says "1250A, 12KV, 25KA/3 Sec". This writes all of it as
// the English sentence the 3AE5 builder reads — so the engineer starts from a
// decoded code rather than a blank page, and can still edit the text.
//
// What is a guess rather than a reading is said so: the busbar current stands
// in for the breaker current only until a feeder says otherwise, and a rating
// raised to the next catalog step is marked to confirm.
import type { DeviceLibraryItem, ProjectData, DeviceTableRow } from '../../types/project';
import { stripLocaleTags } from '../tierEquipmentMatrix';
import { TIERS } from '../tiers';
import { decode, type SionState } from './engine';
import { worldPanel, type WorldPanel, type PanelKind } from './simoprimeWorld';
import { cellRole, cellCurrent, HAS_BREAKER, type CellRole, type CellCurrent } from './cells';

const KV_STEPS = [7.2, 12, 17.5, 24];
const KA_STEPS = [16, 20, 25, 31.5, 40];

const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
/** The next catalog step at or above a value. */
const stepUp = (v: number, steps: number[]) => steps.find(s => s >= v - 1e-9) ?? null;

/** "110VDC", "110 V DC", "DC 110V" → "110V DC". */
function controlVoltage(v: unknown): string | null {
  const t = String(v ?? '').toUpperCase();
  const m = t.match(/(\d{2,3})\s*V?\s*(AC|DC)/) || t.match(/(AC|DC)\s*(\d{2,3})/);
  if (!m) return null;
  const [n, kind] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  return `${n}V ${kind}`;
}

/** The AIS family a MV scope is filed under, as the Scope Library reads it. */
export function scopeFamily(item: DeviceLibraryItem, switchgearType = ''): string | null {
  if (item.family) return item.family;
  const text = `${switchgearType} ${item.name}`.toUpperCase();
  if (/EK\s*-?\s*36/.test(text)) return 'EK36';
  if (/SIMOPRIME\s*-?\s*A4|\bA4\b/.test(text)) return 'SIMOPRIME-A4';
  if (/SIMOPRIME|WORLD/.test(text)) return 'SIMOPRIME-WORLD';
  return null;
}

/** The equipment (switchgear) a library scope stands for, if there is one. */
export function equipmentOf(data: ProjectData, item: DeviceLibraryItem) {
  return (data.equipments ?? []).find(eq =>
    eq.properties?.deviceLibraryItemId === item.id ||
    (item.tpmsScopeId != null && (eq.properties?.tpms as any)?.scopeId === item.tpmsScopeId));
}

/** What a feeder's breaker part says about itself, if its template has one. */
export function feederBreakerText(data: ProjectData, row: DeviceTableRow): string {
  if (!row.templateId) return '';
  const template = TIERS.flatMap(t => data.templates?.[t] ?? []).find(t => t.id === row.templateId);
  const props = (template?.properties ?? {}) as Record<string, any>;
  const parts: any[] = [
    ...(props['VCB OR VC/FUSE']?.parts ?? []),
    ...(props['BREAKER TYPE']?.parts ?? []),
  ];
  return parts.map(p => {
    const d = p?.fullData ?? {};
    return [p?.label, stripLocaleTags(d.Designation1), stripLocaleTags(d.Designation2), stripLocaleTags(d.Designation3)]
      .filter(Boolean).join(', ');
  }).filter(Boolean).join('; ');
}

export interface DraftSpec {
  text: string;
  /** Fields the text states as a guess, to be confirmed. */
  assumed: string[];
  /** Where each value came from, for the engineer. */
  notes: string[];
  /** The panel whose catalogue narrows the breaker ('SIMOPRIME-WORLD'). */
  panel: string | null;
  /** SIMOPRIME World: the cell's panel and breaker, from the design catalogue. */
  world?: WorldPanel;
}

/** The current a feeder has to carry: its FLC, else its breaker part's rating. */
export function feederCurrent(data: ProjectData, row: DeviceTableRow): number | null {
  const flc = num(row.flc);
  if (flc != null && flc > 0) return flc;
  const m = feederBreakerText(data, row).toUpperCase().match(/(\d{3,4})\s*A\b/);
  return m ? +m[1] : null;
}

/** The scope's rated voltage and short-circuit current, raised to catalogue steps. */
export function scopeRatings(data: ProjectData, item: DeviceLibraryItem): { kv: number | null; ka: number | null } {
  const p = (item.properties ?? {}) as Record<string, unknown>;
  let kv = num(p.ratedInsulationVoltage) ?? num(p.serviceVoltage) ?? num(data.technicalSettings?.mediumVoltage?.nominalVoltage);
  if (kv != null && kv > 100) kv /= 1000;
  const ka = num(p.isc) ?? num(p.ratedShortTimeWithstandCurrent);
  return { kv: kv != null ? stepUp(kv, KV_STEPS) : null, ka: ka != null ? stepUp(ka, KA_STEPS) : null };
}

const KIND_OF: Record<CellRole, PanelKind> = {
  incomer: 'circuit-breaker', coupler: 'circuit-breaker', motor: 'circuit-breaker', transformer: 'circuit-breaker',
  capacitor: 'circuit-breaker', outgoing: 'circuit-breaker', metering: 'metering', 'bus-riser': 'bus-riser',
  'bus-connection': 'bus-connection', contactor: 'contactor', dummy: 'dummy',
};

/** A cell's role and current, as the project says them. */
export function cellOf(data: ProjectData, item: DeviceLibraryItem, row: DeviceTableRow): { role: CellRole; current: CellCurrent } {
  const role = cellRole(row.templateName);
  const p = (item.properties ?? {}) as Record<string, unknown>;
  if (role === 'bus-riser' || role === 'bus-connection') {
    // These carry the busbar.
    const busbar = num(p.mainBusbarRatedCurrent);
    return { role, current: { value: item.cellCurrents?.[row.id] ?? busbar, source: item.cellCurrents?.[row.id] ? 'engineer' : busbar ? 'busbar' : null, uncertain: !busbar } };
  }
  return { role, current: cellCurrent(item, row, role, feederBreakerText(data, row), item.cellCurrents?.[row.id]) };
}

/** SIMOPRIME World: the panel of one cell (or, for the switchgear as a
 *  whole, of a breaker carrying the busbar current). */
export function worldPanelFor(data: ProjectData, item: DeviceLibraryItem, row?: DeviceTableRow): WorldPanel & { role?: CellRole; current?: CellCurrent } {
  const p = (item.properties ?? {}) as Record<string, unknown>;
  const site = {
    ...scopeRatings(data, item),
    // The scope's own design temperature, else the project's.
    ambientC: num(p.designTemperature) ?? num(data.techSettings?.general?.designTemperature),
    frequencyHz: num(p.frequency),
    frontAccess: /^front/i.test(String(p.switchgearAccess ?? '')),
  };
  if (!row) return worldPanel('circuit-breaker', num(p.mainBusbarRatedCurrent), site);
  const { role, current } = cellOf(data, item, row);
  const panel = worldPanel(KIND_OF[role], current.value, site, item.cellPanels?.[row.id]);
  if (current.note) panel.notes.unshift(current.note);
  return { ...panel, role, current };
}

export { HAS_BREAKER };

export function specFromProject(data: ProjectData, item: DeviceLibraryItem, row?: DeviceTableRow): DraftSpec {
  const p = (item.properties ?? {}) as Record<string, unknown>;
  const parts: string[] = ['V.C.B'];
  const assumed: string[] = [];
  const notes: string[] = [];
  const equipment = equipmentOf(data, item);
  const tpms = (equipment?.properties?.tpms ?? {}) as Record<string, any>;

  // Rated voltage: the insulation level, else the service voltage raised to
  // the breaker's step.
  let kvRaw = num(p.ratedInsulationVoltage) ?? num(p.serviceVoltage) ?? num(data.technicalSettings?.mediumVoltage?.nominalVoltage);
  if (kvRaw != null && kvRaw > 100) kvRaw /= 1000; // written in volts
  if (kvRaw != null) {
    const kv = stepUp(kvRaw, KV_STEPS);
    if (kv != null) {
      parts.push(`${kv}KV`);
      if (kv !== kvRaw) { assumed.push('kv'); notes.push(`Rated voltage ${kvRaw} kV raised to the 3AE5 step ${kv} kV.`); }
    }
  }
  // Short-circuit current.
  const kaRaw = num(p.isc) ?? num(p.ratedShortTimeWithstandCurrent);
  if (kaRaw != null) {
    const ka = stepUp(kaRaw, KA_STEPS);
    if (ka != null) {
      parts.push(`${ka}KA`);
      if (ka !== kaRaw) { assumed.push('ka'); notes.push(`Short-circuit current ${kaRaw} kA raised to the 3AE5 step ${ka} kA.`); }
    }
  }
  // SIMOPRIME World: the cell's panel picks the breaker from the catalogue.
  const family = scopeFamily(item, String(tpms.switchgearType ?? ''));
  const panel = family === 'SIMOPRIME-WORLD' ? family : null;
  const world = panel ? worldPanelFor(data, item, row) : undefined;
  // The feeder's own breaker, when its template has one, says the most.
  const breaker = row ? feederBreakerText(data, row) : '';
  if (world?.breaker) {
    parts.push(`${world.breaker[5]}A`);
  } else if (breaker) {
    parts.push(breaker);
    notes.push('Breaker part of the feeder template read.');
  } else {
    const ir = num(p.mainBusbarRatedCurrent);
    if (ir != null && ir >= 630) {
      parts.push(`${ir}A`);
      assumed.push('ir');
      notes.push('Rated current taken from the main busbar — confirm it for this breaker.');
    }
  }
  // Control and motor voltages.
  const control = controlVoltage(p.controlProtectionClosingTrippingSignalling);
  if (control) parts.push(`CLOSING COIL ${control}`, `SHUNT RELEASE ${control}`);
  const motor = controlVoltage(p.springChargingMotor);
  if (motor) parts.push(`MOTOR ${motor}`);
  const hz = num(p.frequency);
  if (hz === 50 || hz === 60) parts.push(`${hz}HZ`);
  // Which switchgear it goes into.
  if (family?.startsWith('SIMOPRIME')) parts.push('FOR SIMOPRIME');
  if (world?.breaker) notes.push(`SIMOPRIME World design catalogue: ${world.breaker[0]} in a ${world.width} mm panel.`);

  return { text: parts.join(', '), assumed, notes, panel, world };
}

/**
 * A specification read into the builder, with what the project only
 * suggested marked to confirm, and the panel's own rules applied.
 */
export function decodeDraft(text: string, draft?: Pick<DraftSpec, 'assumed' | 'panel' | 'world'>): SionState {
  const s = decode(text);
  (draft?.assumed ?? []).forEach(f => { if ((s as any)[f] != null) s.st[f] = 'assumed'; });
  if (draft?.panel === 'SIMOPRIME-WORLD') {
    s.panel = draft.panel;
    // The panel's catalogue: motor operation and 12 NO + 12 NC on every
    // breaker; the breaker itself is the fixed-mounted one (W66).
    if (s.aux == null) { s.aux = '12'; s.st.aux = 'found'; }
    // W66 is the fixed-mounted breaker on SIMOPRIME's own truck.
    if (s.inst == null || s.st.inst !== 'user') { s.inst = '0'; s.st.inst = 'found'; }
    // Option points the catalogue leaves open take the office's defaults —
    // listed on the screen, changed in the form like anything else.
    if (s.rel2 == null || s.st.rel2 === 'assumed') { s.rel2 = 'none'; s.st.rel2 = 'default'; }
    if (s.rel3 == null) { s.rel3 = 'none'; s.st.rel3 = 'default'; }
    // The cell's panel fixes the breaker type: its ratings are the catalogue's.
    const b = draft.world?.breaker;
    if (b) {
      s.kv = b[1]; s.ka = b[2]; s.pcd = b[3]; s.vdt = b[4]; s.ir = b[5];
      (['kv', 'ka', 'pcd', 'vdt', 'ir'] as const).forEach(f => { s.st[f] = 'found'; });
    }
  }
  return s;
}

/**
 * A SIMOPRIME World scope's type of ventilation: the most demanding of its
 * cells (table 3.7), or — before it has cells — what its busbar asks for
 * (a 4000 A busbar is force-ventilated).
 */
export function scopeVentilation(data: ProjectData, item: DeviceLibraryItem): { value: string; why: string } {
  const rank = { Without: 0, Natural: 1, Forced: 2 } as const;
  const rows = equipmentOf(data, item)?.devices ?? [];
  let best: 'Without' | 'Natural' | 'Forced' = 'Without';
  let because = '';
  for (const r of rows) {
    const panel = worldPanelFor(data, item, r);
    if (rank[panel.ventilation] > rank[best]) { best = panel.ventilation; because = r.feederNo || r.templateName; }
  }
  if (rows.length) {
    return { value: best, why: best === 'Without' ? `None of its ${rows.length} cells needs ventilation (table 3.7).` : `Cell ${because} needs ${best.toLowerCase()} ventilation (table 3.7).` };
  }
  const busbar = num((item.properties as any)?.mainBusbarRatedCurrent);
  if (busbar === 4000) return { value: 'Forced', why: 'A 4000 A busbar needs forced ventilation.' };
  return { value: 'Without', why: 'No cells yet — from the incomer panel for the busbar current (table 3.7).' };
}

/**
 * A scope's cells: how many, each one's width (SIMOPRIME World from the
 * catalogue or the engineer's choice; other switchgears from what was set
 * per cell), and the switchgear's total width.
 */
export function scopeCells(data: ProjectData, item: DeviceLibraryItem): {
  count: number | null; widths: (number | null)[]; total: number; unknown: number;
} {
  const rows = equipmentOf(data, item)?.devices ?? [];
  const tpms = (equipmentOf(data, item)?.properties?.tpms ?? {}) as Record<string, any>;
  const world = scopeFamily(item, String(tpms.switchgearType ?? '')) === 'SIMOPRIME-WORLD';
  const widths = rows.map(r => (world ? worldPanelFor(data, item, r).width : item.cellPanels?.[r.id]?.width ?? null) ?? null);
  const count = rows.length || num((item.properties as any)?.numberOfCells) || num(tpms.cellCount) || null;
  return {
    count, widths,
    total: widths.reduce<number>((s, w) => s + (w ?? 0), 0),
    unknown: widths.filter(w => w == null).length,
  };
}
