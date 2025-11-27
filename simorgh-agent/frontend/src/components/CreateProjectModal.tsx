import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (projectName: string, firstPageTitle: string) => void;
}

export default function CreateProjectModal({ isOpen, onClose, onCreate }: Props) {
  const [projectName, setProjectName] = useState('');
  const [pageTitle, setPageTitle] = useState('');

  if (!isOpen) return null;

  const handleSubmit = () => {
    if (!projectName.trim()) return alert('نام پروژه را وارد کنید');
    if (!pageTitle.trim()) return alert('نام صفحه اول الزامی است');

    onCreate(projectName.trim(), pageTitle.trim());
    setProjectName('');
    setPageTitle('');
    onClose();
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
              <label className="block text-sm font-medium text-gray-300 mb-2">نام پروژه</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="مثال: وب‌سایت شرکتی"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                autoFocus
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
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg"
              >
                ساخت پروژه
              </button>
              <button
                onClick={onClose}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition"
              >
                لغو
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}