import React, { useState, useEffect, useRef } from 'react';
import { useProject } from '../../context/ProjectContext';
import { Revision } from '../../types/project';
import { projectService } from '../../services/projectService';

// هوک برای بستن منو با کلیک بیرون
const useClickOutside = (ref: React.RefObject<HTMLElement>, callback: () => void) => {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        callback();
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ref, callback]);
};

interface MenuBarProps {
  onShowProjectSelection: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({ onShowProjectSelection }) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const { projectData, saveProject, projectId } = useProject();
  const menuRef = useRef<HTMLDivElement>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevision, setCurrentRevision] = useState<Revision | null>(null);
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [showCreateRevisionModal, setShowCreateRevisionModal] = useState(false);
  const [newRevisionNumber, setNewRevisionNumber] = useState<string>('0');
  const [newRevisionName, setNewRevisionName] = useState<string>('');
  const [newRevisionDescription, setNewRevisionDescription] = useState<string>('');
  const [creatingRevision, setCreatingRevision] = useState(false);

  useClickOutside(menuRef, () => setActiveMenu(null));

  // Load revisions when project changes
  useEffect(() => {
    if (projectData._id) {
      loadRevisions(projectData._id);
    }
  }, [projectData._id]);

  const loadRevisions = async (projectId: string) => {
    try {
      const revisionsData = await projectService.getRevisions(projectId);
      setRevisions(revisionsData);
      if (revisionsData.length > 0) {
        setCurrentRevision(revisionsData[0]); // Latest revision
      }
    } catch (err) {
      console.error('Failed to load revisions:', err);
      setRevisions([]);
    }
  };

  const handleCreateRevision = async () => {
    if (!projectData._id && !projectId) {
      alert('Please save the project first before creating a revision.');
      return;
    }

    // Check if there's a higher revision
    const latestRevision = revisions.length > 0 ? revisions[0] : null;
    if (latestRevision && currentRevision && currentRevision._id !== latestRevision._id) {
      alert('⚠️ ریویژن بالاتر ساخته شده است و امکان تغییرات در این ریویژن نمی‌باشد');
      return;
    }

    try {
      // Get existing revisions to determine next revision number
      const existingRevisions = await projectService.getRevisions(projectId || projectData._id!);
      
      // Find the highest revision number and increment
      let nextRevisionNum = 0;
      if (existingRevisions.length > 0) {
        const maxRev = Math.max(...existingRevisions.map(r => parseInt(r.revisionNumber) || 0));
        nextRevisionNum = maxRev + 1;
      }
      
      // Open modal instead of prompts
      setNewRevisionNumber(nextRevisionNum.toString());
      setNewRevisionName(`Revision ${nextRevisionNum}`);
      setNewRevisionDescription('');
      setShowCreateRevisionModal(true);
      setActiveMenu(null);
    } catch (err) {
      console.error('Failed to prepare revision creation:', err);
    }
  };

  const handleConfirmCreateRevision = async () => {
    const pid = projectId || projectData._id;
    if (!pid) return;

    setCreatingRevision(true);
    try {
      const newRevision = await projectService.createRevision({
        projectId: pid,
        revisionNumber: newRevisionNumber,
        revisionName: newRevisionName || `Revision ${newRevisionNumber}`,
        description: newRevisionDescription || '',
        createdBy: 'user',
        projectSnapshot: projectData,
        isLocked: false,
      });

      // Reload revisions and update current revision
      const revisionsData = await projectService.getRevisions(pid);
      setRevisions(revisionsData);
      setCurrentRevision(newRevision);
      setShowCreateRevisionModal(false);
    } catch (err) {
      console.error('Failed to create revision:', err);
      throw err;
    } finally {
      setCreatingRevision(false);
    }
  };

  const handleSwitchRevision = async () => {
    setShowRevisionModal(true);
    setActiveMenu(null);
  };

  const handleSelectRevision = async (revision: Revision) => {
    try {
      // Check if trying to switch to an older revision when there's a newer one
      const latestRevision = revisions.length > 0 ? revisions[0] : null;
      
      // Show error if trying to switch to an older revision
      if (latestRevision && revision._id !== latestRevision._id) {
        alert('⚠️ ریویژن بالاتر ساخته شده است و امکان تغییرات در این ریویژن نمی‌باشد');
        setShowRevisionModal(false);
        return;
      }
      
      // Load the selected revision's project snapshot
      setCurrentRevision(revision);
      
      alert(`✅ Switched to Revision ${revision.revisionNumber}: ${revision.revisionName}`);
      setShowRevisionModal(false);
      
      // TODO: Reload project data from revision snapshot
      // This would require calling a parent callback to reload the project
    } catch (err) {
      alert('❌ Failed to switch revision: ' + (err as Error).message);
    }
  };

  const handleMenuClick = (menu: string) => {
    setActiveMenu(activeMenu === menu ? null : menu);
  };

  const handleSave = async () => {
    try {
      await saveProject();
      alert('Project saved successfully!');
      setActiveMenu(null);
    } catch (error) {
      alert('Error saving project');
    }
  };

  const handleSaveAs = () => {
    const newName = prompt('Enter new project name:', projectData.projectName);
    if (newName) {
      // منطق Save As اینجا پیاده‌سازی می‌شود
      console.log('Save as:', newName);
      setActiveMenu(null);
    }
  };

  const handleExport = () => {
    alert('Export functionality will be implemented here');
    setActiveMenu(null);
  };

  const handlePrint = () => {
    window.print();
    setActiveMenu(null);
  };

  return (
    <div className="bg-gray-800 text-white text-sm font-sans" ref={menuRef}>
      <div className="flex items-center h-8">
        {/* File Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'file' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('file')}
          >
            File
          </button>
          {activeMenu === 'file' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={onShowProjectSelection}
                >
                  📁 New Project
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={onShowProjectSelection}
                >
                  📂 Open Project
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handleSave}
                >
                  💾 Save
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handleSaveAs}
                >
                  💾 Save As...
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handleExport}
                >
                  📤 Export...
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handlePrint}
                >
                  🖨️ Print
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => {
                    setActiveMenu(null);
                    window.close();
                  }}
                >
                  ❌ Exit
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Edit Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'edit' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('edit')}
          >
            Edit
          </button>
          {activeMenu === 'edit' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600 opacity-50">
                  ↩️ Undo
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600 opacity-50">
                  ↪️ Redo
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ✂️ Cut
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📋 Copy
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📄 Paste
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔍 Find
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ✏️ Replace
                </button>
              </div>
            </div>
          )}
        </div>

        {/* View Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'view' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('view')}
          >
            View
          </button>
          {activeMenu === 'view' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔍 Zoom In
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔍 Zoom Out
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔄 Reset View
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📊 Toolbars
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📐 Status Bar
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Project Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'project' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('project')}
          >
            Project
          </button>
          {activeMenu === 'project' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button 
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handleCreateRevision}
                >
                  📝 New Revision
                </button>
                <button 
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={handleSwitchRevision}
                >
                  🔄 Switch Revision
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ⚙️ Project Settings
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📋 Project Properties
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔄 Update Project
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📊 Project Reports
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Tools Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'tools' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('tools')}
          >
            Tools
          </button>
          {activeMenu === 'tools' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🛠️ Options
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔧 Customize
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📈 Calculations
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🔌 Device Manager
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Window Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'window' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('window')}
          >
            Window
          </button>
          {activeMenu === 'window' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🪟 New Window
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📑 Arrange All
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🫷 Cascade
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ▢ Tile Horizontally
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ▤ Tile Vertically
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Help Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${
              activeMenu === 'help' ? 'bg-gray-700' : ''
            }`}
            onClick={() => handleMenuClick('help')}
          >
            Help
          </button>
          {activeMenu === 'help' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ❓ Help Contents
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  ℹ️ About Simorgh
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  📚 Tutorials
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">
                  🌐 Online Support
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Project Info */}
        <div className="ml-auto flex items-center space-x-4 text-xs text-gray-300">
          <span>Project: <strong>{projectData.projectName}</strong></span>
          <span>Standard: <strong>{projectData.standard}</strong></span>
          {currentRevision && (
            <span>Revision: <strong className="text-green-400">R{currentRevision.revisionNumber}</strong></span>
          )}
          <span>Modified: <strong>{projectData.changedOn}</strong></span>
        </div>
      </div>

      {/* Revision Switch Modal */}
      {showRevisionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[500px] max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg">Switch Revision</h3>
              <p className="text-xs text-gray-500 mt-1">Select a revision to switch to</p>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {revisions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No revisions available. Create a new revision first.
                </div>
              ) : (
                <div className="space-y-2">
                  {revisions.map((revision, idx) => {
                    const isLatest = idx === 0;
                    const isBase = parseInt(revision.revisionNumber) === 0;
                    return (
                      <div
                        key={revision._id || idx}
                        className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                          currentRevision?._id === revision._id
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:bg-gray-50'
                        }`}
                        onClick={() => handleSelectRevision(revision)}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-gray-800">
                                REV {revision.revisionNumber}
                              </p>
                              {isLatest && (
                                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium">LATEST</span>
                              )}
                              {isBase && (
                                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">BASE</span>
                              )}
                            </div>
                            <p className="text-sm text-gray-700 mt-0.5">{revision.revisionName}</p>
                            <p className="text-xs text-gray-500 mt-1">{revision.description}</p>
                            <p className="text-xs text-gray-400 mt-1">
                              Created: {new Date(revision.createdOn).toLocaleString()}
                            </p>
                          </div>
                          {revision.isLocked && (
                            <span className="text-xs bg-gray-200 text-gray-600 px-2 py-1 rounded">
                              🔒 Locked
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex justify-end px-6 py-4 border-t bg-gray-50">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => {
                  setShowRevisionModal(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Revision Modal */}
      {showCreateRevisionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[500px] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg">Create New Revision</h3>
              <p className="text-xs text-gray-500 mt-1">Create a new revision for "{projectData.projectName}"</p>
            </div>
            
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
                  {projectData.projectName}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Revision Number</label>
                <input
                  type="text"
                  value={newRevisionNumber}
                  readOnly
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500"
                />
                <p className="text-xs text-gray-500 mt-1">Automatically calculated as the next revision number</p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Revision Name</label>
                <input
                  type="text"
                  value={newRevisionName}
                  onChange={(e) => setNewRevisionName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  placeholder="e.g., Electrical design update"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <textarea
                  value={newRevisionDescription}
                  onChange={(e) => setNewRevisionDescription(e.target.value)}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  placeholder="Describe the changes in this revision..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => setShowCreateRevisionModal(false)}
                disabled={creatingRevision}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleConfirmCreateRevision}
                disabled={creatingRevision}
              >
                {creatingRevision ? 'Creating...' : 'Create Revision'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};