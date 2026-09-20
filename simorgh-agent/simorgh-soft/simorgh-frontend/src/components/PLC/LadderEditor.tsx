// src/components/PLC/LadderEditor.tsx
//
// The ladder — drawn, and edited where it is drawn.
//
// The rung is laid out here rather than measured. Every element says how tall
// it is and where its wire enters, the branch takes the lowest entry point of
// its elements as its own, and the group's parallel bars are drawn between the
// first branch's wire and the last one's. Working it out in numbers rather
// than by reading the DOM back is what makes the drawing identical on every
// zoom, in full screen, and on a machine whose default font is not the one
// this was written on — all three of which have broken measured layouts in
// this app before.
//
// The elements are real HTML with real inputs in them. A canvas would look
// more like the software this imitates and would cost: the tab order, the
// browser's own find, a text cursor in an operand, and every accessibility
// affordance. An engineer typing thirty addresses wants a form, and this is a
// form that happens to be drawn as a ladder.
//
// Editing goes through `utils/plc/ladderEdit.ts`, every function of which
// returns a rung that is still legal. Nothing in this file reaches into a
// group's branches to splice something.

import React, { useMemo, useRef, useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon, GitBranchIcon,
  EyeOffIcon, EyeIcon, CopyIcon, ArrowUpIcon, ArrowDownIcon, ZapIcon,
  ScissorsIcon, ClipboardIcon,
} from 'lucide-react';
import { MenuBox } from '../shared/MenuBox';
import { Strings } from './lang';
import { Block, Coil, Contact, Element, Rung } from '../../utils/ladder/model';
import { PlcBlock, PlcNetwork, PlcProject, allTags, newNetwork } from '../../utils/plc/model';
import {
  Instruction, helpOf, instructionById, instructionByName, titleOf,
} from '../../utils/plc/instructions';
import {
  ElementPatch, LadderCursor, LadderPos, addOutput, addParallelBranch, elementAt,
  insertElement, moveElement, moveOutput, patchElement, patchOutput, patchPin,
  placeInstruction, positions, removeBranch, removeElement, removeOutput, samePos,
} from '../../utils/plc/ladderEdit';

// ── Layout numbers ──────────────────────────────────────────────────────────
// All of them in pixels, all of them here. A magic number in the middle of a
// render is a number nobody can change safely.

// Every one of these is a height the markup states outright — `height: LABEL_H`
// and not a padding that happens to come to LABEL_H. The two have to agree to
// the pixel: the wire along a branch is drawn from these numbers and the
// contact is drawn by the browser, and when the operand box came out three
// pixels shorter than LABEL_H said, every wire met every contact three pixels
// high. It reads as a drawing that has slipped, and it is the first thing
// anybody sees.
const CELL_W = 88;        // a contact or a coil
const GLYPH_H = 26;       // the drawn part of a contact
const LABEL_H = 26;       // the operand box above it
const CONTACT_H = LABEL_H + GLYPH_H;
const CONTACT_WIRE = LABEL_H + GLYPH_H / 2;
const BOX_BORDER = 2;     // the box's own outline, which the wire enters past
const BOX_HEAD = 22;      // the instruction's name bar
const PIN_H = 20;         // one pin row
const BOX_NAME_H = 20;    // the instance name above the box
const GAP = 18;           // the wire between two elements
const BRANCH_GAP = 10;    // between two parallel branches
const RAIL_PAD = 14;
const WIRE_W = 2;         // how thick a wire is drawn, in the SVG and out of it

interface Geometry { width: number; height: number; wireY: number; }

/** What is being dragged: an element at a position, or one of the coils. */
interface Dragged {
  netId: string;
  pos?: LadderPos;
  output?: number;
}

/**
 * What a slot needs to be a place something can be dropped.
 *
 * Passed down as one object rather than six props because it is threaded
 * through the group to every slot on it, and because a slot either takes a
 * drop or it does not — the parts of that are not separate decisions. The
 * positions inside a group carry `group: 0` and the group's own call site
 * puts its index back, exactly as `onSlot` and `onPatch` already do.
 */
interface Dnd {
  /** True while a drag is in flight, so a slot can show it will take it. */
  active: boolean;
  /** The slot the pointer is over now. */
  over: string | null;
  keyOf: (pos: LadderPos) => string;
  begin: (e: React.DragEvent, pos: LadderPos) => void;
  end: () => void;
  hover: (e: React.DragEvent, key: string) => void;
  drop: (e: React.DragEvent, pos: LadderPos) => void;
}

function boxPins(b: Block): { ins: Block['pins']; outs: Block['pins'] } {
  return { ins: b.pins.filter(p => !p.out), outs: b.pins.filter(p => p.out) };
}

function elementGeometry(el: Element): Geometry {
  if (el.k !== 'block') {
    return { width: CELL_W, height: CONTACT_H, wireY: CONTACT_WIRE };
  }
  const { ins, outs } = boxPins(el);
  const rows = Math.max(1, ins.length, outs.length);
  const named = el.name !== undefined;
  const top = named ? BOX_NAME_H : 0;
  return {
    width: 168,
    // Borders count: everything here is box-sizing: border-box, so the outline
    // is inside the height and the first pin row starts one border in.
    height: top + BOX_BORDER * 2 + BOX_HEAD + rows * PIN_H,
    // The wire goes into the first input, which is where it goes on a real
    // box: the rung enables the instruction, it does not pass through it.
    wireY: top + BOX_BORDER + BOX_HEAD + PIN_H / 2,
  };
}

interface BranchLayout {
  /** The geometry of each element on this branch, left to right. */
  elements: Geometry[];
  /** How far the wire is from the top of the branch's own content. */
  wire: number;
  /** How tall the branch's own content is. */
  height: number;
  width: number;
}

interface GroupLayout {
  width: number;
  branches: BranchLayout[];
}

/**
 * Where everything on a rung goes.
 *
 * **Every branch of every group shares one set of rows.** That is the whole
 * point of working it out here rather than letting each group stack its own
 * branches: a rung with two contacts in parallel in one column and two more
 * in a column further along used to draw the second pair at a different
 * height from the first, because each group measured only itself. It read as
 * a drawing that had slipped, and it is the first thing anybody notices.
 *
 * So the row a branch sits on is decided across the whole rung: row 1 is as
 * tall as the tallest first branch anywhere on the rung, row 2 as tall as the
 * tallest second branch, and so on. Every group's second branch is then at
 * the same y, which is what makes the parallel bars line up and the whole
 * network read as one grid.
 */
interface RungLayout {
  groups: GroupLayout[];
  /** The top of each row, from the top of the rung's box. */
  rowTop: number[];
  /** The y of each row's wire — where contacts sit and bars are drawn to. */
  rowWire: number[];
  rowHeight: number[];
  /**
   * The y of each stacked coil's wire.
   *
   * Their own stack, not the branch rows: a row made tall by a timer box says
   * nothing about where the second coil belongs, and every package draws a
   * column of coils at one tight pitch whatever is to the left of it.
   */
  outputWire: number[];
  height: number;
  /** The main wire: row 0, which is what the rails and the coils join. */
  wireY: number;
}

function layoutRung(rung: Rung): RungLayout {
  const groups: GroupLayout[] = rung.groups.map(group => {
    const branches: BranchLayout[] = group.branches.map(branch => {
      const elements = branch.elements.map(elementGeometry);
      const wire = Math.max(CONTACT_WIRE, ...elements.map(g => g.wireY));
      const height = Math.max(
        CONTACT_H,
        ...elements.map(g => g.height + (wire - g.wireY)),
      );
      // A branch is drawn as slot, element, slot, element, slot — one more
      // slot than there are elements, because there is a place to insert
      // before the first and after the last. Counting the gaps between the
      // elements instead left the branch narrower than what is in it, and the
      // overflow covered the next thing along the rail: the slot a new column
      // goes in could be seen and could not be clicked.
      const width = elements.length === 0
        ? CELL_W
        : elements.reduce((sum, g) => sum + g.width, 0) + GAP * (elements.length + 1);
      return { elements, wire, height, width };
    });
    return { width: Math.max(CELL_W, ...branches.map(b => b.width)), branches };
  });

  const rows = Math.max(1, ...groups.map(g => g.branches.length));

  // Row by row across every group: how far down the row its wire runs, and how
  // much room the row needs once every branch on it is hung from that wire.
  const rowWireOffset: number[] = [];
  const rowHeight: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    const onThisRow = groups.map(g => g.branches[r]).filter((b): b is BranchLayout => !!b);
    const wire = Math.max(CONTACT_WIRE, ...onThisRow.map(b => b.wire));
    rowWireOffset.push(wire);
    rowHeight.push(Math.max(
      CONTACT_H,
      ...onThisRow.map(b => b.height + (wire - b.wire)),
    ));
  }

  const rowTop: number[] = [];
  const rowWire: number[] = [];
  let y = 0;
  for (let r = 0; r < rows; r += 1) {
    rowTop.push(y);
    rowWire.push(y + rowWireOffset[r]);
    y += rowHeight[r] + BRANCH_GAP;
  }

  // The coils, stacked down the right-hand end from the rung's own wire. The
  // first one is *on* it; the rest hang below it on the drop wire, which is
  // what the rung's height has to cover — a rung driving three coils off one
  // contact is taller than its condition, and a height measured from the
  // condition alone left the lower coils hanging past the rails.
  const wireY = rowWire[0];
  const outputWire: number[] = [];
  for (let i = 0; i < Math.max(1, rung.outputs.length); i += 1) {
    outputWire.push(wireY + i * (CONTACT_H + BRANCH_GAP));
  }
  const outputsBottom = outputWire[outputWire.length - 1] + (CONTACT_H - CONTACT_WIRE);

  return {
    groups,
    rowTop,
    rowWire,
    rowHeight,
    outputWire,
    height: Math.max(CONTACT_H, y - BRANCH_GAP, outputsBottom),
    wireY,
  };
}

/** The slot past the last group — where a new column goes. */
const endPos = (rung: Rung): LadderPos => ({ group: rung.groups.length, branch: 0, slot: 0 });

// ── The drawn parts ─────────────────────────────────────────────────────────

const WIRE = 'rgb(51 65 85)';       // slate-700 — the rail and the wires

const ContactGlyph: React.FC<{ kind: Contact['k']; on?: boolean }> = ({ kind, on }) => (
  <svg width={CELL_W} height={GLYPH_H} className="block">
    <line x1={0} y1={GLYPH_H / 2} x2={CELL_W / 2 - 9} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={WIRE_W} />
    <line x1={CELL_W / 2 + 9} y1={GLYPH_H / 2} x2={CELL_W} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={WIRE_W} />
    <line
      x1={CELL_W / 2 - 9} y1={4} x2={CELL_W / 2 - 9} y2={GLYPH_H - 4}
      stroke={on ? '#16a34a' : WIRE} strokeWidth={2}
    />
    <line
      x1={CELL_W / 2 + 9} y1={4} x2={CELL_W / 2 + 9} y2={GLYPH_H - 4}
      stroke={on ? '#16a34a' : WIRE} strokeWidth={2}
    />
    {kind === 'nc' && (
      <line
        x1={CELL_W / 2 - 11} y1={GLYPH_H - 3} x2={CELL_W / 2 + 11} y2={3}
        stroke={WIRE} strokeWidth={WIRE_W}
      />
    )}
    {(kind === 'p' || kind === 'n') && (
      <text
        x={CELL_W / 2} y={GLYPH_H / 2 + 4} textAnchor="middle"
        fontSize={11} fontWeight={700} fill={WIRE}
      >
        {kind.toUpperCase()}
      </text>
    )}
  </svg>
);

const COIL_LETTER: Record<Coil['k'], string> = {
  coil: '', set: 'S', reset: 'R', 'pulse-p': 'P', 'pulse-n': 'N',
};

const CoilGlyph: React.FC<{ kind: Coil['k'] }> = ({ kind }) => {
  const cx = CELL_W / 2;
  const r = 10;
  return (
    <svg width={CELL_W} height={GLYPH_H} className="block">
      <line x1={0} y1={GLYPH_H / 2} x2={cx - r} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={WIRE_W} />
      <path
        d={`M ${cx - r} ${GLYPH_H / 2 - 9} A ${r} ${r} 0 0 0 ${cx - r} ${GLYPH_H / 2 + 9}`}
        fill="none" stroke={WIRE} strokeWidth={2}
      />
      <path
        d={`M ${cx + r} ${GLYPH_H / 2 - 9} A ${r} ${r} 0 0 1 ${cx + r} ${GLYPH_H / 2 + 9}`}
        fill="none" stroke={WIRE} strokeWidth={2}
      />
      <line x1={cx + r} y1={GLYPH_H / 2} x2={CELL_W} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={WIRE_W} />
      {COIL_LETTER[kind] && (
        <text x={cx} y={GLYPH_H / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={WIRE}>
          {COIL_LETTER[kind]}
        </text>
      )}
    </svg>
  );
};

/** The operand box above a contact or a coil. */
const Operand: React.FC<{
  value: string; readOnly?: boolean; placeholder?: string; title?: string;
  onChange: (v: string) => void; known?: boolean;
}> = ({ value, readOnly, placeholder, title, onChange, known }) => (
  // The box is LABEL_H tall and says so; the input is centred inside it. Left
  // to a margin and a height that came to LABEL_H minus three, the glyph below
  // started three pixels high and every wire on the rung missed it.
  <div className="flex items-center w-full px-0.5" style={{ height: LABEL_H }}>
    <input
      className={`w-full text-center text-[10.5px] leading-tight px-0.5 py-0.5 rounded font-mono
        bg-transparent border border-transparent hover:border-gray-300
        focus:border-blue-400 focus:bg-white focus:outline-none
        ${known === false && value ? 'text-amber-700 underline decoration-dotted decoration-amber-500' : ''}`}
      value={value}
      readOnly={readOnly}
      placeholder={placeholder ?? '<??.?>'}
      title={title}
      spellCheck={false}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
    />
  </div>
);

// ── The editor ──────────────────────────────────────────────────────────────

interface Props {
  project: PlcProject;
  block: PlcBlock;
  readOnly?: boolean;
  onChange: (networks: PlcNetwork[]) => void;
  /** What the catalogue has selected, inserted when a slot is clicked. */
  armed: Instruction | null;
  /** Told when something was inserted, so the catalogue can disarm. */
  onInserted?: () => void;
  /**
   * Where the cursor is.
   *
   * Held by the page rather than here, because the catalogue can insert too —
   * and an instruction double-clicked in the catalogue has to land where the
   * engineer last clicked on the rung, not at the top of the block.
   */
  cursor: LadderCursor | null;
  onCursor: (c: LadderCursor | null) => void;
  t: Strings;
}

export const LadderEditor: React.FC<Props> = ({
  project, block, readOnly, onChange, armed, onInserted, cursor, onCursor, t,
}) => {
  const networks = block.networks ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setCursor = onCursor;
  const [menu, setMenu] = useState<
  { x: number; y: number; netId: string; pos?: LadderPos; output?: number } | null>(null);
  /** Which coil is picked, if it is a coil that is picked and not an element. */
  const [selCoil, setSelCoil] = useState<{ netId: string; index: number } | null>(null);
  /** The editor's own clipboard. One element, which is what Ctrl+C copies. */
  const [clip, setClip] = useState<Element | null>(null);
  // What is being dragged is a ref because nothing on screen depends on *what*
  // it is; whether a drag is happening at all is state, because every slot on
  // the block lights up to say it will take it.
  const drag = useRef<Dragged | null>(null);
  /** The block's own box, which has to take the focus back off an operand. */
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dropAt, setDropAt] = useState<string | null>(null);

  const known = useMemo(() => {
    const names = new Set<string>();
    for (const t of allTags(project)) names.add(t.name.toLowerCase());
    for (const v of block.interface) if (v.name) names.add(`#${v.name}`.toLowerCase());
    for (const b of project.blocks) names.add(b.name.toLowerCase());
    return names;
  }, [project, block.interface]);

  const isKnown = (operand: string): boolean => {
    const s = (operand ?? '').trim();
    if (!s) return true;                                  // empty is not wrong yet
    if (s.startsWith('%')) return true;
    if (/^(TRUE|FALSE)$/i.test(s) || /^[-+]?\d/.test(s) || /^[A-Za-z_]\w*#/.test(s)) return true;
    const bare = s.replace(/"/g, '').split(/[.[]/)[0];
    return known.has(bare.toLowerCase()) || known.has(`#${bare}`.toLowerCase())
      || known.has(s.split(/[.[]/)[0].toLowerCase());
  };

  const patchNetwork = (id: string, change: Partial<PlcNetwork>) =>
    onChange(networks.map(n => (n.id === id ? { ...n, ...change } : n)));

  const patchRung = (id: string, next: Rung) => patchNetwork(id, { rung: next });

  const rungOf = (netId: string): Rung | null =>
    networks.find(n => n.id === netId)?.rung ?? null;

  /** Renumber after an insert or a delete, so the numbers are the order. */
  const renumber = (list: PlcNetwork[]): PlcNetwork[] =>
    list.map((n, i) => ({ ...n, rung: { ...n.rung, number: i + 1 } }));

  const addNetwork = (after?: string) => {
    const at = after ? networks.findIndex(n => n.id === after) + 1 : networks.length;
    const next = [...networks];
    next.splice(at, 0, newNetwork(at + 1, { title: '' }));
    onChange(renumber(next));
  };

  const deleteNetwork = (id: string) => {
    const net = networks.find(n => n.id === id);
    const filled = net && (net.rung.groups.length > 0 || net.rung.outputs.length > 0);
    if (filled && !window.confirm(`${t.deleteNetwork} ${net.rung.number}?\n${t.deleteNetworkAsk}`)) {
      return;
    }
    onChange(renumber(networks.filter(n => n.id !== id)));
  };

  const moveNetwork = (id: string, by: -1 | 1) => {
    const at = networks.findIndex(n => n.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= networks.length) return;
    const next = [...networks];
    [next[at], next[to]] = [next[to], next[at]];
    onChange(renumber(next));
  };

  const duplicateNetwork = (id: string) => {
    const at = networks.findIndex(n => n.id === id);
    if (at < 0) return;
    const copy = newNetwork(at + 2, {
      title: `${networks[at].title} (copy)`,
      comment: networks[at].comment,
      rung: JSON.parse(JSON.stringify(networks[at].rung)),
    });
    const next = [...networks];
    next.splice(at + 1, 0, copy);
    onChange(renumber(next));
  };

  /** The armed instruction, put where the cursor is. */
  const place = (netId: string, pos: LadderPos, instr: Instruction, onElement = false) => {
    if (readOnly) return;
    const placed = placeInstruction(networks, { netId, pos, onElement }, instr);
    if (!placed) return;
    onChange(placed.networks);
    setCursor(placed.cursor);
    onInserted?.();
  };

  /** A gap picked: the place something goes. */
  const clickSlot = (netId: string, pos: LadderPos) => {
    setCursor({ netId, pos });
    // One thing is picked at a time: a coil left ringed while a contact is
    // selected is a Delete key that takes off whichever the engineer is not
    // looking at.
    setSelCoil(null);
    if (armed) place(netId, pos, armed);
  };

  /** An element picked — and what is armed goes in after it, not in front. */
  const clickElement = (netId: string, pos: LadderPos) => {
    setCursor({ netId, pos, onElement: true });
    setSelCoil(null);
    if (armed) place(netId, pos, armed, true);
  };

  /** A toolbar button's instruction, put in at the cursor straight away. */
  const insertNow = (id: string) => {
    const instr = instructionById(id);
    if (!instr || readOnly) return;
    // A branch opened with a **coil** picked is another coil beside it. That
    // is the gesture this command has on every ladder editor — select the
    // output, open a branch, get a second output on the same condition — and
    // it is the one the rung on the sheet actually shows: the drop wire after
    // the last contact with two coils hanging off it.
    if (id === 'gen.branch.open' && selCoil) {
      const rung = rungOf(selCoil.netId);
      if (!rung) return;
      patchRung(selCoil.netId, addOutput(rung, { k: 'coil', at: '' }, selCoil.index + 1));
      setSelCoil({ ...selCoil, index: selCoil.index + 1 });
      return;
    }
    const placed = placeInstruction(networks, cursor ?? null, instr);
    if (!placed) return;
    onChange(placed.networks);
    setCursor(placed.cursor);
  };

  // ── Editing it the way anything else on a screen is edited ───────────────
  //
  // Pick something up and drop it somewhere else; press Delete to take it off;
  // Ctrl+C and Ctrl+V; the arrows to move along the rung. None of this is
  // ladder-specific and all of it is what somebody arrives already knowing,
  // which is exactly why its absence reads as the editor being broken rather
  // than as a feature not being there. Every one of them goes through
  // `ladderEdit`, so a drag can no more make an illegal rung than a menu can.

  /** A copy that shares nothing: two boxes must not hold one array of pins. */
  const dup = (el: Element): Element => JSON.parse(JSON.stringify(el)) as Element;

  const coilSelected = (netId: string, index: number): boolean =>
    selCoil?.netId === netId && selCoil.index === index;

  /**
   * A coil picked. The element cursor stays where it is: it is where the
   * catalogue puts the next instruction, and a coil is not a place for one.
   *
   * It stops being a *selection*, though. `onElement` is what rings an element,
   * and leaving it set while a coil is picked put two rings on the rung at
   * once — and Delete takes the coil, so the ring the engineer was looking at
   * was the one it did not touch. Picking an element already clears the coil;
   * this is the other half of the same rule, and without it the rule only
   * holds in one direction.
   */
  const selectCoil = (netId: string, index: number) => {
    setSelCoil({ netId, index });
    if (cursor?.onElement) setCursor({ ...cursor, onElement: false });
  };

  /** The picked element, or nothing when what is picked is a gap. */
  const elementAtCursor = (at: LadderCursor | null = cursor): Element | null => {
    if (!at || !at.onElement) return null;
    const rung = rungOf(at.netId);
    return rung ? elementAt(rung, at.pos) : null;
  };

  const onCursorElement = elementAtCursor() !== null;
  const hasSelection = onCursorElement || selCoil !== null;

  /** Whatever is picked, taken off the rung — the Delete key and the button. */
  const deleteSelection = () => {
    if (readOnly) return;
    if (selCoil) {
      const rung = rungOf(selCoil.netId);
      if (rung) patchRung(selCoil.netId, removeOutput(rung, selCoil.index));
      setSelCoil(null);
      return;
    }
    // A gap is not a picked element: the cursor sitting in front of a contact
    // must not delete the contact it is in front of.
    if (!cursor?.onElement) return;
    const rung = rungOf(cursor.netId);
    if (rung) patchRung(cursor.netId, removeElement(rung, cursor.pos));
  };

  // Both take where to work explicitly, because the menu sets the cursor and
  // copies in the same handler: React has not given the new cursor back by
  // then, and read from the prop these would have copied whatever was picked
  // before the menu was opened.
  const copySelection = (cut: boolean, at: LadderCursor | null = cursor) => {
    const el = elementAtCursor(at);
    if (!el || !at) return;
    setClip(dup(el));
    if (cut && !readOnly) {
      const rung = rungOf(at.netId);
      if (rung) patchRung(at.netId, removeElement(rung, at.pos));
    }
  };

  const pasteAtCursor = (at: LadderCursor | null = cursor) => {
    if (!clip || !at || readOnly) return;
    const rung = rungOf(at.netId);
    if (!rung) return;
    // After the picked element, or into the picked gap — the same rule the
    // catalogue and the toolbar follow.
    const to = at.onElement ? { ...at.pos, slot: at.pos.slot + 1 } : at.pos;
    patchRung(at.netId, insertElement(rung, to, dup(clip)));
    setCursor({ netId: at.netId, pos: { ...to, slot: to.slot + 1 } });
  };

  /** Left and right: along the rung, slot by slot, in reading order. */
  const stepCursor = (by: -1 | 1) => {
    if (!cursor) return;
    const rung = rungOf(cursor.netId);
    if (!rung) return;
    const all = positions(rung);
    const at = all.findIndex(p => samePos(p, cursor.pos));
    const next = all[Math.min(all.length - 1, Math.max(0, (at < 0 ? 0 : at) + by))];
    if (next) setCursor({ netId: cursor.netId, pos: next, onElement: !!elementAt(rung, next) });
  };

  /** Up and down: between the parallel branches, or down the coils. */
  const stepRow = (by: -1 | 1) => {
    if (selCoil) {
      const rung = rungOf(selCoil.netId);
      if (!rung) return;
      const index = Math.min(rung.outputs.length - 1, Math.max(0, selCoil.index + by));
      setSelCoil({ ...selCoil, index });
      return;
    }
    if (!cursor) return;
    const group = rungOf(cursor.netId)?.groups[cursor.pos.group];
    if (!group) return;
    const branch = Math.min(group.branches.length - 1, Math.max(0, cursor.pos.branch + by));
    const slot = Math.min(cursor.pos.slot, group.branches[branch].elements.length);
    const pos = { ...cursor.pos, branch, slot };
    setCursor({ netId: cursor.netId, pos, onElement: !!group.branches[branch].elements[slot] });
  };

  /**
   * The keys — and every one of them stays out of the way of an operand.
   *
   * Each address on the ladder is a real text input, so while one has the
   * focus Delete, Backspace and the arrows belong to the text being typed: an
   * editor that deleted a contact because somebody was correcting `%I0.1`
   * would be worse than one with no shortcuts at all. Escape is the one key
   * that means the same in both places — leave what I am in.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
    if (e.key === 'Escape') {
      // Out of the operand and back onto the ladder — not out of the editor
      // altogether. Blurring alone left the focus on the document body, where
      // the next Delete went nowhere and the ladder looked like it had
      // stopped listening.
      if (typing) { target.blur(); box.current?.focus(); } else { setCursor(null); setSelCoil(null); }
      return;
    }
    if (typing) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'c') { copySelection(false); e.preventDefault(); return; }
    if (ctrl && key === 'x') { copySelection(true); e.preventDefault(); return; }
    if (ctrl && key === 'v') { pasteAtCursor(); e.preventDefault(); return; }
    if (ctrl) return;

    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { stepCursor(-1); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { stepCursor(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { stepRow(-1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { stepRow(1); e.preventDefault(); }
  };

  // ── Dragging ─────────────────────────────────────────────────────────────

  const slotKey = (netId: string, pos: LadderPos) =>
    `${netId}:${pos.group}:${pos.branch}:${pos.slot}`;
  const outKey = (netId: string, index: number) => `${netId}:coil:${index}`;

  const beginDrag = (e: React.DragEvent, what: Dragged) => {
    if (readOnly) return;
    drag.current = what;
    setDragging(true);
    e.dataTransfer.effectAllowed = 'move';
    // Something has to be on the transfer or the browser starts no drag.
    e.dataTransfer.setData('text/plain', 'ladder');
    e.stopPropagation();
  };

  const endDrag = () => { drag.current = null; setDragging(false); setDropAt(null); };

  const hoverDrop = (e: React.DragEvent, key: string) => {
    if (!drag.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropAt !== key) setDropAt(key);
  };

  /** An element dropped on a slot — from this rung, or from another one. */
  const dropOnSlot = (e: React.DragEvent, netId: string, pos: LadderPos) => {
    const from = drag.current;
    endDrag();
    if (!from || readOnly) return;
    const fromPos = from.pos;
    if (!fromPos) return;
    e.preventDefault(); e.stopPropagation();

    if (from.netId === netId) {
      const rung = rungOf(netId);
      if (rung) patchRung(netId, moveElement(rung, fromPos, pos));
      setCursor({ netId, pos, onElement: true });
      return;
    }
    // Across two networks: out of one rung and into the other in one change,
    // so the block is never left holding the element twice or not at all.
    const source = rungOf(from.netId);
    const element = source ? elementAt(source, fromPos) : null;
    if (!element) return;
    onChange(networks.map(n => {
      if (n.id === from.netId) return { ...n, rung: removeElement(n.rung, fromPos) };
      if (n.id === netId) return { ...n, rung: insertElement(n.rung, pos, dup(element)) };
      return n;
    }));
    setCursor({ netId, pos, onElement: true });
  };

  /** A coil dropped on a coil: the stack put in another order. */
  const dropOnOutput = (e: React.DragEvent, netId: string, index: number) => {
    const from = drag.current;
    endDrag();
    if (!from || readOnly || from.output === undefined || from.netId !== netId) return;
    e.preventDefault(); e.stopPropagation();
    const rung = rungOf(netId);
    if (rung) patchRung(netId, moveOutput(rung, from.output, index));
    setSelCoil({ netId, index });
  };

  return (
    <div
      dir="ltr"
      ref={box}
      // The keys are handled here, on the block, rather than on the window:
      // this page has a code editor, a tag table and a tree on it, and a
      // Delete key caught globally would take a contact off the rung while
      // somebody was clearing a row of the tag table. `tabIndex` is what lets
      // a div have the focus at all; the outline is left to the selection
      // ring, which says the same thing in the place it matters.
      tabIndex={0}
      className="h-full overflow-auto bg-white focus:outline-none"
      onKeyDown={onKeyDown}
      onClick={() => menu && setMenu(null)}
    >
      {/* ── The rung toolbar ─────────────────────────────────────────────
          The six things a ladder is actually built out of, in the order
          every package puts them in. They are here and not only in the
          catalogue because building a rung is contact, contact, branch,
          coil — four presses in a row — and going back to a tree on the
          other side of the screen between each one is the difference
          between drawing a network and assembling one. */}
      {!readOnly && networks.length > 0 && (
        <div className="sticky top-0 z-20 flex items-center gap-1 px-2 py-1.5
          bg-gray-50 border-b border-gray-200">
          <RungTool onClick={() => insertNow('bit.no')} title={t.contactNo} glyph="normally-open" />
          <RungTool onClick={() => insertNow('bit.nc')} title={t.contactNc} glyph="normally-closed" />
          <RungTool onClick={() => insertNow('bit.coil')} title={t.coil} glyph="coil" />
          <RungTool onClick={() => insertNow('gen.box')} title={t.emptyBox} glyph="box" />
          <span className="w-px h-5 bg-gray-300 mx-1" />
          <RungTool
            onClick={() => insertNow('gen.branch.open')}
            title={`${t.openBranch} — ${t.openBranchNote}`}
            glyph="open-branch"
          />
          <RungTool
            onClick={() => insertNow('gen.branch.close')}
            title={`${t.closeBranch} — ${t.closeBranchNote}`}
            glyph="close-branch"
          />
          <span className="w-px h-5 bg-gray-300 mx-1" />
          <RungTool
            onClick={deleteSelection}
            title={t.deleteElement}
            glyph="delete"
            disabled={!hasSelection}
          />
          <span className="ms-2 text-[11px] text-gray-500 truncate">
            {cursor
              ? `${t.network} ${networks.find(n => n.id === cursor.netId)?.rung.number ?? ''}`
              : t.clickThenPick}
          </span>
          <span className="ms-auto text-[11px] text-gray-400 truncate hidden md:inline">
            {t.editKeysHint}
          </span>
        </div>
      )}

      {networks.length === 0 && (
        <div className="p-8 text-center text-[12px] text-gray-500">
          <p>{t.noNetworks}</p>
          {!readOnly && (
            <button
              onClick={() => addNetwork()}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-[12px]"
            >
              <PlusIcon className="w-4 h-4" /> {t.addFirstNetwork}
            </button>
          )}
        </div>
      )}

      {networks.map(net => {
        const isClosed = collapsed.has(net.id);
        const layout = layoutRung(net.rung);
        return (
          <section
            key={net.id}
            className={`border-b border-gray-200 ${net.disabled ? 'opacity-50' : ''}`}
          >
            {/* ── The network's own header ───────────────────────────── */}
            <header className="flex items-center gap-2 px-2 py-1.5 bg-slate-50">
              <button
                className="p-0.5 rounded hover:bg-slate-200"
                onClick={() => setCollapsed(prev => {
                  const next = new Set(prev);
                  if (next.has(net.id)) next.delete(net.id); else next.add(net.id);
                  return next;
                })}
                title={isClosed ? 'Open this network' : 'Fold this network away'}
              >
                {isClosed ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
              </button>
              <span className="text-[12px] font-semibold text-slate-600 shrink-0">
                {t.network} {net.rung.number}:
              </span>
              <input
                className="flex-1 min-w-0 bg-transparent text-[12px] px-1.5 py-0.5 rounded
                  border border-transparent hover:border-gray-300 focus:border-blue-400
                  focus:bg-white focus:outline-none"
                value={net.title}
                readOnly={readOnly}
                placeholder={t.networkTitlePlaceholder}
                onChange={e => patchNetwork(net.id, { title: e.target.value })}
              />
              {!readOnly && (
                <>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title={net.disabled ? t.networkOn : t.networkOff}
                    onClick={() => patchNetwork(net.id, { disabled: !net.disabled })}
                  >
                    {net.disabled
                      ? <EyeOffIcon className="w-3.5 h-3.5" />
                      : <EyeIcon className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title={t.addNetworkAfter}
                    onClick={() => addNetwork(net.id)}
                  >
                    <PlusIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title="⋮"
                    onClick={e => {
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, netId: net.id });
                    }}
                  >
                    <span className="block w-3.5 text-center leading-none">⋮</span>
                  </button>
                </>
              )}
            </header>

            {!isClosed && (
              <>
                <input
                  className="w-full bg-transparent text-[11px] italic text-gray-500 px-9 py-1
                    border-0 focus:outline-none focus:bg-blue-50"
                  value={net.comment ?? ''}
                  readOnly={readOnly}
                  placeholder={t.networkCommentPlaceholder}
                  onChange={e => patchNetwork(net.id, { comment: e.target.value })}
                />

                {/* ── The rung ───────────────────────────────────────── */}
                <div className="overflow-x-auto px-3 pb-3">
                  <div
                    className="relative flex items-start"
                    style={{ minHeight: layout.height + RAIL_PAD * 2, paddingTop: RAIL_PAD }}
                  >
                    {/* The left rail. */}
                    <div
                      className="shrink-0"
                      style={{ width: 2, background: WIRE, height: layout.height }}
                    />

                    {net.rung.groups.map((group, gi) => (
                      <GroupView
                        key={gi}
                        group={group}
                        layout={layout.groups[gi]}
                        rung={layout}
                        atRail={gi === 0}
                        hint={armed ? t.placeHere : t.clickThenPick}
                        t={t}
                        readOnly={readOnly}
                        // Filtered to this group here rather than compared
                        // inside it: the group renders its branches with
                        // indices of their own, and a cursor that only
                        // carried a branch and a slot lit up the same
                        // position in every column of the rung.
                        cursor={cursor?.netId === net.id && cursor.pos.group === gi
                          ? cursor.pos : null}
                        onElement={cursor?.onElement === true}
                        isKnown={isKnown}
                        onSlot={pos => clickSlot(net.id, { ...pos, group: gi })}
                        onPick={pos => clickElement(net.id, { ...pos, group: gi })}
                        onSelect={pos => {
                          setCursor({ netId: net.id, pos: { ...pos, group: gi }, onElement: true });
                          setSelCoil(null);
                        }}
                        onPatch={(pos, patch) =>
                          patchRung(net.id, patchElement(net.rung, { ...pos, group: gi }, patch))}
                        onPin={(pos, pin, value) =>
                          patchRung(net.id, patchPin(net.rung, { ...pos, group: gi }, pin, value))}
                        onMenu={(e, pos) => {
                          e.preventDefault(); e.stopPropagation();
                          setMenu({ x: e.clientX, y: e.clientY, netId: net.id, pos: { ...pos, group: gi } });
                        }}
                        dnd={{
                          active: dragging,
                          over: dropAt,
                          keyOf: pos => slotKey(net.id, { ...pos, group: gi }),
                          begin: (e, pos) => beginDrag(e, { netId: net.id, pos: { ...pos, group: gi } }),
                          end: endDrag,
                          hover: hoverDrop,
                          drop: (e, pos) => dropOnSlot(e, net.id, { ...pos, group: gi }),
                        }}
                      />
                    ))}

                    {/* The place a new column goes: after everything. */}
                    <Slot
                      active={samePos(cursor?.netId === net.id ? cursor.pos : null,
                        { group: net.rung.groups.length, branch: 0, slot: 0 })}
                      readOnly={readOnly}
                      wireY={layout.wireY}
                      height={layout.height}
                      hint={armed ? t.placeHere : t.clickThenPick}
                      onClick={() => clickSlot(net.id, { group: net.rung.groups.length, branch: 0, slot: 0 })}
                      dropping={dropAt === slotKey(net.id, endPos(net.rung))}
                      onDragOver={e => hoverDrop(e, slotKey(net.id, endPos(net.rung)))}
                      onDrop={e => dropOnSlot(e, net.id, endPos(net.rung))}
                    />

                    {/* The wire across to the outputs.
                        It grows, because a coil belongs at the right-hand
                        rail and not wherever the condition happened to end —
                        that is how every rung is drawn and it is what makes a
                        column of coils readable down a block of networks. */}
                    <div
                      className="flex-1"
                      style={{ minWidth: 24, height: 2, background: WIRE, marginTop: layout.wireY - 1 }}
                    />

                    {/* The coils, and the wire that feeds them.

                        Coils after the first hang off a **drop wire down the
                        left of the column**, and each one's own lead carries
                        the current from that drop across to the right rail.
                        That drop is the whole picture of a rung with two
                        outputs — without it the second coil sat on the sheet
                        joined to nothing, which is a drawing that says the
                        opposite of what the program does. It is drawn here
                        the way `utils/ladder/render.ts` has always drawn it
                        on a printed sheet. */}
                    <div className="shrink-0" style={{ width: CELL_W }}>
                      {/* As tall as the coils are, not as tall as the rung:
                          `+ coil` belongs under the last coil, and hung off
                          the full height it drifted half a rung away from the
                          thing it adds to whenever the condition was taller
                          than the output stack. */}
                      <div
                        className="relative"
                        style={{
                          width: CELL_W,
                          height: layout.outputWire[Math.max(0, net.rung.outputs.length - 1)]
                            + (CONTACT_H - CONTACT_WIRE),
                        }}
                      >
                        {/* A rung with nothing on the right yet still has a
                            wire running to the rail: the column keeps its
                            width whether or not a coil is in it, and an
                            unfinished rung should read as unfinished, not as
                            a wire that stops in mid-air. */}
                        {net.rung.outputs.length === 0 && (
                          <span
                            className="absolute"
                            style={{ left: 0, right: 0, top: layout.wireY - 1, height: 2, background: WIRE }}
                          />
                        )}
                        {net.rung.outputs.length > 1 && (
                          <span
                            className="absolute"
                            style={{
                              left: 0,
                              top: layout.wireY,
                              height: layout.outputWire[net.rung.outputs.length - 1] - layout.wireY,
                              width: 2,
                              background: WIRE,
                            }}
                          />
                        )}
                        {net.rung.outputs.map((out, oi) => (
                          <div
                            key={oi}
                            className={`absolute flex flex-col items-center rounded
                              ${coilSelected(net.id, oi) ? 'ring-2 ring-blue-400' : ''}
                              ${readOnly ? '' : 'cursor-grab'}`}
                            style={{ left: 0, width: CELL_W, top: layout.outputWire[oi] - CONTACT_WIRE }}
                            draggable={!readOnly}
                            onDragStart={e => beginDrag(e, { netId: net.id, output: oi })}
                            onDragEnd={endDrag}
                            onDragOver={e => hoverDrop(e, outKey(net.id, oi))}
                            onDrop={e => dropOnOutput(e, net.id, oi)}
                            onClick={() => selectCoil(net.id, oi)}
                            onFocus={() => selectCoil(net.id, oi)}
                            onContextMenu={e => {
                              if (readOnly) return;
                              e.preventDefault(); e.stopPropagation();
                              selectCoil(net.id, oi);
                              setMenu({ x: e.clientX, y: e.clientY, netId: net.id, output: oi });
                            }}
                          >
                            <Operand
                              value={out.at}
                              readOnly={readOnly}
                              known={isKnown(out.at)}
                              title={out.label}
                              onChange={v => patchRung(net.id, patchOutput(net.rung, oi, { at: v }))}
                            />
                            <CoilGlyph kind={out.k} />
                          </div>
                        ))}
                      </div>
                      {!readOnly && (
                        <button
                          className="text-[10px] text-blue-600 hover:underline px-1"
                          title={t.addCoil}
                          onClick={() => patchRung(net.id, addOutput(net.rung, { k: 'coil', at: '' }))}
                        >
                          {t.addCoil}
                        </button>
                      )}
                    </div>

                    {/* The right rail, which the coils' leads run into — so no
                        gap between it and the column: a lead that stops short
                        of the rail is a coil wired to nothing. */}
                    <div
                      className="shrink-0"
                      style={{ width: 2, background: WIRE, height: layout.height }}
                    />
                  </div>
                </div>
              </>
            )}
          </section>
        );
      })}

      {!readOnly && networks.length > 0 && (
        <div className="p-3">
          <button
            onClick={() => addNetwork()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-dashed
              border-gray-300 text-[12px] text-gray-600
              hover:border-blue-400 hover:text-blue-700"
          >
            <PlusIcon className="w-4 h-4" /> {t.addNetwork}
          </button>
        </div>
      )}

      {menu && (
        <MenuBox
          x={menu.x} y={menu.y}
          className="z-[140] w-60 bg-white border border-gray-200 shadow-lg rounded-md py-1"
        >
          {menu.pos && (() => {
            const net = networks.find(n => n.id === menu.netId);
            if (!net) return null;
            const pos = menu.pos;
            return (
              <>
                <Item
                  icon={<GitBranchIcon className="w-3.5 h-3.5" />}
                  label={t.openBranch}
                  hint={elementAt(net.rung, pos) ? t.openBranchHere : t.openBranchNote}
                  onClick={() => {
                    // The menu is only ever opened on an element, so the
                    // branch is opened around that element.
                    const opened = addParallelBranch(net.rung, pos, true);
                    patchRung(menu.netId, opened.rung);
                    // The cursor goes into the new branch — which the edit
                    // itself says where it is, because opening a branch around
                    // one contact splits the column and renumbers the groups
                    // after it. The next thing picked belongs in that branch
                    // and nowhere else; left where it was, it landed back in
                    // series with what the branch was opened beside.
                    setCursor({ netId: menu.netId, pos: opened.cursor });
                    setMenu(null);
                  }}
                />
                <div className="border-t border-gray-100 my-1" />
                <Item
                  icon={<CopyIcon className="w-3.5 h-3.5" />}
                  label={t.copyElement}
                  onClick={() => { copySelection(false, { netId: menu.netId, pos }); setMenu(null); }}
                />
                <Item
                  icon={<ScissorsIcon className="w-3.5 h-3.5" />}
                  label={t.cutElement}
                  onClick={() => { copySelection(true, { netId: menu.netId, pos }); setMenu(null); }}
                />
                <Item
                  icon={<ClipboardIcon className="w-3.5 h-3.5" />}
                  label={t.pasteElement}
                  onClick={() => { pasteAtCursor({ netId: menu.netId, pos }); setMenu(null); }}
                />
                <div className="border-t border-gray-100 my-1" />
                <Item
                  icon={<TrashIcon className="w-3.5 h-3.5" />}
                  label={t.deleteElement}
                  onClick={() => { patchRung(menu.netId, removeElement(net.rung, pos)); setMenu(null); }}
                />
                <Item
                  icon={<TrashIcon className="w-3.5 h-3.5" />}
                  label={t.deleteBranch}
                  danger
                  onClick={() => {
                    patchRung(menu.netId, removeBranch(net.rung, pos.group, pos.branch));
                    setMenu(null);
                  }}
                />
              </>
            );
          })()}

          {menu.output !== undefined && (() => {
            const net = networks.find(n => n.id === menu.netId);
            if (!net) return null;
            const oi = menu.output;
            const kinds: Coil['k'][] = ['coil', 'set', 'reset', 'pulse-p', 'pulse-n'];
            const names: Record<Coil['k'], string> = {
              coil: t.coilKindAssign,
              set: t.coilKindSet,
              reset: t.coilKindReset,
              'pulse-p': t.coilKindP,
              'pulse-n': t.coilKindN,
            };
            return (
              <>
                {kinds.map(k => (
                  <Item
                    key={k}
                    icon={<ZapIcon className="w-3.5 h-3.5" />}
                    label={names[k]}
                    onClick={() => { patchRung(menu.netId, patchOutput(net.rung, oi, { k })); setMenu(null); }}
                  />
                ))}
                <div className="border-t border-gray-100 my-1" />
                <Item
                  icon={<TrashIcon className="w-3.5 h-3.5" />}
                  label={t.deleteCoil}
                  danger
                  onClick={() => { patchRung(menu.netId, removeOutput(net.rung, oi)); setMenu(null); }}
                />
              </>
            );
          })()}

          {!menu.pos && menu.output === undefined && (
            <>
              <Item
                icon={<PlusIcon className="w-3.5 h-3.5" />}
                label={t.addNetworkAfter}
                onClick={() => { addNetwork(menu.netId); setMenu(null); }}
              />
              <Item
                icon={<CopyIcon className="w-3.5 h-3.5" />}
                label={t.duplicateNetwork}
                onClick={() => { duplicateNetwork(menu.netId); setMenu(null); }}
              />
              <Item
                icon={<ArrowUpIcon className="w-3.5 h-3.5" />}
                label={t.moveUp}
                onClick={() => { moveNetwork(menu.netId, -1); setMenu(null); }}
              />
              <Item
                icon={<ArrowDownIcon className="w-3.5 h-3.5" />}
                label={t.moveDown}
                onClick={() => { moveNetwork(menu.netId, 1); setMenu(null); }}
              />
              <div className="border-t border-gray-100 my-1" />
              <Item
                icon={<TrashIcon className="w-3.5 h-3.5" />}
                label={t.deleteNetwork}
                danger
                onClick={() => { deleteNetwork(menu.netId); setMenu(null); }}
              />
            </>
          )}
        </MenuBox>
      )}
    </div>
  );
};

// ── One group ───────────────────────────────────────────────────────────────

const GroupView: React.FC<{
  group: Rung['groups'][0];
  layout: GroupLayout;
  /** The rung's own rows, shared by every group on it. */
  rung: RungLayout;
  /** True for the first group, whose branches hang off the rail itself. */
  atRail: boolean;
  readOnly?: boolean;
  cursor: LadderPos | null;
  /** Whether the cursor is on the element at that position or the gap. */
  onElement: boolean;
  isKnown: (v: string) => boolean;
  onSlot: (pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  /** An element picked, which is not the same place as the gap before it. */
  onPick: (pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  /** Picked without placing anything — what the focus landing on it means. */
  onSelect: (pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  onPatch: (pos: Omit<LadderPos, 'group'> & { group: number }, patch: ElementPatch) => void;
  onPin: (pos: Omit<LadderPos, 'group'> & { group: number }, pin: string, value: string) => void;
  onMenu: (e: React.MouseEvent, pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  /** Picking things up and putting them down. */
  dnd: Dnd;
  /** What a slot says when the pointer rests on it. */
  hint: string;
  t: Strings;
}> = ({
  group, layout, rung, atRail, readOnly, cursor, onElement, isKnown,
  onSlot, onPick, onSelect, onPatch, onPin, onMenu, dnd, hint, t,
}) => {
  const parallel = group.branches.length > 1;
  const topWire = rung.rowWire[0];
  const lastWire = rung.rowWire[group.branches.length - 1] ?? topWire;

  return (
    <div className="relative shrink-0" style={{ width: layout.width, height: rung.height }}>
      {/* The two bars that make it a parallel group.
          The left one is left out where the group hangs off the rail: the
          rail is already a vertical line down the whole rung, and drawing a
          second one on top of it gave the first column a stripe twice as
          thick as every other junction. */}
      {parallel && !atRail && (
        <span
          className="absolute"
          style={{ left: 0, top: topWire, height: lastWire - topWire, width: 2, background: WIRE }}
        />
      )}
      {parallel && (
        <span
          className="absolute"
          style={{ right: 0, top: topWire, height: lastWire - topWire, width: 2, background: WIRE }}
        />
      )}

      {group.branches.map((branch, bi) => {
        const bl = layout.branches[bi];
        const wire = rung.rowWire[bi];
        return (
          <div
            key={bi}
            className="absolute flex items-start"
            style={{ top: rung.rowTop[bi], left: 0, width: layout.width, height: rung.rowHeight[bi] }}
          >
            {/* The wire along this branch, behind everything on it. It runs
                the full width of the group so a short branch still reaches
                the bar that closes it. */}
            <span
              className="absolute"
              style={{ left: 0, right: 0, top: wire - rung.rowTop[bi] - 1, height: 2, background: WIRE }}
            />

            <SlotInline
              active={!!cursor && !onElement && cursor.branch === bi && cursor.slot === 0}
              readOnly={readOnly} wireY={wire - rung.rowTop[bi]} hint={hint}
              onClick={() => onSlot({ group: 0, branch: bi, slot: 0 })}
              dragging={dnd.active}
              dropping={dnd.over === dnd.keyOf({ group: 0, branch: bi, slot: 0 })}
              onDragOver={e => dnd.hover(e, dnd.keyOf({ group: 0, branch: bi, slot: 0 }))}
              onDrop={e => dnd.drop(e, { group: 0, branch: bi, slot: 0 })}
            />

            {branch.elements.map((el, ei) => {
              const geo = bl.elements[ei];
              return (
                <React.Fragment key={ei}>
                  <div
                    className={`relative z-10 ${readOnly ? '' : 'cursor-grab'}
                      ${cursor && onElement && cursor.branch === bi && cursor.slot === ei
                      ? 'ring-2 ring-blue-400 rounded' : ''}`}
                    style={{ width: geo.width, marginTop: wire - rung.rowTop[bi] - geo.wireY }}
                    draggable={!readOnly}
                    onDragStart={e => dnd.begin(e, { group: 0, branch: bi, slot: ei })}
                    onDragEnd={dnd.end}
                    // Dropped on an element, it goes in *before* it — which is
                    // what that slot number already means everywhere else here,
                    // and what makes dropping on the left half of a rung read
                    // the way it does in every list anybody has dragged a row
                    // around in.
                    onDragOver={e => dnd.hover(e, dnd.keyOf({ group: 0, branch: bi, slot: ei }))}
                    onDrop={e => dnd.drop(e, { group: 0, branch: bi, slot: ei })}
                    onClick={() => onPick({ group: 0, branch: bi, slot: ei })}
                    // The operand swallows its own clicks — otherwise clicking
                    // into an address to correct it would place whatever the
                    // catalogue has armed on top of it. So it is the *focus*
                    // arriving that picks the element, which is also what
                    // tabbing along a rung should do.
                    onFocus={() => onSelect({ group: 0, branch: bi, slot: ei })}
                    onContextMenu={e => onMenu(e, { group: 0, branch: bi, slot: ei })}
                  >
                    <ElementView
                      element={el}
                      readOnly={readOnly}
                      isKnown={isKnown}
                      t={t}
                      onPatch={patch => onPatch({ group: 0, branch: bi, slot: ei }, patch)}
                      onPin={(pin, value) => onPin({ group: 0, branch: bi, slot: ei }, pin, value)}
                    />
                  </div>
                  <SlotInline
                    active={!!cursor && !onElement && cursor.branch === bi && cursor.slot === ei + 1}
                    readOnly={readOnly} wireY={wire - rung.rowTop[bi]} hint={hint}
                    onClick={() => onSlot({ group: 0, branch: bi, slot: ei + 1 })}
                    dragging={dnd.active}
                    dropping={dnd.over === dnd.keyOf({ group: 0, branch: bi, slot: ei + 1 })}
                    onDragOver={e => dnd.hover(e, dnd.keyOf({ group: 0, branch: bi, slot: ei + 1 }))}
                    onDrop={e => dnd.drop(e, { group: 0, branch: bi, slot: ei + 1 })}
                  />
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/**
 * A place something can be dropped, between two elements on a branch.
 *
 * It is a hairline on the wire, which is plenty to click at and nothing to
 * aim a drag at — so while a drag is in flight it grows to the height of a
 * contact, centred on the same wire. The gap between two elements becomes
 * something a hand can actually hit, and goes back to a hairline the moment
 * the drag ends.
 */
const SlotInline: React.FC<{
  active: boolean; readOnly?: boolean; wireY: number;
  hint: string; onClick: () => void;
  dragging?: boolean; dropping?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}> = ({ active, readOnly, wireY, hint, onClick, dragging, dropping, onDragOver, onDrop }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={e => { e.stopPropagation(); onClick(); }}
    onDragOver={onDragOver}
    onDrop={onDrop}
    className={`relative z-10 shrink-0 group/slot ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
    style={dragging
      ? { width: GAP, height: GLYPH_H, marginTop: wireY - GLYPH_H / 2 }
      : { width: GAP, height: 1, marginTop: wireY }}
    title={hint}
  >
    <span
      className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all
        ${dropping ? 'w-3.5 h-3.5 bg-blue-600 ring-2 ring-blue-300'
        : active ? 'w-3 h-3 bg-blue-500 ring-2 ring-blue-200'
        : dragging ? 'w-2 h-2 bg-blue-200'
        : 'w-1.5 h-1.5 bg-transparent group-hover/slot:bg-blue-400'}`}
      style={dragging ? { top: GLYPH_H / 2 } : undefined}
    />
  </button>
);

/** The slot at the end of the rung, where a new column goes. */
const Slot: React.FC<{
  active: boolean; readOnly?: boolean; wireY: number; height: number;
  hint: string; onClick: () => void;
  // The end slot is already 28 pixels of rung wide, so unlike the inline ones
  // it needs nothing extra to be droppable.
  dropping?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}> = ({ active, readOnly, wireY, height, hint, onClick, dropping, onDragOver, onDrop }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={onClick}
    onDragOver={onDragOver}
    onDrop={onDrop}
    className="relative shrink-0 group/end"
    style={{ width: 28, height }}
    title={hint}
  >
    <span className="absolute" style={{ left: 0, right: 0, top: wireY - 1, height: 2, background: WIRE }} />
    <span
      className={`absolute left-1/2 -translate-x-1/2 rounded-full transition-all
        ${dropping ? 'w-3.5 h-3.5 bg-blue-600 ring-2 ring-blue-300'
        : active ? 'w-3 h-3 bg-blue-500 ring-2 ring-blue-200'
        : 'w-1.5 h-1.5 bg-transparent group-hover/end:bg-blue-400'}`}
      style={{ top: wireY - 6 }}
    />
  </button>
);

// ── One element ─────────────────────────────────────────────────────────────

const ElementView: React.FC<{
  element: Element;
  readOnly?: boolean;
  isKnown: (v: string) => boolean;
  t: Strings;
  onPatch: (patch: ElementPatch) => void;
  onPin: (pin: string, value: string) => void;
}> = ({ element, readOnly, isKnown, t, onPatch, onPin }) => {
  if (element.k !== 'block') {
    const instr = element.k === 'no' ? t.contactNo
      : element.k === 'nc' ? t.contactNc
        : element.k === 'p' ? t.coilKindP
          : t.coilKindN;
    return (
      <div className="flex flex-col items-center bg-white" style={{ width: CELL_W }}>
        <Operand
          value={element.at}
          readOnly={readOnly}
          known={isKnown(element.at)}
          title={`${instr}${element.label ? ` — ${element.label}` : ''}`}
          onChange={v => onPatch({ at: v })}
        />
        <ContactGlyph kind={element.k} />
      </div>
    );
  }
  return <BoxView block={element} readOnly={readOnly} t={t} onPatch={onPatch} onPin={onPin} />;
};

const BoxView: React.FC<{
  block: Block;
  readOnly?: boolean;
  t: Strings;
  onPatch: (patch: ElementPatch) => void;
  onPin: (pin: string, value: string) => void;
}> = ({ block, readOnly, t, onPatch, onPin }) => {
  const { ins, outs } = boxPins(block);
  const rows = Math.max(1, ins.length, outs.length);
  const instr = instructionByName(block.type);
  const named = block.name !== undefined;

  return (
    <div style={{ width: 168 }} className="bg-white">
      {named && (
        <div className="flex items-center w-full px-0.5" style={{ height: BOX_NAME_H }}>
        <input
          className="w-full text-center text-[10.5px] font-mono px-1 rounded bg-transparent
            border border-transparent hover:border-gray-300 focus:border-blue-400
            focus:bg-white focus:outline-none"
          value={block.name ?? ''}
          readOnly={readOnly}
          placeholder={t.instancePlaceholder}
          title={t.instanceTip}
          onChange={e => onPatch({ name: e.target.value })}
          onClick={e => e.stopPropagation()}
        />
        </div>
      )}
      <div
        className="border-2 rounded-sm"
        style={{
          borderColor: WIRE,
          height: BOX_BORDER * 2 + BOX_HEAD + rows * PIN_H,
        }}
      >
        {/* The instruction's name, and it is typed rather than chosen.
            That is what the empty box is for: drop one where the instruction
            belongs and name it afterwards, which is how a network gets built
            when the shape is clear before the exact block is. Typing a name
            the catalogue knows brings its pins with it — in the vendor's own
            order, which is the part nobody should have to remember. */}
        <div
          className="bg-slate-100 border-b"
          style={{ height: BOX_HEAD, borderColor: WIRE }}
        >
          <input
            className="w-full h-full text-center font-semibold text-[11px] bg-transparent
              border border-transparent hover:border-gray-400 focus:border-blue-400
              focus:bg-white focus:outline-none"
            value={block.type}
            readOnly={readOnly}
            spellCheck={false}
            dir="ltr"
            title={instr
              ? `${titleOf(instr, t.lang === 'fa')} — ${helpOf(instr, t.lang === 'fa')}`
              : t.boxTypeTip}
            onChange={e => {
              const typed = e.target.value.toUpperCase();
              const found = instructionByName(typed);
              if (!found) { onPatch({ type: typed }); return; }
              // A known instruction arrives with its pins. What was already
              // wired to a pin of the same name is kept: retyping MOVE as
              // MOVE_BLK should not empty the operand that is still right.
              const kept = new Map(block.pins.map(pin => [pin.name, pin.value]));
              onPatch({
                type: found.name,
                name: found.instance ? (block.name ?? '') : undefined,
                pins: (found.pins ?? []).map(pin => ({
                  name: pin.name, value: kept.get(pin.name) ?? '', out: pin.out,
                })),
              });
            }}
            onClick={e => e.stopPropagation()}
          />
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-stretch" style={{ height: PIN_H }}>
            <div className="flex-1 flex items-center gap-1 px-1 min-w-0">
              {ins[r] && (
                <>
                  <span className="text-[9.5px] text-gray-500 shrink-0">{ins[r].name}</span>
                  <input
                    className="flex-1 min-w-0 text-[10px] font-mono px-0.5 rounded bg-transparent
                      border border-transparent hover:border-gray-300 focus:border-blue-400
                      focus:bg-white focus:outline-none"
                    value={ins[r].value ?? ''}
                    readOnly={readOnly}
                    dir="ltr"
                    placeholder="—"
                    onChange={e => onPin(ins[r].name, e.target.value)}
                    onClick={e => e.stopPropagation()}
                  />
                </>
              )}
            </div>
            <div className="flex items-center gap-1 px-1 justify-end" style={{ width: 66 }}>
              {outs[r] && (
                <>
                  <input
                    className="flex-1 min-w-0 text-[10px] font-mono px-0.5 text-right rounded bg-transparent
                      border border-transparent hover:border-gray-300 focus:border-blue-400
                      focus:bg-white focus:outline-none"
                    value={outs[r].value ?? ''}
                    readOnly={readOnly}
                    dir="ltr"
                    placeholder="—"
                    onChange={e => onPin(outs[r].name, e.target.value)}
                    onClick={e => e.stopPropagation()}
                  />
                  <span className="text-[9.5px] text-gray-500 shrink-0">{outs[r].name}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const Item: React.FC<{
  icon: React.ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void;
}> = ({ icon, label, hint, danger, onClick }) => (
  <button
    className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-gray-100
      ${danger ? 'text-red-600' : ''}`}
    onClick={onClick}
  >
    <span className="flex items-center gap-2">{icon} {label}</span>
    {hint && <span className="block ps-6 text-[10px] text-gray-400">{hint}</span>}
  </button>
);

// ── The toolbar buttons ─────────────────────────────────────────────────────
//
// Drawn rather than lettered, and drawn as the thing they put on the rung. A
// toolbar of words in a graphical editor is a toolbar nobody reads twice; a
// row of the actual symbols is recognised at a glance and in any language,
// which is also why it keeps its order when the page turns for Persian.

type ToolGlyph =
  | 'normally-open' | 'normally-closed' | 'coil' | 'box'
  | 'open-branch' | 'close-branch' | 'delete';

const ToolArt: React.FC<{ glyph: ToolGlyph }> = ({ glyph }) => {
  const S = { stroke: WIRE, strokeWidth: 1.8, fill: 'none' } as const;
  switch (glyph) {
    case 'normally-open':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={9} x2={8} y2={9} {...S} />
          <line x1={8} y1={3} x2={8} y2={15} {...S} />
          <line x1={18} y1={3} x2={18} y2={15} {...S} />
          <line x1={18} y1={9} x2={26} y2={9} {...S} />
        </svg>
      );
    case 'normally-closed':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={9} x2={8} y2={9} {...S} />
          <line x1={8} y1={3} x2={8} y2={15} {...S} />
          <line x1={18} y1={3} x2={18} y2={15} {...S} />
          <line x1={18} y1={9} x2={26} y2={9} {...S} />
          <line x1={6} y1={15} x2={20} y2={3} {...S} />
        </svg>
      );
    case 'coil':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={9} x2={7} y2={9} {...S} />
          <path d="M 7 3 A 7 7 0 0 0 7 15" {...S} />
          <path d="M 19 3 A 7 7 0 0 1 19 15" {...S} />
          <line x1={19} y1={9} x2={26} y2={9} {...S} />
        </svg>
      );
    case 'box':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={9} x2={4} y2={9} {...S} />
          <rect x={4} y={2} width={18} height={14} rx={1} {...S} />
          <text x={13} y={13} textAnchor="middle" fontSize={9} fontWeight={700} fill={WIRE}>?</text>
        </svg>
      );
    // A branch opening: the rail carries on and a second path drops away.
    case 'open-branch':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={4} x2={26} y2={4} {...S} />
          <line x1={7} y1={4} x2={7} y2={15} {...S} />
          <line x1={7} y1={15} x2={26} y2={15} {...S} />
        </svg>
      );
    // A branch closing: the second path comes back up to the rail.
    case 'close-branch':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={4} x2={26} y2={4} {...S} />
          <line x1={0} y1={15} x2={19} y2={15} {...S} />
          <line x1={19} y1={15} x2={19} y2={4} {...S} />
        </svg>
      );
    case 'delete':
      return (
        <svg width={26} height={18} className="block">
          <line x1={0} y1={9} x2={7} y2={9} {...S} />
          <line x1={19} y1={9} x2={26} y2={9} {...S} />
          <line x1={9} y1={4} x2={17} y2={14} stroke="#dc2626" strokeWidth={1.8} />
          <line x1={17} y1={4} x2={9} y2={14} stroke="#dc2626" strokeWidth={1.8} />
        </svg>
      );
  }
};

const RungTool: React.FC<{
  glyph: ToolGlyph; title: string; disabled?: boolean; onClick: () => void;
}> = ({ glyph, title, disabled, onClick }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className="px-1.5 py-1 rounded border border-transparent hover:border-gray-300
      hover:bg-white disabled:opacity-30 disabled:hover:border-transparent
      disabled:hover:bg-transparent"
  >
    <ToolArt glyph={glyph} />
  </button>
);
