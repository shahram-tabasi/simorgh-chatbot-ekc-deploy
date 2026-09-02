import React, { useState, useEffect, useRef } from 'react';
import { ProjectData, Revision } from '../../types/project';
import { projectService, tpmsService, TpmsOption } from '../../services/projectService';
import { defaultProjectData } from '../../context/ProjectContext';
import { buildTpmsImport } from '../../utils/tpmsImport';
import logoMark from '../../assets/logo-mark.png';

interface ProjectSelectionProps {
  onProjectSelect: (project: ProjectData, revision?: Revision) => void;
  onNewProject:    (projectName: string) => void;
}

// Label shown for a project in the combo box: its code followed by its name
// (e.g. "EKC001  ElectroKavir"), the code muted so the two stay readable.
const projectCode = (p: ProjectData) => (p.projectId || p.projectNumber || '').trim();

// Everything the startup flow needs lives in ONE dialog: pick the project from
// a searchable combo box, pick (or create) its revision underneath, then open.
// No second modal opens on top of this one at any point.
//
// The combo box lists two kinds of project: this suite's own (MongoDB) and the
// ones TPMS holds — the very list Eplanix shows. Picking a TPMS project asks
// for its switchgear and revision instead of a revision, and opening it reads
// the switchgear out of MySQL and lands it in the project. TPMS is only ever
// read; nothing is written back to it.
export const ProjectSelection: React.FC<ProjectSelectionProps> = ({
  onProjectSelect,
  onNewProject,
}) => {
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // ── Project combo box ───────────────────────────────────────────────
  const [comboOpen, setComboOpen] = useState(false);
  const [search, setSearch]       = useState('');
  const [selectedProject, setSelectedProject] = useState<ProjectData | null>(null);
  const comboRef = useRef<HTMLDivElement>(null);

  // ── Revisions of the selected project ───────────────────────────────
  const [revisions, setRevisions]               = useState<Revision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<Revision | null>(null);
  const [loadingRevisions, setLoadingRevisions] = useState(false);

  // ── TPMS (Eplanix's MySQL) — the second half of the combo box ────────
  const [tpmsProjects, setTpmsProjects] = useState<TpmsOption[]>([]);
  const [tpmsListError, setTpmsListError] = useState<string | null>(null);
  const [selectedTpms, setSelectedTpms] = useState<TpmsOption | null>(null);
  const [scopes, setScopes]                     = useState<TpmsOption[]>([]);
  const [selectedScope, setSelectedScope]       = useState<TpmsOption | null>(null);
  const [tpmsRevisions, setTpmsRevisions]       = useState<TpmsOption[]>([]);
  const [selectedTpmsRev, setSelectedTpmsRev]   = useState<TpmsOption | null>(null);
  const [tpmsBusy, setTpmsBusy]                 = useState(false);
  const [opening, setOpening]                   = useState(false);

  // ── Inline "new revision" form (same dialog, not a nested modal) ─────
  const [newRevOpen, setNewRevOpen]               = useState(false);
  const [newRevNumber, setNewRevNumber]           = useState('0');
  const [newRevName, setNewRevName]               = useState('');
  const [newRevDescription, setNewRevDescription] = useState('');
  const [creatingRevision, setCreatingRevision]   = useState(false);

  useEffect(() => { loadProjects(); loadTpmsProjects(); }, []);

  // Close the dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!comboOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setComboOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [comboOpen]);

  const loadProjects = async () => {
    try {
      setLoading(true);
      setProjects(await projectService.getAllProjects());
      setError(null);
    } catch {
      setError('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  // The TPMS list is optional: if this server has no MySQL behind it, the
  // section simply doesn't appear — the suite's own projects still open.
  const loadTpmsProjects = async () => {
    try {
      setTpmsProjects(await tpmsService.getProjects());
      setTpmsListError(null);
    } catch (err) {
      setTpmsProjects([]);
      setTpmsListError((err as Error).message);
    }
  };

  const loadRevisions = async (projectId: string) => {
    try {
      setLoadingRevisions(true);
      const list = await projectService.getRevisions(projectId);
      setRevisions(list);
      // Default to the latest revision (the backend returns them newest-first).
      setSelectedRevision(list.length > 0 ? list[0] : null);
    } catch (err) {
      console.error('Failed to load revisions:', err);
      setRevisions([]);
      setSelectedRevision(null);
    } finally {
      setLoadingRevisions(false);
    }
  };

  const handlePickProject = async (project: ProjectData | null) => {
    setSelectedProject(project);
    setSelectedTpms(null);
    setScopes([]); setSelectedScope(null);
    setTpmsRevisions([]); setSelectedTpmsRev(null);
    setComboOpen(false);
    setSearch('');
    setNewRevOpen(false);
    setRevisions([]);
    setSelectedRevision(null);
    if (project?._id) await loadRevisions(project._id);
  };

  // A TPMS project: its switchgears take the place of the revision list.
  const handlePickTpms = async (option: TpmsOption) => {
    setSelectedTpms(option);
    setSelectedProject(null);
    setRevisions([]); setSelectedRevision(null);
    setNewRevOpen(false);
    setComboOpen(false);
    setSearch('');
    setScopes([]); setSelectedScope(null);
    setTpmsRevisions([]); setSelectedTpmsRev(null);
    setTpmsBusy(true);
    try {
      const list = await tpmsService.getScopes(option.value);
      setScopes(list);
      if (list.length === 1) await handlePickScope(list[0]);
    } catch (err) {
      setError('Could not read the switchgears of this TPMS project: ' + (err as Error).message);
    } finally {
      setTpmsBusy(false);
    }
  };

  const handlePickScope = async (scope: TpmsOption) => {
    setSelectedScope(scope);
    setTpmsRevisions([]); setSelectedTpmsRev(null);
    setTpmsBusy(true);
    try {
      const list = await tpmsService.getRevisions(scope.value);
      setTpmsRevisions(list);
      // Newest revision first, as Eplanix opens it.
      const newest = [...list].sort((a, b) => Number(b.value) - Number(a.value))[0];
      setSelectedTpmsRev(newest ?? null);
    } catch (err) {
      setError('Could not read the revisions of this switchgear: ' + (err as Error).message);
    } finally {
      setTpmsBusy(false);
    }
  };

  // Open a TPMS switchgear as a project: read it, land it in the project that
  // already stands for this TPMS project (matched on PID, OE number or name),
  // or in a fresh one, then open that.
  const handleOpenFromTpms = async () => {
    if (!selectedTpms || !selectedScope || !selectedTpmsRev) return;
    setOpening(true);
    setError(null);
    try {
      const payload = await tpmsService.getImport(
        selectedTpms.value, selectedScope.value, Number(selectedTpmsRev.value));

      const pid = payload.project?.projectMainId != null ? String(payload.project.projectMainId) : '';
      const oe  = (payload.project?.oeNumber || '').trim();
      const name = (payload.project?.projectName || '').trim().toLowerCase();
      let existing = projects.find(p =>
        (pid && (p.projectId || '').trim() === pid) ||
        (oe && (p.projectNumber || '').trim() === oe) ||
        (name && p.projectName.trim().toLowerCase() === name)) ?? null;

      if (existing?._id) {
        try { existing = await projectService.getProjectById(existing._id); }
        catch (err) { console.warn('Using the listed copy of the project:', err); }
      }

      const seed: ProjectData = { ...defaultProjectData, ...(existing ?? {}) };
      const { patch } = buildTpmsImport(seed, payload, {
        projectData: true, techSettings: true, deviceLibrary: true, equipment: true,
      });
      const merged: ProjectData = { ...seed, ...patch };

      let saved: ProjectData = merged;
      if (existing?._id) {
        const { _id, ...body } = merged as any;   // _id is immutable in the update
        saved = await projectService.updateProject(existing._id, body);
      } else {
        const { _id, ...body } = merged as any;
        saved = await projectService.createProject(body);
      }
      onProjectSelect(saved ?? merged);
    } catch (err) {
      setError('Could not open this switchgear from TPMS: ' + (err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const openNewRevisionForm = () => {
    const nextNum = revisions.length > 0
      ? Math.max(...revisions.map(r => parseInt(r.revisionNumber) || 0)) + 1
      : 0;
    setNewRevNumber(String(nextNum));
    setNewRevName(`Revision ${nextNum}`);
    setNewRevDescription('');
    setNewRevOpen(true);
  };

  const handleCreateRevision = async () => {
    if (!selectedProject?._id) return;
    setCreatingRevision(true);
    try {
      // Snapshot the freshest copy of the project, but don't fail the whole
      // operation if that read is unavailable — the project document we
      // already listed is a complete one and works as the snapshot.
      let latestProject = selectedProject;
      try {
        latestProject = await projectService.getProjectById(selectedProject._id);
      } catch (fetchErr) {
        console.warn('Falling back to the listed project for the snapshot:', fetchErr);
      }
      const created = await projectService.createRevision({
        projectId: selectedProject._id,
        revisionNumber: newRevNumber,
        revisionName: newRevName || `Revision ${newRevNumber}`,
        description: newRevDescription || '',
        createdBy: 'user',
        projectSnapshot: latestProject,
        isLocked: false,
      });
      await loadRevisions(selectedProject._id);
      setSelectedRevision(created);
      setNewRevOpen(false);
    } catch (err) {
      setError('Failed to create revision: ' + (err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const trimmed = search.trim();
  const filteredProjects = projects.filter(p => {
    const q = trimmed.toLowerCase();
    if (!q) return true;
    return (
      p.projectName.toLowerCase().includes(q) ||
      (p.projectDescription || '').toLowerCase().includes(q) ||
      projectCode(p).toLowerCase().includes(q)
    );
  });

  const tpmsLabel = (o: TpmsOption) => (o.name || o.text || '').trim();
  const tpmsCode  = (o: TpmsOption) => (o.code || '').trim();
  const filteredTpms = tpmsProjects.filter(o => {
    const q = trimmed.toLowerCase();
    if (!q) return true;
    return (o.text || '').toLowerCase().includes(q);
  });

  const exactMatch =
    projects.some(p => p.projectName.toLowerCase() === trimmed.toLowerCase()) ||
    tpmsProjects.some(o => tpmsLabel(o).toLowerCase() === trimmed.toLowerCase());
  const canCreate  = trimmed.length > 0 && !exactMatch;
  const nothingFound = filteredProjects.length === 0 && filteredTpms.length === 0;

  const handleOpen = () => {
    if (!selectedProject) return;
    onProjectSelect(selectedProject, selectedRevision || undefined);
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center overflow-auto p-6"
      style={{ background: 'radial-gradient(1200px 800px at 10% 10%, #14335f 0%, #0a1a33 45%, #060e1e 100%)' }}
    >
      <style>{`
        @keyframes suiteSheen {
          0%   { background-position: -180% 0; }
          100% { background-position:  180% 0; }
        }
        .suite-sheen-light {
          background-image: linear-gradient(100deg,
            #1d4ed8 0%, #1d4ed8 38%, #7dd3fc 50%, #1d4ed8 62%, #1d4ed8 100%);
          background-size: 220% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: suiteSheen 3.4s linear infinite;
        }
        @keyframes suiteBeam {
          0%, 100% { opacity: .35; transform: scaleX(.75); }
          50%      { opacity: 1;   transform: scaleX(1); }
        }
        .suite-beam-light {
          transform-origin: left center;
          background: linear-gradient(90deg, rgba(37,99,235,0) 0%, #60a5fa 25%, #38bdf8 50%, #60a5fa 75%, rgba(37,99,235,0) 100%);
          box-shadow: 0 0 10px 1px rgba(56,189,248,0.55);
          animation: suiteBeam 3.4s ease-in-out infinite;
        }
      `}</style>

      {/* Faint dot grid, matching the loading screen's texture */}
      <div
        className="absolute inset-0 opacity-[0.12] pointer-events-none"
        style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      />

      {/* ── The single dialog ── */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-[600px] max-w-full flex flex-col my-auto">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 py-5 border-b border-gray-100">
          <img src={logoMark} alt="Simorgh" className="h-20 w-auto" />
          <div className="h-14 w-px bg-gray-200" />
          <div>
            <div className="text-2xl font-extrabold tracking-tight text-blue-900 leading-none">Simorgh</div>
            <div className="suite-sheen-light text-lg font-medium leading-none mt-1">Design Suite</div>
            <div className="suite-beam-light h-[2px] w-full mt-1.5 rounded-full" />
            <p className="text-[11px] text-gray-400 mt-1.5">Electrical Engineering Design Platform</p>
          </div>
        </div>

        {/* No overflow clipping here — the combo box dropdown has to be able to
            hang over the dialog's edge. Every inner list caps its own height. */}
        <div className="px-6 py-5">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-300 text-red-700 text-sm px-4 py-2.5 rounded">
              {error}
            </div>
          )}

          {/* ── Project combo box (search lives inside the dropdown) ── */}
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Project</label>
          <div className="relative" ref={comboRef}>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 border border-gray-400 rounded px-3 py-2 text-sm bg-white hover:border-blue-400 focus:outline-none focus:border-blue-500"
              onClick={() => setComboOpen(o => !o)}
              disabled={loading}
            >
              <span className={`truncate ${selectedProject || selectedTpms ? 'text-gray-800' : 'text-gray-500'}`}>
                {loading
                  ? 'Loading projects…'
                  : selectedProject
                    ? <>
                        {projectCode(selectedProject) && (
                          <span className="text-gray-400 mr-1.5">{projectCode(selectedProject)}</span>
                        )}
                        {selectedProject.projectName}
                      </>
                    : selectedTpms
                      ? <>
                          <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold mr-1.5">TPMS</span>
                          {tpmsCode(selectedTpms) && (
                            <span className="text-gray-400 mr-1.5">{tpmsCode(selectedTpms)}</span>
                          )}
                          {tpmsLabel(selectedTpms)}
                        </>
                      : '-- Select Project --'}
              </span>
              <span className="text-gray-500 text-[10px] leading-none">{comboOpen ? '▲' : '▼'}</span>
            </button>

            {comboOpen && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-400 rounded shadow-2xl flex flex-col max-h-72">
                {/* Search field — part of the combo box itself */}
                <div className="p-1.5 border-b border-gray-200 bg-white">
                  <input
                    type="text"
                    autoFocus
                    className="w-full border-2 border-gray-800 rounded-sm px-2 py-1.5 text-sm focus:outline-none focus:border-blue-600"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && filteredProjects.length > 0) handlePickProject(filteredProjects[0]);
                      else if (e.key === 'Enter' && filteredTpms.length > 0) handlePickTpms(filteredTpms[0]);
                      else if (e.key === 'Enter' && canCreate) onNewProject(trimmed);
                      if (e.key === 'Escape') setComboOpen(false);
                    }}
                  />
                </div>

                <ul className="overflow-y-auto text-sm">
                  <li
                    className="px-3 py-1.5 cursor-pointer text-gray-600 hover:bg-blue-50"
                    onClick={() => handlePickProject(null)}
                  >
                    -- Select Project --
                  </li>

                  {filteredProjects.length > 0 && (
                    <li className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-400 bg-gray-50 border-y border-gray-100">
                      Design Suite
                    </li>
                  )}

                  {filteredProjects.map(p => {
                    const isSel = selectedProject?._id === p._id;
                    return (
                      <li
                        key={p._id}
                        className={`px-3 py-1.5 cursor-pointer truncate ${
                          isSel ? 'bg-blue-500 text-white' : 'hover:bg-blue-50 text-gray-800'
                        }`}
                        onClick={() => handlePickProject(p)}
                        title={p.projectDescription || p.projectName}
                      >
                        {projectCode(p) && (
                          <span className={isSel ? 'text-blue-100 mr-1.5' : 'text-gray-400 mr-1.5'}>
                            {projectCode(p)}
                          </span>
                        )}
                        {p.projectName}
                      </li>
                    );
                  })}

                  {filteredTpms.length > 0 && (
                    <li className="px-3 py-1 text-[10px] uppercase tracking-wide text-purple-500 bg-purple-50 border-y border-purple-100">
                      TPMS — {filteredTpms.length} project{filteredTpms.length === 1 ? '' : 's'}
                    </li>
                  )}

                  {filteredTpms.map(o => {
                    const isSel = selectedTpms?.value === o.value;
                    return (
                      <li
                        key={`tpms-${o.value}`}
                        className={`px-3 py-1.5 cursor-pointer truncate ${
                          isSel ? 'bg-purple-600 text-white' : 'hover:bg-purple-50 text-gray-800'
                        }`}
                        onClick={() => handlePickTpms(o)}
                        title={o.text}
                      >
                        {tpmsCode(o) && (
                          <span className={isSel ? 'text-purple-100 mr-1.5' : 'text-gray-400 mr-1.5'}>
                            {tpmsCode(o)}
                          </span>
                        )}
                        {tpmsLabel(o)}
                      </li>
                    );
                  })}

                  {nothingFound && !canCreate && (
                    <li className="px-3 py-3 text-gray-400 italic">No projects found.</li>
                  )}

                  {canCreate && (
                    <li
                      className="px-3 py-2 cursor-pointer text-blue-700 hover:bg-blue-50 border-t border-gray-100 font-medium"
                      onClick={() => onNewProject(trimmed)}
                    >
                      ➕ Create new project “{trimmed}”
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>

          {/* ── Revision of the selected project ── */}
          {selectedProject && (
            <div className="mt-5">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">Revision</label>
                <button
                  type="button"
                  className="text-xs text-green-700 hover:text-green-800 font-medium disabled:opacity-50"
                  onClick={openNewRevisionForm}
                  disabled={loadingRevisions || newRevOpen}
                >
                  + New Revision
                </button>
              </div>

              {loadingRevisions ? (
                <div className="border border-gray-300 rounded px-3 py-3 text-sm text-gray-500">Loading revisions…</div>
              ) : revisions.length === 0 ? (
                <div className="border border-gray-300 rounded px-3 py-3 text-sm text-gray-500">
                  No revisions yet — REV 0 is created automatically when the project opens.
                </div>
              ) : (
                <div className="border border-gray-300 rounded max-h-40 overflow-y-auto divide-y divide-gray-100">
                  {revisions.map((rev, idx) => {
                    const isLatest = idx === 0;
                    const isBase   = parseInt(rev.revisionNumber) === 0;
                    const isSel    = selectedRevision?._id === rev._id;
                    return (
                      <div
                        key={rev._id || idx}
                        className={`px-3 py-2 cursor-pointer ${isSel ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                        onClick={() => setSelectedRevision(rev)}
                      >
                        <div className="flex items-center gap-2">
                          <input type="radio" readOnly checked={isSel} className="accent-blue-600" />
                          <span className="text-sm font-medium text-gray-800">REV {rev.revisionNumber}</span>
                          {isLatest && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">LATEST</span>}
                          {isBase   && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">BASE</span>}
                          {rev.revisionName && <span className="text-xs text-gray-500 truncate">— {rev.revisionName}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Inline new-revision form — stays inside this same dialog */}
              {newRevOpen && (
                <div className="mt-3 border border-green-200 bg-green-50/60 rounded p-3 space-y-2">
                  <div className="grid grid-cols-3 gap-2 items-center">
                    <label className="text-xs text-gray-600">Revision Number</label>
                    <input
                      readOnly
                      value={newRevNumber}
                      className="col-span-2 border border-gray-300 rounded px-2 py-1 text-sm bg-gray-100 text-gray-500"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2 items-center">
                    <label className="text-xs text-gray-600">Revision Name</label>
                    <input
                      value={newRevName}
                      onChange={e => setNewRevName(e.target.value)}
                      className="col-span-2 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-400"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-xs text-gray-600 pt-1">Description</label>
                    <textarea
                      rows={2}
                      value={newRevDescription}
                      onChange={e => setNewRevDescription(e.target.value)}
                      className="col-span-2 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-400"
                      placeholder="Describe the changes in this revision…"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      className="px-3 py-1.5 border rounded text-xs hover:bg-gray-100"
                      onClick={() => setNewRevOpen(false)}
                      disabled={creatingRevision}
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-1.5 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-50"
                      onClick={handleCreateRevision}
                      disabled={creatingRevision}
                    >
                      {creatingRevision ? 'Creating…' : 'Create Revision'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── A TPMS project: pick the switchgear and its revision ── */}
          {selectedTpms && (
            <div className="mt-5 border border-purple-200 bg-purple-50/50 rounded p-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">TPMS</span>
                <span className="text-sm text-gray-700">
                  Read straight from TPMS — the same data Eplanix shows. Nothing is written back.
                </span>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Switchgear</label>
                <select
                  className="w-full border border-gray-400 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:border-purple-500"
                  value={selectedScope?.value ?? ''}
                  disabled={tpmsBusy || scopes.length === 0}
                  onChange={e => {
                    const found = scopes.find(x => String(x.value) === e.target.value);
                    if (found) handlePickScope(found);
                  }}
                >
                  <option value="">
                    {tpmsBusy && scopes.length === 0
                      ? 'Reading switchgears…'
                      : scopes.length === 0 ? 'No switchgear on this project' : '-- Select Switchgear --'}
                  </option>
                  {scopes.map(o => <option key={o.value} value={o.value}>{o.text}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Revision</label>
                <select
                  className="w-full border border-gray-400 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:border-purple-500"
                  value={selectedTpmsRev?.value ?? ''}
                  disabled={tpmsBusy || tpmsRevisions.length === 0}
                  onChange={e => setSelectedTpmsRev(
                    tpmsRevisions.find(x => String(x.value) === e.target.value) ?? null)}
                >
                  <option value="">
                    {!selectedScope ? 'Pick a switchgear first'
                      : tpmsBusy ? 'Reading revisions…'
                      : tpmsRevisions.length === 0 ? 'No revision on this switchgear' : '-- Select Revision --'}
                  </option>
                  {tpmsRevisions.map(o => (
                    <option key={o.value} value={o.value}>REV {o.text}</option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-gray-500">
                Opening it brings in the project data, technical settings, the panel specification
                as a Device Library entry, every feeder line and the parts on it.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
          <span className="text-xs text-gray-400">
            {projects.length} project{projects.length === 1 ? '' : 's'}
            {tpmsProjects.length > 0 && <> · {tpmsProjects.length} in TPMS</>}
            {tpmsListError && <span className="text-amber-600" title={tpmsListError}> · TPMS unavailable</span>}
          </span>
          {selectedTpms ? (
            <button
              className="px-5 py-2 bg-purple-600 text-white rounded text-sm font-medium hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleOpenFromTpms}
              disabled={!selectedScope || !selectedTpmsRev || opening}
            >
              {opening ? 'Reading from TPMS…' : 'Open from TPMS'}
            </button>
          ) : (
            <button
              className="px-5 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleOpen}
              disabled={!selectedProject}
            >
              Open Project
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
