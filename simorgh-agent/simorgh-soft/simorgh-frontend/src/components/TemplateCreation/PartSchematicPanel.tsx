import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MaximizeIcon, RotateCcwIcon, ChevronRightIcon } from 'lucide-react';
import {
  CELL, IEC_SYMBOLS, SYMBOL_GROUPS, SymbolId, drawIecSymbol, symbolHeight,
  symbolLeft, symbolRight,
} from '../../utils/iecSymbols';
import { useSymbolVersion } from '../../utils/cad/useSymbols';
import {
  EplanSymbolMap, SymbolSource, TemplateLike, buildTemplateSvg, partKeys, symbolForPart,
} from '../../utils/eplanSingleLine';
import { formatPartEntry } from '../../utils/tierEquipmentMatrix';
import { eplanSymbolService } from '../../services/projectService';

// The template's own drawing, beside the parts that make it.
//
// One picture of the whole cell — not one per part. It is put together by the
// rule the sheets already use: the devices that carry power in series down the
// line, the instruments hanging off it in parallel from the transformer that
// feeds them, the shunts beside it with the earth under them. Add a part and it
// takes its place; the list underneath says what each part became and lets a
// wrong guess be corrected without opening anything.

export interface PartRef {
  slot: string;
  index: number;
  part: any;
}

interface Props {
  template: TemplateLike;
  tier: 'LV' | 'MV' | 'HV';
  /** Every part of the template, in the order the sheet would draw them. */
  parts: PartRef[];
  selected: PartRef | null;
  onSelect: (ref: PartRef) => void;
  /** Pin a symbol to a part, or pass undefined to go back to the automatic one. */
  onSymbolChange: (ref: PartRef, symbolId: string | undefined) => void;
  /** Open the one graphic window, on the whole template. */
  onOpenGraphic: (symbols: EplanSymbolMap) => void;
  /**
   * Leave off the panel's own title bar and border.
   *
   * Set when something outside already draws them — the collapsible frame on
   * the template screen. Off by default, so every existing use looks exactly
   * as it did.
   */
  bare?: boolean;
}

const WHY: Record<SymbolSource, string> = {
  chosen: 'chosen here',
  eplan: 'from what EPLAN says the part is',
  description: 'from the part’s own description',
  slot: 'from the row it was filed under',
  accessory: 'reads as an accessory of the device above it',
};

/** One symbol drawn to its own box, for the list beside each part. */
const SymbolArt: React.FC<{ id: SymbolId; height: number }> = ({ id, height }) => (
  <svg
    width="100%" height={height}
    viewBox={`0 0 ${symbolLeft(id) + symbolRight(id)} ${symbolHeight(id)}`}
    preserveAspectRatio="xMidYMid meet"
    dangerouslySetInnerHTML={{ __html: drawIecSymbol(id, symbolLeft(id), 0) }}
  />
);

export const PartSchematicPanel: React.FC<Props> = ({
  template, tier, parts, selected, onSelect, onSymbolChange, onOpenGraphic, bare,
}) => {
  // Every symbol on this panel is drawn from the library, which lives outside
  // React. Read the version and this panel is drawn again the moment a symbol
  // changes — on any screen. Without it the previews here kept whatever the
  // library held when the panel first rendered, which is the half of "it is
  // not in sync" that showed up in the template tab.
  const symbolVersion = useSymbolVersion();
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

  // The version is in here as well as read above, and it has to be: being
  // drawn again does not rebuild a memo, and this one *is* the symbols —
  // `buildTemplateSvg` draws every device on the cell from the library. Left
  // out, the panel redrew itself and handed back the markup it had built
  // before the symbol was redrawn.
  const cell = useMemo(
    () => buildTemplateSvg(template, tier, symbols),
    [template, tier, symbols, symbolVersion]);

  const resolved = useMemo(
    () => new Map(parts.map(ref =>
      [`${ref.slot}#${ref.index}`, symbolForPart(ref.part, ref.slot, symbols, tier)])),
    [parts, symbols, tier]);

  const keyOf = (ref: PartRef) => `${ref.slot}#${ref.index}`;
  const current = selected ? resolved.get(keyOf(selected)) : undefined;
  const chosen = String(selected?.part?.symbolId ?? '');

  return (
    <div className={bare
      ? 'bg-white flex flex-col overflow-hidden'
      : 'border border-gray-200 rounded-lg bg-white flex flex-col overflow-hidden'}>
      {!bare && (
        <div className="px-3 py-2 border-b bg-gray-50 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">Template graphic</p>
            <p className="text-[11px] text-gray-500">
              The whole cell, drawn the way a feeder built on it will be.
            </p>
          </div>
          <button
            onClick={() => onOpenGraphic(symbols)}
            title="Open the graphic in its own window, where it can be edited"
            className="flex items-center gap-1 px-2 py-1.5 rounded bg-slate-700 text-white text-xs font-medium hover:bg-slate-800 shrink-0"
          >
            <MaximizeIcon className="w-3.5 h-3.5" /> Open
          </button>
        </div>
      )}

      {/* In bare mode the frame outside owns the title, but Open belongs to
          this panel — the symbols it opens with are fetched in here. */}
      {bare && (
        <div className="px-3 pb-2 flex justify-end">
          <button
            onClick={() => onOpenGraphic(symbols)}
            title="Open the graphic in its own window, where it can be edited"
            className="flex items-center gap-1 px-2 py-1.5 rounded bg-slate-700 text-white text-xs font-medium hover:bg-slate-800"
          >
            <MaximizeIcon className="w-3.5 h-3.5" /> Open
          </button>
        </div>
      )}

      {/* The template itself. Scaled to the panel; the window is where it is
          read properly and edited. */}
      <div className="px-3 py-3 border-b bg-white">
        <div
          className="w-full overflow-hidden [&>svg]:w-full [&>svg]:h-auto"
          style={{ maxHeight: 260 }}
          dangerouslySetInnerHTML={{ __html: cell.svg }}
        />
      </div>

      {parts.length === 0 ? (
        <p className="px-3 py-4 text-sm text-gray-500">
          No parts yet. Add one to a row and it takes its place on the cell above.
        </p>
      ) : (
        <>
          {/* What the part on show became, and a way to say otherwise. */}
          {selected && current && (
            <div className="px-3 py-2 border-b bg-gray-50/60">
              <p className="text-sm font-medium text-gray-800 truncate" title={formatPartEntry(selected.part)}>
                {formatPartEntry(selected.part) || '—'}
              </p>
              <p className="text-[11px] text-gray-500">
                {selected.slot}{selected.index > 0 && ` · part ${selected.index + 1} of the row`}
              </p>
              <p className={`text-[11px] ${current.from === 'chosen' ? 'text-emerald-700' : 'text-gray-500'}`}>
                {IEC_SYMBOLS[current.id]?.title ?? current.id} — {WHY[current.from]}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <select
                  className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                  value={chosen}
                  onChange={e => onSymbolChange(selected, e.target.value || undefined)}
                >
                  <option value="">
                    automatic — {IEC_SYMBOLS[symbolForPart({ ...selected.part, symbolId: undefined },
                      selected.slot, symbols, tier).id]?.title ?? '—'}
                  </option>
                  {SYMBOL_GROUPS.map(group => (
                    <optgroup key={group} label={group}>
                      {Object.values(IEC_SYMBOLS)
                        .filter(sym => sym.group === group)
                        .map(sym => <option key={sym.id} value={sym.id}>{sym.title}</option>)}
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
              </div>
            </div>
          )}

          <ul className="flex-1 overflow-y-auto divide-y max-h-60">
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
            {cell.devices} device{cell.devices === 1 ? '' : 's'} on the cell · one cell step is {CELL} units.
          </p>
        </>
      )}
    </div>
  );
};
