import React, { useState } from 'react';
import { templateMeta } from '../../utils/templateMeta';
import { useProject } from '../../context/ProjectContext';
import { PlusIcon, TrashIcon, CopyIcon, ScissorsIcon, ClipboardPasteIcon, BanIcon, ChevronDownIcon, ChevronRightIcon, WrenchIcon, XIcon, PencilIcon, SearchIcon } from 'lucide-react';
import { HierarchicalTemplateWizard } from './HierarchicalTemplateWizard';
import { findTemplateUsage, UsageReport } from '../../utils/cascadeDelete';
import { TEMPLATE_FAMILIES, familyOf, groupByFamily, hasFamilies } from '../../utils/templateFamilies';
import { CascadeDeleteModal } from '../shared/CascadeDeleteModal';
import { MenuBox } from '../shared/MenuBox';
import { MechanicalQuestions } from './MechanicalQuestions';
import { TemplateItem, TemplateMechanical } from '../../types/project';
import { type Tier, TIERS, TIER_LABEL, TIER_PILL, withAllTiers } from '../../utils/tiers';

interface TemplateTreeProps {
  projectData: any;
  onTemplateSelect: (templateId: string) => void;
  selectedTemplateId: string | null;
  /**
   * Leave off the panel's own caption.
   *
   * Set when a frame outside already draws a title bar. Off by default, so
   * every existing use looks exactly as it did.
   */
  bare?: boolean;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  nodeType: Tier | null;
  templateId: string | null;
  /**
   * Which section of the tier the menu was opened in — OFW or FIX for LV.
   *
   * A template is made from inside the section it belongs to, so by the time
   * the wizard opens there is nothing to ask: the click said it. Null on a
   * tier that has no sections, and on the tier node itself, where the menu
   * offers one entry per section instead.
   */
  family: string | null;
}

export const TemplateTree: React.FC<TemplateTreeProps> = ({
  projectData,
  onTemplateSelect,
  selectedTemplateId,
  bare,
}) => {
  const {
    addTemplate,
    deleteTemplate,
    setTemplateMechanical,
    moveTemplate,
  } = useProject();

  // Pending template deletion — confirmed through the cascade dialog, which
  // lists every equipment row built on the template.
  const [templateDeleteTarget, setTemplateDeleteTarget] = useState<{
    id: string; name: string; usage: UsageReport;
  } | null>(null);
  
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set([...TIERS, 'LV/OFW', 'LV/FIX', 'BPMS']));
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    nodeType: null,
    templateId: null,
    family: null
  });
  // The hierarchical wizard replaces the old "just a name" modal — we keep
  // a separate flag so the rest of the file doesn't have to change.
  const [wizard, setWizard] = useState<{
    tier: Tier;
    family: string | null;
    /** Set when the wizard was opened by a paste, or to edit what is there. */
    startFrom?: TemplateItem | null;
    pasteMode?: 'copy' | 'move' | 'edit';
  } | null>(null);

  // What was copied or cut, kept until it is pasted or replaced.
  //
  // A template carries the property columns of its own tier — CB ORDER and
  // CONTACTOR. ORDER on LV, VCB OR VC/FUSE on MV — so a LV template pasted
  // into MV would arrive with parts filed under columns that tier has not
  // got. Between the sections of one tier the columns are the same, so OFW
  // to FIX is a real paste; between tiers it is refused, and the menu says
  // so rather than leaving somebody to wonder why nothing happened.
  const [clip, setClip] = useState<
    { template: TemplateItem; mode: 'copy' | 'cut' } | null>(null);
  // The mechanical answers being edited on an existing template. Held here
  // rather than written straight through, so Cancel means cancel.
  const [mechEdit, setMechEdit] = useState<
    { template: TemplateItem; value: TemplateMechanical } | null>(null);

  // Every tier present, whatever the project was saved with.
  const safeTemplates = withAllTiers<TemplateItem>(projectData?.templates);
  const allTemplates: TemplateItem[] = TIERS.flatMap(t => safeTemplates[t]);

  // A tier's own section lists what was made here; what came from TPMS is in
  // the BPMS section below.
  const tierTemplates = (tier: Tier) => safeTemplates[tier].filter(t => t.source !== 'tpms');

  // ── BPMS ───────────────────────────────────────────────────────────────
  const [bpmsQuery, setBpmsQuery] = useState('');
  const [bpmsTier, setBpmsTier] = useState<Tier | ''>('');
  const bpmsTemplates = allTemplates.filter(t => t.source === 'tpms');
  // Which TPMS switchgear a template was read for: the import files it under
  // ['TPMS', <switchgear>].
  const switchgearOf = (t: TemplateItem) =>
    (t.hierarchy?.path?.[0] === 'TPMS' ? t.hierarchy?.path?.[1] : undefined) || 'Other';
  // Matched against the name, the switchgear, the group and every part number
  // and label on it — the engineer often knows the breaker, not the name TPMS
  // gave the line.
  const bpmsHaystack = (t: TemplateItem) => [
    t.name, switchgearOf(t), t.type,
    ...Object.entries(t.properties ?? {}).flatMap(([slot, v]: [string, any]) =>
      slot.startsWith('__') ? [] : [slot, ...((v?.parts ?? []) as any[]).flatMap(p => [p?.partNumber, p?.label])]),
  ].join(' ').toLowerCase();
  const bpmsWords = bpmsQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const bpmsShown = bpmsTemplates.filter(t =>
    (!bpmsTier || t.type === bpmsTier) &&
    bpmsWords.every(w => bpmsHaystack(t).includes(w)));
  const bpmsGroups: [string, TemplateItem[]][] = (() => {
    const byGear = new Map<string, TemplateItem[]>();
    for (const t of bpmsShown) {
      const key = switchgearOf(t);
      if (!byGear.has(key)) byGear.set(key, []);
      byGear.get(key)!.push(t);
    }
    return [...byGear.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  })();

  /** One template in the tree — the same row in every section. */
  const renderTemplateRow = (
    template: TemplateItem, tier: Tier, family: string | null, showTier = false,
  ) => (
    <li key={template.id}>
      <div
        className={`flex flex-col p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`}
        onClick={() => onTemplateSelect(template.id)}
        onContextMenu={event => handleContextMenu(event, tier, template.id, family)}
      >
        <span className="text-sm">
          {showTier && (
            <span className={`mr-1 text-[9px] px-1 py-px rounded font-semibold ${TIER_PILL[template.type] ?? ''}`}>{template.type}</span>
          )}
          {template.name}
        </span>
        {templateMeta(template) && (
          <span className="text-[10px] text-gray-500 truncate">
            {templateMeta(template)}
          </span>
        )}
      </div>
    </li>
  );

  const toggleNode = (nodeType: string) => {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeType)) {
      newExpanded.delete(nodeType);
    } else {
      newExpanded.add(nodeType);
    }
    setExpandedNodes(newExpanded);
  };

  const handleContextMenu = (
    event: React.MouseEvent,
    nodeType: Tier,
    templateId: string | null = null,
    family: string | null = null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      nodeType,
      templateId,
      family
    });
  };

  const handleCreateTemplate = (family: string | null = contextMenu.family) => {
    if (contextMenu.nodeType) setWizard({ tier: contextMenu.nodeType, family });
    setContextMenu({ ...contextMenu, visible: false });
  };

  /** Open the wizard straight in a section, from the section's own row. */
  const createInFamily = (tier: Tier, family: string) => {
    setContextMenu({ ...contextMenu, visible: false });
    setWizard({ tier, family });
  };

  // A template is referenced by the device rows built on it, so deleting it
  // has to clear those rows too — otherwise they keep pointing at a template
  // that no longer exists and their property columns come out blank.
  const handleDeleteTemplate = () => {
    if (!contextMenu.templateId) return;
    const id = contextMenu.templateId;
    const tmpl = allTemplates.find(t => t.id === id);
    setTemplateDeleteTarget({
      id,
      name: tmpl?.name || 'Template',
      usage: findTemplateUsage(projectData, id),
    });
    setContextMenu({ ...contextMenu, visible: false });
  };

  const confirmDeleteTemplate = () => {
    if (!templateDeleteTarget) return;
    // deleteTemplate cascades to the rows built on the template.
    deleteTemplate(templateDeleteTarget.id);
    setTemplateDeleteTarget(null);
  };

  const templateById = (id: string | null): TemplateItem | undefined => {
    if (!id) return undefined;
    return allTemplates.find(t => t.id === id);
  };

  /** Take the template the menu was opened on, to be pasted somewhere. */
  const handleClip = (mode: 'copy' | 'cut') => {
    const template = templateById(contextMenu.templateId);
    setContextMenu({ ...contextMenu, visible: false });
    if (template) setClip({ template, mode });
  };

  /**
   * Paste into a section: the wizard opens on it with the copied template as
   * its base, so its path and its name can be settled before anything is
   * written. A cut is a move — the template keeps its id, and the device rows
   * built on it stay attached.
   */
  const handlePaste = (family: string | null) => {
    if (!clip) return;
    setContextMenu({ ...contextMenu, visible: false });
    setWizard({
      tier: clip.template.type,
      family,
      startFrom: clip.template,
      pasteMode: clip.mode === 'cut' ? 'move' : 'copy',
    });
  };

  /**
   * Open the wizard on a template that already exists, to change it.
   *
   * The same steps it was made with — Root, Switch, the leaf and the rated
   * power and full-load current — reopened on the template itself. It keeps
   * its id, so its parts and the device rows built on it stay attached; only
   * the path, the leaf, the parameters and the name change. Before this the
   * only way to correct any of them was to delete the template and build it
   * again.
   */
  const handleEditTemplate = () => {
    const template = templateById(contextMenu.templateId);
    setContextMenu({ ...contextMenu, visible: false });
    if (!template) return;
    setWizard({
      tier: template.type,
      // Its own section, so the wizard opens on the steps that section asks
      // and carries the path the template already has.
      family: familyOf(template.type, template.hierarchy)?.id ?? contextMenu.family,
      startFrom: template,
      pasteMode: 'edit',
    });
  };

  /** Open the mechanical questions on the template the menu was opened on. */
  const handleEditMechanical = () => {
    const template = templateById(contextMenu.templateId);
    setContextMenu({ ...contextMenu, visible: false });
    if (template) setMechEdit({ template, value: { ...(template.mechanical ?? {}) } });
  };

  const handleCloseContextMenu = () => {
    setContextMenu({
      ...contextMenu,
      visible: false
    });
  };

  const handleClickOutside = (event: React.MouseEvent) => {
    if (contextMenu.visible) {
      handleCloseContextMenu();
    }
  };

  return (
    <div className="h-full p-2" onClick={handleClickOutside}>
      {!bare && <div className="text-sm font-medium mb-2">Project Templates</div>}
      <ul className="space-y-1">
        {TIERS.map(tier => {
          const list = tierTemplates(tier);
          return (
            <li key={tier}>
              <div className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded" onContextMenu={event => handleContextMenu(event, tier)}>
                <button onClick={event => {
                  event.stopPropagation();
                  toggleNode(tier);
                }} className="mr-1">
                  {expandedNodes.has(tier) ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                </button>
                <span className="text-sm font-medium">{tier} ({TIER_LABEL[tier]})</span>
                <span className="ml-1.5 text-[10px] text-gray-400">{list.length}</span>
              </div>
              {expandedNodes.has(tier) && (
                <ul className="pl-6 space-y-1 mt-1">
                  {list.length === 0 && !hasFamilies(tier) ? (
                    <li className="text-xs text-gray-400 italic p-1">
                      No templates — right-click {tier} to create one
                    </li>
                  ) : (
                    // The office reads an LV path as two different things — OFW
                    // and FIX — so they are listed apart. A template the families
                    // do not claim is not hidden: it is listed on its own, where
                    // it always was. A tier with no families is one flat list.
                    groupByFamily(tier, list).map(group => {
                      const rows = group.templates.map(template =>
                        renderTemplateRow(template, tier, group.family?.id ?? null));

                      if (!group.family) return <React.Fragment key={`${tier}/rest`}>{rows}</React.Fragment>;

                      const node = `${tier}/${group.family.id}`;
                      return (
                        <li key={node}>
                          <div
                            className="group flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded"
                            onClick={() => toggleNode(node)}
                            onContextMenu={event => handleContextMenu(event, tier, null, group.family!.id)}
                          >
                            {expandedNodes.has(node)
                              ? <ChevronDownIcon className="w-4 h-4 mr-1" />
                              : <ChevronRightIcon className="w-4 h-4 mr-1" />}
                            <span className="text-sm font-medium">{group.family.label}</span>
                            <span className="ml-1.5 text-[10px] text-gray-400">
                              {group.family.note} · {group.templates.length}
                            </span>
                            {/* Made from inside the section it belongs to, so the
                                wizard has nothing to ask about which one. */}
                            <button
                              onClick={event => {
                                event.stopPropagation();
                                createInFamily(tier, group.family!.id);
                              }}
                              title={`New template in ${group.family.label}`}
                              className="ml-auto p-0.5 rounded text-gray-400 opacity-0 group-hover:opacity-100 hover:text-blue-600 hover:bg-blue-50"
                            >
                              <PlusIcon className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {expandedNodes.has(node) && (
                            <ul className="pl-5 space-y-1 mt-1">
                              {rows.length > 0 ? rows : (
                                <li className="text-xs text-gray-400 italic p-1">No templates</li>
                              )}
                            </ul>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>
              )}
            </li>
          );
        })}

        {/* BPMS — the templates that were built from TPMS. They are kept in
            their own section rather than mixed into the voltage groups: there
            are dozens of them on a project of any size, named after TPMS's
            lines, and the engineer looks for them by switchgear and by name,
            which is what the filter is for. They are still the tier's
            templates — Device Selection offers them for that tier as before. */}
        <li>
          <div className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded" onClick={() => toggleNode('BPMS')}>
            <span className="mr-1">
              {expandedNodes.has('BPMS') ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </span>
            <span className="text-sm font-medium">BPMS (from TPMS)</span>
            <span className="ml-1.5 text-[10px] text-gray-400">
              {bpmsQuery.trim() ? `${bpmsShown.length} / ${bpmsTemplates.length}` : bpmsTemplates.length}
            </span>
          </div>
          {expandedNodes.has('BPMS') && (
            <div className="pl-6 mt-1">
              {bpmsTemplates.length === 0 ? (
                <p className="text-xs text-gray-400 italic p-1">
                  No templates read from TPMS in this project.
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-1 mb-1.5 pr-1">
                    <div className="relative flex-1">
                      <SearchIcon className="w-3.5 h-3.5 absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        value={bpmsQuery}
                        onChange={e => setBpmsQuery(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        placeholder="Filter by name, switchgear, part…"
                        className="w-full border border-gray-300 rounded pl-6 pr-6 py-1 text-xs focus:outline-none focus:border-blue-400"
                      />
                      {bpmsQuery && (
                        <button
                          onClick={() => setBpmsQuery('')}
                          className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          title="Clear the filter"
                        >
                          <XIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <select
                      value={bpmsTier}
                      onChange={e => setBpmsTier(e.target.value as Tier | '')}
                      className="border border-gray-300 rounded px-1 py-1 text-xs"
                      title="Only one group"
                    >
                      <option value="">All</option>
                      {TIERS.filter(t => bpmsTemplates.some(x => x.type === t)).map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  {bpmsShown.length === 0 ? (
                    <p className="text-xs text-gray-400 italic p-1">Nothing matches the filter.</p>
                  ) : (
                    bpmsGroups.map(([switchgear, list]) => (
                      <div key={switchgear} className="mb-1">
                        <div
                          className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded text-xs font-medium text-gray-600"
                          onClick={() => toggleNode(`BPMS/${switchgear}`)}
                        >
                          {expandedNodes.has(`BPMS/${switchgear}`) || bpmsQuery.trim()
                            ? <ChevronDownIcon className="w-3.5 h-3.5 mr-1" />
                            : <ChevronRightIcon className="w-3.5 h-3.5 mr-1" />}
                          {switchgear}
                          <span className="ml-1.5 text-[10px] text-gray-400 font-normal">{list.length}</span>
                        </div>
                        {(expandedNodes.has(`BPMS/${switchgear}`) || bpmsQuery.trim()) && (
                          <ul className="pl-4 space-y-1">
                            {list.map(template => renderTemplateRow(template, template.type, null, true))}
                          </ul>
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          )}
        </li>
      </ul>
      {contextMenu.visible && (
        <MenuBox
          x={contextMenu.x}
          y={contextMenu.y}
          className="z-[120] w-56 bg-white border border-gray-200 shadow-lg rounded-md py-1"
        >
          {/* On a tier that has sections, the tier's own menu names them
              rather than asking afterwards which one was meant. */}
          {contextMenu.nodeType && !contextMenu.family
            && (TEMPLATE_FAMILIES[contextMenu.nodeType] ?? []).length > 0 ? (
            (TEMPLATE_FAMILIES[contextMenu.nodeType] ?? []).map(family => (
              <button
                key={family.id}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => handleCreateTemplate(family.id)}
              >
                <PlusIcon className="w-4 h-4 mr-2" />
                Create in {family.label}
              </button>
            ))
          ) : (
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
              onClick={() => handleCreateTemplate()}
            >
              <PlusIcon className="w-4 h-4 mr-2" />
              Create Template
            </button>
          )}
          {/* Paste — offered on the tier, on a section, and on a template,
              because all three name a place to put one. Same tier only. */}
          {clip && contextMenu.nodeType === clip.template.type && (
            contextMenu.family || (TEMPLATE_FAMILIES[contextMenu.nodeType] ?? []).length === 0 ? (
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => handlePaste(contextMenu.family)}
                title={`${clip.mode === 'cut' ? 'Move' : 'Paste a copy of'} ${clip.template.name} here`}
              >
                <ClipboardPasteIcon className="w-4 h-4 mr-2" />
                {clip.mode === 'cut' ? 'Move' : 'Paste'} {clip.template.name}
              </button>
            ) : (
              (TEMPLATE_FAMILIES[contextMenu.nodeType] ?? []).map(family => (
                <button
                  key={`paste-${family.id}`}
                  className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                  onClick={() => handlePaste(family.id)}
                >
                  <ClipboardPasteIcon className="w-4 h-4 mr-2" />
                  {clip.mode === 'cut' ? 'Move' : 'Paste'} into {family.label}
                </button>
              ))
            )
          )}
          {clip && contextMenu.nodeType && contextMenu.nodeType !== clip.template.type && (
            <div
              className="px-4 py-2 text-xs text-gray-400 flex items-start gap-2 cursor-not-allowed"
              title={`A ${clip.template.type} template's property columns are not ${contextMenu.nodeType}'s`}
            >
              <BanIcon className="w-4 h-4 shrink-0 mt-px" />
              <span>
                Can’t paste a {clip.template.type} template into {contextMenu.nodeType} —
                they do not share property columns.
              </span>
            </div>
          )}
          {contextMenu.templateId && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={handleEditTemplate}
                title="Change its Root, Switch, equipment kind, rated power and full-load current — the template keeps its parts and its id"
              >
                <PencilIcon className="w-4 h-4 mr-2" />
                Edit path &amp; parameters…
              </button>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={handleEditMechanical}
              >
                <WrenchIcon className="w-4 h-4 mr-2" />
                Mechanical…
              </button>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => handleClip('copy')}
              >
                <CopyIcon className="w-4 h-4 mr-2" />
                Copy
              </button>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={() => handleClip('cut')}
                title="Take it to file somewhere else — it keeps its id, so the device rows built on it stay attached"
              >
                <ScissorsIcon className="w-4 h-4 mr-2" />
                Cut
              </button>
              <button 
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center text-red-600" 
                onClick={handleDeleteTemplate}
              >
                <TrashIcon className="w-4 h-4 mr-2" />
                Delete
              </button>
            </>
          )}
        </MenuBox>
      )}

      {templateDeleteTarget && (
        <CascadeDeleteModal
          itemName={templateDeleteTarget.name}
          itemKind="Template"
          usage={templateDeleteTarget.usage}
          cascadeNote={
            'Deleting the template also deletes the device rows built on it in Device Selection; ' +
            'the equipment itself is kept and its remaining rows are renumbered.'
          }
          onConfirm={confirmDeleteTemplate}
          onCancel={() => setTemplateDeleteTarget(null)}
        />
      )}

      {wizard && (
        <HierarchicalTemplateWizard
          tier={wizard.tier}
          family={wizard.family}
          existing={safeTemplates[wizard.tier]}
          startFrom={wizard.startFrom ?? null}
          pasteMode={wizard.pasteMode ?? 'copy'}
          onCancel={() => setWizard(null)}
          onSubmit={({ name, hierarchy, useSimorghDraw, mechanical, copyFromId }) => {
            if ((wizard.pasteMode === 'move' || wizard.pasteMode === 'edit') && wizard.startFrom) {
              // A move is the same template filed elsewhere, and an edit is the
              // same template with its path and parameters changed. Neither
              // makes a new one, so both keep the id the device rows point at.
              moveTemplate(wizard.startFrom.id, hierarchy, name, useSimorghDraw);
              // Answers edited on the way through are the template's now.
              setTemplateMechanical(wizard.startFrom.id, mechanical);
              // Only a move consumes what was cut; an edit never touched it.
              if (wizard.pasteMode === 'move') setClip(null);
            } else {
              addTemplate(wizard.tier, name, hierarchy, copyFromId, useSimorghDraw, mechanical);
            }
            const newExpanded = new Set(expandedNodes);
            newExpanded.add(wizard.tier);
            // The new template's own section is opened too, so it is on screen
            // where it was made rather than behind a closed node.
            if (wizard.family) newExpanded.add(`${wizard.tier}/${wizard.family}`);
            setExpandedNodes(newExpanded);
            setWizard(null);
          }}
        />
      )}

      {/* The same questions as the wizard asks, on a template that already
          exists — so an answer can be changed without rebuilding anything,
          and so a template made before this existed can be answered now. */}
      {mechEdit && (
        <div
          className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[200]"
          onClick={() => setMechEdit(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-[560px] max-h-[90vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">
                  Mechanical — {mechEdit.template.name}
                </p>
                <p className="text-[11px] text-gray-500">
                  {mechEdit.template.type} · what the estimate sheets ask about this cell
                </p>
              </div>
              <button
                onClick={() => setMechEdit(null)}
                className="p-1 rounded hover:bg-gray-100 text-gray-500 shrink-0"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              <MechanicalQuestions
                tier={mechEdit.template.type}
                template={mechEdit.template}
                value={mechEdit.value}
                onChange={value => setMechEdit({ ...mechEdit, value })}
                framed={false}
              />
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
              <button
                onClick={() => setMechEdit(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setTemplateMechanical(mechEdit.template.id, mechEdit.value);
                  setMechEdit(null);
                }}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};