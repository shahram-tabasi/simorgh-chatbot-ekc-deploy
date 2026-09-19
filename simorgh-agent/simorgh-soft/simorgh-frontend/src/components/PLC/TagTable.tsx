// src/components/PLC/TagTable.tsx
//
// The PLC tags — the one table in the program that is about the wiring.
//
// `%I0.0` is a terminal somebody landed a wire on. `Start_PB` is what that
// wire is for. Every program worth reading is written against the second, and
// every program that took a day to fix was written against the first — so this
// table is where a job either becomes readable or does not, and it is worth
// the space it takes.
//
// Two things it checks as you type, because both are silent faults otherwise:
//
//   * **the address makes sense.** `%I0` is not an address — a bit needs a bit
//     number — and `%IW64.0` is not one either. The message says which, rather
//     than that something is wrong.
//   * **two tags are not the same terminal.** One address under two names is
//     how a change gets made in one place and not the other, and the program
//     then does two different things with one wire.

import React, { useMemo, useState } from 'react';
import {
  PlusIcon, TrashIcon, TableIcon, XIcon, AlertTriangleIcon, ArrowDownAZIcon,
} from 'lucide-react';
import { PlcProject, PlcTag, PlcTagTable, newId } from '../../utils/plc/model';
import { DATA_TYPE_NAMES, addressProblem, dataTypeInfo } from '../../utils/plc/dataTypes';
import { Lang, Strings } from './lang';
import { CHECK_STRINGS, CheckStrings } from '../../utils/plc/checkLang';

interface Props {
  project: PlcProject;
  readOnly?: boolean;
  t: Strings;
  lang: Lang;
  /** Which table is open. Kept by the page so it survives a tab change. */
  tableId: string | null;
  onTableId: (id: string) => void;
  onChange: (tables: PlcTagTable[]) => void;
}

const HEAD = 'px-2 py-1 text-left font-semibold text-[11px] uppercase tracking-wide text-gray-500';
const input = (extra = '') =>
  'w-full bg-transparent px-1.5 py-1 text-[12px] rounded border border-transparent '
  + 'hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:outline-none '
  + extra;

/** What is wrong with one tag, or null. */
function tagProblem(tag: PlcTag, all: PlcTag[], t: Strings, say: CheckStrings): string | null {
  if (!tag.name.trim()) return t.giveItAName;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag.name)) return t.nameRules;
  if (all.filter(other => other.name.toLowerCase() === tag.name.toLowerCase()).length > 1) {
    return t.nameAlreadyUsed;
  }
  const address = addressProblem(tag.address, say);
  if (address) return address;
  const sameAddress = tag.address
    ? all.filter(other => other.address.toUpperCase() === tag.address.toUpperCase())
    : [];
  if (sameAddress.length > 1) {
    return say.duplicateAddress(tag.address, sameAddress.length,
      sameAddress.map(other => other.name).join(', '));
  }
  const bit = /\.\d$/.test(tag.address);
  const info = dataTypeInfo(tag.dataType);
  if (tag.address && bit && info && info.bits !== 1) {
    return say.tagTypeWidthBit(tag.name, tag.address, tag.dataType);
  }
  if (tag.address && !bit && info?.bits === 1 && /^%[IQM]\d/i.test(tag.address)) {
    return say.tagTypeWidthBool(tag.name, tag.address);
  }
  return null;
}

export const TagTable: React.FC<Props> = ({
  project, readOnly, tableId, onTableId, onChange, t, lang,
}) => {
  const say = CHECK_STRINGS[lang];
  const [filter, setFilter] = useState('');
  const tables = project.tagTables;
  const open = tables.find(t => t.id === tableId) ?? tables[0];

  // Every tag in the project, because the two checks that matter — one name,
  // one address — are about the whole controller and not about one table.
  const everyTag = useMemo(() => tables.flatMap(t => t.tags), [tables]);

  if (!open) return null;

  const patchTable = (id: string, change: Partial<PlcTagTable>) =>
    onChange(tables.map(t => (t.id === id ? { ...t, ...change } : t)));

  const patchTag = (id: string, change: Partial<PlcTag>) =>
    patchTable(open.id, { tags: open.tags.map(t => (t.id === id ? { ...t, ...change } : t)) });

  /**
   * A new tag, with the next address of the same kind already filled in.
   *
   * Guessing the address is right here and wrong almost everywhere else: the
   * tags of one panel are consecutive, entering thirty of them is the job, and
   * an address that is one out is corrected in a second and noticed
   * immediately. An address left blank is corrected thirty times.
   */
  const addTag = () => {
    const last = [...open.tags].reverse().find(t => /^%I\d+\.\d$/i.test(t.address));
    let address = '';
    if (last) {
      const m = /^%I(\d+)\.(\d)$/i.exec(last.address);
      if (m) {
        const byte = Number(m[1]);
        const bit = Number(m[2]);
        address = bit >= 7 ? `%I${byte + 1}.0` : `%I${byte}.${bit + 1}`;
      }
    }
    patchTable(open.id, {
      tags: [...open.tags, {
        id: newId('t'), name: '', dataType: 'Bool', address, comment: '',
      }],
    });
  };

  const removeTag = (id: string) =>
    patchTable(open.id, { tags: open.tags.filter(t => t.id !== id) });

  const addTable = () => {
    const name = window.prompt(t.tableNameAsk, `${t.tagTable} ${tables.length + 1}`);
    if (!name?.trim()) return;
    const table: PlcTagTable = { id: newId('tt'), name: name.trim(), tags: [] };
    onChange([...tables, table]);
    onTableId(table.id);
  };

  const removeTable = (id: string) => {
    const table = tables.find(t => t.id === id);
    if (!table) return;
    if (table.isDefault) {
      window.alert(t.defaultTableKept);
      return;
    }
    if (table.tags.length > 0
      && !window.confirm(`"${table.name}" — ${table.tags.length} — ${t.deleteTableAsk}`)) {
      return;
    }
    onChange(tables.filter(t => t.id !== id));
    onTableId(tables.find(t => t.id !== id)?.id ?? '');
  };

  /** By address, which is the order the terminals are in on the rail. */
  const sortByAddress = () => {
    const key = (t: PlcTag) => {
      const m = /^%([IQM])([XBWD]?)(\d+)(?:\.(\d))?$/i.exec(t.address);
      if (!m) return [9, 0, 0, 0];
      const area = { I: 0, Q: 1, M: 2 }[m[1].toUpperCase() as 'I' | 'Q' | 'M'] ?? 3;
      return [area, Number(m[3]), Number(m[4] ?? 0), 0];
    };
    patchTable(open.id, {
      tags: [...open.tags].sort((a, b) => {
        const ka = key(a); const kb = key(b);
        for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return a.name.localeCompare(b.name);
      }),
    });
  };

  const shown = filter.trim()
    ? open.tags.filter(t => `${t.name} ${t.address} ${t.comment ?? ''}`
      .toLowerCase().includes(filter.trim().toLowerCase()))
    : open.tags;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* The tables, as tabs. */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b bg-gray-50 shrink-0 overflow-x-auto">
        {tables.map(table => (
          <button
            key={table.id}
            onClick={() => onTableId(table.id)}
            className={`group inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] whitespace-nowrap
              ${table.id === open.id
              ? 'bg-white shadow-sm font-semibold'
              : 'hover:bg-white/60 text-gray-600'}`}
          >
            <TableIcon className="w-3.5 h-3.5" />
            {table.name}
            <span className="text-gray-400">{table.tags.length}</span>
            {!readOnly && !table.isDefault && (
              <span
                role="button"
                tabIndex={-1}
                className="opacity-0 group-hover:opacity-100 hover:text-red-600"
                title={t.deleteTable}
                onClick={e => { e.stopPropagation(); removeTable(table.id); }}
              >
                <XIcon className="w-3 h-3" />
              </span>
            )}
          </button>
        ))}
        {!readOnly && (
          <button
            onClick={addTable}
            className="px-2 py-1 rounded text-[12px] text-blue-700 hover:bg-blue-50"
            title={t.anotherTable}
          >
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="ms-auto flex items-center gap-2">
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t.filter}
            className="px-2 py-1 text-[12px] rounded border border-gray-300 w-40"
          />
          {!readOnly && (
            <button
              onClick={sortByAddress}
              className="p-1.5 rounded hover:bg-gray-200"
              title={t.sortByAddress}
            >
              <ArrowDownAZIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12px] min-w-[820px]">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className={`${HEAD} w-8`} />
              <th className={`${HEAD} min-w-[160px]`}>{t.colName}</th>
              <th className={`${HEAD} w-40`}>{t.colType}</th>
              <th className={`${HEAD} w-32`}>{t.colAddress}</th>
              <th className={`${HEAD} w-16 text-center`}>{t.colRetain}</th>
              <th className={`${HEAD} w-20 text-center`}>{t.colVisible}</th>
              <th className={`${HEAD} w-20 text-center`}>{t.colWritable}</th>
              <th className={HEAD}>{t.colComment}</th>
              <th className={`${HEAD} w-10`} />
            </tr>
          </thead>
          <tbody>
            {shown.map(tag => {
              const problem = tagProblem(tag, everyTag, t, say);
              return (
                <tr
                  key={tag.id}
                  className="border-b border-gray-100 hover:bg-blue-50"
                >
                  <td className="px-1 text-center">
                    {problem && (
                      <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-500 inline" aria-label={problem} />
                    )}
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      className={input(problem ? 'border-amber-300 bg-amber-50/60' : '')}
                      value={tag.name}
                      readOnly={readOnly}
                      title={problem ?? undefined}
                      placeholder={t.tagNamePlaceholder}
                      onChange={e => patchTag(tag.id, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      className={input()}
                      dir="ltr"
                      value={tag.dataType}
                      readOnly={readOnly}
                      list="plc-tag-types"
                      title={dataTypeInfo(tag.dataType)?.note}
                      onChange={e => patchTag(tag.id, { dataType: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      className={input('font-mono')}
                      dir="ltr"
                      value={tag.address}
                      readOnly={readOnly}
                      placeholder="%I0.0"
                      onChange={e => patchTag(tag.id, { address: e.target.value })}
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox" checked={!!tag.retain} disabled={readOnly}
                      title={t.retainTip}
                      onChange={e => patchTag(tag.id, { retain: e.target.checked })}
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox" checked={tag.visible !== false} disabled={readOnly}
                      onChange={e => patchTag(tag.id, { visible: e.target.checked })}
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox" checked={tag.writable !== false} disabled={readOnly}
                      onChange={e => patchTag(tag.id, { writable: e.target.checked })}
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <input
                      className={input('text-gray-600')}
                      value={tag.comment ?? ''}
                      readOnly={readOnly}
                      placeholder={t.tagCommentPlaceholder}
                      onChange={e => patchTag(tag.id, { comment: e.target.value })}
                    />
                  </td>
                  <td className="px-1 text-center">
                    {!readOnly && (
                      <button
                        className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600"
                        title={t.deleteRow}
                        onClick={() => removeTag(tag.id)}
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}

            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-[11px] text-gray-500 italic">
                  {filter.trim() ? t.noTagMatches : t.noTags}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <datalist id="plc-tag-types">
          {DATA_TYPE_NAMES.map(t => <option key={t} value={t} />)}
        </datalist>
      </div>

      {!readOnly && (
        <div className="px-2 py-1.5 border-t bg-gray-50 shrink-0">
          <button
            onClick={addTag}
            className="inline-flex items-center gap-1 px-2 py-1 text-[12px] rounded text-blue-700 hover:bg-blue-50"
          >
            <PlusIcon className="w-3.5 h-3.5" /> {t.addTag}
          </button>
          <span className="ms-3 text-[11px] text-gray-500">
            {t.addTagNote}
          </span>
        </div>
      )}
    </div>
  );
};
