import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CheckIcon, XIcon, InfoIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { PartSingleLine, CtCore, CtCorePurpose, SignalDir } from '../../types/project';
import { IEC_SYMBOLS, SYMBOL_GROUPS, SymbolId } from '../../utils/iecSymbols';
import { breakLabel, symbolForPart, coresFromText } from '../../utils/eplanSingleLine';
import { partCode } from '../../utils/eplanDataExport';
import { stripLocaleTags } from '../../utils/tierEquipmentMatrix';
import { type Tier } from '../../utils/tiers';
import {
  loadOfficeSymbols, officeSymbols, officeVersion, onOfficeSymbols,
} from '../../utils/cad/officeSymbols';
import { drawIecSymbol, symbolHeight, symbolLeft, symbolRight, OFFICE_PREFIX } from '../../utils/iecSymbols';

// One part's own questions for the single line.
//
// Opened when a part is entered — so the drawing is told what the part is
// while the person who picked it still knows — and again from the part's
// edit button whenever an answer has to change. Only the questions that
// matter for this part are asked: whether a second part in a row is an
// accessory or a device of its own, whether a device sits on the line or
// beside it, and for a relay whether it is the main one the CTs go into or an
// auxiliary one, and what that one is wired to.
//
// Every answer can be left on Auto, which is the drawing reading the part the
// way it always has. Skip changes nothing.

interface Props {
  part: any;
  slot: string;
  /** The row's name as the table shows it. */
  slotTitle: string;
  /** Where the part is in its row: 0 is the row's device. */
  index: number;
  tier: Tier;
  /** The row's first part, which an accessory is written under. */
  host?: any;
  /** Opened because the part was just entered (rather than to edit). */
  fresh: boolean;
  /** The part drawn just above this one — what series and parallel are
   *  told relative to. */
  above?: string;
  /** The template's other parts, by key (`slot#index`): what an auxiliary
   *  relay can be wired to besides the breaker and the main relay. */
  others?: { key: string; label: string }[];
  /** EK36 or SIMOPRIME — the PT truck is a SIMOPRIME question. */
  family?: 'EK36' | 'SIMOPRIME' | '';
  /** `simTable` is the SIM-TABLE typed here, or undefined to keep the
   *  part's own (its order number / designation). */
  onSave: (answers: PartSingleLine, symbolId: string | undefined, simTable: string | undefined) => void;
  onClose: () => void;
}

const RELAYS: SymbolId[] = ['protection-relay', 'earth-fault-relay'];
/** Measuring devices: they get a serial link and statuses too. */
const METERS: SymbolId[] = [
  'ammeter', 'voltmeter', 'multimeter', 'watt-meter', 'var-meter', 'power-factor-meter',
  'frequency-meter', 'hour-meter', 'kwh-meter', 'kvarh-meter', 'transducer',
];
const CORE_PURPOSES: { id: CtCorePurpose; label: string }[] = [
  { id: 'protection', label: 'Protection → relay' },
  { id: 'measurement', label: 'Measuring → meters' },
  { id: 'remark', label: 'Remark (arrow + text)' },
];
/** The breaker of the cell: the interlocks and the boxes beside it. */
const BREAKERS: SymbolId[] = ['vcb', 'vcb-racking', 'withdrawable-cb', 'vacuum-contactor-fuse', 'circuit-breaker'];
const SWITCHES: SymbolId[] = [
  'vcb', 'vcb-racking', 'withdrawable-cb', 'vacuum-contactor-fuse', 'circuit-breaker',
  'contactor', 'disconnector', 'switch-disconnector', 'mcb', 'motor-starter',
];

const input = 'w-full min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400';

/**
 * Which way a signal's arrow points at the foot of the cell: down, a signal
 * going out; up, one coming in.
 */
const DirToggle: React.FC<{ value: SignalDir | undefined; onChange: (next: SignalDir | undefined) => void }> = ({
  value, onChange,
}) => (
  <span className="inline-flex shrink-0 rounded border border-gray-300 overflow-hidden" title="Which way its arrow points">
    {(['down', 'up'] as const).map(d => {
      const on = (value ?? 'down') === d;
      return (
        <button key={d} type="button" onClick={() => onChange(d === 'down' ? undefined : d)}
          title={d === 'down' ? 'Arrow down — going out' : 'Arrow up — coming in'}
          className={`px-1.5 py-1 text-xs leading-none ${on ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}>
          {d === 'down' ? '↓' : '↑'}
        </button>
      );
    })}
  </span>
);

/** A list of status texts: each one a dashed line to the foot of the cell. */
const StatusList: React.FC<{
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  hint: string;
  label?: string;
  /** Each one's arrow, by position — given, a ↓/↑ beside each. */
  dirs?: SignalDir[];
  onDirs?: (next: SignalDir[] | undefined) => void;
}> = ({ value, onChange, hint, label = 'Status', dirs, onDirs }) => {
  const list = value ?? [];
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  const setDirs = (next: SignalDir[]) => onDirs?.(next.some(d => d === 'up') ? next : undefined);
  const dirAt = (k: number): SignalDir => dirs?.[k] ?? 'down';
  return (
    <div className="w-full space-y-1.5">
      {list.map((t, k) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-500 w-14 shrink-0">{label} {k + 1}</span>
          <input className={input} value={t} placeholder={hint}
            onChange={e => set(list.map((x, i) => (i === k ? e.target.value : x)))} />
          {onDirs && (
            <DirToggle value={dirAt(k)}
              onChange={d => setDirs(list.map((_, i) => (i === k ? d ?? 'down' : dirAt(i))))} />
          )}
          <button type="button" title="Remove" onClick={() => {
            set(list.filter((_, i) => i !== k));
            if (onDirs) setDirs(list.map((_, i) => dirAt(i)).filter((_, i) => i !== k));
          }}
            className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, ''])}
        className="flex items-center gap-1 px-2 py-1 rounded border border-dashed border-gray-300 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-700">
        <PlusIcon className="w-3.5 h-3.5" /> Add {label === 'Status' ? 'a status' : `a ${label.toLowerCase()}`}
      </button>
    </div>
  );
};
const INSTRUMENT_IDS: SymbolId[] = [
  'test-block', 'ammeter', 'ampere-selector', 'multimeter', 'watt-meter', 'var-meter',
  'power-factor-meter', 'kwh-meter', 'kvarh-meter', 'transducer', 'protection-relay',
  'earth-fault-relay', 'voltmeter', 'voltage-selector', 'frequency-meter', 'hour-meter',
  'alarm-annunciator', 'lamp', 'ptc', 'lcs',
];
const BESIDE_IDS: SymbolId[] = [
  'earthing-switch', 'magnet', 'capacitive-divider', 'surge-arrester', 'surge-limiter',
];

const Choice: React.FC<{
  on: boolean; title: string; note?: string; onClick: () => void;
}> = ({ on, title, note, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex-1 min-w-[120px] text-left rounded-lg border px-3 py-2 transition-colors ${
      on ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-gray-300 bg-white hover:border-blue-400'}`}
  >
    <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
      <span className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
        on ? 'bg-blue-600 border-blue-600' : 'border-gray-400'}`}>
        {on && <CheckIcon className="w-2.5 h-2.5 text-white" />}
      </span>
      {title}
    </span>
    {note && <span className="block mt-0.5 text-[11px] text-gray-500 leading-snug">{note}</span>}
  </button>
);

/** One of several that can be ticked together. */
const Check: React.FC<{ on: boolean; title: string; onClick: () => void }> = ({ on, title, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
      on ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600 text-gray-800' : 'border-gray-300 bg-white text-gray-700 hover:border-blue-400'}`}
  >
    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
      on ? 'bg-blue-600 border-blue-600' : 'border-gray-400'}`}>
      {on && <CheckIcon className="w-2.5 h-2.5 text-white" />}
    </span>
    {title}
  </button>
);

const Question: React.FC<{ n: number; title: string; children: React.ReactNode }> = ({ n, title, children }) => (
  <div>
    <p className="text-sm font-semibold text-gray-800 mb-1.5">
      <span className="inline-flex w-5 h-5 mr-1.5 rounded-full bg-gray-100 text-gray-600 text-[11px] items-center justify-center">{n}</span>
      {title}
    </p>
    <div className="flex flex-wrap gap-2">{children}</div>
  </div>
);

export const PartQuestionsDialog: React.FC<Props> = ({
  part, slot, slotTitle, index, tier, host, fresh, above, others, family, onSave, onClose,
}) => {
  const [answers, setAnswers] = useState<PartSingleLine>({ ...(part?.sld ?? {}) });
  const [symbolId, setSymbolId] = useState<string>(String(part?.symbolId ?? ''));
  // The office's new symbols, any of which can be what this part is drawn
  // with — read once, and the list redraws when it lands.
  useSyncExternalStore(onOfficeSymbols, officeVersion, officeVersion);
  useEffect(() => { loadOfficeSymbols().catch(() => undefined); }, []);
  const newSymbols = officeSymbols().filter(o => o.kind === 'sld');

  const auto = useMemo(
    () => symbolForPart({ ...part, symbolId: undefined }, slot, undefined, tier, slotTitle).id,
    [part, slot, tier, slotTitle]);
  const effective = (symbolId || auto) as SymbolId;

  const set = <K extends keyof PartSingleLine>(key: K, value: PartSingleLine[K] | undefined) =>
    setAnswers(prev => {
      const next = { ...prev };
      if (value === undefined) delete next[key]; else next[key] = value;
      return next;
    });

  const label = stripLocaleTags(part?.label) || '';
  // The SIM-TABLE as the part gives it, and as typed here.
  const ownCode = partCode({ ...part, simTableOverride: undefined });
  const [simTable, setSimTable] = useState<string>(partCode(part));
  const code = simTable.trim();
  const isSwitch = SWITCHES.includes(effective);
  const isMeter = METERS.includes(effective);
  const isCt = effective === 'current-transformer';
  // A CT's cores: its window's own, else what its SIM-TABLE says.
  const cores: CtCore[] = answers.cores ?? coresFromText(code);
  const setCores = (next: CtCore[]) => set('cores', next.length ? next : undefined);
  const asksRole = index > 0;
  const isAccessory = asksRole ? answers.role !== 'main' : answers.role === 'accessory';
  const isRelay = RELAYS.includes(effective);
  const isBreaker = BREAKERS.includes(effective);
  // The magnet by its kind, or by what its row or the part is called.
  const isMagnet = effective === 'magnet' || /magnet|\bMB\d*\b/i.test(`${slotTitle} ${stripLocaleTags(part?.label) || ''}`);
  const isVt = effective === 'voltage-transformer';
  // What an auxiliary relay is wired to: its list, else the older one-answer.
  const connects: string[] = answers.connects
    ?? (answers.relayConnect === 'both' ? ['breaker', 'relay']
      : answers.relayConnect ? [answers.relayConnect] : ['relay']);
  const toggleConnect = (key: string) => {
    const next = connects.includes(key) ? connects.filter(k => k !== key) : [...connects, key];
    setAnswers(prev => {
      const out = { ...prev, connects: next };
      delete out.relayConnect;
      return out;
    });
  };
  const ownKey = `${slot}#${index}`;
  const aboveName = above || 'the part above';
  const naturally = INSTRUMENT_IDS.includes(effective) || BESIDE_IDS.includes(effective)
    ? 'beside the line' : 'on the line';

  // What the sheet will write for it, broken the way the sheet breaks it.
  const hostText = host
    ? `${stripLocaleTags(host?.label) || '—'} : ${partCode(host)}` : '';
  const preview = isAccessory && host
    ? [...breakLabel(hostText), ...breakLabel(code)]
    : breakLabel(code ? `${label || '—'} : ${code}` : (label || '—'));
  const previewAccessoryFrom = isAccessory && host ? breakLabel(hostText).length : Infinity;

  let n = 0;
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[94vw] max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="bg-blue-600 text-white px-5 py-3 rounded-t-lg flex justify-between items-start gap-3">
          <div className="min-w-0">
            <p className="text-xs text-blue-100">{slotTitle}{index > 0 ? ` · part ${index + 1} of the row` : ''}</p>
            <h3 className="text-base font-semibold truncate" title={`${label} : ${code}`}>
              {label || 'Part'}{code ? ` : ${code}` : ''}
            </h3>
            <p className="text-xs text-blue-100">
              {fresh ? 'Just entered — how should the single line draw it?' : 'Single-line questions for this part'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-blue-700" title="Close">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <Question n={++n} title="SIM-TABLE">
            <input className={input} value={simTable} placeholder={ownCode || 'SIM-TABLE'}
              onChange={e => setSimTable(e.target.value)} />
            {simTable.trim() !== ownCode && ownCode && (
              <button type="button" onClick={() => setSimTable(ownCode)}
                className="text-[11px] text-blue-700 hover:underline">Back to the part’s own: {ownCode}</button>
            )}
          </Question>

          {asksRole && (
            <Question n={++n} title="Is it an accessory of the scope above, or a scope of its own?">
              <Choice on={isAccessory} title="Accessory"
                note={`Not drawn; only its SIM-TABLE is written, under ${host ? `${stripLocaleTags(host?.label) || 'the row'}'s` : 'the row’s'}.`}
                onClick={() => set('role', undefined)} />
              <Choice on={!isAccessory} title="Main scope"
                note="Drawn as a scope of its own, with its own label."
                onClick={() => set('role', 'main')} />
            </Question>
          )}

          {!isAccessory && (
            <>
              <Question n={++n} title="Symbol">
                <select
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={symbolId}
                  onChange={e => setSymbolId(e.target.value)}
                >
                  <option value="">Automatic — {IEC_SYMBOLS[auto]?.title ?? auto}</option>
                  {SYMBOL_GROUPS.map(group => (
                    <optgroup key={group} label={group}>
                      {Object.values(IEC_SYMBOLS).filter(sym => sym.group === group)
                        .map(sym => <option key={sym.id} value={sym.id}>{sym.title}</option>)}
                    </optgroup>
                  ))}
                </select>
              </Question>

              <Question n={++n} title="Drawing">
                <select
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={answers.drawing ?? ''}
                  onChange={e => set('drawing', e.target.value || undefined)}
                >
                  <option value="">The library’s drawing of {IEC_SYMBOLS[effective]?.title ?? 'its kind'}</option>
                  {newSymbols.length > 0 && (
                    <optgroup label="New symbols">
                      {newSymbols.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </optgroup>
                  )}
                </select>
                {answers.drawing && (() => {
                  const key = `${OFFICE_PREFIX}${answers.drawing}`;
                  const w = symbolLeft(key) + symbolRight(key);
                  const h = symbolHeight(key);
                  return (
                    <div className="w-full flex items-center gap-2">
                      <span className="w-14 h-14 border border-gray-200 rounded bg-white flex items-center justify-center shrink-0">
                        <svg width="48" height="48" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet"
                          dangerouslySetInnerHTML={{ __html: drawIecSymbol(key as any, symbolLeft(key), 0) }} />
                      </span>
                      <span className="text-[11px] text-gray-500">
                        Drawn with this symbol and its own connection points; still connected as a {IEC_SYMBOLS[effective]?.title ?? 'device'}.
                      </span>
                    </div>
                  );
                })()}
                {newSymbols.length === 0 && (
                  <p className="w-full text-[11px] text-gray-500">No new symbols in the library yet — make one with “New symbol”.</p>
                )}
              </Question>

              <Question n={++n} title={`Series or parallel with ${aboveName}?`}>
                <Choice on={!answers.placement} title="Auto" note={`As its kind is drawn: ${naturally}.`}
                  onClick={() => set('placement', undefined)} />
                <Choice on={answers.placement === 'series'} title="Series"
                  note={`After ${aboveName}, in line with it — connected on from it.`}
                  onClick={() => set('placement', 'series')} />
                <Choice on={answers.placement === 'parallel'} title="Parallel"
                  note={`Branched off before ${aboveName}, standing beside it.`}
                  onClick={() => set('placement', 'parallel')} />
              </Question>

              {isRelay && (
                <Question n={++n} title="Main relay or auxiliary relay?">
                  <Choice on={answers.relayRole !== 'auxiliary'} title="Main relay"
                    note="The CTs, the core-balance CT and the test block go into it."
                    onClick={() => { set('relayRole', 'main'); set('relayConnect', undefined); set('connects', undefined); }} />
                  <Choice on={answers.relayRole === 'auxiliary'} title="Auxiliary relay"
                    note="Wired to the breaker, the main relay, or any other part."
                    onClick={() => set('relayRole', 'auxiliary')} />
                </Question>
              )}

              {isRelay && answers.relayRole === 'auxiliary' && (
                <Question n={++n} title="What is it connected to? (any of them)">
                  <Check on={connects.includes('breaker')} title="Breaker" onClick={() => toggleConnect('breaker')} />
                  <Check on={connects.includes('relay')} title="Main relay" onClick={() => toggleConnect('relay')} />
                  {(others ?? []).filter(o => o.key !== ownKey).map(o => (
                    <Check key={o.key} on={connects.includes(o.key)} title={o.label} onClick={() => toggleConnect(o.key)} />
                  ))}
                  {connects.length === 0 && (
                    <p className="w-full text-[11px] text-gray-500">Nothing ticked — drawn standing on its own.</p>
                  )}
                </Question>
              )}

              {isRelay && (
                <Question n={++n} title="Functions">
                  <input className={input} value={answers.functions ?? ''}
                    placeholder="50, 50N, 51, 51N, 25, BCU — empty: PROTECTION RELAY"
                    onChange={e => set('functions', e.target.value || undefined)} />
                  <p className="w-full text-[11px] text-gray-500">
                    Written in the relay’s box in place of “PROTECTION RELAY”. Left empty, the box says PROTECTION RELAY.
                  </p>
                </Question>
              )}

              {isBreaker && (
                <Question n={++n} title="Interlock with upstream?">
                  <Choice on={answers.upstreamInterlock === true} title="Yes"
                    note="A key interlock on the breaker's dashed line, its text along it."
                    onClick={() => set('upstreamInterlock', true)} />
                  <Choice on={answers.upstreamInterlock !== true} title="No"
                    onClick={() => { set('upstreamInterlock', undefined); set('upstreamText', undefined); }} />
                  {answers.upstreamInterlock && (
                    <div className="w-full flex items-center gap-1.5">
                      <input className={input} value={answers.upstreamText ?? ''} placeholder="INCOMING FEEDER"
                        onChange={e => set('upstreamText', e.target.value || undefined)} />
                      <DirToggle value={answers.upstreamDir} onChange={d => set('upstreamDir', d)} />
                    </div>
                  )}
                </Question>
              )}

              {isBreaker && (
                <Question n={++n} title="Boxes beside the breaker">
                  <p className="w-full text-[11px] text-gray-500">
                    Each one a box strung along the interlock's dashed line — 94, CR, 74, 86 …
                  </p>
                  <StatusList value={answers.attachments} onChange={v => set('attachments', v)} hint="e.g. 94" label="Box" />
                </Question>
              )}

              {isMagnet && (
                <Question n={++n} title="Interlock with downstream?">
                  <Choice on={answers.downstreamInterlock !== false} title="Yes"
                    note="A dashed line from the magnet down to the foot of the cell, this text along it."
                    onClick={() => set('downstreamInterlock', undefined)} />
                  <Choice on={answers.downstreamInterlock === false} title="No"
                    onClick={() => { set('downstreamInterlock', false); set('downstreamText', undefined); }} />
                  {answers.downstreamInterlock !== false && (
                    <label className="w-full">
                      <span className="block text-[11px] text-gray-500 mb-0.5">Text along the line</span>
                      <span className="flex items-center gap-1.5">
                        <input className={input} value={answers.downstreamText ?? 'OUTGOING FEEDER'}
                          onChange={e => set('downstreamText', e.target.value === 'OUTGOING FEEDER' ? undefined : e.target.value)} />
                        <DirToggle value={answers.downstreamDir} onChange={d => set('downstreamDir', d)} />
                      </span>
                    </label>
                  )}
                </Question>
              )}

              {isVt && (
                <Question n={++n} title="Fuses?">
                  <Choice on={answers.vtFuses !== false} title="With fuses" onClick={() => set('vtFuses', undefined)} />
                  <Choice on={answers.vtFuses === false} title="Without fuses" onClick={() => set('vtFuses', false)} />
                </Question>
              )}

              {isVt && family === 'SIMOPRIME' && (
                <Question n={++n} title="On a PT truck?">
                  <Choice on={answers.ptTruck === true} title="Yes"
                    note="The PT is drawn after the breaker, on a socket." onClick={() => set('ptTruck', true)} />
                  <Choice on={answers.ptTruck !== true} title="No" onClick={() => set('ptTruck', undefined)} />
                </Question>
              )}

              {isCt && (
                <Question n={++n} title="CT cores, top to bottom">
                  <p className="w-full text-[11px] text-gray-500">
                    {answers.cores
                      ? 'Each core goes out of the CT in this order: protection into the relay, measuring into the meters.'
                      : cores.length
                        ? 'Read from its SIM-TABLE (5P/10P → protection, 0.2/0.5/FS → measuring). Change any of them here.'
                        : 'Nothing in its SIM-TABLE says — add its cores.'}
                  </p>
                  <div className="w-full space-y-1.5">
                    {cores.map((core, k) => (
                      <div key={k} className="flex items-center gap-1.5">
                        <span className="text-[11px] text-gray-500 w-12 shrink-0">Core {k + 1}</span>
                        <select className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white shrink-0"
                          value={core.purpose}
                          onChange={e => setCores(cores.map((c, i) => (i === k ? { ...c, purpose: e.target.value as CtCorePurpose } : c)))}>
                          {CORE_PURPOSES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                        {core.purpose === 'remark' && (
                          <input className={input} value={core.text ?? ''} placeholder="Written at the arrow"
                            onChange={e => setCores(cores.map((c, i) => (i === k ? { ...c, text: e.target.value } : c)))} />
                        )}
                        <button type="button" title="Remove this core" onClick={() => setCores(cores.filter((_, i) => i !== k))}
                          className="ml-auto p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                          <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setCores([...cores, { purpose: 'measurement' }])}
                      className="flex items-center gap-1 px-2 py-1 rounded border border-dashed border-gray-300 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-700">
                      <PlusIcon className="w-3.5 h-3.5" /> Add a core
                    </button>
                  </div>
                </Question>
              )}

              {(isRelay || isMeter) && (
                <Question n={++n} title="Serial link?">
                  <Choice on={answers.serialLink === true} title="Yes"
                    note="A dashed line from the scope down to the foot of the cell, its text along it."
                    onClick={() => set('serialLink', true)} />
                  <Choice on={answers.serialLink !== true} title="No"
                    onClick={() => { set('serialLink', undefined); set('serialText', undefined); set('serialDir', undefined); }} />
                  {answers.serialLink && (
                    <div className="w-full flex items-center gap-1.5">
                      <input className={input} value={answers.serialText ?? ''} placeholder="SERIAL LINK"
                        onChange={e => set('serialText', e.target.value || undefined)} />
                      <DirToggle value={answers.serialDir} onChange={d => set('serialDir', d)} />
                    </div>
                  )}
                </Question>
              )}

              {(isRelay || isSwitch || isMeter) && (
                <Question n={++n} title={isRelay ? 'Status signals from the relay'
                  : isMeter ? 'Status signals from the meter' : 'Status signals from the breaker'}>
                  <p className="w-full text-[11px] text-gray-500">
                    {isRelay || isMeter
                      ? 'Each one a dashed line from the scope, beside the serial link, down to the foot of the cell with its text along it.'
                      : 'Each one carries on the mechanical interlock’s dashed line and runs down to the foot of the cell with its text along it.'}
                  </p>
                  <StatusList
                    value={answers.statuses}
                    onChange={v => set('statuses', v)}
                    dirs={answers.statusDirs}
                    onDirs={v => set('statusDirs', v)}
                    hint={isRelay ? 'e.g. TRIP TO UPSTREAM' : isMeter ? 'e.g. ALARM TO DCS' : 'e.g. CB OPEN/CLOSE TO DCS'}
                  />
                </Question>
              )}
            </>
          )}

          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">On the drawing</p>
            <div className="font-mono text-xs text-gray-800 leading-relaxed">
              {preview.map((l, k) => (
                <div key={k} className={k >= previewAccessoryFrom ? 'text-blue-700' : 'font-semibold'}>{l}</div>
              ))}
            </div>
            <p className="mt-1 flex items-start gap-1 text-[10.5px] text-gray-500">
              <InfoIcon className="w-3 h-3 mt-px shrink-0" />
              Long SIM-TABLE values are broken onto lines like this, so they never run over the drawing.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50">
            {fresh ? 'Skip' : 'Cancel'}
          </button>
          <button
            onClick={() => {
              // Empty statuses are dropped; nothing typed is no key at all.
              const clean = { ...answers };
              if (clean.statuses) {
                // Each status keeps its own arrow when the empty ones go.
                const kept = clean.statuses
                  .map((t, k) => ({ t: t.trim(), d: clean.statusDirs?.[k] ?? 'down' as const }))
                  .filter(x => x.t);
                if (kept.length) clean.statuses = kept.map(x => x.t); else delete clean.statuses;
                if (kept.some(x => x.d === 'up')) clean.statusDirs = kept.map(x => x.d); else delete clean.statusDirs;
              }
              if (clean.attachments) {
                const kept = clean.attachments.map(t => t.trim()).filter(Boolean);
                if (kept.length) clean.attachments = kept; else delete clean.attachments;
              }
              const typed = simTable.trim();
              onSave(clean, symbolId || undefined, typed && typed !== ownCode ? typed : undefined);
            }}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white font-medium hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
