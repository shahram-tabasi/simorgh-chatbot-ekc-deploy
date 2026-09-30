// src/components/PLC/InterfaceTable.tsx
//
// The declaration grid — what a block is given, what it gives back and what it
// remembers.
//
// This is the half of a block that decides whether it can be reused. A block
// whose inputs are real inputs can drive ten motors; the same logic written
// against ten global tags can drive one, and the second motor is a copy of the
// block with every address changed by hand. So the grid is not a side panel
// here: it is above the code, open, and the first thing on the screen when a
// block is opened.
//
// It is one component for four different things — an FB's interface, an FC's,
// a global data block's rows, and a PLC data type's members — because they are
// the same grid with different sections showing, and `sectionsFor` in the
// model already says which. Four components would be four places to fix the
// next time a column is added.
//
// What it refuses to do is silently correct. A name with a space in it, a type
// nothing has heard of, the same name twice — each is marked where it is and
// left as typed. An engineer half way through renaming something does not want
// the grid arguing with them; they want to be able to see, when they stop,
// what is still wrong.

import React, { useMemo, useRef, useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon,
  ArrowUpIcon, ArrowDownIcon, AlertTriangleIcon,
} from 'lucide-react';
import { MenuBox } from '../shared/MenuBox';
import {
  PlcBlock, PlcProject, PlcSection, PlcVar, newVar, sectionsFor,
} from '../../utils/plc/model';
import { DATA_TYPE_NAMES, dataTypeInfo, isUserType, userTypeName } from '../../utils/plc/dataTypes';
import { Strings } from './lang';

interface Props {
  project: PlcProject;
  block: PlcBlock;
  readOnly?: boolean;
  t: Strings;
  onChange: (next: PlcVar[]) => void;
  /** Start with the sections closed — used where the code is the point. */
  startCollapsed?: boolean;
}

/** What is wrong with one row, or null. Shown on the row, not in a dialog. */
function rowProblem(v: PlcVar, all: PlcVar[], typeNames: Set<string>): string | null {
  if (!v.name.trim()) return 'This row has no name.';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) {
    return 'A name is letters, digits and underscores, and does not start with a digit.';
  }
  const twice = all.filter(o => o.name.toLowerCase() === v.name.toLowerCase()).length > 1;
  if (twice) return 'Declared twice. One of the two uses in the code is not the one that was meant.';
  if (isUserType(v.dataType)) {
    if (!typeNames.has(userTypeName(v.dataType).toLowerCase())) {
      return `"${userTypeName(v.dataType)}" is not a PLC data type or a function block in this project.`;
    }
    return null;
  }
  if (!v.dataType.trim()) return 'This row has no type.';
  if (!dataTypeInfo(v.dataType)) return `${v.dataType} is not a type this controller knows.`;
  if (v.section === 'Temp' && v.defaultValue?.trim()) {
    return 'Temp is not initialised — it holds whatever was in that memory last scan, and the '
      + 'start value is ignored.';
  }
  return null;
}

/** A section's heading and its note, in the language being read. */
function sectionLabel(t: Strings, section: PlcSection): string {
  switch (section) {
    case 'Input': return t.secInput;
    case 'Output': return t.secOutput;
    case 'InOut': return t.secInOut;
    case 'Static': return t.secStatic;
    case 'Temp': return t.secTemp;
    case 'Constant': return t.secConstant;
    case 'Return': return t.secReturn;
  }
}

function sectionNote(t: Strings, section: PlcSection): string {
  switch (section) {
    case 'Input': return t.secInputNote;
    case 'Output': return t.secOutputNote;
    case 'InOut': return t.secInOutNote;
    case 'Static': return t.secStaticNote;
    case 'Temp': return t.secTempNote;
    case 'Constant': return t.secConstantNote;
    case 'Return': return t.secReturnNote;
  }
}

const HEAD = 'px-2 py-1 text-left font-semibold text-[11px] uppercase tracking-wide text-gray-500';
const CELL = 'px-1 py-0.5 align-top';

const input = (extra = '') =>
  'w-full bg-transparent px-1.5 py-1 text-[12px] rounded border border-transparent '
  + 'hover:border-gray-300 focus:border-blue-400 focus:bg-white focus:outline-none '
  + extra;

export const InterfaceTable: React.FC<Props> = ({
  project, block, readOnly, onChange, startCollapsed, t,
}) => {
  const sections = sectionsFor(block.kind);
  const [closed, setClosed] = useState<Set<string>>(
    () => new Set(startCollapsed ? sections : []));
  const [menu, setMenu] = useState<{ x: number; y: number; varId: string } | null>(null);
  // Which row was added last, so the name cell can be focused for typing — a
  // new row that needs a click before it can be named is a new row nobody adds.
  const freshRef = useRef<string | null>(null);

  const typeNames = useMemo(
    () => new Set(project.blocks
      .filter(b => b.kind === 'UDT' || b.kind === 'FB')
      .map(b => b.name.toLowerCase())),
    [project.blocks],
  );

  const typeOptions = useMemo(() => [
    ...DATA_TYPE_NAMES,
    ...project.blocks.filter(b => b.kind === 'UDT' || b.kind === 'FB').map(b => `"${b.name}"`),
    'TON', 'TOF', 'TP', 'TONR', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG',
  ], [project.blocks]);

  const patch = (id: string, change: Partial<PlcVar>) => {
    onChange(block.interface.map(v => (v.id === id ? { ...v, ...change } : v)));
  };

  const addRow = (section: PlcSection, after?: string) => {
    const row = newVar(section);
    freshRef.current = row.id;
    if (!after) { onChange([...block.interface, row]); return; }
    const at = block.interface.findIndex(v => v.id === after);
    const next = [...block.interface];
    next.splice(at + 1, 0, row);
    onChange(next);
  };

  const remove = (id: string) => onChange(block.interface.filter(v => v.id !== id));

  /**
   * Move a row within its own section.
   *
   * Within, not across: declaration order matters inside a section — it is the
   * order the pins appear in on the box — and means nothing between them.
   * Letting a drag carry an Input into Output would change what the block *is*
   * by accident.
   */
  const move = (id: string, by: -1 | 1) => {
    const row = block.interface.find(v => v.id === id);
    if (!row) return;
    const mine = block.interface.filter(v => v.section === row.section);
    const at = mine.findIndex(v => v.id === id);
    const to = at + by;
    if (to < 0 || to >= mine.length) return;
    const swapped = [...mine];
    [swapped[at], swapped[to]] = [swapped[to], swapped[at]];
    let k = 0;
    onChange(block.interface.map(v => (v.section === row.section ? swapped[k++] : v)));
  };

  const toggle = (section: string) => setClosed(prev => {
    const next = new Set(prev);
    if (next.has(section)) next.delete(section); else next.add(section);
    return next;
  });

  const showRetain = block.kind === 'FB' || block.kind === 'DB';
  const showHmi = block.kind !== 'FC';

  return (
    <div className="text-[12px] overflow-x-auto" onClick={() => menu && setMenu(null)}>
      {/* A minimum width, so a narrow middle column scrolls the grid instead
          of squeezing it. Squeezed, "Default value" wraps onto two lines and
          the comment — the column that makes a program readable — is the one
          that disappears. */}
      <table className="w-full border-collapse min-w-[740px]">
        <thead className="bg-gray-50 sticky top-0 z-10">
          <tr>
            <th className={`${HEAD} w-8`} />
            <th className={`${HEAD} min-w-[160px]`}>{t.colName}</th>
            <th className={`${HEAD} min-w-[150px]`}>{t.colType}</th>
            <th className={`${HEAD} w-32`}>{t.colDefault}</th>
            {showRetain && <th className={`${HEAD} w-16 text-center`}>{t.colRetain}</th>}
            {showHmi && <th className={`${HEAD} w-20 text-center`}>{t.colVisible}</th>}
            {showHmi && <th className={`${HEAD} w-20 text-center`}>{t.colWritable}</th>}
            <th className={HEAD}>{t.colComment}</th>
            <th className={`${HEAD} w-10`} />
          </tr>
        </thead>

        <tbody>
          {sections.map(section => {
            const rows = block.interface.filter(v => v.section === section);
            const isClosed = closed.has(section);
            return (
              <React.Fragment key={section}>
                <tr
                  className="bg-blue-50 cursor-pointer select-none"
                  onClick={() => toggle(section)}
                >
                  <td className="px-1 py-1">
                    {isClosed
                      ? <ChevronRightIcon className="w-3.5 h-3.5 text-gray-500" />
                      : <ChevronDownIcon className="w-3.5 h-3.5 text-gray-500" />}
                  </td>
                  <td className="px-2 py-1 font-semibold text-blue-900" colSpan={2}>
                    {sectionLabel(t, section)}
                    <span className="ms-2 font-normal text-gray-500">{rows.length}</span>
                  </td>
                  <td className="px-2 py-1 text-[11px] text-gray-500 italic" colSpan={9}>
                    {sectionNote(t, section)}
                  </td>
                </tr>

                {!isClosed && rows.map(v => {
                  const problem = rowProblem(v, block.interface, typeNames);
                  return (
                    <tr
                      key={v.id}
                      className="border-b border-gray-100 hover:bg-blue-50"
                      onContextMenu={e => {
                        if (readOnly) return;
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, varId: v.id });
                      }}
                    >
                      <td className="px-1 text-center">
                        {problem && (
                          <AlertTriangleIcon
                            className="w-3.5 h-3.5 text-amber-500 inline"
                            aria-label={problem}
                          />
                        )}
                      </td>
                      <td className={CELL}>
                        <input
                          className={input(problem ? 'border-amber-300 bg-amber-50/60' : '')}
                          value={v.name}
                          readOnly={readOnly}
                          title={problem ?? undefined}
                          placeholder={t.namePlaceholder}
                          autoFocus={freshRef.current === v.id}
                          onChange={e => patch(v.id, { name: e.target.value })}
                        />
                      </td>
                      <td className={CELL}>
                        <input
                          className={input()}
                          dir="ltr"
                          value={v.dataType}
                          readOnly={readOnly}
                          list="plc-data-types"
                          placeholder="Bool"
                          title={dataTypeInfo(v.dataType)?.note}
                          onChange={e => patch(v.id, { dataType: e.target.value })}
                        />
                      </td>
                      <td className={CELL}>
                        <input
                          className={input('font-mono')}
                          dir="ltr"
                          value={v.defaultValue ?? ''}
                          readOnly={readOnly}
                          placeholder={dataTypeInfo(v.dataType)?.initial ?? ''}
                          onChange={e => patch(v.id, { defaultValue: e.target.value })}
                        />
                      </td>
                      {showRetain && (
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={!!v.retain}
                            disabled={readOnly || v.section !== 'Static'}
                            title={v.section === 'Static' ? t.retainTip : t.retainOnlyStatic}
                            onChange={e => patch(v.id, { retain: e.target.checked })}
                          />
                        </td>
                      )}
                      {showHmi && (
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={v.visible !== false}
                            disabled={readOnly}
                            title={t.visibleTip}
                            onChange={e => patch(v.id, { visible: e.target.checked })}
                          />
                        </td>
                      )}
                      {showHmi && (
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={v.writable !== false}
                            disabled={readOnly}
                            title={t.writableTip}
                            onChange={e => patch(v.id, { writable: e.target.checked })}
                          />
                        </td>
                      )}
                      <td className={CELL}>
                        <input
                          className={input('text-gray-600')}
                          value={v.comment ?? ''}
                          readOnly={readOnly}
                          placeholder={t.commentPlaceholder}
                          onChange={e => patch(v.id, { comment: e.target.value })}
                        />
                      </td>
                      <td className="px-1 text-center">
                        {!readOnly && (
                          <button
                            className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-600"
                            title={t.deleteRow}
                            onClick={() => remove(v.id)}
                          >
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {!isClosed && !readOnly && (
                  <tr>
                    <td />
                    <td className="px-1 py-1" colSpan={9}>
                      <button
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded
                          text-blue-700 hover:bg-blue-50"
                        onClick={() => addRow(section)}
                      >
                        <PlusIcon className="w-3 h-3" /> {t.addTo} {sectionLabel(t, section)}
                      </button>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {/* One list for every type cell on the page. A datalist is the native
          combo box: it suggests without preventing, which is what a type cell
          needs — `Array[1..10] of Real` is valid and is in no list. */}
      <datalist id="plc-data-types">
        {typeOptions.map(t => <option key={t} value={t} />)}
      </datalist>

      {block.interface.length === 0 && (
        <p className="px-3 py-4 text-[11px] text-gray-500 italic">
          {block.kind === 'DB' ? t.nothingDeclaredDb
            : block.kind === 'UDT' ? t.nothingDeclaredUdt
              : block.kind === 'OB' ? t.nothingDeclaredOb
                : t.nothingDeclaredFb}
        </p>
      )}

      {menu && (
        <MenuBox x={menu.x} y={menu.y} className="z-[140] w-56 bg-white border border-gray-200 shadow-lg rounded-md py-1">
          <MenuItem
            icon={<PlusIcon className="w-3.5 h-3.5" />}
            label={t.insertRowBelow}
            onClick={() => {
              const v = block.interface.find(x => x.id === menu.varId);
              if (v) addRow(v.section, v.id);
              setMenu(null);
            }}
          />
          <MenuItem
            icon={<ArrowUpIcon className="w-3.5 h-3.5" />}
            label={t.moveUp}
            onClick={() => { move(menu.varId, -1); setMenu(null); }}
          />
          <MenuItem
            icon={<ArrowDownIcon className="w-3.5 h-3.5" />}
            label={t.moveDown}
            onClick={() => { move(menu.varId, 1); setMenu(null); }}
          />
          <div className="border-t border-gray-100 my-1" />
          <MenuItem
            icon={<TrashIcon className="w-3.5 h-3.5" />}
            label={t.deleteRow}
            danger
            onClick={() => { remove(menu.varId); setMenu(null); }}
          />
        </MenuBox>
      )}
    </div>
  );
};

const MenuItem: React.FC<{
  icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void;
}> = ({ icon, label, danger, onClick }) => (
  <button
    className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2
      hover:bg-gray-100 ${danger ? 'text-red-600' : ''}`}
    onClick={onClick}
  >
    {icon} {label}
  </button>
);
