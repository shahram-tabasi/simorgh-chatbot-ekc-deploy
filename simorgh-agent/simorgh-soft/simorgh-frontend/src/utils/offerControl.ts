// src/utils/offerControl.ts
//
// The control equipment an offer counted, set against what the design has.
//
// At offer stage the sales engineer puts the control parts of each template —
// two MCBs, three Finder relays — on the template's offer list. That list sizes
// the first drawer and prices the offer. Later the design has its own parts;
// where it carries more than the offer counted, that is a claim, and this is
// where it is seen. The offer list is never bought and never sent to EPLAN: it
// lives beside the template's rows (TemplateItem.offerControl), not in them.
import type { OfferControlPart, ProjectData, TemplateItem } from '../types/project';
import { TIERS } from './tiers';
import { stripLocaleTags } from './tierEquipmentMatrix';

export type ControlKind = 'MCB' | 'Relay' | 'Contactor' | 'Timer' | 'Meter' | 'Supply' | 'Other';

const textOf = (p: any) => [
  p?.partNumber, p?.label, p?.fullData?.OrderNumber, p?.fullData?.TypeNumber,
  stripLocaleTags(p?.fullData?.Designation1), stripLocaleTags(p?.fullData?.Designation2),
].filter(Boolean).join(' ').toUpperCase();

/** What sort of control part it is, from its order code and description. */
export function controlKind(p: any): ControlKind {
  const t = textOf(p);
  if (/\b5S[LYJVP]\d|\bMCB\b|MINIATURE|M\.C\.B/.test(t)) return 'MCB';
  if (/FINDER|\b90\.2\d|\b60\.1\d|\b40\.\d\d|\bRELAY\b|\b3RQ|\bLZX|\bPLC-R/.test(t)) return 'Relay';
  if (/TIMER|\b3RP|\b7PV/.test(t)) return 'Timer';
  if (/\b3RT|\b3RH|CONTACTOR/.test(t)) return 'Contactor';
  if (/METER|\b7KM|\b7KT|AMMETER|VOLTMETER/.test(t)) return 'Meter';
  if (/POWER SUPPLY|\b6EP|\b4AV/.test(t)) return 'Supply';
  return 'Other';
}

/** A price the part's own record carries, if the parts database has one. */
export function priceOf(p: any): number | null {
  const d = p?.fullData ?? {};
  for (const [k, v] of Object.entries(d)) {
    if (!/price/i.test(k)) continue;
    const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The power rows — the feeder's own breaker, contactor, overload and
 *  transformers. Control equipment is everything else. */
const POWER_ROWS = /^(CB ORDER|VCB OR VC\/FUSE|BREAKER TYPE|CONTACTOR\. ORDER|OVER LOAD RELAY|CT RATING|PT RATING|COREBALANCE CT|EARTH FAULT|SURGE ARRESTER)$/i;

/** The control parts the design itself has on a template. */
export function designParts(template: TemplateItem): any[] {
  const props = (template.properties ?? {}) as Record<string, any>;
  return Object.entries(props)
    .filter(([slot]) => !POWER_ROWS.test(slot.trim()))
    .flatMap(([, v]) => (Array.isArray((v as any)?.parts) ? (v as any).parts : []));
}

export interface KindCompare {
  kind: ControlKind;
  /** Per feeder. */
  offer: number;
  design: number;
}

/** Offer against design, per kind of control part, per feeder. */
export function compareKinds(template: TemplateItem): KindCompare[] {
  const offer = new Map<ControlKind, number>();
  const design = new Map<ControlKind, number>();
  for (const p of template.offerControl ?? []) {
    const k = controlKind(p);
    offer.set(k, (offer.get(k) ?? 0) + (Number(p.quantity) || 1));
  }
  for (const p of designParts(template)) {
    const k = controlKind(p);
    // MCBs and relays always count; any other kind only where the offer
    // counted it — a meter row is not something the offer was asked to price.
    if (k !== 'MCB' && k !== 'Relay' && !offer.has(k)) continue;
    design.set(k, (design.get(k) ?? 0) + (Number(p.quantity) || 1));
  }
  const kinds = [...new Set([...offer.keys(), ...design.keys()])];
  return kinds.map(kind => ({ kind, offer: offer.get(kind) ?? 0, design: design.get(kind) ?? 0 }));
}

/** How many feeders use each template across the project's switchgear. */
export function feedersPerTemplate(data: ProjectData): Map<string, number> {
  const m = new Map<string, number>();
  for (const eq of data.equipments ?? []) {
    for (const r of eq.devices ?? []) if (r.templateId) m.set(r.templateId, (m.get(r.templateId) ?? 0) + 1);
  }
  return m;
}

/** Templates that have an offer list. */
export function offerTemplates(data: ProjectData): TemplateItem[] {
  return TIERS.flatMap(t => data.templates?.[t] ?? []).filter(t => (t.offerControl ?? []).length > 0);
}

/** Control counts for sizing a drawer: offer list where there is one, else design. */
export function controlCounts(template?: TemplateItem): { mcb: number; relay: number } {
  if (!template) return { mcb: 0, relay: 0 };
  const list: OfferControlPart[] | any[] = (template.offerControl ?? []).length ? template.offerControl! : designParts(template);
  let mcb = 0, relay = 0;
  for (const p of list) {
    const k = controlKind(p);
    const q = Number(p.quantity) || 1;
    if (k === 'MCB') mcb += q;
    if (k === 'Relay') relay += q;
  }
  return { mcb, relay };
}
