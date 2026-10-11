// src/utils/siprotec/sx800.ts
//
// SIPROTEC 5 Compact 7SX800 — the order number as Siemens' catalogue gives it
// (SIPROTEC 5 Compact · Catalog – Edition 6, Table 5.1/1 "SIPROTEC 7SX800
// selection and ordering data"):
//
//   position  1–7   7SX8000      fixed
//             8     3            fixed
//             9     A B C        binary inputs / outputs
//             10    A B          measuring inputs
//             11    5            fixed
//             12    0 1          front view
//             13    1            fixed
//             14    A B C        port F
//             15–16 A0           fixed
//
//   7SX8000-3 ☐ ☐ 5 ☐ - 1 ☐ A 0      e.g. 7SX8000-3CA50-1BA0
//
// Function points are ordered apart (7XX8152-1AA…, the account number from
// Siemens' function-point manager), so they are not part of this number.

export interface SxOption { code: string; label: string; detail?: string }
export interface SxPosition { key: string; pos: number; title: string; options: SxOption[] }

export const SX800_POSITIONS: SxPosition[] = [
  {
    key: 'io', pos: 9, title: 'Binary inputs / outputs',
    options: [
      { code: 'A', label: '4 BI, 5 BO (4 F, 1 life contact)' },
      { code: 'B', label: '14 BI, 11 BO (10 F, 1 life contact)' },
      { code: 'C', label: '17 BI, 8 BO (7 F, 1 life contact)' },
    ],
  },
  {
    key: 'meas', pos: 10, title: 'Measuring inputs',
    options: [
      { code: 'A', label: '4 x Ip, 4 x U', detail: 'CT: 4 (protection); VT: 4 (standard)' },
      { code: 'B', label: '3 x Ip, 1 x Iee, 4 x U', detail: 'sensitive earth-current input' },
    ],
  },
  {
    key: 'front', pos: 12, title: 'Front view',
    options: [
      { code: '0', label: 'Standard' },
      { code: '1', label: 'US' },
    ],
  },
  {
    key: 'portF', pos: 14, title: 'Port F (Ethernet)',
    options: [
      { code: 'A', label: '2 x unpopulated SFP cages', detail: 'SFPs ordered as spare parts' },
      { code: 'B', label: 'Ethernet electrical', detail: '2 x RJ45, 100 Mbit/s, 20 m' },
      { code: 'C', label: 'Ethernet optical', detail: '2 x duplex LC, 1300 nm, 2 km multimode' },
    ],
  },
];

export const SX800_DEFAULT: Record<string, string> = { io: 'C', meas: 'A', front: '0', portF: 'B' };

/** The order number for these choices — null while one is missing. */
export function sx800Code(c: Record<string, string>): string | null {
  const ok = SX800_POSITIONS.every(p => p.options.some(o => o.code === c[p.key]));
  if (!ok) return null;
  return `7SX8000-3${c.io}${c.meas}5${c.front}-1${c.portF}A0`;
}

/** The choices an order number stands for — null if it is not a 7SX800 one. */
export function sx800Decode(code: string): Record<string, string> | null {
  const m = /^7SX8000-?3([ABC])([AB])5([01])-?1([ABC])A0$/i.exec(code.replace(/\s+/g, '').toUpperCase());
  return m ? { io: m[1], meas: m[2], front: m[3], portF: m[4] } : null;
}
