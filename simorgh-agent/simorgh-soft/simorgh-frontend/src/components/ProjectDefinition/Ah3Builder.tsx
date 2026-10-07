// src/components/ProjectDefinition/Ah3Builder.tsx
//
// The 3AH3 order number (Siemens HG 11.03 · 2018), built from the scope and
// the cell the way the 3AE5 builder is: the code on top, every position a
// choice below it, what is still open listed. EK36 takes the 3AH3.
import React, { useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from 'lucide-react';
import type { BreakerCodeRecord } from '../../types/project';
import {
  evaluateAh3, primaryOptions, thirdOptions, SECOND_OPTIONS, RELEASE_LABEL, STD_V, SPECIAL_V, AUX, auxLabel,
  LANGS, AH3_EXTRAS, type Ah3State, type Release,
} from '../../utils/sion3ae5/ah3';

interface Props {
  /** Where the builder starts: what was saved, else what the project gives. */
  initial: Ah3State;
  /** What the project gives — "From project" goes back to it. */
  fromProject: Ah3State;
  saved?: BreakerCodeRecord;
  onSave: (record: BreakerCodeRecord) => void;
  /** An order code the rules add, taken off (or put back) for the scope. */
  onScopeCodeOff?: (code: string, on: boolean) => void;
}

const VOLTAGES = [...STD_V, ...SPECIAL_V];

export const Ah3Builder: React.FC<Props> = ({ initial, fromProject, saved, onSave, onScopeCodeOff }) => {
  const [s, setS] = useState<Ah3State>(initial);
  const [showExtras, setShowExtras] = useState(false);
  const [copied, setCopied] = useState(false);
  const r = useMemo(() => evaluateAh3(s), [s]);

  const set = <K extends keyof Ah3State>(k: K, v: Ah3State[K]) =>
    setS(prev => {
      const next = { ...prev, [k]: v, st: { ...prev.st, [k]: 'user' as const } };
      // A 2nd release the 3rd no longer pairs with drops the 3rd.
      if (k === 'rel2' && !thirdOptions(v as Release).includes(next.rel3)) next.rel3 = 'none';
      // The pole-centre distance follows the ratings unless only one is left.
      if (k === 'kv' || k === 'ka' || k === 'ir') next.pcd = null;
      return next;
    });
  const num = (v: string) => (v === '' ? null : Number(v));

  const field = (label: string, key: string, control: React.ReactNode, hint?: string) => {
    const open = r.missing.includes(label);
    const mark = s.st[key];
    return (
      <label className="block text-xs text-gray-600" title={hint}>
        <span className="flex items-center gap-1.5 mb-1">
          <span className={`w-1.5 h-1.5 rounded-full ${open ? 'bg-red-600' : mark === 'assumed' ? 'bg-amber-500' : 'bg-green-600'}`} />
          {label}
          {mark === 'assumed' && <span className="text-amber-800">(raised to the next rating — confirm)</span>}
          {mark === 'default' && <span className="text-gray-500">(default)</span>}
        </span>
        {control}
      </label>
    );
  };
  const sel = (value: string, onChange: (v: string) => void, options: [string, string][], open = false) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`w-full border rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 ${open ? 'border-red-400' : 'border-gray-300'}`}
    >
      <option value="">Choose…</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const voltSel = (key: 'vClose' | 'vRel1' | 'vRel2' | 'vRel3' | 'vMotor', extra: [string, string][] = []) =>
    sel(s[key] ?? '', v => set(key, v || null), [...extra, ...VOLTAGES.map(v => [v, SPECIAL_V.includes(v) ? `${v} (special)` : v] as [string, string])], !s[key]);
  const takesVoltage = (rel: Release) => rel === 'shunt' || rel === 'uv';
  const hasAc = [s.vClose, s.vRel1, s.vRel2, s.vRel3, s.vMotor].some(v => v?.startsWith('AC'));

  return (
    <div className="space-y-4">
      {/* The order number */}
      <div className="border border-gray-200 rounded-md bg-gray-50 px-4 py-3">
        <div className="flex items-end gap-[3px] overflow-x-auto pb-1">
          {r.pos.map((c, k) => (
            <React.Fragment key={k}>
              {(k === 7 || k === 12) && <span className="w-3 text-center font-mono text-xl text-gray-500 pb-1">–</span>}
              <span className="w-8 text-center shrink-0">
                <span className="block text-[10px] text-gray-500">{k + 1}</span>
                <span className={`block h-10 leading-10 font-mono text-xl font-semibold bg-white border border-gray-200 border-b-4 rounded-t ${c === '?' ? 'text-red-700 border-b-red-400' : 'text-gray-900 border-b-green-600'}`}>
                  {c}
                </span>
              </span>
            </React.Fragment>
          ))}
          {(r.orderCodes.length > 0 || r.removed.length > 0) && (
            <span className="flex items-end gap-1.5 ml-2 shrink-0">
              <span className="font-mono text-xl text-gray-500 pb-1">-Z</span>
              {[...r.orderCodes, ...r.removed].map(c => {
                const on = r.orderCodes.includes(c);
                const own = s.extras.includes(c);
                return (
                  <label
                    key={c}
                    title={on
                      ? (own ? 'Untick to take this option off this breaker' : 'Untick to take it off — the rules add it; it stays off for every breaker of this scope')
                      : 'Taken off — tick to put it back'}
                    className={`flex items-center gap-1 font-mono text-sm font-semibold px-1.5 py-1 mb-1 rounded border cursor-pointer ${
                      on ? 'bg-gray-100 border-gray-200 text-gray-800' : 'bg-white border-dashed border-gray-300 text-gray-500 line-through'}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={e => {
                        const v = e.target.checked;
                        if (!v && own) { set('extras', s.extras.filter(x => x !== c)); return; }
                        setS(prev => ({ ...prev, off: v ? (prev.off ?? []).filter(x => x !== c) : [...new Set([...(prev.off ?? []), c])] }));
                        onScopeCodeOff?.(c, v);
                      }}
                    />
                    {c}
                  </label>
                );
              })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm">
          <span className="font-mono text-gray-900">{r.code}</span>
          <button
            onClick={() => { void navigator.clipboard?.writeText(r.code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            className="px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50 inline-flex items-center gap-1"
            title="Copy the order number"
          >
            <CopyIcon className="w-3.5 h-3.5" />{copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={() => setS(fromProject)}
            className="px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50"
            title="Start again from the scope's ratings and this cell"
          >
            From project
          </button>
          <span className={`ml-auto text-xs ${r.missing.length ? 'text-red-700' : 'text-green-700'}`} title={r.missing.join('\n')}>
            {r.missing.length ? `${r.missing.length} missing` : 'Complete'}
            {r.primary ? ` · ${r.primary[0]} · Up ${r.primary[2]} / Ud ${r.primary[3]} kV · Ima ${r.primary[5]} kA · ${r.primary[6]} mm` : ''}
          </span>
          <button
            onClick={() => onSave({ spec: '3AH3', state: s, code: r.code, savedAt: new Date().toISOString() })}
            title={saved ? `Saved ${new Date(saved.savedAt).toLocaleString()}` : 'Keep this code with the scope'}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            Save
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600" title="HG 11.03 pages 15–17">Ratings (1st–8th position)</h4>
          <div className="grid grid-cols-2 gap-3">
            {field('Rated voltage', 'kv', sel(s.kv == null ? '' : String(s.kv), v => set('kv', num(v)), primaryOptions(s, 'kv').map(v => [String(v), `${v} kV`]), s.kv == null))}
            {field('Short-circuit breaking current', 'ka', sel(s.ka == null ? '' : String(s.ka), v => set('ka', num(v)), primaryOptions(s, 'ka').map(v => [String(v), `${v} kA`]), s.ka == null))}
            {field('Rated normal current', 'ir', sel(s.ir == null ? '' : String(s.ir), v => set('ir', num(v)), primaryOptions(s, 'ir').map(v => [String(v), `${v} A`]), s.ir == null))}
            {field('Pole-centre distance', 'pcd', sel(String(s.pcd ?? r.primary?.[6] ?? ''), v => set('pcd', num(v)), primaryOptions(s, 'pcd').map(v => [String(v), `${v} mm`])),
              'Follows the ratings; choose only where two are offered')}
          </div>
        </section>

        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600" title="HG 11.03 page 19: the 1st shunt release is always fitted">Releases (9th position)</h4>
          <div className="grid grid-cols-2 gap-3">
            {field('2nd release', 'rel2', sel(s.rel2, v => set('rel2', (v || 'none') as Release), SECOND_OPTIONS.map(o => [o, RELEASE_LABEL[o]])))}
            {field('3rd release', 'rel3', sel(s.rel3, v => set('rel3', (v || 'none') as Release), thirdOptions(s.rel2).map(o => [o, RELEASE_LABEL[o]])))}
          </div>
        </section>

        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600" title="HG 11.03 pages 20–24">Voltages (10th–14th position)</h4>
          <div className="grid grid-cols-2 gap-3">
            {field('Closing', 'closing', sel(s.closing, v => set('closing', (v || 'mech') as 'mech' | 'manual'),
              [['mech', 'Mechanical closing at the breaker'], ['manual', 'Manual electrical closing at the breaker']]))}
            {field('Closing solenoid voltage', 'vClose', voltSel('vClose'))}
            {field('1st shunt release voltage', 'vRel1', voltSel('vRel1'))}
            {takesVoltage(s.rel2) && field('2nd release voltage', 'vRel2', voltSel('vRel2'))}
            {takesVoltage(s.rel3) && field('3rd release voltage', 'vRel3', voltSel('vRel3'))}
            {field('Operating mechanism voltage', 'vMotor', voltSel('vMotor', [['manual', 'Manual (hand crank)']]))}
          </div>
        </section>

        <section className="border border-gray-200 rounded-md p-3 space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600" title="HG 11.03 pages 25–26">Interface and language (15th–16th position)</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              {field('Auxiliary switch / interface', 'aux', sel(s.aux ?? '', v => set('aux', v || null), AUX.map(a => [a[0], `${a[0]} — ${auxLabel(a)}`]), !s.aux))}
            </div>
            {field('Language', 'lang', sel(s.lang, v => set('lang', v || 'en'), Object.entries(LANGS).map(([k, l]) => [k, l[0]])))}
            {hasAc && field('AC frequency', 'freq', sel(s.freq, v => set('freq', (v || '50') as '50' | '60'), [['50', '50 Hz'], ['60', '60 Hz']]))}
          </div>
        </section>
      </div>

      {/* Additional equipment */}
      <section className="border border-gray-200 rounded-md">
        <button
          onClick={() => setShowExtras(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 text-sm text-gray-800 rounded-t-md"
          title="HG 11.03 pages 27–28"
        >
          {showExtras ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
          Additional equipment
          {s.extras.length > 0 && <span className="text-xs text-gray-600">{s.extras.join(' + ')}</span>}
        </button>
        {showExtras && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 p-3 max-h-72 overflow-auto">
            {AH3_EXTRAS.map(([c, l]) => (
              <label key={c} className="flex items-start gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={s.extras.includes(c)}
                  onChange={e => {
                    const v = e.target.checked;
                    setS(prev => ({
                      ...prev,
                      extras: v ? [...prev.extras, c] : prev.extras.filter(x => x !== c),
                      off: v ? (prev.off ?? []).filter(x => x !== c) : prev.off,
                    }));
                  }}
                  className="mt-0.5"
                />
                <span><span className="font-mono text-gray-900">{c}</span> {l}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      {(r.missing.length > 0 || r.notes.length > 0) && (
        <ul className="text-xs space-y-1">
          {r.missing.map(m => <li key={m} className="text-red-700">Missing: {m}</li>)}
          {r.notes.map(n => <li key={n} className="text-gray-700">{n}</li>)}
        </ul>
      )}
    </div>
  );
};
