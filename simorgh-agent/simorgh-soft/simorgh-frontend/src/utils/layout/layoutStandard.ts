// src/utils/layout/layoutStandard.ts
//
// The office's layout standard, as numbers a drawing can be built from.
//
// Most of it is RE-TE-011-01, "راهنمای طراحی نقشه جانمایی و نمای داخلی
// تابلوهای ایستاده" — the clause is named beside each value so a figure can be
// traced back and argued with. The ducts are the first standard the office set
// for Simorgh Draw (perimeter 60, MCB rows 40, breaker and contactor rows 60);
// details are to be agreed and changed here, in one place.
//
// All dimensions in millimetres.

/** A SIVACON S8 section — the withdrawable (OFW) column. */
export interface S8Section {
  /** One drawer module. 2M is 100 mm and 14M 700 mm: S8 drawers go 100…700. */
  moduleMm: number;
  height: number;
  /** Main busbar compartment at the top — the drawers start below it (B24: 390). */
  busbarTop: number;
  /** Below the last drawer: the plinth and the bottom cover. */
  bottom: number;
  /** The drawer (device) compartment. */
  deviceWidth: number;
  /** The cable connection compartment beside it. */
  cableWidth: number;
  depth: number;
}

export const S8_SECTION: S8Section = {
  moduleMm: 50,
  height: 2200,
  busbarTop: 400,
  bottom: 0,
  deviceWidth: 600,
  cableWidth: 400,
  depth: 600,
};

/** How many modules a section holds. */
export const sectionModules = (s: S8Section = S8_SECTION) =>
  Math.floor((s.height - s.busbarTop - s.bottom) / s.moduleMm);

/** Standing panels: the widths and depths they are built in (B5). */
export const PANEL_WIDTHS = [400, 600, 800, 1000] as const;
export const PANEL_DEPTHS = [400, 600, 800] as const;

/** The fixed (CCS) internal view. */
export const CCS = {
  height: 2200,
  /** Vertical ducts, both sides — perimeter 60 (B12 allows 80 on the hinge side). */
  ductSide: 60,
  /** Horizontal duct across the top of the panel (B12). */
  ductTop: 40,
  /** Ducts above and below a row of MCBs, fuses and relays. */
  ductMcbRow: 40,
  /** Ducts above and below a row of breakers, MPCBs and contactors. */
  ductPowerRow: 60,
  /** Duct above the terminal plate (B12) and below it. */
  ductAboveTerminals: 80,
  ductBelowTerminals: 60,
  /** Equipment starts this far past a vertical duct (B26). */
  pastDuct: 5,
  /** Wire numbers above and below a device: 20, 30 where there is room (B34). */
  wireNumbers: 25,
  /** Duct to duct for an MCB or fuse row, and for a relay (Finder) row (B34). */
  mcbRowPitch: 130,
  relayRowPitch: 100,
  /** The mounting plates start below the busbar compartment (B24). */
  busbarCompartment: 390,
  /** Cable bottom: power terminals at least this far off the floor (B35). */
  terminalsOffFloor: 300,
  /** Gap between devices in a row (B33: 1 cm between breakers). */
  gap: 10,
  /** Breakers from the side of the panel: 80 to 250 A, 105 from 315 A (B29). */
  breakerFromSide: (amps?: number) => (amps != null && amps >= 315 ? 105 : 80),
  /** Breaker above contactor, joined by a bar: at least 150 apart (B30). */
  breakerToContactor: 150,
  /** Spare space to leave — tell the client if it cannot be (B20). */
  spare: 0.2,
  /** A U mounting plate is 70 narrower than the cell (B54). */
  uPlateLess: 70,
  /** Front plug-in breaker: 50 more above and below (B44). */
  plugInFront: 50,
};

/** A device's face on the mounting plate, width × height, from its order code. */
export interface DeviceFace {
  kind: 'mcb' | 'mpcb' | 'contactor' | 'overload' | 'mccb' | 'relay' | 'meter' | 'supply' | 'terminal' | 'other';
  w: number;
  h: number;
}

/** Siemens catalogue faces, rounded. A device not known here is drawn 45 × 90. */
export function faceOf(code: string, text = '', poles = 3): DeviceFace {
  const c = code.toUpperCase().replace(/\s/g, '');
  const t = `${c} ${text}`.toUpperCase();
  const p = Math.max(1, Math.min(4, poles));
  if (/^5S[LYJ]|^5SV|\bMCB\b|MINIATURE/.test(t)) {
    const n = Number(c.match(/^5S[LYJ]\d(\d)/)?.[1]) || p;
    return { kind: 'mcb', w: 18 * Math.min(4, n), h: 90 };
  }
  if (/^3RV/.test(c)) {
    const s = c.match(/^3RV\d\d(\d)/)?.[1];
    return s === '4' ? { kind: 'mpcb', w: 70, h: 150 } : s === '3' ? { kind: 'mpcb', w: 55, h: 140 } : { kind: 'mpcb', w: 45, h: 97 };
  }
  if (/^3RT10[567]/.test(c)) {
    const s = c[5];
    return s === '7' ? { kind: 'contactor', w: 160, h: 210 } : s === '6' ? { kind: 'contactor', w: 145, h: 180 } : { kind: 'contactor', w: 120, h: 160 };
  }
  if (/^3RT2/.test(c)) {
    const s = c.match(/^3RT2\d(\d)/)?.[1];
    return s === '4' ? { kind: 'contactor', w: 70, h: 140 } : s === '3' ? { kind: 'contactor', w: 55, h: 114 }
      : s === '2' ? { kind: 'contactor', w: 45, h: 85 } : { kind: 'contactor', w: 45, h: 58 };
  }
  if (/^3R[UB]|^3UF/.test(c)) return { kind: 'overload', w: 45, h: 70 };
  if (/^3VA/.test(c)) {
    const f = c.slice(3, 5);
    const k = p >= 4 ? 4 / 3 : 1;
    const [w, h] = f === '10' || f === '11' ? [76, 130] : f === '12' ? [105, 160]
      : f === '23' ? [138, 248] : f === '24' ? [183, 275] : [105, 181];
    return { kind: 'mccb', w: Math.round(w * k), h };
  }
  if (/FINDER|^90\.2|^60\.1|RELAY|^3RH|^3RQ|^LZX/.test(t)) return { kind: 'relay', w: 38, h: 78 };
  if (/METER|^7KM|^7KT|CONTREL|ELR|RAR/.test(t)) return { kind: 'meter', w: 96, h: 96 };
  if (/POWER ?SUPPLY|^6EP|PHOENIX/.test(t)) return { kind: 'supply', w: 45, h: 100 };
  if (/TERMINAL|^8WH|^PT ?\d|^UK/.test(t)) return { kind: 'terminal', w: 6.2, h: 50 };
  return { kind: 'other', w: 45, h: 90 };
}

/** The power rows: breakers, MPCBs, contactors — the 60 duct. */
export const isPowerRow = (kind: DeviceFace['kind']) =>
  kind === 'mccb' || kind === 'mpcb' || kind === 'contactor' || kind === 'overload';
