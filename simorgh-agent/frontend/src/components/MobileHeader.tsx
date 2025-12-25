// src/components/MobileHeader.tsx
import React from 'react';
import { Menu, Settings, ChevronDown, History, Search, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface MobileHeaderProps {
  onMenuClick: () => void;
  onHistoryClick: () => void;
  onSettingsClick: () => void;
  currentModel: 'online' | 'offline';
}

export default function MobileHeader({ onMenuClick, onHistoryClick, onSettingsClick, currentModel }: MobileHeaderProps) {
  const [showModelSelector, setShowModelSelector] = React.useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = React.useState(false);
  const [selectedModel, setSelectedModel] = React.useState<'online' | 'offline'>(currentModel);

  React.useEffect(() => {
    setSelectedModel(currentModel);
  }, [currentModel]);

  const handleModelChange = (mode: 'online' | 'offline') => {
    setSelectedModel(mode);
    localStorage.setItem('llm_mode', mode);
    window.dispatchEvent(new CustomEvent('llm-mode-changed', { detail: mode }));
    setShowModelSelector(false);
  };

  const modelDisplayName = selectedModel === 'online' ? 'Sonnet 4.5' : 'Local AI';

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

          {/* Center: Model Selector */}
          <button
            onClick={() => setShowModelSelector(true)}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 rounded-lg transition-colors"
          >
            <span className="text-white font-medium text-sm">{modelDisplayName}</span>
            <ChevronDown className="w-4 h-4 text-gray-400" />
          </button>

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

      {/* Model Selector Bottom Sheet */}
      <AnimatePresence>
        {showModelSelector && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowModelSelector(false)}
              className="md:hidden fixed inset-0 bg-black/70 backdrop-blur-sm z-40"
            />

            {/* Bottom Sheet */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-black/95 backdrop-blur-xl rounded-t-3xl border-t border-white/20"
              style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
            >
              <div className="p-6 space-y-4">
                {/* Handle bar */}
                <div className="flex justify-center">
                  <div className="w-12 h-1 bg-white/30 rounded-full" />
                </div>

                <h3 className="text-white text-lg font-semibold">Select AI Model</h3>

                {/* Online AI Option */}
                <button
                  onClick={() => handleModelChange('online')}
                  className={`w-full p-4 rounded-xl border-2 flex items-start gap-3 transition-all ${
                    selectedModel === 'online'
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                    <div className="w-5 h-5 rounded-full bg-blue-500" />
                  </div>
                  <div className="text-left flex-1">
                    <div className="text-white font-semibold">Sonnet 4.5</div>
                    <div className="text-xs text-gray-400 mt-0.5">Cloud • GPT-4 • Grok</div>
                  </div>
                  {selectedModel === 'online' && (
                    <div className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-white" />
                    </div>
                  )}
                </button>

                {/* Local AI Option */}
                <button
                  onClick={() => handleModelChange('offline')}
                  className={`w-full p-4 rounded-xl border-2 flex items-start gap-3 transition-all ${
                    selectedModel === 'offline'
                      ? 'border-purple-500 bg-purple-500/10'
                      : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                    <div className="w-5 h-5 rounded-full bg-purple-500" />
                  </div>
                  <div className="text-left flex-1">
                    <div className="text-white font-semibold">Local AI</div>
                    <div className="text-xs text-gray-400 mt-0.5">On-premise • 192.168.1.61/62 • Private</div>
                  </div>
                  {selectedModel === 'offline' && (
                    <div className="flex-shrink-0 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-white" />
                    </div>
                  )}
                </button>

                {/* Cancel button */}
                <button
                  onClick={() => setShowModelSelector(false)}
                  className="w-full py-3 text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
