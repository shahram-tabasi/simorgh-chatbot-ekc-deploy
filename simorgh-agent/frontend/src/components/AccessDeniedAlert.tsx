// src/components/AccessDeniedAlert.tsx
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldX, X, Lock } from 'lucide-react';

interface AccessDeniedAlertProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  username?: string;
}

export default function AccessDeniedAlert({
  isOpen,
  onClose,
  projectId,
  username
}: AccessDeniedAlertProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          />

          {/* Alert Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="bg-gradient-to-br from-red-900/90 to-red-950/90 backdrop-blur-2xl border-2 border-red-500/50 rounded-2xl p-8 max-w-md w-full shadow-2xl shadow-red-500/20 pointer-events-auto">
              {/* Close Button */}
              <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 hover:bg-white/10 rounded-lg transition"
              >
                <X className="w-5 h-5 text-white" />
              </button>

              {/* Icon */}
              <div className="flex justify-center mb-6">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1, rotate: [0, -10, 10, -10, 0] }}
                  transition={{ delay: 0.2, duration: 0.6 }}
                  className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center border-4 border-red-500/40"
                >
                  <ShieldX className="w-10 h-10 text-red-400" />
                </motion.div>
              </div>

              {/* Title */}
              <h2 className="text-2xl font-bold text-white text-center mb-3">
                Access Denied
              </h2>

              {/* Message */}
              <p className="text-red-200 text-center mb-6 leading-relaxed">
                You don't have access to this Project
              </p>

              {/* Details */}
              {(projectId || username) && (
                <div className="bg-black/30 rounded-xl p-4 mb-6 space-y-2">
                  {projectId && (
                    <div className="flex items-center gap-3 text-sm">
                      <Lock className="w-4 h-4 text-red-400" />
                      <span className="text-gray-300">Project ID:</span>
                      <span className="text-white font-mono font-bold">{projectId}</span>
                    </div>
                  )}
                  {username && (
                    <div className="flex items-center gap-3 text-sm">
                      <Lock className="w-4 h-4 text-red-400" />
                      <span className="text-gray-300">User:</span>
                      <span className="text-white font-medium">{username}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Help Text */}
              <p className="text-red-300/80 text-sm text-center mb-6">
                Please contact your administrator if you believe this is an error.
              </p>

              {/* Action Button */}
              <motion.button
                onClick={onClose}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition shadow-lg shadow-red-600/30"
              >
                Close
              </motion.button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
