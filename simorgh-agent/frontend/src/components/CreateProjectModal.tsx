import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Loader, CheckCircle, AlertCircle } from 'lucide-react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (projectId: string, projectName: string, firstPageTitle: string) => void;
}

export default function CreateProjectModal({ isOpen, onClose, onCreate }: Props) {
  // Field 1: Last 5 digits of OENUM
  const [oenumSuffix, setOenumSuffix] = useState('');
  // Field 2: Project Name (auto-filled, read-only)
  const [projectName, setProjectName] = useState('');
  const [fullOenum, setFullOenum] = useState('');
  const [idProjectMain, setIdProjectMain] = useState('');
  // Field 3: First Page Name
  const [pageTitle, setPageTitle] = useState('New Page');

  const [isValidating, setIsValidating] = useState(false);
  const [isValidated, setIsValidated] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleOenumChange = (value: string) => {
    // Only allow digits, max 5 characters
    const cleaned = value.replace(/\D/g, '').slice(0, 5);
    setOenumSuffix(cleaned);
    setIsValidated(false);
    setError('');
  };

  const handleValidateOenum = async () => {
    if (!oenumSuffix.trim()) {
      setError('Please enter last 5 digits of OENUM');
      return;
    }

    if (oenumSuffix.length !== 5) {
      setError('OENUM must be exactly 5 digits');
      return;
    }

    setIsValidating(true);
    setError('');

    try {
      const token = localStorage.getItem('simorgh_token');
      if (!token) {
        throw new Error('Authentication required');
      }

      // Call backend to validate OENUM suffix and check permission
      const response = await axios.post(
        `${API_BASE}/auth/validate-project-by-oenum`,
        { oenum: oenumSuffix.trim() },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      // Auto-fill project name and full OENUM (read-only)
      setProjectName(response.data.project.project_name);
      setFullOenum(response.data.project.oenum);
      setIdProjectMain(response.data.project.id_project_main);
      setIsValidated(true);
      setError('');

      console.log('✅ Project validated:', response.data.project);
    } catch (err: any) {
      setIsValidated(false);
      if (err.response?.status === 404) {
        setError('Project not found with OENUM ending in "' + oenumSuffix + '"');
      } else if (err.response?.status === 403) {
        setError('Access denied: You don\'t have permission for this project');
      } else {
        setError(err.response?.data?.detail || 'Validation failed. Please try again.');
      }
      console.error('❌ Validation failed:', err);
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!isValidated) {
      setError('Please validate the Project ID first');
      return;
    }

    // Use default "New Page" if page title is empty
    const finalPageTitle = pageTitle.trim() || 'New Page';

    // Pass IDProjectMain (not OENUM) to onCreate
    onCreate(idProjectMain, projectName, finalPageTitle);

    // Reset form
    setOenumSuffix('');
    setProjectName('');
    setFullOenum('');
    setIdProjectMain('');
    setPageTitle('New Page');
    setIsValidated(false);
    setError('');
    onClose();
  };

  const handleClose = () => {
    setOenumSuffix('');
    setProjectName('');
    setFullOenum('');
    setIdProjectMain('');
    setPageTitle('New Page');
    setIsValidated(false);
    setError('');
    onClose();
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
      />

      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-md p-8">
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
            {/* Field 1: Last 5 Digits of OENUM */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Project ID (Last 5 Digits of OENUM)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={oenumSuffix}
                  onChange={(e) => handleOenumChange(e.target.value)}
                  placeholder="12065"
                  maxLength={5}
                  className="flex-1 px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition text-lg font-mono tracking-wider"
                  autoFocus
                  disabled={isValidated || isValidating}
                />
                <button
                  onClick={handleValidateOenum}
                  disabled={isValidating || isValidated || oenumSuffix.length !== 5}
                  className="px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-xl text-white font-medium transition flex items-center gap-2 min-w-[120px] justify-center"
                >
                  {isValidating && <Loader className="w-4 h-4 animate-spin" />}
                  {isValidated && <CheckCircle className="w-4 h-4" />}
                  {isValidating ? 'Checking...' : isValidated ? 'Valid' : 'Validate'}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Enter exactly 5 digits (e.g., "12065" for OENUM "04A12065")
              </p>
            </div>

            {/* Field 2: Full OENUM (Read-only) */}
            {isValidated && fullOenum && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Full OENUM (Found)
                </label>
                <div className="px-4 py-3 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                  <p className="text-blue-300 font-mono text-lg">{fullOenum}</p>
                </div>
              </div>
            )}

            {/* Field 3: Project Name (Auto-filled, Read-only) */}
            {isValidated && projectName && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Project Name (Auto-filled)
                </label>
                <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl">
                  <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
                  <input
                    type="text"
                    value={projectName}
                    readOnly
                    className="flex-1 bg-transparent text-green-300 cursor-not-allowed focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Field 4: First Page Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                First Page Name
              </label>
              <input
                type="text"
                value={pageTitle}
                onChange={(e) => setPageTitle(e.target.value)}
                placeholder="New Page"
                className={`w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition ${
                  !isValidated ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                disabled={!isValidated}
              />
              <p className="mt-2 text-xs text-gray-500">
                Default: "New Page" - can be changed after validation
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={!isValidated}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Project
              </button>
              <button
                onClick={handleClose}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition"
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