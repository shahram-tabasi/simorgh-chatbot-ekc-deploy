// src/components/ProjectDefinition/StockCompareTab.tsx
//
// Stock Compare: "I need this code, the store has that one" — what comes off
// the stock breaker and what goes on it, from the catalogue's spare-part
// tables (utils/sion3ae5/convert). Its own tab, so the code builders stay
// as they were. The required code is typed in, or taken from a code saved in
// Breaker Code.
import React, { useMemo, useState } from 'react';
import type { ProjectData } from '../../types/project';
import { compare, GENERATIONS, type Family, type Part, type Parsed } from '../../utils/sion3ae5/convert';
import { equipmentOf } from '../../utils/sion3ae5/fromProject';

interface Props {
  projectData: ProjectData;
}

const familyOf = (code: string): Family | null => {
  const t = code.toUpperCase().replace(/\s/g, '');
  return t.startsWith('3AE5') ? '3AE5' : t.startsWith('3AH3') ? '3AH3' : null;
};

const PartList: React.FC<{ title: string; parts: Part[]; empty: string; tone: string }> = ({ title, parts, empty, tone }) => (
  <section className="border border-gray-200 rounded-md">
    <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
      <h4 className={`text-sm font-medium ${tone}`}>{title} ({parts.length})</h4>
    </header>
    {parts.length === 0
      ? <p className="px-3 py-2 text-xs text-gray-500">{empty}</p>
      : (
        <table className="w-full text-xs">
          <tbody>
            {parts.map((p, i) => (
              <tr key={i} className="border-t border-gray-100 first:border-t-0" title={p.note}>
                <td className="px-3 py-1.5 text-gray-800">{p.label}{p.note ? ' *' : ''}</td>
                <td className="px-3 py-1.5 font-mono whitespace-nowrap text-gray-900 text-right">
                  {p.article ?? <span className="text-amber-800">ask Siemens</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </section>
);

const Reading: React.FC<{ title: string; p: Parsed }> = ({ title, p }) => (
  <div>
    <h5 className="text-xs font-semibold text-gray-700 mb-1">{title}: <span className="font-mono">{p.base}</span></h5>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {p.reading.map(x => (
        <React.Fragment key={x.label}><dt className="text-gray-500">{x.label}</dt><dd className="text-gray-800">{x.value}</dd></React.Fragment>
      ))}
    </dl>
  </div>
);

export const StockCompareTab: React.FC<Props> = ({ projectData }) => {
  // The codes saved in Breaker Code, to pick the required one from.
  const saved = useMemo(() => (projectData.deviceLibrary?.MV ?? []).flatMap(scope => {
    const rows = equipmentOf(projectData, scope)?.devices ?? [];
    return Object.entries(scope.breakerCodes ?? {})
      .filter(([, rec]) => rec.code && !rec.code.includes('?'))
      .map(([id, rec]) => {
        const row = rows.find(r => r.id === id);
        const where = row ? [row.feederNo, row.templateName].filter(Boolean).join(' · ') : 'Switchgear';
        return { label: `${scope.name} — ${where}`, code: rec.code };
      });
  }), [projectData]);

  const [wanted, setWanted] = useState(saved[0]?.code ?? '');
  const [stock, setStock] = useState('');
  const family = familyOf(wanted) ?? familyOf(stock) ?? '3AE5';
  const gens = GENERATIONS[family];
  const [stockGen, setStockGen] = useState('');
  const [wantedGen, setWantedGen] = useState('');
  // A generation from the other family falls back to this family's newest.
  const sg = gens.some(g => g[0] === stockGen) ? stockGen : gens[0][0];
  const wg = gens.some(g => g[0] === wantedGen) ? wantedGen : gens[0][0];
  const r = useMemo(() => (stock.trim() && wanted.trim() ? compare(stock, sg, wanted, wg) : null), [stock, sg, wanted, wg]);

  const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';
  const genSel = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={e => onChange(e.target.value)} className={input}>
      {gens.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600"
        title="SION 3AE5: HG 11.02 · 10/2022, pages 33–35 · 3AH3: HG 11.03 · 2018, pages 30–31">
        Which parts come off a breaker from stock and which go on, to make it the one the project needs — from the catalogues' spare-part tables.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-sm font-medium text-gray-800">Required breaker</h4>
          {saved.length > 0 && (
            <label className="block text-xs text-gray-600">
              <span className="block mb-1">From Breaker Code</span>
              <select value={saved.some(s => s.code === wanted) ? wanted : ''} onChange={e => e.target.value && setWanted(e.target.value)} className={input}>
                <option value="">Choose a saved code…</option>
                {saved.map((s, i) => <option key={i} value={s.code}>{s.label} — {s.code}</option>)}
              </select>
            </label>
          )}
          <label className="block text-xs text-gray-600">
            <span className="block mb-1">Article number</span>
            <input value={wanted} onChange={e => setWanted(e.target.value)} placeholder="3AE5124-2AE40-0EN2-Z F30" className={`${input} font-mono`} />
          </label>
          <label className="block text-xs text-gray-600" title="The article number does not say it — the rating plate's serial number and year do">
            <span className="block mb-1">Anti-pumping</span>
            {genSel(wg, setWantedGen)}
          </label>
        </section>

        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-sm font-medium text-gray-800">Breaker in stock</h4>
          <label className="block text-xs text-gray-600">
            <span className="block mb-1">Article number</span>
            <input value={stock} onChange={e => setStock(e.target.value)} placeholder={family === '3AE5' ? '3AE5124-2AE40-0EA2' : '3AH3305-2ME40-0EB2'} className={`${input} font-mono`} />
          </label>
          <label className="block text-xs text-gray-600" title="The article number does not say it — the rating plate's serial number and year do">
            <span className="block mb-1">Anti-pumping</span>
            {genSel(sg, setStockGen)}
          </label>
        </section>
      </div>

      {typeof r === 'string' && <p className="text-sm text-red-700">{r}</p>}
      {r && typeof r !== 'string' && (
        <>
          {r.blockers.map(b => (
            <p key={b} className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">Not by parts: {b}</p>
          ))}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <PartList title="Take off the stock breaker" parts={r.remove} empty="Nothing." tone="text-red-700" />
            <PartList title="Order and fit" parts={r.add} empty="Nothing — the stock breaker already has it all." tone="text-green-700" />
            <PartList title="Stays as it is" parts={r.keep} empty="—" tone="text-gray-700" />
          </div>
          {r.steps.length > 0 && (
            <section className="border border-gray-200 rounded-md">
              <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                <h4 className="text-sm font-medium text-gray-800">Rewiring</h4>
              </header>
              <ol className="px-3 py-2 text-sm text-gray-800 list-decimal list-inside space-y-1">
                {r.steps.map(s => <li key={s}>{s}</li>)}
              </ol>
            </section>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 border border-gray-200 rounded-md p-3">
            <Reading title="Stock" p={r.stock} />
            <Reading title="Required" p={r.wanted} />
          </div>
          <ul className="text-xs text-gray-700 list-disc list-inside space-y-0.5">
            {r.notes.map(n => <li key={n}>{n}</li>)}
          </ul>
        </>
      )}
    </div>
  );
};
