// src/components/ProjectDefinition/BreakerCodeTab.tsx
//
// Breaker Code: the SION 3AE5 article number of a MV scope's breaker, worked
// out from the specification the project already carries.
//
// Pick a MV scope (and, if it has them, one of its feeders). The specification
// is written from the scope's ratings and the feeder's breaker part, decoded,
// and what it leaves open is asked — nothing else. The 16 positions read
// green when stated, amber when assumed, red while missing. Saved with the
// scope, so the code is still there next time.
import React, { useEffect, useMemo, useState } from 'react';
import { CopyIcon, ChevronDownIcon, ChevronRightIcon, RefreshCwIcon, FanIcon } from 'lucide-react';
import type { BreakerCodeRecord, DeviceLibraryItem, ProjectData } from '../../types/project';
import {
  evaluate, setField, confirm, toggleExtra, fieldOptions, EXTRAS, FIELD_LABEL, FORM_GROUPS,
  type SionState, type FieldStatus,
} from '../../utils/sion3ae5/engine';
import { specFromProject, equipmentOf, decodeDraft, scopeFamily, worldPanelFor } from '../../utils/sion3ae5/fromProject';
import { panelKindLabel } from '../../utils/sion3ae5/simoprimeWorld';
import { ROLE_LABEL, SOURCE_LABEL, HAS_BREAKER } from '../../utils/sion3ae5/cells';

interface Props {
  projectData: ProjectData;
  onSave: (item: DeviceLibraryItem, key: string, record: BreakerCodeRecord) => void;
  /** The scope with something of it changed (cell currents, many codes at once). */
  onUpdate: (item: DeviceLibraryItem) => void;
}

const TONE: Record<string, string> = {
  ok: 'border-green-600', amb: 'border-amber-500', miss: 'border-red-600 text-red-700', part: 'border-gray-400',
};
const DOT: Record<string, string> = {
  ok: 'bg-green-600', amb: 'bg-amber-500', miss: 'bg-red-600', conflict: 'bg-red-600',
};

export const BreakerCodeTab: React.FC<Props> = ({ projectData, onSave, onUpdate }) => {
  const scopes = useMemo(() => projectData.deviceLibrary?.MV ?? [], [projectData.deviceLibrary]);
  const [scopeId, setScopeId] = useState<string>(scopes[0]?.id ?? '');
  const [rowId, setRowId] = useState<string>('');
  const scope = scopes.find(s => s.id === scopeId) ?? null;
  const rows = useMemo(() => (scope ? equipmentOf(projectData, scope)?.devices ?? [] : []), [scope, projectData]);
  const row = rows.find(r => r.id === rowId);

  const draft = useMemo(() => (scope ? specFromProject(projectData, scope, row) : null), [scope, row, projectData]);
  // SIMOPRIME World: every cell's panel, straight from the design catalogue.
  const isWorld = !!scope && scopeFamily(scope, String((equipmentOf(projectData, scope)?.properties?.tpms as any)?.switchgearType ?? '')) === 'SIMOPRIME-WORLD';
  // …and each breaker cell's code as the rules and defaults give it, so the
  // whole switchgear is read at a glance and saved in one go.
  const panels = useMemo(() => {
    if (!isWorld || !scope) return [];
    return rows.map(r => {
      const panel = worldPanelFor(projectData, scope, r);
      let code: string | null = null;
      let open = 0;
      let rec: BreakerCodeRecord | null = null;
      if (panel.breaker) {
        const d = specFromProject(projectData, scope, r);
        const st = decodeDraft(d.text, d);
        const ev = evaluate(st);
        code = ev.code;
        open = ev.questions.length;
        rec = { spec: d.text, state: st, code, savedAt: '' };
      }
      return { row: r, panel, code, open, rec };
    });
  }, [isWorld, scope, rows, projectData]);

  const setCellCurrent = (id: string, raw: string) => {
    if (!scope) return;
    const v = parseFloat(raw);
    const next = { ...(scope.cellCurrents ?? {}) };
    if (Number.isFinite(v) && v > 0) next[id] = v; else delete next[id];
    onUpdate({ ...scope, cellCurrents: next });
  };
  const saveAll = () => {
    if (!scope) return;
    const now = new Date().toISOString();
    const codes = { ...(scope.breakerCodes ?? {}) };
    // A cell already saved keeps what the engineer saved for it.
    panels.forEach(c => { if (c.rec && !codes[c.row.id]) codes[c.row.id] = { ...c.rec, savedAt: now }; });
    onUpdate({ ...scope, breakerCodes: codes });
  };
  const saved = scope?.breakerCodes?.[rowId];

  const [spec, setSpec] = useState('');
  const [state, setState] = useState<SionState | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const [copied, setCopied] = useState('');

  // A new scope or feeder starts from what was saved for it, else from the
  // specification the project gives.
  useEffect(() => {
    if (!scope || !draft) { setSpec(''); setState(null); return; }
    if (saved) { setSpec(saved.spec); setState(saved.state as SionState); return; }
    setSpec(draft.text);
    setState(decodeDraft(draft.text, draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, rowId]);

  const result = useMemo(() => (state ? evaluate(state) : null), [state]);

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 1200);
  };

  if (scopes.length === 0) {
    return (
      <p className="text-sm text-gray-600 py-6" title="Add a scope under Medium Voltage in the Scope Library first">
        No Medium Voltage scope in this project yet.
      </p>
    );
  }

  const select = (field: string, id: string, status: FieldStatus) => {
    const value = (result?.state as any)?.[field];
    return (
      <select
        id={id}
        value={value == null ? '' : String(value)}
        onChange={e => setState(s => (s ? setField(s, field, e.target.value) : s))}
        className={`w-full border rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 ${
          status === 'miss' || status === 'conflict' ? 'border-red-400' : status === 'amb' ? 'border-amber-400' : 'border-gray-300'}`}
      >
        <option value="">Choose…</option>
        {state && fieldOptions(result!.state, field).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  };

  return (
    <div className="space-y-4">
      {/* What the code is for */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-600">
          <span className="block mb-1">Scope (Medium Voltage)</span>
          <select
            value={scopeId}
            onChange={e => { setScopeId(e.target.value); setRowId(''); }}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white min-w-[16rem] focus:outline-none focus:border-blue-500"
          >
            {scopes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">
          <span className="block mb-1">Breaker</span>
          <select
            value={rowId}
            onChange={e => setRowId(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white min-w-[16rem] focus:outline-none focus:border-blue-500"
          >
            <option value="">Switchgear (from the scope's ratings)</option>
            {rows.map(r => (
              <option key={r.id} value={r.id}>
                {[r.feederNo, r.templateName, (r as any).tag].filter(Boolean).join(' · ') || `Row ${r.rowNumber}`}
                {scope?.breakerCodes?.[r.id] ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => scope && draft && state && onSave(scope, rowId, {
            spec, state, code: result?.code ?? '', savedAt: new Date().toISOString(),
          })}
          disabled={!state}
          title={saved ? `Saved ${new Date(saved.savedAt).toLocaleString()}` : 'Keep this code with the scope'}
          className="ml-auto px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
        >
          Save
        </button>
      </div>

      {/* SIMOPRIME World: the panel of every cell */}
      {isWorld && panels.length > 0 && (
        <section className="border border-gray-200 rounded-md overflow-hidden">
          <header className="flex items-center gap-3 px-3 py-2 bg-gray-50 border-b border-gray-200">
            <h4 className="text-sm font-medium text-gray-800"
              title="SIMOPRIME World design catalogue (issue 23, 06/2026): table 3.7 picks the typical, width, ventilation and breaker from the cell's current at the design temperature and frequency; 2.2.3.3 withdrawable VTs; 2.2.2.9 mandatory order codes. Click a cell to open its code below.">
              Cells — SIMOPRIME World
            </h4>
            <span className="text-xs text-gray-600" title="Option points the catalogue leaves open: 1 shunt release, no 2nd or 3rd release, fixed-mounted breaker (W66), 12 NO + 12 NC, 64-pole plug, English — change any of them on a cell's code">
              Defaults: 1 shunt release · W66 fixed · 12 NO + 12 NC · 64-pole · English
            </span>
            <button
              onClick={saveAll}
              title="Keep every breaker cell's code with the scope — cells already saved keep theirs"
              className="ml-auto px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50"
            >
              Save all cells
            </button>
          </header>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 text-gray-700 sticky top-0 z-10">
                <tr>
                  {['Feeder', 'Template', 'Role', 'Current (A)', 'Typical', 'Width', 'Ventilation', 'W/d VT', 'Breaker code'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {panels.map(({ row: r, panel: p, code, open }) => (
                  <tr
                    key={r.id}
                    onClick={() => setRowId(r.id)}
                    title={p.notes.join('\n')}
                    className={`border-t border-gray-100 cursor-pointer ${r.id === rowId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  >
                    <td className="px-2 py-1 whitespace-nowrap text-gray-800">{r.feederNo || `Row ${r.rowNumber}`}{scope?.breakerCodes?.[r.id] ? ' ✓' : ''}</td>
                    <td className="px-2 py-1 text-gray-700 truncate max-w-[14rem]">{r.templateName}</td>
                    <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{p.role ? ROLE_LABEL[p.role] : '—'}</td>
                    <td className="px-2 py-1 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      {p.current?.value != null || HAS_BREAKER[p.role ?? 'outgoing'] ? (
                        <span className="inline-flex items-center gap-1.5">
                          <input
                            key={`${r.id}-${p.current?.value ?? ''}`}
                            defaultValue={p.current?.value ?? ''}
                            onBlur={e => { if (e.target.value !== String(p.current?.value ?? '')) setCellCurrent(r.id, e.target.value); }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            title="The current this cell has to carry — type to set it yourself, clear to go back to the rules"
                            className={`w-16 border rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:border-blue-500 ${
                              p.current?.uncertain ? 'border-amber-400' : 'border-gray-300'}`}
                          />
                          {p.current?.source && (
                            <span className={p.current.uncertain ? 'text-amber-800' : 'text-gray-500'} title={p.current.note}>
                              {SOURCE_LABEL[p.current.source]}
                            </span>
                          )}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{p.typicalA ? `${p.typicalA} A` : panelKindLabel(p.kind).replace(' panel', '')}</td>
                    <td className="px-2 py-1 text-gray-700">{p.width ?? '—'}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {p.ventilation === 'Without'
                        ? <span className="text-gray-500">Without</span>
                        : <span className="inline-flex items-center gap-1 font-semibold text-gray-900"><FanIcon className="w-3.5 h-3.5" />{p.ventilation}</span>}
                    </td>
                    <td className="px-2 py-1 text-gray-700">{p.withdrawableVT == null ? '—' : p.withdrawableVT ? 'Possible' : 'No'}</td>
                    <td className="px-2 py-1 font-mono whitespace-nowrap">
                      {code
                        ? <span className={open ? 'text-amber-800' : 'text-gray-900'} title={open ? `${open} point(s) still open` : 'Complete'}>{code}</span>
                        : HAS_BREAKER[p.role ?? 'outgoing'] ? <span className="text-red-700">?</span> : <span className="text-gray-500">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* The article number */}
      {result && (
        <div className="border border-gray-200 rounded-md bg-gray-50 px-4 py-3">
          <div className="flex items-end gap-[3px] overflow-x-auto pb-1">
            {Array.from({ length: 16 }, (_, k) => k + 1).map(i => (
              <React.Fragment key={i}>
                {(i === 8 || i === 13) && <span className="w-3 text-center font-mono text-xl text-gray-500 pb-1">–</span>}
                <span className="w-8 text-center shrink-0">
                  <span className="block text-[10px] text-gray-500">{i}</span>
                  <span className={`block h-10 leading-10 font-mono text-xl font-semibold bg-white border border-gray-200 border-b-4 rounded-t ${TONE[result.pos[i].s]}`}>
                    {result.pos[i].c}
                  </span>
                </span>
              </React.Fragment>
            ))}
            {result.codes.length > 0 && (
              <span className="flex items-end gap-1.5 ml-2 shrink-0">
                <span className="font-mono text-xl text-gray-500 pb-1">-Z</span>
                {result.codes.map(c => (
                  <span key={c} className="font-mono text-sm font-semibold px-1.5 py-1 mb-1 rounded bg-gray-100 border border-gray-200 text-gray-800">{c}</span>
                ))}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
            <span className="font-mono text-sm text-gray-900 select-all">{result.code}</span>
            <button
              onClick={() => copy(result.code, 'code')}
              className="flex items-center gap-1 px-2 py-1 border border-gray-300 bg-white text-gray-700 rounded hover:bg-gray-50"
            >
              <CopyIcon className="w-3.5 h-3.5" /> {copied === 'code' ? 'Copied' : 'Copy'}
            </button>
            {draft?.world && (
              <span className="text-gray-700" title={draft.world.notes.join('\n')}>
                {draft.world.width ? `${draft.world.width} mm panel` : ''}
                {draft.world.ventilation !== 'Without' ? ` · ${draft.world.ventilation.toLowerCase()} ventilation` : ''}
                {draft.world.notes.length ? ` · ${draft.world.notes.length} note${draft.world.notes.length > 1 ? 's' : ''}` : ''}
              </span>
            )}
            <span className="ml-auto" title="Green: read from the text or chosen · amber: assumed, please confirm · red: missing">
              <b className="text-red-700">{result.questions.filter(q => q.status !== 'amb').length}</b> missing ·{' '}
              <b className="text-amber-800">{result.questions.filter(q => q.status === 'amb').length}</b> to confirm ·{' '}
              {result.primary ? <span className="font-mono">{result.primary[0]}</span> : `${result.candidates} primary types match`}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          {/* Specification */}
          <section className="border border-gray-200 rounded-md">
            <header className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
              <h4 className="text-sm font-medium text-gray-800" title="English text, as in a datasheet or tender — written from the scope's specification and the feeder's breaker part">
                Specification
              </h4>
              <button
                onClick={() => { if (draft) { setSpec(draft.text); setState(decodeDraft(draft.text, draft)); } }}
                title="Write the text again from the project's specification"
                className="ml-auto flex items-center gap-1 px-2 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50"
              >
                <RefreshCwIcon className="w-3.5 h-3.5" /> From project
              </button>
              <button
                onClick={() => setState(decodeDraft(spec, { assumed: [], panel: draft?.panel ?? null }))}
                className="px-2 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50"
              >
                Decode
              </button>
            </header>
            <textarea
              value={spec}
              onChange={e => setSpec(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 font-mono text-[13px] bg-white border-0 rounded-b-md focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            />
            {draft && draft.notes.length > 0 && !saved && (
              <p className="px-3 pb-2 text-xs text-gray-600">{draft.notes.join(' ')}</p>
            )}
          </section>

          {/* Questions */}
          {result && (
            <section className="border border-gray-200 rounded-md">
              <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                <h4 className="text-sm font-medium text-gray-800" title="Only what the specification left open">Questions</h4>
              </header>
              <div className="p-3 space-y-2">
                {result.questions.length === 0 && (
                  <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                    Nothing left to answer — the article number is complete.
                  </p>
                )}
                {result.questions.map(q => (
                  <div
                    key={q.field}
                    className={`border-l-4 rounded-r px-3 py-2 ${q.status === 'amb' ? 'border-amber-500 bg-amber-50' : 'border-red-600 bg-red-50'}`}
                  >
                    <label htmlFor={`q_${q.field}`} className="block text-sm font-medium text-gray-900" title={q.why}>{q.label}</label>
                    {q.status === 'conflict' && <p className="text-xs text-red-700 mb-1">{q.why}</p>}
                    <div className="flex gap-2 mt-1">
                      {select(q.field, `q_${q.field}`, q.status)}
                      {q.status === 'amb' && (
                        <button
                          onClick={() => setState(s => (s ? confirm(s, q.field) : s))}
                          className="px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 shrink-0"
                        >
                          Confirm
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Description and checks */}
          {result && (
            <section className="border border-gray-200 rounded-md">
              <header className="flex items-center px-3 py-2 bg-gray-50 border-b border-gray-200">
                <h4 className="text-sm font-medium text-gray-800">Description</h4>
                <button
                  onClick={() => copy(result.description, 'desc')}
                  className="ml-auto flex items-center gap-1 px-2 py-1 border border-gray-300 bg-white text-gray-700 rounded text-xs hover:bg-gray-50"
                >
                  <CopyIcon className="w-3.5 h-3.5" /> {copied === 'desc' ? 'Copied' : 'Copy'}
                </button>
              </header>
              <pre className="px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap font-sans">{result.description}</pre>
              {(result.notes.length > 0 || (draft?.world?.notes.length ?? 0) > 0) && (
                <ul className="px-3 pb-3 space-y-1 text-xs list-disc list-inside">
                  {[...(draft?.world?.notes ?? []).map(text => ({ text, warn: /confirm|No 3AE5|above/.test(text) })), ...result.notes].map((n, i) => (
                    <li key={i} className={n.warn ? 'text-red-700' : 'text-gray-600'}>{n.text}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* Every parameter */}
        {result && (
          <section className="border border-gray-200 rounded-md self-start">
            <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
              <h4 className="text-sm font-medium text-gray-800" title="Everything that makes up the code — change anything here">All parameters</h4>
            </header>
            <div className="p-3 space-y-4">
              {FORM_GROUPS.map(g => {
                // A field the code needs, and the insulating shell always — as the builder shows it.
                const fields = g.fields.filter(f => result.status[f] != null || f === 'shell');
                return (
                  <fieldset key={g.label}>
                    <legend className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">{g.label}</legend>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2">
                      {fields.map(f => (
                        <div key={f}>
                          <label htmlFor={`f_${f}`} className="flex items-center gap-1.5 text-xs text-gray-600 mb-0.5">
                            <i className={`w-2 h-2 rounded-full ${DOT[result.status[f] ?? ''] ?? 'bg-gray-300'}`} />
                            {FIELD_LABEL[f]}
                          </label>
                          {select(f, `f_${f}`, result.status[f])}
                        </div>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
              <div>
                <button
                  onClick={() => setShowExtras(v => !v)}
                  className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                >
                  {showExtras ? <ChevronDownIcon className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
                  Additional order codes ({result.state.extras.length})
                </button>
                {showExtras && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
                    {EXTRAS.map(([c, l]) => (
                      <label key={c} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={result.state.extras.includes(c)}
                          onChange={e => setState(s => (s ? toggleExtra(s, c, e.target.checked) : s))}
                        />
                        <span><code className="font-mono font-semibold">{c}</code> {l}</span>
                      </label>
                    ))}
                    <label className="sm:col-span-2 mt-2 block">
                      <span className="block text-gray-600 mb-0.5">Other order codes (e.g. Y99, B99)</span>
                      <input
                        value={result.state.custom}
                        onChange={e => setState(s => (s ? { ...s, custom: e.target.value } : s))}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default BreakerCodeTab;
