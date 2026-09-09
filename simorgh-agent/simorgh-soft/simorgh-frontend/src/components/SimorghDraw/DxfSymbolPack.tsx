import React, { useMemo, useRef, useState } from 'react';
import { UploadIcon, Trash2Icon, FileWarningIcon } from 'lucide-react';
import { IEC_SYMBOLS, SymbolId } from '../../utils/iecSymbols';
import { DxfSymbol, symbolFromDxf } from '../../utils/cad/dxfSymbols';

// The office's own DXF schematics, brought in and put on the line.
//
// There are two ways in, and they layer. A file dropped into the symbol pack
// on the server — eplan-symbols/vcb.dxf — reaches everyone who opens the
// project, which is where a schematic belongs once it is settled. A file
// picked here is read in this browser only, on top of the pack, which is what
// you want while a drawing is still being got right.
//
// A file named after one of the library's symbols takes that symbol's place.
// A file named after anything else is loaded all the same and the symbol it
// stands for is chosen here, which is the ordinary case: a schematic is named
// after the device, not after us.

interface Props {
  symbols: DxfSymbol[];
  onChange: (next: DxfSymbol[]) => void;
}

const ID_BY_NAME = new Map(Object.keys(IEC_SYMBOLS).map(id => [id.toLowerCase(), id as SymbolId]));

/** vcb.dxf, VCB.DXF, vacuum_contactor_fuse.dxf → the library's own id. */
function idFromFileName(fileName: string): SymbolId | null {
  const stem = fileName.replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return ID_BY_NAME.get(stem) ?? null;
}

const SORTED_IDS = Object.values(IEC_SYMBOLS)
  .map(s => ({ id: s.id, label: `${s.title} — ${s.id}` }))
  .sort((a, b) => a.label.localeCompare(b.label));

export const DxfSymbolPack: React.FC<Props> = ({ symbols, onChange }) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  const taken = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of symbols) count.set(s.id, (count.get(s.id) ?? 0) + 1);
    return count;
  }, [symbols]);

  const read = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const rejected: string[] = [];
    const added: DxfSymbol[] = [];

    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        // A file that names a library symbol takes its place; otherwise it
        // lands on 'accessory' and is pointed at the right one here.
        const id = idFromFileName(file.name) ?? 'accessory';
        const symbol = symbolFromDxf(text, file.name, id);
        if (symbol) added.push(symbol);
        else rejected.push(`${file.name} — no geometry this reader understands`);
      } catch (error) {
        rejected.push(`${file.name} — ${error instanceof Error ? error.message : 'could not be read'}`);
      }
    }

    // A second file for the same symbol replaces the first: the last one
    // dropped is the one the office means.
    const byId = new Map(symbols.map(s => [s.id, s]));
    for (const s of added) byId.set(s.id, s);
    onChange([...byId.values()]);
    setFailed(rejected);
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  const retarget = (fileName: string, id: string) => {
    const moved = symbols.find(s => s.fileName === fileName);
    if (!moved) return;
    const rest = symbols.filter(s => s.fileName !== fileName && s.id !== id);
    onChange([...rest, { ...moved, id }]);
  };

  const setCells = (fileName: string, cells: number) =>
    onChange(symbols.map(s => (s.fileName === fileName ? { ...s, cells } : s)));

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-b">
        <div className="min-w-0">
          <p className="font-medium text-sm text-gray-800">Your own DXF schematics — this browser</p>
          <p className="text-xs text-gray-500">
            A device drawn in AutoCAD replaces the library symbol and goes back out as
            geometry, not as a picture. Put points on a layer named <code>CONN</code> at the
            terminals and the branch line runs through them by itself.
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            These are read here only, on top of the symbol pack. Copy the same file into
            {' '}<code>simorgh-backend/eplan-symbols/</code> to give it to everyone.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={input} type="file" accept=".dxf,application/dxf,image/vnd.dxf" multiple
            className="hidden" onChange={e => read(e.target.files)}
          />
          <button
            onClick={() => input.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-700 text-white text-sm font-medium hover:bg-teal-800 disabled:opacity-40"
          >
            <UploadIcon className="w-4 h-4" />
            {busy ? 'Reading…' : 'Add DXF'}
          </button>
          {symbols.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-100"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {failed.length > 0 && (
        <ul className="px-4 py-2 bg-amber-50 border-b text-xs text-amber-800 space-y-0.5">
          {failed.map(line => (
            <li key={line} className="flex items-center gap-1.5">
              <FileWarningIcon className="w-3.5 h-3.5 shrink-0" />{line}
            </li>
          ))}
        </ul>
      )}

      {symbols.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500">
          Nothing loaded. The drawing uses the library's own symbols until a file replaces one.
        </p>
      ) : (
        <ul className="divide-y">
          {symbols.map(s => (
            <li key={s.fileName} className="flex items-start gap-4 px-4 py-3">
              <svg
                width={72} height={72}
                viewBox={`${-s.width * 0.1} ${-s.height * 0.1} ${s.width * 1.2} ${s.height * 1.2}`}
                className="shrink-0 border border-gray-200 rounded bg-white"
              >
                <g dangerouslySetInnerHTML={{ __html: s.art }} />
                {/* The terminals, so it is obvious where the line will join. */}
                <circle cx={s.pinX} cy={0} r={Math.max(1, s.width * 0.04)} fill="#0d9488" />
                <circle cx={s.pinX} cy={s.height} r={Math.max(1, s.width * 0.04)} fill="#0d9488" />
              </svg>

              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium text-gray-800 truncate">{s.fileName}</p>
                <p className="text-[11px] text-gray-500">
                  {s.entities} entities · {s.terminals} terminal{s.terminals === 1 ? '' : 's'} ·
                  {' '}{s.width.toFixed(0)} × {s.height.toFixed(0)} units
                  {Object.keys(s.skipped).length > 0 && (
                    <span className="text-amber-700">
                      {' '}· passed over {Object.entries(s.skipped).map(([k, n]) => `${n} ${k}`).join(', ')}
                    </span>
                  )}
                </p>
                <p className={`text-[11px] ${s.terminals >= 2 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {s.note}
                </p>
                <div className="flex items-center gap-2 pt-0.5">
                  <label className="text-[11px] text-gray-500">Replaces</label>
                  <select
                    className="border border-gray-300 rounded px-2 py-1 text-xs bg-white max-w-[16rem]"
                    value={s.id}
                    onChange={e => retarget(s.fileName, e.target.value)}
                  >
                    {SORTED_IDS.map(o => (
                      <option key={o.id} value={o.id}>
                        {o.label}{taken.has(o.id) && o.id !== s.id ? ' (taken)' : ''}
                      </option>
                    ))}
                  </select>
                  <label className="text-[11px] text-gray-500 ml-2">Cells</label>
                  <select
                    className="border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                    value={s.cells}
                    onChange={e => setCells(s.fileName, Number(e.target.value))}
                  >
                    {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>

              <button
                onClick={() => onChange(symbols.filter(x => x.fileName !== s.fileName))}
                title="Remove this symbol"
                className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
              >
                <Trash2Icon className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
