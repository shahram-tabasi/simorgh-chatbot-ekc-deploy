import React, { useMemo, useState } from 'react';
import { CheckIcon, XIcon, InfoIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { PartSingleLine } from '../../types/project';
import { IEC_SYMBOLS, SYMBOL_GROUPS, SymbolId } from '../../utils/iecSymbols';
import { breakLabel, symbolForPart } from '../../utils/eplanSingleLine';
import { partCode } from '../../utils/eplanDataExport';
import { stripLocaleTags } from '../../utils/tierEquipmentMatrix';
import { type Tier } from '../../utils/tiers';

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
  /** `simTable` is the SIM-TABLE typed here, or undefined to keep the
   *  part's own (its order number / designation). */
  onSave: (answers: PartSingleLine, symbolId: string | undefined, simTable: string | undefined) => void;
  onClose: () => void;
}

const RELAYS: SymbolId[] = ['protection-relay', 'earth-fault-relay'];
const SWITCHES: SymbolId[] = [
  'vcb', 'vcb-racking', 'withdrawable-cb', 'vacuum-contactor-fuse', 'circuit-breaker',
  'contactor', 'disconnector', 'switch-disconnector', 'mcb', 'motor-starter',
];

const input = 'w-full min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400';

/** A list of status texts: each one a dashed line to the foot of the cell. */
const StatusList: React.FC<{
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  hint: string;
}> = ({ value, onChange, hint }) => {
  const list = value ?? [];
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  return (
    <div className="w-full space-y-1.5">
      {list.map((t, k) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-500 w-14 shrink-0">Status {k + 1}</span>
          <input className={input} value={t} placeholder={hint}
            onChange={e => set(list.map((x, i) => (i === k ? e.target.value : x)))} />
          <button type="button" title="Remove this status" onClick={() => set(list.filter((_, i) => i !== k))}
            className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, ''])}
        className="flex items-center gap-1 px-2 py-1 rounded border border-dashed border-gray-300 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-700">
        <PlusIcon className="w-3.5 h-3.5" /> Add a status
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
  part, slot, slotTitle, index, tier, host, fresh, onSave, onClose,
}) => {
  const [answers, setAnswers] = useState<PartSingleLine>({ ...(part?.sld ?? {}) });
  const [symbolId, setSymbolId] = useState<string>(String(part?.symbolId ?? ''));

  const auto = useMemo(
    () => symbolForPart({ ...part, symbolId: undefined }, slot, undefined, tier).id,
    [part, slot, tier]);
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
  const asksRole = index > 0;
  const isAccessory = asksRole ? answers.role !== 'main' : answers.role === 'accessory';
  const isRelay = RELAYS.includes(effective);
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
            <Question n={++n} title="Is it an accessory of the device above, or a device of its own?">
              <Choice on={isAccessory} title="Accessory"
                note={`Not drawn; only its SIM-TABLE is written, under ${host ? `${stripLocaleTags(host?.label) || 'the row'}'s` : 'the row’s'}.`}
                onClick={() => set('role', undefined)} />
              <Choice on={!isAccessory} title="Main device"
                note="Drawn as a device of its own, with its own label."
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

              <Question n={++n} title="Series or parallel?">
                <Choice on={!answers.placement} title="Auto" note={`As its kind is drawn: ${naturally}.`}
                  onClick={() => set('placement', undefined)} />
                <Choice on={answers.placement === 'series'} title="Series" note="On the line — the current runs through it."
                  onClick={() => set('placement', 'series')} />
                <Choice on={answers.placement === 'parallel'} title="Parallel" note="Beside the line, tapped off it."
                  onClick={() => set('placement', 'parallel')} />
              </Question>

              {isRelay && (
                <Question n={++n} title="Main relay or auxiliary relay?">
                  <Choice on={answers.relayRole !== 'auxiliary'} title="Main relay"
                    note="The CTs, the core-balance CT and the test block go into it."
                    onClick={() => { set('relayRole', 'main'); set('relayConnect', undefined); }} />
                  <Choice on={answers.relayRole === 'auxiliary'} title="Auxiliary relay"
                    note="Wired to the breaker, the main relay, or both."
                    onClick={() => set('relayRole', 'auxiliary')} />
                </Question>
              )}

              {isRelay && answers.relayRole === 'auxiliary' && (
                <Question n={++n} title="What is it connected to?">
                  <Choice on={answers.relayConnect === 'breaker'} title="Breaker" onClick={() => set('relayConnect', 'breaker')} />
                  <Choice on={!answers.relayConnect || answers.relayConnect === 'relay'} title="Main relay"
                    onClick={() => set('relayConnect', 'relay')} />
                  <Choice on={answers.relayConnect === 'both'} title="Both" onClick={() => set('relayConnect', 'both')} />
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

              {isRelay && (
                <Question n={++n} title="Serial link?">
                  <Choice on={answers.serialLink === true} title="Yes"
                    note="A dashed line from the relay down to the foot of the cell, its text along it."
                    onClick={() => set('serialLink', true)} />
                  <Choice on={answers.serialLink !== true} title="No"
                    onClick={() => { set('serialLink', undefined); set('serialText', undefined); }} />
                  {answers.serialLink && (
                    <input className={input} value={answers.serialText ?? ''} placeholder="SERIAL LINK"
                      onChange={e => set('serialText', e.target.value || undefined)} />
                  )}
                </Question>
              )}

              {(isRelay || isSwitch) && (
                <Question n={++n} title={isRelay ? 'Status signals from the relay' : 'Status signals from the breaker'}>
                  <p className="w-full text-[11px] text-gray-500">
                    {isRelay
                      ? 'Each one a dashed line from the relay, beside the serial link, down to the foot of the cell with its text along it.'
                      : 'Each one carries on the mechanical interlock’s dashed line and runs down to the foot of the cell with its text along it.'}
                  </p>
                  <StatusList
                    value={answers.statuses}
                    onChange={v => set('statuses', v)}
                    hint={isRelay ? 'e.g. TRIP TO UPSTREAM' : 'e.g. CB OPEN/CLOSE TO DCS'}
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
                const kept = clean.statuses.map(t => t.trim()).filter(Boolean);
                if (kept.length) clean.statuses = kept; else delete clean.statuses;
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
