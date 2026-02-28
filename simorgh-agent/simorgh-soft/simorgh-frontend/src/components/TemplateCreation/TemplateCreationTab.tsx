import React, { useState } from 'react';
import { Keyboard, X, RotateCcw } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { TemplateTree } from './TemplateTree';
import { TemplateProperties } from './TemplateProperties';

interface TemplateCreationTabProps {
  onComplete: () => void;
  initialSelectedTemplate?: string | null;
}

// ===== KEYBOARD SHORTCUTS DIALOG =====
const SHORTCUT_COMMANDS = [
  { id: 'newTemplate',     label: 'New Template',        description: 'Create a new template in the tree',           defaultKey: 'Ctrl+N' },
  { id: 'deleteTemplate',  label: 'Delete Template',     description: 'Delete the selected template',                defaultKey: 'Delete' },
  { id: 'copyTemplate',    label: 'Copy Template',       description: 'Duplicate the selected template',             defaultKey: 'Ctrl+D' },
  { id: 'selectPart',      label: 'Open Part Selector',  description: 'Open the part search & selection dialog',     defaultKey: 'Ctrl+P' },
  { id: 'removePart',      label: 'Remove Part',         description: 'Remove the part from the focused property row', defaultKey: 'Ctrl+Delete' },
  { id: 'moveRowUp',       label: 'Move Row Up',         description: 'Move the focused property row upward',        defaultKey: 'Alt+ArrowUp' },
  { id: 'moveRowDown',     label: 'Move Row Down',       description: 'Move the focused property row downward',      defaultKey: 'Alt+ArrowDown' },
  { id: 'increaseQty',     label: 'Increase Quantity',   description: 'Increase quantity of the selected part',      defaultKey: 'Ctrl+ArrowUp' },
  { id: 'decreaseQty',     label: 'Decrease Quantity',   description: 'Decrease quantity of the selected part',      defaultKey: 'Ctrl+ArrowDown' },
  { id: 'increasePriority',label: 'Increase Priority',   description: 'Increase priority of the selected part',      defaultKey: 'Ctrl+Shift+ArrowUp' },
  { id: 'decreasePriority',label: 'Decrease Priority',   description: 'Decrease priority of the selected part',      defaultKey: 'Ctrl+Shift+ArrowDown' },
];

const STORAGE_KEY = 'simorghKeyboardShortcuts';

interface ShortcutsDialogProps {
  onClose: () => void;
}

export const KeyboardShortcutsDialog: React.FC<ShortcutsDialogProps> = ({ onClose }) => {
  const [shortcuts, setShortcuts] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const [selectedCommand, setSelectedCommand] = useState<string>(SHORTCUT_COMMANDS[0].id);
  const [recording, setRecording] = useState(false);

  const getKey = (id: string) =>
    shortcuts[id] || SHORTCUT_COMMANDS.find(c => c.id === id)?.defaultKey || '';

  const saveShortcuts = (updated: Record<string, string>) => {
    setShortcuts(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      const keyLabel = e.key === ' ' ? 'Space' : e.key;
      parts.push(keyLabel);
      saveShortcuts({ ...shortcuts, [selectedCommand]: parts.join('+') });
      setRecording(false);
    }
  };

  const resetToDefault = (id: string) => {
    const updated = { ...shortcuts };
    delete updated[id];
    saveShortcuts(updated);
  };

  const resetAll = () => {
    setShortcuts({});
    localStorage.removeItem(STORAGE_KEY);
  };

  const selectedCmd = SHORTCUT_COMMANDS.find(c => c.id === selectedCommand)!;
  const hasCustom = (id: string) => !!shortcuts[id];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[720px] max-h-[80vh] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {/* Header */}
        <div className="bg-gray-800 text-white px-6 py-4 rounded-t-lg flex justify-between items-center">
          <div className="flex items-center gap-3">
            <Keyboard className="w-5 h-5 text-gray-300" />
            <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
            <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">Template Creation</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left panel: Commands list */}
          <div className="w-[55%] border-r overflow-y-auto flex flex-col">
            <div className="px-4 py-2 bg-gray-50 border-b text-xs font-semibold text-gray-500 uppercase tracking-wide sticky top-0">
              Select Command
            </div>
            {SHORTCUT_COMMANDS.map(cmd => (
              <div
                key={cmd.id}
                className={`px-4 py-3 cursor-pointer border-b transition-colors ${
                  selectedCommand === cmd.id
                    ? 'bg-blue-50 border-l-4 border-l-blue-500'
                    : 'hover:bg-gray-50 border-l-4 border-l-transparent'
                }`}
                onClick={() => { setSelectedCommand(cmd.id); setRecording(false); }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-800">{cmd.label}</span>
                  <kbd className={`px-2 py-0.5 rounded text-xs font-mono border ${
                    hasCustom(cmd.id)
                      ? 'bg-amber-50 border-amber-300 text-amber-800'
                      : 'bg-gray-100 border-gray-300 text-gray-600'
                  }`}>
                    {getKey(cmd.id)}
                  </kbd>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">{cmd.description}</p>
              </div>
            ))}
          </div>

          {/* Right panel: Shortcut assignment */}
          <div className="w-[45%] flex flex-col">
            <div className="px-4 py-2 bg-gray-50 border-b text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Assigned Shortcut Keys
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div>
                <div className="text-base font-semibold text-gray-800">{selectedCmd.label}</div>
                <p className="text-sm text-gray-500 mt-1">{selectedCmd.description}</p>
              </div>

              {/* Current shortcut display */}
              <div className="bg-gray-50 border rounded-lg p-4">
                <div className="text-xs font-medium text-gray-500 uppercase mb-3">Current Shortcut</div>
                <div className="flex items-center gap-3">
                  <kbd className={`px-4 py-2 rounded-lg text-sm font-mono font-bold border-2 shadow-sm min-w-[100px] text-center ${
                    recording
                      ? 'border-blue-400 bg-blue-50 text-blue-700 animate-pulse'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}>
                    {recording ? 'Press keys...' : getKey(selectedCmd.id)}
                  </kbd>
                  {hasCustom(selectedCmd.id) && (
                    <button
                      onClick={() => resetToDefault(selectedCmd.id)}
                      className="text-xs text-gray-400 hover:text-orange-600 flex items-center gap-1 transition-colors"
                      title="Reset to default"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset
                    </button>
                  )}
                </div>
                {hasCustom(selectedCmd.id) && (
                  <div className="mt-2 text-xs text-gray-400">
                    Default: <kbd className="px-1.5 py-0.5 bg-gray-100 border rounded text-xs font-mono">{selectedCmd.defaultKey}</kbd>
                  </div>
                )}
              </div>

              {/* Change shortcut button */}
              <button
                onClick={() => setRecording(r => !r)}
                className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  recording
                    ? 'bg-red-50 border border-red-300 text-red-700 hover:bg-red-100'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {recording ? 'Cancel (press Esc)' : 'Change Shortcut'}
              </button>

              {recording && (
                <p className="text-xs text-blue-600 bg-blue-50 rounded p-2 text-center">
                  Press any key combination now. Press <strong>Esc</strong> to cancel.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-3 flex justify-between items-center bg-gray-50 rounded-b-lg">
          <button
            onClick={resetAll}
            className="text-sm text-gray-400 hover:text-red-600 flex items-center gap-1.5 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset All to Defaults
          </button>
          <button
            onClick={onClose}
            className="px-5 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// ===== TEMPLATE CREATION TAB =====
export const TemplateCreationTab: React.FC<TemplateCreationTabProps> = ({
  onComplete,
  initialSelectedTemplate
}) => {
  const { projectData } = useProject();
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(initialSelectedTemplate ?? null);

  React.useEffect(() => {
    if (initialSelectedTemplate) {
      setSelectedTemplate(initialSelectedTemplate);
    }
  }, [initialSelectedTemplate]);

  if (!projectData) {
    return (
      <div className="flex flex-col h-full">
        <h2 className="text-xl font-semibold mb-4">Create Template</h2>
        <div className="flex items-center justify-center h-48 text-gray-500">
          <p>Project data is not available. Please check your project configuration.</p>
        </div>
      </div>
    );
  }

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);
  };

  const getSelectedTemplateData = () => {
    if (!selectedTemplate) return null;
    const templates = projectData.templates || {};
    for (const type of ['LV', 'MV', 'HV'] as const) {
      const template = (templates[type] || []).find(t => t.id === selectedTemplate);
      if (template) return template;
    }
    return null;
  };

  const selectedTemplateData = getSelectedTemplateData();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Create Template</h2>
      </div>

      <div className="flex flex-grow border border-gray-200 rounded-md overflow-hidden">
        <div className="w-1/4 border-r border-gray-200 overflow-y-auto">
          <TemplateTree
            projectData={projectData}
            onTemplateSelect={handleTemplateSelect}
            selectedTemplateId={selectedTemplate}
          />
        </div>
        <div className="w-3/4 p-4 overflow-y-auto">
          {selectedTemplateData ? (
            <TemplateProperties template={selectedTemplateData} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <p>Select a template from the tree or create a new one</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <button
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          onClick={onComplete}
        >
          Next
        </button>
      </div>

    </div>
  );
};
