// src/utils/offerTemplate.ts
//
// What the Offer Template tab and Create Template share.
//
//   * which kind of device each header is, so the catalogue opened from a
//     header shows that kind only — breakers under CB ORDER, CTs under CT
//     RATING, VTs under PT RATING — as words a part's type number or
//     descriptions hold (the parts table carries no kind of its own);
//   * the template open in either tab, so moving between them keeps it open;
//   * a part copied on the offer side, to paste or to replace another with.

import type { OfferTemplatePart } from '../types/project';

export interface DeviceKind { label: string; words: string[] }

const BREAKER: DeviceKind = {
  label: 'breakers',
  words: ['circuit breaker', 'circuit-breaker', 'leistungsschalter', 'mccb', 'acb', 'vcb', 'vacuum',
    'breaker', '3va', '3wa', '3wl', '3vl', '3ah', '3ae', '3rv'],
};
const KINDS: [RegExp, DeviceKind][] = [
  [/^(CB ORDER|VCB OR VC\/FUSE|BREAKER TYPE)$/i, BREAKER],
  [/CONTACTOR/i, { label: 'contactors', words: ['contactor', 'schütz', 'schutz', '3rt', '3tf', '3tl'] }],
  [/OVER ?LOAD/i, { label: 'overload relays', words: ['overload', 'thermal', '3ru', '3rb', '3ua'] }],
  [/CORE ?BALANCE/i, { label: 'core-balance CTs', words: ['core balance', 'core-balance', 'summation', 'ring type', 'residual current transformer'] }],
  [/^CT RATING$/i, { label: 'current transformers', words: ['current transformer', 'stromwandler', '4nc'] }],
  [/^PT RATING$/i, { label: 'voltage transformers', words: ['voltage transformer', 'potential transformer', 'spannungswandler', '4mr', '4mt'] }],
  [/^AMMETER$/i, { label: 'ammeters', words: ['ammeter', 'amperemeter', 'current meter'] }],
  [/^VOLTMETER$/i, { label: 'voltmeters', words: ['voltmeter', 'voltage meter'] }],
  [/AMMETER SELECTOR|VOLTMETER SELECTOR|SELECTOR/i, { label: 'selector switches', words: ['selector', 'umschalter', 'wahlschalter'] }],
  [/MULTIMETER/i, { label: 'multimeters', words: ['multimeter', 'power meter', 'multifunction', 'sentron pac', '7km'] }],
  [/TRANSDUSER|TRANSDUCER/i, { label: 'transducers', words: ['transducer', 'messumformer'] }],
  [/PROTECTION RELAY/i, { label: 'protection relays', words: ['protection', 'relay', '7sr', '7sj', '7sk', '7ut', 'siprotec', 'reyrolle'] }],
  [/EARTH FAULT/i, { label: 'earth-fault relays', words: ['earth fault', 'earth-fault', 'residual', 'rcd', '5sv', '3ug'] }],
  [/TEST BLOCK/i, { label: 'test blocks', words: ['test block', 'test terminal', 'test switch', 'test plug', 'prüf'] }],
  [/ALARM/i, { label: 'alarm annunciators', words: ['annunciator', 'alarm'] }],
  [/SURGE/i, { label: 'surge arresters', words: ['arrester', 'surge', 'spd', 'überspannung'] }],
  [/VOLTAGE INDICATOR/i, { label: 'voltage indicators', words: ['voltage indicat', 'capacitive', 'capdis', 'voltage detect'] }],
];

/** Every kind there is, for the catalogue's category list. */
export const DEVICE_KINDS: DeviceKind[] = KINDS.map(([, k]) => k)
  .filter((k, i, all) => all.findIndex(x => x.label === k.label) === i);

/**
 * MV or LV is told by the server (simorgh-backend/partsMatch.js): MV is a part
 * that says so — 3AE, 3AH and the other MV families, or a rating above 1 kV —
 * and LV is everything else. A switching device must say it is MV to be listed
 * under MV; a relay or a meter, which says neither, is listed under both.
 */
export const STRICT_VOLTAGE_KINDS = [BREAKER.label, 'contactors'];

/** The kind of device a header holds, or none when the header says nothing. */
export function kindOfHeader(header: string): DeviceKind | null {
  const h = String(header ?? '').trim();
  return KINDS.find(([re]) => re.test(h))?.[1] ?? null;
}

/** A catalogue part's SIM-TABLE, as Create Template reads it: its order
 *  number, or Designation 3 where that is empty or a dash. */
export function simTableOf(part: any): string {
  const order = String(part?.OrderNumber ?? '').trim();
  return order && order !== '-' && order !== '_' ? order : String(part?.Designation3 ?? '').trim();
}

// ── The template open in either tab ─────────────────────────────────────────
let openTemplate: string | null = null;
export const sharedTemplate = (): string | null => openTemplate;
export const shareTemplate = (id: string | null): void => { openTemplate = id; };

// ── A part copied on the offer side ─────────────────────────────────────────
export interface OfferClip { from: string; parts: OfferTemplatePart[] }
let clip: OfferClip | null = null;
const listeners = new Set<() => void>();
export const offerClip = (): OfferClip | null => clip;
export function setOfferClip(next: OfferClip | null): void {
  clip = next;
  for (const fn of listeners) fn();
}
export function onOfferClip(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
