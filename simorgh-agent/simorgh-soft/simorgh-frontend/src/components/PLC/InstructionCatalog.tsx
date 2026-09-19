// src/components/PLC/InstructionCatalog.tsx
//
// The instruction tree, down the right-hand side.
//
// It is a tree and not a palette of icons for one reason: an engineer knows
// the *family* of what they want long before the name. "Something that counts
// up", "the one that turns a raw analogue value into engineering units" —
// those are Counter operations and Conversion operations, and finding them by
// opening the right heading takes one second where scanning a wall of glyphs
// takes ten. The search box is for the other half of the time, when the name
// is known exactly.
//
// Every row carries the one-line description beside the name and the full help
// on hover, because the difference between `SR` and `RS` is one sentence and
// choosing the wrong one gives a machine that starts when it was told to stop.
// Making that sentence reachable without leaving the page is most of what this
// panel is for.
//
// Clicking an instruction **arms** it rather than inserting it. Where it goes
// depends on the language: onto the rung at the cursor in LAD, at the text
// cursor in SCL. Arming keeps that decision in one place and makes the
// two-step obvious — pick the place, pick the instruction, in either order.

import React, { useMemo, useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, SearchIcon, StarIcon, XIcon, BookOpenIcon,
} from 'lucide-react';
import {
  INSTRUCTION_SECTIONS, Instruction, searchInstructions,
} from '../../utils/plc/instructions';

interface Props {
  /** What is armed now, so the row can be shown as picked. */
  armed: Instruction | null;
  onArm: (instr: Instruction | null) => void;
  /** Put it in now — a double click, or the button on the row. */
  onInsert: (instr: Instruction) => void;
  /** What the open block is written in, so rows that cannot go in are dimmed. */
  language: 'LAD' | 'FBD' | 'SCL' | 'STL' | 'GRAPH';
  readOnly?: boolean;
}

const FAVOURITES_KEY = 'simorgh-plc-favourites';

function loadFavourites(): string[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : DEFAULT_FAVOURITES;
  } catch {
    return DEFAULT_FAVOURITES;
  }
}

/**
* What Favorites holds before anybody has changed it.
*
* The seven things a first program is made of. An empty Favorites is a heading
* that teaches nothing; this one is a shortcut on day one and a habit by the
* end of the week.
*/
const DEFAULT_FAVOURITES = [
  'bit.no', 'bit.nc', 'bit.coil', 'bit.set', 'bit.reset', 'tmr.ton', 'cnt.ctu',
];

export const InstructionCatalog: React.FC<Props> = ({
  armed, onArm, onInsert, language, readOnly,
}) => {
  const [query, setQuery] = useState('');
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['basic']));
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['bit']));
  const [favourites, setFavourites] = useState<string[]>(loadFavourites);
  const [showFavourites, setShowFavourites] = useState(true);
  const [help, setHelp] = useState<Instruction | null>(null);

  const results = useMemo(() => searchInstructions(query), [query]);

  const favouriteItems = useMemo(() => {
    const all = INSTRUCTION_SECTIONS.flatMap(s => s.groups).flatMap(g => g.items);
    return favourites
      .map(id => all.find(x => x.id === id))
      .filter((x): x is Instruction => x !== undefined);
  }, [favourites]);

  const toggleFavourite = (id: string) => {
    setFavourites(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      try { window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next)); }
      catch { /* a browser that keeps nothing is not an error */ }
      return next;
    });
  };

  const toggle = (set: Set<string>, id: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    put(next);
  };

  /**
   * Whether this instruction can go into the language that is open.
   *
   * Not hidden — dimmed, with a reason on hover. Hiding half the catalogue
   * when an SCL block is open would make an engineer think the instruction is
   * gone; showing it greyed says "this one is drawn, and this block is
   * written", which is a thing worth knowing.
   */
  const usable = (x: Instruction): string | null => {
    const graphical = language === 'LAD' || language === 'FBD';
    if (x.form === 'editor' && !graphical) return 'An editor command, for a drawn network.';
    if (!graphical && !x.scl) return 'Drawn only — there is no text form of this one.';
    return null;
  };

  return (
    <div className="h-full flex flex-col bg-white text-[12px]">
      {/* Search */}
      <div className="p-2 border-b shrink-0">
        <div className="relative">
          <SearchIcon className="w-3.5 h-3.5 absolute start-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search instructions…"
            className="w-full ps-7 pe-7 py-1.5 rounded border border-gray-300 focus:border-blue-400 focus:outline-none"
          />
          {query && (
            <button
              className="absolute end-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-gray-200"
              onClick={() => setQuery('')}
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* Always here, armed or not.
            It used to appear only once something was picked, which pushed the
            whole list down by its own height — so the second click of a double
            click landed on the row *above* the one that was double-clicked,
            and picking TON gave a Set coil. A strip that is always on the
            screen cannot move anything under the pointer. */}
        <div
          className={`mt-2 flex items-center gap-2 px-2 py-1.5 rounded border
            ${armed ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}
        >
          {armed ? (
            <>
              <span className="font-mono font-semibold">{armed.name}</span>
              <span className="text-[11px] text-blue-800 truncate">
                — click where it goes
              </span>
              <button
                className="ms-auto p-0.5 rounded hover:bg-blue-100"
                onClick={() => onArm(null)}
                title="Put it back"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <span className="text-[11px] text-gray-500 truncate">
              Click an instruction, then click where it goes.
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {query.trim() ? (
          <div>
            <div className="px-2 py-1.5 bg-gray-50 text-[11px] font-semibold text-gray-500">
              {results.length} match{results.length === 1 ? '' : 'es'}
            </div>
            {results.map(x => (
              <Row
                key={x.id} instr={x} armed={armed?.id === x.id} readOnly={readOnly}
                why={usable(x)} favourite={favourites.includes(x.id)}
                onArm={onArm} onInsert={onInsert} onFavourite={toggleFavourite} onHelp={setHelp}
              />
            ))}
            {results.length === 0 && (
              <p className="px-3 py-6 text-center text-[11px] text-gray-500 italic">
                Nothing in the catalogue matches that. The search looks at the name, the
                description and the help.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Favorites */}
            <button
              className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-gray-100
                font-semibold text-gray-700 hover:bg-gray-200"
              onClick={() => setShowFavourites(v => !v)}
            >
              {showFavourites ? <ChevronDownIcon className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
              <StarIcon className="w-3.5 h-3.5 text-amber-500" />
              Favorites
            </button>
            {showFavourites && favouriteItems.map(x => (
              <Row
                key={`fav-${x.id}`} instr={x} armed={armed?.id === x.id} readOnly={readOnly}
                why={usable(x)} favourite
                onArm={onArm} onInsert={onInsert} onFavourite={toggleFavourite} onHelp={setHelp}
              />
            ))}
            {showFavourites && favouriteItems.length === 0 && (
              <p className="px-6 py-2 text-[11px] text-gray-500 italic">
                Nothing here. The star on a row puts it in.
              </p>
            )}

            {INSTRUCTION_SECTIONS.map(section => (
              <div key={section.id}>
                <button
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 bg-gray-100
                    font-semibold text-gray-700 hover:bg-gray-200"
                  onClick={() => toggle(openSections, section.id, setOpenSections)}
                >
                  {openSections.has(section.id)
                    ? <ChevronDownIcon className="w-3.5 h-3.5" />
                    : <ChevronRightIcon className="w-3.5 h-3.5" />}
                  {section.label}
                </button>

                {openSections.has(section.id) && section.groups.map(group => (
                  <div key={group.id}>
                    <button
                      className="w-full flex items-center gap-1.5 ps-5 pe-2 py-1 text-left
                        hover:bg-gray-50"
                      onClick={() => toggle(openGroups, group.id, setOpenGroups)}
                      title={group.note}
                    >
                      {openGroups.has(group.id)
                        ? <ChevronDownIcon className="w-3 h-3 text-gray-400" />
                        : <ChevronRightIcon className="w-3 h-3 text-gray-400" />}
                      <span className="text-gray-700">{group.label}</span>
                      <span className="ms-auto text-[10px] text-gray-400">{group.items.length}</span>
                    </button>

                    {openGroups.has(group.id) && group.items.map(x => (
                      <Row
                        key={x.id} instr={x} armed={armed?.id === x.id} readOnly={readOnly}
                        why={usable(x)} favourite={favourites.includes(x.id)}
                        onArm={onArm} onInsert={onInsert} onFavourite={toggleFavourite} onHelp={setHelp}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      {/* The help for one instruction, at the bottom where it does not cover
          the list it was opened from. */}
      {help && (
        <div className="shrink-0 border-t bg-amber-50/60 max-h-[42%] overflow-auto">
          <div className="flex items-start gap-2 px-3 py-2">
            <BookOpenIcon className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{help.name} — {help.title}</p>
              {help.pins && help.pins.length > 0 && (
                <p className="mt-1 text-[11px] font-mono text-gray-600">
                  {help.pins.filter(p => !p.out).map(p => `${p.name}: ${p.type}`).join('   ')}
                  {help.pins.some(p => p.out) && '  ⇒  '}
                  {help.pins.filter(p => p.out).map(p => `${p.name}: ${p.type}`).join('   ')}
                </p>
              )}
              {help.instance && (
                <p className="mt-1 text-[11px] text-amber-800">
                  Keeps its own state — it needs an instance of its own.
                </p>
              )}
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-gray-700">
                {help.help}
              </p>
              {help.scl && (
                <pre className="mt-2 p-2 rounded bg-white border
                  text-[11px] font-mono whitespace-pre-wrap">
                  {help.scl.replace(/\$\{\d+:?([^}]*)\}/g, '$1')}
                </pre>
              )}
            </div>
            <button
              className="p-0.5 rounded hover:bg-amber-100 shrink-0"
              onClick={() => setHelp(null)}
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{
  instr: Instruction;
  armed: boolean;
  favourite: boolean;
  readOnly?: boolean;
  /** Why it cannot go into the open block, or null. */
  why: string | null;
  onArm: (x: Instruction | null) => void;
  onInsert: (x: Instruction) => void;
  onFavourite: (id: string) => void;
  onHelp: (x: Instruction) => void;
}> = ({ instr, armed, favourite, readOnly, why, onArm, onInsert, onFavourite, onHelp }) => (
  <div
    className={`group flex items-center gap-2 ps-8 pe-1.5 py-1 cursor-pointer
      ${armed ? 'bg-blue-100' : 'hover:bg-blue-50'}
      ${why ? 'opacity-50' : ''}`}
    title={why ?? `${instr.title}\n\n${instr.help}`}
    onClick={() => !readOnly && !why && onArm(armed ? null : instr)}
    onDoubleClick={() => !readOnly && !why && onInsert(instr)}
  >
    <span className="font-mono text-[11px] w-[86px] shrink-0 truncate text-slate-700">
      {instr.glyph ?? instr.name}
    </span>
    <span className="flex-1 min-w-0 truncate text-gray-600 text-[11.5px]">
      {instr.title}
    </span>
    <button
      className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-amber-100"
      title="What it does, and what goes wrong with it"
      onClick={e => { e.stopPropagation(); onHelp(instr); }}
    >
      <BookOpenIcon className="w-3.5 h-3.5 text-gray-400" />
    </button>
    <button
      className={`p-0.5 rounded hover:bg-amber-100
        ${favourite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      title={favourite ? 'Take it out of Favorites' : 'Put it in Favorites'}
      onClick={e => { e.stopPropagation(); onFavourite(instr.id); }}
    >
      <StarIcon className={`w-3.5 h-3.5 ${favourite ? 'text-amber-500 fill-amber-400' : 'text-gray-400'}`} />
    </button>
  </div>
);
