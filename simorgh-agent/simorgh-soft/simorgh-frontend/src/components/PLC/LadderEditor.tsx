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

import React, { useMemo, useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon, GitBranchIcon,
  EyeOffIcon, EyeIcon, CopyIcon, ArrowUpIcon, ArrowDownIcon, ZapIcon,
} from 'lucide-react';
import { MenuBox } from '../shared/MenuBox';
import { Strings } from './lang';
import { Block, Coil, Contact, Element, Rung } from '../../utils/ladder/model';
import { PlcBlock, PlcNetwork, PlcProject, allTags, newNetwork } from '../../utils/plc/model';
import {
  Instruction, helpOf, instructionById, instructionByName, titleOf,
} from '../../utils/plc/instructions';
import {
  ElementPatch, LadderCursor, LadderPos, addOutput, addParallelBranch, patchElement,
  patchOutput, patchPin, placeInstruction, removeBranch, removeElement, removeOutput, samePos,
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

  return {
    groups,
    rowTop,
    rowWire,
    rowHeight,
    height: Math.max(CONTACT_H, y - BRANCH_GAP),
    wireY: rowWire[0],
  };
}

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
  const place = (netId: string, pos: LadderPos, instr: Instruction) => {
    if (readOnly) return;
    const placed = placeInstruction(networks, { netId, pos }, instr);
    if (!placed) return;
    onChange(placed.networks);
    setCursor(placed.cursor);
    onInserted?.();
  };

  const clickSlot = (netId: string, pos: LadderPos) => {
    setCursor({ netId, pos });
    if (armed) place(netId, pos, armed);
  };

  /** A toolbar button's instruction, put in at the cursor straight away. */
  const insertNow = (id: string) => {
    const instr = instructionById(id);
    if (!instr || readOnly) return;
    const placed = placeInstruction(networks, cursor ?? null, instr);
    if (!placed) return;
    onChange(placed.networks);
    setCursor(placed.cursor);
  };

  /** What the cursor is on, taken off the rung. */
  const deleteAtCursor = () => {
    if (!cursor || readOnly) return;
    const net = networks.find(n => n.id === cursor.netId);
    if (!net) return;
    patchRung(cursor.netId, removeElement(net.rung, cursor.pos));
  };

  const onCursorElement = (() => {
    if (!cursor) return false;
    const net = networks.find(n => n.id === cursor.netId);
    const branch = net?.rung.groups[cursor.pos.group]?.branches[cursor.pos.branch];
    return !!branch?.elements[cursor.pos.slot];
  })();

  return (
    <div
      dir="ltr"
      className="h-full overflow-auto bg-white"
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
            onClick={deleteAtCursor}
            title={t.deleteElement}
            glyph="delete"
            disabled={!onCursorElement}
          />
          <span className="ms-2 text-[11px] text-gray-500 truncate">
            {cursor
              ? `${t.network} ${networks.find(n => n.id === cursor.netId)?.rung.number ?? ''}`
              : t.clickThenPick}
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
                        isKnown={isKnown}
                        onSlot={pos => clickSlot(net.id, { ...pos, group: gi })}
                        onPatch={(pos, patch) =>
                          patchRung(net.id, patchElement(net.rung, { ...pos, group: gi }, patch))}
                        onPin={(pos, pin, value) =>
                          patchRung(net.id, patchPin(net.rung, { ...pos, group: gi }, pin, value))}
                        onMenu={(e, pos) => {
                          e.preventDefault(); e.stopPropagation();
                          setMenu({ x: e.clientX, y: e.clientY, netId: net.id, pos: { ...pos, group: gi } });
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

                    <div className="flex flex-col" style={{ gap: BRANCH_GAP }}>
                      {net.rung.outputs.map((out, oi) => (
                        <div
                          key={oi}
                          className="flex flex-col items-center"
                          style={{ width: CELL_W, marginTop: oi === 0 ? layout.wireY - CONTACT_WIRE : 0 }}
                          onContextMenu={e => {
                            if (readOnly) return;
                            e.preventDefault(); e.stopPropagation();
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
                      {!readOnly && (
                        <button
                          className="text-[10px] text-blue-600 hover:underline px-1"
                          style={{ marginTop: net.rung.outputs.length === 0 ? layout.wireY - 8 : 0 }}
                          title={t.addCoil}
                          onClick={() => patchRung(net.id, addOutput(net.rung, { k: 'coil', at: '' }))}
                        >
                          {t.addCoil}
                        </button>
                      )}
                    </div>

                    {/* The right rail. */}
                    <div
                      className="shrink-0 ms-2"
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
                  hint={t.openBranchNote}
                  onClick={() => {
                    patchRung(menu.netId, addParallelBranch(net.rung, pos.group));
                    // The cursor goes into the new branch. The next thing
                    // picked belongs there and nowhere else, and leaving the
                    // cursor where it was put it back in series with what the
                    // branch was opened beside.
                    const branches = net.rung.groups[pos.group]?.branches.length ?? 1;
                    setCursor({ netId: menu.netId, pos: { group: pos.group, branch: branches, slot: 0 } });
                    setMenu(null);
                  }}
                />
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
  isKnown: (v: string) => boolean;
  onSlot: (pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  onPatch: (pos: Omit<LadderPos, 'group'> & { group: number }, patch: ElementPatch) => void;
  onPin: (pos: Omit<LadderPos, 'group'> & { group: number }, pin: string, value: string) => void;
  onMenu: (e: React.MouseEvent, pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  /** What a slot says when the pointer rests on it. */
  hint: string;
  t: Strings;
}> = ({
  group, layout, rung, atRail, readOnly, cursor, isKnown,
  onSlot, onPatch, onPin, onMenu, hint, t,
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
              active={!!cursor && cursor.branch === bi && cursor.slot === 0}
              readOnly={readOnly} wireY={wire - rung.rowTop[bi]} hint={hint}
              onClick={() => onSlot({ group: 0, branch: bi, slot: 0 })}
            />

            {branch.elements.map((el, ei) => {
              const geo = bl.elements[ei];
              return (
                <React.Fragment key={ei}>
                  <div
                    className={`relative z-10 ${cursor && cursor.branch === bi && cursor.slot === ei
                      ? 'ring-2 ring-blue-400 rounded' : ''}`}
                    style={{ width: geo.width, marginTop: wire - rung.rowTop[bi] - geo.wireY }}
                    onClick={() => onSlot({ group: 0, branch: bi, slot: ei })}
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
                    active={!!cursor && cursor.branch === bi && cursor.slot === ei + 1}
                    readOnly={readOnly} wireY={wire - rung.rowTop[bi]} hint={hint}
                    onClick={() => onSlot({ group: 0, branch: bi, slot: ei + 1 })}
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

/** A place something can be dropped, between two elements on a branch. */
const SlotInline: React.FC<{
  active: boolean; readOnly?: boolean; wireY: number;
  hint: string; onClick: () => void;
}> = ({ active, readOnly, wireY, hint, onClick }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={e => { e.stopPropagation(); onClick(); }}
    className={`relative z-10 shrink-0 group/slot ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
    style={{ width: GAP, height: 1, marginTop: wireY }}
    title={hint}
  >
    <span
      className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all
        ${active ? 'w-3 h-3 bg-blue-500 ring-2 ring-blue-200'
        : 'w-1.5 h-1.5 bg-transparent group-hover/slot:bg-blue-400'}`}
    />
  </button>
);

/** The slot at the end of the rung, where a new column goes. */
const Slot: React.FC<{
  active: boolean; readOnly?: boolean; wireY: number; height: number;
  hint: string; onClick: () => void;
}> = ({ active, readOnly, wireY, height, hint, onClick }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={onClick}
    className="relative shrink-0 group/end"
    style={{ width: 28, height }}
    title={hint}
  >
    <span className="absolute" style={{ left: 0, right: 0, top: wireY - 1, height: 2, background: WIRE }} />
    <span
      className={`absolute left-1/2 -translate-x-1/2 rounded-full transition-all
        ${active ? 'w-3 h-3 bg-blue-500 ring-2 ring-blue-200' : 'w-1.5 h-1.5 bg-transparent group-hover/end:bg-blue-400'}`}
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
