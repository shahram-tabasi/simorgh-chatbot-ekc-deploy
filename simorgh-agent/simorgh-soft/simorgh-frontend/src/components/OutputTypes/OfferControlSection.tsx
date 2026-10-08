import React, { useMemo, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { ProjectData } from '../../types/project';
import { compareKinds, feedersPerTemplate, offerTemplates, priceOf } from '../../utils/offerControl';

// Offer against design: the control equipment each template's offer counted,
// beside what the design now has. Where the design has more, the offer did not
// price it — that is a claim. Read only here; the offer list is kept on the
// template (Offer control), and is never bought or sent to EPLAN.

export const OfferControlSection: React.FC<{ projectData: ProjectData; badge: string }> = ({ projectData, badge }) => {
  const [open, setOpen] = useState(false);
  const templates = useMemo(() => offerTemplates(projectData), [projectData]);
  const feeders = useMemo(() => feedersPerTemplate(projectData), [projectData]);
  const over = templates.reduce((n, t) => n + compareKinds(t).filter(k => k.design > k.offer).length, 0);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-3">
      <button className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
        onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">{badge}</span>
          <span className="font-medium text-sm text-gray-800">
            Offer control equipment ({templates.length} template{templates.length === 1 ? '' : 's'})
          </span>
          {over > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800">
              {over} more than the offer
            </span>
          )}
        </div>
        {open ? <ChevronDownIcon className="w-4 h-4 text-gray-400" /> : <ChevronRightIcon className="w-4 h-4 text-gray-400" />}
      </button>
      {open && (
        <div className="p-4 border-t border-gray-100 bg-white space-y-4">
          {templates.length === 0 ? (
            <p className="text-sm text-gray-600">
              No template has an offer list yet — add one with “Offer control” on the template’s page.
            </p>
          ) : templates.map(t => {
            const n = feeders.get(t.id) ?? 0;
            const kinds = compareKinds(t);
            const price = (t.offerControl ?? []).reduce((s, p) => {
              const v = priceOf(p);
              return v == null ? s : s + v * (Number(p.quantity) || 1);
            }, 0);
            return (
              <section key={t.id} className="border border-gray-200 rounded-md">
                <header className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-sm font-medium text-gray-800">{t.name} <span className="text-gray-500 font-normal">· {t.type} · {n} feeder{n === 1 ? '' : 's'}</span></h4>
                  <p className="text-xs text-gray-600">
                    Offer: {(t.offerControl ?? []).map(p => `${p.quantity}× ${p.partNumber}`).join(', ')}
                    {price > 0 && <> · {price.toLocaleString()} per feeder</>}
                  </p>
                </header>
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 text-gray-700">
                    <tr>{['Kind', 'Offer / feeder', 'Design / feeder', 'Offer total', 'Design total', ''].map(h =>
                      <th key={h} className="text-start font-medium px-3 py-1.5">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {kinds.map(k => (
                      <tr key={k.kind}>
                        <td className="px-3 py-1.5 text-gray-800">{k.kind}</td>
                        <td className="px-3 py-1.5">{k.offer}</td>
                        <td className="px-3 py-1.5">{k.design}</td>
                        <td className="px-3 py-1.5">{k.offer * n}</td>
                        <td className="px-3 py-1.5">{k.design * n}</td>
                        <td className="px-3 py-1.5">
                          {k.design > k.offer
                            ? <span className="text-amber-800">+{(k.design - k.offer) * n} more than the offer — claim</span>
                            : k.design < k.offer
                              ? <span className="text-gray-600">{(k.offer - k.design) * n} fewer than the offer</span>
                              : <span className="text-green-700">as offered</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
