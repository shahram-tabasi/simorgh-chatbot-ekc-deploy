import React, { useState } from 'react';
import { foldedPath } from '../../utils/templateFamilies';
import { useProject } from '../../context/ProjectContext';
import { PlusIcon, TrashIcon, CopyIcon, ScissorsIcon, ChevronDownIcon, ChevronRightIcon, WrenchIcon, XIcon } from 'lucide-react';
import { HierarchicalTemplateWizard } from './HierarchicalTemplateWizard';
import { findTemplateUsage, UsageReport } from '../../utils/cascadeDelete';
import { TEMPLATE_FAMILIES, groupByFamily, hasFamilies } from '../../utils/templateFamilies';
import { CascadeDeleteModal } from '../shared/CascadeDeleteModal';
import { MechanicalQuestions } from './MechanicalQuestions';
import { TemplateItem, TemplateMechanical } from '../../types/project';

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

interface Template {
  id: string;
  name: string;
  type: 'LV' | 'MV' | 'HV';
  properties?: Record<string, any>;
  hierarchy?: {
    path?: string[];
    leafKind?: string;
    params?: { kw?: string; currentA?: string };
  };
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  nodeType: 'LV' | 'MV' | 'HV' | null;
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
  } = useProject();

  // Pending template deletion — confirmed through the cascade dialog, which
  // lists every equipment row built on the template.
  const [templateDeleteTarget, setTemplateDeleteTarget] = useState<{
    id: string; name: string; usage: UsageReport;
  } | null>(null);
  
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    new Set(['LV', 'MV', 'HV', 'LV/OFW', 'LV/FIX']));
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
  const [wizard, setWizard] = useState<
    { tier: 'LV' | 'MV' | 'HV'; family: string | null } | null>(null);
  // The mechanical answers being edited on an existing template. Held here
  // rather than written straight through, so Cancel means cancel.
  const [mechEdit, setMechEdit] = useState<
    { template: TemplateItem; value: TemplateMechanical } | null>(null);

  // 🔹 بررسی امن برای templates - اضافه شده
  const safeTemplates = {
    LV: projectData?.templates?.LV || [],
    MV: projectData?.templates?.MV || [],
    HV: projectData?.templates?.HV || []
  };

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
    nodeType: 'LV' | 'MV' | 'HV',
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
  const createInFamily = (tier: 'LV' | 'MV' | 'HV', family: string) => {
    setContextMenu({ ...contextMenu, visible: false });
    setWizard({ tier, family });
  };

  // A template is referenced by the device rows built on it, so deleting it
  // has to clear those rows too — otherwise they keep pointing at a template
  // that no longer exists and their property columns come out blank.
  const handleDeleteTemplate = () => {
    if (!contextMenu.templateId) return;
    const id = contextMenu.templateId;
    const all = [...safeTemplates.LV, ...safeTemplates.MV, ...safeTemplates.HV];
    const tmpl = all.find((t: Template) => t.id === id);
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

  /** Open the mechanical questions on the template the menu was opened on. */
  const handleEditMechanical = () => {
    const id = contextMenu.templateId;
    setContextMenu({ ...contextMenu, visible: false });
    if (!id) return;
    const all = [...safeTemplates.LV, ...safeTemplates.MV, ...safeTemplates.HV];
    const template = all.find((t: TemplateItem) => t.id === id);
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
        <li>
          <div className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded" onContextMenu={event => handleContextMenu(event, 'LV')}>
            <button onClick={event => {
              event.stopPropagation();
              toggleNode('LV');
            }} className="mr-1">
              {expandedNodes.has('LV') ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </button>
            <span className="text-sm font-medium">LV (Low Voltage)</span>
          </div>
          {expandedNodes.has('LV') && (
            <ul className="pl-6 space-y-1 mt-1">
              {safeTemplates.LV.length === 0 && !hasFamilies('LV') ? (
                <li className="text-xs text-gray-400 italic p-1">
                  No templates
                </li>
              ) : (
                // The office reads an LV path as two different things — OFW
                // and FIX — so they are listed apart. A template the families
                // do not claim is not
                // hidden: it is listed on its own, where it always was.
                groupByFamily('LV', safeTemplates.LV as Template[]).map(group => {
                  const rows = group.templates.map((template: Template) => (
                    <li key={template.id}>
                      <div
                        className={`flex flex-col p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`}
                        onClick={() => onTemplateSelect(template.id)}
                        onContextMenu={event => handleContextMenu(event, 'LV', template.id, group.family?.id ?? null)}
                      >
                        <span className="text-sm">{template.name}</span>
                        {template.hierarchy?.path && template.hierarchy.path.length > 0 && (
                          <span className="text-[10px] text-gray-500 truncate">
                            {foldedPath(template.hierarchy.path).join(' / ')}
                            {template.hierarchy.leafKind && ` · ${template.hierarchy.leafKind}`}
                            {template.hierarchy.params?.kw && ` · ${template.hierarchy.params.kw} kW`}
                            {template.hierarchy.params?.currentA && ` · ${template.hierarchy.params.currentA} A`}
                          </span>
                        )}
                      </div>
                    </li>
                  ));

                  if (!group.family) return <React.Fragment key="LV/rest">{rows}</React.Fragment>;

                  const node = `LV/${group.family.id}`;
                  return (
                    <li key={node}>
                      <div
                        className="group flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded"
                        onClick={() => toggleNode(node)}
                        onContextMenu={event => handleContextMenu(event, 'LV', null, group.family!.id)}
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
                            createInFamily('LV', group.family!.id);
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
        
        <li>
          <div className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded" onContextMenu={event => handleContextMenu(event, 'MV')}>
            <button onClick={event => {
              event.stopPropagation();
              toggleNode('MV');
            }} className="mr-1">
              {expandedNodes.has('MV') ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </button>
            <span className="text-sm font-medium">MV (Medium Voltage)</span>
          </div>
          {expandedNodes.has('MV') && (
            <ul className="pl-6 space-y-1 mt-1">
              {safeTemplates.MV.length === 0 ? (
                <li className="text-xs text-gray-400 italic p-1">
                  No templates
                </li>
              ) : (
                safeTemplates.MV.map((template: Template) => (
                  <li key={template.id}>
                    <div
                      className={`flex flex-col p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`}
                      onClick={() => onTemplateSelect(template.id)}
                      onContextMenu={event => handleContextMenu(event, 'MV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
                      {template.hierarchy?.path && template.hierarchy.path.length > 0 && (
                        <span className="text-[10px] text-gray-500 truncate">
                          {foldedPath(template.hierarchy.path).join(' / ')}
                          {template.hierarchy.leafKind && ` · ${template.hierarchy.leafKind}`}
                          {template.hierarchy.params?.kw && ` · ${template.hierarchy.params.kw} kW`}
                          {template.hierarchy.params?.currentA && ` · ${template.hierarchy.params.currentA} A`}
                        </span>
                      )}
                    </div>
                  </li>
                ))
              )}
            </ul>
          )}
        </li>
        
        <li>
          <div className="flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded" onContextMenu={event => handleContextMenu(event, 'HV')}>
            <button onClick={event => {
              event.stopPropagation();
              toggleNode('HV');
            }} className="mr-1">
              {expandedNodes.has('HV') ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
            </button>
            <span className="text-sm font-medium">HV (High Voltage)</span>
          </div>
          {expandedNodes.has('HV') && (
            <ul className="pl-6 space-y-1 mt-1">
              {safeTemplates.HV.length === 0 ? (
                <li className="text-xs text-gray-400 italic p-1">
                  No templates
                </li>
              ) : (
                safeTemplates.HV.map((template: Template) => (
                  <li key={template.id}>
                    <div
                      className={`flex flex-col p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`}
                      onClick={() => onTemplateSelect(template.id)}
                      onContextMenu={event => handleContextMenu(event, 'HV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
                      {template.hierarchy?.path && template.hierarchy.path.length > 0 && (
                        <span className="text-[10px] text-gray-500 truncate">
                          {foldedPath(template.hierarchy.path).join(' / ')}
                          {template.hierarchy.leafKind && ` · ${template.hierarchy.leafKind}`}
                          {template.hierarchy.params?.kw && ` · ${template.hierarchy.params.kw} kW`}
                          {template.hierarchy.params?.currentA && ` · ${template.hierarchy.params.currentA} A`}
                        </span>
                      )}
                    </div>
                  </li>
                ))
              )}
            </ul>
          )}
        </li>
      </ul>

      {contextMenu.visible && (
        <div 
          className="fixed z-10 w-48 bg-white border border-gray-200 shadow-lg rounded-md py-1" 
          style={{
            top: contextMenu.y,
            left: contextMenu.x
          }}
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
          {contextMenu.templateId && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center"
                onClick={handleEditMechanical}
              >
                <WrenchIcon className="w-4 h-4 mr-2" />
                Mechanical…
              </button>
              <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center">
                <CopyIcon className="w-4 h-4 mr-2" />
                Copy
              </button>
              <button className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center">
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
        </div>
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
          onCancel={() => setWizard(null)}
          onSubmit={({ name, hierarchy, useSimorghDraw, mechanical, copyFromId }) => {
            addTemplate(wizard.tier, name, hierarchy, copyFromId, useSimorghDraw, mechanical);
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