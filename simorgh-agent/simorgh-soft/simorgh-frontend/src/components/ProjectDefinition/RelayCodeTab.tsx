// src/components/ProjectDefinition/RelayCodeTab.tsx
//
// Relay Code: the order codes of the project's SIPROTEC 5 relays, kept with
// the project so they are there offline.
//
//   * 7SX800 (SIPROTEC 5 Compact) is built here, position by position, from
//     Siemens' own selection and ordering table (utils/siprotec/sx800.ts) —
//     the code is exact because the table is.
//   * The modular devices (7SJ82/85, 7SK8x, 7UT8x, 7SA8x …) take a product
//     code that only Siemens' online configurator makes; it is copied in
//     from there, once, and kept — so the next time, offline, it is found.
import React, { useMemo, useState } from 'react';
import { CopyIcon, Trash2Icon, PencilIcon } from 'lucide-react';
import type { ProjectData, RelayCodeRecord } from '../../types/project';
import { SX800_POSITIONS, SX800_DEFAULT, sx800Code, sx800Decode } from '../../utils/siprotec/sx800';

interface Props {
  projectData: ProjectData;
  onChange: (codes: RelayCodeRecord[]) => void;
}

const newId = () => `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const copy = (text: string) => { void navigator.clipboard?.writeText(text); };

const inputCls = 'border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

export const RelayCodeTab: React.FC<Props> = ({ projectData, onChange }) => {
  const codes = useMemo(() => projectData.relayCodes ?? [], [projectData.relayCodes]);

  // ── The 7SX800, from the catalogue table ──────────────────────────────
  const [choices, setChoices] = useState<Record<string, string>>(SX800_DEFAULT);
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const code = sx800Code(choices);

  const saveSx = () => {
    if (!code) return;
    const rec: RelayCodeRecord = {
      id: editing ?? newId(), tag: tag.trim(), device: '7SX800', code, source: 'catalogue',
      choices, note: note.trim() || undefined, savedAt: new Date().toISOString(),
    };
    onChange(editing ? codes.map(c => (c.id === editing ? rec : c)) : [...codes, rec]);
    setEditing(null); setTag(''); setNote('');
  };

  // ── A code from Siemens' online configurator ──────────────────────────
  const [cTag, setCTag] = useState('');
  const [cDevice, setCDevice] = useState('');
  const [cCode, setCCode] = useState('');
  const [cNote, setCNote] = useState('');
  const pastedSx = sx800Decode(cCode);
  const saveConfigurator = () => {
    const c = cCode.trim();
    if (!c) return;
    const device = cDevice.trim() || (/^(7[A-Z]{2}\d{2,3})/i.exec(c)?.[1]?.toUpperCase() ?? '');
    onChange([...codes, {
      id: newId(), tag: cTag.trim(), device, code: c,
      source: pastedSx ? 'catalogue' : 'configurator',
      choices: pastedSx ?? undefined, note: cNote.trim() || undefined, savedAt: new Date().toISOString(),
    }]);
    setCTag(''); setCDevice(''); setCCode(''); setCNote('');
  };

  const [filter, setFilter] = useState('');
  const shown = codes.filter(c => [c.tag, c.device, c.code, c.note ?? ''].join(' ').toLowerCase()
    .includes(filter.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* 7SX800 builder */}
        <section className="border border-gray-200 rounded-md bg-white">
          <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
            <h4 className="text-sm font-medium text-gray-800">SIPROTEC 5 Compact 7SX800 — order number</h4>
            <p className="text-xs text-gray-500">From Siemens' selection and ordering table (Compact catalogue, Table 5.1/1)</p>
          </header>
          <div className="p-3 space-y-3">
            {SX800_POSITIONS.map(p => (
              <fieldset key={p.key}>
                <legend className="text-xs font-semibold text-gray-700 mb-1">
                  {p.title} <span className="font-normal text-gray-500">· position {p.pos}</span>
                </legend>
                <div className="space-y-1">
                  {p.options.map(o => (
                    <label key={o.code} className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
                      <input type="radio" name={`sx-${p.key}`} className="mt-1"
                        checked={choices[p.key] === o.code}
                        onChange={() => setChoices(c => ({ ...c, [p.key]: o.code }))} />
                      <span>
                        <span className="font-mono text-gray-600 mr-1.5">{o.code}</span>{o.label}
                        {o.detail && <span className="block text-xs text-gray-500">{o.detail}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}

            <div className="flex items-center gap-2 pt-2 border-t border-gray-200">
              <span className="text-xs text-gray-600">Order no.</span>
              <span className="font-mono text-base font-semibold text-gray-900 tracking-wide">{code ?? '—'}</span>
              {code && (
                <button onClick={() => copy(code)} title="Copy the order number"
                  className="p-1 rounded text-gray-500 hover:bg-gray-100"><CopyIcon className="w-4 h-4" /></button>
              )}
            </div>
            <p className="text-xs text-gray-500">
              Function points are ordered apart, with the account number from Siemens' function-point manager (7XX8152-1AA…).
            </p>

            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-gray-600">
                <span className="block mb-1">Tag / where it goes</span>
                <input value={tag} onChange={e => setTag(e.target.value)} placeholder="e.g. Feeder F03" className={`${inputCls} w-44`} />
              </label>
              <label className="text-xs text-gray-600 flex-1 min-w-[10rem]">
                <span className="block mb-1">Note</span>
                <input value={note} onChange={e => setNote(e.target.value)} className={`${inputCls} w-full`} />
              </label>
              {editing && (
                <button onClick={() => { setEditing(null); setTag(''); setNote(''); }}
                  className="px-3 py-2 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50">Cancel</button>
              )}
              <button onClick={saveSx} disabled={!code}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50">
                {editing ? 'Save changes' : 'Save to project'}
              </button>
            </div>
          </div>
        </section>

        {/* From the online configurator */}
        <section className="border border-gray-200 rounded-md bg-white">
          <header className="px-3 py-2 bg-gray-50 border-b border-gray-200">
            <h4 className="text-sm font-medium text-gray-800">From Siemens' SIPROTEC 5 configurator</h4>
            <p className="text-xs text-gray-500">
              7SJ82/85, 7SK8x, 7UT8x, 7SA8x and the other modular devices: their product code is made only by the online
              configurator. Copy it here once — it stays with the project, offline.
            </p>
          </header>
          <div className="p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-600">
                <span className="block mb-1">Tag / where it goes</span>
                <input value={cTag} onChange={e => setCTag(e.target.value)} className={`${inputCls} w-full`} />
              </label>
              <label className="text-xs text-gray-600">
                <span className="block mb-1">Device</span>
                <input value={cDevice} onChange={e => setCDevice(e.target.value)} placeholder="from the code if empty"
                  className={`${inputCls} w-full`} />
              </label>
            </div>
            <label className="text-xs text-gray-600 block">
              <span className="block mb-1">Product code / order number</span>
              <input value={cCode} onChange={e => setCCode(e.target.value)} placeholder="e.g. 7SJ85-DAAA-AA0-0AAAA0-…"
                className={`${inputCls} w-full font-mono`} />
            </label>
            {pastedSx && (
              <p className="text-xs text-gray-600">
                A 7SX800 number: {SX800_POSITIONS.map(p => p.options.find(o => o.code === pastedSx[p.key])?.label).join(' · ')}
              </p>
            )}
            <label className="text-xs text-gray-600 block">
              <span className="block mb-1">Note — what it was configured for</span>
              <textarea value={cNote} onChange={e => setCNote(e.target.value)} rows={2}
                placeholder="e.g. motor feeder, 11 BI / 9 BO, IEC 61850, firmware V9.90"
                className={`${inputCls} w-full`} />
            </label>
            <div className="flex justify-end">
              <button onClick={saveConfigurator} disabled={!cCode.trim()}
                className="px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50">
                Add to project
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* What the project has */}
      <section className="border border-gray-200 rounded-md bg-white overflow-hidden">
        <header className="flex items-center gap-3 px-3 py-2 bg-gray-50 border-b border-gray-200">
          <h4 className="text-sm font-medium text-gray-800">Relay codes of this project</h4>
          <span className="text-xs text-gray-500">{codes.length}</span>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search…"
            className={`${inputCls} ml-auto w-56 py-1`} />
        </header>
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-500">{codes.length ? 'Nothing matches.' : 'No relay codes yet.'}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-100 text-gray-700">
              <tr>
                {['Tag', 'Device', 'Order no. / product code', 'From', 'Note', ''].map(h => (
                  <th key={h} className="px-3 py-1.5 text-left font-medium text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 text-gray-800">{c.tag || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-800">{c.device || '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-900">{c.code}</td>
                  <td className="px-3 py-1.5 text-gray-600 text-xs">{c.source === 'catalogue' ? 'Catalogue table' : 'Online configurator'}</td>
                  <td className="px-3 py-1.5 text-gray-600 text-xs max-w-[18rem] truncate" title={c.note}>{c.note}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-right">
                    <button onClick={() => copy(c.code)} title="Copy" className="p-1 rounded text-gray-500 hover:bg-gray-100">
                      <CopyIcon className="w-3.5 h-3.5" />
                    </button>
                    {c.device === '7SX800' && c.choices && (
                      <button title="Open in the 7SX800 builder" className="p-1 rounded text-gray-500 hover:bg-gray-100"
                        onClick={() => { setChoices(c.choices!); setTag(c.tag); setNote(c.note ?? ''); setEditing(c.id); }}>
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button title="Remove" className="p-1 rounded text-gray-500 hover:bg-gray-100"
                      onClick={() => onChange(codes.filter(x => x.id !== c.id))}>
                      <Trash2Icon className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
