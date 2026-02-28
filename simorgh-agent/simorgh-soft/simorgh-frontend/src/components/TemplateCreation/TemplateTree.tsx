import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { PlusIcon, TrashIcon, CopyIcon, ScissorsIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

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
  
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['LV', 'MV', 'HV']));
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    nodeType: null,
    templateId: null
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');

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
    setShowCreateModal(true);
    setContextMenu({
      ...contextMenu,
      visible: false
    });
  };

  const handleSubmitNewTemplate = () => {
    if (contextMenu.nodeType && newTemplateName.trim()) {
      addTemplate(contextMenu.nodeType, newTemplateName);
      setNewTemplateName('');
      setShowCreateModal(false);
      // Expand the node to show the new template
      const newExpanded = new Set(expandedNodes);
      newExpanded.add(contextMenu.nodeType);
      setExpandedNodes(newExpanded);
    }
  };

  const handleDeleteTemplate = () => {
    if (contextMenu.templateId) {
      deleteTemplate(contextMenu.templateId);
      setContextMenu({
        ...contextMenu,
        visible: false
      });
    }
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
                      className={`flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`} 
                      onClick={() => onTemplateSelect(template.id)} 
                      onContextMenu={event => handleContextMenu(event, 'LV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
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
                      className={`flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`} 
                      onClick={() => onTemplateSelect(template.id)} 
                      onContextMenu={event => handleContextMenu(event, 'MV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
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
                      className={`flex items-center p-1 cursor-pointer hover:bg-gray-100 rounded ${selectedTemplateId === template.id ? 'bg-blue-100' : ''}`} 
                      onClick={() => onTemplateSelect(template.id)} 
                      onContextMenu={event => handleContextMenu(event, 'HV', template.id)}
                    >
                      <span className="text-sm">{template.name}</span>
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

      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-20">
          <div className="bg-white p-6 rounded-lg shadow-xl w-96">
            <h3 className="text-lg font-semibold mb-4">Create New Template</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Template Type: {contextMenu.nodeType}
              </label>
              <label className="block text-sm font-medium text-gray-700 mb-1 mt-3">
                Template Name
              </label>
              <input 
                type="text" 
                className="w-full border border-gray-300 rounded px-3 py-2" 
                value={newTemplateName} 
                onChange={e => setNewTemplateName(e.target.value)} 
                onKeyPress={e => {
                  if (e.key === 'Enter') {
                    handleSubmitNewTemplate();
                  }
                }} 
                autoFocus 
              />
            </div>
            <div className="flex justify-end space-x-3">
              <button 
                className="px-4 py-2 border border-gray-300 rounded text-sm hover:bg-gray-50" 
                onClick={() => {
                  setNewTemplateName('');
                  setShowCreateModal(false);
                }}
              >
                Cancel
              </button>
              <button 
                className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700" 
                onClick={handleSubmitNewTemplate}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};