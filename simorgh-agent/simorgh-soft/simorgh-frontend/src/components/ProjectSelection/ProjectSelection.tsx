import React, { useState, useEffect } from 'react';
import { ProjectData } from '../../types/project';
import { projectService } from '../../services/projectService';
import simorghLogo from '../../assets/simrgh.jpg';

interface ProjectSelectionProps {
  onProjectSelect: (project: ProjectData) => void;
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
                  onClick={() => onProjectSelect(project)}
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
    </div>
  );
};
