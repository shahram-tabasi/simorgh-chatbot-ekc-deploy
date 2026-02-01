import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Loader, CheckCircle, AlertCircle, Search, ChevronDown } from 'lucide-react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (oenum: string, projectName: string, firstPageTitle: string) => void;
}

interface ProjectOption {
  OENUM: string;
  Project_Name: string;
  IDProjectMain: number;
}

export default function CreateProjectModal({ isOpen, onClose, onCreate }: Props) {
  // Step 1: OENUM Search Input
  const [searchQuery, setSearchQuery] = useState('');
  const [allOENUMs, setAllOENUMs] = useState<ProjectOption[]>([]); // Store ALL loaded OENUMs
  const [filteredResults, setFilteredResults] = useState<ProjectOption[]>([]); // Client-side filtered results
  const [isLoadingOENUMs, setIsLoadingOENUMs] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  // Step 2: Selected Project
  const [selectedProject, setSelectedProject] = useState<ProjectOption | null>(null);

  // Step 3: Permission Validation
  const [isValidatingPermission, setIsValidatingPermission] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [permissionError, setPermissionError] = useState('');

  // First Page Name
  const [pageTitle, setPageTitle] = useState('New Page');

  // Creating state (for loading animation)
  const [isCreating, setIsCreating] = useState(false);

  // General error state
  const [error, setError] = useState('');

  // Refs for click-outside detection
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Load ALL OENUMs from the database when modal opens
   */
  const loadAllOENUMs = React.useCallback(async () => {
    setIsLoadingOENUMs(true);
    setError('');

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        throw new Error('Authentication required');
      }

      // Fetch ALL OENUMs (no query parameter = fetch all)
      const response = await axios.get(`${API_BASE}/auth/search-oenum`, {
        params: { query: '' }, // Empty query returns all OENUMs
        headers: { Authorization: `Bearer ${token}` }
      });

      const allProjects = response.data.results || [];
      setAllOENUMs(allProjects);
      setFilteredResults(allProjects); // Initially show all

      if (allProjects.length === 0) {
        setError('No projects found in the database');
      }
    } catch (err: any) {
      console.error('❌ Failed to load OENUMs:', err);
      setError('Failed to load projects. Please try again.');
      setAllOENUMs([]);
      setFilteredResults([]);
    } finally {
      setIsLoadingOENUMs(false);
    }
  }, []);

  /**
   * Client-side filtering of OENUMs based on search query
   */
  React.useEffect(() => {
    if (!searchQuery || searchQuery.trim().length === 0) {
      // Show all OENUMs when search is empty
      setFilteredResults(allOENUMs);
      return;
    }

    // Filter client-side for better performance
    const query = searchQuery.trim().toLowerCase();
    const filtered = allOENUMs.filter(project =>
      project.OENUM.toLowerCase().includes(query) ||
      project.Project_Name.toLowerCase().includes(query)
    );

    setFilteredResults(filtered);

    if (filtered.length === 0) {
      setError(`No projects found matching "${searchQuery}"`);
    } else {
      setError('');
    }
  }, [searchQuery, allOENUMs]);

  /**
   * Load all OENUMs when modal opens
   */
  React.useEffect(() => {
    if (isOpen && allOENUMs.length === 0) {
      loadAllOENUMs();
    }
  }, [isOpen, allOENUMs.length, loadAllOENUMs]);

  // Click outside to close dropdown
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Step 2: Handle project selection from dropdown
   */
  const handleSelectProject = React.useCallback(async (project: ProjectOption) => {
    setSelectedProject(project);
    setSearchQuery(project.OENUM); // Show selected OENUM in input
    setShowDropdown(false);
    setError('');
    setPermissionError('');
    setHasPermission(false);

    // Immediately validate permission
    await validatePermission(project.IDProjectMain);
  }, []);

  /**
   * Step 3: Validate user permission for selected project
   */
  const validatePermission = React.useCallback(async (idProjectMain: number) => {
    setIsValidatingPermission(true);
    setPermissionError('');

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        throw new Error('Authentication required');
      }

      // Call permission validation endpoint
      const response = await axios.post(
        `${API_BASE}/auth/validate-project-permission`,
        { id_project_main: String(idProjectMain) },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data.has_access) {
        setHasPermission(true);
        setPermissionError('');
        console.log('✅ Permission granted for project:', idProjectMain);
      }
    } catch (err: any) {
      setHasPermission(false);
      if (err.response?.status === 403) {
        setPermissionError('Access denied: You don\'t have permission for this project');
      } else {
        setPermissionError('Failed to validate permission. Please try again.');
      }
      console.error('❌ Permission validation failed:', err);
    } finally {
      setIsValidatingPermission(false);
    }
  }, []);

  /**
   * Submit: Create project
   */
  const handleSubmit = React.useCallback(async () => {
    if (!selectedProject || !hasPermission) {
      setError('Please select a project and ensure you have permission');
      return;
    }

    // Use default "New Page" if empty
    const finalPageTitle = pageTitle.trim() || 'New Page';

    // Show loading state
    setIsCreating(true);
    setError('');

    try {
      // Pass OENUM (project_number) to parent for creating TPMS project
      // onCreate now returns a Promise<boolean>
      await onCreate(
        selectedProject.OENUM,
        selectedProject.Project_Name,
        finalPageTitle
      );

      // Reset form and close (only on success)
      handleClose();
    } catch (err: any) {
      setError('Failed to create project. Please try again.');
      console.error('Project creation failed:', err);
    } finally {
      setIsCreating(false);
    }
  }, [selectedProject, hasPermission, pageTitle, onCreate]);

  /**
   * Close modal and reset state
   */
  const handleClose = React.useCallback(() => {
    setSearchQuery('');
    setShowDropdown(false);
    setSelectedProject(null);
    setHasPermission(false);
    setPermissionError('');
    setPageTitle('New Page');
    setError('');
    setIsCreating(false);
    // Note: Keep allOENUMs and filteredResults cached for performance
    onClose();
  }, [onClose]);

  // ✅ FIXED: Early return AFTER all hooks
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
      />

      {/* Modal */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-md p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Plus className="w-8 h-8 text-emerald-400" />
              New Project
            </h2>
            <button onClick={handleClose} className="p-2 hover:bg-white/10 rounded-lg transition">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>

          <div className="space-y-6">
            {/* Step 1: OENUM Search with Autocomplete */}
            <div className="relative">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Project ID (OENUM) - Search
              </label>
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedProject(null);
                    setHasPermission(false);
                    setPermissionError('');
                  }}
                  onFocus={() => setShowDropdown(true)}
                  onClick={() => setShowDropdown(true)}
                  placeholder="Click to browse or type to search..."
                  className="w-full px-4 py-3 pr-10 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                  autoFocus
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isLoadingOENUMs ? (
                    <Loader className="w-5 h-5 text-gray-400 animate-spin" />
                  ) : (
                    <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {isLoadingOENUMs ? 'Loading all projects...' : `${allOENUMs.length} projects loaded. Type to filter or scroll to browse.`}
              </p>

              {/* Dropdown Results */}
              <AnimatePresence>
                {showDropdown && filteredResults.length > 0 && (
                  <motion.div
                    ref={dropdownRef}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="absolute z-10 w-full mt-2 bg-gray-800 border border-white/20 rounded-xl shadow-2xl max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-800"
                  >
                    {filteredResults.map((project, index) => (
                      <button
                        key={`${project.IDProjectMain}-${index}`}
                        onClick={() => handleSelectProject(project)}
                        className="w-full px-4 py-3 text-left hover:bg-white/10 transition border-b border-white/10 last:border-b-0"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-emerald-400 font-mono font-semibold text-sm">
                              {project.OENUM}
                            </p>
                            <p className="text-gray-300 text-sm mt-1 truncate">
                              {project.Project_Name}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Step 2: Selected Project Info (Read-only) */}
            {selectedProject && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Selected OENUM
                  </label>
                  <div className="px-4 py-3 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                    <p className="text-blue-300 font-mono text-lg font-semibold">
                      {selectedProject.OENUM}
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Project Name (Auto-filled)
                  </label>
                  <div className="flex items-center gap-2 px-4 py-3 bg-gray-700/50 border border-white/10 rounded-xl">
                    <input
                      type="text"
                      value={selectedProject.Project_Name}
                      readOnly
                      className="flex-1 bg-transparent text-gray-300 cursor-not-allowed focus:outline-none"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Step 3: Permission Validation Status */}
            {selectedProject && (
              <div>
                {isValidatingPermission && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl">
                    <Loader className="w-5 h-5 text-yellow-400 animate-spin flex-shrink-0" />
                    <p className="text-sm text-yellow-400">Checking your permission...</p>
                  </div>
                )}

                {!isValidatingPermission && hasPermission && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl">
                    <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
                    <p className="text-sm text-green-400 font-semibold">
                      ✅ Permission granted - You can create this project
                    </p>
                  </div>
                )}

                {!isValidatingPermission && permissionError && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <p className="text-sm text-red-400">{permissionError}</p>
                  </div>
                )}
              </div>
            )}

            {/* First Page Name (enabled only after permission granted) */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                First Page Name
              </label>
              <input
                type="text"
                value={pageTitle}
                onChange={(e) => setPageTitle(e.target.value)}
                placeholder="New Page"
                disabled={!hasPermission}
                className={`w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition ${
                  !hasPermission ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              />
              <p className="mt-2 text-xs text-gray-500">
                Default: "New Page" - can be changed after permission is granted
              </p>
            </div>

            {/* General Error Message */}
            {error && !isCreating && (
              <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Creating Animation */}
            {isCreating && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-4 py-6"
              >
                <div className="relative">
                  <div className="w-16 h-16 border-4 border-emerald-500/30 rounded-full"></div>
                  <div className="absolute top-0 left-0 w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
                <div className="text-center">
                  <p className="text-lg font-semibold text-white">Creating Project...</p>
                  <p className="text-sm text-gray-400 mt-1">
                    Setting up databases and syncing TPMS data
                  </p>
                </div>
              </motion.div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={!selectedProject || !hasPermission || isValidatingPermission || isCreating}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isCreating ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" />
                    Creating...
                  </>
                ) : isValidatingPermission ? (
                  'Validating...'
                ) : (
                  'Create Project'
                )}
              </button>
              <button
                onClick={handleClose}
                disabled={isCreating}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}
