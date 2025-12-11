import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MessageSquare } from 'lucide-react';

export interface ToastNotification {
  id: string;
  message: string;
  timestamp: number;
}

interface NotificationToastProps {
  notifications: ToastNotification[];
  onDismiss: (id: string) => void;
}

export function NotificationToast({ notifications, onDismiss }: NotificationToastProps) {
  return (
    <div className="fixed bottom-4 right-4 z-[100000] space-y-2 pointer-events-none">
      <AnimatePresence>
        {notifications.map((notification) => (
          <NotificationItem
            key={notification.id}
            notification={notification}
            onDismiss={onDismiss}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function NotificationItem({
  notification,
  onDismiss
}: {
  notification: ToastNotification;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(notification.id);
    }, 6000); // 6 seconds

    return () => clearTimeout(timer);
  }, [notification.id, onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 50, scale: 0.3 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.2 } }}
      className="pointer-events-auto w-96 max-w-[calc(100vw-2rem)]"
    >
      <div className="bg-gradient-to-r from-gray-900 to-black border border-white/20 rounded-xl shadow-2xl backdrop-blur-xl p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-white" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white mb-1">New AI Response</p>
            <p className="text-sm text-gray-300 line-clamp-2">{notification.message}</p>
          </div>

          <button
            onClick={() => onDismiss(notification.id)}
            className="flex-shrink-0 p-1 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* Progress bar */}
        <motion.div
          className="mt-3 h-1 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: 6, ease: 'linear' }}
        />
      </div>
    </motion.div>
  );
}

export default NotificationToast;
