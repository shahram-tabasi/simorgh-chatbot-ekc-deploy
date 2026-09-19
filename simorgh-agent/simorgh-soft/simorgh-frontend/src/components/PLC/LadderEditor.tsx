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
import { Block, Coil, Contact, Element, Rung } from '../../utils/ladder/model';
import { PlcBlock, PlcNetwork, PlcProject, allTags, newNetwork } from '../../utils/plc/model';
import { Instruction, instructionByName } from '../../utils/plc/instructions';
import {
  ElementPatch, LadderCursor, LadderPos, addOutput, addParallelBranch, patchElement,
  patchOutput, patchPin, placeInstruction, removeBranch, removeElement, removeOutput, samePos,
} from '../../utils/plc/ladderEdit';

// ── Layout numbers ──────────────────────────────────────────────────────────
// All of them in pixels, all of them here. A magic number in the middle of a
// render is a number nobody can change safely.

const CELL_W = 88;        // a contact or a coil
const GLYPH_H = 26;       // the drawn part of a contact
const LABEL_H = 26;       // the operand box above it
const CONTACT_H = LABEL_H + GLYPH_H;
const CONTACT_WIRE = LABEL_H + GLYPH_H / 2;
const BOX_HEAD = 22;      // the instruction's name bar
const PIN_H = 20;         // one pin row
const BOX_NAME_H = 20;    // the instance name above the box
const GAP = 18;           // the wire between two elements
const BRANCH_GAP = 10;    // between two parallel branches
const RAIL_PAD = 14;

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
    height: top + BOX_HEAD + rows * PIN_H + 6,
    // The wire goes into the first input, which is where it goes on a real
    // box: the rung enables the instruction, it does not pass through it.
    wireY: top + BOX_HEAD + PIN_H / 2,
  };
}

interface BranchLayout { height: number; wireY: number; elements: Geometry[]; width: number; }
interface GroupLayout { width: number; height: number; branches: BranchLayout[]; tops: number[]; }

function layoutRung(rung: Rung): { groups: GroupLayout[]; height: number; wireY: number } {
  const groups: GroupLayout[] = rung.groups.map(group => {
    const branches: BranchLayout[] = group.branches.map(branch => {
      const elements = branch.elements.map(elementGeometry);
      const wireY = Math.max(CONTACT_WIRE, ...elements.map(g => g.wireY));
      const height = Math.max(
        CONTACT_H,
        ...elements.map(g => g.height + (wireY - g.wireY)),
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
      return { height, wireY, elements, width };
    });
    const width = Math.max(CELL_W, ...branches.map(b => b.width));
    // Where each branch starts down the group, so the parallel bars can be
    // drawn between the first wire and the last without measuring anything.
    const tops: number[] = [];
    let y = 0;
    for (const b of branches) { tops.push(y); y += b.height + BRANCH_GAP; }
    const height = Math.max(0, y - BRANCH_GAP);
    return { width, height, branches, tops };
  });

  const height = Math.max(CONTACT_H, ...groups.map(g => g.height));
  const wireY = Math.max(CONTACT_WIRE, ...groups.map(g => g.branches[0]?.wireY ?? CONTACT_WIRE));
  return { groups, height, wireY };
}

// ── The drawn parts ─────────────────────────────────────────────────────────

const WIRE = 'rgb(51 65 85)';       // slate-700 — the rail and the wires

const ContactGlyph: React.FC<{ kind: Contact['k']; on?: boolean }> = ({ kind, on }) => (
  <svg width={CELL_W} height={GLYPH_H} className="block">
    <line x1={0} y1={GLYPH_H / 2} x2={CELL_W / 2 - 9} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={1.5} />
    <line x1={CELL_W / 2 + 9} y1={GLYPH_H / 2} x2={CELL_W} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={1.5} />
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
        stroke={WIRE} strokeWidth={1.5}
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
      <line x1={0} y1={GLYPH_H / 2} x2={cx - r} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={1.5} />
      <path
        d={`M ${cx - r} ${GLYPH_H / 2 - 9} A ${r} ${r} 0 0 0 ${cx - r} ${GLYPH_H / 2 + 9}`}
        fill="none" stroke={WIRE} strokeWidth={2}
      />
      <path
        d={`M ${cx + r} ${GLYPH_H / 2 - 9} A ${r} ${r} 0 0 1 ${cx + r} ${GLYPH_H / 2 + 9}`}
        fill="none" stroke={WIRE} strokeWidth={2}
      />
      <line x1={cx + r} y1={GLYPH_H / 2} x2={CELL_W} y2={GLYPH_H / 2} stroke={WIRE} strokeWidth={1.5} />
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
  <input
    className={`w-full text-center text-[10.5px] leading-tight px-0.5 py-0.5 rounded font-mono
      bg-transparent border border-transparent hover:border-gray-300
      focus:border-blue-400 focus:bg-white focus:outline-none
      ${known === false && value ? 'text-amber-700 underline decoration-dotted decoration-amber-500' : ''}`}
    style={{ height: LABEL_H - 6, marginTop: 3 }}
    value={value}
    readOnly={readOnly}
    placeholder={placeholder ?? '<??.?>'}
    title={title}
    spellCheck={false}
    onChange={e => onChange(e.target.value)}
    onClick={e => e.stopPropagation()}
  />
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
}

export const LadderEditor: React.FC<Props> = ({
  project, block, readOnly, onChange, armed, onInserted, cursor, onCursor,
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
    if (filled && !window.confirm(`Delete network ${net.rung.number}? Ctrl+Z will not bring it back.`)) {
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

  return (
    <div className="h-full overflow-auto bg-white" onClick={() => menu && setMenu(null)}>
      {networks.length === 0 && (
        <div className="p-8 text-center text-[12px] text-gray-500">
          <p>This block has no networks yet.</p>
          {!readOnly && (
            <button
              onClick={() => addNetwork()}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 text-white text-[12px]"
            >
              <PlusIcon className="w-4 h-4" /> Add the first network
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
                Network {net.rung.number}:
              </span>
              <input
                className="flex-1 min-w-0 bg-transparent text-[12px] px-1.5 py-0.5 rounded
                  border border-transparent hover:border-gray-300 focus:border-blue-400
                  focus:bg-white focus:outline-none"
                value={net.title}
                readOnly={readOnly}
                placeholder="what this network is for"
                onChange={e => patchNetwork(net.id, { title: e.target.value })}
              />
              {!readOnly && (
                <>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title={net.disabled
                      ? 'Put this network back into the program'
                      : 'Leave it in the block but do not execute it'}
                    onClick={() => patchNetwork(net.id, { disabled: !net.disabled })}
                  >
                    {net.disabled
                      ? <EyeOffIcon className="w-3.5 h-3.5" />
                      : <EyeIcon className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title="Another network after this one"
                    onClick={() => addNetwork(net.id)}
                  >
                    <PlusIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="p-1 rounded hover:bg-slate-200"
                    title="More"
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
                  placeholder="Comment — why it is built this way"
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
                        wireY={layout.wireY}
                        readOnly={readOnly}
                        armed={!!armed}
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
                      armed={!!armed}
                      readOnly={readOnly}
                      wireY={layout.wireY}
                      height={layout.height}
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
                          title="Another coil, stacked at the right-hand end"
                          onClick={() => patchRung(net.id, addOutput(net.rung, { k: 'coil', at: '' }))}
                        >
                          + coil
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
            <PlusIcon className="w-4 h-4" /> Add network
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
                  label="Open a parallel branch here"
                  hint="Everything in this column becomes an OR"
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
                  label="Delete this element"
                  onClick={() => { patchRung(menu.netId, removeElement(net.rung, pos)); setMenu(null); }}
                />
                <Item
                  icon={<TrashIcon className="w-3.5 h-3.5" />}
                  label="Delete this branch"
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
              coil: 'Assignment  -( )-',
              set: 'Set  -(S)-',
              reset: 'Reset  -(R)-',
              'pulse-p': 'Positive edge  -(P)-',
              'pulse-n': 'Negative edge  -(N)-',
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
                  label="Delete this coil"
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
                label="Insert network after"
                onClick={() => { addNetwork(menu.netId); setMenu(null); }}
              />
              <Item
                icon={<CopyIcon className="w-3.5 h-3.5" />}
                label="Duplicate network"
                onClick={() => { duplicateNetwork(menu.netId); setMenu(null); }}
              />
              <Item
                icon={<ArrowUpIcon className="w-3.5 h-3.5" />}
                label="Move up"
                onClick={() => { moveNetwork(menu.netId, -1); setMenu(null); }}
              />
              <Item
                icon={<ArrowDownIcon className="w-3.5 h-3.5" />}
                label="Move down"
                onClick={() => { moveNetwork(menu.netId, 1); setMenu(null); }}
              />
              <div className="border-t border-gray-100 my-1" />
              <Item
                icon={<TrashIcon className="w-3.5 h-3.5" />}
                label="Delete network"
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
  wireY: number;
  readOnly?: boolean;
  armed: boolean;
  cursor: LadderPos | null;
  isKnown: (v: string) => boolean;
  onSlot: (pos: Omit<LadderPos, 'group'> & { group: number }) => void;
  onPatch: (pos: Omit<LadderPos, 'group'> & { group: number }, patch: ElementPatch) => void;
  onPin: (pos: Omit<LadderPos, 'group'> & { group: number }, pin: string, value: string) => void;
  onMenu: (e: React.MouseEvent, pos: Omit<LadderPos, 'group'> & { group: number }) => void;
}> = ({ group, layout, wireY, readOnly, armed, cursor, isKnown, onSlot, onPatch, onPin, onMenu }) => {
  const parallel = group.branches.length > 1;
  const firstWire = layout.branches[0]?.wireY ?? 0;
  const lastTop = layout.tops[layout.tops.length - 1] ?? 0;
  const lastWire = lastTop + (layout.branches[layout.branches.length - 1]?.wireY ?? 0);

  return (
    <div
      className="relative shrink-0"
      // The height has to be stated. Every branch inside is positioned
      // absolutely — that is what lets the parallel bars be drawn between two
      // known wires without measuring anything — and a box whose children are
      // all absolute is a box of no height at all. Leaving it out let the
      // group collapse to nothing and the next thing along the rail, the slot
      // a new column goes in, sat underneath the contact that had just been
      // placed and could not be clicked.
      style={{ width: layout.width, height: layout.height, marginTop: wireY - firstWire }}
    >
      {/* The two bars that make it a parallel group. */}
      {parallel && (
        <>
          <span
            className="absolute"
            style={{ left: 0, top: firstWire, height: lastWire - firstWire, width: 2, background: WIRE }}
          />
          <span
            className="absolute"
            style={{ right: 0, top: firstWire, height: lastWire - firstWire, width: 2, background: WIRE }}
          />
        </>
      )}

      {group.branches.map((branch, bi) => {
        const bl = layout.branches[bi];
        return (
          <div
            key={bi}
            className="absolute flex items-start"
            style={{ top: layout.tops[bi], left: 0, width: layout.width, height: bl.height }}
          >
            {/* The wire along this branch, behind everything on it. */}
            <span
              className="absolute"
              style={{ left: 0, right: 0, top: bl.wireY - 1, height: 2, background: WIRE }}
            />

            <SlotInline
              active={!!cursor && cursor.branch === bi && cursor.slot === 0}
              armed={armed} readOnly={readOnly} wireY={bl.wireY}
              onClick={() => onSlot({ group: 0, branch: bi, slot: 0 })}
            />

            {branch.elements.map((el, ei) => {
              const geo = bl.elements[ei];
              return (
                <React.Fragment key={ei}>
                  <div
                    className={`relative z-10 ${cursor && cursor.branch === bi && cursor.slot === ei
                      ? 'ring-2 ring-blue-400 rounded' : ''}`}
                    style={{ width: geo.width, marginTop: bl.wireY - geo.wireY }}
                    onClick={() => onSlot({ group: 0, branch: bi, slot: ei })}
                    onContextMenu={e => onMenu(e, { group: 0, branch: bi, slot: ei })}
                  >
                    <ElementView
                      element={el}
                      readOnly={readOnly}
                      isKnown={isKnown}
                      onPatch={patch => onPatch({ group: 0, branch: bi, slot: ei }, patch)}
                      onPin={(pin, value) => onPin({ group: 0, branch: bi, slot: ei }, pin, value)}
                    />
                  </div>
                  <SlotInline
                    active={!!cursor && cursor.branch === bi && cursor.slot === ei + 1}
                    armed={armed} readOnly={readOnly} wireY={bl.wireY}
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
  active: boolean; armed: boolean; readOnly?: boolean; wireY: number; onClick: () => void;
}> = ({ active, armed, readOnly, wireY, onClick }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={e => { e.stopPropagation(); onClick(); }}
    className={`relative z-10 shrink-0 group/slot ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
    style={{ width: GAP, height: 1, marginTop: wireY }}
    title={armed ? 'Put the chosen instruction here' : 'Click, then pick an instruction'}
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
  active: boolean; armed: boolean; readOnly?: boolean; wireY: number; height: number; onClick: () => void;
}> = ({ active, armed, readOnly, wireY, height, onClick }) => (
  <button
    type="button"
    disabled={readOnly}
    onClick={onClick}
    className="relative shrink-0 group/end"
    style={{ width: 28, height }}
    title={armed ? 'Put the chosen instruction here' : 'Click, then pick an instruction from the right'}
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
  onPatch: (patch: ElementPatch) => void;
  onPin: (pin: string, value: string) => void;
}> = ({ element, readOnly, isKnown, onPatch, onPin }) => {
  if (element.k !== 'block') {
    const instr = element.k === 'no' ? 'Normally open contact'
      : element.k === 'nc' ? 'Normally closed contact'
        : element.k === 'p' ? 'Rising edge of the operand'
          : 'Falling edge of the operand';
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
  return <BoxView block={element} readOnly={readOnly} isKnown={isKnown} onPatch={onPatch} onPin={onPin} />;
};

const BoxView: React.FC<{
  block: Block;
  readOnly?: boolean;
  isKnown: (v: string) => boolean;
  onPatch: (patch: ElementPatch) => void;
  onPin: (pin: string, value: string) => void;
}> = ({ block, readOnly, onPatch, onPin }) => {
  const { ins, outs } = boxPins(block);
  const rows = Math.max(1, ins.length, outs.length);
  const instr = instructionByName(block.type);
  const named = block.name !== undefined;

  return (
    <div style={{ width: 168 }} className="bg-white">
      {named && (
        <input
          className="w-full text-center text-[10.5px] font-mono px-1 rounded bg-transparent
            border border-transparent hover:border-gray-300 focus:border-blue-400
            focus:bg-white focus:outline-none"
          style={{ height: BOX_NAME_H - 2 }}
          value={block.name ?? ''}
          readOnly={readOnly}
          placeholder="<instance>"
          title="Where this instruction keeps its state. Two calls sharing one instance interfere."
          onChange={e => onPatch({ name: e.target.value })}
          onClick={e => e.stopPropagation()}
        />
      )}
      <div className="border-2 rounded-sm" style={{ borderColor: WIRE }}>
        <div
          className="text-center font-semibold text-[11px] bg-slate-100 border-b"
          style={{ height: BOX_HEAD, lineHeight: `${BOX_HEAD - 2}px`, borderColor: WIRE }}
          title={instr ? `${instr.title} — ${instr.help}` : block.type}
        >
          {block.type}
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
