import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Loader } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import AccessDeniedAlert from './AccessDeniedAlert';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (projectId: string, projectName: string, firstPageTitle: string) => void;
}

export default function CreateProjectModal({ isOpen, onClose, onCreate }: Props) {
  const [projectId, setProjectId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [showAccessDenied, setShowAccessDenied] = useState(false);

  const { checkPermission, user } = useAuth();

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!projectId.trim()) return alert('شماره پروژه را وارد کنید');
    if (!projectName.trim()) return alert('نام پروژه را وارد کنید');
    if (!pageTitle.trim()) return alert('نام صفحه اول الزامی است');

    try {
      setIsChecking(true);

      // Check permission
      const hasAccess = await checkPermission(projectId.trim());

      if (!hasAccess) {
        // Show access denied alert
        setShowAccessDenied(true);
        setIsChecking(false);
        return;
      }

      // Permission granted - proceed with creation
      onCreate(projectId.trim(), projectName.trim(), pageTitle.trim());
      setProjectId('');
      setProjectName('');
      setPageTitle('');
      onClose();
    } catch (error) {
      console.error('Permission check failed:', error);
      alert('خطا در بررسی دسترسی. لطفا دوباره تلاش کنید.');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
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
              پروژه جدید
            </h2>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">شماره پروژه (Project ID)</label>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="مثال: 11849"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                autoFocus
                disabled={isChecking}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">نام پروژه</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="مثال: وب‌سایت شرکتی"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                disabled={isChecking}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">نام صفحه اول</label>
              <input
                type="text"
                value={pageTitle}
                onChange={(e) => setPageTitle(e.target.value)}
                placeholder="مثال: صفحه اصلی"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                disabled={isChecking}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={isChecking}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isChecking ? (
                  <>
                    <Loader className="w-5 h-5 animate-spin" />
                    <span>در حال بررسی دسترسی...</span>
                  </>
                ) : (
                  'ساخت پروژه'
                )}
              </button>
              <button
                onClick={onClose}
                disabled={isChecking}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition disabled:opacity-50"
              >
                لغو
              </button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Access Denied Alert */}
      <AccessDeniedAlert
        isOpen={showAccessDenied}
        onClose={() => setShowAccessDenied(false)}
        projectId={projectId}
        username={user?.EMPUSERNAME}
      />
    </>
  );
}