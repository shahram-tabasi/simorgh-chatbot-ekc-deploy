// src/utils/sion3ae5/catalogue.ts
//
// The design catalogues a MV scope can be held to, by AIS family: what its
// specification form allows and fills in, and what panel each cell gets.
// SIMOPRIME World and SIMOPRIME A4 both take the SION 3AE5; EK36 has none yet.
import type { DeviceLibraryProperties } from '../../types/project';
import { worldPanel, type PanelChoice, type PanelKind, type WorldPanel, type WorldSite } from './simoprimeWorld';
import { a4Panel, A4_WIDTHS } from './simoprimeA4';
import { applyWorldRules, worldFieldRule, WORLD_FIELDS, type FieldRule, type WorldSiteInfo } from './simoprimeWorldScope';
import { applyA4Rules, a4FieldRule, A4_FIELDS } from './simoprimeA4Scope';

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
