import React, { useState, useEffect, useRef } from 'react';
import { useProject } from '../../context/ProjectContext';

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

  useClickOutside(menuRef, () => setActiveMenu(null));

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
          <span>Modified: <strong>{projectData.changedOn}</strong></span>
        </div>
      </div>
    </div>
  );
};