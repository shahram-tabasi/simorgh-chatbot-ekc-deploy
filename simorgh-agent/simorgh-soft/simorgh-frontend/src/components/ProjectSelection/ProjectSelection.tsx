import React, { useState, useEffect, useRef } from 'react';
import { ProjectData, Revision } from '../../types/project';
import { projectService, tpmsService, TpmsOption } from '../../services/projectService';
import { syncProjectFromTpms, findLinkedProject, TpmsSyncResult } from '../../services/tpmsSync';
import { TpmsProjectHeader } from '../../utils/tpmsProjectImport';
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
// ones TPMS holds — the very list Eplanix shows. Picking a TPMS project reads
// the whole project: every switchgear, and every TPMS revision as a revision
// on this side. Nothing is asked and nothing is written back to TPMS.
//
// A project that came from TPMS stays TPMS's until a revision is raised here:
// opening it reads TPMS again, so it is always what TPMS says. That is why a
// linked project is re-read on Open Project too.
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
  const [tpmsHeader, setTpmsHeader]     = useState<TpmsProjectHeader | null>(null);
  const [tpmsBusy, setTpmsBusy]         = useState(false);
  const [opening, setOpening]           = useState(false);
  const [progress, setProgress]         = useState<string>('');
  const [revisionScope, setRevisionScope] = useState<'all' | 'newest'>('all');
  // A read that came back with holes in it: shown before opening, so nobody
  // works on a project that is quietly missing a switchgear.
  const [pending, setPending]           = useState<TpmsSyncResult | null>(null);
  // What TPMS says about the size of a project, for one that will not open.
  const [stats, setStats]               = useState<any | null>(null);
  const [statsBusy, setStatsBusy]       = useState(false);

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
    setTpmsHeader(null);
    setComboOpen(false);
    setSearch('');
    setNewRevOpen(false);
    setRevisions([]);
    setSelectedRevision(null);
    if (project?._id) await loadRevisions(project._id);
  };

  // A TPMS project: read what it holds so the dialog can say what is coming —
  // switchgears and revisions — before anything is written here.
  const handlePickTpms = async (option: TpmsOption) => {
    setSelectedTpms(option);
    setSelectedProject(null);
    setRevisions([]); setSelectedRevision(null);
    setNewRevOpen(false);
    setComboOpen(false);
    setSearch('');
    setTpmsHeader(null);
    setStats(null);
    setPending(null);
    setTpmsBusy(true);
    try {
      setTpmsHeader(await tpmsService.getProjectHeader(option.value));
    } catch (err) {
      setError('Could not read this project from TPMS: ' + (err as Error).message);
    } finally {
      setTpmsBusy(false);
    }
  };

  // What TPMS holds for this project and how long each read takes. Used when
  // a project will not open: it says whether TPMS answers at all, and how big
  // the thing being read actually is.
  const handleCheck = async () => {
    if (!selectedTpms) return;
    setStatsBusy(true);
    setStats(null);
    try {
      setStats(await tpmsService.getProjectStats(selectedTpms.value));
    } catch (err) {
      setStats({ error: (err as Error).message });
    } finally {
      setStatsBusy(false);
    }
  };

  // Read the whole project — every switchgear, every revision — into this
  // suite and open it. A project that already stands for it (linked, or same
  // PID / OE number / name) is refreshed rather than duplicated.
  const handleOpenFromTpms = async () => {
    if (!selectedTpms || !tpmsHeader) return;
    setOpening(true);
    setError(null);
    setPending(null);
    try {
      const existing = findLinkedProject(projects, tpmsHeader);
      const result = await syncProjectFromTpms(
        selectedTpms.value,
        existing,
        message => setProgress(message),
        { revisions: revisionScope, header: tpmsHeader },
      );
      if (result.problems.length > 0) { setPending(result); return; }
      onProjectSelect(result.project, result.current || undefined);
    } catch (err) {
      setError('Could not open this project from TPMS: ' + (err as Error).message);
    } finally {
      setOpening(false);
      setProgress('');
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

  // The same rule the database uses (projectNameKey on the server): no case,
  // no double spaces, no edges. Comparing on case alone let "Sarmad Iron &
  // Steel CO." and "Sarmad  Iron & Steel CO." both be created, and then there
  // were two of them in the list with no way to tell which was which.
  const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

  const exactMatch =
    projects.some(p => nameKey(p.projectName) === nameKey(trimmed)) ||
    tpmsProjects.some(o => nameKey(tpmsLabel(o)) === nameKey(trimmed));
  const canCreate  = trimmed.length > 0 && !exactMatch;

  // Projects that already share a name. They cannot be told apart in a list
  // that shows only the name, so the ones that clash say so and show when
  // each was last changed — enough to decide which to keep.
  const sharedNames = new Set(
    Object.entries(
      projects.reduce<Record<string, number>>((n, p) => {
        const k = nameKey(p.projectName || '');
        n[k] = (n[k] ?? 0) + 1;
        return n;
      }, {}),
    ).filter(([, n]) => n > 1).map(([k]) => k),
  );
  const nothingFound = filteredProjects.length === 0 && filteredTpms.length === 0;

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
      // Raising a revision here on a TPMS-linked project is the hand-over:
      // Design Suite becomes its master and it stops being read from TPMS.
      const tpmsSync = latestProject.tpmsSync?.master === 'tpms'
        ? {
            ...latestProject.tpmsSync,
            master: 'suite' as const,
            detachedAt: new Date().toISOString(),
            detachedAtRevision: newRevNumber,
          }
        : latestProject.tpmsSync;
      const snapshot = { ...latestProject, ...(tpmsSync ? { tpmsSync } : {}) };

      const created = await projectService.createRevision({
        projectId: selectedProject._id,
        revisionNumber: newRevNumber,
        revisionName: newRevName || `Revision ${newRevNumber}`,
        description: newRevDescription || '',
        createdBy: 'user',
        projectSnapshot: snapshot,
        isLocked: false,
        source: 'suite',
      });
      if (tpmsSync && tpmsSync !== latestProject.tpmsSync) {
        try { await projectService.updateProject(selectedProject._id, { tpmsSync }); }
        catch (err) { console.error('Could not mark the project as taken over:', err); }
        setSelectedProject(snapshot);
        setProjects(prev => prev.map(p => (p._id === snapshot._id ? snapshot : p)));
      }
      await loadRevisions(selectedProject._id);
      setSelectedRevision(created);
      setNewRevOpen(false);
    } catch (err) {
      setError('Failed to create revision: ' + (err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const handleOpen = async () => {
    if (!selectedProject) return;
    // A project TPMS still owns is read again on the way in, so what opens is
    // what TPMS has now. Raising a revision here ends that.
    const sync = selectedProject.tpmsSync;
    if (sync?.master === 'tpms' && sync.projectMainId) {
      setOpening(true);
      setError(null);
      try {
        const result = await syncProjectFromTpms(
          sync.projectMainId, selectedProject, message => setProgress(message),
          { revisions: revisionScope });
        // Keep the revision the user picked, if it survived the refresh.
        const picked = selectedRevision
          ? result.revisions.find(r => r.revisionNumber === selectedRevision.revisionNumber)
          : null;
        onProjectSelect(result.project, picked || result.current || undefined);
        return;
      } catch (err) {
        // TPMS being unreachable must not stand between the user and their
        // project: say so, and open the copy that is already here.
        console.warn('TPMS refresh failed; opening the stored project:', err);
        setError('TPMS could not be reached — opening the last version stored here.');
      } finally {
        setOpening(false);
        setProgress('');
      }
    }
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
          <img src={logoMark} alt="Simorgh" data-theme-invert className="h-20 w-auto" />
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
                        {sharedNames.has(nameKey(p.projectName || '')) && (
                          <span
                            className={`ml-2 text-[10px] ${isSel ? 'text-amber-100' : 'text-amber-700'}`}
                            title={'Another project has this name. Open each one, rename or delete '
                              + 'the one you do not want, and the two will stop being confusable.'}
                          >
                            ⚠ same name · changed {p.changedOn
                              ? new Date(p.changedOn).toLocaleDateString()
                              : '—'}
                          </span>
                        )}
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

          {/* ── A TPMS project: what is about to be read ── */}
          {selectedTpms && (
            <div className="mt-5 border border-purple-200 bg-purple-50/50 rounded p-3 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">TPMS</span>
                <span className="text-sm text-gray-700">
                  The whole project is read from TPMS — the same data Simorgh Draw shows. Nothing is written back.
                </span>
              </div>

              {tpmsBusy && !tpmsHeader && (
                <div className="text-sm text-gray-500">Reading the project…</div>
              )}

              {tpmsHeader && (
                <>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <div><span className="text-gray-500">OE number:</span> <span className="text-gray-800">{tpmsHeader.project.oeNumber || '—'}</span></div>
                    <div><span className="text-gray-500">Project:</span> <span className="text-gray-800">{tpmsHeader.project.projectName || '—'}</span></div>
                    <div><span className="text-gray-500">Switchgears:</span> <span className="text-gray-800">{tpmsHeader.switchgears.length}</span></div>
                    <div>
                      <span className="text-gray-500">Revisions:</span>{' '}
                      <span className="text-gray-800">
                        {tpmsHeader.revisions.length > 0 ? tpmsHeader.revisions.map(r => `REV ${r}`).join(', ') : '—'}
                      </span>
                    </div>
                  </div>

                  {tpmsHeader.switchgears.length > 0 && (
                    <div className="border border-purple-100 rounded bg-white max-h-32 overflow-y-auto divide-y divide-gray-50">
                      {tpmsHeader.switchgears.map(sw => (
                        <div key={sw.scopeId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                            sw.panelType === 'LV' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                          }`}>{sw.panelType}</span>
                          <span className="text-gray-800">{sw.scopeName}</span>
                          <span className="text-gray-400 truncate">{sw.switchgearType}</span>
                          {sw.cellCount && <span className="text-gray-400 ml-auto">{sw.cellCount} cells</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {tpmsHeader.revisions.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Revisions to read</label>
                      <select
                        className="w-full border border-gray-400 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:border-purple-500"
                        value={revisionScope}
                        onChange={e => setRevisionScope(e.target.value as 'all' | 'newest')}
                      >
                        <option value="all">All {tpmsHeader.revisions.length} revisions — the full history</option>
                        <option value="newest">
                          Newest only (REV {tpmsHeader.revisions[tpmsHeader.revisions.length - 1]}) — quickest for a big project
                        </option>
                      </select>
                      <p className="text-xs text-gray-500 mt-1" dir="rtl">
                        A heavy project can be opened with its latest revision only; the other revisions are left untouched.
                      </p>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 border border-purple-300 text-purple-800 rounded text-xs hover:bg-purple-100 disabled:opacity-50"
                      onClick={handleCheck}
                      disabled={statsBusy || opening}
                    >
                      {statsBusy ? 'Checking…' : 'Check this project'}
                    </button>
                    <span className="text-xs text-gray-500">
                      How much TPMS holds for it, and how long each read takes.
                    </span>
                  </div>

                  {stats && (
                    <div className={`rounded border px-3 py-2 text-xs ${
                      stats.error ? 'border-red-300 bg-red-50 text-red-800' : 'border-gray-200 bg-white text-gray-700'
                    }`}>
                      {stats.error ? (
                        <>TPMS answered with an error: {stats.error}</>
                      ) : (
                        <>
                          <div className="font-medium text-gray-800">
                            {stats.switchgears} switchgear(s) · {stats.revisions.length} revision(s) ·
                            {' '}{stats.drafts} line(s) · {stats.parts} part row(s)
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-600">
                            {stats.revisions.map((r: any) => (
                              <span key={r.revision}>REV {r.revision}: {r.drafts}</span>
                            ))}
                          </div>
                          <div className="mt-1 text-gray-500">
                            reads: {Object.entries(stats.timings || {}).map(([k, v]) => `${k} ${v}ms`).join(' · ')}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <p className="text-xs text-gray-500">
                    Every switchgear lands in Device Selection with its lines and templates, the panel
                    specifications in Device Library, and each TPMS revision becomes a revision here.
                    Until a revision is raised in Design Suite the project stays read-only and is refreshed
                    from TPMS every time it is opened.
                  </p>
                </>
              )}
            </div>
          )}

          {/* A project of this suite that TPMS still owns */}
          {selectedProject?.tpmsSync?.master === 'tpms' && (
            <div className="mt-4 flex items-start gap-2 text-xs text-purple-800 bg-purple-50 border border-purple-200 rounded px-3 py-2">
              <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-semibold">TPMS</span>
              <span>
                Linked to TPMS project {selectedProject.tpmsSync.oeNumber || selectedProject.tpmsSync.projectMainId} — it is
                read from TPMS again when it opens, and stays read-only until a revision is raised here.
              </span>
            </div>
          )}

          {pending && (
            <div className="mt-4 border border-amber-300 bg-amber-50 rounded p-3">
              <p className="text-sm font-medium text-amber-900">
                {pending.problems.length} part{pending.problems.length === 1 ? '' : 's'} of this project could not be read.
              </p>
              <p className="text-xs text-amber-800 mt-1" dir="rtl">
                Part of the project could not be read. Open it as it is, or try again.
              </p>
              <ul className="mt-2 max-h-28 overflow-y-auto text-xs text-amber-900 list-disc list-inside space-y-0.5">
                {pending.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
              <div className="flex justify-end gap-2 mt-3">
                <button
                  className="px-3 py-1.5 border rounded text-xs hover:bg-amber-100"
                  onClick={() => setPending(null)}
                >
                  Try again
                </button>
                <button
                  className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700"
                  onClick={() => onProjectSelect(pending.project, pending.current || undefined)}
                >
                  Open anyway
                </button>
              </div>
            </div>
          )}

          {progress && (
            <div className="mt-4 text-sm text-gray-600 flex items-center gap-2">
              <span className="animate-spin">⏳</span>{progress}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
          <span className="text-xs text-gray-400">
            {projects.length} project{projects.length === 1 ? '' : 's'}
            {tpmsProjects.length > 0 && <> · {tpmsProjects.length} in TPMS</>}
            {tpmsListError && <span className="text-amber-600" title={tpmsListError}> · TPMS unavailable</span>}
            {/* The build used to be printed here. It is still worth being able
                to read — every image is tagged :latest, so the version on
                screen is the only way to tell one from another without the
                server — but a commit hash is not what the front door of the
                application should say. It is in Help → About. */}
          </span>
          {selectedTpms ? (
            <button
              className="px-5 py-2 bg-purple-600 text-white rounded text-sm font-medium hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleOpenFromTpms}
              disabled={!tpmsHeader || tpmsBusy || opening}
            >
              {opening ? 'Reading from TPMS…' : 'Open from TPMS'}
            </button>
          ) : (
            <button
              className="px-5 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleOpen}
              disabled={!selectedProject || opening}
            >
              {opening ? 'Refreshing from TPMS…' : 'Open Project'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
