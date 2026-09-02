import React, { useState, useEffect, useRef } from 'react';
import { projectService } from './services/projectService';
import { TabNavigation } from './components/Tabs/TabNavigation';
import { ProjectDefinitionTab } from './components/ProjectDefinition/ProjectDefinitionTab';
import { TemplateCreationTab, KeyboardShortcutsDialog } from './components/TemplateCreation/TemplateCreationTab';
import DeviceSelectionTab from './components/DeviceSelection/DeviceSelectionTab'; // Changed from named to default import
import { OutputTypesTab } from './components/OutputTypes/OutputTypesTab';
import { ProjectSelection } from './components/ProjectSelection/ProjectSelection';
import { SplashScreen } from './components/SplashScreen/SplashScreen';
import { ProjectProvider, useProject } from './context/ProjectContext';
import logoMark from './assets/logo-mark.png';
import { Chatbot } from './components/Chatbot/Chatbot';
import { RevisionLockedModal } from './components/shared/RevisionLockedModal';
import { FeederDuplicateModal } from './components/DeviceSelection/FeederDuplicateModal';
import { findFeederDuplicates, DuplicateGroup } from './utils/feederDuplicates';
import { DesktopInstallerInfo } from './services/projectService';
import { Revision } from './types/project';

// هوک Auto-save
const useAutoSave = (projectData: any, saveProject: () => Promise<void>, enabled = true) => {
  const timeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // A revision that is no longer the latest one is read-only — there is
    // nothing to auto-save, and trying would only raise the lock warning.
    if (!enabled) return;

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
  }, [projectData, saveProject, enabled]);
};

// Looks up the Windows installer published on the server. Checked once per
// window; if nothing is published the link simply never appears.
const useDesktopInstaller = (): DesktopInstallerInfo => {
  const [info, setInfo] = useState<DesktopInstallerInfo>({ available: false });
  useEffect(() => {
    let cancelled = false;
    projectService.getDesktopInstaller().then(result => {
      if (!cancelled) setInfo(result);
    });
    return () => { cancelled = true; };
  }, []);
  return info;
};

// Human-readable file size for the download link ("86.4 MB").
const formatSize = (bytes?: number) =>
  !bytes ? '' : bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

// کامپوننت MenuBar
interface MenuBarProps {
  onShowProjectSelection: () => void;
  onCreateNewRevision: () => void;
  currentRevision?: any;
  isCurrentRevisionEditable?: boolean;
}
const MenuBar: React.FC<MenuBarProps> = ({ onShowProjectSelection, onCreateNewRevision, currentRevision, isCurrentRevisionEditable }) => {
  const [activeMenu,    setActiveMenu]    = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const { projectData, saveProject, notifyRevisionLocked } = useProject();
  const desktopInstaller = useDesktopInstaller();
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
      // A locked revision raises its own dialog from the context — don't
      // stack a second alert on top of it.
      if (isCurrentRevisionEditable !== false) {
        alert('❌ ' + ((error as Error)?.message || 'Error saving project'));
      }
    }
  };

  const handleExport = () => {
    // Export به JSON
    const dataStr = JSON.stringify(projectData, { type: 'application/json' });
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

  const canCreateRevision = isCurrentRevisionEditable !== false;

  const handleCreateRevisionClick = () => {
    if (!canCreateRevision) {
      notifyRevisionLocked();
      return;
    }
    onCreateNewRevision();
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
                  className={`block w-full text-left px-4 py-2 hover:bg-gray-600 ${!canCreateRevision ? 'opacity-50 cursor-not-allowed' : ''}`} 
                  onClick={handleCreateRevisionClick}
                  disabled={!canCreateRevision}
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
                {desktopInstaller.available && (
                  <a
                    className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                    href={projectService.desktopDownloadUrl()}
                    onClick={() => setActiveMenu(null)}
                  >
                    🪟 Windows app{desktopInstaller.version ? ` (${desktopInstaller.version})` : ''}
                  </a>
                )}
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
            <span>Revision: <strong className="text-blue-300">REV {currentRevision.revisionNumber}</strong></span>
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
    deleteRevision,
    getNextRevisionNumber,
    isCurrentRevisionEditable,
    blockingRevisionNumbers,
    revisionLockNotice,
    notifyRevisionLocked,
    dismissRevisionLockNotice
  } = useProject();

  // Auto-save — disabled while a locked (non-latest) revision is selected.
  useAutoSave(projectData, saveProject, isCurrentRevisionEditable);

  const desktopInstaller = useDesktopInstaller();

  // Load revisions when project changes
  React.useEffect(() => {
    if (projectData._id) {
      loadRevisions(projectData._id);
    }
  }, [projectData._id]);

  // ── Leaving Device Selection: FEEDER NO. must be unique per switchgear ──
  // Nothing interrupts the user while they work on the tab; the check runs
  // once, on the way out, and the dialog carries the whole picture.
  const [feederDuplicates, setFeederDuplicates] = useState<DuplicateGroup[]>([]);
  const [pendingTab, setPendingTab] = useState<number | null>(null);

  const goToTab = (tabId: number) => {
    // Clicking Project Definition directly starts on its Project Data sub-tab.
    if (tabId === 0) { setProjDefSubTab('project-data'); setNavigatingToDeviceId(undefined); }
    setActiveTab(tabId);
  };

  const requestTab = (tabId: number) => {
    const leavingDeviceSelection = activeTab === DEVICE_SELECTION_TAB && tabId !== DEVICE_SELECTION_TAB;
    if (leavingDeviceSelection) {
      const duplicates = findFeederDuplicates(projectData);
      if (duplicates.length > 0) {
        setFeederDuplicates(duplicates);
        setPendingTab(tabId);
        return;
      }
    }
    goToTab(tabId);
  };

  const closeFeederDialog = () => { setFeederDuplicates([]); setPendingTab(null); };

  const continuePastFeederDialog = () => {
    const target = pendingTab;
    closeFeederDialog();
    if (target !== null) goToTab(target);
  };

  // Feeder numbers already in use per equipment, so the dialog can tell whether
  // a value typed into it collides with a row it isn't showing.
  const feederUsage = React.useMemo(() => {
    const usage: Record<string, string[]> = {};
    for (const eq of projectData.equipments ?? []) {
      usage[eq.id] = (eq.devices ?? []).map(d => String(d.feederNo ?? ''));
    }
    return usage;
  }, [projectData.equipments]);

  // Write the dialog's corrections into the real rows, then re-check: if
  // something still collides the dialog stays up, showing the new state.
  const applyFeederEdits = (edits: Record<string, string>) => {
    const touched = new Set(Object.keys(edits));
    for (const eq of projectData.equipments ?? []) {
      const devices = eq.devices ?? [];
      if (!devices.some(d => touched.has(d.id))) continue;
      updateEquipment(eq.id, {
        devices: devices.map(d => (touched.has(d.id) ? { ...d, feederNo: edits[d.id] } : d)),
      });
    }
    setPendingFeederRecheck(true);
  };

  // Re-check after React has applied the edits above.
  const [pendingFeederRecheck, setPendingFeederRecheck] = useState(false);
  React.useEffect(() => {
    if (!pendingFeederRecheck) return;
    setPendingFeederRecheck(false);
    const duplicates = findFeederDuplicates(projectData);
    if (duplicates.length === 0) continuePastFeederDialog();
    else setFeederDuplicates(duplicates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFeederRecheck, projectData]);

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

  // Set when the user deliberately switches to an older revision. The lock
  // dialog is raised from an effect (not inline) so it reads the freshly
  // applied revision state rather than the pre-switch one.
  const [pendingLockWarning, setPendingLockWarning] = useState(false);

  React.useEffect(() => {
    if (!pendingLockWarning) return;
    if (!isCurrentRevisionEditable) notifyRevisionLocked();
    setPendingLockWarning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLockWarning, isCurrentRevisionEditable, blockingRevisionNumbers]);

  const [showRevisionDropdown, setShowRevisionDropdown] = useState(false);
  const [showCreateRevisionModal, setShowCreateRevisionModal] = useState(false);
  const [newRevisionName, setNewRevisionName] = useState('');
  const [newRevisionDescription, setNewRevisionDescription] = useState('');
  const [creatingRevision, setCreatingRevision] = useState(false);
  const [switchingRevision, setSwitchingRevision] = useState(false);
  const [revisionToDelete, setRevisionToDelete] = useState<Revision | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletingRevision, setDeletingRevision] = useState(false);

  const handleCreateNewRevision = async () => {
    // Auto-save handles saving, so we can proceed directly
    const nextNum = getNextRevisionNumber();
    setNewRevisionName(`Revision ${nextNum}`);
    setNewRevisionDescription('');
    setShowCreateRevisionModal(true);
  };

  const handleConfirmCreateRevision = async () => {
    if (!projectData._id) return;
    
    setCreatingRevision(true);
    try {
      await createRevision(newRevisionName || `Revision ${getNextRevisionNumber()}`, newRevisionDescription);
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
      // Warn right away when the user lands on an older, read-only revision
      const selectedRev = revisions.find(r => r._id === revisionId);
      const latestRev = revisions[0];
      if (selectedRev && latestRev && selectedRev._id !== latestRev._id) {
        setPendingLockWarning(true);
      }
    } catch (err) {
      console.error('Failed to switch revision:', err);
      alert('Failed to switch revision: ' + (err as Error).message);
    } finally {
      setSwitchingRevision(false);
    }
  };

  const handleDeleteRevisionClick = (revision: Revision) => {
    if (revisions.length <= 1) {
      alert('⚠️ Cannot delete the only remaining revision. A project must always have at least one revision.');
      return;
    }
    setRevisionToDelete(revision);
    setDeletePassword('');
  };

  const handleConfirmDeleteRevision = async () => {
    if (!revisionToDelete) return;
    setDeletingRevision(true);
    try {
      await deleteRevision(revisionToDelete._id!, deletePassword);
      setRevisionToDelete(null);
      setDeletePassword('');
    } catch (err) {
      alert('❌ ' + (err as Error).message);
    } finally {
      setDeletingRevision(false);
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
          onNext={() => requestTab(3)}
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
        currentRevision={currentRevision}
        isCurrentRevisionEditable={isCurrentRevisionEditable}
      />
      
      {/* Header with Revision Dropdown */}
      <div className="bg-white shadow-md border-b">
        <div className="container mx-auto px-4">
          <style>{`
            @keyframes headerWordmarkReveal {
              from { opacity: 0; transform: translateX(-10px) scaleX(0.85); }
              to   { opacity: 1; transform: translateX(0) scaleX(1); }
            }
            .header-wordmark { transform-origin: left center; animation: headerWordmarkReveal 0.7s cubic-bezier(0.22,1,0.36,1) 0.2s both; }

            /* Light sweeping across "Design Suite", same effect as the splash. */
            @keyframes headerSuiteSheen {
              0%   { background-position: -180% 0; }
              100% { background-position:  180% 0; }
            }
            .header-suite-sheen {
              background-image: linear-gradient(100deg,
                #1d4ed8 0%, #1d4ed8 38%, #7dd3fc 50%, #1d4ed8 62%, #1d4ed8 100%);
              background-size: 220% 100%;
              -webkit-background-clip: text;
              background-clip: text;
              color: transparent;
              animation: headerSuiteSheen 3.4s linear infinite;
            }
            @keyframes headerSuiteBeam {
              0%, 100% { opacity: .3; transform: scaleX(.75); }
              50%      { opacity: 1;  transform: scaleX(1); }
            }
            .header-suite-beam {
              transform-origin: left center;
              background: linear-gradient(90deg, rgba(37,99,235,0) 0%, #60a5fa 25%, #38bdf8 50%, #60a5fa 75%, rgba(37,99,235,0) 100%);
              box-shadow: 0 0 8px 1px rgba(56,189,248,0.5);
              animation: headerSuiteBeam 3.4s ease-in-out infinite;
            }
          `}</style>
          <div className="flex items-center py-3">
            {/* Transparent, cropped logo mark — no white plate, so the bird
                itself is what you see and it reads noticeably larger. */}
            <img src={logoMark} alt="Simorgh logo" className="h-16 w-auto object-contain" />
            <div className="mx-4 h-12 w-px bg-gray-300 self-center" />
            <div className="header-wordmark">
              <div className="text-xl font-extrabold tracking-tight text-blue-900 leading-none">Simorgh</div>
              <div className="header-suite-sheen text-sm font-medium leading-none mt-1">Design Suite</div>
              <div className="header-suite-beam h-[2px] w-full mt-1 rounded-full" />
            </div>
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
                            <div
                              key={revision._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => handleSwitchRevision(revision._id!)}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchRevision(revision._id!); }}
                              aria-disabled={switchingRevision}
                              className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer ${
                                switchingRevision ? 'opacity-50 pointer-events-none' : ''
                              } ${isActive ? 'bg-blue-50 border-l-4 border-blue-500' : ''}`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1 min-w-0">
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
                                  {revision.description && (
                                    <p className="text-xs text-gray-500 mt-0.5 truncate">{revision.description}</p>
                                  )}
                                  {revision.createdOn && (
                                    <p className="text-xs text-gray-400 mt-0.5">
                                      {new Date(revision.createdOn).toLocaleString()}
                                    </p>
                                  )}
                                </div>
                                <div className="flex items-center space-x-2 flex-shrink-0">
                                  {isActive && (
                                    <svg className="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                    </svg>
                                  )}
                                  {isLatest && (
                                    <button
                                      type="button"
                                      title="Delete this revision"
                                      onClick={(e) => { e.stopPropagation(); handleDeleteRevisionClick(revision); }}
                                      className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 rounded px-1.5 py-1"
                                    >
                                      🗑️
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
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

      {/* Engineering workflow navigation — a distinct toolbar band (not an
          in-page stepper), same pattern as the logo header above it. */}
      <div className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4">
          <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={requestTab} />
        </div>
      </div>

      {/* Read-only banner — a non-latest revision cannot be edited until the
          newer revisions are deleted. */}
      {!isCurrentRevisionEditable && currentRevision && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2">
          <div className="container mx-auto flex items-center gap-2 text-sm text-amber-900">
            <span>🔒</span>
            <span>
              <strong>REV {currentRevision.revisionNumber}</strong> is read-only
              {blockingRevisionNumbers.length > 0
                ? ` — a newer revision (${blockingRevisionNumbers.map(n => `REV ${n}`).join(', ')}) exists.`
                : ' — a newer revision exists.'}
            </span>
            <span dir="rtl" className="ml-auto text-amber-800">
              برای اعمال تغییرات، ابتدا ریویژن‌های بالاتر را حذف کنید.
            </span>
          </div>
        </div>
      )}

      {/* محتوای اصلی + پنل چت‌بات (split layout) */}
      <div className="flex flex-row flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="container mx-auto px-4 py-4">
            <div className="bg-white rounded-lg shadow-md p-6">
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
          <span className="flex items-center gap-3">
            {desktopInstaller.available && (
              <a
                href={projectService.desktopDownloadUrl()}
                className="text-gray-400 hover:text-white transition-colors"
                title={`Windows installer${desktopInstaller.size ? ` — ${formatSize(desktopInstaller.size)}` : ''}`}
              >
                🪟 Windows app{desktopInstaller.version ? ` ${desktopInstaller.version}` : ''}
              </a>
            )}
            <span>Version 1.0.0 | Auto-save: Enabled</span>
          </span>
        </div>
      </div>

      {/* Create New Revision Modal */}
      {showCreateRevisionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[500px] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg">Create New Revision</h3>
              <p className="text-xs text-gray-500 mt-1">
                Revision {getNextRevisionNumber()} will be cloned from the current revision
                {currentRevision ? ` (REV ${currentRevision.revisionNumber})` : ''}.
              </p>
            </div>

            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Revision Name</label>
                <input
                  type="text"
                  value={newRevisionName}
                  onChange={(e) => setNewRevisionName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                  placeholder="e.g., Electrical design update"
                  autoFocus
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

      {/* Delete Revision Modal (password required) */}
      {revisionToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[420px] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg text-red-700">Delete Revision {revisionToDelete.revisionNumber}</h3>
              <p className="text-xs text-gray-500 mt-1">This cannot be undone. Enter the password to confirm.</p>
            </div>
            <div className="px-6 py-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmDeleteRevision(); }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => { setRevisionToDelete(null); setDeletePassword(''); }}
                disabled={deletingRevision}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleConfirmDeleteRevision}
                disabled={deletingRevision || !deletePassword}
              >
                {deletingRevision ? 'Deleting...' : 'Delete Revision'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate FEEDER NO. — raised on the way out of Device Selection */}
      {feederDuplicates.length > 0 && (
        <FeederDuplicateModal
          groups={feederDuplicates}
          usedByEquipment={feederUsage}
          onApply={applyFeederEdits}
          onIgnore={continuePastFeederDialog}
          onCancel={closeFeederDialog}
        />
      )}

      {/* Revision-locked warning — raised by any blocked edit attempt */}
      {revisionLockNotice && (
        <RevisionLockedModal notice={revisionLockNotice} onClose={dismissRevisionLockNotice} />
      )}
    </div>
  );
};

// Device Selection's position in the tab strip.
const DEVICE_SELECTION_TAB = 2;

// Marks that the loading screen has already played for this run of the app.
const SPLASH_SHOWN_KEY = 'simorgh-splash-shown';

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

  // Splash screen gate — runs real startup checks (backend health, font
  // readiness, asset preload) before anything else renders. The deep-link
  // effect below still starts immediately in parallel (hooks always run),
  // so it isn't slowed down by the splash.
  //
  // It belongs to opening the software, not to moving around inside it:
  // New Project / Open Project reload the page, and this flag (kept for the
  // lifetime of the window) is what stops the splash from playing again.
  // Closing the app and starting it again shows it, as it should.
  const [booted, setBooted] = useState(() => {
    try { return sessionStorage.getItem(SPLASH_SHOWN_KEY) === '1'; }
    catch { return false; }
  });
  const markBooted = () => {
    try { sessionStorage.setItem(SPLASH_SHOWN_KEY, '1'); } catch { /* private mode */ }
    setBooted(true);
  };

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

  if (!booted) {
    return <SplashScreen onComplete={markBooted} />;
  }

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