import React, { useMemo, useState } from 'react';
import { LayoutGridIcon, XIcon } from 'lucide-react';
import type { DrawingEdits, ProjectData } from '../../types/project';
import { DrawingPage, nextName, pageKey } from '../../utils/cad/pages';
import { officeItems } from '../../utils/cad/officeSymbols';
import { LAYOUT_OF } from '../../utils/tiers';
import { PANEL_WIDTHS } from '../../utils/layout/layoutStandard';
import { VERTICAL_BUSBAR, type S8System } from '../../utils/layout/s8Catalogue';
import { ccsDevices, ccsInternalPages, layoutKindOf, planS8, s8FrontPages, systemOf, type LayoutPage } from '../../utils/layout/layoutPages';

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
  // What the room and the board are — read from the switchgear's scope
  // (design temperature, IP, busbar configuration), changed here per drawing.
  const [sysEdit, setSysEdit] = useState<Partial<S8System>>({});
  const [ccsWidth, setCcsWidth] = useState<number | 'auto'>('auto');
  const equipment = switchgears.find(e => e.id === chosen);
  const system: S8System | null = equipment ? { ...systemOf(project, equipment), ...sysEdit } : null;
  const setSys = (patch: Partial<S8System>) => setSysEdit(prev => ({ ...prev, ...patch }));

  const plan = useMemo(() => (equipment && kind === 's8' ? planS8(project, equipment, sysEdit) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, equipment, kind, sysEdit]);
  const devices = useMemo(() => (equipment && kind === 'ccs' ? ccsDevices(project, equipment) : []),
    [project, equipment, kind]);

  const built: LayoutPage[] = useMemo(() => {
    if (!equipment) return [];
    if (kind === 's8' && plan) return s8FrontPages(equipment, plan);
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
                  {system && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-700"
                      title="SIVACON S8 Technical Planning Information 10/2015: ratings at 35 °C, converted to the room's temperature">
                      <label className="flex items-center gap-2">
                        Room <input type="number" className={`${input} w-16`} value={system.ambient}
                          onChange={e => setSys({ ambient: Number(e.target.value) || 35 })} /> °C
                      </label>
                      <label className="flex items-center gap-2">
                        <select className={input} value={system.ventilated ? 'v' : 'n'} onChange={e => setSys({ ventilated: e.target.value === 'v' })}>
                          <option value="v">Ventilated (≤ IP43)</option>
                          <option value="n">Non-ventilated (IP54)</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        Frame
                        <select className={input} value={system.frame} onChange={e => setSys({ frame: Number(e.target.value) as 2000 | 2200 })}>
                          <option value={2200}>2200</option><option value={2000}>2000</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        Base
                        <select className={input} value={system.base} onChange={e => setSys({ base: Number(e.target.value) as 0 | 100 | 200 })}>
                          {[0, 100, 200].map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        Main busbar
                        <select className={input} value={system.busbar} onChange={e => setSys({ busbar: e.target.value as 'top' | 'rear' })}>
                          <option value="top">Top</option><option value="rear">Rear</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={system.doubleBusbar} onChange={e => setSys({ doubleBusbar: e.target.checked })} />
                        Double busbar
                      </label>
                      <label className="flex items-center gap-2">
                        Distribution busbar
                        <select className={input} value={system.verticalBusbar} onChange={e => setSys({ verticalBusbar: Number(e.target.value) })}>
                          {VERTICAL_BUSBAR.map((v, i) => <option key={v.name} value={i}>{v.name}</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                  <p className="text-sm text-gray-700">
                    {plan.sections.length} cubicle(s) · {plan.capacity}M a drawer cubicle · main busbar {plan.mainBusbar ? `${plan.mainBusbar.rated} A (${plan.mainBusbar.at} A at ${plan.system.ambient} °C)` : '—'} for {plan.mainAmps} A · depth {plan.depth} mm
                  </p>
                  {plan.warnings.length > 0 && (
                    <ul className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 list-disc list-inside space-y-0.5">
                      {plan.warnings.map(w => <li key={w}>{w}</li>)}
                    </ul>
                  )}
                  {plan.unknown.length > 0 && (
                    <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                      {plan.unknown.length} feeder(s) match no drawer in the assembly list and are drawn at 4M, shaded — choose their size on the line (SIZE) or in the list.
                    </p>
                  )}
                  <div className="border border-gray-200 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-gray-700">
                        <tr>{['Pos.', 'Feeder', 'Template', 'Size', 'From', 'Drawer', 'Why / check'].map(h =>
                          <th key={h} className="text-start font-medium px-2 py-1.5">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {plan.sections.flatMap(sec => sec.feeders.map(f => (
                          <tr key={f.row.id}>
                            <td className="px-2 py-1">{f.pos}</td>
                            <td className="px-2 py-1 font-medium text-gray-900">{f.row.feederNo || '—'}</td>
                            <td className="px-2 py-1 text-gray-700">{f.row.templateName}</td>
                            <td className="px-2 py-1">{f.modules}M</td>
                            <td className="px-2 py-1 text-gray-600">{f.from === 'line' ? 'SIZE on the line' : f.from === 'list' ? 'assembly list' : f.from === 'catalogue' ? 'S8 catalogue minimum' : f.from === 'acb' ? `ACB — ${sec.kind} cubicle ${sec.width}` : <span className="text-amber-800">not found</span>}</td>
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
                      <select className={input} value={ccsWidth}
                        onChange={e => setCcsWidth(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
                        <option value="auto">Auto — narrowest with 20 % spare</option>
                        {PANEL_WIDTHS.map(w => <option key={w} value={w}>{w} mm</option>)}
                      </select>
                    </label>
                    <span className="text-gray-600">{devices.length} device(s) from the feeders’ templates</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    Ducts: sides 60, MCB and relay rows 40, breaker and contactor rows 60, terminals 80 above / 60 between, the lowest terminals 300 mm off the floor. 20 % of the mounting plate left spare (B20); the incoming breaker at the top beside the busbar, 80 mm from the side up to 250 A, 105 mm from 315 A (B29). A device is drawn with the office’s layout symbol whose name carries its order code (e.g. “3RT2027”), else as a box of its catalogue size.
                  </p>
                  {built[0]?.notes?.length ? (
                    <ul className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 list-disc list-inside space-y-0.5">
                      {built[0].notes.map(n => <li key={n}>{n}</li>)}
                    </ul>
                  ) : null}
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
