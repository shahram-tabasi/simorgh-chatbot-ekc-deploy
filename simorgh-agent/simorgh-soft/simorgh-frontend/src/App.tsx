import React, { useState, useEffect, useRef } from 'react';
import { TabNavigation } from './components/Tabs/TabNavigation';
import { ProjectDefinitionTab } from './components/ProjectDefinition/ProjectDefinitionTab';
import { TemplateCreationTab, KeyboardShortcutsDialog } from './components/TemplateCreation/TemplateCreationTab';
import DeviceSelectionTab from './components/DeviceSelection/DeviceSelectionTab';
import { OutputTypesTab } from './components/OutputTypes/OutputTypesTab';
import { ProjectSelection } from './components/ProjectSelection/ProjectSelection';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { RevisionProvider, useRevision } from './context/RevisionContext';
import { RevisionDropdown } from './components/shared/RevisionDropdown';
import { CreateRevisionModal } from './components/shared/CreateRevisionModal';
import simorghLogo from './assets/simrgh.jpg';
import { ProjectData, RevisionCreateData } from './types/project';

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

// کامپوننت MenuBar با قابلیت Create Revision
interface MenuBarProps {
  onShowProjectSelection: () => void;
  onCreateRevision: () => void;
}

const MenuBar: React.FC<MenuBarProps> = ({ onShowProjectSelection, onCreateRevision }) => {
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
                <button 
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600" 
                  onClick={() => {
                    onCreateRevision();
                    setActiveMenu(null);
                  }}
                >
                  ➕ Create New Revision
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

        {/* Project Info - نمایش نام پروژه و Revision */}
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

// کامپوننت Header با Revision Dropdown
const Header: React.FC = () => {
  const { projectData } = useProject();
  const { revisions, currentRevision, switchToRevision, deleteRevision } = useRevision();

  const handleSwitchRevision = async (revisionId: string) => {
    try {
      const projectSnapshot = await switchToRevision(revisionId);
      // Parent component will handle updating project data
      console.log('Switched to revision:', revisionId);
    } catch (error) {
      console.error('Failed to switch revision:', error);
      alert('Failed to switch revision');
    }
  };

  const handleDeleteRevision = async (revisionId: string) => {
    try {
      await deleteRevision(revisionId, ''); // Password will be entered in modal
    } catch (error: any) {
      throw error; // Error handled in RevisionDropdown
    }
  };

  return (
    <div className="bg-white shadow-md">
      <div className="container mx-auto px-4">
        <div className="flex items-center py-3">
          <img src={simorghLogo} alt="Simorgh logo" className="max-h-10 w-auto mr-3 object-contain" />
          <h1 className="text-xl font-bold text-blue-800">Simorgh Electrical Design Software</h1>
          <div className="ml-auto flex items-center space-x-3">
            <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 px-3 py-1 rounded">
              <strong className="text-blue-800">Active Project:</strong> {projectData.projectName}
            </div>
            {/* Revision Dropdown */}
            <RevisionDropdown
              revisions={revisions}
              currentRevision={currentRevision}
              onSwitchRevision={handleSwitchRevision}
              onDeleteRevision={handleDeleteRevision}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// کامپوننت اصلی اپ با Revision support
const MainApp: React.FC<{ 
  projectId: string;
  onShowProjectSelection: () => void;
}> = ({ projectId, onShowProjectSelection }) => {
  const [activeTab,               setActiveTab]               = useState(0);
  const [navigatingToTemplateId,  setNavigatingToTemplateId]  = useState<string | null>(null);
  const [projDefSubTab, setProjDefSubTab] = useState<'project-data' | 'device-library'>('project-data');
  const [navigatingToDeviceId,    setNavigatingToDeviceId]    = useState<string | undefined>(undefined);
  const [showCreateRevision, setShowCreateRevision] = useState(false);

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

  const {
    revisions,
    currentRevision,
    loadRevisions,
    createRevision,
    switchToRevision
  } = useRevision();

  // Load revisions when project changes
  useEffect(() => {
    if (projectId) {
      loadRevisions(projectId);
    }
  }, [projectId]);

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

  // Handle Create Revision
  const handleCreateRevision = async (revisionData: RevisionCreateData) => {
    // Include current project snapshot
    const fullRevisionData = {
      ...revisionData,
      projectSnapshot: { ...projectData }
    };
    
    const result = await createRevision(fullRevisionData);
    
    // After successful creation, switch to the new revision and load its data
    if (result._id) {
      const projectSnapshot = await switchToRevision(result._id);
      // Update would be handled by parent context
      console.log('Created and switched to revision:', result.revisionLabel);
    }
  };

  // Calculate next revision number
  const nextRevisionNumber = revisions.length > 0 
    ? Math.max(...revisions.map(r => r.revisionNumber)) + 1 
    : 0;

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
      {/* Menu Bar with Create Revision */}
      <MenuBar 
        onShowProjectSelection={onShowProjectSelection} 
        onCreateRevision={() => setShowCreateRevision(true)}
      />
      
      {/* Header with Revision Dropdown */}
      <Header />

      {/* محتوای اصلی */}
      <div className="container mx-auto px-4 py-4 flex-1">
        <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={(tabId) => {
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
          <span>Version 1.0.0 | Auto-save: Enabled | Revisions: {revisions.length}</span>
        </div>
      </div>

      {/* Create Revision Modal */}
      <CreateRevisionModal
        isOpen={showCreateRevision}
        onClose={() => setShowCreateRevision(false)}
        onCreate={handleCreateRevision}
        projectName={projectData.projectName}
        projectId={projectId}
        nextRevisionNumber={nextRevisionNumber}
      />
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

  const handleNewProject = (projectName: string) => {
    setCurrentProject({ projectName });
    setShowProjectSelection(false);
  };

  const handleCloseProject = () => {
    setCurrentProject(null);
    setShowProjectSelection(true);
  };

  if (showProjectSelection) {
    return <ProjectSelection onProjectSelect={handleProjectSelect} onNewProject={handleNewProject} />;
  }

  const projectId = currentProject?._id || '';

  return (
    <ProjectProvider initialProject={currentProject}>
      <RevisionProvider projectId={projectId}>
        <MainApp 
          projectId={projectId} 
          onShowProjectSelection={handleCloseProject}
        />
      </RevisionProvider>
    </ProjectProvider>
  );
}