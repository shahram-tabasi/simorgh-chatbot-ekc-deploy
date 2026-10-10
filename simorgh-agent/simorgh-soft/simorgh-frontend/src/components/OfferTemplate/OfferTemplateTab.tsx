import React, { useEffect, useMemo, useState } from 'react';
import {
  GripVerticalIcon, PlusIcon, SearchIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon,
  CopyIcon, ClipboardPasteIcon, ReplaceIcon,
} from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { PanelFrame } from '../shared/PanelFrame';
import { TemplateTree } from '../TemplateCreation/TemplateTree';
import { PartSelectionDialog, templateSectionClip } from '../TemplateCreation/TemplateProperties';
import {
  kindOfHeader, offerClip, onOfferClip, setOfferClip, shareTemplate, sharedTemplate, simTableOf,
} from '../../utils/offerTemplate';
import type { OfferTemplatePart, OfferTemplateSection, TemplateItem } from '../../types/project';
import { LAYOUT_OF, TIERS } from '../../utils/tiers';
import {
  HV_TEMPLATE_PROPERTIES, LV_TEMPLATE_PROPERTIES, MV_TEMPLATE_PROPERTIES, stripLocaleTags,
} from '../../utils/tierEquipmentMatrix';

// The offer version of a template.
//
// Create Template is exact: fixed headers, the very devices that are bought
// and drawn. An offer is general — so here the headers are a short list at
// the side, as the templates are on Scope Selection: drag one into the page
// (or click it), give it parts there, drag the headers and the parts about
// to put them in order. The same templates as Create Template, from the same
// tree; what is set here is kept on the template beside its rows
// (TemplateItem.offerTemplate) and never touches them. No mechanical
// questions, no cell type, no template graphic.

const DRAG_HEADER = 'application/x-offer-header';
const DRAG_SECTION = 'application/x-offer-section';
const DRAG_PART = 'application/x-offer-part';

const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** The headers a template of this tier offers, without the spare rows. */
function headersFor(type: TemplateItem['type']): string[] {
  const layout = LAYOUT_OF[type];
  const list = layout === 'MV' ? MV_TEMPLATE_PROPERTIES : layout === 'HV' ? HV_TEMPLATE_PROPERTIES : LV_TEMPLATE_PROPERTIES;
  return list.filter(h => !/^SPARE\b/i.test(h));
}

export const OfferTemplateTab: React.FC<{ onComplete?: () => void }> = ({ onComplete }) => {
  const { projectData, patchProjectData, isCurrentRevisionEditable } = useProject();
  // The template open in Create Template is the one open here, and back.
  const [selectedId, setSelectedIdState] = useState<string | null>(sharedTemplate);
  const setSelectedId = (id: string | null) => { shareTemplate(id); setSelectedIdState(id); };
  const [clip, setClip] = useState(offerClip);
  useEffect(() => onOfferClip(() => setClip(offerClip())), []);
  const [customHeader, setCustomHeader] = useState('');
  const [customHeaders, setCustomHeaders] = useState<string[]>([]);
  const [picking, setPicking] = useState<{ section: string; part?: string } | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);

  const template = useMemo(() => {
    if (!selectedId || !projectData) return null;
    for (const type of TIERS) {
      const t = (projectData.templates?.[type] ?? []).find(x => x.id === selectedId);
      if (t) return t;
    }
    return null;
  }, [projectData, selectedId]);

  if (!projectData) {
    return <div className="flex items-center justify-center h-48 text-gray-500">Project data is not available.</div>;
  }

  const canEdit = Boolean(isCurrentRevisionEditable);
  const sections: OfferTemplateSection[] = template?.offerTemplate ?? [];

  const save = (next: OfferTemplateSection[]) => {
    if (!template || !canEdit) return;
    patchProjectData(prev => ({
      templates: {
        ...prev.templates,
        [template.type]: (prev.templates?.[template.type] ?? []).map(t =>
          (t.id === template.id ? { ...t, offerTemplate: next } : t)),
      },
    }));
  };

  // Headers other templates of the project already use, so a custom one is
  // there to drag again.
  const projectHeaders = Array.from(new Set(TIERS.flatMap(t => projectData.templates?.[t] ?? [])
    .flatMap(t => (t.offerTemplate ?? []).map(s => s.header))));
  const sideHeaders = template
    ? Array.from(new Set([...headersFor(template.type), ...projectHeaders, ...customHeaders]))
    : [];

  const addSection = (header: string, before?: string) => {
    const h = header.trim();
    if (!h) return;
    const section: OfferTemplateSection = { id: newId('sec'), header: h, parts: [] };
    const at = before ? sections.findIndex(s => s.id === before) : -1;
    save(at < 0 ? [...sections, section] : [...sections.slice(0, at), section, ...sections.slice(at)]);
  };
  const moveSection = (id: string, before?: string) => {
    if (id === before) return;
    const moving = sections.find(s => s.id === id);
    if (!moving) return;
    const rest = sections.filter(s => s.id !== id);
    const at = before ? rest.findIndex(s => s.id === before) : -1;
    save(at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]);
  };
  const shift = (id: string, by: -1 | 1) => {
    const i = sections.findIndex(s => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const setSection = (id: string, patch: Partial<OfferTemplateSection>) =>
    save(sections.map(s => (s.id === id ? { ...s, ...patch } : s)));
  const setPart = (sid: string, pid: string, patch: Partial<OfferTemplatePart>) =>
    save(sections.map(s => (s.id === sid
      ? { ...s, parts: s.parts.map(p => (p.id === pid ? { ...p, ...patch } : p)) } : s)));
  const addPart = (sid: string, part?: Partial<OfferTemplatePart>) =>
    save(sections.map(s => (s.id === sid
      ? { ...s, parts: [...s.parts, { id: newId('part'), description: '', quantity: 1, ...part }] } : s)));
  /** A part dragged onto another section, or onto another part (before it). */
  const movePart = (pid: string, toSection: string, before?: string) => {
    let moving: OfferTemplatePart | undefined;
    const without = sections.map(s => {
      const found = s.parts.find(p => p.id === pid);
      if (found) moving = found;
      return { ...s, parts: s.parts.filter(p => p.id !== pid) };
    });
    if (!moving) return;
    save(without.map(s => {
      if (s.id !== toSection) return s;
      const at = before ? s.parts.findIndex(p => p.id === before) : -1;
      return { ...s, parts: at < 0 ? [...s.parts, moving!] : [...s.parts.slice(0, at), moving!, ...s.parts.slice(at)] };
    }));
  };

  const onPicked = (part: any) => {
    if (!picking) return;
    // The description is the part's SIM-TABLE, as Create Template writes
    // it; the EKC NUMBER is its type number.
    const fill: Partial<OfferTemplatePart> = {
      partNumber: String(part?.TypeNumber ?? '').trim(),
      description: simTableOf(part) || stripLocaleTags(part?.Designation1) || String(part?.PartNumber ?? ''),
      fullData: part,
    };
    if (picking.part) setPart(picking.section, picking.part, fill);
    else addPart(picking.section, fill);
    setPicking(null);
  };

  // ── Copy, paste, replace ────────────────────────────────────────────────
  const fresh = (p: OfferTemplatePart): OfferTemplatePart =>
    ({ ...JSON.parse(JSON.stringify(p)), id: `part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
  /** What there is to paste: a part or a header copied here, or a section
   *  copied in Create Template, read as offer parts. */
  const pasteable = (): { from: string; parts: OfferTemplatePart[] } | null => {
    if (clip) return clip;
    const tc = templateSectionClip();
    if (!tc || !tc.parts.length) return null;
    return {
      from: `${tc.label} in ${tc.templateName}`,
      parts: tc.parts.map((p: any) => ({
        id: '', description: p.simTableOverride || simTableOf(p.fullData) || p.partNumber || '',
        partNumber: String(p.fullData?.TypeNumber ?? '').trim(), quantity: Number(p.quantity) || 1,
        ...(p.fullData ? { fullData: p.fullData } : {}),
      })),
    };
  };
  const paste = (sid: string) => {
    const c = pasteable();
    if (!c) return;
    save(sections.map(s => (s.id === sid ? { ...s, parts: [...s.parts, ...c.parts.map(fresh)] } : s)));
  };
  const replaceWithClip = (sid: string, pid: string) => {
    const c = pasteable();
    if (!c || !c.parts.length) return;
    const { id: _id, ...with_ } = fresh(c.parts[0]);
    setPart(sid, pid, with_);
  };

  /** What a drop on a section (or before one) does, by what was dragged. */
  const dropOn = (e: React.DragEvent, sectionId?: string, beforePart?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropAt(null);
    if (!canEdit || !template) return;
    const header = e.dataTransfer.getData(DRAG_HEADER);
    const sec = e.dataTransfer.getData(DRAG_SECTION);
    const part = e.dataTransfer.getData(DRAG_PART);
    if (header) addSection(header, sectionId);
    else if (sec) moveSection(sec, sectionId);
    else if (part && sectionId) movePart(part, sectionId, beforePart);
  };
  const allowDrop = (key: string) => (e: React.DragEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    setDropAt(key);
  };

  const input = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50';
  const partCount = sections.reduce((n, s) => n + s.parts.length, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-grow min-h-0 border border-gray-200 rounded-md overflow-hidden bg-white">
        <PanelFrame
          id="offer-templates"
          title="Project Templates"
          group="Offer Template"
          note="The same templates as Create Template — pick one to give it its offer version"
          side="left"
          className="w-1/5 border-0 border-r border-gray-200 rounded-none"
          bodyClassName="flex-1 overflow-y-auto"
        >
          <TemplateTree bare offerMode projectData={projectData} onTemplateSelect={setSelectedId} selectedTemplateId={selectedId} />
        </PanelFrame>

        <PanelFrame
          id="offer-headers"
          title="Headers"
          group="Offer Template"
          note="Drag a header into the page, or click it to add it at the end"
          side="left"
          className="w-[210px] border-0 border-r border-gray-200 rounded-none"
          bodyClassName="flex-1 overflow-y-auto"
        >
          <div className="p-2 space-y-1">
            {!template && <p className="text-xs text-gray-500 p-1">Pick a template first.</p>}
            {sideHeaders.map(h => (
              <div
                key={h}
                draggable={canEdit}
                onDragStart={e => { e.dataTransfer.setData(DRAG_HEADER, h); e.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => canEdit && addSection(h)}
                title={canEdit ? 'Drag into the page, or click to add at the end' : 'This revision is read-only'}
                className="flex items-center gap-1.5 p-1.5 text-xs bg-white border border-gray-200 rounded cursor-move hover:bg-blue-50 select-none text-gray-800"
              >
                <GripVerticalIcon className="w-3 h-3 text-gray-500 shrink-0" />
                <span className="truncate">{h}</span>
              </div>
            ))}
            {template && (
              <form
                className="pt-2 flex gap-1"
                onSubmit={e => {
                  e.preventDefault();
                  const h = customHeader.trim();
                  if (!h) return;
                  setCustomHeaders(list => (list.includes(h) ? list : [...list, h]));
                  setCustomHeader('');
                }}
              >
                <input
                  value={customHeader}
                  onChange={e => setCustomHeader(e.target.value)}
                  placeholder="New header…"
                  className={`${input} w-full text-xs`}
                  disabled={!canEdit}
                />
                <button type="submit" disabled={!canEdit || !customHeader.trim()} title="Add to the list"
                  className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50">
                  <PlusIcon className="w-4 h-4" />
                </button>
              </form>
            )}
          </div>
        </PanelFrame>

        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4">
          {!template ? (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              Select a template from the tree to build its offer version
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">{template.name}</h2>
                  <p className="text-xs text-gray-600">
                    {template.type} · offer version · {sections.length} header{sections.length === 1 ? '' : 's'}, {partCount} part{partCount === 1 ? '' : 's'}.
                    {' '}Kept beside the template's rows; Create Template, purchasing and Send to EPLAN are not affected.
                  </p>
                </div>
                {!canEdit && <span className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">Read-only revision</span>}
              </div>

              {sections.map((s, si) => (
                <div
                  key={s.id}
                  onDragOver={allowDrop(s.id)}
                  onDragLeave={() => setDropAt(d => (d === s.id ? null : d))}
                  onDrop={e => dropOn(e, s.id)}
                  className={`border rounded-md bg-white ${dropAt === s.id ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200'}`}
                >
                  <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-md">
                    <span
                      draggable={canEdit}
                      onDragStart={e => { e.dataTransfer.setData(DRAG_SECTION, s.id); e.dataTransfer.effectAllowed = 'move'; }}
                      title="Drag to move this header"
                      className="cursor-move text-gray-500"
                    >
                      <GripVerticalIcon className="w-4 h-4" />
                    </span>
                    <input
                      value={s.header}
                      onChange={e => setSection(s.id, { header: e.target.value })}
                      disabled={!canEdit}
                      className="flex-1 min-w-0 bg-transparent text-sm font-semibold text-gray-800 focus:outline-none focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-1"
                    />
                    <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Move up"
                      disabled={!canEdit || si === 0} onClick={() => shift(s.id, -1)}><ChevronUpIcon className="w-4 h-4" /></button>
                    <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Move down"
                      disabled={!canEdit || si === sections.length - 1} onClick={() => shift(s.id, 1)}><ChevronDownIcon className="w-4 h-4" /></button>
                    <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title={`Copy the parts of ${s.header}`}
                      disabled={s.parts.length === 0} onClick={() => setOfferClip({ from: `${s.header} in ${template.name}`, parts: s.parts })}>
                      <CopyIcon className="w-4 h-4" /></button>
                    <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                      title={pasteable() ? `Paste ${pasteable()!.parts.length} part(s) — ${pasteable()!.from}` : 'Nothing copied'}
                      disabled={!canEdit || !pasteable()} onClick={() => paste(s.id)}>
                      <ClipboardPasteIcon className="w-4 h-4" /></button>
                    <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Remove this header and its parts"
                      disabled={!canEdit} onClick={() => save(sections.filter(x => x.id !== s.id))}><Trash2Icon className="w-4 h-4" /></button>
                  </div>

                  <div className="p-2">
                    {s.parts.length > 0 && (
                      <table className="w-full text-sm table-fixed">
                        <thead className="text-gray-600 text-xs">
                          <tr>
                            <th className="w-6" />
                            <th className="text-start font-medium px-1 py-1">Description</th>
                            <th className="text-start font-medium px-1 py-1 w-[22%]">EKC NUMBER</th>
                            <th className="text-start font-medium px-1 py-1 w-[4.5rem]">Qty</th>
                            <th className="text-start font-medium px-1 py-1 w-[20%]">Note</th>
                            <th className="w-28" />
                          </tr>
                        </thead>
                        <tbody>
                          {s.parts.map(p => (
                            <tr
                              key={p.id}
                              onDragOver={allowDrop(`${s.id}:${p.id}`)}
                              onDrop={e => dropOn(e, s.id, p.id)}
                              className={dropAt === `${s.id}:${p.id}` ? 'border-t-2 border-blue-500' : ''}
                            >
                              <td className="px-1">
                                <span
                                  draggable={canEdit}
                                  onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(DRAG_PART, p.id); e.dataTransfer.effectAllowed = 'move'; }}
                                  title="Drag to move this part — onto another header, or before another part"
                                  className="cursor-move text-gray-500 inline-flex"
                                >
                                  <GripVerticalIcon className="w-3.5 h-3.5" />
                                </span>
                              </td>
                              <td className="px-1 py-0.5">
                                <input className={`${input} w-full`} value={p.description} disabled={!canEdit}
                                  placeholder="SIM-TABLE, or e.g. MCCB 400 A 3P"
                                  onChange={e => setPart(s.id, p.id, { description: e.target.value })} />
                              </td>
                              <td className="px-1 py-0.5">
                                <input className={`${input} w-full font-mono`} value={p.partNumber ?? ''} disabled={!canEdit}
                                  onChange={e => setPart(s.id, p.id, { partNumber: e.target.value })} />
                              </td>
                              <td className="px-1 py-0.5">
                                <input type="number" min={0} className={`${input} w-full`} value={p.quantity} disabled={!canEdit}
                                  onChange={e => setPart(s.id, p.id, { quantity: Math.max(0, Number(e.target.value) || 0) })} />
                              </td>
                              <td className="px-1 py-0.5">
                                <input className={`${input} w-full`} value={p.note ?? ''} disabled={!canEdit}
                                  onChange={e => setPart(s.id, p.id, { note: e.target.value })} />
                              </td>
                              <td className="px-1 text-right whitespace-nowrap">
                                <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Replace from the catalogue"
                                  disabled={!canEdit} onClick={() => setPicking({ section: s.id, part: p.id })}>
                                  <SearchIcon className="w-4 h-4" />
                                </button>
                                <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Copy this part"
                                  onClick={() => setOfferClip({ from: p.description || p.partNumber || 'part', parts: [p] })}>
                                  <CopyIcon className="w-4 h-4" />
                                </button>
                                <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                                  title={pasteable() ? `Replace with the copied part — ${pasteable()!.from}` : 'Nothing copied'}
                                  disabled={!canEdit || !pasteable()} onClick={() => replaceWithClip(s.id, p.id)}>
                                  <ReplaceIcon className="w-4 h-4" />
                                </button>
                                <button className="p-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50" title="Remove"
                                  disabled={!canEdit}
                                  onClick={() => setSection(s.id, { parts: s.parts.filter(x => x.id !== p.id) })}>
                                  <Trash2Icon className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button disabled={!canEdit} onClick={() => addPart(s.id)}
                        className="flex items-center gap-1.5 px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50">
                        <PlusIcon className="w-4 h-4" /> Add part
                      </button>
                      <button disabled={!canEdit} onClick={() => setPicking({ section: s.id })}
                        className="flex items-center gap-1.5 px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                        title={kindOfHeader(s.header) ? `The catalogue, showing ${kindOfHeader(s.header)!.label} only` : 'The catalogue'}>
                        <SearchIcon className="w-4 h-4" /> From catalogue
                      </button>
                      {pasteable() && (
                        <button disabled={!canEdit} onClick={() => paste(s.id)}
                          className="flex items-center gap-1.5 px-3 py-1 border border-gray-300 bg-white text-gray-700 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
                          title={`Paste — ${pasteable()!.from}`}>
                          <ClipboardPasteIcon className="w-4 h-4" /> Paste {pasteable()!.parts.length}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {/* The page itself takes a header too: dropped here it goes last. */}
              <div
                onDragOver={allowDrop('end')}
                onDragLeave={() => setDropAt(d => (d === 'end' ? null : d))}
                onDrop={e => dropOn(e)}
                className={`border-2 border-dashed rounded-md p-6 text-center text-sm ${
                  dropAt === 'end' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-500'}`}
              >
                {sections.length === 0
                  ? 'Drag a header here from the list on the left to start this template\'s offer'
                  : 'Drop a header here to add it at the end'}
              </div>
            </div>
          )}
        </div>
      </div>

      {onComplete && (
        <div className="flex justify-end mt-4 shrink-0">
          <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700" onClick={onComplete}>
            Next
          </button>
        </div>
      )}

      <PartSelectionDialog
        isOpen={picking != null}
        onClose={() => setPicking(null)}
        onSelect={onPicked}
        propertyName={sections.find(s => s.id === picking?.section)?.header ?? ''}
        currentPart={null}
        kind={kindOfHeader(sections.find(s => s.id === picking?.section)?.header ?? '')}
        voltage={template && LAYOUT_OF[template.type] === 'LV' ? 'LV' : 'MV'}
      />
    </div>
  );
};

export default OfferTemplateTab;
