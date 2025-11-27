import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PanelLeftIcon, PanelRightIcon, SparklesIcon, PlusIcon, SearchIcon } from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  side: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
  onNewProject?: () => void;
  onNewGeneralChat?: () => void;
  onSearchClick?: () => void;
}

export function Sidebar({
  isOpen,
  onToggle,
  side,
  children,
  className = '',
  onNewProject,
  onNewGeneralChat,
}: SidebarProps) {
  return (
    <>
      {/* Sidebar content */}
      <motion.div
        initial={false}
        animate={{
          width: isOpen ? 320 : 0,
          opacity: isOpen ? 1 : 0
        }}
        transition={{
          duration: 0.3,
          ease: 'easeInOut'
        }}
        className={`relative bg-black/40 backdrop-blur-xl border-white/10 overflow-hidden ${
          side === 'right' ? 'border-l' : 'border-r'
        } ${className}`}
      >
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-80 h-full"
            >
              {/* دکمه toggle داخل sidebar - بالای صفحه */}
              <div
                className="absolute top-4 z-10"
                style={{
                  [side === 'right' ? 'left' : 'right']: '16px'
                }}
              >
                <button
                  onClick={onToggle}
                  className="p-2.5 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg"
                  title="Hide sidebar"
                >
                  {side === 'right' ? (
                    <PanelLeftIcon className="w-5 h-5 text-white" />
                  ) : (
                    <PanelRightIcon className="w-5 h-5 text-white" />
                  )}
                </button>
              </div>

              {/* محتوای sidebar با padding از بالا */}
              <div className="h-full pt-16">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* دکمه‌ها وقتی sidebar بسته است - در بالای صفحه */}
      {!isOpen && (
        <div
          className={`fixed ${
            side === 'right' ? 'left-4' : 'right-4'
          } top-4 z-50 flex flex-col gap-2`}
        >
          {/* دکمه toggle */}
          <button
            onClick={onToggle}
            className="p-2.5 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg"
            title="Show sidebar"
          >
            {side === 'right' ? (
              <PanelRightIcon className="w-5 h-5 text-white" />
            ) : (
              <PanelLeftIcon className="w-5 h-5 text-white" />
            )}
          </button>

          {/* دکمه‌های اضافی برای sidebar راست */}
          {side === 'right' && (
            <>
              {onNewGeneralChat && (
                <button
                  onClick={onNewGeneralChat}
                  className="p-2.5 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg group"
                  title="New General Chat"
                >
                  <SparklesIcon className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
                </button>
              )}
              {onNewProject && (
                <button
                  onClick={onNewProject}
                  className="p-2.5 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg group"
                  title="New Project"
                >
                  <PlusIcon className="w-5 h-5 text-blue-400 group-hover:text-blue-300" />
                </button>
              )}
            </>
          )}

          {/* Search Icon */}
          <button
            onClick={onToggle}
            className="p-3 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg group"
            title="Search History"
          >
            <SearchIcon className="w-5 h-5 text-blue-400 group-hover:text-blue-300" />
          </button>
          )
        </div>
      )}
    </>
  );
}