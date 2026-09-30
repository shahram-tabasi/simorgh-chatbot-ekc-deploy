// src/components/PLC/NewBlockDialog.tsx
//
// Adding a block — the one decision in a PLC project that is expensive to
// change later.
//
// Whether a piece of logic is an FC or an FB decides whether it can remember
// anything; whether a data block is global or an instance decides who may
// write it. Both are chosen here, in about four seconds, and both are a day's
// work to change once ten call sites exist. So this dialog says what each
// choice means *while it is being made* rather than leaving it to be found
// out — that is the whole reason it is a dialog and not a menu item that drops
// an untitled block into the tree.
//
// The number is offered and not demanded. Symbolic access made it stop
// mattering for most work, and for an OB it still decides what the block *is*
// — so the OB list is events with their numbers already on them, and the rest
// get the first free number with the option to change it.

import React, { useMemo, useState } from 'react';
import {
  XIcon, FileCodeIcon, BoxIcon, DatabaseIcon, LayersIcon, CpuIcon, CheckIcon,
} from 'lucide-react';
import {
  PLC_LANGUAGES, PlcBlock, PlcBlockKind, PlcLanguage, PlcProject,
  isGraphical, newBlock, newNetwork, nextNumber,
} from '../../utils/plc/model';
import { Strings } from './lang';

/** What each kind of block is called and what it is, in the language read. */
function kindMetaOf(t: Strings): { id: PlcBlockKind; label: string; note: string }[] {
  return [
    { id: 'OB', label: t.kindOb, note: t.kindObNote },
    { id: 'FB', label: t.kindFb, note: t.kindFbNote },
    { id: 'FC', label: t.kindFc, note: t.kindFcNote },
    { id: 'DB', label: t.kindDb, note: t.kindDbNote },
    { id: 'UDT', label: t.kindUdt, note: t.kindUdtNote },
  ];
}

/**
* The organisation blocks, with what calls each one.
*
* The number is the identity here: OB100 is startup because it is 100, and a
* block called `Startup` with the wrong number never runs. Listing them with
* their numbers is what stops that.
*/
const OB_EVENTS: { number: number; name: string; label: string; note: string }[] = [
  { number: 1, name: 'Main', label: 'Program cycle', note: 'Called once every scan. Where the program lives.' },
  { number: 100, name: 'Startup', label: 'Startup', note: 'Once, as the CPU goes to RUN — before the first cycle.' },
  { number: 30, name: 'Cyclic_interrupt', label: 'Cyclic interrupt', note: 'At a fixed interval, whatever the cycle is doing. For control loops.' },
  { number: 40, name: 'Hardware_interrupt', label: 'Hardware interrupt', note: 'When an input edge arrives — faster than the cycle can see it.' },
  { number: 80, name: 'Time_error', label: 'Time error interrupt', note: 'The scan took too long. Without this OB the CPU stops.' },
  { number: 82, name: 'Diagnostic_error', label: 'Diagnostic error interrupt', note: 'A module reported a fault.' },
  { number: 121, name: 'Programming_error', label: 'Programming error', note: 'A fault in the program — a bad index, a division by zero.' },
  { number: 122, name: 'IO_access_error', label: 'IO access error', note: 'A module that was addressed and did not answer.' },
];

interface Props {
  project: PlcProject;
  /** Pre-chosen from the tree — "Add new block" under Program blocks. */
  initialKind?: PlcBlockKind;
  t: Strings;
  onCancel: () => void;
  onCreate: (block: PlcBlock) => void;
}

const KIND_ICON: Record<PlcBlockKind, React.ReactNode> = {
  OB: <CpuIcon className="w-5 h-5" />,
  FB: <BoxIcon className="w-5 h-5" />,
  FC: <FileCodeIcon className="w-5 h-5" />,
  DB: <DatabaseIcon className="w-5 h-5" />,
  UDT: <LayersIcon className="w-5 h-5" />,
};

export const NewBlockDialog: React.FC<Props> = ({
  project, initialKind = 'FB', t, onCancel, onCreate,
}) => {
  const kinds = kindMetaOf(t);
  const [kind, setKind] = useState<PlcBlockKind>(initialKind);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<PlcLanguage>('LAD');
  const [event, setEvent] = useState(OB_EVENTS[0]);
  const [manualNumber, setManualNumber] = useState<string>('');
  const [dbKind, setDbKind] = useState<'global' | 'instance'>('global');
  const [instanceOf, setInstanceOf] = useState('');
  const [comment, setComment] = useState('');

  const functionBlocks = useMemo(
    () => project.blocks.filter(b => b.kind === 'FB'), [project.blocks]);

  const suggestedNumber = useMemo(() => {
    if (kind === 'OB') return event.number;
    if (kind === 'UDT') return undefined;
    return nextNumber(project, kind, kind === 'DB' ? 1 : 1);
  }, [project, kind, event]);

  const number = manualNumber.trim()
    ? Math.max(0, Math.round(Number(manualNumber))) || undefined
    : suggestedNumber;

  const nameTaken = project.blocks
    .some(b => b.name.trim().toLowerCase() === name.trim().toLowerCase());
  const numberTaken = number !== undefined && project.blocks
    .some(b => b.kind === kind && b.number === number);

  const nameProblem = !name.trim() ? t.giveItAName
    : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())
      ? t.nameRules
      : nameTaken ? t.nameAlreadyUsed
        : null;

  const instanceProblem = kind === 'DB' && dbKind === 'instance' && !instanceOf
    ? t.instanceNeedsFb
    : null;

  const canCreate = !nameProblem && !instanceProblem;

  const create = () => {
    if (!canCreate) return;
    const graphical = isGraphical(language);
    const block = newBlock(kind, {
      name: name.trim(),
      number,
      language: kind === 'DB' || kind === 'UDT' ? 'SCL' : language,
      comment: comment.trim() || (kind === 'OB' ? event.note : undefined),
      networks: kind === 'DB' || kind === 'UDT' ? undefined
        : graphical ? [newNetwork(1, { title: '' })] : undefined,
      code: kind === 'DB' || kind === 'UDT' ? undefined : graphical ? undefined : '',
      dbKind: kind === 'DB' ? dbKind : undefined,
      instanceOf: kind === 'DB' && dbKind === 'instance' ? instanceOf : undefined,
      interface: kind === 'DB' && dbKind === 'instance'
        // An instance DB *is* the function block's interface. It is copied in
        // at creation so the grid has something to show, and it is read-only
        // there — the FB owns it, and editing it here would be editing a copy.
        ? (functionBlocks.find(b => b.id === instanceOf)?.interface ?? [])
          .filter(v => v.section !== 'Temp')
          .map(v => ({ ...v, section: 'Static' as const }))
        : [],
    });
    onCreate(block);
  };

  const kindMeta = kinds.find(k => k.id === kind);

  return (
    <div className="fixed inset-0 z-[220] bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[720px] max-w-full max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-gradient-to-r from-slate-700 to-slate-800 text-white px-5 py-3 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold">{t.newBlockTitle}</h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-white/20">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5 space-y-5 text-[13px]">
          {/* What kind */}
          <div>
            <p className="font-semibold mb-2">{t.whatKind}</p>
            <div className="grid grid-cols-5 gap-2">
              {kinds.map(k => (
                <button
                  key={k.id}
                  onClick={() => {
                    setKind(k.id);
                    if (k.id === 'OB' && !name.trim()) setName(OB_EVENTS[0].name);
                  }}
                  className={`flex flex-col items-center gap-1 p-3 rounded border text-center transition
                    ${kind === k.id
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-300'
                    : 'border-gray-200 hover:border-blue-300'}`}
                >
                  <span className={kind === k.id ? 'text-blue-600' : 'text-gray-500'}>{KIND_ICON[k.id]}</span>
                  <span className="text-[11px] font-semibold">{k.id}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">{kindMeta?.label}</span> — {kindMeta?.note}
            </p>
          </div>

          {/* The OB's event */}
          {kind === 'OB' && (
            <div>
              <p className="font-semibold mb-2">{t.whatCalls}</p>
              <div className="space-y-1 max-h-48 overflow-auto rounded border">
                {OB_EVENTS.map(e => (
                  <button
                    key={e.number}
                    onClick={() => { setEvent(e); if (!name.trim() || OB_EVENTS.some(x => x.name === name)) setName(e.name); }}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2
                      ${event.number === e.number ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  >
                    <span className="font-mono text-[11px] w-12 shrink-0 text-gray-500">OB{e.number}</span>
                    <span className="font-medium shrink-0">{e.label}</span>
                    <span className="text-[11px] text-gray-500 truncate">{e.note}</span>
                    {event.number === e.number && <CheckIcon className="w-4 h-4 text-blue-600 ms-auto shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Global or instance */}
          {kind === 'DB' && (
            <div>
              <p className="font-semibold mb-2">{t.whatFor}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setDbKind('global')}
                  className={`p-3 rounded border text-left ${dbKind === 'global'
                    ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
                >
                  <span className="font-semibold">{t.globalDb}</span>
                  <span className="block text-[11px] text-gray-600">{t.globalDbNote}</span>
                </button>
                <button
                  onClick={() => setDbKind('instance')}
                  disabled={functionBlocks.length === 0}
                  className={`p-3 rounded border text-left disabled:opacity-40 ${dbKind === 'instance'
                    ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
                >
                  <span className="font-semibold">{t.instanceDb}</span>
                  <span className="block text-[11px] text-gray-600">
                    {functionBlocks.length === 0 ? t.noFbYet : t.instanceDbNote}
                  </span>
                </button>
              </div>
              {dbKind === 'instance' && (
                <select
                  className="mt-2 w-full px-2 py-1.5 rounded border border-gray-300"
                  value={instanceOf}
                  onChange={e => {
                    setInstanceOf(e.target.value);
                    const fb = functionBlocks.find(b => b.id === e.target.value);
                    if (fb && !name.trim()) setName(`${fb.name}_DB`);
                  }}
                >
                  <option value="">{t.whichFb}</option>
                  {functionBlocks.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Language */}
          {kind !== 'DB' && kind !== 'UDT' && (
            <div>
              <p className="font-semibold mb-2">{t.writtenIn}</p>
              <div className="flex flex-wrap gap-2">
                {PLC_LANGUAGES.map(l => (
                  <button
                    key={l.id}
                    onClick={() => setLanguage(l.id)}
                    className={`px-3 py-1.5 rounded border text-left ${language === l.id
                      ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}
                    title={l.note}
                  >
                    <span className="font-semibold">{l.label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-gray-600">
                {PLC_LANGUAGES.find(l => l.id === language)?.note}
                {language === 'GRAPH' && ' — declared here and written as text until it is drawn.'}
              </p>
            </div>
          )}

          {/* Name and number */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <label className="block">
              <span className="block font-semibold mb-1">{t.name}</span>
              <input
                className={`w-full px-2 py-1.5 rounded border
                  ${nameProblem && name ? 'border-amber-400' : 'border-gray-300'}`}
                value={name}
                autoFocus
                placeholder={kind === 'DB' ? 'Recipe_Data' : kind === 'UDT' ? 'MotorData' : 'Motor_Control'}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canCreate) create(); }}
              />
            </label>
            {kind !== 'UDT' && (
              <label className="block">
                <span className="block font-semibold mb-1">{t.number}</span>
                <input
                  className={`w-full px-2 py-1.5 rounded border font-mono
                    ${numberTaken ? 'border-amber-400' : 'border-gray-300'}`}
                  value={manualNumber}
                  placeholder={String(suggestedNumber ?? '')}
                  onChange={e => setManualNumber(e.target.value.replace(/\D/g, ''))}
                />
              </label>
            )}
          </div>

          <label className="block">
            <span className="block font-semibold mb-1">{t.comment}</span>
            <textarea
              className="w-full px-2 py-1.5 rounded border border-gray-300 h-16 resize-none"
              value={comment}
              placeholder="What this block is for. A block with this filled in is a block somebody else can use."
              onChange={e => setComment(e.target.value)}
            />
          </label>

          {(nameProblem || instanceProblem || numberTaken) && (
            <ul className="text-[12px] text-amber-700 space-y-1">
              {nameProblem && name.trim() && <li>{nameProblem}</li>}
              {instanceProblem && <li>{instanceProblem}</li>}
              {numberTaken && <li>{kind}{number} {t.numberTaken}</li>}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex items-center gap-2 shrink-0">
          {!canCreate && (
            <p className="me-auto text-[12px] text-amber-700">
              {nameProblem ?? instanceProblem}
            </p>
          )}
          <button
            onClick={onCancel}
            className="ms-auto px-4 py-2 text-[13px] border border-gray-300 rounded hover:bg-white"
          >
            {t.cancel}
          </button>
          <button
            onClick={create}
            disabled={!canCreate}
            className="px-4 py-2 text-[13px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
          >
            {t.addBlock}
          </button>
        </div>
      </div>
    </div>
  );
};
