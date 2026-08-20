import React, { useState, useEffect } from 'react';
import { ProjectData, Revision } from '../../types/project';
import { projectService } from '../../services/projectService';
import simorghLogo from '../../assets/logo.jpeg';

interface ProjectSelectionProps {
  onProjectSelect: (project: ProjectData, revision?: Revision) => void;
  onNewProject:    (projectName: string) => void;
}

export const ProjectSelection: React.FC<ProjectSelectionProps> = ({
  onProjectSelect,
  onNewProject,
}) => {
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<Revision | null>(null);
  const [showRevisionSelector, setShowRevisionSelector] = useState(false);
  const [selectedProjectForRevision, setSelectedProjectForRevision] = useState<ProjectData | null>(null);
  
  // Create revision modal state
  const [showCreateRevisionModal, setShowCreateRevisionModal] = useState(false);
  const [newRevisionNumber, setNewRevisionNumber] = useState<string>('0');
  const [newRevisionName, setNewRevisionName] = useState<string>('');
  const [newRevisionDescription, setNewRevisionDescription] = useState<string>('');
  const [creatingRevision, setCreatingRevision] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const projectsData = await projectService.getAllProjects();
      setProjects(projectsData);
    } catch (err) {
      setError('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  const loadRevisions = async (projectId: string) => {
    try {
      const revisionsData = await projectService.getRevisions(projectId);
      setRevisions(revisionsData);
      
      // Auto-create Revision 0 if none exist
      if (revisionsData.length === 0) {
        // Will be created when opening or explicitly by user
        setSelectedRevision(null);
      } else {
        // Default to latest (first after sort by revisionNumber desc)
        setSelectedRevision(revisionsData[0]);
      }
    } catch (err) {
      console.error('Failed to load revisions:', err);
      setRevisions([]);
      setSelectedRevision(null);
    }
  };

  const handleProjectClick = async (project: ProjectData) => {
    setSelectedProjectForRevision(project);
    await loadRevisions(project._id!);
    setShowRevisionSelector(true);
  };

  const handleConfirmSelect = () => {
    if (selectedProjectForRevision) {
      onProjectSelect(selectedProjectForRevision, selectedRevision || undefined);
      setShowRevisionSelector(false);
      setSelectedProjectForRevision(null);
    }
  };

  const openCreateRevisionModal = async () => {
    if (!selectedProjectForRevision) return;
    
    // Calculate next revision number automatically
    let nextNum = 0;
    if (revisions.length > 0) {
      const maxRev = Math.max(...revisions.map(r => parseInt(r.revisionNumber) || 0));
      nextNum = maxRev + 1;
    }
    
    setNewRevisionNumber(nextNum.toString());
    setNewRevisionName(`Revision ${nextNum}`);
    setNewRevisionDescription('');
    setShowCreateRevisionModal(true);
  };

  const handleCreateRevision = async () => {
    if (!selectedProjectForRevision) return;
    
    setCreatingRevision(true);
    try {
      // Get the latest project data for the snapshot
      const latestProject = await projectService.getProjectById(selectedProjectForRevision._id!);
      
      const newRevision = await projectService.createRevision({
        projectId: selectedProjectForRevision._id!,
        revisionNumber: newRevisionNumber,
        revisionName: newRevisionName || `Revision ${newRevisionNumber}`,
        description: newRevisionDescription || '',
        createdBy: 'user',
        projectSnapshot: latestProject,
        isLocked: false,
      });
      
      // Reload revisions and select the new one
      await loadRevisions(selectedProjectForRevision._id!);
      setSelectedRevision(newRevision);
      setShowCreateRevisionModal(false);
    } catch (err) {
      console.error('Failed to create revision:', err);
      // Show error message using existing UI pattern
      alert('Failed to create revision: ' + (err as Error).message);
    } finally {
      setCreatingRevision(false);
    }
  };

  const trimmed = searchTerm.trim();

  const filteredProjects = projects.filter(p =>
    p.projectName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.projectDescription.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Exact name match (case-insensitive) — used for duplicate check
  const exactMatch = projects.some(
    p => p.projectName.toLowerCase() === trimmed.toLowerCase()
  );

  // Show create button when user has typed something that doesn't fully match an existing project name
  const canCreate = trimmed.length > 0 && !exactMatch;

  const handleCreate = () => {
    if (!canCreate) return;
    onNewProject(trimmed);
  };

  if (loading) {
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        style={{ background: 'radial-gradient(1200px 800px at 10% 10%, #14335f 0%, #0a1a33 45%, #060e1e 100%)' }}
      >
        <div className="text-slate-300 text-sm">Loading projects…</div>
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col min-h-screen"
      style={{ background: 'radial-gradient(1200px 800px at 10% 10%, #14335f 0%, #0a1a33 45%, #060e1e 100%)' }}
    >
      <style>{`
        @keyframes projSelWordmarkReveal {
          from { opacity: 0; transform: translateX(-10px) scaleX(0.85); }
          to   { opacity: 1; transform: translateX(0) scaleX(1); }
        }
        .proj-sel-wordmark { transform-origin: left center; animation: projSelWordmarkReveal 0.7s cubic-bezier(0.22,1,0.36,1) 0.2s both; }
      `}</style>

      {/* Faint dot grid, matching the loading screen's texture */}
      <div
        className="absolute inset-0 opacity-[0.12] pointer-events-none"
        style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      />

      {/* Header */}
      <div className="relative border-b border-white/10">
        <div className="container mx-auto px-6 py-4 flex items-center gap-4">
          <img src={simorghLogo} alt="Simorgh" className="h-12 w-auto object-contain" />
          <div className="h-10 w-px bg-white/25" />
          <div className="proj-sel-wordmark">
            <div className="text-xl font-extrabold tracking-tight text-white leading-none">Simorgh</div>
            <div className="text-sm font-medium text-blue-400 leading-none mt-1">Design Suite</div>
            <p className="text-xs text-slate-400 mt-1">Electrical Engineering Design Platform</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex-1 container mx-auto px-6 py-10 max-w-3xl">

        {error && (
          <div className="mb-4 bg-red-50 border border-red-300 text-red-700 text-sm px-4 py-3 rounded">
            {error}
          </div>
        )}

        {/* Search / Create bar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Search or create a project
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              autoFocus
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
              placeholder="Type a project name…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
            />
            {canCreate && (
              <button
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 whitespace-nowrap font-medium"
                onClick={handleCreate}
              >
                + Create "{trimmed}"
              </button>
            )}
            {exactMatch && trimmed.length > 0 && (
              <span className="self-center text-xs text-amber-600 whitespace-nowrap font-medium">
                Name already exists
              </span>
            )}
          </div>
        </div>

        {/* Projects list */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">
              {trimmed ? `Results for "${trimmed}"` : 'All Projects'}
            </h2>
            <span className="text-xs text-gray-400">{filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}</span>
          </div>

          {filteredProjects.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-500">
                {trimmed
                  ? <>No project named <strong>"{trimmed}"</strong>.</>
                  : 'No projects yet.'}
              </p>
              {canCreate && (
                <button
                  className="mt-3 text-sm text-blue-600 hover:text-blue-800 font-medium"
                  onClick={handleCreate}
                >
                  Create "{trimmed}" as a new project →
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filteredProjects.map(project => (
                <li
                  key={project._id}
                  className="flex items-center justify-between px-5 py-4 hover:bg-blue-50 cursor-pointer transition-colors group"
                  onClick={() => handleProjectClick(project)}
                >
                  <div className="min-w-0">
                    <p className="font-medium text-blue-900 truncate">{project.projectName}</p>
                    {project.projectDescription && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{project.projectDescription}</p>
                    )}
                    <div className="flex gap-3 mt-1 text-xs text-gray-400">
                      {project.client   && <span>Client: {project.client}</span>}
                      {project.location && <span>Location: {project.location}</span>}
                      {project.standard && <span>{project.standard}</span>}
                    </div>
                  </div>
                  <div className="ml-4 text-right text-xs text-gray-400 flex-shrink-0">
                    <div>Modified: {new Date(project.changedOn).toLocaleDateString()}</div>
                    <div className="mt-0.5 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                      Open →
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Revision Selection Modal */}
      {showRevisionSelector && selectedProjectForRevision && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-lg">Select Revision for "{selectedProjectForRevision.projectName}"</h3>
                <p className="text-xs text-gray-500 mt-1">Choose which version of this project to open</p>
              </div>
              <button
                className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={openCreateRevisionModal}
                disabled={creatingRevision}
              >
                {creatingRevision ? 'Creating...' : '+ New Revision'}
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {revisions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No revisions available. Create a new revision to start.
                  <br/>
                  <span className="text-xs">Revision 0 will be created automatically as the base revision.</span>
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
                          selectedRevision?._id === revision._id
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:bg-gray-50'
                        }`}
                        onClick={() => setSelectedRevision(revision)}
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
                              {isLatest && isBase && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded font-medium">INITIAL</span>
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

            <div className="flex justify-between items-center px-6 py-4 border-t bg-gray-50">
              <button
                className="px-4 py-2 border rounded text-sm hover:bg-gray-100"
                onClick={() => {
                  setShowRevisionSelector(false);
                  setSelectedProjectForRevision(null);
                }}
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleConfirmSelect}
                  disabled={!selectedRevision && revisions.length > 0}
                >
                  Open Selected Revision
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Revision Modal */}
      {showCreateRevisionModal && selectedProjectForRevision && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-[500px] flex flex-col">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-lg">Create New Revision</h3>
              <p className="text-xs text-gray-500 mt-1">Create a new revision for "{selectedProjectForRevision.projectName}"</p>
            </div>
            
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
                  {selectedProjectForRevision.projectName}
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
                onClick={handleCreateRevision}
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
