import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PencilIcon, RotateCcwIcon, ChevronRightIcon } from 'lucide-react';
import {
  CELL, IEC_SYMBOLS, SYMBOL_GROUPS, SymbolId, drawIecSymbol, symbolHeight,
  symbolLeft, symbolRight,
} from '../../utils/iecSymbols';
import {
  EplanSymbolMap, SymbolSource, partKeys, symbolForPart,
} from '../../utils/eplanSingleLine';
import { formatPartEntry } from '../../utils/tierEquipmentMatrix';
import { eplanSymbolService } from '../../services/projectService';

// The schematic of the part being entered, beside the parts themselves.
//
// A template is a list of part numbers, and until now the only way to see what
// they would draw was to build a single line and look. This shows it as the
// parts go in: pick one, see the symbol the drawing will put on the line, and
// say so outright when the guess is wrong.
//
// What decides the symbol is `symbolForPart`, the same function the single line
// uses — so what is previewed here is what is drawn there, not a second opinion
// that agrees most of the time.

export interface PartRef {
  slot: string;
  index: number;
  part: any;
}

interface Props {
  /** Every part of the template, in the order the sheet would draw them. */
  parts: PartRef[];
  selected: PartRef | null;
  onSelect: (ref: PartRef) => void;
  /** Pin a symbol to a part, or pass undefined to go back to the automatic one. */
  onSymbolChange: (ref: PartRef, symbolId: string | undefined) => void;
  /** Open the graphic page on a symbol. */
  onEdit: (symbolId: SymbolId) => void;
  /** True when this project has redrawn that symbol. */
  isRedrawn: (symbolId: SymbolId) => boolean;
}

const WHY: Record<SymbolSource, string> = {
  chosen: 'chosen here',
  eplan: 'from what EPLAN says the part is',
  description: 'from the part’s own description',
  slot: 'from the row it was filed under',
  accessory: 'reads as an accessory of the device above it',
};

/** One symbol drawn to its own box, for a preview of any size. */
const SymbolArt: React.FC<{ id: SymbolId; height: number }> = ({ id, height }) => {
  const left = symbolLeft(id);
  const right = symbolRight(id);
  const tall = symbolHeight(id);
  return (
    <svg
      width="100%" height={height}
      viewBox={`0 0 ${left + right} ${tall}`}
      preserveAspectRatio="xMidYMid meet"
      dangerouslySetInnerHTML={{ __html: drawIecSymbol(id, left, 0) }}
    />
  );
};

export const PartSchematicPanel: React.FC<Props> = ({
  parts, selected, onSelect, onSymbolChange, onEdit, isRedrawn,
}) => {
  // What EPLAN says these parts are. Without it the symbol still comes out —
  // from the description, then the row — which is exactly what the drawing
  // falls back to when the parts database is out of reach.
  const [symbols, setSymbols] = useState<EplanSymbolMap>({});
  const asked = useRef('');

  const codes = useMemo(() => {
    const out = new Set<string>();
    for (const ref of parts) for (const key of partKeys(ref.part)) out.add(key);
    return [...out].sort();
  }, [parts]);

  useEffect(() => {
    const key = codes.join('|');
    if (!key || key === asked.current) return;
    asked.current = key;
    let cancelled = false;
    (async () => {
      const found = await eplanSymbolService.lookup(codes);
      if (!cancelled) setSymbols(found);
    })();
    return () => { cancelled = true; };
  }, [codes]);

  const resolved = useMemo(
    () => new Map(parts.map(ref =>
      [`${ref.slot}#${ref.index}`, symbolForPart(ref.part, ref.slot, symbols)])),
    [parts, symbols]);

  const keyOf = (ref: PartRef) => `${ref.slot}#${ref.index}`;
  const current = selected ? resolved.get(keyOf(selected)) : undefined;
  const chosen = String(selected?.part?.symbolId ?? '');

  return (
    <div className="border border-gray-200 rounded-lg bg-white flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b bg-gray-50">
        <p className="text-sm font-medium text-gray-800">Schematic</p>
        <p className="text-[11px] text-gray-500">
          What the single line draws for the part you are on. Pick a part to see it.
        </p>
      </div>

      {parts.length === 0 ? (
        <p className="px-3 py-6 text-sm text-gray-500">
          No parts yet. Add one to a row and its symbol appears here.
        </p>
      ) : (
        <>
          {/* The one on show, big. */}
          <div className="px-3 py-3 border-b">
            {selected && current ? (
              <>
                <div className="h-28 flex items-center justify-center bg-white border border-gray-200 rounded">
                  <SymbolArt id={current.id} height={104} />
                </div>
                <p className="mt-2 text-sm font-medium text-gray-800 truncate" title={formatPartEntry(selected.part)}>
                  {formatPartEntry(selected.part) || '—'}
                </p>
                <p className="text-[11px] text-gray-500">
                  {selected.slot}
                  {selected.index > 0 && ` · part ${selected.index + 1} of the row`}
                </p>
                <p className={`text-[11px] ${current.from === 'chosen' ? 'text-emerald-700' : 'text-gray-500'}`}>
                  {IEC_SYMBOLS[current.id]?.title ?? current.id} — {WHY[current.from]}
                  {isRedrawn(current.id) && ' · redrawn for this project'}
                </p>

                <div className="mt-2 flex items-center gap-1.5">
                  <select
                    className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                    value={chosen}
                    onChange={e => onSymbolChange(selected, e.target.value || undefined)}
                  >
                    <option value="">
                      automatic — {IEC_SYMBOLS[symbolForPart({ ...selected.part, symbolId: undefined },
                        selected.slot, symbols).id]?.title ?? '—'}
                    </option>
                    {SYMBOL_GROUPS.map(group => (
                      <optgroup key={group} label={group}>
                        {Object.values(IEC_SYMBOLS)
                          .filter(sym => sym.group === group)
                          .map(sym => (
                            <option key={sym.id} value={sym.id}>{sym.title}</option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {chosen && (
                    <button
                      onClick={() => onSymbolChange(selected, undefined)}
                      title="Back to the symbol the drawing works out on its own"
                      className="p-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                    >
                      <RotateCcwIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(current.id)}
                    title="Open this symbol on the graphic page"
                    className="flex items-center gap-1 px-2 py-1.5 rounded bg-slate-700 text-white text-xs font-medium hover:bg-slate-800"
                  >
                    <PencilIcon className="w-3.5 h-3.5" /> Edit
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500 py-8 text-center">Pick a part from the list below.</p>
            )}
          </div>

          {/* Every part of the template, in the order the sheet draws them. */}
          <ul className="flex-1 overflow-y-auto divide-y max-h-72">
            {parts.map(ref => {
              const item = resolved.get(keyOf(ref));
              const isOn = selected && keyOf(selected) === keyOf(ref);
              return (
                <li key={keyOf(ref)}>
                  <button
                    onClick={() => onSelect(ref)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${
                      isOn ? 'bg-blue-50' : ''}`}
                  >
                    <span className="w-9 h-9 shrink-0 border border-gray-200 rounded bg-white flex items-center justify-center">
                      {item && <SymbolArt id={item.id} height={34} />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-gray-800 truncate">
                        {formatPartEntry(ref.part) || '—'}
                      </span>
                      <span className="block text-[10px] text-gray-500 truncate">
                        {ref.slot} · {item ? (IEC_SYMBOLS[item.id]?.title ?? item.id) : ''}
                        {ref.part?.symbolId ? ' · chosen' : ''}
                      </span>
                    </span>
                    {isOn && <ChevronRightIcon className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-3 py-1.5 border-t bg-gray-50 text-[10px] text-gray-400">
            One cell is {CELL} units of the branch.
          </p>
        </>
      )}
    </div>
  );
};
