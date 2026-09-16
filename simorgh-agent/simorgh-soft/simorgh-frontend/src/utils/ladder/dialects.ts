// src/utils/ladder/dialects.ts
//
// What each vendor calls the same thing.
//
// A ladder rung is a ladder rung everywhere. What is not the same everywhere is
// almost everything written on it: Siemens tests `%I0.0` with a plain contact
// and Rockwell tests a tag with an XIC; a Siemens TON has IN and PT and gives
// back Q and ET, a Rockwell TON has a Preset and an Accum and gives back EN, TT
// and DN; Mitsubishi does not have a timer block at all, it has `OUT T0 K50`.
//
// A program drawn with the wrong vendor's blocks is worse than no program. It
// looks right, it reads right, and it cannot be typed into the software the
// customer owns — which is the whole reason somebody asked for it. So the
// dialect is chosen first, everything drawn comes out of the table below, and
// the model is told what this vendor has rather than left to remember.
//
// What is written here is what is common to the vendor's own documentation and
// stable across their tool versions: block names, pin names, and how an address
// is written. Where a vendor's families genuinely differ — S7-300 against
// S7-1500, ControlLogix against MicroLogix — they are separate entries rather
// than one entry with a footnote, because a footnote is not something a
// drawing can carry.
//
// Everything here is descriptive: it is the vocabulary, not a compiler. This
// app draws ladder and explains it; it does not claim to produce a file any
// vendor's software will import.

export interface BlockDef {
  /** The vendor's own name for it. */
  type: string;
  /** Pins going in, in the order the block shows them. */
  ins: string[];
  /** Pins coming out. */
  outs: string[];
  /** What it does and what the pins want, in one line. */
  note: string;
  /** True where the vendor wants an instance name — a DB, a timer tag. */
  instance?: boolean;
}

export interface Dialect {
  id: string;
  /** The maker. */
  vendor: string;
  /** The family, where the vendor's dialects differ between families. */
  family: string;
  /** The software it is programmed in — what the user will actually open. */
  software: string;
  /** Controllers in this family, for the picker. Not exhaustive. */
  controllers: string[];
  /** The languages this software offers. Ladder is drawn whichever is chosen. */
  languages: string[];
  /** How addresses are written, with an example of each. */
  addressing: {
    input: string;
    output: string;
    memory: string;
    timer: string;
    counter: string;
    data: string;
    /** One line on the rule behind them. */
    note: string;
  };
  /** What a contact and a coil are called here. */
  names: {
    no: string;
    nc: string;
    coil: string;
    set: string;
    reset: string;
  };
  /** The blocks this vendor has, by our own key. */
  blocks: Record<string, BlockDef>;
  /** Anything a person writing for this vendor has to know. */
  notes: string[];
}

/** The blocks every dialect is asked about, so the picker can compare them. */
export const COMMON_BLOCKS = ['ton', 'tof', 'ctu', 'ctd', 'move', 'compare'] as const;

const IEC_BLOCKS: Record<string, BlockDef> = {
  ton: { type: 'TON', ins: ['IN', 'PT'], outs: ['Q', 'ET'], note: 'On-delay: Q goes true PT after IN does.', instance: true },
  tof: { type: 'TOF', ins: ['IN', 'PT'], outs: ['Q', 'ET'], note: 'Off-delay: Q stays true PT after IN goes false.', instance: true },
  ctu: { type: 'CTU', ins: ['CU', 'R', 'PV'], outs: ['Q', 'CV'], note: 'Counts up on CU; Q at PV; R clears.', instance: true },
  ctd: { type: 'CTD', ins: ['CD', 'LD', 'PV'], outs: ['Q', 'CV'], note: 'Counts down from PV loaded by LD.', instance: true },
  move: { type: 'MOVE', ins: ['EN', 'IN'], outs: ['ENO', 'OUT'], note: 'Copies IN to OUT while EN is true.' },
  compare: { type: 'GE', ins: ['IN1', 'IN2'], outs: ['OUT'], note: 'Compare — also GT, LT, LE, EQ, NE.' },
};

export const DIALECTS: Dialect[] = [
  {
    id: 'siemens-s7-1200',
    vendor: 'Siemens',
    family: 'S7-1200 / S7-1500',
    software: 'TIA Portal',
    controllers: ['S7-1200 CPU 1211C', 'S7-1200 CPU 1214C', 'S7-1200 CPU 1215C', 'S7-1500 CPU 1511', 'S7-1500 CPU 1513', 'S7-1500 CPU 1516'],
    languages: ['LAD (ladder)', 'FBD', 'SCL', 'GRAPH'],
    addressing: {
      input: '%I0.0', output: '%Q0.0', memory: '%M0.0',
      timer: 'an IEC timer in its own DB', counter: 'an IEC counter in its own DB',
      data: '%MW10, %DB1.DBW0',
      note: 'Byte.bit for bits, and the % is part of the address in TIA Portal. Symbolic tag names are the normal way to write a program; the absolute address is what the tag is bound to.',
    },
    names: { no: 'Normally open contact', nc: 'Normally closed contact', coil: 'Coil', set: 'S (set)', reset: 'R (reset)' },
    blocks: {
      ...IEC_BLOCKS,
      ton: { type: 'TON', ins: ['IN', 'PT'], outs: ['Q', 'ET'], note: 'On-delay. PT is a TIME — T#5s. Each instance needs its own data block.', instance: true },
      tof: { type: 'TOF', ins: ['IN', 'PT'], outs: ['Q', 'ET'], note: 'Off-delay. PT is a TIME — T#5s.', instance: true },
      move: { type: 'MOVE', ins: ['EN', 'IN'], outs: ['ENO', 'OUT1'], note: 'Copies IN to OUT1 while EN is true.' },
    },
    notes: [
      'An IEC timer or counter is an instance: it needs its own data block, and TIA Portal asks for one as the block is placed.',
      'A TIME is written T#5s, T#1m30s — not a plain number.',
    ],
  },
  {
    id: 'siemens-s7-300',
    vendor: 'Siemens',
    family: 'S7-300 / S7-400',
    software: 'STEP 7 (classic) or TIA Portal',
    controllers: ['S7-300 CPU 313C', 'S7-300 CPU 314C', 'S7-300 CPU 315-2 PN/DP', 'S7-400 CPU 414', 'S7-400 CPU 416'],
    languages: ['LAD (ladder)', 'FBD', 'STL', 'SCL', 'GRAPH'],
    addressing: {
      input: 'I0.0', output: 'Q0.0', memory: 'M0.0',
      timer: 'T1', counter: 'C1', data: 'MW10, DB1.DBW0',
      note: 'Byte.bit, with no % in classic STEP 7. Timers and counters are CPU resources numbered T0… and C0…, not instances.',
    },
    names: { no: 'Normally open contact', nc: 'Normally closed contact', coil: 'Coil', set: 'S (set)', reset: 'R (reset)' },
    blocks: {
      ton: { type: 'S_ODT', ins: ['S', 'TV', 'R'], outs: ['Q', 'BI', 'BCD'], note: 'On-delay timer on a CPU timer. TV is a time constant, S5T#5s.' },
      tof: { type: 'S_OFFDT', ins: ['S', 'TV', 'R'], outs: ['Q', 'BI', 'BCD'], note: 'Off-delay timer on a CPU timer.' },
      ctu: { type: 'S_CU', ins: ['CU', 'S', 'PV', 'R'], outs: ['Q', 'CV', 'CV_BCD'], note: 'Up counter on a CPU counter. PV is C#10.' },
      ctd: { type: 'S_CD', ins: ['CD', 'S', 'PV', 'R'], outs: ['Q', 'CV', 'CV_BCD'], note: 'Down counter on a CPU counter.' },
      move: { type: 'MOVE', ins: ['EN', 'IN'], outs: ['ENO', 'OUT'], note: 'Copies IN to OUT while EN is true.' },
      compare: { type: 'CMP >=I', ins: ['IN1', 'IN2'], outs: [], note: 'Compare box in the rung — also >I, <I, <=I, ==I, <>I.' },
    },
    notes: [
      'Timers here are CPU resources: T1 is the timer itself, not a tag holding one.',
      'A time constant is S5T#5s on these families.',
    ],
  },
  {
    id: 'rockwell-logix',
    vendor: 'Rockwell Automation / Allen-Bradley',
    family: 'ControlLogix / CompactLogix',
    software: 'Studio 5000 Logix Designer',
    controllers: ['CompactLogix 5370 L18', 'CompactLogix 5380 L306ER', 'ControlLogix 5570 L71', 'ControlLogix 5580 L81E'],
    languages: ['Ladder Diagram', 'Function Block', 'Structured Text', 'SFC'],
    addressing: {
      input: 'Local:1:I.Data.0', output: 'Local:2:O.Data.0', memory: 'a BOOL tag',
      timer: 'a TIMER tag', counter: 'a COUNTER tag', data: 'a DINT or REAL tag',
      note: 'Tag based. A program is written against names you declare, and the physical point is reached through the module — Local:1:I.Data.0 — or through an alias tag pointing at it.',
    },
    names: { no: 'XIC — Examine If Closed', nc: 'XIO — Examine If Open', coil: 'OTE — Output Energise', set: 'OTL — Output Latch', reset: 'OTU — Output Unlatch' },
    blocks: {
      ton: { type: 'TON', ins: ['Timer', 'Preset', 'Accum'], outs: ['EN', 'TT', 'DN'], note: 'On-delay. Preset is in milliseconds. DN is the bit most rungs read.', instance: true },
      tof: { type: 'TOF', ins: ['Timer', 'Preset', 'Accum'], outs: ['EN', 'TT', 'DN'], note: 'Off-delay, same structure as TON.', instance: true },
      ctu: { type: 'CTU', ins: ['Counter', 'Preset', 'Accum'], outs: ['CU', 'DN', 'OV'], note: 'Counts up each false-to-true of the rung. DN at Preset.', instance: true },
      ctd: { type: 'CTD', ins: ['Counter', 'Preset', 'Accum'], outs: ['CD', 'DN', 'UN'], note: 'Counts down each false-to-true of the rung.', instance: true },
      move: { type: 'MOV', ins: ['Source', 'Dest'], outs: [], note: 'Copies Source into Dest while the rung is true.' },
      compare: { type: 'GEQ', ins: ['Source A', 'Source B'], outs: [], note: 'Compare — also GRT, LES, LEQ, EQU, NEQ.' },
    },
    notes: [
      'A timer is a TIMER tag; its bits are read as Timer_Name.DN and Timer_Name.TT.',
      'A counter is reset with an RES instruction on the counter tag, not by writing its accumulator.',
      'Presets are in milliseconds: five seconds is 5000.',
    ],
  },
  {
    id: 'rockwell-micro',
    vendor: 'Rockwell Automation / Allen-Bradley',
    family: 'Micro800',
    software: 'Connected Components Workbench',
    controllers: ['Micro820', 'Micro850', 'Micro870'],
    languages: ['Ladder Diagram', 'Function Block', 'Structured Text'],
    addressing: {
      input: '_IO_EM_DI_00', output: '_IO_EM_DO_00', memory: 'a BOOL variable',
      timer: 'a TON instance', counter: 'a CTU instance', data: 'an INT or REAL variable',
      note: 'Variable based, and the embedded I/O carries reserved names — _IO_EM_DI_00 for the first embedded input.',
    },
    names: { no: 'Direct contact', nc: 'Reverse contact', coil: 'Direct coil', set: 'Set coil', reset: 'Reset coil' },
    blocks: {
      ...IEC_BLOCKS,
      ton: { type: 'TON', ins: ['IN', 'PT'], outs: ['Q', 'ET'], note: 'IEC on-delay. PT is a TIME — T#5s.', instance: true },
    },
    notes: ['Micro800 follows IEC 61131-3 blocks rather than the Logix instruction set.'],
  },
  {
    id: 'mitsubishi-fx',
    vendor: 'Mitsubishi Electric',
    family: 'MELSEC FX / iQ-F',
    software: 'GX Works2 / GX Works3',
    controllers: ['FX3U', 'FX3G', 'FX5U', 'FX5UC'],
    languages: ['Ladder', 'Structured Text', 'FBD', 'SFC'],
    addressing: {
      input: 'X0', output: 'Y0', memory: 'M0',
      timer: 'T0', counter: 'C0', data: 'D0',
      note: 'Device letters with a number. Inputs and outputs on FX are octal — X0 to X7, then X10 — which catches people out.',
    },
    names: { no: 'LD — normally open', nc: 'LDI — normally closed', coil: 'OUT', set: 'SET', reset: 'RST' },
    blocks: {
      ton: { type: 'OUT T', ins: ['T device', 'K value'], outs: ['T contact'], note: 'A timer is an OUT to a T device with a K constant: OUT T0 K50 is 5 s on a 100 ms timer.' },
      tof: { type: 'OUT T', ins: ['T device', 'K value'], outs: ['T contact'], note: 'Off-delay is built from a timer and an interlock; FX has no single off-delay instruction.' },
      ctu: { type: 'OUT C', ins: ['C device', 'K value'], outs: ['C contact'], note: 'OUT C0 K10 counts ten rising edges; RST C0 clears it.' },
      ctd: { type: 'OUT C', ins: ['C device', 'K value'], outs: ['C contact'], note: 'Up/down counters are the C200 range on FX.' },
      move: { type: 'MOV', ins: ['S', 'D'], outs: [], note: 'MOV K100 D0 puts 100 in D0.' },
      compare: { type: 'CMP', ins: ['S1', 'S2', 'D'], outs: [], note: 'CMP sets three consecutive bits from D: greater, equal, less.' },
    },
    notes: [
      'A timer value is a K constant in timer units: T0 to T199 are 100 ms, so K50 is five seconds.',
      'X and Y devices are numbered in octal on FX: after X7 comes X10.',
    ],
  },
  {
    id: 'delta-dvp',
    vendor: 'Delta',
    family: 'DVP',
    software: 'WPLSoft / ISPSoft',
    controllers: ['DVP-SS2', 'DVP-SA2', 'DVP-EX2', 'DVP-SV2'],
    languages: ['Ladder', 'Instruction list', 'SFC', 'Structured Text (ISPSoft)'],
    addressing: {
      input: 'X0', output: 'Y0', memory: 'M0',
      timer: 'T0', counter: 'C0', data: 'D0',
      note: 'Device letters with a number, close to the Mitsubishi scheme. X and Y are octal.',
    },
    names: { no: 'LD', nc: 'LDI', coil: 'OUT', set: 'SET', reset: 'RST' },
    blocks: {
      ton: { type: 'TMR', ins: ['T device', 'K value'], outs: ['T contact'], note: 'TMR T0 K50 — 5 s on a 100 ms timer.' },
      tof: { type: 'TMR', ins: ['T device', 'K value'], outs: ['T contact'], note: 'Off-delay is built from a timer and an interlock.' },
      ctu: { type: 'CNT', ins: ['C device', 'K value'], outs: ['C contact'], note: 'CNT C0 K10 counts ten rising edges.' },
      ctd: { type: 'DCNT', ins: ['C device', 'K value'], outs: ['C contact'], note: 'High-speed and up/down counters are the C235 range.' },
      move: { type: 'MOV', ins: ['S', 'D'], outs: [], note: 'MOV K100 D0.' },
      compare: { type: 'CMP', ins: ['S1', 'S2', 'D'], outs: [], note: 'CMP sets three consecutive bits from D.' },
    },
    notes: ['Timer resolution depends on the T range — check the model’s manual before trusting a K value.'],
  },
  {
    id: 'schneider-m221',
    vendor: 'Schneider Electric',
    family: 'Modicon M221 / M241',
    software: 'EcoStruxure Machine Expert (Basic)',
    controllers: ['TM221CE16R', 'TM221CE24R', 'TM241CE24R', 'TM241CE40R'],
    languages: ['Ladder', 'Instruction list', 'Structured Text (M241)', 'FBD (M241)'],
    addressing: {
      input: '%I0.0', output: '%Q0.0', memory: '%M0',
      timer: '%TM0', counter: '%C0', data: '%MW0',
      note: 'IEC-style % addresses. %I0.0 is the first input of the first module; %M0 is a memory bit and %MW0 a memory word.',
    },
    names: { no: 'Normally open contact', nc: 'Normally closed contact', coil: 'Coil', set: 'Set coil', reset: 'Reset coil' },
    blocks: {
      ton: { type: '%TMi (TON)', ins: ['IN', 'Preset'], outs: ['Q'], note: 'A timer block configured as TON, with a time base and a preset.', instance: true },
      tof: { type: '%TMi (TOF)', ins: ['IN', 'Preset'], outs: ['Q'], note: 'The same block configured as TOF.', instance: true },
      ctu: { type: '%Ci', ins: ['CU', 'R', 'Preset'], outs: ['D', 'E'], note: 'Counter block; D is done at the preset.', instance: true },
      ctd: { type: '%Ci', ins: ['CD', 'R', 'Preset'], outs: ['D', 'E'], note: 'The same block counting down.', instance: true },
      move: { type: 'Operate', ins: ['%MW0 := value'], outs: [], note: 'Assignment is written in an operation block on the rung.' },
      compare: { type: 'Compare', ins: ['expression'], outs: [], note: 'A compare block holding an expression such as %MW0 >= 100.' },
    },
    notes: ['On M221 a timer is a configured object (%TM0) with its type and time base set in the block properties.'],
  },
  {
    id: 'omron-nx',
    vendor: 'Omron',
    family: 'NJ / NX',
    software: 'Sysmac Studio',
    controllers: ['NX1P2', 'NX102', 'NJ101', 'NJ501'],
    languages: ['Ladder', 'Structured Text'],
    addressing: {
      input: 'a BOOL variable mapped to the I/O', output: 'a BOOL variable mapped to the I/O',
      memory: 'an internal variable', timer: 'a TON instance', counter: 'a CTU instance',
      data: 'an INT or REAL variable',
      note: 'Variable based and IEC throughout — physical points are mapped to variables in the I/O map rather than addressed in the program.',
    },
    names: { no: 'Normally open contact', nc: 'Normally closed contact', coil: 'Coil', set: 'Set', reset: 'Reset' },
    blocks: { ...IEC_BLOCKS },
    notes: ['Sysmac follows IEC 61131-3, so TON, CTU and MOVE behave as the standard describes.'],
  },
  {
    id: 'iec',
    vendor: 'IEC 61131-3',
    family: 'Any conforming controller',
    software: 'CODESYS and the tools built on it',
    controllers: ['Any CODESYS-based controller'],
    languages: ['LD (ladder)', 'FBD', 'ST', 'IL', 'SFC'],
    addressing: {
      input: '%IX0.0', output: '%QX0.0', memory: '%MX0.0',
      timer: 'a TON instance', counter: 'a CTU instance', data: '%MW0',
      note: 'The standard’s own notation: %IX0.0 for an input bit, %QX0.0 for an output bit, %MW0 for a memory word.',
    },
    names: { no: 'Normally open contact', nc: 'Normally closed contact', coil: 'Coil', set: 'Set coil', reset: 'Reset coil' },
    blocks: { ...IEC_BLOCKS },
    notes: ['Where a vendor is not known, this is the safest thing to write: every conforming tool has these blocks.'],
  },
];

const BY_ID = new Map(DIALECTS.map(d => [d.id, d]));

export const dialectOf = (id: string | undefined): Dialect =>
  BY_ID.get(String(id ?? '')) ?? DIALECTS[DIALECTS.length - 1];

/** The vendors, for the first of the three pickers. */
export const vendors = (): string[] => [...new Set(DIALECTS.map(d => d.vendor))];

/** The families a vendor has here. */
export const familiesOf = (vendor: string): Dialect[] =>
  DIALECTS.filter(d => d.vendor === vendor);

/**
 * What to tell the model about this dialect.
 *
 * Written out rather than summarised: the failure this guards against is a
 * program drawn with a Siemens TON for a Mitsubishi controller, and the only
 * reliable way to stop it is to put this vendor's own vocabulary in front of
 * the model and say that nothing else exists.
 */
export function dialectBriefing(d: Dialect): string {
  const blocks = Object.values(d.blocks).map(b => {
    const pins = [
      ...b.ins.map(p => p),
      ...b.outs.map(p => `${p} (out)`),
    ].join(', ');
    return `  ${b.type} — pins: ${pins}. ${b.note}`;
  }).join('\n');

  return [
    `Vendor: ${d.vendor}`,
    `Family: ${d.family}, programmed in ${d.software}`,
    `Contacts and coils are called: ${d.names.no}; ${d.names.nc}; ${d.names.coil}; ${d.names.set}; ${d.names.reset}`,
    'Addressing:',
    `  input ${d.addressing.input} · output ${d.addressing.output} · memory ${d.addressing.memory}`,
    `  timer ${d.addressing.timer} · counter ${d.addressing.counter} · data ${d.addressing.data}`,
    `  ${d.addressing.note}`,
    'Blocks available:',
    blocks,
    d.notes.length ? `Things to get right:\n${d.notes.map(n => `  - ${n}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}
