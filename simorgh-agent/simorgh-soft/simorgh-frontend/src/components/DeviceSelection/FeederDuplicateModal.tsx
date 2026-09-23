import React, { useMemo, useState } from 'react';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import { DuplicateGroup, countDuplicateRows } from '../../utils/feederDuplicates';
import { type Tier, TIER_PILL } from '../../utils/tiers';

interface FeederDuplicateModalProps {
  groups: DuplicateGroup[];
  /** Every feeder number already in use, per equipment id — so a value typed
   *  here can be checked against rows that aren't listed in the dialog. */
  usedByEquipment: Record<string, string[]>;
  /** Write the corrections back to the project. Keyed by row id. */
  onApply: (edits: Record<string, string>) => void;
  /** Leave the tab without changing anything. */
  onIgnore: () => void;
  /** Stay on Device Selection and fix it there. */
  onCancel: () => void;
}

// Raised when leaving Device Selection with two rows of one switchgear sharing
// a FEEDER NO. It shows exactly which rows collide and lets the user fix them
// right here — what they type is written back to the table — or step past it,
// or go back and sort it out on the tab itself.
export const FeederDuplicateModal: React.FC<FeederDuplicateModalProps> = ({
  groups, usedByEquipment, onApply, onIgnore, onCancel,
}) => {
  // rowId → the value typed in this dialog (absent = leave the row alone).
  const [edits, setEdits] = useState<Record<string, string>>({});

  const valueFor = (rowId: string, original: string) =>
    edits[rowId] !== undefined ? edits[rowId] : original;

  // What the table would look like if the dialog's edits were applied: for
  // each equipment, how many rows would end up on each feeder number.
  const countsAfterEdits = useMemo(() => {
    const counts: Record<string, Record<string, number>> = {};
    const editedRowIds = new Set(Object.keys(edits));

    for (const [equipmentId, feeders] of Object.entries(usedByEquipment)) {
      counts[equipmentId] = {};
      // rows that the dialog isn't touching
      const rowsInDialog = new Map<string, string>();
      for (const g of groups) {
        if (g.equipmentId !== equipmentId) continue;
        for (const r of g.rows) rowsInDialog.set(r.rowId, r.feederNo);
      }
      // `feeders` is every value in the equipment, in row order; the dialog's
      // rows are replaced by whatever is typed, the rest counted as they are.
      for (const value of feeders) {
        const key = value.trim().toLowerCase();
        if (!key) continue;
        counts[equipmentId][key] = (counts[equipmentId][key] ?? 0) + 1;
      }
      // undo the dialog rows, then re-add them with their current value
      for (const [rowId, original] of rowsInDialog) {
        const oldKey = original.trim().toLowerCase();
        if (counts[equipmentId][oldKey]) counts[equipmentId][oldKey] -= 1;
        const next = (editedRowIds.has(rowId) ? edits[rowId] : original).trim().toLowerCase();
        if (!next) continue;
        counts[equipmentId][next] = (counts[equipmentId][next] ?? 0) + 1;
      }
    }
    return counts;
  }, [edits, groups, usedByEquipment]);

  const stillClashing = (equipmentId: string, value: string) => {
    const key = value.trim().toLowerCase();
    if (!key) return false; // an empty feeder number is unfinished, not a clash
    return (countsAfterEdits[equipmentId]?.[key] ?? 0) > 1;
  };

  const unresolved = groups.reduce((sum, g) =>
    sum + g.rows.filter(r => stillClashing(g.equipmentId, valueFor(r.rowId, r.feederNo))).length, 0);

  const totalRows = countDuplicateRows(groups);
  const hasEdits = Object.keys(edits).length > 0;

  const typeColor = (t: Tier) => TIER_PILL[t] ?? TIER_PILL.OTHER;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100] p-6">
      <div className="bg-white rounded-lg shadow-2xl w-[760px] max-w-full max-h-[88vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b bg-amber-50 rounded-t-lg">
          <div className="flex items-start gap-3">
            <AlertTriangleIcon className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-lg text-amber-900">Duplicate FEEDER NO.</h3>
              <p className="text-sm text-amber-800 mt-0.5">
                {groups.length} feeder number{groups.length === 1 ? '' : 's'} used more than once, on {totalRows} rows.
              </p>
            </div>
          </div>
          <button className="p-1 hover:bg-amber-100 rounded" onClick={onCancel} title="Back to Device Selection">
            <XIcon className="w-5 h-5 text-amber-600" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <p className="text-sm text-gray-700">
            Two rows of the same switchgear carry the same FEEDER NO. Correct them here — the
            change is written straight into the table — or continue and fix them later.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-4">
          {groups.map(group => (
            <div key={`${group.equipmentId}-${group.feederNo}`} className="border border-gray-200 rounded">
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b text-sm">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${typeColor(group.equipmentType)}`}>
                  {group.equipmentType}
                </span>
                <span className="font-medium text-gray-800">{group.equipmentName}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-700">
                  FEEDER NO. <strong>{group.feederNo}</strong> on {group.rows.length} rows
                </span>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500">
                    <th className="px-3 py-1.5 text-left font-medium w-16">Row</th>
                    <th className="px-3 py-1.5 text-left font-medium w-36">Template</th>
                    <th className="px-3 py-1.5 text-left font-medium w-20">Bus</th>
                    <th className="px-3 py-1.5 text-left font-medium">Description</th>
                    <th className="px-3 py-1.5 text-left font-medium w-40">FEEDER NO.</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(row => {
                    const value = valueFor(row.rowId, row.feederNo);
                    const clashing = stillClashing(group.equipmentId, value);
                    return (
                      <tr key={row.rowId} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 text-gray-500">{row.rowNumber}</td>
                        <td className="px-3 py-1.5 text-gray-800 truncate">{row.templateName || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600">{row.busSection || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600 truncate" title={row.description}>
                          {row.description || '—'}
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            className={`w-full border rounded px-2 py-1 text-sm focus:outline-none ${
                              clashing
                                ? 'border-red-400 bg-red-50 text-red-800 focus:border-red-500'
                                : 'border-green-400 bg-green-50 text-green-800 focus:border-green-500'
                            }`}
                            value={value}
                            onChange={e => setEdits(prev => ({ ...prev, [row.rowId]: e.target.value }))}
                            title={clashing ? 'Still used by another row in this switchgear' : 'Free'}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t bg-gray-50 rounded-b-lg">
          <span className="text-xs text-gray-500">
            {unresolved === 0
              ? 'No duplicates left — apply to write the changes back.'
              : `${unresolved} row${unresolved === 1 ? '' : 's'} still share a number.`}
          </span>
          <div className="flex gap-2">
            <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onCancel}>
              Back to the table
            </button>
            <button
              className="px-4 py-2 border border-amber-300 text-amber-800 rounded text-sm hover:bg-amber-50"
              onClick={onIgnore}
            >
              Continue anyway
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-40"
              disabled={!hasEdits}
              onClick={() => onApply(edits)}
            >
              Apply &amp; continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
