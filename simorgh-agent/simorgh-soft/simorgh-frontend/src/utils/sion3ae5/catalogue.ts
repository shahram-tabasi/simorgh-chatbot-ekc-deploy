// src/utils/sion3ae5/catalogue.ts
//
// The design catalogues a MV scope can be held to, by AIS family: what its
// specification form allows and fills in, and what panel each cell gets.
// SIMOPRIME World and SIMOPRIME A4 take the SION 3AE5; EK36 takes the 3AH3.
import type { DeviceLibraryProperties } from '../../types/project';
import { worldPanel, type PanelChoice, type PanelKind, type WorldPanel, type WorldSite } from './simoprimeWorld';
import { a4Panel, A4_WIDTHS } from './simoprimeA4';
import { applyWorldRules, worldFieldRule, WORLD_FIELDS, type FieldRule, type WorldSiteInfo } from './simoprimeWorldScope';
import { applyA4Rules, a4FieldRule, A4_FIELDS } from './simoprimeA4Scope';
import { applyEk36Rules, ek36FieldRule, ek36Panel, EK36_FIELDS, EK36_WIDTHS } from './ek36';

export interface ScopeCatalogue {
  family: string;
  /** "SIMOPRIME World" — for headings. */
  name: string;
  /** What the catalogue is and which of its sections the form follows. */
  about: string;
  /** What the cells table follows. */
  cellsAbout: string;
  /** The selection table, as notes cite it ("table 3.7"). */
  table: string;
  fields: string[];
  fieldRule: (key: string, p: Record<string, any>, site: WorldSiteInfo) => FieldRule | null;
  apply: (input: DeviceLibraryProperties, changed: string | null, autos: Set<string>, site: WorldSiteInfo)
    => { props: DeviceLibraryProperties; autos: Set<string> };
  panel: (kind: PanelKind, feederA: number | null, site: WorldSite, choice?: PanelChoice) => WorldPanel;
  /** The widths a cell may be set to by hand. */
  widths: number[];
  /** The breaker the panels take — the 3AE5 builder serves only the 3AE5. */
  breaker: '3AE5' | '3AH3';
}

const CATALOGUES: Record<string, ScopeCatalogue> = {
  'SIMOPRIME-WORLD': {
    family: 'SIMOPRIME-WORLD',
    name: 'SIMOPRIME World',
    about: 'SIMOPRIME World design catalogue (issue 23, 06/2026): each field offers only what the catalogue allows with the rest, and one choice fills in what it settles (1.1 technical data, 1.2 busbars, 1.3 design, 1.5 supply voltages, 3.2 dimensions, 3.8 busbar currents)',
    cellsAbout: "SIMOPRIME World design catalogue (issue 23, 06/2026): table 3.7 picks the typical, width, ventilation and breaker from the cell's current at the design temperature and frequency; 2.2.3.3 withdrawable VTs; 2.2.2.9 mandatory order codes. Click a cell to open its code below.",
    table: 'table 3.7',
    fields: WORLD_FIELDS,
    fieldRule: worldFieldRule,
    apply: applyWorldRules,
    panel: worldPanel,
    widths: [600, 800],
    breaker: '3AE5',
  },
  'SIMOPRIME-A4': {
    family: 'SIMOPRIME-A4',
    name: 'SIMOPRIME A4',
    about: 'SIMOPRIME A4 design catalogue (version 1.4, 04/2007): each field offers only what the catalogue allows with the rest, and one choice fills in what it settles (1 technical data, 1.1–1.2 busbars, 1.3 design options, 1.5 supply voltages, 2.2 feeder currents, 2.2.1 dimensions)',
    cellsAbout: "SIMOPRIME A4 design catalogue (version 1.4, 04/2007): table 2.2 picks the busbar run, breaker, ventilation and width (2.2.1) from the cell's current at the design temperature and frequency; the SION 3AE5 of the same rating stands in for the catalogue's 3AH5, at 210 mm phase centres in an 800 mm panel and 275 mm in a 1000 mm one (2.3.2). Click a cell to open its code below.",
    table: 'table 2.2',
    fields: A4_FIELDS,
    fieldRule: a4FieldRule,
    apply: applyA4Rules,
    panel: a4Panel,
    widths: A4_WIDTHS,
    breaker: '3AE5',
  },
  EK36: {
    family: 'EK36',
    name: 'EK36',
    about: 'EK36 manual (EK-MS-04, 09.2025): each field offers only what the manual allows, and one choice fills in what it settles (10.1 technical data and dimensions, 17.3 busbars, 17.4 earthing busbar, 10.3 3AH3 supply voltages)',
    cellsAbout: 'EK36 manual (EK-MS-04, 09.2025): every circuit-breaker, bus sectionalizer, riser and metering panel is 1100 mm (10.1); feeders 1250 or 2500 A with the 3AH3 vacuum circuit-breaker on truck (10.3).',
    table: 'EK36 10.1',
    fields: EK36_FIELDS,
    fieldRule: ek36FieldRule,
    apply: applyEk36Rules,
    panel: ek36Panel,
    widths: EK36_WIDTHS,
    breaker: '3AH3',
  },
};

/** The catalogue a family's scopes are held to, if it has one. */
export const catalogueOf = (family: string | null | undefined): ScopeCatalogue | null =>
  (family && CATALOGUES[family]) || null;

/** True when a value is one the catalogue allows, given the rest. */
export function allowedIn(cat: ScopeCatalogue, key: string, p: Record<string, any>, site: WorldSiteInfo): boolean {
  const v = p[key];
  if (v == null || v === '') return true;
  const rule = cat.fieldRule(key, p, site);
  return !rule || rule.options.some(o => o.value === String(v));
}
