import React, { useState, useEffect } from 'react';
import { ProjectData, Revision } from '../../types/project';
import { projectService } from '../../services/projectService';
import simorghLogo from '../../assets/simrgh.jpg';

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
  const [showRevisionDropdown, setShowRevisionDropdown] = useState(false);
  const [selectedProjectForRevision, setSelectedProjectForRevision] = useState<ProjectData | null>(null);
  const [showRevisionSelector, setShowRevisionSelector] = useState(false);

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
      if (revisionsData.length > 0) {
        setSelectedRevision(revisionsData[0]); // Default to latest (first after sort)
      } else {
        setSelectedRevision(null);
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

  const handleCreateRevision = async () => {
    if (!selectedProjectForRevision) return;
    
    const revisionNumber = prompt('Enter revision number (e.g., 0, 1, 2):', '0');
    if (!revisionNumber) return;
    
    const revisionName = prompt('Enter revision name:', `Revision ${revisionNumber}`);
    if (!revisionName) return;
    
    const description = prompt('Enter revision description:', 'Initial revision');
    
    try {
      const newRevision = await projectService.createRevision({
        projectId: selectedProjectForRevision._id!,
        revisionNumber,
        revisionName: revisionName || `Revision ${revisionNumber}`,
        description: description || '',
        createdBy: 'user',
        projectSnapshot: selectedProjectForRevision,
        isLocked: false,
      });
      
      alert(`✅ Revision ${revisionNumber} created successfully!`);
      await loadRevisions(selectedProjectForRevision._id!);
    } catch (err) {
      alert('❌ Failed to create revision: ' + (err as Error).message);
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
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="text-gray-500 text-sm">Loading projects…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-6 py-4 flex items-center gap-3">
          <img src={simorghLogo} alt="Simorgh" className="h-10 w-auto object-contain" />
          <div>
            <h1 className="text-xl font-bold text-blue-900 leading-tight">Simorgh Design Software</h1>
            <p className="text-xs text-gray-500">Electrical Engineering Design Platform</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 container mx-auto px-6 py-8 max-w-3xl">

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
                className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 font-medium"
                onClick={handleCreateRevision}
              >
                + New Revision
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {revisions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No revisions available. Create a new revision or open the current project.
                </div>
              ) : (
                <div className="space-y-2">
                  {revisions.map((revision, idx) => (
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
                  className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                  onClick={handleConfirmSelect}
                >
                  Open Selected Revision
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
