// src/components/MobileHeader.tsx
import React from 'react';
import { Menu, Settings, History, Search, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface MobileHeaderProps {
  onMenuClick: () => void;
  onHistoryClick: () => void;
  onSettingsClick: () => void;
  // Legacy props kept so existing call sites still compile. The model
  // selector chip was removed from the header (was misleading — general
  // chats hard-pin the LLM server-side); these are no longer rendered.
  currentModel?: 'online' | 'offline';
  userTier?: string;
  offlineLocked?: boolean;
}

export default function MobileHeader({ onMenuClick, onHistoryClick, onSettingsClick }: MobileHeaderProps) {
  const [showSettingsMenu, setShowSettingsMenu] = React.useState(false);

  return (
    <>
      {/* Mobile Header - only visible on screens < 768px */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-black/80 backdrop-blur-xl border-b border-white/10">
        <div className="flex items-center justify-between px-3 h-14" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          {/* Left: Hamburger Menu + History */}
          <div className="flex items-center gap-1">
            <button
              onClick={onMenuClick}
              className="p-2.5 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Open menu"
            >
              <Menu className="w-6 h-6 text-white" />
            </button>
            <button
              onClick={onHistoryClick}
              className="p-2.5 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Open history"
            >
              <History className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* Center: Simorgh wordmark — replaces the old model-selector
              dropdown which was confusing operators (the actual LLM is
              pinned server-side for general chats). Decorative only. */}
          <span className="text-white font-medium text-sm tracking-wide select-none">
            Simorgh AI
          </span>

          {/* Right: Settings with Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowSettingsMenu(!showSettingsMenu)}
              className="p-2.5 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Settings"
            >
              <Settings className="w-6 h-6 text-white" />
            </button>

            {/* Settings Dropdown Menu */}
            <AnimatePresence>
              {showSettingsMenu && (
                <>
                  {/* Backdrop */}
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setShowSettingsMenu(false)}
                  />

                  {/* Dropdown */}
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -10 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 top-full mt-2 w-56 bg-black/95 backdrop-blur-xl border border-white/20 rounded-xl shadow-2xl overflow-hidden z-40"
                  >
                    <div className="py-2">
                      {/* Search */}
                      <button
                        onClick={() => {
                          onHistoryClick();
                          setShowSettingsMenu(false);
                        }}
                        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/10 transition-colors text-left"
                      >
                        <Search className="w-5 h-5 text-blue-400" />
                        <span className="text-white font-medium">Search</span>
                      </button>

                      {/* Chat History */}
                      <button
                        onClick={() => {
                          onHistoryClick();
                          setShowSettingsMenu(false);
                        }}
                        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/10 transition-colors text-left"
                      >
                        <MessageSquare className="w-5 h-5 text-purple-400" />
                        <span className="text-white font-medium">Chat History</span>
                      </button>

                      {/* Divider */}
                      <div className="h-px bg-white/10 my-2" />

                      {/* Settings (original action) */}
                      <button
                        onClick={() => {
                          onSettingsClick();
                          setShowSettingsMenu(false);
                        }}
                        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/10 transition-colors text-left"
                      >
                        <Settings className="w-5 h-5 text-gray-400" />
                        <span className="text-white font-medium">Settings</span>
                      </button>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

    </>
  );
}
