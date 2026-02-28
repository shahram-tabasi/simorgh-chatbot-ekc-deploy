import React, { useState, useEffect, useRef } from 'react';
import { TabNavigation } from './components/Tabs/TabNavigation';
import { ProjectDefinitionTab } from './components/ProjectDefinition/ProjectDefinitionTab';
import { TemplateCreationTab, KeyboardShortcutsDialog } from './components/TemplateCreation/TemplateCreationTab';
import DeviceSelectionTab from './components/DeviceSelection/DeviceSelectionTab'; // Changed from named to default import
import { OutputTypesTab } from './components/OutputTypes/OutputTypesTab';
import { ProjectSelection } from './components/ProjectSelection/ProjectSelection';
import { ProjectProvider, useProject } from './context/ProjectContext';
import simorghLogo from './assets/simrgh.jpg';

// هوک Auto-save
const useAutoSave = (projectData: any, saveProject: () => Promise<void>) => {
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Set new timeout for auto-save (5 seconds after last change)
    timeoutRef.current = setTimeout(async () => {
      try {
        await saveProject();
        console.log('Auto-saved at:', new Date().toLocaleTimeString());
      } catch (error) {
        console.error('Auto-save failed:', error);
      }
    }, 5000);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [projectData, saveProject]);
};

// کامپوننت MenuBar
const MenuBar: React.FC<{ onShowProjectSelection: () => void }> = ({ onShowProjectSelection }) => {
  const [activeMenu,    setActiveMenu]    = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const { projectData, saveProject } = useProject();
  const menuRef = useRef<HTMLDivElement>(null);

  // Click outside handler
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleMenuClick = (menu: string) => {
    setActiveMenu(activeMenu === menu ? null : menu);
  };

  const handleSave = async () => {
    try {
      await saveProject();
      alert('✅ Project saved successfully!');
      setActiveMenu(null);
    } catch (error) {
      alert('❌ Error saving project');
    }
  };

  const handleExport = () => {
    // Export به JSON
    const dataStr = JSON.stringify(projectData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${projectData.projectName}_export.json`;
    link.click();
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
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${activeMenu === 'file' ? 'bg-gray-700' : ''}`}
            onClick={() => handleMenuClick('file')}
          >
            File
          </button>
          {activeMenu === 'file' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={onShowProjectSelection}>
                  📁 New Project
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={onShowProjectSelection}>
                  📂 Open Project
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={handleSave}>
                  💾 Save
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={handleExport}>
                  📤 Export JSON
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={handlePrint}>
                  🖨️ Print
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={() => window.close()}>
                  ❌ Exit
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Edit Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${activeMenu === 'edit' ? 'bg-gray-700' : ''}`}
            onClick={() => handleMenuClick('edit')}
          >
            Edit
          </button>
          {activeMenu === 'edit' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">✂️ Cut</button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">📋 Copy</button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">📄 Paste</button>
                <div className="border-t border-gray-600 my-1"></div>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">🔍 Find</button>
                <div className="border-t border-gray-600 my-1"></div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { setShowShortcuts(true); setActiveMenu(null); }}
                >
                  ⌨️ Keyboard Shortcuts
                </button>
              </div>
            </div>
          )}
        </div>

        {/* View Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${activeMenu === 'view' ? 'bg-gray-700' : ''}`}
            onClick={() => handleMenuClick('view')}
          >
            View
          </button>
          {activeMenu === 'view' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">🔍 Zoom In</button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">🔍 Zoom Out</button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">🔄 Reset View</button>
              </div>
            </div>
          )}
        </div>

        {/* Help Menu */}
        <div className="relative">
          <button
            className={`px-3 py-1 h-8 hover:bg-gray-700 ${activeMenu === 'help' ? 'bg-gray-700' : ''}`}
            onClick={() => handleMenuClick('help')}
          >
            Help
          </button>
          {activeMenu === 'help' && (
            <div className="absolute left-0 top-8 bg-gray-700 border border-gray-600 shadow-lg z-50 min-w-48">
              <div className="py-1">
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">❓ Help Contents</button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600">ℹ️ About Simorgh</button>
              </div>
            </div>
          )}
        </div>

        {/* Project Info - نمایش نام پروژه */}
        <div className="ml-auto flex items-center space-x-4 text-xs text-gray-300 px-4">
          <span className="flex items-center">
            <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
            Project: <strong className="ml-1 text-white">{projectData.projectName}</strong>
          </span>
          <span>Standard: <strong>{projectData.standard}</strong></span>
          <span>Last saved: <strong>{new Date(projectData.changedOn).toLocaleTimeString()}</strong></span>
        </div>
      </div>
      {showShortcuts && <KeyboardShortcutsDialog onClose={() => setShowShortcuts(false)} />}
    </div>
  );
};

// کامپوننت اصلی اپ
const MainApp: React.FC = () => {
  const [activeTab,               setActiveTab]               = useState(0);
  const [navigatingToTemplateId,  setNavigatingToTemplateId]  = useState<string | null>(null);
  // Controls which sub-tab ProjectDefinitionTab opens on
  const [projDefSubTab, setProjDefSubTab] = useState<'project-data' | 'device-library'>('project-data');
  const [navigatingToDeviceId,    setNavigatingToDeviceId]    = useState<string | undefined>(undefined);

  const {
    projectData,
    saveProject,
    selectedEquipment,
    setSelectedEquipment,
    updateEquipment,
    addEquipment,
    deleteEquipment,
    copyEquipment
  } = useProject();

  // Auto-save
  useAutoSave(projectData, saveProject);

  // Navigate to Template Creation tab
  const handleNavigateToTemplate = (templateId: string) => {
    setNavigatingToTemplateId(templateId);
    setActiveTab(1);
  };

  // Navigate from DeviceSelection → Project Definition → Device Library sub-tab
  const handleNavigateToDeviceLibrary = (deviceId?: string) => {
    setProjDefSubTab('device-library');
    setNavigatingToDeviceId(deviceId);
    setActiveTab(0);
  };

  const tabs = [
    {
      id: 0,
      title: `Project Definition`,
      component: (
        <ProjectDefinitionTab
          onComplete={() => setActiveTab(1)}
          requestedSubTab={projDefSubTab}
          requestedDeviceId={navigatingToDeviceId}
        />
      )
    },
    {
      id: 1,
      title: `Create Template`,
      component: <TemplateCreationTab onComplete={() => setActiveTab(2)} initialSelectedTemplate={navigatingToTemplateId} />
    },
    {
      id: 2,
      title: `Device Selection`,
      component: (
        <DeviceSelectionTab
          projectData={projectData}
          selectedEquipment={selectedEquipment}
          setSelectedEquipment={setSelectedEquipment}
          updateEquipment={updateEquipment}
          addEquipment={addEquipment}
          deleteEquipment={deleteEquipment}
          copyEquipment={copyEquipment}
          onNext={() => setActiveTab(3)}
          onNavigateToTemplate={handleNavigateToTemplate}
          onNavigateToDeviceLibrary={handleNavigateToDeviceLibrary}
        />
      )
    },
    {
      id: 3,
      title: `Output Types`,
      component: <OutputTypesTab />
    }
  ];

  return (
    <div className="flex flex-col w-full min-h-screen bg-gray-100">
      {/* Menu Bar */}
      <MenuBar onShowProjectSelection={() => window.location.reload()} />
      
      {/* Header */}
      <div className="bg-white shadow-md">
        <div className="container mx-auto px-4">
          <div className="flex items-center py-3">
            <img src={simorghLogo} alt="Simorgh logo" className="max-h-10 w-auto mr-3 object-contain" />
            <h1 className="text-xl font-bold text-blue-800">Simorgh Electrical Design Software</h1>
            <div className="ml-auto flex items-center space-x-3">
              <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 px-3 py-1 rounded">
                <strong className="text-blue-800">Active Project:</strong> {projectData.projectName}
              </div>
              <div className="text-xs text-gray-500">
                {projectData.devices.length} devices
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* محتوای اصلی */}
      <div className="container mx-auto px-4 py-4 flex-1">
        <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={(tabId) => {
          // When user manually clicks the Project Definition tab, reset to Project Data sub-tab
          if (tabId === 0) { setProjDefSubTab('project-data'); setNavigatingToDeviceId(undefined); }
          setActiveTab(tabId);
        }} />
        <div className="mt-4 bg-white rounded-lg shadow-md p-6">
          {tabs[activeTab].component}
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-800 text-white text-xs py-2">
        <div className="container mx-auto px-4 flex justify-between items-center">
          <span>© 2025 Simorgh Software - Professional Electrical Design</span>
          <span>Version 1.0.0 | Auto-save: Enabled</span>
        </div>
      </div>
    </div>
  );
};

// کامپوننت اصلی با Project Selection
export function App() {
  const [currentProject, setCurrentProject] = useState<any>(null);
  const [showProjectSelection, setShowProjectSelection] = useState(true);

  const handleProjectSelect = (project: any) => {
    setCurrentProject(project);
    setShowProjectSelection(false);
  };

  // projectName is the name typed by the user in the "Create New Project" dialog
  const handleNewProject = (projectName: string) => {
    setCurrentProject({ projectName });
    setShowProjectSelection(false);
  };

  if (showProjectSelection) {
    return <ProjectSelection onProjectSelect={handleProjectSelect} onNewProject={handleNewProject} />;
  }

  return (
    <ProjectProvider initialProject={currentProject}>
      <MainApp />
    </ProjectProvider>
  );
}