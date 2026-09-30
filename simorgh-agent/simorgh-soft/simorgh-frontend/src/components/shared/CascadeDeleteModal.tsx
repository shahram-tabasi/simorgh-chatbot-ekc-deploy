import React from 'react';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import { UsageReport } from '../../utils/cascadeDelete';
import { TIER_PILL, type Tier } from '../../utils/tiers';

interface CascadeDeleteModalProps {
  /** What is being deleted, e.g. the device or template name. */
  itemName: string;
  /** Short kind label shown in the title, e.g. "Device" / "Template". */
  itemKind: string;
  /** Where the item is currently used. */
  usage: UsageReport;
  /** English + Persian sentence describing what the delete cascades to. */
  cascadeNote: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Full-information delete confirmation: before anything is removed the user
// sees every place the item is used and exactly what the delete will take
// with it.
export const CascadeDeleteModal: React.FC<CascadeDeleteModalProps> = ({
  itemName, itemKind, usage, cascadeNote, onConfirm, onCancel,
}) => {
  const isUsed = usage.equipments.length > 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
      <div className="bg-white rounded-lg shadow-2xl w-[560px] max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b bg-red-50 rounded-t-lg">
          <div className="flex items-start gap-3">
            <AlertTriangleIcon className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-lg text-red-800">Delete {itemKind}</h3>
              <p className="text-sm text-red-700 mt-0.5">{itemName}</p>
            </div>
          </div>
          <button className="p-1 hover:bg-red-100 rounded" onClick={onCancel}>
            <XIcon className="w-5 h-5 text-red-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-4">
          {isUsed ? (
            <>
              <div>
                <p className="text-sm font-semibold text-gray-800">
                  This {itemKind.toLowerCase()} is currently used in {usage.equipments.length} place
                  {usage.equipments.length === 1 ? '' : 's'} ({usage.totalRows} device row
                  {usage.totalRows === 1 ? '' : 's'}):
                </p>
                <p className="text-sm text-gray-600 mt-1" dir="rtl">
                  Used in {usage.equipments.length} place(s), across {usage.totalRows} row(s):
                </p>
              </div>

              <div className="border border-gray-200 rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600 border-b">Equipment</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600 border-b w-20">Type</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600 border-b w-24">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.equipments.map(eq => (
                      <tr key={eq.id} className="border-b last:border-b-0">
                        <td className="px-3 py-1.5 text-gray-800">{eq.name}</td>
                        <td className="px-3 py-1.5">
                          <span className={`text-xs px-2 py-0.5 rounded font-semibold ${
                            TIER_PILL[eq.type as Tier] ?? TIER_PILL.OTHER
                          }`}>{eq.type}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{eq.rowCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2">
                <p className="text-sm text-amber-900">{cascadeNote}</p>
              </div>
            </>
          ) : (
            <div>
              <p className="text-sm text-gray-700">
                This {itemKind.toLowerCase()} is not used anywhere in the project. Deleting it affects nothing else.
              </p>
              <p className="text-sm text-gray-600 mt-1" dir="rtl">
                This is not used anywhere in the project, so deleting it changes nothing else.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
          <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700"
            onClick={onConfirm}
          >
            {isUsed ? 'Delete everywhere' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};
