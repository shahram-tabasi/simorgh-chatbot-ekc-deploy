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
  const { projectData, saveProject } = useProject();
  const menuRef = useRef<HTMLDivElement>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevision, setCurrentRevision] = useState<Revision | null>(null);
  const [showRevisionModal, setShowRevisionModal] = useState(false);

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
    if (!projectData._id) {
      alert('Please save the project first before creating a revision.');
      return;
    }

    const revisionNumber = prompt('Enter revision number (starts from 0):', '0');
    if (!revisionNumber) return;

    const revisionName = prompt('Enter revision name:', `Revision ${revisionNumber}`);
    if (!revisionName) return;

    const description = prompt('Enter revision description:', 'New revision');

    try {
      const newRevision = await projectService.createRevision({
        projectId: projectData._id!,
        revisionNumber,
        revisionName: revisionName || `Revision ${revisionNumber}`,
        description: description || '',
        createdBy: 'user',
        projectSnapshot: projectData,
        isLocked: false,
      });

      alert(`✅ Revision ${revisionNumber} created successfully!`);
      await loadRevisions(projectData._id!);
      setActiveMenu(null);
    } catch (err) {
      alert('❌ Failed to create revision: ' + (err as Error).message);
    }
  };

  const handleSwitchRevision = async () => {
    setShowRevisionModal(true);
    setActiveMenu(null);
  };

  const handleSelectRevision = async (revision: Revision) => {
    try {
      // Load the selected revision's project snapshot
      // In a real implementation, you would reload the project with the snapshot data
      setCurrentRevision(revision);
      alert(`Switched to Revision ${revision.revisionNumber}: ${revision.revisionName}`);
      setShowRevisionModal(false);
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
                  {revisions.map((revision, idx) => (
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
                          <p className="font-medium text-gray-800">
                            Revision {revision.revisionNumber}: {revision.revisionName}
                          </p>
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
                  ))}
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
    </div>
  );
};