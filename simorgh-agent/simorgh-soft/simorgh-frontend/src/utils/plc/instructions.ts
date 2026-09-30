// src/utils/plc/instructions.ts
//
// The instruction catalogue — what the engineer picks from, and what the
// assistant is allowed to use.
//
// This is one table and it does four jobs, which is the reason it is one table
// rather than four lists that drift apart:
//
//   1. It is the **tree on the right of the screen**: the groups, the names
//      and the one-line descriptions, in the order an engineer expects to find
//      them in.
//   2. It is what the **ladder editor inserts**. Clicking `TON` has to put a
//      box on the rung with IN and PT going in and Q and ET coming out, in
//      that order, spelled the way the vendor spells them.
//   3. It is what the **text editor completes and explains**. The same entry
//      supplies the SCL the engineer gets when they accept the completion and
//      the help they get when they hover it.
//   4. It is the **vocabulary the assistant is given**. A model told "use
//      these and nothing else", with the pins written out, produces a program
//      that can be typed in; one left to remember produces a program that
//      reads beautifully and names a block the controller has never heard of.
//
// The contents follow the IEC 61131-3 basic instruction set as Siemens spells
// it in TIA Portal for the S7-1200/1500 families, because that is the software
// this office actually opens and the names differ between vendors — a Siemens
// `TON` is not a Mitsubishi `OUT T0 K50`. `utils/ladder/dialects.ts` holds the
// same knowledge for the vendors this suite draws for; this file is the depth
// behind the Siemens entry in it.
//
// **This is descriptive, not a compiler.** It says what an instruction is
// called, what its pins are and what it does. It does not claim to produce a
// file TIA will import unchanged, and nothing here is checked against a real
// controller. A generated program is a draft for an engineer to read.

/** One pin of an instruction box. */
export interface InstrPin {
  /** The vendor's own name, spelled exactly: IN, PT, Q, ET, CU, PV, CV. */
  name: string;
  /** What it wants — Bool, Time, Int, Variant, ANY_NUM. */
  type: string;
  /** True for a pin leaving the box. */
  out?: boolean;
  /** A pin that may be left unwired. */
  optional?: boolean;
  /** One line on what to put on it. */
  note?: string;
}

/** How an instruction is drawn on a ladder rung. */
export type InstrForm =
  /** In the condition, on the rail: `-| |-`, `-|/|-`, `-|P|-`. */
  | 'contact'
  /** At the right-hand end: `-( )-`, `-(S)`, `-(R)`. */
  | 'coil'
  /** A box in the condition or at the end: TON, ADD, MOVE. */
  | 'box'
  /** An editor command rather than an instruction — a branch, a network. */
  | 'editor';

export interface Instruction {
  /** Stable id. Used by the editor, the assistant and saved programs. */
  id: string;
  /** What the catalogue shows in the Name column. */
  name: string;
  /** What the catalogue shows in the Description column — one line. */
  title: string;
  group: string;
  form: InstrForm;
  /** How it is drawn in the tree: `-| |-`, `-(S)`, or the box's own name. */
  glyph?: string;
  pins?: InstrPin[];
  /**
   * The SCL this inserts, with `${n:name}` where the cursor should stop.
   *
   * Every instruction has one, including the contacts and coils, because a
   * contact *is* something in SCL — it is the term in the condition — and an
   * engineer moving between the two languages is helped far more by being
   * shown that than by being told the question does not apply.
   */
  scl?: string;
  /** What it does and what goes wrong with it. Shown on hover and in the tree. */
  help: string;
  /** Needs its own instance data — a timer, a counter, an edge detector. */
  instance?: boolean;
  /** For a contact: which kind, in the ladder model's own words. */
  contactKind?: 'no' | 'nc' | 'p' | 'n';
  /** For a coil: which kind. */
  coilKind?: 'coil' | 'set' | 'reset' | 'pulse-p' | 'pulse-n';
  /** Families that have it, where it is not in all of them. */
  only?: string[];
}

export interface InstrGroup {
  id: string;
  label: string;
  /** One line under the heading. */
  note: string;
  items: Instruction[];
}

export interface InstrSection {
  id: string;
  label: string;
  groups: InstrGroup[];
}

// ── Shorthands, so the table below reads as a table ─────────────────────────

const i = (type: string, name: string, note?: string): InstrPin => ({ name, type, note });
const o = (type: string, name: string, note?: string): InstrPin => ({ name, type, out: true, note });

// ── Basic instructions ──────────────────────────────────────────────────────

const GENERAL: Instruction[] = [
  {
    id: 'gen.network', name: 'Insert network', title: 'Insert network', group: 'general', form: 'editor',
    help: 'A new, empty network after the one the cursor is in. A network is one '
      + 'rung: one path from the left rail to the right. Splitting logic across '
      + 'networks is how a program is made readable — one idea to a network, and '
      + 'the title says which idea.',
  },
  {
    id: 'gen.box', name: 'Empty box', title: 'Empty box [F8]', group: 'general', form: 'box',
    glyph: '???',
    help: 'A box with no instruction in it yet. Drop it where the instruction '
      + 'belongs and name it afterwards — useful when the shape of the network '
      + 'is clear before the exact block is.',
  },
  {
    id: 'gen.branch.open', name: 'Open branch', title: 'Open branch [Shift+F8]', group: 'general', form: 'editor',
    help: 'Starts a parallel path at the cursor. Two contacts in parallel are an '
      + 'OR: current gets through if either passes. This is how a seal-in is drawn.',
  },
  {
    id: 'gen.branch.close', name: 'Close branch', title: 'Close branch [Shift+F9]', group: 'general', form: 'editor',
    help: 'Brings the parallel path back to the rail. A branch that is opened and '
      + 'never closed is not a rung the controller can be given.',
  },
  {
    id: 'gen.input', name: 'Insert input', title: 'Insert input', group: 'general', form: 'editor',
    help: 'Another input on a box that takes a variable number of them — ADD, '
      + 'AND, MUX. The box grows downwards.',
  },
];

const BIT_LOGIC: Instruction[] = [
  {
    id: 'bit.no', name: '-| |-', title: 'Normally open contact', group: 'bit', form: 'contact',
    glyph: '-| |-', contactKind: 'no',
    pins: [i('Bool', '<operand>')],
    scl: '${1:operand}',
    help: 'Passes current when the operand is TRUE. This is a *test*, not a wire: '
      + 'it reads the operand and nothing else. A normally open contact on a '
      + 'normally closed stop button is the commonest wiring mistake there is — '
      + 'the contact kind follows the signal at the terminal, not the word on the '
      + 'button.',
  },
  {
    id: 'bit.nc', name: '-|/|-', title: 'Normally closed contact', group: 'bit', form: 'contact',
    glyph: '-|/|-', contactKind: 'nc',
    pins: [i('Bool', '<operand>')],
    scl: 'NOT ${1:operand}',
    help: 'Passes current when the operand is FALSE. A stop button wired NC — the '
      + 'safe way, because a broken wire stops the motor — is read with a normally '
      + 'open contact, because the signal is TRUE while the button is not pressed.',
  },
  {
    id: 'bit.not', name: '-|NOT|-', title: 'Invert RLO', group: 'bit', form: 'contact',
    glyph: '-|NOT|-',
    scl: 'NOT (${1:condition})',
    help: 'Turns the result of everything to its left inside out. It tests no '
      + 'operand of its own.',
  },
  {
    id: 'bit.coil', name: '-( )-', title: 'Assignment [Shift+F7]', group: 'bit', form: 'coil',
    glyph: '-( )-', coilKind: 'coil',
    pins: [i('Bool', '<operand>')],
    scl: '${1:operand} := ${2:condition};',
    help: 'Writes the result of the network to the operand — TRUE when current '
      + 'reaches it, FALSE when it does not. Every scan, both ways. Two coils '
      + 'writing the same operand in one program is the bug that looks like the '
      + 'controller ignoring you: the last one to run wins.',
  },
  {
    id: 'bit.coil.neg', name: '-(/)-', title: 'Negate assignment', group: 'bit', form: 'coil',
    glyph: '-(/)-', coilKind: 'coil',
    pins: [i('Bool', '<operand>')],
    scl: '${1:operand} := NOT (${2:condition});',
    help: 'The assignment, inverted: the operand goes FALSE when current reaches '
      + 'the coil.',
  },
  {
    id: 'bit.reset', name: '-(R)', title: 'Reset output', group: 'bit', form: 'coil',
    glyph: '-(R)-', coilKind: 'reset',
    pins: [i('Bool', '<operand>')],
    scl: 'IF ${1:condition} THEN\n    ${2:operand} := FALSE;\nEND_IF;',
    help: 'Sets the operand FALSE when current reaches it, and leaves it alone '
      + 'when it does not. Unlike a coil it does not write every scan, so the '
      + 'operand stays where it was put until something sets it again.',
  },
  {
    id: 'bit.set', name: '-(S)', title: 'Set output', group: 'bit', form: 'coil',
    glyph: '-(S)-', coilKind: 'set',
    pins: [i('Bool', '<operand>')],
    scl: 'IF ${1:condition} THEN\n    ${2:operand} := TRUE;\nEND_IF;',
    help: 'Sets the operand TRUE and leaves it TRUE. It must be paired with a '
      + 'reset somewhere, and where they are both reached in one scan the one '
      + 'further down the program is the one that decides.',
  },
  {
    id: 'bit.set_bf', name: 'SET_BF', title: 'Set bit field', group: 'bit', form: 'coil',
    glyph: '-(SET_BF)-',
    pins: [i('Bool', '<operand>', 'the first bit'), i('UInt', 'n', 'how many')],
    scl: '// SET_BF: set n bits from the first one\nFOR #i := 0 TO ${2:n} - 1 DO\n    ${1:field}[#i] := TRUE;\nEND_FOR;',
    help: 'Sets a run of consecutive bits, starting at the operand. The count is '
      + 'a constant on the coil, not a tag.',
  },
  {
    id: 'bit.reset_bf', name: 'RESET_BF', title: 'Reset bit field', group: 'bit', form: 'coil',
    glyph: '-(RESET_BF)-',
    pins: [i('Bool', '<operand>', 'the first bit'), i('UInt', 'n', 'how many')],
    scl: '// RESET_BF: clear n bits from the first one\nFOR #i := 0 TO ${2:n} - 1 DO\n    ${1:field}[#i] := FALSE;\nEND_FOR;',
    help: 'Clears a run of consecutive bits. The usual first line of a startup '
      + 'block, where a whole command word is put back to zero.',
  },
  {
    id: 'bit.sr', name: 'SR', title: 'Set/reset flip-flop', group: 'bit', form: 'box',
    pins: [i('Bool', 'S'), i('Bool', 'R1'), o('Bool', 'Q')],
    scl: 'IF ${2:reset} THEN\n    ${3:q} := FALSE;\nELSIF ${1:set} THEN\n    ${3:q} := TRUE;\nEND_IF;',
    help: 'A latch where **reset wins**: R1 is the dominant input, so a command '
      + 'to stop beats a command to start arriving in the same scan. That is the '
      + 'one you want for anything that moves.',
  },
  {
    id: 'bit.rs', name: 'RS', title: 'Reset/set flip-flop', group: 'bit', form: 'box',
    pins: [i('Bool', 'R'), i('Bool', 'S1'), o('Bool', 'Q')],
    scl: 'IF ${2:set} THEN\n    ${3:q} := TRUE;\nELSIF ${1:reset} THEN\n    ${3:q} := FALSE;\nEND_IF;',
    help: 'A latch where **set wins**: S1 is dominant. Choose it deliberately — '
      + 'picking the wrong one of RS and SR gives a machine that starts when it '
      + 'was told to stop, and only when both arrive together, which is the '
      + 'hardest kind of fault to catch.',
  },
  {
    id: 'bit.p.contact', name: '-|P|-', title: 'Scan operand for positive signal edge', group: 'bit', form: 'contact',
    glyph: '-|P|-', contactKind: 'p', instance: true,
    pins: [i('Bool', '<operand>'), i('Bool', '<M_BIT>', 'where the last state is kept')],
    scl: '// rising edge of the operand\nIF ${1:operand} AND NOT #${1:operand}_last THEN\n    ;\nEND_IF;\n#${1:operand}_last := ${1:operand};',
    help: 'Passes current for exactly one scan, when the operand goes from FALSE '
      + 'to TRUE. The memory bit under it is where the previous state is kept and '
      + '**must not be used by anything else** — sharing one memory bit between '
      + 'two edges is why one of them stops working.',
  },
  {
    id: 'bit.n.contact', name: '-|N|-', title: 'Scan operand for negative signal edge', group: 'bit', form: 'contact',
    glyph: '-|N|-', contactKind: 'n', instance: true,
    pins: [i('Bool', '<operand>'), i('Bool', '<M_BIT>')],
    scl: '// falling edge of the operand\nIF NOT ${1:operand} AND #${1:operand}_last THEN\n    ;\nEND_IF;\n#${1:operand}_last := ${1:operand};',
    help: 'One scan on the falling edge — TRUE to FALSE. Same rule about the '
      + 'memory bit.',
  },
  {
    id: 'bit.p.coil', name: '-(P)-', title: 'Set operand on positive signal edge', group: 'bit', form: 'coil',
    glyph: '-(P)-', coilKind: 'pulse-p', instance: true,
    pins: [i('Bool', '<operand>'), i('Bool', '<M_BIT>')],
    help: 'Sets the operand TRUE for one scan when the network in front of it '
      + 'goes TRUE. The edge is taken from the *result of the network*, not from '
      + 'a single operand.',
  },
  {
    id: 'bit.n.coil', name: '-(N)-', title: 'Set operand on negative signal edge', group: 'bit', form: 'coil',
    glyph: '-(N)-', coilKind: 'pulse-n', instance: true,
    pins: [i('Bool', '<operand>'), i('Bool', '<M_BIT>')],
    help: 'One scan when the network falls.',
  },
  {
    id: 'bit.p_trig', name: 'P_TRIG', title: 'Scan RLO for positive signal edge', group: 'bit', form: 'box',
    instance: true,
    pins: [i('Bool', 'CLK'), o('Bool', 'Q')],
    scl: '// P_TRIG on the result so far',
    help: 'The box form of the rising-edge scan, taking the result of everything '
      + 'to its left. Its memory bit is the instance under it.',
  },
  {
    id: 'bit.n_trig', name: 'N_TRIG', title: 'Scan RLO for negative signal edge', group: 'bit', form: 'box',
    instance: true,
    pins: [i('Bool', 'CLK'), o('Bool', 'Q')],
    help: 'The box form of the falling-edge scan.',
  },
  {
    id: 'bit.r_trig', name: 'R_TRIG', title: 'Detect positive signal edge', group: 'bit', form: 'box',
    instance: true,
    pins: [i('Bool', 'CLK'), o('Bool', 'Q')],
    scl: '${1:edge}(CLK := ${2:signal});\nIF ${1:edge}.Q THEN\n    ;\nEND_IF;',
    help: 'The IEC edge detector, as a function block with its own instance. '
      + 'Prefer this in SCL and in anything reusable: the instance travels with '
      + 'the call, so an FB used for ten motors gets ten edges rather than one '
      + 'shared memory bit and a fault that appears only when two start together.',
  },
  {
    id: 'bit.f_trig', name: 'F_TRIG', title: 'Detect negative signal edge', group: 'bit', form: 'box',
    instance: true,
    pins: [i('Bool', 'CLK'), o('Bool', 'Q')],
    scl: '${1:edge}(CLK := ${2:signal});\nIF ${1:edge}.Q THEN\n    ;\nEND_IF;',
    help: 'The IEC falling-edge detector, with its own instance.',
  },
];

const TIMERS: Instruction[] = [
  {
    id: 'tmr.tp', name: 'TP', title: 'Generate pulse', group: 'timer', form: 'box', instance: true,
    pins: [i('Bool', 'IN'), i('Time', 'PT', 'how long, e.g. T#5s'), o('Bool', 'Q'), o('Time', 'ET')],
    scl: '${1:pulse}(IN := ${2:trigger}, PT := ${3:T#5s});\n// ${1:pulse}.Q is TRUE for PT once IN goes TRUE',
    help: 'Q goes TRUE for exactly PT when IN rises, and stays TRUE for the whole '
      + 'time **whatever IN does afterwards**. That is what makes it a pulse: a '
      + 'button tapped for 10 ms still gives a full 2-second horn.',
  },
  {
    id: 'tmr.ton', name: 'TON', title: 'Generate on-delay', group: 'timer', form: 'box', instance: true,
    pins: [i('Bool', 'IN'), i('Time', 'PT'), o('Bool', 'Q'), o('Time', 'ET')],
    scl: '${1:delay}(IN := ${2:condition}, PT := ${3:T#5s});\nIF ${1:delay}.Q THEN\n    ;\nEND_IF;',
    help: 'Q goes TRUE after IN has been TRUE continuously for PT. IN dropping at '
      + 'any point puts ET back to zero and starts again. The workhorse: a '
      + 'start-up warning, a debounce, a "has it really failed" filter.',
  },
  {
    id: 'tmr.tof', name: 'TOF', title: 'Generate off-delay', group: 'timer', form: 'box', instance: true,
    pins: [i('Bool', 'IN'), i('Time', 'PT'), o('Bool', 'Q'), o('Time', 'ET')],
    scl: '${1:offdelay}(IN := ${2:condition}, PT := ${3:T#5s});',
    help: 'Q follows IN up immediately and stays TRUE for PT after IN falls. A fan '
      + 'that runs on after the motor stops, a lamp that holds for a moment.',
  },
  {
    id: 'tmr.tonr', name: 'TONR', title: 'Time accumulator', group: 'timer', form: 'box', instance: true,
    pins: [i('Bool', 'IN'), i('Bool', 'R'), i('Time', 'PT'), o('Bool', 'Q'), o('Time', 'ET')],
    scl: '${1:hours}(IN := ${2:running}, R := ${3:reset}, PT := ${4:T#8h});',
    help: 'Adds up the time IN has been TRUE, across as many separate periods as '
      + 'it takes, and only R puts it back to zero. Running hours, total time in '
      + 'fault, how long a valve has been open today.',
  },
  {
    id: 'tmr.tp.coil', name: '-(TP)-', title: 'Start pulse timer', group: 'timer', form: 'coil',
    glyph: '-(TP)-', instance: true, pins: [i('Time', '<PT>')],
    help: 'The coil form: the timer is started by the network and its Q is read '
      + 'elsewhere from the timer\'s own DB.',
  },
  {
    id: 'tmr.ton.coil', name: '-(TON)-', title: 'Start on-delay timer', group: 'timer', form: 'coil',
    glyph: '-(TON)-', instance: true, pins: [i('Time', '<PT>')],
    help: 'The coil form of the on-delay.',
  },
  {
    id: 'tmr.tof.coil', name: '-(TOF)-', title: 'Start off-delay timer', group: 'timer', form: 'coil',
    glyph: '-(TOF)-', instance: true, pins: [i('Time', '<PT>')],
    help: 'The coil form of the off-delay.',
  },
  {
    id: 'tmr.tonr.coil', name: '-(TONR)-', title: 'Time accumulator', group: 'timer', form: 'coil',
    glyph: '-(TONR)-', instance: true, pins: [i('Time', '<PT>')],
    help: 'The coil form of the accumulator.',
  },
  {
    id: 'tmr.rt', name: '-(RT)-', title: 'Reset timer', group: 'timer', form: 'coil',
    glyph: '-(RT)-', pins: [i('IEC_TIMER', '<timer>')],
    scl: 'RESET_TIMER(${1:timer});',
    help: 'Puts a timer back to zero from somewhere else in the program — the '
      + 'reset a TON does not have.',
  },
  {
    id: 'tmr.pt', name: '-(PT)-', title: 'Load time duration', group: 'timer', form: 'coil',
    glyph: '-(PT)-', pins: [i('IEC_TIMER', '<timer>'), i('Time', '<PT>')],
    scl: 'PRESET_TIMER(PT := ${2:T#5s}, TIMER := ${1:timer});',
    help: 'Writes a new preset into a running timer — a recipe changing a dwell '
      + 'time without the block being rebuilt.',
  },
];

const COUNTERS: Instruction[] = [
  {
    id: 'cnt.ctu', name: 'CTU', title: 'Count up', group: 'counter', form: 'box', instance: true,
    pins: [i('Bool', 'CU'), i('Bool', 'R'), i('Int', 'PV'), o('Bool', 'Q'), o('Int', 'CV')],
    scl: '${1:counter}(CU := ${2:pulse}, R := ${3:reset}, PV := ${4:10});\nIF ${1:counter}.QU THEN\n    ;\nEND_IF;',
    help: 'CV goes up by one on every rising edge of CU. Q is TRUE once CV has '
      + 'reached PV, and CV keeps climbing past it — it does not stop and it does '
      + 'not wrap until the type\'s limit. R clears it.',
  },
  {
    id: 'cnt.ctd', name: 'CTD', title: 'Count down', group: 'counter', form: 'box', instance: true,
    pins: [i('Bool', 'CD'), i('Bool', 'LD'), i('Int', 'PV'), o('Bool', 'Q'), o('Int', 'CV')],
    scl: '${1:counter}(CD := ${2:pulse}, LD := ${3:load}, PV := ${4:10});',
    help: 'CV goes down by one on every rising edge of CD, and Q is TRUE at or '
      + 'below zero. LD loads PV into CV — that is how it is started, and '
      + 'forgetting it leaves a counter counting down from zero.',
  },
  {
    id: 'cnt.ctud', name: 'CTUD', title: 'Count up and down', group: 'counter', form: 'box', instance: true,
    pins: [
      i('Bool', 'CU'), i('Bool', 'CD'), i('Bool', 'R'), i('Bool', 'LD'), i('Int', 'PV'),
      o('Bool', 'QU'), o('Bool', 'QD'), o('Int', 'CV'),
    ],
    scl: '${1:counter}(CU := ${2:in}, CD := ${3:out}, R := ${4:reset}, LD := FALSE, PV := ${5:10});',
    help: 'Both at once, with a flag at each end: QU at or above PV, QD at or '
      + 'below zero. Parts in a buffer, bottles between two sensors, cars in a '
      + 'car park.',
  },
];

const COMPARE: Instruction[] = [
  {
    id: 'cmp.eq', name: 'CMP ==', title: 'Equal', group: 'compare', form: 'contact',
    glyph: '-|==|-', pins: [i('ANY', 'IN1'), i('ANY', 'IN2')],
    scl: '${1:a} = ${2:b}',
    help: 'Passes current when the two are equal. Both must be the same data '
      + 'type. **Never compare two Reals for equality** — 0.1 + 0.2 is not 0.3 in '
      + 'floating point, on any controller ever built. Compare a difference '
      + 'against a tolerance instead.',
  },
  {
    id: 'cmp.ne', name: 'CMP <>', title: 'Not equal', group: 'compare', form: 'contact',
    glyph: '-|<>|-', pins: [i('ANY', 'IN1'), i('ANY', 'IN2')], scl: '${1:a} <> ${2:b}',
    help: 'Passes when the two differ.',
  },
  {
    id: 'cmp.ge', name: 'CMP >=', title: 'Greater or equal', group: 'compare', form: 'contact',
    glyph: '-|>=|-', pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2')], scl: '${1:a} >= ${2:b}',
    help: 'Passes when the first is at least the second.',
  },
  {
    id: 'cmp.le', name: 'CMP <=', title: 'Less or equal', group: 'compare', form: 'contact',
    glyph: '-|<=|-', pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2')], scl: '${1:a} <= ${2:b}',
    help: 'Passes when the first is at most the second.',
  },
  {
    id: 'cmp.gt', name: 'CMP >', title: 'Greater than', group: 'compare', form: 'contact',
    glyph: '-|>|-', pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2')], scl: '${1:a} > ${2:b}',
    help: 'Passes when the first is above the second.',
  },
  {
    id: 'cmp.lt', name: 'CMP <', title: 'Less than', group: 'compare', form: 'contact',
    glyph: '-|<|-', pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2')], scl: '${1:a} < ${2:b}',
    help: 'Passes when the first is below the second.',
  },
  {
    id: 'cmp.in_range', name: 'IN_RANGE', title: 'Value within range', group: 'compare', form: 'box',
    pins: [i('ANY_NUM', 'MIN'), i('ANY_NUM', 'VAL'), i('ANY_NUM', 'MAX'), o('Bool', 'OUT')],
    scl: '(${1:min} <= ${2:value}) AND (${2:value} <= ${3:max})',
    help: 'TRUE when MIN ≤ VAL ≤ MAX, both ends included. One box instead of two '
      + 'comparators and an AND, and it reads as what it means.',
  },
  {
    id: 'cmp.out_range', name: 'OUT_RANGE', title: 'Value outside range', group: 'compare', form: 'box',
    pins: [i('ANY_NUM', 'MIN'), i('ANY_NUM', 'VAL'), i('ANY_NUM', 'MAX'), o('Bool', 'OUT')],
    scl: '(${2:value} < ${1:min}) OR (${3:max} < ${2:value})',
    help: 'TRUE when the value is outside the band — an alarm, drawn the way it '
      + 'is spoken.',
  },
  {
    id: 'cmp.ok', name: '-|OK|-', title: 'Check validity', group: 'compare', form: 'contact',
    glyph: '-|OK|-', pins: [i('Real', '<operand>')],
    help: 'Passes when a floating-point number is a real number — not NaN, not '
      + 'infinity. Worth having in front of anything that divides by a measured '
      + 'value.',
  },
  {
    id: 'cmp.not_ok', name: '-|NOT_OK|-', title: 'Check invalidity', group: 'compare', form: 'contact',
    glyph: '-|NOT_OK|-', pins: [i('Real', '<operand>')],
    help: 'Passes when the floating-point number is invalid — the alarm side of OK.',
  },
];

const MATH: Instruction[] = [
  {
    id: 'math.calculate', name: 'CALCULATE', title: 'Calculate', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := ${2:expression};',
    help: 'A whole expression in one box — you type the formula and it shows the '
      + 'inputs it needs. Far better than six boxes wired together, which is the '
      + 'same arithmetic written so that nobody can check it.',
  },
  {
    id: 'math.add', name: 'ADD', title: 'Add', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := ${2:a} + ${3:b};',
    help: 'Adds, with as many inputs as you insert. The result goes to OUT and '
      + 'everything must be one type — mixing Int and Real is an error, not a '
      + 'conversion.',
  },
  {
    id: 'math.sub', name: 'SUB', title: 'Subtract', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := ${2:a} - ${3:b};', help: 'IN1 minus IN2.',
  },
  {
    id: 'math.mul', name: 'MUL', title: 'Multiply', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := ${2:a} * ${3:b};',
    help: 'Multiplies. Watch the range: two Ints that each fit can give a product '
      + 'that does not, and it wraps silently.',
  },
  {
    id: 'math.div', name: 'DIV', title: 'Divide', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: 'IF ${3:b} <> 0 THEN\n    ${1:out} := ${2:a} / ${3:b};\nEND_IF;',
    help: 'Integer division truncates — 7 / 2 is 3, not 3.5. **Guard the divisor**: '
      + 'dividing an Int by zero faults the CPU, and a measured value is zero '
      + 'exactly when the sensor has failed.',
  },
  {
    id: 'math.mod', name: 'MOD', title: 'Return remainder of division', group: 'math', form: 'box',
    pins: [i('ANY_INT', 'IN1'), i('ANY_INT', 'IN2'), o('ANY_INT', 'OUT')],
    scl: '${1:out} := ${2:a} MOD ${3:b};',
    help: 'The remainder. How "every tenth part" and "which bay of eight" are '
      + 'written.',
  },
  {
    id: 'math.neg', name: 'NEG', title: 'Create twos complement', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN'), o('ANY_NUM', 'OUT')], scl: '${1:out} := -${2:in};',
    help: 'Changes the sign.',
  },
  {
    id: 'math.inc', name: 'INC', title: 'Increment', group: 'math', form: 'box',
    pins: [i('ANY_INT', 'IN/OUT'), ], scl: '${1:value} := ${1:value} + 1;',
    help: 'Adds one to the operand in place. In a network with no edge in front of '
      + 'it this counts once per scan — thousands a second, which is almost never '
      + 'what was meant.',
  },
  {
    id: 'math.dec', name: 'DEC', title: 'Decrement', group: 'math', form: 'box',
    pins: [i('ANY_INT', 'IN/OUT')], scl: '${1:value} := ${1:value} - 1;',
    help: 'Takes one off, in place. Same warning about the scan.',
  },
  {
    id: 'math.abs', name: 'ABS', title: 'Form absolute value', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN'), o('ANY_NUM', 'OUT')], scl: '${1:out} := ABS(${2:in});',
    help: 'Drops the sign. The usual way to compare a deviation against a '
      + 'tolerance without caring which side it is on.',
  },
  {
    id: 'math.min', name: 'MIN', title: 'Get minimum', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := MIN(IN1 := ${2:a}, IN2 := ${3:b});', help: 'The smallest of its inputs.',
  },
  {
    id: 'math.max', name: 'MAX', title: 'Get maximum', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'IN1'), i('ANY_NUM', 'IN2'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := MAX(IN1 := ${2:a}, IN2 := ${3:b});', help: 'The largest of its inputs.',
  },
  {
    id: 'math.limit', name: 'LIMIT', title: 'Set limit value', group: 'math', form: 'box',
    pins: [i('ANY_NUM', 'MN'), i('ANY_NUM', 'IN'), i('ANY_NUM', 'MX'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := LIMIT(MN := ${2:min}, IN := ${3:value}, MX := ${4:max});',
    help: 'Clamps a value into a band. The last thing before a setpoint leaves the '
      + 'program: whatever the HMI sent, the drive gets something it can take.',
  },
  {
    id: 'math.sqr', name: 'SQR', title: 'Form square', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := SQR(${2:in});', help: 'The square.',
  },
  {
    id: 'math.sqrt', name: 'SQRT', title: 'Form square root', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := SQRT(${2:in});',
    help: 'The square root. Negative in gives an invalid float, so guard it — a '
      + 'flow calculated from a differential pressure does go negative.',
  },
  {
    id: 'math.ln', name: 'LN', title: 'Form natural logarithm', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := LN(${2:in});', help: 'Natural log.',
  },
  {
    id: 'math.exp', name: 'EXP', title: 'Form exponential value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := EXP(${2:in});', help: 'e to the power of IN.',
  },
  {
    id: 'math.sin', name: 'SIN', title: 'Form sine value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := SIN(${2:radians});',
    help: 'Sine. The angle is in **radians**, not degrees — multiply degrees by '
      + 'PI/180 first.',
  },
  {
    id: 'math.cos', name: 'COS', title: 'Form cosine value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := COS(${2:radians});', help: 'Cosine, in radians.',
  },
  {
    id: 'math.tan', name: 'TAN', title: 'Form tangent value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := TAN(${2:radians});', help: 'Tangent, in radians.',
  },
  {
    id: 'math.asin', name: 'ASIN', title: 'Form arcsine value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := ASIN(${2:in});', help: 'Arcsine; IN must be −1…1.',
  },
  {
    id: 'math.acos', name: 'ACOS', title: 'Form arccosine value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := ACOS(${2:in});', help: 'Arccosine; IN must be −1…1.',
  },
  {
    id: 'math.atan', name: 'ATAN', title: 'Form arctangent value', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := ATAN(${2:in});', help: 'Arctangent, giving radians.',
  },
  {
    id: 'math.frac', name: 'FRAC', title: 'Return fraction', group: 'math', form: 'box',
    pins: [i('Real', 'IN'), o('Real', 'OUT')], scl: '${1:out} := FRAC(${2:in});',
    help: 'What is after the decimal point.',
  },
  {
    id: 'math.expt', name: 'EXPT', title: 'Exponentiate', group: 'math', form: 'box',
    pins: [i('Real', 'IN1'), i('ANY_NUM', 'IN2'), o('Real', 'OUT')],
    scl: '${1:out} := ${2:base} ** ${3:power};', help: 'IN1 to the power of IN2.',
  },
];

const MOVE: Instruction[] = [
  {
    id: 'mov.move', name: 'MOVE', title: 'Move value', group: 'move', form: 'box',
    pins: [i('Variant', 'IN'), o('Variant', 'OUT1')],
    scl: '${1:destination} := ${2:source};',
    help: 'Copies one value. It will copy between different types and it will '
      + 'copy a whole structure, and where the types differ it copies the bits — '
      + 'which is the right thing for a structure and the wrong thing for a '
      + 'number. Use CONVERT when the meaning has to survive, not just the bits.',
  },
  {
    id: 'mov.blk', name: 'MOVE_BLK', title: 'Move block', group: 'move', form: 'box',
    pins: [i('Array', 'IN'), i('DInt', 'COUNT'), o('Array', 'OUT')],
    scl: 'MOVE_BLK(IN := ${1:source}[${2:0}], COUNT := ${3:10}, OUT => ${4:dest}[${5:0}]);',
    help: 'Copies a run of array elements. Both arrays must be the same element '
      + 'type, and COUNT is elements, not bytes.',
  },
  {
    id: 'mov.ublk', name: 'UMOVE_BLK', title: 'Move block uninterruptible', group: 'move', form: 'box',
    pins: [i('Array', 'IN'), i('DInt', 'COUNT'), o('Array', 'OUT')],
    scl: 'UMOVE_BLK(IN := ${1:source}[0], COUNT := ${2:10}, OUT => ${3:dest}[0]);',
    help: 'The same copy, with interrupts held off so the destination is never '
      + 'half-written. Use it when an interrupt reads what this writes; it costs '
      + 'scan time, so not otherwise.',
  },
  {
    id: 'mov.blk_variant', name: 'MOVE_BLK_VARIANT', title: 'Move block (Variant)', group: 'move', form: 'box',
    pins: [i('Variant', 'SRC'), i('DInt', 'COUNT'), i('DInt', 'SRC_INDEX'), i('DInt', 'DEST_INDEX'),
      o('Int', 'RET_VAL'), o('Variant', 'DEST')],
    help: 'Copying where the arrays are not known until it runs — an array handed '
      + 'in as a Variant. It checks the types at run time and reports through '
      + 'RET_VAL instead of faulting.',
  },
  {
    id: 'mov.fill', name: 'FILL_BLK', title: 'Fill block', group: 'move', form: 'box',
    pins: [i('Variant', 'IN'), i('DInt', 'COUNT'), o('Array', 'OUT')],
    scl: 'FILL_BLK(IN := ${1:0}, COUNT := ${2:10}, OUT => ${3:array}[0]);',
    help: 'Writes one value into a run of array elements — how a buffer is cleared.',
  },
  {
    id: 'mov.ufill', name: 'UFILL_BLK', title: 'Fill block uninterruptible', group: 'move', form: 'box',
    pins: [i('Variant', 'IN'), i('DInt', 'COUNT'), o('Array', 'OUT')],
    help: 'The uninterruptible fill.',
  },
  {
    id: 'mov.swap', name: 'SWAP', title: 'Swap', group: 'move', form: 'box',
    pins: [i('ANY_BIT', 'IN'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := SWAP(${2:in});',
    help: 'Reverses the byte order of a Word or DWord. This is what to reach for '
      + 'when a value from another device reads as nonsense but the right nonsense '
      + '— big-endian against little-endian.',
  },
  {
    id: 'mov.serialize', name: 'Serialize', title: 'Serialize', group: 'move', form: 'box',
    pins: [i('Variant', 'SRC_VARIABLE'), i('DInt', 'POS'), o('Int', 'RET_VAL'), o('Variant', 'DEST_ARRAY')],
    help: 'Flattens a structure into a byte array, for sending down a link or '
      + 'writing to a file.',
  },
  {
    id: 'mov.deserialize', name: 'Deserialize', title: 'Deserialize', group: 'move', form: 'box',
    pins: [i('Variant', 'SRC_ARRAY'), i('DInt', 'POS'), o('Int', 'RET_VAL'), o('Variant', 'DEST_VARIABLE')],
    help: 'The other way: a byte array back into a structure.',
  },
];

const CONVERT: Instruction[] = [
  {
    id: 'cnv.convert', name: 'CONVERT', title: 'Convert value', group: 'convert', form: 'box',
    pins: [i('ANY', 'IN'), o('ANY', 'OUT')],
    scl: '${1:out} := ${2:TYPE}_TO_${3:TYPE}(${4:in});',
    help: 'Changes the type and keeps the **meaning** — 5 as an Int becomes 5.0 as '
      + 'a Real. That is the difference from MOVE, which keeps the bits. In SCL it '
      + 'is written as `INT_TO_REAL(...)`, `REAL_TO_DINT(...)`.',
  },
  {
    id: 'cnv.round', name: 'ROUND', title: 'Round numerical value', group: 'convert', form: 'box',
    pins: [i('Real', 'IN'), o('ANY_INT', 'OUT')], scl: '${1:out} := ROUND(${2:in});',
    help: 'To the nearest whole number, and **to the even one on a tie** — 0.5 '
      + 'goes to 0 and 1.5 goes to 2. That is the IEC rule and it surprises '
      + 'everybody once.',
  },
  {
    id: 'cnv.ceil', name: 'CEIL', title: 'Generate next higher integer', group: 'convert', form: 'box',
    pins: [i('Real', 'IN'), o('ANY_INT', 'OUT')], scl: '${1:out} := CEIL(${2:in});', help: 'Always upwards.',
  },
  {
    id: 'cnv.floor', name: 'FLOOR', title: 'Generate next lower integer', group: 'convert', form: 'box',
    pins: [i('Real', 'IN'), o('ANY_INT', 'OUT')], scl: '${1:out} := FLOOR(${2:in});', help: 'Always downwards.',
  },
  {
    id: 'cnv.trunc', name: 'TRUNC', title: 'Truncate numerical value', group: 'convert', form: 'box',
    pins: [i('Real', 'IN'), o('ANY_INT', 'OUT')], scl: '${1:out} := TRUNC(${2:in});',
    help: 'Throws the fraction away — towards zero, so −2.7 becomes −2.',
  },
  {
    id: 'cnv.scale_x', name: 'SCALE_X', title: 'Scale', group: 'convert', form: 'box',
    pins: [i('ANY_NUM', 'MIN'), i('Real', 'VALUE'), i('ANY_NUM', 'MAX'), o('ANY_NUM', 'OUT')],
    scl: '${1:out} := SCALE_X(MIN := ${2:0.0}, VALUE := ${3:norm}, MAX := ${4:100.0});',
    help: 'Turns a 0.0…1.0 fraction into engineering units. The second half of '
      + 'reading an analogue input: NORM_X first, then SCALE_X.',
  },
  {
    id: 'cnv.norm_x', name: 'NORM_X', title: 'Normalize', group: 'convert', form: 'box',
    pins: [i('ANY_NUM', 'MIN'), i('ANY_NUM', 'VALUE'), i('ANY_NUM', 'MAX'), o('Real', 'OUT')],
    scl: '${1:norm} := NORM_X(MIN := ${2:0}, VALUE := ${3:rawValue}, MAX := ${4:27648});',
    help: 'Turns a raw value into a 0.0…1.0 fraction. 0…27648 is the Siemens range '
      + 'for a unipolar analogue input, and 4–20 mA on a 0–20 mA card starts at '
      + '5530, not 0 — a scaling that reads 20 % with the loop dead is this '
      + 'mistake.',
  },
];

const PROGRAM_CONTROL: Instruction[] = [
  {
    id: 'ctl.jmp', name: '-(JMP)', title: 'Jump if RLO = 1', group: 'control', form: 'coil',
    glyph: '-(JMP)', pins: [i('LABEL', '<label>')],
    scl: 'IF ${1:condition} THEN\n    // ...\nEND_IF;',
    help: 'Jumps forward to a label when the network is TRUE, skipping everything '
      + 'between. The networks skipped **keep their outputs as they were** — a '
      + 'jumped-over coil does not go FALSE, it freezes, and that is the trap.',
  },
  {
    id: 'ctl.jmpn', name: '-(JMPN)', title: 'Jump if RLO = 0', group: 'control', form: 'coil',
    glyph: '-(JMPN)', pins: [i('LABEL', '<label>')],
    help: 'Jumps when the network is FALSE.',
  },
  {
    id: 'ctl.label', name: 'LABEL', title: 'Jump label', group: 'control', form: 'editor',
    help: 'Where a jump lands. It sits at the top of a network and is local to the '
      + 'block.',
  },
  {
    id: 'ctl.jmp_list', name: 'JMP_LIST', title: 'Define jump list', group: 'control', form: 'box',
    pins: [i('UInt', 'K'), o('LABEL', 'DEST0'), o('LABEL', 'DEST1')],
    help: 'Jumps to the K-th label in a list — a state machine written as a jump '
      + 'table.',
  },
  {
    id: 'ctl.switch', name: 'SWITCH', title: 'Jump distributor', group: 'control', form: 'box',
    pins: [i('ANY', 'K'), o('LABEL', 'DEST0'), o('LABEL', 'ELSE')],
    scl: 'CASE ${1:state} OF\n    0:\n        ;\n    1:\n        ;\n    ELSE\n        ;\nEND_CASE;',
    help: 'Compares K against a list and jumps to the first that matches. CASE is '
      + 'the SCL equivalent and is far easier to read.',
  },
  {
    id: 'ctl.ret', name: '-(RET)', title: 'Return', group: 'control', form: 'coil',
    glyph: '-(RET)', scl: 'RETURN;',
    help: 'Leaves the block now and goes back to whatever called it. Everything '
      + 'after it is skipped, with the same freezing of outputs as a jump.',
  },
  {
    id: 'ctl.re_trigr', name: 'RE_TRIGR', title: 'Restart cycle monitoring time', group: 'control', form: 'box',
    scl: 'RE_TRIGR();',
    help: 'Restarts the watchdog. For the rare long loop that is genuinely meant '
      + 'to take that long — not as a way to silence a scan that has grown too '
      + 'slow, which is a fault being hidden rather than fixed.',
  },
  {
    id: 'ctl.stp', name: 'STP', title: 'Exit program', group: 'control', form: 'box',
    scl: 'STP();',
    help: 'Puts the CPU into STOP. Outputs go to their configured safe state and '
      + 'the machine stops dead. Rarely the right answer: a controlled shutdown '
      + 'in the program almost always is.',
  },
  {
    id: 'ctl.get_error', name: 'GET_ERROR', title: 'Get error locally', group: 'control', form: 'box',
    pins: [o('ErrorStruct', 'ERROR')],
    scl: 'GET_ERROR(${1:errorInfo});',
    help: 'The full description of the last error in this block, so it can be '
      + 'handled here instead of stopping the CPU.',
  },
  {
    id: 'ctl.get_err_id', name: 'GET_ERR_ID', title: 'Get error ID locally', group: 'control', form: 'box',
    pins: [o('Word', 'ID')],
    scl: '${1:errId} := GET_ERR_ID();',
    help: 'Just the error number — cheaper than GET_ERROR where only "did it '
      + 'work" is wanted.',
  },
  {
    id: 'ctl.endis_pw', name: 'ENDIS_PW', title: 'Limit and enable password legitimation', group: 'control', form: 'box',
    pins: [i('Bool', 'REQ'), i('Bool', 'F_PWD'), i('Bool', 'FULL_PWD'), i('Bool', 'R_PWD'), i('Bool', 'HMI_PWD'),
      o('Int', 'RET_VAL')],
    help: 'Turns the CPU\'s passwords on and off from the program.',
  },
];

const WORD_LOGIC: Instruction[] = [
  {
    id: 'wl.and', name: 'AND', title: 'AND logic operation', group: 'word', form: 'box',
    pins: [i('ANY_BIT', 'IN1'), i('ANY_BIT', 'IN2'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := ${2:a} AND ${3:b};',
    help: 'Bit by bit across two words — not the AND of a ladder rung. The usual '
      + 'use is masking: AND with 16#00FF keeps the low byte and clears the rest.',
  },
  {
    id: 'wl.or', name: 'OR', title: 'OR logic operation', group: 'word', form: 'box',
    pins: [i('ANY_BIT', 'IN1'), i('ANY_BIT', 'IN2'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := ${2:a} OR ${3:b};', help: 'Bit by bit OR — how bits are set in a word.',
  },
  {
    id: 'wl.xor', name: 'XOR', title: 'EXCLUSIVE OR logic operation', group: 'word', form: 'box',
    pins: [i('ANY_BIT', 'IN1'), i('ANY_BIT', 'IN2'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := ${2:a} XOR ${3:b};',
    help: 'Bits that differ come out TRUE. XOR a word against its previous value '
      + 'and every bit that changed is marked — a change detector for a whole word.',
  },
  {
    id: 'wl.invert', name: 'INVERT', title: 'Create ones complement', group: 'word', form: 'box',
    pins: [i('ANY_BIT', 'IN'), o('ANY_BIT', 'OUT')], scl: '${1:out} := NOT ${2:in};',
    help: 'Every bit turned over.',
  },
  {
    id: 'wl.deco', name: 'DECO', title: 'Decode', group: 'word', form: 'box',
    pins: [i('UInt', 'IN'), o('ANY_BIT', 'OUT')], scl: '${1:out} := DECO(IN := ${2:bitNumber});',
    help: 'Sets the bit whose number is IN and clears the rest — a number turned '
      + 'into a one-of-n selection.',
  },
  {
    id: 'wl.enco', name: 'ENCO', title: 'Encode', group: 'word', form: 'box',
    pins: [i('ANY_BIT', 'IN'), o('Int', 'OUT')], scl: '${1:out} := ENCO(IN := ${2:word});',
    help: 'The number of the **lowest** set bit. With no bits set it gives −1, '
      + 'which is worth testing for.',
  },
  {
    id: 'wl.sel', name: 'SEL', title: 'Select', group: 'word', form: 'box',
    pins: [i('Bool', 'G'), i('ANY', 'IN0'), i('ANY', 'IN1'), o('ANY', 'OUT')],
    scl: '${1:out} := SEL(G := ${2:pick}, IN0 := ${3:whenFalse}, IN1 := ${4:whenTrue});',
    help: 'One of two, chosen by a Bool. An IF with one value on each side, in a '
      + 'box.',
  },
  {
    id: 'wl.mux', name: 'MUX', title: 'Multiplex', group: 'word', form: 'box',
    pins: [i('UInt', 'K'), i('ANY', 'IN0'), i('ANY', 'IN1'), i('ANY', 'ELSE'), o('ANY', 'OUT')],
    scl: '${1:out} := MUX(K := ${2:index}, IN0 := ${3:a}, IN1 := ${4:b}, IN2 := ${5:c});',
    help: 'One of many, chosen by a number. **Wire ELSE**: an index outside the '
      + 'list otherwise leaves OUT untouched, which reads as the program having '
      + 'stopped responding.',
  },
  {
    id: 'wl.demux', name: 'DEMUX', title: 'Demultiplex', group: 'word', form: 'box',
    pins: [i('UInt', 'K'), i('ANY', 'IN'), o('ANY', 'OUT0'), o('ANY', 'OUT1'), o('ANY', 'ELSE')],
    help: 'One value out to one of many outputs, chosen by K.',
  },
];

const SHIFT_ROTATE: Instruction[] = [
  {
    id: 'sr.shr', name: 'SHR', title: 'Shift right', group: 'shift', form: 'box',
    pins: [i('ANY_BIT', 'IN'), i('UInt', 'N'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := SHR(IN := ${2:value}, N := ${3:1});',
    help: 'Moves the bits N places right; zeros come in at the top and what falls '
      + 'off the bottom is gone. On an unsigned value that is a divide by two per '
      + 'place.',
  },
  {
    id: 'sr.shl', name: 'SHL', title: 'Shift left', group: 'shift', form: 'box',
    pins: [i('ANY_BIT', 'IN'), i('UInt', 'N'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := SHL(IN := ${2:value}, N := ${3:1});',
    help: 'Moves the bits N places left, zeros in at the bottom. A multiply by two '
      + 'per place — until a bit falls off the top, which is silent.',
  },
  {
    id: 'sr.ror', name: 'ROR', title: 'Rotate right', group: 'shift', form: 'box',
    pins: [i('ANY_BIT', 'IN'), i('UInt', 'N'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := ROR(IN := ${2:value}, N := ${3:1});',
    help: 'Like the shift, except the bits that fall off one end come back in at '
      + 'the other. Nothing is lost — a rotating light pattern, a round-robin.',
  },
  {
    id: 'sr.rol', name: 'ROL', title: 'Rotate left', group: 'shift', form: 'box',
    pins: [i('ANY_BIT', 'IN'), i('UInt', 'N'), o('ANY_BIT', 'OUT')],
    scl: '${1:out} := ROL(IN := ${2:value}, N := ${3:1});', help: 'Rotate the other way.',
  },
];

// ── Extended instructions ───────────────────────────────────────────────────
// Not the whole of what a 1500 has — that is a book — but the ones an office
// doing switchgear and plant control reaches for often enough that having to
// leave the page to look them up is what stops them being used.

const DATE_TIME: Instruction[] = [
  {
    id: 'dt.t_conv', name: 'T_CONV', title: 'Convert times', group: 'datetime', form: 'box',
    pins: [i('ANY', 'IN'), o('ANY', 'OUT')], scl: '${1:out} := ${2:TIME}_TO_${3:DINT}(${4:in});',
    help: 'Between Time, LTime, DInt and the rest. A Time is milliseconds in a '
      + 'DInt underneath, which is what makes the conversion exact.',
  },
  {
    id: 'dt.t_add', name: 'T_ADD', title: 'Add times', group: 'datetime', form: 'box',
    pins: [i('ANY', 'IN1'), i('Time', 'IN2'), o('ANY', 'OUT')],
    scl: '${1:out} := T_ADD(IN1 := ${2:dateTime}, IN2 := ${3:T#1h});',
    help: 'A duration onto a date-and-time, or onto another duration.',
  },
  {
    id: 'dt.t_sub', name: 'T_SUB', title: 'Subtract times', group: 'datetime', form: 'box',
    pins: [i('ANY', 'IN1'), i('Time', 'IN2'), o('ANY', 'OUT')], help: 'A duration off a time.',
  },
  {
    id: 'dt.t_diff', name: 'T_DIFF', title: 'Time difference', group: 'datetime', form: 'box',
    pins: [i('DTL', 'IN1'), i('DTL', 'IN2'), o('Time', 'OUT')],
    help: 'How long between two date-and-times. How "the batch took 4 h 12 min" is '
      + 'worked out.',
  },
  {
    id: 'dt.rd_sys_t', name: 'RD_SYS_T', title: 'Read time-of-day', group: 'datetime', form: 'box',
    pins: [o('Int', 'RET_VAL'), o('DTL', 'OUT')], scl: 'RD_SYS_T(${1:now});',
    help: 'The CPU clock, in UTC. RD_LOC_T is the local one — which of the two is '
      + 'wanted is worth deciding before a log is a year old.',
  },
  {
    id: 'dt.rd_loc_t', name: 'RD_LOC_T', title: 'Read local time', group: 'datetime', form: 'box',
    pins: [o('Int', 'RET_VAL'), o('DTL', 'OUT')], scl: 'RD_LOC_T(${1:now});',
    help: 'The clock with the time zone and summer time applied.',
  },
  {
    id: 'dt.wr_sys_t', name: 'WR_SYS_T', title: 'Set time-of-day', group: 'datetime', form: 'box',
    pins: [i('DTL', 'IN'), o('Int', 'RET_VAL')], help: 'Sets the CPU clock.',
  },
  {
    id: 'dt.rtm', name: 'RTM', title: 'Runtime meter', group: 'datetime', form: 'box',
    pins: [i('UInt', 'NR'), i('Int', 'MODE'), i('DInt', 'PV'), o('Int', 'RET_VAL'),
      o('Bool', 'CQ'), o('DInt', 'CV')],
    help: 'The CPU\'s own hour meters — kept across a power cycle, which is what '
      + 'makes them the honest place for running hours.',
  },
];

const STRINGS: Instruction[] = [
  {
    id: 'str.len', name: 'LEN', title: 'Determine the length of a character string', group: 'string', form: 'box',
    pins: [i('String', 'IN'), o('Int', 'OUT')], scl: '${1:n} := LEN(${2:text});',
    help: 'How many characters are in it now — not how many it can hold, which is '
      + 'MAX_LEN.',
  },
  {
    id: 'str.concat', name: 'CONCAT', title: 'Combine character strings', group: 'string', form: 'box',
    pins: [i('String', 'IN1'), i('String', 'IN2'), o('String', 'OUT')],
    scl: '${1:out} := CONCAT(IN1 := ${2:a}, IN2 := ${3:b});',
    help: 'Joins two strings. What will not fit in the destination is cut off '
      + 'without a word, so size the destination for the worst case.',
  },
  {
    id: 'str.left', name: 'LEFT', title: 'Read the left characters', group: 'string', form: 'box',
    pins: [i('String', 'IN'), i('Int', 'L'), o('String', 'OUT')],
    scl: '${1:out} := LEFT(IN := ${2:text}, L := ${3:4});', help: 'The first L characters.',
  },
  {
    id: 'str.right', name: 'RIGHT', title: 'Read the right characters', group: 'string', form: 'box',
    pins: [i('String', 'IN'), i('Int', 'L'), o('String', 'OUT')],
    scl: '${1:out} := RIGHT(IN := ${2:text}, L := ${3:4});', help: 'The last L characters.',
  },
  {
    id: 'str.mid', name: 'MID', title: 'Read middle characters', group: 'string', form: 'box',
    pins: [i('String', 'IN'), i('Int', 'L'), i('Int', 'P'), o('String', 'OUT')],
    scl: '${1:out} := MID(IN := ${2:text}, L := ${3:4}, P := ${4:1});',
    help: 'L characters from position P. **P counts from 1**, not from 0.',
  },
  {
    id: 'str.find', name: 'FIND', title: 'Find characters', group: 'string', form: 'box',
    pins: [i('String', 'IN1'), i('String', 'IN2'), o('Int', 'OUT')],
    scl: '${1:at} := FIND(IN1 := ${2:haystack}, IN2 := ${3:needle});',
    help: 'Where IN2 starts inside IN1, or 0 when it is not there.',
  },
  {
    id: 'str.replace', name: 'REPLACE', title: 'Replace characters', group: 'string', form: 'box',
    pins: [i('String', 'IN1'), i('String', 'IN2'), i('Int', 'L'), i('Int', 'P'), o('String', 'OUT')],
    help: 'Puts IN2 over L characters of IN1 from position P.',
  },
  {
    id: 'str.delete', name: 'DELETE', title: 'Delete characters', group: 'string', form: 'box',
    pins: [i('String', 'IN'), i('Int', 'L'), i('Int', 'P'), o('String', 'OUT')],
    help: 'Takes L characters out from position P.',
  },
  {
    id: 'str.insert', name: 'INSERT', title: 'Insert characters', group: 'string', form: 'box',
    pins: [i('String', 'IN1'), i('String', 'IN2'), i('Int', 'P'), o('String', 'OUT')],
    help: 'Puts IN2 into IN1 after position P.',
  },
  {
    id: 'str.s_conv', name: 'S_CONV', title: 'Convert character string', group: 'string', form: 'box',
    pins: [i('ANY', 'IN'), o('ANY', 'OUT')],
    help: 'A number to a string or back, in the plainest possible form. '
      + 'STRG_VAL and VAL_STRG give control over the format.',
  },
  {
    id: 'str.val_strg', name: 'VAL_STRG', title: 'Convert numerical value to character string', group: 'string', form: 'box',
    pins: [i('ANY_NUM', 'IN'), i('USInt', 'SIZE'), i('USInt', 'PREC'), i('Int', 'FORMAT'),
      i('Int', 'P'), o('Word', 'RET_VAL'), o('String', 'OUT')],
    help: 'A number into a string with a chosen width and number of decimals — for '
      + 'an HMI line or a label.',
  },
  {
    id: 'str.strg_val', name: 'STRG_VAL', title: 'Convert character string to numerical value', group: 'string', form: 'box',
    pins: [i('String', 'IN'), i('Int', 'FORMAT'), i('Int', 'P'), o('Word', 'RET_VAL'), o('ANY_NUM', 'OUT')],
    help: 'A string back to a number, saying through RET_VAL whether it could be '
      + 'read — which is the part to use, because operators type anything.',
  },
];

const DIAGNOSTICS: Instruction[] = [
  {
    id: 'dg.led', name: 'LED', title: 'Read the status of the LED', group: 'diag', form: 'box',
    pins: [i('HW_DEVICE', 'LADDR'), i('UInt', 'LED'), o('Int', 'RET_VAL')],
    help: 'What a module\'s own LED is doing, read from the program — the ERROR '
      + 'light on a rack, reported to the HMI.',
  },
  {
    id: 'dg.get_diag', name: 'GET_DIAG', title: 'Read diagnostic information', group: 'diag', form: 'box',
    pins: [i('UInt', 'MODE'), i('HW_ANY', 'LADDR'), o('Int', 'RET_VAL'), o('Variant', 'DINFO')],
    help: 'The full diagnostic record of a module or device.',
  },
  {
    id: 'dg.device_states', name: 'DeviceStates', title: 'Read module states in the IO system', group: 'diag', form: 'box',
    pins: [i('HW_IOSYSTEM', 'LADDR'), i('UInt', 'MODE'), o('Int', 'RET_VAL'), o('Variant', 'STATE')],
    help: 'Which devices on a PROFINET line are there and which are missing, in '
      + 'one call.',
  },
  {
    id: 'dg.module_states', name: 'ModuleStates', title: 'Read module status information', group: 'diag', form: 'box',
    pins: [i('HW_DEVICE', 'LADDR'), i('UInt', 'MODE'), o('Int', 'RET_VAL'), o('Variant', 'STATE')],
    help: 'The same question about the modules inside one device.',
  },
];

const INTERRUPTS: Instruction[] = [
  {
    id: 'int.attach', name: 'ATTACH', title: 'Attach an OB to an interrupt event', group: 'interrupt', form: 'box',
    pins: [i('OB_ATT', 'OB_NR'), i('EVENT_ATT', 'EVENT'), i('Bool', 'ADD'), o('Int', 'RET_VAL')],
    help: 'Connects an event to the OB that answers it, while the program is '
      + 'running.',
  },
  {
    id: 'int.detach', name: 'DETACH', title: 'Detach an OB from an interrupt event', group: 'interrupt', form: 'box',
    pins: [i('OB_ATT', 'OB_NR'), i('EVENT_ATT', 'EVENT'), o('Int', 'RET_VAL')],
    help: 'Disconnects it again.',
  },
  {
    id: 'int.srt_dint', name: 'SRT_DINT', title: 'Start time-delay interrupt', group: 'interrupt', form: 'box',
    pins: [i('OB_DELAY', 'OB_NR'), i('Time', 'DTIME'), i('Word', 'SIGN'), o('Int', 'RET_VAL')],
    help: 'Runs an OB once, after a delay — without a timer in the cyclic program.',
  },
  {
    id: 'int.dis_airt', name: 'DIS_AIRT', title: 'Delay higher priority interrupts', group: 'interrupt', form: 'box',
    pins: [o('Int', 'RET_VAL')], scl: 'DIS_AIRT();',
    help: 'Holds interrupts off so a piece of work is not cut in half. **Always '
      + 'pair it with EN_AIRT**, in every path out of the code between them.',
  },
  {
    id: 'int.en_airt', name: 'EN_AIRT', title: 'Enable higher priority interrupts', group: 'interrupt', form: 'box',
    pins: [o('Int', 'RET_VAL')], scl: 'EN_AIRT();', help: 'Lets them through again.',
  },
];

const PROCESS_IMAGE: Instruction[] = [
  {
    id: 'pi.updat_pi', name: 'UPDAT_PI', title: 'Update the process image partition', group: 'pimage', form: 'box',
    pins: [i('UInt', 'PART'), i('HW_IOSYSTEM', 'FLADDR'), o('Int', 'RET_VAL')],
    help: 'Reads a partition of the inputs now, instead of waiting for the top of '
      + 'the next scan.',
  },
  {
    id: 'pi.updat_po', name: 'UPDAT_PO', title: 'Update the process image output partition', group: 'pimage', form: 'box',
    pins: [i('UInt', 'PART'), i('HW_IOSYSTEM', 'FLADDR'), o('Int', 'RET_VAL')],
    help: 'Writes a partition of the outputs now.',
  },
];

// ── Technology and communication ────────────────────────────────────────────

const TECHNOLOGY: Instruction[] = [
  {
    id: 'tec.pid_compact', name: 'PID_Compact', title: 'Universal PID controller', group: 'pid', form: 'box',
    instance: true,
    pins: [i('Real', 'Setpoint'), i('Real', 'Input'), i('Word', 'Input_PER'), i('Bool', 'ManualEnable'),
      i('Real', 'ManualValue'), i('Bool', 'Reset'), o('Real', 'Output'), o('Word', 'Output_PER'),
      o('Bool', 'State'), o('Bool', 'Error')],
    help: 'The standard loop: a setpoint, a measurement and an output, with '
      + 'auto-tuning. Use Input_PER to take the raw analogue value and let the '
      + 'block do the scaling.',
  },
  {
    id: 'tec.pid_3step', name: 'PID_3Step', title: 'PID controller with valve tuning', group: 'pid', form: 'box',
    instance: true,
    pins: [i('Real', 'Setpoint'), i('Real', 'Input'), i('Bool', 'Actuator_H'), i('Bool', 'Actuator_L'),
      o('Bool', 'Output_UP'), o('Bool', 'Output_DN')],
    help: 'For a motorised valve driven open and closed rather than by an '
      + 'analogue signal.',
  },
  {
    id: 'tec.mc_power', name: 'MC_Power', title: 'Enable/disable axis', group: 'motion', form: 'box',
    instance: true,
    pins: [i('TO_Axis', 'Axis'), i('Bool', 'Enable'), o('Bool', 'Status'), o('Bool', 'Error')],
    help: 'Enables an axis. Nothing else in motion works until this is TRUE, which '
      + 'is the first thing to check when a move does nothing.',
  },
  {
    id: 'tec.mc_home', name: 'MC_Home', title: 'Home axis', group: 'motion', form: 'box',
    instance: true,
    pins: [i('TO_Axis', 'Axis'), i('Bool', 'Execute'), i('Real', 'Position'), i('Int', 'Mode'),
      o('Bool', 'Done'), o('Bool', 'Error')],
    help: 'Gives the axis its reference. Absolute moves mean nothing before it.',
  },
  {
    id: 'tec.mc_moveabs', name: 'MC_MoveAbsolute', title: 'Position axis absolutely', group: 'motion', form: 'box',
    instance: true,
    pins: [i('TO_Axis', 'Axis'), i('Bool', 'Execute'), i('Real', 'Position'), i('Real', 'Velocity'),
      o('Bool', 'Done'), o('Bool', 'Error')],
    help: 'Moves to a position in the axis\'s own coordinates. Execute is edge '
      + 'triggered.',
  },
  {
    id: 'tec.mc_movejog', name: 'MC_MoveJog', title: 'Move axis in jog mode', group: 'motion', form: 'box',
    instance: true,
    pins: [i('TO_Axis', 'Axis'), i('Bool', 'JogForward'), i('Bool', 'JogBackward'), i('Real', 'Velocity'),
      o('Bool', 'InVelocity'), o('Bool', 'Error')],
    help: 'Runs while the button is held — the manual mode on the panel.',
  },
];

const COMMUNICATION: Instruction[] = [
  {
    id: 'com.tsend_c', name: 'TSEND_C', title: 'Establish connection and send data', group: 'open-comm', form: 'box',
    instance: true,
    pins: [i('Bool', 'REQ'), i('Bool', 'CONT'), i('Variant', 'CONNECT'), i('Variant', 'DATA'),
      o('Bool', 'DONE'), o('Bool', 'BUSY'), o('Bool', 'ERROR'), o('Word', 'STATUS')],
    help: 'Sets up a TCP or ISO-on-TCP connection and sends on it. REQ is edge '
      + 'triggered — holding it TRUE sends once, not continuously.',
  },
  {
    id: 'com.trcv_c', name: 'TRCV_C', title: 'Establish connection and receive data', group: 'open-comm', form: 'box',
    instance: true,
    pins: [i('Bool', 'EN_R'), i('Bool', 'CONT'), i('Variant', 'CONNECT'), o('Bool', 'DONE'),
      o('Bool', 'BUSY'), o('Bool', 'ERROR'), o('Word', 'STATUS'), o('UInt', 'RCVD_LEN'), o('Variant', 'DATA')],
    help: 'The receiving half.',
  },
  {
    id: 'com.mb_client', name: 'MB_CLIENT', title: 'Communicate via Modbus TCP as client', group: 'modbus', form: 'box',
    instance: true,
    pins: [i('Bool', 'REQ'), i('Bool', 'DISCONNECT'), i('UInt', 'MB_MODE'), i('UDInt', 'MB_DATA_ADDR'),
      i('UInt', 'MB_DATA_LEN'), i('Variant', 'MB_DATA_PTR'), i('Variant', 'CONNECT'),
      o('Bool', 'DONE'), o('Bool', 'BUSY'), o('Bool', 'ERROR'), o('Word', 'STATUS')],
    help: 'Modbus TCP master. One call per request, one after another on a '
      + 'connection — two REQs at once on the same instance is the commonest '
      + 'reason a Modbus link "works sometimes".',
  },
  {
    id: 'com.mb_server', name: 'MB_SERVER', title: 'Communicate via Modbus TCP as server', group: 'modbus', form: 'box',
    instance: true,
    pins: [i('Bool', 'DISCONNECT'), i('Variant', 'MB_HOLD_REG'), i('Variant', 'CONNECT'),
      o('Bool', 'NDR'), o('Bool', 'DR'), o('Bool', 'ERROR'), o('Word', 'STATUS')],
    help: 'Modbus TCP slave — call it every scan and it answers whatever asks.',
  },
  {
    id: 'com.put', name: 'PUT', title: 'Write data to a remote CPU', group: 's7-comm', form: 'box',
    instance: true,
    pins: [i('Bool', 'REQ'), i('Word', 'ID'), i('Remote', 'ADDR_1'), i('Variant', 'SD_1'),
      o('Bool', 'DONE'), o('Bool', 'ERROR'), o('Word', 'STATUS')],
    help: 'S7 communication to another Siemens CPU. The partner must allow PUT/GET '
      + 'access in its protection settings, which is off by default and is the '
      + 'usual reason it does nothing.',
  },
  {
    id: 'com.get', name: 'GET', title: 'Read data from a remote CPU', group: 's7-comm', form: 'box',
    instance: true,
    pins: [i('Bool', 'REQ'), i('Word', 'ID'), i('Remote', 'ADDR_1'), o('Variant', 'RD_1'),
      o('Bool', 'NDR'), o('Bool', 'ERROR'), o('Word', 'STATUS')],
    help: 'The reading half of S7 communication.',
  },
];

// ── The catalogue ───────────────────────────────────────────────────────────

export const INSTRUCTION_SECTIONS: InstrSection[] = [
  {
    id: 'basic',
    label: 'Basic instructions',
    groups: [
      { id: 'general', label: 'General', note: 'Editor commands — networks, branches, an empty box', items: GENERAL },
      { id: 'bit', label: 'Bit logic operations', note: 'Contacts, coils, latches and edges', items: BIT_LOGIC },
      { id: 'timer', label: 'Timer operations', note: 'IEC timers — pulse, on-delay, off-delay, accumulator', items: TIMERS },
      { id: 'counter', label: 'Counter operations', note: 'IEC counters — up, down, both', items: COUNTERS },
      { id: 'compare', label: 'Comparator operations', note: 'Equality, order and range', items: COMPARE },
      { id: 'math', label: 'Math functions', note: 'Arithmetic, limits and the transcendentals', items: MATH },
      { id: 'move', label: 'Move operations', note: 'Copying values, blocks and structures', items: MOVE },
      { id: 'convert', label: 'Conversion operations', note: 'Between types, and between raw and engineering units', items: CONVERT },
      { id: 'control', label: 'Program control operations', note: 'Jumps, returns and error handling', items: PROGRAM_CONTROL },
      { id: 'word', label: 'Word logic operations', note: 'Bit-by-bit logic, select and multiplex', items: WORD_LOGIC },
      { id: 'shift', label: 'Shift and rotate', note: 'Moving bits along a word', items: SHIFT_ROTATE },
    ],
  },
  {
    id: 'extended',
    label: 'Extended instructions',
    groups: [
      { id: 'datetime', label: 'Date and time-of-day', note: 'The clock, durations and running hours', items: DATE_TIME },
      { id: 'string', label: 'String + Char', note: 'Text: length, joining, cutting and conversion', items: STRINGS },
      { id: 'pimage', label: 'Process image', note: 'Reading and writing the I/O image out of turn', items: PROCESS_IMAGE },
      { id: 'interrupt', label: 'Interrupts', note: 'Events, delays and holding interrupts off', items: INTERRUPTS },
      { id: 'diag', label: 'Diagnostics', note: 'What the rack and the network say about themselves', items: DIAGNOSTICS },
    ],
  },
  {
    id: 'technology',
    label: 'Technology',
    groups: [
      { id: 'pid', label: 'PID control', note: 'Closed-loop control', items: TECHNOLOGY.filter(x => x.group === 'pid') },
      { id: 'motion', label: 'Motion control', note: 'Axes: enable, home and move', items: TECHNOLOGY.filter(x => x.group === 'motion') },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    groups: [
      { id: 'open-comm', label: 'Open user communication', note: 'TCP, ISO-on-TCP and UDP', items: COMMUNICATION.filter(x => x.group === 'open-comm') },
      { id: 'modbus', label: 'MODBUS TCP', note: 'Client and server', items: COMMUNICATION.filter(x => x.group === 'modbus') },
      { id: 's7-comm', label: 'S7 communication', note: 'PUT and GET between Siemens CPUs', items: COMMUNICATION.filter(x => x.group === 's7-comm') },
    ],
  },
];

/** Every instruction, flat — for lookup, completion and the assistant. */
export const ALL_INSTRUCTIONS: Instruction[] = INSTRUCTION_SECTIONS
  .flatMap(s => s.groups)
  .flatMap(g => g.items);

const BY_ID = new Map(ALL_INSTRUCTIONS.map(x => [x.id, x]));
const BY_NAME = new Map(ALL_INSTRUCTIONS.map(x => [x.name.toUpperCase(), x]));

export const instructionById = (id: string): Instruction | undefined => BY_ID.get(id);

/** By the name as written on a rung or in code — `TON`, `MOVE`, `SCALE_X`. */
export const instructionByName = (name: string): Instruction | undefined =>
  BY_NAME.get(name.trim().toUpperCase());

/**
 * The instructions matching what was typed in the search box.
 *
 * Name first, then the description, then the help — so typing `TON` finds the
 * timer before it finds the six other entries whose help mentions on-delay,
 * and typing `edge` still finds all of them.
 */
export function searchInstructions(query: string, limit = 60): Instruction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const name: Instruction[] = [];
  const title: Instruction[] = [];
  const help: Instruction[] = [];
  for (const x of ALL_INSTRUCTIONS) {
    if (x.name.toLowerCase().includes(q)) name.push(x);
    // The Persian description is searched whatever language is on screen:
    // somebody who thinks of it as «تایمر» and somebody who types TON are
    // looking for the same box, and neither should have to switch first.
    else if (x.title.toLowerCase().includes(q) || (TITLE_FA[x.id] ?? '').includes(q)) title.push(x);
    else if (x.help.toLowerCase().includes(q) || (HELP_FA[x.id] ?? '').includes(q)) help.push(x);
  }
  return [...name, ...title, ...help].slice(0, limit);
}

/**
 * The catalogue written out for a language model.
 *
 * One line an instruction: the name, the pins in order with their types, and
 * what it does. That is the whole of what a model needs to use it and far less
 * than what it would need to invent it — and a model given this stops offering
 * `TIMER_ON` and `MOV`, which is the failure that makes a generated program
 * useless rather than merely wrong.
 */
export function briefing(sections: string[] = ['basic']): string {
  const out: string[] = [];
  for (const section of INSTRUCTION_SECTIONS) {
    if (!sections.includes(section.id)) continue;
    out.push(`## ${section.label}`);
    for (const group of section.groups) {
      if (group.items.length === 0) continue;
      out.push(`### ${group.label}`);
      for (const x of group.items) {
        if (x.form === 'editor') continue;
        const pins = (x.pins ?? [])
          .map(p => `${p.name}${p.out ? '=>' : ':'}${p.type}`).join(' ');
        out.push(`- ${x.name}${pins ? ` (${pins})` : ''} — ${x.title}${x.instance ? ' [needs an instance]' : ''}`);
      }
    }
  }
  return out.join('\n');
}

// ── Persian ─────────────────────────────────────────────────────────────────
//
// The description column and the long help, in Persian, for every entry in
// every section. Kept as lookups beside the table rather than as two more
// fields on every entry, so the catalogue above stays one readable list and
// adding a language does not mean editing two hundred object literals.
//
// Both tables are complete and are meant to stay that way. An id in one and
// not the other shows up as an instruction that is half in each language,
// which is the one thing worse than being in neither.
//
// **The names do not turn.** `TON` is TON, `-| |-` is `-| |-` and `SCALE_X` is
// SCALE_X in either language — they are the vocabulary of the software the
// program is finally typed into, and an engineer who cannot search for the
// name they will see in TIA has been helped into a corner. What turns is the
// sentence beside it, which is the part that has to be understood rather than
// matched.
//
// **The long help turns too.** It is a paragraph an entry and it is where the
// real warnings live, so it was carried across sentence by sentence rather
// than glossed: the numbers, the pin names and the code stay in the form they
// are typed in, and a warning that is shouted in one language is shouted in
// the other. An entry with no Persian help yet falls back to the English one,
// which is better than an empty panel.

const TITLE_FA: Record<string, string> = {
  // General
  'gen.network': 'درج شبکه',
  'gen.box': 'باکس خالی [F8]',
  'gen.branch.open': 'باز کردن شاخه [Shift+F8]',
  'gen.branch.close': 'بستن شاخه [Shift+F9]',
  'gen.input': 'درج ورودی',

  // Bit logic
  'bit.no': 'کنتاکت باز در حالت عادی',
  'bit.nc': 'کنتاکت بسته در حالت عادی',
  'bit.not': 'معکوس کردن نتیجهٔ منطق',
  'bit.coil': 'انتساب [Shift+F7]',
  'bit.coil.neg': 'انتساب معکوس',
  'bit.reset': 'ریست خروجی',
  'bit.set': 'ست خروجی',
  'bit.set_bf': 'ست کردن میدان بیت',
  'bit.reset_bf': 'ریست کردن میدان بیت',
  'bit.sr': 'فلیپ‌فلاپ ست/ریست',
  'bit.rs': 'فلیپ‌فلاپ ریست/ست',
  'bit.p.contact': 'خواندن لبهٔ بالارونده روی عملوند',
  'bit.n.contact': 'خواندن لبهٔ پایین‌رونده روی عملوند',
  'bit.p.coil': 'ست کردن عملوند روی لبهٔ بالارونده',
  'bit.n.coil': 'ست کردن عملوند روی لبهٔ پایین‌رونده',
  'bit.p_trig': 'خواندن لبهٔ بالارونده روی نتیجهٔ منطق',
  'bit.n_trig': 'خواندن لبهٔ پایین‌رونده روی نتیجهٔ منطق',
  'bit.r_trig': 'تشخیص لبهٔ بالارونده',
  'bit.f_trig': 'تشخیص لبهٔ پایین‌رونده',

  // Timers
  'tmr.tp': 'تولید پالس',
  'tmr.ton': 'تأخیر در وصل',
  'tmr.tof': 'تأخیر در قطع',
  'tmr.tonr': 'تایمر انباشتی',
  'tmr.tp.coil': 'شروع تایمر پالس',
  'tmr.ton.coil': 'شروع تایمر تأخیر در وصل',
  'tmr.tof.coil': 'شروع تایمر تأخیر در قطع',
  'tmr.tonr.coil': 'تایمر انباشتی',
  'tmr.rt': 'ریست تایمر',
  'tmr.pt': 'بارگذاری مدت زمان',

  // Counters
  'cnt.ctu': 'شمارش بالا',
  'cnt.ctd': 'شمارش پایین',
  'cnt.ctud': 'شمارش بالا و پایین',

  // Comparators
  'cmp.eq': 'مساوی',
  'cmp.ne': 'نامساوی',
  'cmp.ge': 'بزرگ‌تر یا مساوی',
  'cmp.le': 'کوچک‌تر یا مساوی',
  'cmp.gt': 'بزرگ‌تر از',
  'cmp.lt': 'کوچک‌تر از',
  'cmp.in_range': 'مقدار داخل بازه',
  'cmp.out_range': 'مقدار خارج بازه',
  'cmp.ok': 'بررسی معتبر بودن',
  'cmp.not_ok': 'بررسی نامعتبر بودن',

  // Math
  'math.calculate': 'محاسبهٔ یک عبارت',
  'math.add': 'جمع',
  'math.sub': 'تفریق',
  'math.mul': 'ضرب',
  'math.div': 'تقسیم',
  'math.mod': 'باقی‌ماندهٔ تقسیم',
  'math.neg': 'منفی کردن',
  'math.inc': 'یکی اضافه کردن',
  'math.dec': 'یکی کم کردن',
  'math.abs': 'قدر مطلق',
  'math.min': 'کمترین',
  'math.max': 'بیشترین',
  'math.limit': 'محدود کردن به بازه',
  'math.sqr': 'مجذور',
  'math.sqrt': 'جذر',
  'math.ln': 'لگاریتم طبیعی',
  'math.exp': 'تابع نمایی',
  'math.sin': 'سینوس',
  'math.cos': 'کسینوس',
  'math.tan': 'تانژانت',
  'math.asin': 'آرک‌سینوس',
  'math.acos': 'آرک‌کسینوس',
  'math.atan': 'آرک‌تانژانت',
  'math.frac': 'بخش اعشاری',
  'math.expt': 'به توان رساندن',

  // Move
  'mov.move': 'انتقال مقدار',
  'mov.blk': 'انتقال بلوک',
  'mov.ublk': 'انتقال بلوک بدون وقفه',
  'mov.blk_variant': 'انتقال بلوک (Variant)',
  'mov.fill': 'پر کردن بلوک',
  'mov.ufill': 'پر کردن بلوک بدون وقفه',
  'mov.swap': 'جابه‌جایی ترتیب بایت‌ها',
  'mov.serialize': 'تبدیل ساختار به آرایهٔ بایت',
  'mov.deserialize': 'تبدیل آرایهٔ بایت به ساختار',

  // Conversion
  'cnv.convert': 'تبدیل نوع مقدار',
  'cnv.round': 'گرد کردن',
  'cnv.ceil': 'گرد کردن به بالا',
  'cnv.floor': 'گرد کردن به پایین',
  'cnv.trunc': 'حذف بخش اعشاری',
  'cnv.scale_x': 'مقیاس‌دهی به واحد مهندسی',
  'cnv.norm_x': 'نرمال‌سازی به کسر ۰ تا ۱',

  // Program control
  'ctl.jmp': 'پرش اگر نتیجهٔ منطق ۱ باشد',
  'ctl.jmpn': 'پرش اگر نتیجهٔ منطق ۰ باشد',
  'ctl.label': 'برچسب پرش',
  'ctl.jmp_list': 'تعریف فهرست پرش',
  'ctl.switch': 'توزیع‌کنندهٔ پرش',
  'ctl.ret': 'بازگشت از بلاک',
  'ctl.re_trigr': 'شروع دوبارهٔ زمان نظارت بر سیکل',
  'ctl.stp': 'خروج از برنامه (STOP)',
  'ctl.get_error': 'گرفتن خطای محلی',
  'ctl.get_err_id': 'گرفتن شناسهٔ خطای محلی',
  'ctl.endis_pw': 'محدود کردن و فعال کردن رمز',

  // Word logic
  'wl.and': 'AND بیت‌به‌بیت',
  'wl.or': 'OR بیت‌به‌بیت',
  'wl.xor': 'XOR بیت‌به‌بیت',
  'wl.invert': 'مکمل یک (معکوس کردن بیت‌ها)',
  'wl.deco': 'رمزگشایی — عدد به بیت',
  'wl.enco': 'رمزگذاری — بیت به عدد',
  'wl.sel': 'انتخاب یکی از دو',
  'wl.mux': 'انتخاب یکی از چند (مالتی‌پلکس)',
  'wl.demux': 'توزیع به یکی از چند خروجی',

  // Shift and rotate
  'sr.shr': 'شیفت به راست',
  'sr.shl': 'شیفت به چپ',
  'sr.ror': 'چرخش به راست',
  'sr.rol': 'چرخش به چپ',

  // Date and time
  'dt.t_conv': 'تبدیل زمان‌ها',
  'dt.t_add': 'جمع زمان‌ها',
  'dt.t_sub': 'تفریق زمان‌ها',
  'dt.t_diff': 'اختلاف زمان',
  'dt.rd_sys_t': 'خواندن ساعت سیستم',
  'dt.rd_loc_t': 'خواندن ساعت محلی',
  'dt.wr_sys_t': 'تنظیم ساعت سیستم',
  'dt.rtm': 'ساعت‌شمار کارکرد',

  // String and character
  'str.len': 'تعیین طول رشتهٔ کاراکتری',
  'str.concat': 'به‌هم پیوستن رشته‌ها',
  'str.left': 'خواندن کاراکترهای سمت چپ',
  'str.right': 'خواندن کاراکترهای سمت راست',
  'str.mid': 'خواندن کاراکترهای میانی',
  'str.find': 'یافتن کاراکترها',
  'str.replace': 'جایگزینی کاراکترها',
  'str.delete': 'حذف کاراکترها',
  'str.insert': 'درج کاراکترها',
  'str.s_conv': 'تبدیل رشتهٔ کاراکتری',
  'str.val_strg': 'تبدیل مقدار عددی به رشتهٔ کاراکتری',
  'str.strg_val': 'تبدیل رشتهٔ کاراکتری به مقدار عددی',

  // Diagnostics
  'dg.led': 'خواندن وضعیت LED',
  'dg.get_diag': 'خواندن اطلاعات عیب‌یابی',
  'dg.device_states': 'خواندن وضعیت ماژول‌ها در سیستم IO',
  'dg.module_states': 'خواندن اطلاعات وضعیت ماژول',

  // Interrupts
  'int.attach': 'وصل کردن یک OB به رویداد وقفه',
  'int.detach': 'جدا کردن یک OB از رویداد وقفه',
  'int.srt_dint': 'شروع وقفهٔ تأخیری',
  'int.dis_airt': 'به تأخیر انداختن وقفه‌های با اولویت بالاتر',
  'int.en_airt': 'فعال کردن وقفه‌های با اولویت بالاتر',

  // Process image
  'pi.updat_pi': 'به‌روزرسانی پارتیشن تصویر ورودی',
  'pi.updat_po': 'به‌روزرسانی پارتیشن تصویر خروجی',

  // Technology
  'tec.pid_compact': 'کنترلر PID همه‌منظوره',
  'tec.pid_3step': 'کنترلر PID با تنظیم شیر',
  'tec.mc_power': 'فعال/غیرفعال کردن محور',
  'tec.mc_home': 'مرجع‌گیری محور',
  'tec.mc_moveabs': 'موقعیت‌دهی مطلق محور',
  'tec.mc_movejog': 'حرکت محور در حالت جوگ',

  // Communication
  'com.tsend_c': 'برقراری اتصال و فرستادن داده',
  'com.trcv_c': 'برقراری اتصال و گرفتن داده',
  'com.mb_client': 'ارتباط Modbus TCP به‌عنوان کلاینت',
  'com.mb_server': 'ارتباط Modbus TCP به‌عنوان سرور',
  'com.put': 'نوشتن داده در یک CPU دیگر',
  'com.get': 'خواندن داده از یک CPU دیگر',
};

const HELP_FA: Record<string, string> = {
  // General
  'gen.network': 'یک شبکهٔ خالی تازه، پس از شبکه‌ای که مکان‌نما در آن است. هر شبکه یک پله است: یک مسیر از ریل چپ تا ریل راست. تقسیم منطق میان شبکه‌ها همان چیزی است که برنامه را خوانا می‌کند — هر شبکه یک ایده، و عنوان می‌گوید کدام ایده.',
  'gen.box': 'باکسی که هنوز دستوری در آن نیست. آن را همان‌جا که دستور باید بیاید بگذارید و نامش را بعد بنویسید — وقتی به کار می‌آید که شکل شبکه پیش از خودِ بلوک روشن است.',
  'gen.branch.open': 'یک مسیر موازی از محل مکان‌نما آغاز می‌کند. دو کنتاکت موازی یعنی OR: اگر هر کدام عبور دهد، جریان می‌رسد. مدار خودنگه‌دار این‌گونه کشیده می‌شود.',
  'gen.branch.close': 'مسیر موازی را به ریل برمی‌گرداند. شاخه‌ای که باز شود و بسته نشود، پله‌ای نیست که بتوان به کنترلر داد.',
  'gen.input': 'یک ورودی دیگر روی باکسی که تعداد ورودی‌هایش متغیر است — ADD، AND، MUX. باکس رو به پایین بزرگ می‌شود.',

  // Bit logic
  'bit.no': 'وقتی عملوند TRUE باشد جریان را عبور می‌دهد. این یک *آزمون* است، نه سیم: فقط عملوند را می‌خواند و بس. گذاشتن کنتاکت باز روی شستی استپی که در حالت عادی بسته است، رایج‌ترین اشتباه سیم‌کشی است — نوع کنتاکت از سیگنالِ سرِ ترمینال پیروی می‌کند، نه از کلمه‌ای که روی شستی نوشته‌اند.',
  'bit.nc': 'وقتی عملوند FALSE باشد جریان را عبور می‌دهد. شستی استپی که NC سیم شده — که راه ایمن است، چون قطع شدن سیم موتور را می‌خواباند — با کنتاکت باز خوانده می‌شود، چون تا وقتی شستی فشرده نشده سیگنال TRUE است.',
  'bit.not': 'نتیجهٔ هر چه سمت چپش هست را وارونه می‌کند. خودش هیچ عملوندی را نمی‌آزماید.',
  'bit.coil': 'نتیجهٔ شبکه را در عملوند می‌نویسد — وقتی جریان می‌رسد TRUE و وقتی نمی‌رسد FALSE. هر اسکن، در هر دو جهت. دو کویل که در یک برنامه روی یک عملوند بنویسند، همان ایرادی است که شبیه بی‌اعتنایی کنترلر به شما دیده می‌شود: هر کدام دیرتر اجرا شود برنده است.',
  'bit.coil.neg': 'همان انتساب، وارونه: وقتی جریان به کویل می‌رسد عملوند FALSE می‌شود.',
  'bit.reset': 'وقتی جریان برسد عملوند را FALSE می‌کند و وقتی نرسد کاری با آن ندارد. برخلاف کویل هر اسکن نمی‌نویسد، پس عملوند همان‌جا که گذاشته شده می‌ماند تا چیزی دوباره ستش کند.',
  'bit.set': 'عملوند را TRUE می‌کند و TRUE نگه می‌دارد. باید جایی با یک ریست جفت شود، و اگر در یک اسکن به هر دو جریان برسد، آنکه پایین‌تر در برنامه است تصمیم می‌گیرد.',
  'bit.set_bf': 'یک رشته بیتِ پشت‌سرهم را از عملوند به بعد ست می‌کند. تعداد، یک ثابت روی کویل است، نه یک تگ.',
  'bit.reset_bf': 'یک رشته بیتِ پشت‌سرهم را صفر می‌کند. معمولاً نخستین سطر بلوک راه‌اندازی، جایی که یک کلمهٔ فرمانِ کامل به صفر برگردانده می‌شود.',
  'bit.sr': 'قفلی که در آن **ریست برنده است**: R1 ورودی غالب است، پس فرمان توقفی که در همان اسکن همراه فرمان شروع می‌رسد بر آن پیروز می‌شود. برای هر چیزی که حرکت می‌کند همین را می‌خواهید.',
  'bit.rs': 'قفلی که در آن **ست برنده است**: S1 غالب است. آگاهانه انتخابش کنید — اشتباه گرفتن RS و SR ماشینی می‌دهد که وقتی به آن گفته‌اند بایست راه می‌افتد، و فقط وقتی هر دو با هم برسند؛ و این سخت‌یاب‌ترین نوع خطاست.',
  'bit.p.contact': 'دقیقاً یک اسکن جریان می‌دهد، وقتی عملوند از FALSE به TRUE می‌رود. بیت حافظهٔ زیرش جایی است که حالت پیشین نگه داشته می‌شود و **نباید جای دیگری به کار رود** — به اشتراک گذاشتن یک بیت حافظه میان دو لبه، همان دلیلی است که یکی از آن دو از کار می‌افتد.',
  'bit.n.contact': 'یک اسکن روی لبهٔ پایین‌رونده — TRUE به FALSE. همان قاعده دربارهٔ بیت حافظه.',
  'bit.p.coil': 'وقتی شبکهٔ پیش از آن TRUE می‌شود، عملوند را یک اسکن TRUE می‌کند. لبه از *نتیجهٔ شبکه* گرفته می‌شود، نه از یک عملوند تنها.',
  'bit.n.coil': 'یک اسکن، وقتی شبکه می‌افتد.',
  'bit.p_trig': 'شکل باکسیِ اسکنِ لبهٔ بالارونده، که نتیجهٔ هر چه سمت چپش هست را می‌گیرد. بیت حافظه‌اش همان اینستنس زیر آن است.',
  'bit.n_trig': 'شکل باکسیِ اسکنِ لبهٔ پایین‌رونده.',
  'bit.r_trig': 'تشخیص‌دهندهٔ لبهٔ IEC، به‌صورت یک فانکشن‌بلاک با اینستنس خودش. در SCL و در هر چیزِ قابل استفادهٔ دوباره همین را ترجیح دهید: اینستنس همراه فراخوانی می‌رود، پس یک FB که برای ده موتور به کار می‌رود ده لبه می‌گیرد، نه یک بیت حافظهٔ مشترک و خطایی که تنها وقتی دو موتور با هم راه بیفتند پیدا می‌شود.',
  'bit.f_trig': 'تشخیص‌دهندهٔ لبهٔ پایین‌روندهٔ IEC، با اینستنس خودش.',

  // Timers
  'tmr.tp': 'با بالا رفتن IN، خروجی Q دقیقاً به اندازهٔ PT برقرار می‌شود و تمام این مدت برقرار می‌ماند، **هر بلایی هم که بعد سر IN بیاید**. همین است که آن را پالس می‌کند: شستی‌ای که 10 میلی‌ثانیه زده شود باز هم بوقِ دو ثانیه‌ای کامل می‌دهد.',
  'tmr.ton': 'وقتی IN پیوسته به اندازهٔ PT برقرار مانده باشد، Q برقرار می‌شود. افتادن IN در هر لحظه ET را به صفر برمی‌گرداند و از نو شروع می‌کند. اسب بارکشِ تایمرها: هشدار راه‌اندازی، حذف نویز کنتاکت، و فیلترِ «واقعاً خراب شده؟».',
  'tmr.tof': 'Q بی‌درنگ با IN بالا می‌رود و پس از افتادن IN به اندازهٔ PT برقرار می‌ماند. فنی که پس از ایستادن موتور کار می‌کند، چراغی که لحظه‌ای روشن می‌ماند.',
  'tmr.tonr': 'مدتی را که IN برقرار بوده جمع می‌زند، در هر تعداد بازهٔ جداگانه که لازم باشد، و تنها R آن را صفر می‌کند. ساعت کارکرد، مجموع زمان در خطا، اینکه امروز چقدر یک شیر باز بوده.',
  'tmr.tp.coil': 'شکل کویلی: تایمر را شبکه راه می‌اندازد و Q آن را جای دیگری از DB خودِ تایمر می‌خوانند.',
  'tmr.ton.coil': 'شکل کویلیِ تأخیر در وصل.',
  'tmr.tof.coil': 'شکل کویلیِ تأخیر در قطع.',
  'tmr.tonr.coil': 'شکل کویلیِ تایمر انباشتی.',
  'tmr.rt': 'یک تایمر را از جای دیگری در برنامه به صفر برمی‌گرداند — همان ریستی که TON ندارد.',
  'tmr.pt': 'مقدار پیش‌تنظیمِ تازه‌ای در تایمرِ در حال کار می‌نویسد — رسپی‌ای که زمان مکث را عوض می‌کند بدون آنکه بلوک از نو ساخته شود.',

  // Counters
  'cnt.ctu': 'با هر لبهٔ بالاروندهٔ CU، مقدار CV یکی بالا می‌رود. همین که CV به PV برسد Q برقرار می‌شود و CV همچنان از آن بالاتر می‌رود — نه می‌ایستد و نه تا سقف نوع داده سرریز می‌کند. R آن را پاک می‌کند.',
  'cnt.ctd': 'با هر لبهٔ بالاروندهٔ CD مقدار CV یکی پایین می‌آید و Q در صفر یا پایین‌تر برقرار است. LD مقدار PV را در CV بار می‌کند — شمارنده این‌گونه راه می‌افتد، و فراموش کردنش شمارنده‌ای می‌دهد که از صفر رو به پایین می‌شمارد.',
  'cnt.ctud': 'هر دو با هم، با یک پرچم در هر سر: QU در PV و بالاتر، QD در صفر و پایین‌تر. قطعه در بافر، بطری میان دو سنسور، خودرو در پارکینگ.',

  // Comparators
  'cmp.eq': 'وقتی دو مقدار برابر باشند جریان را عبور می‌دهد. هر دو باید از یک نوع داده باشند. **هرگز دو Real را برای تساوی مقایسه نکنید** — در ممیز شناور 0.1 + 0.2 برابر 0.3 نیست، روی هیچ کنترلری که تا امروز ساخته شده. به‌جایش اختلاف را با یک رواداری بسنجید.',
  'cmp.ne': 'وقتی دو مقدار متفاوت باشند عبور می‌دهد.',
  'cmp.ge': 'وقتی اولی دست‌کم به اندازهٔ دومی باشد عبور می‌دهد.',
  'cmp.le': 'وقتی اولی حداکثر به اندازهٔ دومی باشد عبور می‌دهد.',
  'cmp.gt': 'وقتی اولی از دومی بزرگ‌تر باشد عبور می‌دهد.',
  'cmp.lt': 'وقتی اولی از دومی کوچک‌تر باشد عبور می‌دهد.',
  'cmp.in_range': 'وقتی MIN ≤ VAL ≤ MAX باشد TRUE است، با احتساب هر دو سرِ بازه. یک باکس به‌جای دو مقایسه‌گر و یک AND، و همان چیزی خوانده می‌شود که معنایش است.',
  'cmp.out_range': 'وقتی مقدار بیرون از بازه باشد TRUE است — یک آلارم، کشیده‌شده همان‌طور که گفته می‌شود.',
  'cmp.ok': 'وقتی عددِ ممیز شناور یک عدد حقیقی باشد عبور می‌دهد — نه NaN و نه بی‌نهایت. ارزشش را دارد که پیش از هر تقسیمی بر یک مقدار اندازه‌گیری‌شده بیاید.',
  'cmp.not_ok': 'وقتی عددِ ممیز شناور نامعتبر باشد عبور می‌دهد — سمتِ آلارمِ OK.',

  // Math
  'math.calculate': 'یک عبارت کامل در یک باکس — فرمول را می‌نویسید و خودش ورودی‌های لازم را نشان می‌دهد. بسیار بهتر از شش باکسِ سیم‌شده به هم، که همان حساب است اما نوشته‌شده به شکلی که هیچ‌کس نتواند وارسی‌اش کند.',
  'math.add': 'جمع می‌کند، با هر تعداد ورودی که درج کنید. نتیجه به OUT می‌رود و همه چیز باید یک نوع باشد — قاطی کردن Int و Real خطاست، نه تبدیل.',
  'math.sub': 'IN1 منهای IN2.',
  'math.mul': 'ضرب می‌کند. حواستان به بازه باشد: دو Int که هر کدام جا می‌شوند می‌توانند حاصل‌ضربی بدهند که جا نمی‌شود، و بی‌صدا سرریز می‌کند.',
  'math.div': 'تقسیم صحیح، باقی‌مانده را دور می‌ریزد — 7 / 2 می‌شود 3، نه 3.5. **مقسومٌ‌علیه را محافظت کنید**: تقسیم یک Int بر صفر CPU را به خطا می‌برد، و یک مقدار اندازه‌گیری‌شده درست وقتی صفر است که سنسور از کار افتاده باشد.',
  'math.mod': 'باقی‌مانده. «هر دهمین قطعه» و «کدام‌یک از هشت جایگاه» این‌گونه نوشته می‌شود.',
  'math.neg': 'علامت را عوض می‌کند.',
  'math.inc': 'یکی به عملوند اضافه می‌کند، در جای خودش. در شبکه‌ای که لبه‌ای جلویش نباشد، هر اسکن یک‌بار می‌شمارد — هزاران بار در ثانیه، که تقریباً هیچ‌وقت منظور نبوده.',
  'math.dec': 'یکی کم می‌کند، در جای خودش. همان هشدار دربارهٔ اسکن.',
  'math.abs': 'علامت را می‌اندازد. راه معمولِ سنجیدن یک انحراف در برابر یک رواداری، بی‌آنکه سمتش مهم باشد.',
  'math.min': 'کوچک‌ترینِ ورودی‌ها.',
  'math.max': 'بزرگ‌ترینِ ورودی‌ها.',
  'math.limit': 'مقدار را در یک بازه محدود می‌کند. آخرین چیز پیش از آنکه یک ستپوینت از برنامه بیرون برود: HMI هر چه فرستاده باشد، درایو چیزی می‌گیرد که از پسش برمی‌آید.',
  'math.sqr': 'مجذور.',
  'math.sqrt': 'جذر. ورودی منفی یک ممیز شناورِ نامعتبر می‌دهد، پس محافظتش کنید — دبی‌ای که از اختلاف فشار حساب می‌شود منفی هم می‌شود.',
  'math.ln': 'لگاریتم طبیعی.',
  'math.exp': 'e به توان IN.',
  'math.sin': 'سینوس. زاویه بر حسب **رادیان** است، نه درجه — اول درجه را در PI/180 ضرب کنید.',
  'math.cos': 'کسینوس، بر حسب رادیان.',
  'math.tan': 'تانژانت، بر حسب رادیان.',
  'math.asin': 'آرک‌سینوس؛ IN باید میان −1 و 1 باشد.',
  'math.acos': 'آرک‌کسینوس؛ IN باید میان −1 و 1 باشد.',
  'math.atan': 'آرک‌تانژانت، که رادیان می‌دهد.',
  'math.frac': 'آنچه پس از ممیز است.',
  'math.expt': 'IN1 به توان IN2.',

  // Move
  'mov.move': 'یک مقدار را کپی می‌کند. میان نوع‌های متفاوت هم کپی می‌کند و یک ساختار کامل را هم کپی می‌کند، و آنجا که نوع‌ها فرق دارند بیت‌ها را کپی می‌کند — که برای یک ساختار درست است و برای یک عدد غلط. وقتی معنا باید سالم بماند و نه فقط بیت‌ها، از CONVERT استفاده کنید.',
  'mov.blk': 'یک رشته از عناصر آرایه را کپی می‌کند. هر دو آرایه باید عناصر هم‌نوع داشته باشند، و COUNT شمارِ عناصر است، نه بایت.',
  'mov.ublk': 'همان کپی، با وقفه‌های نگه‌داشته، تا مقصد هرگز نیمه‌نوشته نماند. وقتی به کارش ببرید که یک وقفه همان چیزی را بخواند که این می‌نویسد؛ زمان اسکن می‌گیرد، پس در غیر این صورت نه.',
  'mov.blk_variant': 'کپی در جایی که آرایه‌ها تا زمان اجرا معلوم نیستند — آرایه‌ای که به‌صورت Variant تحویل داده شده. نوع‌ها را هنگام اجرا وارسی می‌کند و به‌جای خطا دادن، از راه RET_VAL گزارش می‌دهد.',
  'mov.fill': 'یک مقدار را در یک رشته از عناصر آرایه می‌نویسد — بافر این‌گونه پاک می‌شود.',
  'mov.ufill': 'پُر کردنِ وقفه‌ناپذیر.',
  'mov.swap': 'ترتیب بایت‌های یک Word یا DWord را وارونه می‌کند. وقتی مقداری از دستگاهی دیگر بی‌معنا خوانده می‌شود اما بی‌معنایِ آشنا، سراغ همین بیایید — big-endian در برابر little-endian.',
  'mov.serialize': 'یک ساختار را به آرایه‌ای از بایت مسطح می‌کند، برای فرستادن روی یک لینک یا نوشتن در یک فایل.',
  'mov.deserialize': 'راه برگشت: آرایهٔ بایت، دوباره به ساختار.',

  // Convert
  'cnv.convert': 'نوع را عوض می‌کند و **معنا** را نگه می‌دارد — 5 از نوع Int می‌شود 5.0 از نوع Real. تفاوتش با MOVE همین است، که بیت‌ها را نگه می‌دارد. در SCL به شکل `INT_TO_REAL(...)` و `REAL_TO_DINT(...)` نوشته می‌شود.',
  'cnv.round': 'به نزدیک‌ترین عدد صحیح، و **در حالت تساوی به عدد زوج** — 0.5 می‌شود 0 و 1.5 می‌شود 2. این قاعدهٔ IEC است و یک‌بار همه را غافلگیر می‌کند.',
  'cnv.ceil': 'همیشه رو به بالا.',
  'cnv.floor': 'همیشه رو به پایین.',
  'cnv.trunc': 'بخش اعشاری را دور می‌ریزد — به‌سمت صفر، پس −2.7 می‌شود −2.',
  'cnv.scale_x': 'کسری میان 0.0 و 1.0 را به واحد مهندسی تبدیل می‌کند. نیمهٔ دوم خواندن یک ورودی آنالوگ: اول NORM_X، بعد SCALE_X.',
  'cnv.norm_x': 'یک مقدار خام را به کسری میان 0.0 و 1.0 تبدیل می‌کند. بازهٔ 0…27648 بازهٔ زیمنس برای ورودی آنالوگ تک‌قطبی است، و 4–20 میلی‌آمپر روی کارت 0–20 میلی‌آمپر از 5530 آغاز می‌شود، نه از 0 — اگر با لوپِ قطع عدد 20 درصد خوانده می‌شود، همین اشتباه رخ داده.',

  // Program control
  'ctl.jmp': 'وقتی شبکه TRUE باشد به یک برچسب در جلو می‌پرد و هر چه میان آن دو است را رد می‌کند. شبکه‌های ردشده **خروجی‌هایشان را همان‌طور که بوده نگه می‌دارند** — کویلی که از رویش پریده‌اند FALSE نمی‌شود، یخ می‌زند، و تله همین است.',
  'ctl.jmpn': 'وقتی شبکه FALSE باشد می‌پرد.',
  'ctl.label': 'جایی که پرش فرود می‌آید. بالای یک شبکه می‌نشیند و محلیِ همان بلوک است.',
  'ctl.jmp_list': 'به Kاُمین برچسب از یک فهرست می‌پرد — یک ماشین حالت، نوشته‌شده به شکل جدول پرش.',
  'ctl.switch': 'K را با یک فهرست می‌سنجد و به نخستین موردی که بخورد می‌پرد. معادل SCL آن CASE است و بسیار خواناتر.',
  'ctl.ret': 'همین حالا از بلوک بیرون می‌رود و به آنچه فراخوانده‌اش برمی‌گردد. هر چه پس از آن است رد می‌شود، با همان یخ‌زدن خروجی‌ها که در پرش گفته شد.',
  'ctl.re_trigr': 'واچ‌داگ را از نو راه می‌اندازد. برای آن حلقهٔ طولانیِ نادر که واقعاً قرار است این‌قدر طول بکشد — نه به‌عنوان راهی برای ساکت کردن اسکنی که کند شده، که پنهان کردن یک عیب است نه رفع آن.',
  'ctl.stp': 'CPU را به STOP می‌برد. خروجی‌ها به حالت امنِ پیکربندی‌شده می‌روند و ماشین یک‌باره می‌ایستد. به‌ندرت پاسخ درستی است: یک خاموشیِ کنترل‌شده در برنامه تقریباً همیشه پاسخ درست است.',
  'ctl.get_error': 'شرح کامل آخرین خطای این بلوک، تا به‌جای متوقف شدن CPU همین‌جا به آن رسیدگی شود.',
  'ctl.get_err_id': 'فقط شمارهٔ خطا — ارزان‌تر از GET_ERROR، آنجا که تنها «کار کرد یا نه» مهم است.',
  'ctl.endis_pw': 'رمزهای CPU را از داخل برنامه روشن و خاموش می‌کند.',

  // Word logic
  'wl.and': 'بیت‌به‌بیت میان دو کلمه — نه ANDِ یک پلهٔ لدر. کاربرد معمولش ماسک کردن است: AND با 16#00FF بایت پایین را نگه می‌دارد و بقیه را صفر می‌کند.',
  'wl.or': 'ORِ بیت‌به‌بیت — بیت‌ها در یک کلمه این‌گونه ست می‌شوند.',
  'wl.xor': 'بیت‌هایی که فرق دارند TRUE بیرون می‌آیند. XOR یک کلمه با مقدار پیشینش، هر بیتی را که تغییر کرده علامت می‌زند — یک تشخیص‌دهندهٔ تغییر برای یک کلمهٔ کامل.',
  'wl.invert': 'همهٔ بیت‌ها وارونه.',
  'wl.deco': 'بیتی را که شماره‌اش IN است ست می‌کند و بقیه را صفر — یک عدد، تبدیل‌شده به انتخابِ یکی از n.',
  'wl.enco': 'شمارهٔ **پایین‌ترین** بیتِ ست‌شده. اگر هیچ بیتی ست نباشد −1 می‌دهد، که ارزشِ آزمودن دارد.',
  'wl.sel': 'یکی از دو، به انتخاب یک Bool. یک IF با یک مقدار در هر سو، در قالب یک باکس.',
  'wl.mux': 'یکی از چند، به انتخاب یک عدد. **ELSE را وصل کنید**: اندیسی بیرون از فهرست وگرنه OUT را دست‌نخورده می‌گذارد، که این‌طور خوانده می‌شود که انگار برنامه دیگر پاسخ نمی‌دهد.',
  'wl.demux': 'یک مقدار، بیرون به یکی از چند خروجی، به انتخاب K.',

  // Shift and rotate
  'sr.shr': 'بیت‌ها را N جا به راست می‌برد؛ از بالا صفر وارد می‌شود و آنچه از پایین بیفتد رفته است. روی یک مقدار بی‌علامت، هر جا یعنی تقسیم بر دو.',
  'sr.shl': 'بیت‌ها را N جا به چپ می‌برد، صفر از پایین وارد می‌شود. هر جا یعنی ضرب در دو — تا وقتی بیتی از بالا بیفتد، که بی‌صداست.',
  'sr.ror': 'مثل شیفت، با این تفاوت که بیت‌هایی که از یک سر می‌افتند از سر دیگر برمی‌گردند. چیزی از دست نمی‌رود — یک الگوی چراغ گردان، یک نوبت‌دهی چرخشی.',
  'sr.rol': 'چرخش در جهت دیگر.',

  // Date and time
  'dt.t_conv': 'میان Time و LTime و DInt و بقیه. یک Time در زیر همان میلی‌ثانیه در یک DInt است، و همین است که تبدیل را دقیق می‌کند.',
  'dt.t_add': 'یک مدت را روی یک تاریخ‌وساعت، یا روی یک مدت دیگر می‌افزاید.',
  'dt.t_sub': 'یک مدت را از یک زمان کم می‌کند.',
  'dt.t_diff': 'فاصلهٔ میان دو تاریخ‌وساعت. «بچ 4 ساعت و 12 دقیقه طول کشید» این‌گونه درمی‌آید.',
  'dt.rd_sys_t': 'ساعت CPU، به وقت UTC. RD_LOC_T ساعت محلی است — ارزشش را دارد که پیش از آنکه یک لاگ یک‌ساله شود تصمیم بگیرید کدام‌یک را می‌خواهید.',
  'dt.rd_loc_t': 'ساعت، با منطقهٔ زمانی و ساعت تابستانی اعمال‌شده.',
  'dt.wr_sys_t': 'ساعت CPU را تنظیم می‌کند.',
  'dt.rtm': 'ساعت‌شمارهای خودِ CPU — که با قطع برق هم می‌مانند، و همین آن‌ها را جای صادقانهٔ ثبت ساعت کارکرد می‌کند.',

  // String and character
  'str.len': 'همین حالا چند کاراکتر در آن هست — نه اینکه چند تا جا می‌گیرد، که MAX_LEN است.',
  'str.concat': 'دو رشته را به هم می‌چسباند. آنچه در مقصد جا نشود بی‌هیچ حرفی بریده می‌شود، پس مقصد را برای بدترین حالت اندازه کنید.',
  'str.left': 'L کاراکترِ نخست.',
  'str.right': 'L کاراکترِ آخر.',
  'str.mid': 'L کاراکتر از موقعیت P. **شمارش P از 1 است**، نه از 0.',
  'str.find': 'IN2 از کجای IN1 آغاز می‌شود، یا 0 وقتی آنجا نیست.',
  'str.replace': 'IN2 را از موقعیت P روی L کاراکتر از IN1 می‌گذارد.',
  'str.delete': 'L کاراکتر را از موقعیت P بیرون می‌کشد.',
  'str.insert': 'IN2 را پس از موقعیت P در IN1 می‌گذارد.',
  'str.s_conv': 'عدد به رشته یا برعکس، در ساده‌ترین شکل ممکن. STRG_VAL و VAL_STRG کنترل روی قالب را می‌دهند.',
  'str.val_strg': 'عدد به رشته، با پهنا و تعداد رقم اعشارِ دلخواه — برای یک سطر HMI یا یک برچسب.',
  'str.strg_val': 'رشته، دوباره به عدد، که از راه RET_VAL می‌گوید خوانده شد یا نه — و همان بخشی است که باید به کار ببرید، چون اپراتور هر چیزی تایپ می‌کند.',

  // Diagnostics
  'dg.led': 'اینکه LED خودِ یک ماژول چه می‌کند، خوانده‌شده از برنامه — چراغ ERROR روی یک رک، گزارش‌شده به HMI.',
  'dg.get_diag': 'رکورد عیب‌یابیِ کامل یک ماژول یا دستگاه.',
  'dg.device_states': 'اینکه کدام دستگاه‌های روی یک خط PROFINET هستند و کدام نیستند، در یک فراخوانی.',
  'dg.module_states': 'همان پرسش، دربارهٔ ماژول‌های داخل یک دستگاه.',

  // Interrupts
  'int.attach': 'یک رویداد را به OBی که پاسخش می‌دهد وصل می‌کند، در حالی که برنامه در حال اجراست.',
  'int.detach': 'دوباره آن را جدا می‌کند.',
  'int.srt_dint': 'یک OB را پس از یک تأخیر، یک‌بار اجرا می‌کند — بدون تایمر در برنامهٔ سیکلیک.',
  'int.dis_airt': 'وقفه‌ها را نگه می‌دارد تا کاری نصفه نماند. **همیشه با EN_AIRT جفتش کنید**، در هر مسیری که از کدِ میان آن دو بیرون می‌رود.',
  'int.en_airt': 'دوباره راهشان می‌دهد.',

  // Process image
  'pi.updat_pi': 'یک پارتیشن از ورودی‌ها را همین حالا می‌خواند، به‌جای انتظار تا سرِ اسکن بعدی.',
  'pi.updat_po': 'یک پارتیشن از خروجی‌ها را همین حالا می‌نویسد.',

  // Technology
  'tec.pid_compact': 'لوپ استاندارد: یک ستپوینت، یک اندازه‌گیری و یک خروجی، با تنظیم خودکار. از Input_PER استفاده کنید تا مقدار آنالوگ خام را بگیرد و مقیاس‌گذاری را خودِ بلوک انجام دهد.',
  'tec.pid_3step': 'برای شیر موتوردار که با باز و بسته کردن رانده می‌شود، نه با یک سیگنال آنالوگ.',
  'tec.mc_power': 'محور را فعال می‌کند. تا این TRUE نشود هیچ چیز دیگری در حرکت کار نمی‌کند، و وقتی یک حرکت هیچ نمی‌کند نخستین چیزی است که باید وارسی شود.',
  'tec.mc_home': 'مرجعِ محور را به آن می‌دهد. حرکت‌های مطلق پیش از آن هیچ معنایی ندارند.',
  'tec.mc_moveabs': 'به یک موقعیت در مختصات خودِ محور می‌رود. Execute با لبه راه می‌افتد.',
  'tec.mc_movejog': 'تا وقتی شستی نگه داشته شده کار می‌کند — حالت دستی روی تابلو.',

  // Communication
  'com.tsend_c': 'یک اتصال TCP یا ISO-on-TCP برپا می‌کند و روی آن می‌فرستد. REQ با لبه راه می‌افتد — TRUE نگه داشتنش یک‌بار می‌فرستد، نه پیوسته.',
  'com.trcv_c': 'نیمهٔ گیرنده.',
  'com.mb_client': 'مسترِ Modbus TCP. هر فراخوانی یک درخواست، یکی پس از دیگری روی یک اتصال — دو REQ هم‌زمان روی یک اینستنس، رایج‌ترین دلیلی است که یک لینک Modbus «گاهی کار می‌کند».',
  'com.mb_server': 'اسلیوِ Modbus TCP — هر اسکن فراخوانش کنید و به هر که بپرسد پاسخ می‌دهد.',
  'com.put': 'ارتباط S7 با یک CPU زیمنسِ دیگر. طرف مقابل باید در تنظیمات حفاظتش دسترسی PUT/GET را اجازه دهد، که به‌صورت پیش‌فرض خاموش است و دلیل همیشگیِ کار نکردنش همین است.',
  'com.get': 'نیمهٔ خوانندهٔ ارتباط S7.',
};

const GROUP_LABEL_FA: Record<string, string> = {
  general: 'عمومی',
  bit: 'عملیات منطق بیتی',
  timer: 'عملیات تایمر',
  counter: 'عملیات شمارنده',
  compare: 'عملیات مقایسه',
  math: 'توابع ریاضی',
  move: 'عملیات انتقال',
  convert: 'عملیات تبدیل',
  control: 'عملیات کنترل برنامه',
  word: 'عملیات منطق کلمه‌ای',
  shift: 'شیفت و چرخش',
  datetime: 'تاریخ و ساعت',
  string: 'رشته و کاراکتر',
  pimage: 'تصویر فرایند',
  interrupt: 'وقفه‌ها',
  diag: 'عیب‌یابی',
  pid: 'کنترل PID',
  motion: 'کنترل حرکت',
  'open-comm': 'ارتباط باز کاربر',
  modbus: 'MODBUS TCP',
  's7-comm': 'ارتباط S7',
};

const SECTION_LABEL_FA: Record<string, string> = {
  basic: 'دستورهای پایه',
  extended: 'دستورهای گسترده',
  technology: 'تکنولوژی',
  communication: 'ارتباطات',
};

/** The one-line description, in the language being read. */
export const titleOf = (x: Instruction, fa: boolean): string =>
  (fa && TITLE_FA[x.id]) || x.title;

/**
 * The long help, in the language being read.
 *
 * Falls back to the English paragraph when an entry has no Persian one, so a
 * new instruction is readable the moment it is added rather than blank.
 */
export const helpOf = (x: Instruction, fa: boolean): string =>
  (fa && HELP_FA[x.id]) || x.help;

/** A group heading, in the language being read. */
export const groupLabelOf = (g: InstrGroup, fa: boolean): string =>
  (fa && GROUP_LABEL_FA[g.id]) || g.label;

/** A section heading, in the language being read. */
export const sectionLabelOf = (s: InstrSection, fa: boolean): string =>
  (fa && SECTION_LABEL_FA[s.id]) || s.label;
