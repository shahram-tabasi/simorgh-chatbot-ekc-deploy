import React, { useMemo, useState } from 'react';
import { LayoutGridIcon, XIcon } from 'lucide-react';
import type { DrawingEdits, ProjectData } from '../../types/project';
import { DrawingPage, nextName, pageKey } from '../../utils/cad/pages';
import { officeItems } from '../../utils/cad/officeSymbols';
import { LAYOUT_OF } from '../../utils/tiers';
import { S8_SECTION, PANEL_WIDTHS } from '../../utils/layout/layoutStandard';
import { ccsDevices, ccsInternalPages, layoutKindOf, planS8, s8FrontPages, type LayoutPage } from '../../utils/layout/layoutPages';

// Layout pages from the project: an LV switchgear's S8 front view, or a fixed
// panel's internal view, built to the office's standard and then drawn on like
// any other page. What was worked out is shown first — every feeder's drawer
// and where its size came from — so a wrong size is seen here, not at the
// panel shop.

interface Props {
  project: ProjectData;
  pages: DrawingPage[];
  edits?: DrawingEdits;
  onDone: (pages: DrawingPage[], edits: DrawingEdits, made: number) => void;
  onClose: () => void;
}

type Kind = 's8' | 'ccs';

export const LayoutFromProject: React.FC<Props> = ({ project, pages, edits, onDone, onClose }) => {
  const switchgears = useMemo(() => (project.equipments ?? [])
    .filter(eq => LAYOUT_OF[eq.type] === 'LV' && (eq.devices ?? []).length > 0), [project]);

  // FIX templates (CCS, OFF…) are fixed panels; the rest are S8 drawers.
  const kindOf = (id: string): Kind => {
    const eq = switchgears.find(e => e.id === id);
    return eq ? layoutKindOf(project, eq) : 's8';
  };

  const [chosen, setChosen] = useState<string>(switchgears[0]?.id ?? '');
  const [kind, setKind] = useState<Kind>(() => (switchgears[0] ? kindOf(switchgears[0].id) : 's8'));
  const [moduleMm, setModuleMm] = useState(S8_SECTION.moduleMm);
  const [busbarTop, setBusbarTop] = useState(S8_SECTION.busbarTop);
  const [ccsWidth, setCcsWidth] = useState(1000);
  const equipment = switchgears.find(e => e.id === chosen);
  const section = { ...S8_SECTION, moduleMm, busbarTop };

  const plan = useMemo(() => (equipment && kind === 's8' ? planS8(project, equipment, section) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, equipment, kind, moduleMm, busbarTop]);
  const devices = useMemo(() => (equipment && kind === 'ccs' ? ccsDevices(project, equipment) : []),
    [project, equipment, kind]);

  const built: LayoutPage[] = useMemo(() => {
    if (!equipment) return [];
    if (kind === 's8' && plan) return s8FrontPages(equipment, plan, section);
    const symbols = officeItems().filter(i => i.kind === 'old');
    return ccsInternalPages(equipment, devices, ccsWidth, symbols);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment, kind, plan, devices, ccsWidth]);

  const create = () => {
    if (!built.length) return;
    const next = [...pages];
    const nextEdits: DrawingEdits = { ...(edits ?? {}) };
    const now = new Date().toISOString();
    for (const page of built) {
      const made: DrawingPage = {
        id: `p${Date.now().toString(36)}${next.length.toString(36)}`,
        name: nextName(next, 'old'),
        description: `${page.name} · ${page.description}`,
        type: 'old',
        width: page.width,
        height: page.height,
        createdAt: now,
      };
      next.push(made);
      // A page somebody owns from here on, like the I/O pages: a later layout
      // makes new pages and never overwrites the work on these.
      nextEdits[pageKey(made.id)] = { shapes: page.shapes, drawnAs: 'page', editedAt: now };
    }
    onDone(next, nextEdits, built.length);
  };

  const input = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500';
  const chip = (on: boolean) => `px-3 py-1 rounded border text-sm ${on ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[320]" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-[960px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
              <LayoutGridIcon className="w-4 h-4" /> Layout from the project
            </h2>
            <p className="text-xs text-gray-600">
              SIVACON S8 front view from the drawer list, or a fixed panel’s internal view to the office’s layout standard (RE-TE-011-01).
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded text-gray-500 hover:bg-gray-100" title="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {switchgears.length === 0 ? (
            <p className="text-sm text-gray-600">No LV switchgear with feeder lines in this project yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2 text-gray-700">
                  Switchgear
                  <select className={input} value={chosen}
                    onChange={e => { setChosen(e.target.value); setKind(kindOf(e.target.value)); }}>
                    {switchgears.map(eq => <option key={eq.id} value={eq.id}>{eq.name} ({eq.devices.length})</option>)}
                  </select>
                </label>
                <button className={chip(kind === 's8')} onClick={() => setKind('s8')}
                  title="Withdrawable (OFW) — every feeder a drawer">S8 front view</button>
                <button className={chip(kind === 'ccs')} onClick={() => setKind('ccs')}
                  title="Fixed (CCS, OFF…) — mounting plates and ducts">Internal view (fixed)</button>
              </div>

              {kind === 's8' && plan && (
                <>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700">
                    <label className="flex items-center gap-2" title="S8 drawers go 100…700 mm: 2M…14M at 50 mm">
                      1M = <input type="number" className={`${input} w-20`} value={moduleMm}
                        onChange={e => setModuleMm(Math.max(10, Number(e.target.value) || 50))} /> mm
                    </label>
                    <label className="flex items-center gap-2" title="Main busbar compartment at the top of the section">
                      Busbar compartment <input type="number" className={`${input} w-20`} value={busbarTop}
                        onChange={e => setBusbarTop(Math.max(0, Number(e.target.value) || 0))} /> mm
                    </label>
                    <span className="text-gray-600">{plan.capacity}M per section · {plan.sections.length} section(s)</span>
                  </div>
                  {plan.unknown.length > 0 && (
                    <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      {plan.unknown.length} feeder(s) match no drawer in the assembly list and are drawn at 4M, shaded — choose their size on the line (SIZE) or in the list.
                    </p>
                  )}
                  <div className="border border-gray-200 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-gray-700">
                        <tr>{['Section', 'Feeder', 'Template', 'Size', 'From', 'Drawer', 'Why / check'].map(h =>
                          <th key={h} className="text-start font-medium px-2 py-1.5">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {plan.sections.flatMap(sec => sec.feeders.map(f => (
                          <tr key={f.row.id}>
                            <td className="px-2 py-1">+{sec.column}</td>
                            <td className="px-2 py-1 font-medium text-gray-900">{f.row.feederNo || '—'}</td>
                            <td className="px-2 py-1 text-gray-700">{f.row.templateName}</td>
                            <td className="px-2 py-1">{f.modules}M</td>
                            <td className="px-2 py-1 text-gray-600">{f.from === 'line' ? 'SIZE on the line' : f.from === 'list' ? 'assembly list' : f.from === 'acb' ? 'ACB — whole section' : <span className="text-amber-800">not found</span>}</td>
                            <td className="px-2 py-1 font-mono" title={f.drawer?.row.shortCode}>{f.drawer?.row.code ?? '—'}</td>
                            <td className="px-2 py-1 text-gray-600" title={f.drawer?.row.note}>
                              {f.drawer?.why.join(' · ')}
                              {f.drawer?.check.length ? <span className="text-amber-800"> · check: {f.drawer.check.join('; ')}</span> : null}
                            </td>
                          </tr>
                        )))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {kind === 'ccs' && (
                <>
                  <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700">
                    <label className="flex items-center gap-2">
                      Panel width
                      <select className={input} value={ccsWidth} onChange={e => setCcsWidth(Number(e.target.value))}>
                        {PANEL_WIDTHS.map(w => <option key={w} value={w}>{w} mm</option>)}
                      </select>
                    </label>
                    <span className="text-gray-600">{devices.length} device(s) from the feeders’ templates</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    Ducts: sides 60, MCB and relay rows 40, breaker and contactor rows 60, terminals 80 above / 60 between, the lowest terminals 300 mm off the floor. A device is drawn with the office’s layout symbol whose name carries its order code (e.g. “3RT2027”), else as a box of its catalogue size.
                  </p>
                </>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={create} disabled={built.length === 0}
            className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {built.length ? `Draw ${built.length} page${built.length === 1 ? '' : 's'}` : 'Draw the pages'}
          </button>
        </div>
      </div>
    </div>
  );
};
