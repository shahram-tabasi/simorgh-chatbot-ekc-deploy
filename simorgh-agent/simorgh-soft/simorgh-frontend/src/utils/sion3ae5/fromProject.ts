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
import { worldPanel, panelKindOf, type WorldPanel } from './simoprimeWorld';

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

/** SIMOPRIME World: the panel of one cell (or, for the switchgear as a
 *  whole, of a breaker carrying the busbar current). */
export function worldPanelFor(data: ProjectData, item: DeviceLibraryItem, row?: DeviceTableRow): WorldPanel {
  const { kv, ka } = scopeRatings(data, item);
  const p = (item.properties ?? {}) as Record<string, unknown>;
  const current = row ? feederCurrent(data, row) : num(p.mainBusbarRatedCurrent);
  return worldPanel(row ? panelKindOf(row.templateName) : 'circuit-breaker', current, kv, ka);
}

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
    if (s.inst == null) { s.inst = '0'; s.st.inst = 'assumed'; }
    // The cell's panel fixes the breaker type: its ratings are the catalogue's.
    const b = draft.world?.breaker;
    if (b) {
      s.kv = b[1]; s.ka = b[2]; s.pcd = b[3]; s.vdt = b[4]; s.ir = b[5];
      (['kv', 'ka', 'pcd', 'vdt', 'ir'] as const).forEach(f => { s.st[f] = 'found'; });
    }
  }
  return s;
}
