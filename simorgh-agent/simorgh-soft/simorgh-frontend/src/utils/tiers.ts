// src/utils/tiers.ts
//
// The groups a switchgear is filed under — in the Device Library, in Create
// Template and in Device Selection.
//
// LV, MV and HV are voltage levels. GIS is gas-insulated switchgear: medium
// voltage in rating, but a different product with its own cells, so it gets
// its own group and its own templates, laid out the way MV's are. OTHER is for
// the switchgear that is none of these — a DC board, a control panel, a
// marshalling cabinet — which used to have to be filed under a voltage level
// it did not belong to.
//
// Written once here, because a group list spelt out in each screen is a group
// list that differs between screens: a device filed under GIS that Device
// Selection does not know about is a device nobody can build rows for.

export type Tier = 'LV' | 'MV' | 'HV' | 'GIS' | 'OTHER';

export const TIERS: readonly Tier[] = ['LV', 'MV', 'HV', 'GIS', 'OTHER'];

export const TIER_LABEL: Record<Tier, string> = {
  LV: 'Low Voltage',
  MV: 'Medium Voltage',
  HV: 'High Voltage',
  GIS: 'Gas Insulated Switchgear',
  OTHER: 'Other devices',
};

/** Badge colours, light utilities only (see theme.css for the dark remap). */
export const TIER_BADGE: Record<Tier, string> = {
  LV: 'text-green-600 bg-green-50',
  MV: 'text-orange-600 bg-orange-50',
  HV: 'text-red-600 bg-red-50',
  GIS: 'text-blue-600 bg-blue-50',
  OTHER: 'text-gray-600 bg-gray-100',
};

export const TIER_PILL: Record<Tier, string> = {
  LV: 'bg-green-100 text-green-700',
  MV: 'bg-orange-100 text-orange-700',
  HV: 'bg-red-100 text-red-700',
  GIS: 'bg-blue-100 text-blue-700',
  OTHER: 'bg-gray-100 text-gray-700',
};

/**
 * Which tier's property rows a tier's templates use.
 *
 * A GIS cell carries what a MV cell carries — the breaker, the voltage
 * indicator, the CTs and VTs, the relay — so GIS templates are laid out as MV
 * ones and every screen that reads MV's columns reads GIS's the same way.
 * OTHER is the catch-all and takes LV's, the longer list.
 */
export const LAYOUT_OF: Record<Tier, 'LV' | 'MV' | 'HV'> = {
  LV: 'LV', MV: 'MV', HV: 'HV', GIS: 'MV', OTHER: 'LV',
};

export const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIERS as readonly string[]).includes(v);

/** One empty list per tier. */
export function emptyTiers<T>(): Record<Tier, T[]> {
  return { LV: [], MV: [], HV: [], GIS: [], OTHER: [] };
}

/**
 * The same record with every tier present.
 *
 * A project saved before GIS and OTHER existed has no list for them, and
 * `templates.GIS.map(...)` on it throws. Returned unchanged — the same object —
 * when nothing is missing, so a project that is already whole does not look
 * like a changed one.
 */
export function withAllTiers<T>(record: Partial<Record<Tier, T[]>> | undefined | null): Record<Tier, T[]> {
  const src = (record ?? {}) as Partial<Record<Tier, T[]>>;
  if (record && TIERS.every(t => Array.isArray(src[t]))) return record as Record<Tier, T[]>;
  const out = { ...src } as Record<Tier, T[]>;
  for (const t of TIERS) if (!Array.isArray(out[t])) out[t] = [];
  return out;
}
