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
  const [isMobile, setIsMobile] = React.useState(false);

  // Detect mobile screen size
  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768); // md breakpoint
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return (
    <>
      {/* Mobile backdrop - only show on mobile when sidebar is open */}
      {isMobile && isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onToggle}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30"
        />
      )}

      {/* Sidebar content */}
      <motion.div
        initial={false}
        animate={{
          width: isOpen ? (isMobile ? '100%' : 320) : 0,
          opacity: isOpen ? 1 : 0
        }}
        transition={{
          duration: 0.3,
          ease: 'easeInOut'
        }}
        className={`${
          isMobile
            ? 'fixed inset-y-0 z-40 w-full max-w-sm'
            : 'relative'
        } ${
          side === 'right' && isMobile ? 'left-0' : ''
        } ${
          side === 'left' && isMobile ? 'right-0' : ''
        } bg-black/40 backdrop-blur-xl border-white/10 overflow-hidden ${
          side === 'right' ? 'border-l' : 'border-r'
        } ${className}`}
      >
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, x: side === 'right' ? -20 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: side === 'right' ? -20 : 20 }}
              transition={{ duration: 0.2 }}
              className={`${isMobile ? 'w-full' : 'w-80'} h-full overflow-y-auto`}
            >
              {/* Header with Logo and toggle button */}
              <div className="flex flex-col px-4 pt-2 pb-2">
                {/* Top row: Logo + Toggle */}
                <div className="flex items-center justify-between">
                  {/* Simorgh Logo - only on right sidebar, hidden on mobile */}
                  {side === 'right' && !isMobile && (
                    <div className="flex items-center gap-1.5">
                      <img
                        src="/simorgh.svg"
                        alt="Simorgh"
                        className="w-9 h-9 -mt-0.5"
                      />
                      <img
                        src="/text_simorgh.svg"
                        alt="Simorgh"
                        className="h-7"
                      />
                    </div>
                  )}

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
              </div>

              {/* محتوای sidebar */}
              <div className="h-full">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* دکمه‌ها وقتی sidebar بسته است - hidden on mobile (< 768px), shown on desktop */}
      {!isOpen && (
        <div
          className={`hidden md:flex fixed ${
            side === 'right' ? 'left-4' : 'right-4'
          } top-4 z-50 flex-col gap-2`}
        >
          {/* Simorgh Logo - only on right sidebar when closed */}
          {side === 'right' && (
            <img
              src="/simorgh.svg"
              alt="Simorgh"
              className="w-8 h-8 mb-1"
            />
          )}

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
            className="p-2.5 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg group"
            title="Search History"
          >
            <SearchIcon className="w-5 h-5 text-blue-400 group-hover:text-blue-300" />
          </button>
        </div>
      )}
    </>
  );
}