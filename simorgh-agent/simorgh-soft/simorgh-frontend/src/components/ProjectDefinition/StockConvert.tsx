// src/components/ProjectDefinition/StockConvert.tsx
//
// "I need this code, the store has that one": what comes off the stock
// breaker and what goes on it, from the catalogue's spare-part tables
// (utils/sion3ae5/convert).
import React, { useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { compare, GENERATIONS, type Family, type Part } from '../../utils/sion3ae5/convert';

interface Props {
  /** The code the project needs, as the builder above has it. */
  wanted: string;
  family: Family;
}

const PartList: React.FC<{ title: string; parts: Part[]; empty: string; tone: string }> = ({ title, parts, empty, tone }) => (
  <div>
    <h5 className={`text-xs font-semibold uppercase tracking-wide mb-1 ${tone}`}>{title} ({parts.length})</h5>
    {parts.length === 0
      ? <p className="text-xs text-gray-500">{empty}</p>
      : (
        <table className="w-full text-xs">
          <tbody>
            {parts.map((p, i) => (
              <tr key={i} className="border-t border-gray-100" title={p.note}>
                <td className="py-1 pr-2 text-gray-800">{p.label}{p.note ? ' *' : ''}</td>
                <td className="py-1 font-mono whitespace-nowrap text-gray-900">{p.article ?? <span className="text-amber-800">ask Siemens</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </div>
);

export const StockConvert: React.FC<Props> = ({ wanted, family }) => {
  const [open, setOpen] = useState(false);
  const [stock, setStock] = useState('');
  const gens = GENERATIONS[family];
  const [stockGen, setStockGen] = useState(gens[0][0]);
  const [wantedGen, setWantedGen] = useState(gens[0][0]);
  const r = useMemo(() => (stock.trim() ? compare(stock, stockGen, wanted, wantedGen) : null), [stock, stockGen, wanted, wantedGen]);
  const sel = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
    >
      {gens.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <section className="border border-gray-200 rounded-md">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 text-sm text-gray-800 rounded-t-md"
        title={family === '3AE5' ? 'From the spare-part tables of SION catalogue HG 11.02 · 10/2022, pages 33–35' : 'From the spare-part tables of 3AH3 catalogue HG 11.03 · 2018, pages 30–31'}
      >
        {open ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
        Convert a breaker from stock
        <span className="text-xs text-gray-600">— which parts come off and which go on</span>
      </button>
      {open && (
        <div className="p-3 space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <label className="block text-xs text-gray-600">
              <span className="block mb-1">Article number in stock</span>
              <input
                value={stock}
                onChange={e => setStock(e.target.value)}
                placeholder={family === '3AE5' ? '3AE5124-2AE40-0EN2-Z F30' : '3AH3305-2ME40-0EB2'}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block text-xs text-gray-600" title="The article number does not say it — the rating plate's serial number and year do">
              <span className="block mb-1">Stock breaker — anti-pumping</span>
              {sel(stockGen, setStockGen)}
            </label>
            <label className="block text-xs text-gray-600">
              <span className="block mb-1">Required breaker — anti-pumping</span>
              {sel(wantedGen, setWantedGen)}
            </label>
          </div>
          <p className="text-xs text-gray-600">Required: <span className="font-mono text-gray-900">{wanted}</span></p>

          {typeof r === 'string' && <p className="text-sm text-red-700">{r}</p>}
          {r && typeof r !== 'string' && (
            <>
              {r.blockers.map(b => (
                <p key={b} className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">Not by parts: {b}</p>
              ))}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <PartList title="Take off the stock breaker" parts={r.remove} empty="Nothing." tone="text-red-700" />
                <PartList title="Order and fit" parts={r.add} empty="Nothing — the stock breaker already has it all." tone="text-green-700" />
                <PartList title="Stays as it is" parts={r.keep} empty="—" tone="text-gray-600" />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                {[['Stock', r.stock], ['Required', r.wanted]].map(([t, p]) => typeof p !== 'string' && (
                  <div key={t as string}>
                    <h5 className="font-semibold text-gray-700 mb-1">{t as string}: <span className="font-mono">{(p as any).base}</span></h5>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      {(p as any).reading.map((x: { label: string; value: string }) => (
                        <React.Fragment key={x.label}><dt className="text-gray-500">{x.label}</dt><dd className="text-gray-800">{x.value}</dd></React.Fragment>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
              <ul className="text-xs text-gray-700 list-disc list-inside space-y-0.5">
                {r.notes.map(n => <li key={n}>{n}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
};
