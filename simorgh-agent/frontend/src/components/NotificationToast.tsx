import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Loader2,
} from 'lucide-react';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'progress';

export interface ToastNotification {
  id:        string;
  message:   string;
  timestamp: number;
  /** Optional type for icon + accent color. Defaults to 'info'. */
  type?:     ToastType;
  /** Optional short heading; defaults to a per-type label. */
  title?:    string;
  /** 0..100 — when set, replaces the auto-dismiss timer with a live bar. */
  progress?: number;
  /** Ms to live. Defaults to 6000. Set to 0 to keep open until dismissed. */
  timeoutMs?: number;
}

interface NotificationToastProps {
  notifications: ToastNotification[];
  onDismiss: (id: string) => void;
}

const STYLES: Record<ToastType, {
  accent: string;       // gradient for icon background + progress bar
  border: string;       // ring/border color
  icon:   React.FC<{ className?: string }>;
  defaultTitle: string;
}> = {
  info:     { accent: 'from-blue-500 to-purple-500',     border: 'border-white/20',         icon: MessageSquare, defaultTitle: 'Notification' },
  success:  { accent: 'from-emerald-500 to-teal-500',    border: 'border-emerald-400/30',   icon: CheckCircle2,  defaultTitle: 'Done' },
  warning:  { accent: 'from-amber-500 to-orange-500',    border: 'border-amber-400/30',     icon: AlertTriangle, defaultTitle: 'Heads up' },
  error:    { accent: 'from-rose-500 to-red-500',        border: 'border-rose-400/30',      icon: AlertCircle,   defaultTitle: 'Error' },
  progress: { accent: 'from-indigo-500 to-violet-500',   border: 'border-indigo-400/30',    icon: Loader2,       defaultTitle: 'Working' },
};

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
  onDismiss,
}: {
  notification: ToastNotification;
  onDismiss: (id: string) => void;
}) {
  const type = notification.type || 'info';
  const style = STYLES[type] || STYLES.info;
  const Icon = style.icon;
  const isPersistent =
    notification.timeoutMs === 0 ||
    (type === 'progress' && (notification.progress ?? 0) < 100);
  const ttl = notification.timeoutMs ?? 6000;

  useEffect(() => {
    if (isPersistent) return;
    const timer = setTimeout(() => onDismiss(notification.id), ttl);
    return () => clearTimeout(timer);
  }, [notification.id, onDismiss, isPersistent, ttl]);

  const showProgress = typeof notification.progress === 'number';
  const pct = Math.max(0, Math.min(100, notification.progress ?? 0));

  return (
    <motion.div
      initial={{ opacity: 0, y: 50, scale: 0.3 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.2 } }}
      className="pointer-events-auto w-96 max-w-[calc(100vw-2rem)]"
    >
      <div className={`bg-gradient-to-r from-gray-900 to-black border ${style.border} rounded-xl shadow-2xl backdrop-blur-xl p-4`}>
        <div className="flex items-start gap-3">
          <div className={`flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-r ${style.accent} flex items-center justify-center`}>
            <Icon className={`w-4 h-4 text-white ${type === 'progress' ? 'animate-spin' : ''}`} />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white mb-1">
              {notification.title || style.defaultTitle}
            </p>
            <p className="text-sm text-gray-300 line-clamp-3 whitespace-pre-wrap">
              {notification.message}
            </p>
          </div>

          <button
            onClick={() => onDismiss(notification.id)}
            className="flex-shrink-0 p-1 hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* Progress bar: live % when caller provides one; auto-shrinking
            timeout indicator otherwise. */}
        {showProgress ? (
          <div className="mt-3 h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-1 bg-gradient-to-r ${style.accent} rounded-full transition-all duration-300`}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : !isPersistent ? (
          <motion.div
            className={`mt-3 h-1 bg-gradient-to-r ${style.accent} rounded-full`}
            initial={{ width: '100%' }}
            animate={{ width: '0%' }}
            transition={{ duration: ttl / 1000, ease: 'linear' }}
          />
        ) : null}
      </div>
    </motion.div>
  );
}

export default NotificationToast;
