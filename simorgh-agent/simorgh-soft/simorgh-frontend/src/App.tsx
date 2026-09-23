import React, { useState, useEffect, useRef } from 'react';
import { projectService } from './services/projectService';
import { TabNavigation } from './components/Tabs/TabNavigation';
import { ProjectDefinitionTab } from './components/ProjectDefinition/ProjectDefinitionTab';
import { TemplateCreationTab, KeyboardShortcutsDialog } from './components/TemplateCreation/TemplateCreationTab';
import DeviceSelectionTab from './components/DeviceSelection/DeviceSelectionTab'; // Changed from named to default import
import { OutputTypesTab } from './components/OutputTypes/OutputTypesTab';
import { ProjectSelection } from './components/ProjectSelection/ProjectSelection';
import { SplashScreen } from './components/SplashScreen/SplashScreen';
import { ProjectConflictState, ProjectProvider, useProject } from './context/ProjectContext';
import { COPYRIGHT_LINE, PRODUCT_NAME, PRODUCT_TAGLINE } from './branding';
import { ProjectHistoryModal } from './components/shared/ProjectHistoryModal';
import { buildLabel, buildStamp } from './utils/buildStamp';
import { PanelsProvider, usePanelRegistry } from './context/PanelsContext';
import logoMark from './assets/logo-mark.png';
import { useTheme } from './useTheme';
import { SunIcon, MoonIcon, CpuIcon } from 'lucide-react';
import { SaveNeedsYou } from './services/projectService';
import { Chatbot } from './components/Chatbot/Chatbot';
import { LogicWorkspace } from './components/SimorghLogic/LogicWorkspace';
import { fileSafe } from './utils/download';
import { RevisionLockedModal } from './components/shared/RevisionLockedModal';
import { FeederDuplicateModal } from './components/DeviceSelection/FeederDuplicateModal';
import { TpmsImportModal } from './components/TpmsImport/TpmsImportModal';
import { EplanixTab } from './components/Eplanix/EplanixTab';
import { DocumentsTab } from './components/Documents/DocumentsTab';
import { SendToEplanTab } from './components/SendToEplan/SendToEplanTab';

/**
 * The PLC page, fetched when it is first opened.
 *
 * It carries the code editor — three megabytes of it — and the whole
 * instruction catalogue, and a project that never opens the page should not
 * pay for either. Lazily is the only honest way to add something this size to
 * a bundle that everything else in the suite is also waiting on.
 */
const PlcTab = React.lazy(() => import('./components/PLC/PlcTab'));
import { findFeederDuplicates, DuplicateGroup } from './utils/feederDuplicates';
import { DesktopInstallerInfo } from './services/projectService';
import { Revision } from './types/project';
import { useSymbolLibrary } from './utils/cad/useSymbols';
import { TIERS } from './utils/tiers';

// The build shown in Help → About.
const APP_VERSION = '1.0.0';

/** Read a project back out of a .json file this application wrote. */
function readProjectFile(file: File, onLoad: (project: any) => void): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!data || typeof data !== 'object' || !('projectName' in data)) {
        alert('That file is not a project saved by this application.');
        return;
      }
      if (!window.confirm(
        `Replace what is on screen with "${data.projectName}" from this file?\n\n`
        + 'The project as it is now is written to a file first, so this can be undone.')) return;
      onLoad(data);
    } catch {
      alert('That file could not be read as a project.');
    }
  };
  reader.readAsText(file);
}

/**
 * Autosave has stopped working, and somebody has to be told in the only way
 * that cannot be missed.
 *
 * A red word in the status bar is not enough for this. Work that is on screen
 * and nowhere else looks exactly like work that is saved — that is the whole
 * danger — and the longer nobody notices the more there is to lose.
 *
 * The one useful thing it offers is a file. Not a copy inside the browser:
 * that goes with a cleared cache, a reinstall or a different machine, and a
 * copy somebody believes in and does not have is worse than no copy at all.
 * A .json in a folder is somewhere, and Restore from a copy reads it back.
 *
 * Dismissing it is allowed — the server may come back on its own, and the
 * status bar keeps saying so in red — but each further failure brings it back,
 * because a warning dismissed once must not buy silence for an afternoon in
 * which nothing is being written.
 */
const SaveFailedModal: React.FC<{
  saveError: string | null;
  saveFailures: number;
  saving: boolean;
  lastSavedAt: Date | null;
  /** True where retrying cannot help — see SaveNeedsYou. */
  needsYou: boolean;
  onDownload: () => void;
  onRetry: () => void;
}> = ({ saveError, saveFailures, saving, lastSavedAt, needsYou, onDownload, onRetry }) => {
  const [dismissedAt, setDismissedAt] = useState(0);
  const [saved, setSaved] = useState(false);

  // A save that goes through closes it, whatever the person was in the middle
  // of deciding.
  useEffect(() => { if (!saveError) { setDismissedAt(0); setSaved(false); } }, [saveError]);

  if (!saveError || saveFailures === 0 || saveFailures <= dismissedAt) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10002] p-4">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg">
        <div className="px-5 py-3 border-b border-l-4 border-l-red-500">
          <h3 className="font-semibold text-gray-800">Your work is not being saved</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {lastSavedAt
              ? <>Nothing has reached the database since <strong>{lastSavedAt.toLocaleTimeString()}</strong>.</>
              : <>Nothing has reached the database yet.</>}
            {' '}Everything since then is on this screen only — closing this window would lose it.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-700">
            Save a copy to a folder now. That is the one place it is safe, and
            <strong> File → Restore from a copy…</strong> reads it back when the server is well again.
          </p>
          <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <span className="text-gray-500">The server said: </span>{saveError}
            {saveFailures > 1 && <> · {saveFailures} attempts</>}
          </p>
          <p className="text-xs text-gray-500">
            {needsYou
              ? <>This one will not fix itself by waiting — deal with what the server said, then
                  press <strong>Try now</strong>. Save a copy first either way.</>
              : <>It keeps trying every 15 seconds. If it succeeds, this closes itself and the
                  status bar goes back to saying when it last saved.</>}
          </p>
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex flex-wrap justify-end gap-2">
          <button
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-white"
            onClick={() => setDismissedAt(saveFailures)}
          >
            Keep working
          </button>
          <button
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-white disabled:opacity-50"
            onClick={onRetry}
            disabled={saving}
          >
            {saving ? 'Trying…' : 'Try now'}
          </button>
          <button
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700"
            onClick={() => { onDownload(); setSaved(true); }}
          >
            {saved ? 'Save another copy' : 'Save a copy to disk'}
          </button>
        </div>
      </div>
    </div>
  );
};

// هوک Auto-save
//
// Five seconds after the last change, and again every fifteen while the save
// is failing. A backend that was unreachable for a minute used to cost every
// edit made in that minute: the failure was logged to a console nobody has
// open and the attempt was never made again until the next edit.
//
// The save function is held in a ref rather than named as a dependency. It is
// a new closure on every render, so depending on it restarted the five-second
// timer on every render — and on a screen that renders often, the save would
// keep being pushed into the future.
const useAutoSave = (projectData: any, saveProject: () => Promise<void>, enabled = true) => {
  const saveRef = useRef(saveProject);
  saveRef.current = saveProject;
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const retryRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timeoutRef.current);
    clearTimeout(retryRef.current);

    // A revision that is no longer the latest one is read-only — there is
    // nothing to auto-save, and trying would only raise the lock warning.
    if (!enabled) return;

    const attempt = () => {
      saveRef.current()
        .then(() => console.log('Auto-saved at:', new Date().toLocaleTimeString()))
        .catch(error => {
          // Some failures will fail again however long this waits: two
          // projects with one name, a request the server will not take. The
          // loop stops for those — it was ten attempts deep and climbing when
          // this was reported, and none of them could have worked. The warning
          // stays up, because the work is still unsaved, and Try now still
          // works, because the person may have just fixed it.
          if (error instanceof SaveNeedsYou) {
            console.error('Auto-save cannot succeed until this is dealt with:', error);
            return;
          }
          console.error('Auto-save failed, trying again in 15s:', error);
          clearTimeout(retryRef.current);
          retryRef.current = setTimeout(attempt, 15000);
        });
    };

    timeoutRef.current = setTimeout(attempt, 5000);

    return () => clearTimeout(timeoutRef.current);
  }, [projectData, enabled]);

  // The retry belongs to the window, not to one run of the effect above.
  useEffect(() => () => {
    clearTimeout(timeoutRef.current);
    clearTimeout(retryRef.current);
  }, []);
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
  onImportFromTpms: () => void;
  currentRevision?: any;
  isCurrentRevisionEditable?: boolean;
  /** Raising a revision is allowed even though the open one is read-only. */
  canRaiseRevision?: boolean;
}
const MenuBar: React.FC<MenuBarProps> = ({ onShowProjectSelection, onCreateNewRevision, onImportFromTpms, currentRevision, isCurrentRevisionEditable, canRaiseRevision }) => {
  const { theme, setTheme } = useTheme();
  const [activeMenu,    setActiveMenu]    = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout,     setShowAbout]     = useState(false);
  const [zoom,          setZoom]          = useState(100);
  const {
    projectData, saveProject, notifyRevisionLocked, lastSavedAt, saving, saveError,
    saveNeedsYou, saveFailures, downloadProjectCopy, restoreFromFile, restoreOneSwitchgear,
  } = useProject();
  const [showHistory, setShowHistory] = useState(false);
  // The symbol library, loaded once for the whole app.
  //
  // It used to be loaded by whichever tab happened to want it, from that tab's
  // own effect — so the office's DXF pack reached the drawings and not the
  // template previews, and a symbol redrawn on one screen was still the old
  // one on another until something unrelated made it render again. Up here it
  // is loaded before any tab opens and changed in one place.
  useSymbolLibrary(projectData.symbolOverrides);
  const desktopInstaller = useDesktopInstaller();
  // Everything on screen that can be put away, so View can bring it back.
  // Null outside a provider — the menu simply shows no panel section then.
  const registry = usePanelRegistry();
  const panels = registry?.panels ?? [];
  const isPanelOpen = (id: string) => registry?.isOpen(id) ?? true;
  const togglePanel = (id: string) => registry?.toggle(id);
  const showAllPanels = () => registry?.showAll();
  const menuRef = useRef<HTMLDivElement>(null);
  // Cut / Copy / Paste act on the field the user was last in: opening the
  // menu takes the focus away, so the field is remembered as it is left.
  const lastFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

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

  // Remember the last text field that held the caret.
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        lastFieldRef.current = target;
      }
    };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);

  // View -> Zoom scales the whole app. Chromium (and the Electron desktop
  // client) honour `zoom`; the reset simply clears it again.
  useEffect(() => {
    (document.documentElement.style as any).zoom = zoom === 100 ? '' : `${zoom}%`;
  }, [zoom]);

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

  // Writing to `.value` of a controlled input is discarded on the next
  // render — React keeps its own copy. Go through the native setter and
  // raise the `input` event React actually listens to.
  const writeField = (
    field: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number,
  ) => {
    const proto = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.setSelectionRange(caret, caret);
  };

  const handleClipboard = async (action: 'cut' | 'copy' | 'paste') => {
    setActiveMenu(null);
    const field = lastFieldRef.current;
    if (!field || !field.isConnected) {
      alert('Click inside a field first, then use Edit → ' + action + '.');
      return;
    }
    field.focus();
    const start = field.selectionStart ?? field.value.length;
    const end   = field.selectionEnd   ?? field.value.length;
    const marked = field.value.slice(start, end);
    try {
      if (action === 'paste') {
        const text = await navigator.clipboard.readText();
        writeField(field, field.value.slice(0, start) + text + field.value.slice(end), start + text.length);
        return;
      }
      await navigator.clipboard.writeText(marked || field.value);
      if (action === 'cut' && marked) {
        writeField(field, field.value.slice(0, start) + field.value.slice(end), start);
      }
    } catch {
      alert('The browser would not give the app the clipboard — use Ctrl+X / Ctrl+C / Ctrl+V instead.');
    }
  };

  // The user guides ship with the app (public/*.html), so they open from
  // wherever the suite is mounted rather than from a hard-coded path.
  const helpBase: string = import.meta.env.BASE_URL;
  const helpUrl = `${helpBase}help.html`;
  // The drawing guide is its own page: it is three languages deep and belongs
  // to Simorgh Draw rather than to the four-step workflow the other one walks.
  const drawingGuideUrl = `${helpBase}help-drawing.html`;
  const openHelp = (hash = '') => {
    window.open(`${helpUrl}${hash}`, '_blank', 'noopener');
    setActiveMenu(null);
  };
  const openDrawingGuide = () => {
    window.open(drawingGuideUrl, '_blank', 'noopener');
    setActiveMenu(null);
  };

  // F1 opens the guide from anywhere, the way the rest of the desktop does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F1') {
        event.preventDefault();
        window.open(`${import.meta.env.BASE_URL}help.html`, '_blank', 'noopener');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // A TPMS project is taken over by raising a revision, from whichever of its
  // revisions is open — every one of them is read-only until then, so gating
  // this on the open revision being the latest left no way in from an older
  // one.
  const canCreateRevision = isCurrentRevisionEditable !== false || !!canRaiseRevision;

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
                {/* One entry, not two: "New Project" and "Open Project" both
                    went to the project selection screen, which is where a
                    project is both opened and started. */}
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={onShowProjectSelection}
                  title="Open an existing project, or start a new one"
                >
                  📁 Projects…
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
                {/* A copy in a folder, and the way back from one. Under Save,
                    because that is what somebody is looking for when they come
                    here after losing something. */}
                {/* The versions the server kept. First of the three, because
                    it is the one that answers "it was there this morning"
                    without anybody needing a file or a database client. */}
                <button
                  className={`block w-full text-left px-4 py-2 hover:bg-gray-600 ${
                    projectData._id ? '' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={!projectData._id}
                  onClick={() => { setShowHistory(true); setActiveMenu(null); }}
                  title={projectData._id
                    ? 'Every version of this project the server kept — restore one switchgear or all of it'
                    : 'This project has not been saved yet, so there is nothing kept for it'}
                >
                  🕘 History &amp; restore…
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { downloadProjectCopy(); setActiveMenu(null); }}
                  title="Write the whole project to a .json file on this computer"
                >
                  🗂️ Save a copy to disk…
                </button>
                <label
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600 cursor-pointer"
                  title="Read a project back from a .json file this application wrote"
                >
                  📂 Restore from a copy…
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      setActiveMenu(null);
                      if (file) readProjectFile(file, restoreFromFile);
                    }}
                  />
                </label>
                <div className="border-t border-gray-600 my-1"></div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { onImportFromTpms(); setActiveMenu(null); }}
                >
                  🗄️ Import from TPMS…
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
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={() => handleClipboard('cut')}>
                  ✂️ Cut <span className="text-xs text-gray-400 float-right">Ctrl+X</span>
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={() => handleClipboard('copy')}>
                  📋 Copy <span className="text-xs text-gray-400 float-right">Ctrl+C</span>
                </button>
                <button className="block w-full text-left px-4 py-2 hover:bg-gray-600" onClick={() => handleClipboard('paste')}>
                  📄 Paste <span className="text-xs text-gray-400 float-right">Ctrl+V</span>
                </button>
                {/* Find was a disabled entry promising something, and the
                    shortcuts dialog is on the Help menu where such things
                    live — it was on both. */}
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
                <div className="px-4 py-1 text-[11px] uppercase tracking-wider text-gray-400">Theme</div>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { setTheme('light'); setActiveMenu(null); }}
                >
                  ☀️ Light {theme === 'light' && <span className="float-right">✓</span>}
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { setTheme('dark'); setActiveMenu(null); }}
                >
                  🌙 Dark {theme === 'dark' && <span className="float-right">✓</span>}
                </button>
                <div className="my-1 border-t border-gray-600" />
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => setZoom(z => Math.min(200, z + 10))}
                >
                  🔍 Zoom In <span className="text-xs text-gray-400 float-right">{zoom}%</span>
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => setZoom(z => Math.max(50, z - 10))}
                >
                  🔍 Zoom Out
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => setZoom(100)}
                >
                  🔄 Reset View
                </button>

                {/* Panels, the way EPLAN keeps its navigators: anything that
                    can be closed is listed here, whether it is closed or not,
                    so putting something away can always be undone. */}
                {panels.length > 0 && (
                  <>
                    <div className="border-t border-gray-600 my-1"></div>
                    <div className="px-4 py-1 text-[11px] uppercase tracking-wide text-gray-400">
                      Panels
                    </div>
                    {panels.map(panel => (
                      <button
                        key={panel.id}
                        className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                        onClick={() => togglePanel(panel.id)}
                        title={panel.note}
                      >
                        <span className="inline-block w-4">{isPanelOpen(panel.id) ? '☑' : '☐'}</span>
                        {panel.label}
                        {panel.group && (
                          <span className="text-xs text-gray-400 float-right">{panel.group}</span>
                        )}
                      </button>
                    ))}
                    <button
                      className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                      onClick={() => { showAllPanels(); setActiveMenu(null); }}
                    >
                      <span className="inline-block w-4"></span>
                      Show all panels
                    </button>
                  </>
                )}
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
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => openHelp()}
                >
                  ❓ Help Contents <span className="text-xs text-gray-400 float-right">F1</span>
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => openHelp('#overview')}
                >
                  📚 Tutorials
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={openDrawingGuide}
                >
                  📐 Simorgh Draw guide
                </button>
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { setShowShortcuts(true); setActiveMenu(null); }}
                >
                  ⌨️ Keyboard Shortcuts
                </button>
                <div className="border-t border-gray-600 my-1"></div>
                {desktopInstaller.available && (
                  <a
                    className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                    href={projectService.desktopDownloadUrl()}
                    onClick={() => setActiveMenu(null)}
                  >
                    🪟 Windows app{desktopInstaller.version ? ` (${desktopInstaller.version})` : ''}
                  </a>
                )}
                <button
                  className="block w-full text-left px-4 py-2 hover:bg-gray-600"
                  onClick={() => { setShowAbout(true); setActiveMenu(null); }}
                >
                  ℹ️ About Simorgh
                </button>
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
          {/* What the database has, not what the screen has. This used to show
              projectData.changedOn, which is stamped on every edit — so it read
              as freshly saved while nothing had been written for an hour. */}
          {saveError ? (
            <span
              className="flex items-center text-red-300"
              title={`${saveError} — still trying. Do not close this window.`}
            >
              <span className="inline-block w-2 h-2 bg-red-400 rounded-full mr-2" />
              Not saved{lastSavedAt && ` since ${lastSavedAt.toLocaleTimeString()}`}
            </span>
          ) : saving ? (
            <span className="flex items-center">
              <span className="inline-block w-2 h-2 bg-amber-300 rounded-full mr-2 animate-pulse" />
              Saving…
            </span>
          ) : (
            <span>
              Last saved: <strong>{lastSavedAt ? lastSavedAt.toLocaleTimeString() : '—'}</strong>
            </span>
          )}
        </div>
      </div>
      {showShortcuts && <KeyboardShortcutsDialog onClose={() => setShowShortcuts(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showHistory && projectData._id && (
        <ProjectHistoryModal
          projectId={String(projectData._id)}
          projectName={projectData.projectName}
          onClose={() => setShowHistory(false)}
          onRestoreProject={restoreFromFile}
          onRestoreSwitchgear={restoreOneSwitchgear}
        />
      )}
      <SaveFailedModal
        saveError={saveError}
        saveFailures={saveFailures}
        saving={saving}
        lastSavedAt={lastSavedAt}
        needsYou={saveNeedsYou}
        onDownload={downloadProjectCopy}
        onRetry={() => { saveProject().catch(() => { /* the banner already says */ }); }}
      />
    </div>
  );
};

// What "About Simorgh" shows: the build the user is running and where the
// guide lives, so a support question can name a version.
const AboutDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]" onClick={onClose}>
    <div
      className="bg-white text-gray-800 rounded-lg shadow-2xl w-[420px] overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center gap-3 px-6 py-5 bg-slate-800 text-white">
        <img src={logoMark} alt="" data-theme-invert className="w-10 h-10 rounded" />
        <div>
          <h3 className="font-semibold text-lg leading-tight">{PRODUCT_NAME}</h3>
          <p className="text-xs text-slate-300">{PRODUCT_TAGLINE}</p>
        </div>
      </div>
      <div className="px-6 py-4 text-sm space-y-1.5">
        <p><span className="text-gray-500">Version:</span> <strong>{APP_VERSION}</strong></p>
        {/* The build. It used to be printed across the foot of the project
            picker, which is not what the front door of the application should
            say — but it is still the first thing worth reading when something
            that was working yesterday is not, because every image is tagged
            :latest and the version on screen is the only way to tell two
            apart without the server. */}
        {buildLabel() && (
          <p title={`commit ${buildStamp.sha}${buildStamp.built ? ` · built ${buildStamp.built}` : ''}`}>
            <span className="text-gray-500">Build:</span> <strong>{buildLabel()}</strong>
          </p>
        )}
        <p><span className="text-gray-500">Modules:</span> Project Definition · Create Template · Device Selection · Output · Simorgh Draw</p>
        <p><span className="text-gray-500">Guide:</span>{' '}
          <a
            className="text-blue-600 hover:underline"
            href={`${import.meta.env.BASE_URL}help.html`}
            target="_blank"
            rel="noopener"
          >
            help.html
          </a>
        </p>
        <p className="pt-2 mt-2 border-t text-xs text-gray-500">{COPYRIGHT_LINE}</p>
      </div>
      <div className="flex justify-end px-6 py-3 border-t bg-gray-50">
        <button className="px-4 py-2 border rounded text-sm hover:bg-gray-100" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>
);

/**
 * Two people, one project, two versions of it.
 *
 * This is what used to happen silently: two computers each held the whole
 * project and each saved the whole of it, so whoever saved last wrote over
 * the other's work with nothing on screen to say so. A morning of templates
 * made on one machine disappeared under a morning of device rows made on
 * another.
 *
 * It cannot be merged — the two are whole documents, and guessing which half
 * of each to keep is how both get damaged instead of one. So it is a choice,
 * put plainly, and the side that loses is downloaded first either way. Nothing
 * is thrown away by pressing either button.
 */
const ProjectConflictModal: React.FC<{
  conflict: ProjectConflictState;
  onTakeTheirs: () => void;
  onKeepMine: () => Promise<void>;
}> = ({ conflict, onTakeTheirs, onKeepMine }) => {
  const [busy, setBusy] = useState(false);
  const count = (p: any) => ({
    equipments: p?.equipments?.length ?? 0,
    rows: (p?.equipments ?? []).reduce((n: number, e: any) => n + (e?.devices?.length ?? 0), 0),
    templates: TIERS.reduce((n, t) => n + (p?.templates?.[t]?.length ?? 0), 0),
  });
  const mine = count(conflict.mine);
  const theirs = count(conflict.theirs);

  const Side: React.FC<{ title: string; note: string; n: ReturnType<typeof count> }> =
    ({ title, note, n }) => (
      <div className="flex-1 rounded border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="font-medium text-sm text-gray-800">{title}</p>
        <p className="text-[11px] text-gray-500 mb-1.5">{note}</p>
        <p className="text-xs text-gray-700">
          {n.templates} template(s) · {n.equipments} switchgear(s) · {n.rows} device row(s)
        </p>
      </div>
    );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001] p-4">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl">
        <div className="px-5 py-3 border-b border-l-4 border-l-amber-500">
          <h3 className="font-semibold text-gray-800">
            This project was changed on another computer
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Somebody saved <strong>{conflict.theirs?.projectName}</strong> while you had it
            open, so your last change was not saved. Nothing has been lost yet — whichever
            you choose, the other one is downloaded first.
          </p>
        </div>

        <div className="px-5 py-4 flex gap-3">
          <Side title="Yours" note="what is on this screen" n={mine} />
          <Side title="Theirs" note="what is in the database now" n={theirs} />
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex flex-wrap justify-end gap-2">
          <button
            disabled={busy}
            onClick={onTakeTheirs}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-white disabled:opacity-50"
            title="Load their version. Yours is downloaded as a .json file first."
          >
            Take theirs (mine is downloaded)
          </button>
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onKeepMine(); } finally { setBusy(false); } }}
            className="px-4 py-2 text-sm bg-amber-700 text-white rounded hover:bg-amber-800 disabled:opacity-50"
            title="Save your version over theirs. Theirs is downloaded as a .json file first."
          >
            {busy ? 'Saving…' : 'Keep mine (theirs is downloaded)'}
          </button>
        </div>
      </div>
    </div>
  );
};

// کامپوننت اصلی اپ
const MainApp: React.FC = () => {
  const { theme, toggle: toggleTheme } = useTheme();
  const [activeTab,               setActiveTab]               = useState(0);
  // Simorgh Logic takes the whole window while it is open — see the button.
  const [logicOpen,               setLogicOpen]               = useState(false);
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
    isTpmsMastered,
    blockingRevisionNumbers,
    revisionLockNotice,
    notifyRevisionLocked,
    dismissRevisionLockNotice,
    lastSavedAt,
    saving,
    saveError,
    conflict,
    resolveConflictTakeTheirs,
    resolveConflictKeepMine
  } = useProject();

  // Auto-save — off while a locked (non-latest) revision is selected, and off
  // while TPMS owns the project (it is written by the sync, not from here).
  // Off while two versions of the project are on the table: saving would
  // either keep failing or, once it stopped failing, overwrite one of them.
  useAutoSave(
    projectData, saveProject,
    isCurrentRevisionEditable && !isTpmsMastered && !conflict);

  // Closing the window while work is still on its way to the database — or
  // stuck because the server cannot be reached — asks first. The browser shows
  // its own wording; all it wants from us is that there is something to lose.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const edited = new Date(projectData.changedOn).getTime();
      const written = lastSavedAt ? lastSavedAt.getTime() : 0;
      if (!saving && !saveError && written >= edited) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [projectData.changedOn, lastSavedAt, saving, saveError]);

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

  const [showTpmsImport, setShowTpmsImport] = useState(false);
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
    },
    {
      id: 4,
      title: `Simorgh Draw`,
      component: <EplanixTab />
    },
    {
      id: 5,
      // The controller's program — blocks, tags and the instruction catalogue.
      // Beside Simorgh Draw rather than inside it: a panel's logic and a
      // panel's drawings are one job, and a program kept in a separate tool is
      // the one that is a revision behind when the job ships.
      title: `PLC`,
      component: (
        <React.Suspense fallback={
          <div className="h-full flex items-center justify-center text-sm text-gray-500">
            Opening the PLC page…
          </div>
        }
        >
          <PlcTab />
        </React.Suspense>
      )
    },
    {
      id: 6,
      title: `Documents`,
      component: <DocumentsTab />
    },
    {
      id: 7,
      title: `Send to EPLAN`,
      component: <SendToEplanTab />
    }
  ];


  return (
    <div className="flex flex-col w-full h-screen overflow-hidden bg-gray-100">
      {/* Menu Bar */}
      <MenuBar
        onShowProjectSelection={() => window.location.reload()}
        onCreateNewRevision={handleCreateNewRevision}
        onImportFromTpms={() => setShowTpmsImport(true)}
        currentRevision={currentRevision}
        isCurrentRevisionEditable={isCurrentRevisionEditable}
        canRaiseRevision={isTpmsMastered}
      />
      
      {/* Header with Revision Dropdown */}
      <div className="bg-white shadow-md border-b">
        <div className="w-full px-4">
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
            <img src={logoMark} alt="Simorgh logo" data-theme-invert className="h-16 w-auto object-contain" />
            <div className="mx-4 h-12 w-px bg-gray-300 self-center" />
            <div className="header-wordmark">
              <div className="text-xl font-extrabold tracking-tight text-blue-900 leading-none">Simorgh</div>
              <div className="header-suite-sheen text-sm font-medium leading-none mt-1">Design Suite</div>
              <div className="header-suite-beam h-[2px] w-full mt-1 rounded-full" />
            </div>
            <div className="ml-auto flex items-center space-x-4">
              <button
                onClick={toggleTheme}
                title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                className="p-2 rounded border border-gray-300 hover:bg-gray-100 transition-colors"
              >
                {theme === 'dark'
                  ? <SunIcon className="w-4 h-4 text-amber-500" />
                  : <MoonIcon className="w-4 h-4 text-gray-600" />}
              </button>
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

              {/* Simorgh Logic — a door, not a tab.
                  Ladder is a different job from drawing a panel: a different
                  vocabulary, a different unit of work, often a different person
                  at the keyboard. As one more tab it would put a PLC toolbar on
                  every switchgear drawing and leave every program one mis-click
                  from the busbar, so it takes the whole window and hands it
                  back on the way out. */}
              <button
                onClick={() => setLogicOpen(true)}
                title="Ladder programming — its own workspace"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-700 text-white hover:bg-violet-800"
              >
                <CpuIcon className="w-4 h-4" />
                Simorgh Logic
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Engineering workflow navigation — a distinct toolbar band (not an
          in-page stepper), same pattern as the logo header above it. */}
      <div className="bg-white border-b shadow-sm">
        <div className="w-full px-4">
          <TabNavigation tabs={tabs} activeTab={activeTab} onTabChange={requestTab} />
        </div>
      </div>

      {/* Read-only banner — TPMS owns this project until a revision is raised
          here. */}
      {isTpmsMastered && (
        <div className="bg-purple-50 border-b border-purple-300 px-4 py-2">
          <div className="w-full flex items-center gap-2 text-sm text-purple-900">
            <span>🗄️</span>
            <span>
              Read-only — this project is read from <strong>TPMS</strong>
              {projectData.tpmsSync?.oeNumber ? ` (${projectData.tpmsSync.oeNumber})` : ''} every time it
              opens. Raise a revision to take it over and edit it here.
            </span>
            <button
              className="ml-auto px-3 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700 disabled:opacity-50"
              onClick={() => { setNewRevisionName(`Revision ${getNextRevisionNumber()}`); setShowCreateRevisionModal(true); }}
            >
              + New Revision
            </button>
          </div>
        </div>
      )}

      {/* Read-only banner — a non-latest revision cannot be edited until the
          newer revisions are deleted. */}
      {!isTpmsMastered && !isCurrentRevisionEditable && currentRevision && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2">
          <div className="w-full flex items-center gap-2 text-sm text-amber-900">
            <span>🔒</span>
            <span>
              <strong>REV {currentRevision.revisionNumber}</strong> is read-only
              {blockingRevisionNumbers.length > 0
                ? ` — a newer revision (${blockingRevisionNumbers.map(n => `REV ${n}`).join(', ')}) exists.`
                : ' — a newer revision exists.'}
            </span>
            <span className="ml-auto text-amber-800">
              Delete the newer revisions first to make changes here.
            </span>
          </div>
        </div>
      )}

      {/* محتوای اصلی + پنل چت‌بات (split layout) */}
      <div className="flex flex-row flex-1 min-h-0">
        {/* The workspace runs to the edges of the window rather than sitting in
            a centred column. A drawing, a parts table and a device matrix all
            want the width, and when a panel beside them is closed they should
            get the room it gave up — a capped container would have left it as
            grey margin instead. */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="w-full px-4 py-4">
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

      {logicOpen && (
        <LogicWorkspace
          fileBase={fileSafe(projectData.projectName || 'project')}
          titleBlock={[
            projectData.projectName || 'PROJECT',
            projectData.projectNumber ? `OE ${projectData.projectNumber}` : '',
            new Date().toLocaleDateString(),
          ].filter(Boolean)}
          onClose={() => setLogicOpen(false)}
        />
      )}

      {/* Footer */}
      <div className="bg-gray-800 text-white text-xs py-2">
        <div className="w-full px-4 flex justify-between items-center">
          <span>{COPYRIGHT_LINE}</span>
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
            <span>
              Version 1.0.0 | Auto-save:{' '}
              {isTpmsMastered
                ? 'off (read from TPMS)'
                : isCurrentRevisionEditable ? 'Enabled' : 'off (revision locked)'}
            </span>
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

      {/* TPMS import — the switchgear data Simorgh Draw reads from MySQL */}
      {showTpmsImport && (
        <TpmsImportModal
          onClose={() => setShowTpmsImport(false)}
          onImported={() => setActiveTab(DEVICE_SELECTION_TAB)}
        />
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

      {conflict && (
        <ProjectConflictModal
          conflict={conflict}
          onTakeTheirs={resolveConflictTakeTheirs}
          onKeepMine={resolveConflictKeepMine}
        />
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
      {/* Which panels are on screen. Outside ProjectProvider's data but inside
          the app, because it belongs to the person rather than the project. */}
      <PanelsProvider>
        <MainApp />
      </PanelsProvider>
    </ProjectProvider>
  );
}