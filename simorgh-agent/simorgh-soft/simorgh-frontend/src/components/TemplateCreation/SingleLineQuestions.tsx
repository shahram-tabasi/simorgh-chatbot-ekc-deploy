import React, { useState } from 'react';
import { CheckIcon, InfoIcon, PlusIcon, XIcon } from 'lucide-react';
import {
  CtCore, CtCorePurpose, DeviceAttachment, TemplateSingleLine,
} from '../../types/project';

// The questions a medium-voltage cell is asked so its single line comes out
// whole: what the parts in the template cannot say on their own.
//
// Every answer is optional. A question left on Auto is a key that is not
// there, and the drawing reads that as "work it out from the parts" — the
// switch from the breaker row, the CT's cores from whether there is a relay
// and meters to feed. So answering nothing draws what was drawn before the
// questions existed, and each answer changes exactly the part of the cell it
// is about. The template graphic above redraws as they are answered.

interface Props {
  value: TemplateSingleLine;
  onChange: (next: TemplateSingleLine) => void;
  /** EK36 or SIMOPRIME — the PT truck is a SIMOPRIME question. */
  family: 'EK36' | 'SIMOPRIME' | '';
}

const Pill: React.FC<{ on: boolean; label: string; onClick: () => void; tone?: 'blue' | 'gray' }> = ({
  on, label, onClick, tone = 'blue',
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-2 py-0.5 rounded-full border text-[11px] transition-colors ${
      on
        ? tone === 'blue' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-gray-600 border-gray-600 text-white'
        : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400'
    }`}
  >
    {on && <CheckIcon className="w-3 h-3 inline mr-0.5 -mt-0.5" />}{label}
  </button>
);

const Question: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div className="py-2 border-b border-gray-100 last:border-b-0">
    <p className="text-xs font-medium text-gray-700">{title}</p>
    {hint && <p className="text-[10.5px] text-gray-500">{hint}</p>}
    <div className="mt-1.5 space-y-1.5">{children}</div>
  </div>
);

const input = 'w-full min-w-0 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400';

const PURPOSES: { id: CtCorePurpose; label: string }[] = [
  { id: 'protection', label: 'Protection → relay' },
  { id: 'measurement', label: 'Measuring → meters' },
  { id: 'remark', label: 'Remark' },
];

const ATTACHMENTS: { kind: DeviceAttachment['kind']; label: string }[] = [
  { kind: 'serial', label: 'Serial' },
  { kind: 'link', label: 'Link' },
  { kind: 'status', label: 'Status' },
];

/** Serial, link, status and anything else hanging on a device. */
const Attachments: React.FC<{
  value: DeviceAttachment[] | undefined;
  onChange: (next: DeviceAttachment[] | undefined) => void;
}> = ({ value, onChange }) => {
  const list = value ?? [];
  const [other, setOther] = useState('');
  const set = (next: DeviceAttachment[]) => onChange(next.length ? next : undefined);
  const has = (kind: DeviceAttachment['kind']) => list.some(a => a.kind === kind);
  return (
    <>
      <div className="flex flex-wrap gap-1">
        {ATTACHMENTS.map(a => (
          <Pill key={a.kind} on={has(a.kind)} label={a.label}
            onClick={() => set(has(a.kind) ? list.filter(x => x.kind !== a.kind) : [...list, { kind: a.kind }])} />
        ))}
      </div>
      {list.filter(a => a.kind === 'other').map((a, n) => (
        <div key={`${a.text}-${n}`} className="flex items-center gap-1 text-[11px] text-gray-700">
          <span className="flex-1 truncate border border-gray-200 rounded px-2 py-0.5 bg-gray-50">{a.text}</span>
          <button type="button" title="Remove" onClick={() => set(list.filter(x => x !== a))}
            className="p-0.5 text-gray-400 hover:text-red-600"><XIcon className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input className={input} value={other} placeholder="Another, e.g. 94 / CR / 74 / 86"
          onChange={e => setOther(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && other.trim()) { set([...list, { kind: 'other', text: other.trim() }]); setOther(''); }
          }} />
        <button type="button" title="Add" disabled={!other.trim()}
          onClick={() => { set([...list, { kind: 'other', text: other.trim() }]); setOther(''); }}
          className="p-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-40">
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </>
  );
};

export const SingleLineQuestions: React.FC<Props> = ({ value, onChange, family }) => {
  // An answer is cleared by dropping its key — the drawing reads the absence
  // as "work it out from the parts".
  const set = <K extends keyof TemplateSingleLine>(key: K, v: TemplateSingleLine[K] | undefined) => {
    const next = { ...value };
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  const cores = value.ctCores ?? [];
  const setCore = (n: number, patch: Partial<CtCore>) =>
    set('ctCores', cores.map((c, k) => (k === n ? { ...c, ...patch } : c)));
  const setCoreCount = (count: number) =>
    set('ctCores', count === 0 ? undefined
      : Array.from({ length: count }, (_, k) => cores[k] ?? { purpose: k === 0 ? 'protection' : 'measurement' }));

  return (
    <div className="px-3 pb-3">
      <p className="flex items-start gap-1.5 text-[10.5px] text-gray-500 mb-1">
        <InfoIcon className="w-3.5 h-3.5 shrink-0 mt-px text-gray-400" />
        <span>Asked so the cell's single line comes out complete. Anything left on Auto
          is read from the parts; the graphic above redraws as you answer.</span>
      </p>

      <Question title="Main switch" hint="Drawn on the line, connections 1 and 2 in the main path.">
        <div className="flex flex-wrap gap-1">
          <Pill tone="gray" on={value.switchType === undefined} label="Auto" onClick={() => set('switchType', undefined)} />
          <Pill on={value.switchType === 'vcb'} label="Circuit breaker (VCB)" onClick={() => set('switchType', 'vcb')} />
          <Pill on={value.switchType === 'vc-fuse'} label="Contactor + fuse" onClick={() => set('switchType', 'vc-fuse')} />
          <Pill on={value.switchType === 'none'} label="None" onClick={() => set('switchType', 'none')} />
        </div>
      </Question>

      <Question title="Interlock with downstream"
        hint="Earth switch 3 → magnet 1, magnet 2 → the feeder below, its name written on the line.">
        <div className="flex flex-wrap gap-1">
          <Pill tone="gray" on={value.downstreamInterlock === undefined} label="Auto"
            onClick={() => set('downstreamInterlock', undefined)} />
          <Pill on={value.downstreamInterlock === true} label="Yes" onClick={() => set('downstreamInterlock', true)} />
          <Pill on={value.downstreamInterlock === false} label="No" onClick={() => set('downstreamInterlock', false)} />
        </div>
        {value.downstreamInterlock !== false && (
          <input className={input} value={value.downstreamText ?? ''} placeholder="OUTGOING FEEDER"
            onChange={e => set('downstreamText', e.target.value)} />
        )}
      </Question>

      <Question title="Interlock with upstream" hint="A key interlock on the breaker's line.">
        <div className="flex flex-wrap gap-1">
          <Pill on={value.upstreamInterlock === true} label="Yes" onClick={() => set('upstreamInterlock', true)} />
          <Pill on={value.upstreamInterlock !== true} label="No" onClick={() => set('upstreamInterlock', undefined)} />
        </div>
        {value.upstreamInterlock && (
          <input className={input} value={value.upstreamText ?? ''} placeholder="INCOMING FEEDER"
            onChange={e => set('upstreamText', e.target.value)} />
        )}
      </Question>

      <Question title="CT cores"
        hint={family === 'EK36'
          ? 'EK36: the CT comes after the earth switch. How many cores, and what is each for?'
          : 'How many cores, and what is each for?'}>
        <div className="flex items-center gap-1.5">
          <select className="border border-gray-300 rounded px-1.5 py-1 text-xs bg-white"
            value={cores.length} onChange={e => setCoreCount(Number(e.target.value))}>
            <option value={0}>Auto</option>
            {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} core{n > 1 ? 's' : ''}</option>)}
          </select>
          {cores.length === 0 && <span className="text-[10.5px] text-gray-500">a protection core if there is a relay, a measuring core if there are meters</span>}
        </div>
        {cores.map((core, n) => (
          <div key={n} className="flex items-center gap-1">
            <span className="text-[11px] text-gray-500 w-10 shrink-0">Core {n + 1}</span>
            <select className="border border-gray-300 rounded px-1.5 py-1 text-xs bg-white shrink-0"
              value={core.purpose} onChange={e => setCore(n, { purpose: e.target.value as CtCorePurpose })}>
              {PURPOSES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {core.purpose === 'remark' && (
              <input className={input} value={core.text ?? ''} placeholder="Written at the arrow"
                onChange={e => setCore(n, { text: e.target.value })} />
            )}
          </div>
        ))}
      </Question>

      <Question title="Protection relay">
        <div className="flex flex-wrap gap-1">
          <Pill on={value.relayMode !== 'functions'} label="Protection relay only"
            onClick={() => set('relayMode', undefined)} />
          <Pill on={value.relayMode === 'functions'} label="With its functions"
            onClick={() => set('relayMode', 'functions')} />
        </div>
        {value.relayMode === 'functions' && (
          <input className={input} value={value.relayFunctions ?? ''} placeholder="50, 50N, 51, 51N, 25, BCU"
            onChange={e => set('relayFunctions', e.target.value)} />
        )}
      </Question>

      <Question title="On the breaker" hint="Strung along the key interlock's line.">
        <Attachments value={value.breakerAttachments} onChange={v => set('breakerAttachments', v)} />
      </Question>

      <Question title="On the relay">
        <Attachments value={value.relayAttachments} onChange={v => set('relayAttachments', v)} />
      </Question>

      {family === 'SIMOPRIME' && (
        <Question title="Incoming with a PT truck"
          hint="The PT is then drawn after the breaker, on a socket — not as a switched device.">
          <div className="flex flex-wrap gap-1">
            <Pill on={value.ptTruck === true} label="Yes" onClick={() => set('ptTruck', true)} />
            <Pill on={value.ptTruck !== true} label="No" onClick={() => set('ptTruck', undefined)} />
          </div>
        </Question>
      )}
    </div>
  );
};
