import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { PlusIcon, TrashIcon, CopyIcon, ScissorsIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { HierarchicalTemplateWizard } from './HierarchicalTemplateWizard';
import { findTemplateUsage, UsageReport } from '../../utils/cascadeDelete';
import { CascadeDeleteModal } from '../shared/CascadeDeleteModal';

interface TemplateTreeProps {
  projectData: any;
  onTemplateSelect: (templateId: string) => void;
  selectedTemplateId: string | null;
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
}

export const TemplateTree: React.FC<TemplateTreeProps> = ({
  projectData,
  onTemplateSelect,
  selectedTemplateId
}) => {
  const {
    addTemplate,
    deleteTemplate
  } = useProject();

  // Pending template deletion — confirmed through the cascade dialog, which
  // lists every equipment row built on the template.
  const [templateDeleteTarget, setTemplateDeleteTarget] = useState<{
    id: string; name: string; usage: UsageReport;
  } | null>(null);
  
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['LV', 'MV', 'HV']));
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    nodeType: null,
    templateId: null
  });
  // The hierarchical wizard replaces the old "just a name" modal — we keep
  // a separate flag so the rest of the file doesn't have to change.
  const [wizardTier, setWizardTier] = useState<'LV' | 'MV' | 'HV' | null>(null);

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

  const handleContextMenu = (event: React.MouseEvent, nodeType: 'LV' | 'MV' | 'HV', templateId: string | null = null) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      visible: true,
      x: event.clientX,
      y: event.clientY,
      nodeType,
      templateId
    });
  };

  const handleCreateTemplate = () => {
    if (contextMenu.nodeType) setWizardTier(contextMenu.nodeType);
    setContextMenu({ ...contextMenu, visible: false });
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
      <div className="text-sm font-medium mb-2">Project Templates</div>
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
              {safeTemplates.LV.length === 0 ? (
                <li className="text-xs text-gray-400 italic p-1">
                  No templates
                </li>
              ) : (
                safeTemplates.LV.map((template: Template) => (
                  <li key={template.id}>
                    <div
                      className={`flex flex-col p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`}
                      onClick={() => onTemplateSelect(template.id)}
                      onContextMenu={event => handleContextMenu(event, 'LV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
                      {template.hierarchy?.path && template.hierarchy.path.length > 0 && (
                        <span className="text-[10px] text-gray-500 truncate">
                          {template.hierarchy.path.join(' / ')}
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
                          {template.hierarchy.path.join(' / ')}
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
                          {template.hierarchy.path.join(' / ')}
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
          <button 
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 flex items-center" 
            onClick={handleCreateTemplate}
          >
            <PlusIcon className="w-4 h-4 mr-2" />
            Create Template
          </button>
          {contextMenu.templateId && (
            <>
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
          cascadeNoteFa={
            'با حذف تمپلیت، ردیف‌هایی که در Device Selection با آن ساخته شده‌اند هم حذف می‌شوند؛ ' +
            'خود تجهیز باقی می‌ماند و شماره ردیف‌های باقیمانده دوباره مرتب می‌شود.'
          }
          onConfirm={confirmDeleteTemplate}
          onCancel={() => setTemplateDeleteTarget(null)}
        />
      )}

      {wizardTier && (
        <HierarchicalTemplateWizard
          tier={wizardTier}
          existing={safeTemplates[wizardTier]}
          onCancel={() => setWizardTier(null)}
          onSubmit={({ name, hierarchy, copyFromId }) => {
            addTemplate(wizardTier, name, hierarchy, copyFromId);
            const newExpanded = new Set(expandedNodes);
            newExpanded.add(wizardTier);
            setExpandedNodes(newExpanded);
            setWizardTier(null);
          }}
        />
      )}
    </div>
  );
};