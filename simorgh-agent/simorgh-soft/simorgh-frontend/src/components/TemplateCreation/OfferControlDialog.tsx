import React from 'react';
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react';
import type { OfferControlPart } from '../../types/project';
import { controlKind, priceOf } from '../../utils/offerControl';
import { stripLocaleTags } from '../../utils/tierEquipmentMatrix';

// The offer's control equipment for one template — the MCBs, relays and the
// rest the quotation counted. Its own window so the template's table stays as
// it is: these parts size the first drawer and price the offer, and are not
// bought or sent to EPLAN. The engineer checks them against the design in the
// Output tab.

interface Props {
  templateName: string;
  parts: OfferControlPart[];
  canEdit: boolean;
  onChange: (next: OfferControlPart[]) => void;
  onAdd: () => void;
  onClose: () => void;
}

export const OfferControlDialog: React.FC<Props> = ({ templateName, parts, canEdit, onChange, onAdd, onClose }) => {
  const set = (i: number, patch: Partial<OfferControlPart>) =>
    onChange(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const total = parts.reduce((sum, p) => {
    const price = priceOf(p);
    return price == null ? sum : sum + price * (Number(p.quantity) || 1);
  }, 0);
  const input = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-[820px] max-w-[95vw] max-h-[88vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-800">Offer control equipment — {templateName}</h2>
            <p className="text-xs text-gray-600">
              What the offer counted per feeder. Sizes the first drawer and prices the offer; not bought, not sent to EPLAN. Checked against the design in the Output tab.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-500 hover:bg-gray-100" title="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {parts.length === 0 ? (
            <p className="text-sm text-gray-600">No control parts on the offer yet.</p>
          ) : (
            <table className="w-full text-sm border border-gray-200">
              <thead className="bg-gray-100 text-gray-700">
                <tr>
                  {['Part', 'Description', 'Kind', 'Qty / feeder', 'Price', ''].map(h =>
                    <th key={h} className="text-start font-medium px-3 py-1.5">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {parts.map((p, i) => {
                  const price = priceOf(p);
                  return (
                    <tr key={i}>
                      <td className="px-3 py-1.5 font-mono text-gray-900">{p.partNumber}</td>
                      <td className="px-3 py-1.5 text-gray-600">{stripLocaleTags(p.fullData?.Designation1) || p.label || ''}</td>
                      <td className="px-3 py-1.5 text-gray-600">{controlKind(p)}</td>
                      <td className="px-3 py-1.5">
                        <input type="number" min={1} className={`${input} w-20`} value={p.quantity} disabled={!canEdit}
                          onChange={e => set(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                      </td>
                      <td className="px-3 py-1.5 text-gray-700">{price == null ? '—' : price.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Remove from the offer"
                          disabled={!canEdit} onClick={() => onChange(parts.filter((_, j) => j !== i))}>
                          <Trash2Icon className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {total > 0 && (
            <p className="mt-2 text-sm text-gray-700">Per feeder, from the prices the parts carry: <b>{total.toLocaleString()}</b></p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
          <button onClick={onAdd} disabled={!canEdit}
            className="flex items-center gap-1.5 px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50">
            <PlusIcon className="w-4 h-4" /> Add part
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
