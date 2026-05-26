import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PanelLeftIcon, PanelRightIcon, SparklesIcon, PlusIcon } from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  side: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
  onNewProject?: () => void;
  onNewGeneralChat?: () => void;
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
              // The sidebar shell no longer scrolls — the contents
              // (top brand/quota/new-project/filters + General row)
              // stay pinned and only the inner chat list scrolls.
              // Previously this was `h-full overflow-y-auto` which
              // let everything scroll together.
              className={`${isMobile ? 'w-full' : 'w-80'} h-full flex flex-col overflow-hidden`}
            >
              {/* Brand row — fixed at the top, never scrolls. */}
              <div
                className="flex-shrink-0 flex items-center justify-between px-4 pt-3 pb-2"
              >
                {/* "Simorgh AI" wordmark. Renamed from "Simorgh Code"
                    per operator request. Switched the inline
                    leading-none (which was clipping descenders like
                    the 'g' in Simorgh) to leading-tight + a small
                    pb so the gradient text always renders complete. */}
                {side === 'right' && !isMobile && (
                  <div className="flex items-center gap-2.5">
                    <img
                      src={`${import.meta.env.BASE_URL}simorgh.svg`}
                      alt=""
                      className="w-12 h-12 flex-shrink-0"
                    />
                    <div className="flex items-baseline gap-1.5 leading-tight pb-1">
                      <span
                        className="text-[28px] font-bold tracking-tight bg-gradient-to-r from-sky-400 to-violet-400 bg-clip-text text-transparent"
                        style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", lineHeight: 1.15 }}
                      >
                        Simorgh
                      </span>
                      <span
                        className="text-[22px] font-normal text-slate-200/90 tracking-tight"
                        style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", lineHeight: 1.15 }}
                      >
                        AI
                      </span>
                    </div>
                  </div>
                )}

                <button
                  onClick={onToggle}
                  className="p-2 rounded-lg bg-black/60 hover:bg-black/80 border border-white/20 backdrop-blur-sm transition-all shadow-lg"
                  title="Hide sidebar"
                >
                  {side === 'right' ? (
                    <PanelLeftIcon className="w-5 h-5 text-white" />
                  ) : (
                    <PanelRightIcon className="w-5 h-5 text-white" />
                  )}
                </button>
              </div>

              {/* Sidebar body — flex column that lets the inner
                  ProjectTree decide which subsections scroll. The
                  brand row above is flex-shrink-0; everything else
                  inherits a flex-1 + min-h-0 to honour child scroll. */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>
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
              src={`${import.meta.env.BASE_URL}simorgh.svg`}
              alt="Simorgh"
              className="w-10 h-10 mb-1"
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
          {/* The dedicated Search/History affordance was redundant
              with the sidebar toggle (both did onToggle) and added
              UI noise on every screen. Removed per operator request.
              The full chat history list still opens via the chevron
              edge-toggle button below. */}
        </div>
      )}
    </>
  );
}
