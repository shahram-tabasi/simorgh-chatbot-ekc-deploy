import React, { useState, useEffect, useRef } from 'react';
import { projectService } from './services/projectService';
import { TabNavigation } from './components/Tabs/TabNavigation';
import { ProjectDefinitionTab } from './components/ProjectDefinition/ProjectDefinitionTab';
import { TemplateCreationTab, KeyboardShortcutsDialog } from './components/TemplateCreation/TemplateCreationTab';
import DeviceSelectionTab from './components/DeviceSelection/DeviceSelectionTab'; // Changed from named to default import
import { OutputTypesTab } from './components/OutputTypes/OutputTypesTab';
import { ProjectSelection } from './components/ProjectSelection/ProjectSelection';
import { ProjectProvider, useProject } from './context/ProjectContext';
import simorghLogo from './assets/simrgh.jpg';
import { Chatbot } from './components/Chatbot/Chatbot';

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
interface MenuBarProps {
  onShowProjectSelection: () => void;
  onCreateNewRevision: () => void;
}
const MenuBar: React.FC<MenuBarProps> = ({ onShowProjectSelection, onCreateNewRevision }) => {
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
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={onCreateNewRevision}>
                  📝 Create Revision
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
          {currentRevision && (
            <span>Revision: <strong className="text-blue-300">{currentRevision}</strong></span>
          )}
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
    copyEquipment,
    currentRevision,
    revisions,
    loadRevisions,
    switchRevision,
    createRevision,
    getNextRevisionNumber
  } = useProject();

  // Auto-save
  useAutoSave(projectData, saveProject);

  // Load revisions when project changes
  React.useEffect(() => {
    if (projectData._id) {
      loadRevisions(projectData._id);
    }
  }, [projectData._id]);

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

  const [showRevisionDropdown, setShowRevisionDropdown] = useState(false);
  const [showCreateRevisionModal, setShowCreateRevisionModal] = useState(false);
  const [newRevisionName, setNewRevisionName] = useState('');
  const [newRevisionDescription, setNewRevisionDescription] = useState('');
  const [creatingRevision, setCreatingRevision] = useState(false);
  const [switchingRevision, setSwitchingRevision] = useState(false);

  const handleCreateNewRevision = async () => {
    if (!projectData._id) {
      alert('Please save the project first before creating a revision.');
      return;
    }
    const nextNum = getNextRevisionNumber();
    setNewRevisionName(`Revision ${nextNum}`);
    setNewRevisionDescription('');
    setShowCreateRevisionModal(true);
  };

  const handleConfirmCreateRevision = async () => {
    if (!projectData._id) return;
    
    setCreatingRevision(true);
    try {
      const newRev = await createRevision(newRevisionName || `Revision ${getNextRevisionNumber()}`, newRevisionDescription);
      setShowCreateRevisionModal(false);
      setNewRevisionName('');
      setNewRevisionDescription('');
    } catch (err) {
      console.error('Failed to create revision:', err);
      alert('Failed to create revision: ' + (err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const handleSwitchRevision = async (revisionId: string) => {
    setSwitchingRevision(true);
    try {
      await switchRevision(revisionId);
      setShowRevisionDropdown(false);
    } catch (err) {
      console.error('Failed to switch revision:', err);
      alert('Failed to switch revision: ' + (err as Error).message);
    } finally {
      setSwitchingRevision(false);
    }
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
    <div className="flex flex-col w-full h-screen overflow-hidden bg-gray-100">
      {/* Menu Bar */}
      <MenuBar 
        onShowProjectSelection={() => window.location.reload()} 
        onCreateNewRevision={handleCreateNewRevision}
      />
      
      {/* Header with Revision Dropdown */}
      <div className="bg-white shadow-md border-b">
        <div className="container mx-auto px-4">
          <div className="flex items-center py-3">
            <img src={simorghLogo} alt="Simorgh logo" className="max-h-10 w-auto mr-3 object-contain" />
            <h1 className="text-xl font-bold text-blue-800">Simorgh Electrical Design Software</h1>
            <div className="ml-auto flex items-center space-x-4">
              {/* Project Name */}
              <div className="text-sm text-gray-700">
                <span className="font-medium">Project:</span> {projectData.projectName}
              </div>
              
              {/* Revision Dropdown */}
              {revisions.length > 0 && currentRevision && (
                <div className="relative">
                  <button
                    onClick={() => setShowRevisionDropdown(!showRevisionDropdown)}
                    disabled={switchingRevision}
                    className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 border border-blue-300 rounded hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="text-sm font-semibold text-blue-800">
                      REV {currentRevision.revisionNumber}
                    </span>
                    <svg className={`w-4 h-4 text-blue-600 transition-transform ${showRevisionDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  
                  {/* Revision Dropdown Menu */}
                  {showRevisionDropdown && (
                    <div className="absolute right-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
                      <div className="py-2">
                        <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100 mb-1">
                          Select Revision
                        </div>
                        {revisions.map((revision, idx) => {
                          const isLatest = idx === 0;
                          const isBase = parseInt(revision.revisionNumber) === 0;
                          const isActive = currentRevision._id === revision._id;
                          
                          return (
                            <button
                              key={revision._id}
                              onClick={() => handleSwitchRevision(revision._id)}
                              disabled={switchingRevision}
                              className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                isActive ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center space-x-2">
                                    <span className={`font-medium ${isActive ? 'text-blue-800' : 'text-gray-800'}`}>
                                      REV {revision.revisionNumber}
                                    </span>
                                    {isLatest && (
                                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium">LATEST</span>
                                    )}
                                    {isBase && (
                                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-medium">BASE</span>
                                    )}
                                  </div>
                                  {revision.revisionName && (
                                    <p className="text-xs text-gray-600 mt-0.5">{revision.revisionName}</p>
                                  )}
                                </div>
                                {isActive && (
                                  <svg className="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      
                      {/* Create New Revision Button */}
                      <div className="border-t border-gray-200 p-2">
                        <button
                          onClick={() => {
                            setShowRevisionDropdown(false);
                            handleCreateNewRevision();
                          }}
                          className="w-full flex items-center justify-center space-x-2 px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors text-sm"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          <span>Create New Revision</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              
              {/* Standard */}
              <div className="text-sm text-gray-700">
                <span className="font-medium">Standard:</span> {projectData.standard || 'N/A'}
              </div>
              
              {/* Device Count */}
              <div className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                {projectData.devices.length} devices
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* محتوای اصلی + پنل چت‌بات (split layout) */}
      <div className="flex flex-row flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="container mx-auto px-4 py-4">
            <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={(tabId) => {
              // When user manually clicks the Project Definition tab, reset to Project Data sub-tab
              if (tabId === 0) { setProjDefSubTab('project-data'); setNavigatingToDeviceId(undefined); }
              setActiveTab(tabId);
            }} />
            <div className="mt-4 bg-white rounded-lg shadow-md p-6">
              {tabs[activeTab].component}
            </div>
          </div>
        </div>

        {/* AI chatbot — embedded sibling column (not a floating overlay).
            We hand it the active-tab state so it can both surface the
            current tab to the model and let the AI navigate between tabs. */}
        <Chatbot activeTab={activeTab} setActiveTab={setActiveTab} />
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
  // Deep-link bootstrap: if the URL carries `?projectId=<mongo-id>` (set by
  // the chatbot bridge after it POSTs to simorgh-soft /api/projects),
  // load that project NOW and skip the selection screen — otherwise the
  // user lands on the create/select dialog and the param is never
  // consumed (the previous ProjectContext-side hydration ran too late).
  const initialPidFromUrl = React.useMemo(() => {
    try { return new URLSearchParams(window.location.search).get('projectId'); }
    catch { return null; }
  }, []);

  const [currentProject, setCurrentProject] = useState<any>(null);
  const [showProjectSelection, setShowProjectSelection] = useState(!initialPidFromUrl);
  const [deepLinkLoading, setDeepLinkLoading] = useState(!!initialPidFromUrl);
  const [deepLinkError, setDeepLinkError] = useState<string>('');

  useEffect(() => {
    if (!initialPidFromUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await projectService.getProjectById(initialPidFromUrl);
        if (cancelled) return;
        if (p) {
          setCurrentProject(p);
          setShowProjectSelection(false);
        } else {
          setDeepLinkError('Project not found.');
          setShowProjectSelection(true);
        }
      } catch (e: any) {
        setDeepLinkError(e?.message || 'Could not load the linked project.');
        setShowProjectSelection(true);
      } finally {
        if (!cancelled) setDeepLinkLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialPidFromUrl]);

  const handleProjectSelect = (project: any, revision?: any) => {
    // If a revision is selected, load the project snapshot from that revision
    if (revision && revision.projectSnapshot) {
      setCurrentProject(revision.projectSnapshot);
    } else {
      setCurrentProject(project);
    }
    setShowProjectSelection(false);
  };

  // projectName is the name typed by the user in the "Create New Project" dialog
  const handleNewProject = (projectName: string) => {
    setCurrentProject({ projectName });
    setShowProjectSelection(false);
  };

  if (deepLinkLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-300 bg-slate-900">
        <div>Loading project…</div>
      </div>
    );
  }

  if (showProjectSelection) {
    return (
      <>
        {deepLinkError && (
          <div className="fixed top-2 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded bg-red-500/15 border border-red-500/40 text-red-200 text-sm">
            {deepLinkError}
          </div>
        )}
        <ProjectSelection onProjectSelect={handleProjectSelect} onNewProject={handleNewProject} />
      </>
    );
  }

  return (
    <ProjectProvider initialProject={currentProject}>
      <MainApp />
    </ProjectProvider>
  );
}