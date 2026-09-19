// src/utils/plc/dataTypes.ts
//
// The data types a program may declare, and what is true about each of them.
//
// A type in a PLC is not a hint. It is how many bits the controller sets aside,
// what the highest number it can hold is, and what happens when it goes past —
// and every one of those is a real fault on a real machine rather than a
// warning in a log. An Int counting parts on a busy line reaches 32 767 in
// about nine hours and then reads −32 768; a Real compared for equality is
// never equal; a Time is a DInt of milliseconds and stops at 24 days. Those are
// the things this table is for.
//
// The list is the IEC 61131-3 elementary types as Siemens spells them, plus
// the S7 types an engineer meets in the same grid. Where a family does not have
// one — LInt and LReal are 1500 only — it says so rather than leaving it out,
// because a type missing from the list looks like a type that does not exist.

export interface DataTypeInfo {
  name: string;
  /** How wide it is, in bits. */
  bits: number;
  group: 'bit' | 'integer' | 'real' | 'time' | 'char' | 'struct' | 'pointer';
  /** What it holds, and what to watch for. */
  note: string;
  /** What it is when nothing is assigned. */
  initial: string;
  /** The lowest and highest it can hold, where that is a number. */
  range?: string;
  /** Families that have it, where it is not in all of them. */
  only?: string;
}

export const DATA_TYPES: DataTypeInfo[] = [
  // ── Bits ──
  { name: 'Bool', bits: 1, group: 'bit', initial: 'FALSE',
    note: 'One bit: TRUE or FALSE. Everything a contact reads and a coil writes.' },
  { name: 'Byte', bits: 8, group: 'bit', initial: '16#00',
    note: 'Eight bits with no meaning of their own — a pattern, not a number. '
      + 'Arithmetic on it is a mistake; use USInt when it counts something.' },
  { name: 'Word', bits: 16, group: 'bit', initial: '16#0000',
    note: 'Sixteen bits as a pattern. Status words, command words, masks.' },
  { name: 'DWord', bits: 32, group: 'bit', initial: '16#0000_0000',
    note: 'Thirty-two bits as a pattern.' },
  { name: 'LWord', bits: 64, group: 'bit', initial: '16#0', only: 'S7-1500',
    note: 'Sixty-four bits as a pattern.' },

  // ── Integers ──
  { name: 'SInt', bits: 8, group: 'integer', initial: '0', range: '−128 … 127',
    note: 'A small signed integer. Overflows almost immediately if it is counting '
      + 'anything real.' },
  { name: 'USInt', bits: 8, group: 'integer', initial: '0', range: '0 … 255',
    note: 'A small unsigned integer — a percentage, a step number, a byte that '
      + 'means a quantity.' },
  { name: 'Int', bits: 16, group: 'integer', initial: '0', range: '−32 768 … 32 767',
    note: 'The default whole number. **It wraps silently**: a production counter '
      + 'on a fast line reaches the top in hours and comes back negative. Use '
      + 'DInt for anything that only goes up.' },
  { name: 'UInt', bits: 16, group: 'integer', initial: '0', range: '0 … 65 535',
    note: 'Unsigned sixteen bits. What most fieldbus registers are.' },
  { name: 'DInt', bits: 32, group: 'integer', initial: '0', range: '−2 147 483 648 … 2 147 483 647',
    note: 'The honest choice for a counter, a position or a total. Two thousand '
      + 'million is enough for almost anything a machine counts.' },
  { name: 'UDInt', bits: 32, group: 'integer', initial: '0', range: '0 … 4 294 967 295',
    note: 'Unsigned thirty-two bits. Lengths, addresses, handles.' },
  { name: 'LInt', bits: 64, group: 'integer', initial: '0', only: 'S7-1500',
    range: '±9.22 × 10¹⁸', note: 'Sixty-four bit signed — for time stamps in nanoseconds.' },
  { name: 'ULInt', bits: 64, group: 'integer', initial: '0', only: 'S7-1500',
    range: '0 … 1.84 × 10¹⁹', note: 'Sixty-four bit unsigned.' },

  // ── Floating point ──
  { name: 'Real', bits: 32, group: 'real', initial: '0.0', range: '±1.18 × 10⁻³⁸ … ±3.40 × 10³⁸',
    note: 'Thirty-two bit floating point — about **seven** significant digits, '
      + 'which is why a total kept in a Real stops changing once it is large. '
      + 'Never compare two of them with `=`.' },
  { name: 'LReal', bits: 64, group: 'real', initial: '0.0', only: 'S7-1500',
    range: '±2.23 × 10⁻³⁰⁸ … ±1.80 × 10³⁰⁸',
    note: 'Sixty-four bit floating point, about fifteen digits. Worth the memory '
      + 'for a running total or a coordinate.' },

  // ── Time ──
  { name: 'Time', bits: 32, group: 'time', initial: 'T#0ms', range: '±24d 20h 31m 23s 647ms',
    note: 'A duration: milliseconds in a signed DInt underneath. Written T#5s, '
      + 'T#1m30s, T#2h. Every IEC timer\'s PT is one of these.' },
  { name: 'LTime', bits: 64, group: 'time', initial: 'LT#0ns', only: 'S7-1500',
    note: 'A duration in nanoseconds.' },
  { name: 'Date', bits: 16, group: 'time', initial: 'D#1990-01-01', range: 'D#1990-01-01 … D#2168-12-31',
    note: 'A day, with no time of day. Written D#2026-04-01.' },
  { name: 'Time_Of_Day', bits: 32, group: 'time', initial: 'TOD#00:00:00',
    note: 'A time of day with no date, in milliseconds since midnight. TOD#06:30:00.' },
  { name: 'DTL', bits: 96, group: 'time', initial: 'DTL#1970-01-01-00:00:00',
    note: 'Date **and** time, as a structure with named fields — YEAR, MONTH, DAY, '
      + 'HOUR, and so on down to nanoseconds. The one to use: the fields can be '
      + 'read without decoding anything.' },
  { name: 'LDT', bits: 64, group: 'time', initial: 'LDT#1970-01-01-00:00:00', only: 'S7-1500',
    note: 'Date and time as nanoseconds since 1970 — one number, so it sorts and '
      + 'subtracts directly.' },

  // ── Text ──
  { name: 'Char', bits: 8, group: 'char', initial: "' '", note: 'One character.' },
  { name: 'WChar', bits: 16, group: 'char', initial: "WCHAR#' '", note: 'One wide character.' },
  { name: 'String', bits: 8 * 256, group: 'char', initial: "''",
    note: 'Up to 254 characters by default, and `String[32]` for a shorter one. '
      + 'It costs two bytes more than its maximum length whether it is full or '
      + 'empty, so size it.' },
  { name: 'WString', bits: 16 * 256, group: 'char', initial: '""', only: 'S7-1500',
    note: 'A wide string — where the text is not Latin.' },

  // ── Structures and references ──
  { name: 'Struct', bits: 0, group: 'struct',
    initial: '', note: 'Fields declared in place. Prefer a PLC data type (UDT) — '
      + 'declared once, used by name, and changed in one place.' },
  { name: 'Array', bits: 0, group: 'struct', initial: '',
    note: 'Written `Array[1..10] of Real`. The bounds are part of the type, and '
      + 'reading outside them faults the CPU rather than returning rubbish.' },
  { name: 'Variant', bits: 0, group: 'pointer', initial: '', only: 'S7-1200/1500',
    note: 'A pointer that knows its own type, checked when it is used. How a block '
      + 'takes "an array of whatever" and stays safe.' },
  { name: 'IEC_TIMER', bits: 0, group: 'struct', initial: '',
    note: 'The instance of an IEC timer — what TON, TOF and TP keep their state in.' },
  { name: 'IEC_COUNTER', bits: 0, group: 'struct', initial: '',
    note: 'The instance of an IEC counter.' },
];

const BY_NAME = new Map(DATA_TYPES.map(t => [t.name.toUpperCase(), t]));

/** What is known about a written type, ignoring any array or length around it. */
export function dataTypeInfo(written: string): DataTypeInfo | undefined {
  return BY_NAME.get(baseTypeName(written).toUpperCase());
}

/**
 * The elementary type at the bottom of a written one.
 *
 * `Array[1..10] of Real` is a Real underneath, `String[32]` is a String, and
 * `"MotorData"` is a user type this cannot see into. Everything that checks a
 * type has to start by asking this, so it is one function rather than a regular
 * expression copied into four.
 */
export function baseTypeName(written: string): string {
  let s = (written ?? '').trim();
  // `Array[1..10, 1..4] of Real` → `Real`
  const arr = /^array\s*\[[^\]]*\]\s*of\s+(.+)$/i.exec(s);
  if (arr) s = arr[1].trim();
  // `String[32]` → `String`
  s = s.replace(/\[[^\]]*\]\s*$/, '').trim();
  return s;
}

/** True where the written type is an array of something. */
export const isArrayType = (written: string): boolean =>
  /^array\s*\[/i.test((written ?? '').trim());

/** True where the type is a user type or block name — `"MotorData"`. */
export const isUserType = (written: string): boolean =>
  /^"[^"]+"$/.test(baseTypeName(written));

/** The name inside the quotes of a user type. */
export const userTypeName = (written: string): string =>
  baseTypeName(written).replace(/^"|"$/g, '');

/** What a variable of this type starts as, where nothing was written. */
export function defaultValueFor(written: string): string {
  if (isArrayType(written)) return '';
  return dataTypeInfo(written)?.initial ?? '';
}

/** True where a value of `from` may be assigned to `to` without converting. */
export function assignable(from: string, to: string): boolean {
  const a = dataTypeInfo(from);
  const b = dataTypeInfo(to);
  if (!a || !b) return true;           // a user type: not ours to judge
  if (a.name === b.name) return true;
  // Widening within a group is safe and is what an engineer expects: an Int
  // into a DInt loses nothing. Everything else wants a CONVERT, and saying so
  // is the whole value of this check.
  if (a.group === 'integer' && b.group === 'integer') return b.bits >= a.bits;
  if (a.group === 'real' && b.group === 'real') return b.bits >= a.bits;
  if (a.group === 'bit' && b.group === 'bit') return b.bits >= a.bits;
  return false;
}

/** The names, for a picker. */
export const DATA_TYPE_NAMES: string[] = DATA_TYPES.map(t => t.name);

/**
 * The six things an address can be wrong about, in words.
 *
 * Taken as an argument so the tag table can say them in Persian, and defaulted
 * so the parts of this file that only want a yes or a no — an importer, a
 * test — do not have to carry a language around with them.
 */
export interface AddressWords {
  addrNoPercent: () => string;
  addrNeedsBit: () => string;
  addrDbNeedsBit: () => string;
  addrNotS7: () => string;
  addrOnlyBitHasBit: () => string;
  addrBitRange: () => string;
}

const DEFAULT_ADDRESS_WORDS: AddressWords = {
  addrNoPercent: () => 'An address starts with % — %I0.0, %QW64, %MD100.',
  addrNeedsBit: () => 'A bit address needs a bit number — %I0.0, not %I0.',
  addrDbNeedsBit: () => 'A bit in a DB needs a bit number — %DB1.DBX0.0.',
  addrNotS7: () => 'That is not an S7 address. Try %I0.0, %QW64 or %MD100.',
  addrOnlyBitHasBit: () => 'Only a bit address has a bit number — %IW64, not %IW64.0.',
  addrBitRange: () => 'A bit number is 0 to 7.',
};

/**
 * Whether an address is written the way S7 writes one.
 *
 * `%I0.0`, `%Q0.1`, `%M10.7`, `%IW64`, `%QD100`, `%MB20`, `%DB1.DBX0.0`.
 * Returned as a reason rather than a boolean, because "that is not an address"
 * helps nobody and "a bit address needs a bit number — %I0.0, not %I0" is the
 * whole correction.
 */
export function addressProblem(address: string, say?: AddressWords): string | null {
  const w = say ?? DEFAULT_ADDRESS_WORDS;
  const a = (address ?? '').trim();
  if (!a) return null;                  // a tag with no address is allowed
  if (!a.startsWith('%')) return w.addrNoPercent();
  const body = a.slice(1).toUpperCase();

  // Data block: %DB1.DBX0.0 / .DBW2 / .DBD4
  if (/^DB\d+\.DB[XBWD]\d+(\.\d)?$/.test(body)) {
    if (/DBX\d+$/.test(body)) return w.addrDbNeedsBit();
    return null;
  }
  const m = /^([IQM])([XBWD]?)(\d+)(?:\.(\d))?$/.exec(body);
  if (!m) return w.addrNotS7();
  const [, , size, , bit] = m;
  if ((size === '' || size === 'X') && bit === undefined) return w.addrNeedsBit();
  if (size !== '' && size !== 'X' && bit !== undefined) return w.addrOnlyBitHasBit();
  if (bit !== undefined && Number(bit) > 7) return w.addrBitRange();
  return null;
}
