// src/components/SettingsPanel.tsx - UPDATED VERSION
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Settings,
  X,
  Wifi,
  WifiOff,
  Palette,
  LogOut,
  Sparkles,
  Moon,
  ChevronDown,
  Bell,
  BellOff,
  Star,
  Code2,
  Feather
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { showWarning } from '../utils/alerts';
import { useAuth } from '../context/AuthContext';
import { useTheme, ThemeType } from '../context/ThemeContext';

const languages = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'fa', name: 'فارسی', flag: '🇮🇷' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' }
] as const;

const themes: Array<{ id: ThemeType; name: string; icon: any; gradient: string }> = [
  { id: 'default', name: 'Default (Starry)', icon: Star, gradient: 'from-indigo-900 to-purple-900' },
  { id: 'pink-ekc', name: 'Starry EKC Sky', icon: Sparkles, gradient: 'from-pink-300 to-pink-500' },
  { id: 'navy-simorgh', name: 'Navy Simorgh', icon: Feather, gradient: 'from-blue-900 to-indigo-900' },
  { id: 'dark-matrix', name: 'Dark Matrix', icon: Code2, gradient: 'from-black to-green-900' },
  { id: 'modern-dark', name: 'Modern Dark', icon: Moon, gradient: 'from-gray-800 to-gray-900' },
  { id: 'clean-white', name: 'EKC Digital Realm', icon: Palette, gradient: 'from-gray-100 to-white' },
];

interface SettingsPanelProps {
  externalOpen?: boolean;
  onExternalClose?: () => void;
}

export default function SettingsPanel({ externalOpen = false, onExternalClose }: SettingsPanelProps = {}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [langOpen, setLangOpen] = React.useState(false);
  const [aiMode, setAiMode] = React.useState<'online' | 'offline'>('online');

  const { language, setLanguage } = useLanguage();
  const { user, logout } = useAuth();
  const { theme, setTheme, notificationsEnabled, setNotificationsEnabled } = useTheme();

  const currentLang = languages.find(l => l.code === language) || languages[0];
  const displayName = user?.EMPUSERNAME || 'Guest User';
  const userStatus = user ? 'Pro Member • Online' : 'Guest';

  // Sync with external control
  React.useEffect(() => {
    if (externalOpen) {
      setIsOpen(true);
    }
  }, [externalOpen]);

  // Load AI mode from localStorage on mount
  React.useEffect(() => {
    const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
    if (savedMode) {
      setAiMode(savedMode);
    }
  }, []);

  // Handle AI mode change
  const handleAiModeChange = (mode: 'online' | 'offline') => {
    setAiMode(mode);
    localStorage.setItem('llm_mode', mode);
    window.dispatchEvent(new CustomEvent('llm-mode-changed', { detail: mode }));
  };

  // Handle notification toggle
  const handleNotificationToggle = () => {
    setNotificationsEnabled(!notificationsEnabled);
  };

  const handleClose = () => {
    setIsOpen(false);
    onExternalClose?.();
  };

  return (
    <>
      {/* دکمه تنظیمات - hidden on mobile (< 768px), bottom-right on desktop */}
      <button
        onClick={() => setIsOpen(true)}
        className="hidden md:flex fixed right-6 bottom-6 z-50 w-12 h-12 rounded-full bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl hover:scale-110 hover:bg-white/20 transition-all items-center justify-center"
      >
        <Settings className="w-6 h-6 text-white" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* پس‌زمینه تیره */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleClose}
              className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40"
            />

            {/* پنل اصلی */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 300 }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-black/95 backdrop-blur-3xl border-l border-white/10 z-50 overflow-y-auto"
            >
              <div className="p-6 space-y-8">
                {/* هدر + دکمه بستن */}
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                    <Palette className="w-8 h-8 text-purple-400" />
                    Settings
                  </h2>
                  <button
                    onClick={handleClose}
                    className="p-3 hover:bg-white/10 rounded-xl transition"
                  >
                    <X className="w-6 h-6 text-gray-400" />
                  </button>
                </div>

                {/* یوزر */}
                <div className="bg-white/5 rounded-2xl p-5 border border-white/10">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full overflow-hidden border-4 border-white/20 shadow-xl">
                      <img
                        src={`https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=6366f1&color=fff&bold=true`}
                        alt="User"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div>
                      <p className="text-white font-bold text-lg">{displayName}</p>
                      <p className="text-gray-400 text-sm">{userStatus}</p>
                      {user?.USER_UID && (
                        <p className="text-gray-500 text-xs mt-0.5">ID: {user.USER_UID}</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* زبان */}
                <div>
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Language</h3>
                  <div className="relative">
                    <button
                      onClick={() => setLangOpen(!langOpen)}
                      className="w-full px-5 py-4 bg-white/10 border border-white/20 rounded-xl flex items-center justify-between hover:bg-white/15 transition"
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-2xl">{currentLang.flag}</span>
                        <span className="text-white font-medium">{currentLang.name}</span>
                      </div>
                      <ChevronDown className={`w-5 h-5 text-gray-400 transition ${langOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <AnimatePresence>
                      {langOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute top-full left-0 right-0 mt-2 bg-black/90 border border-white/20 rounded-xl overflow-hidden backdrop-blur-xl z-10"
                        >
                          {languages.map(lang => (
                            <button
                              key={lang.code}
                              onClick={() => {
                                setLanguage(lang.code);
                                setLangOpen(false);
                              }}
                              className="w-full px-5 py-4 flex items-center gap-4 hover:bg-white/10 transition text-left"
                            >
                              <span className="text-2xl">{lang.flag}</span>
                              <span className="text-white">{lang.name}</span>
                              {language === lang.code && (
                                <div className="ml-auto w-3 h-3 bg-emerald-400 rounded-full" />
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* AI Mode */}
                <div>
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">AI Mode</h3>
                  <div className="space-y-3">
                    <button
                      onClick={() => handleAiModeChange('online')}
                      className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                        aiMode === 'online'
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      <Wifi className="w-6 h-6 text-blue-400" />
                      <div className="text-left">
                        <div className="text-white font-medium">Online AI</div>
                        <div className="text-xs text-gray-400">Cloud • GPT-4 • Grok</div>
                      </div>
                    </button>
                    <button
                      onClick={() => handleAiModeChange('offline')}
                      className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                        aiMode === 'offline'
                          ? 'border-purple-500 bg-purple-500/10'
                          : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      <WifiOff className="w-6 h-6 text-purple-400" />
                      <div className="text-left">
                        <div className="text-white font-medium">Local AI</div>
                        <div className="text-xs text-gray-400">On-premise • 192.168.1.61/62 • Private</div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Notifications - NOW ENABLED */}
                <div>
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Notifications</h3>
                  <button
                    onClick={handleNotificationToggle}
                    className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                      notificationsEnabled
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-white/10 hover:border-emerald-500 hover:bg-emerald-500/5'
                    }`}
                  >
                    {notificationsEnabled ? (
                      <Bell className="w-6 h-6 text-emerald-400" />
                    ) : (
                      <BellOff className="w-6 h-6 text-gray-400" />
                    )}
                    <div className="text-left">
                      <div className="text-white font-medium">
                        {notificationsEnabled ? 'Notifications Active ✓' : 'Enable Notifications'}
                      </div>
                      <div className="text-xs text-gray-400">
                        {notificationsEnabled
                          ? 'Toast notifications for AI messages'
                          : 'Get toast alerts when AI responds'
                        }
                      </div>
                    </div>
                  </button>
                </div>

                {/* Themes - NOW WORKING */}
                <div>
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Themes</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {themes.map((themeOption) => (
                      <button
                        key={themeOption.id}
                        onClick={() => setTheme(themeOption.id)}
                        className={`relative overflow-hidden rounded-xl p-4 border-2 transition-all ${
                          theme === themeOption.id
                            ? 'border-emerald-500 shadow-lg shadow-emerald-500/30'
                            : 'border-white/10 hover:border-white/30'
                        }`}
                      >
                        <div className={`absolute inset-0 bg-gradient-to-br ${themeOption.gradient} opacity-80`} />
                        <div className="relative flex flex-col items-center gap-2">
                          <themeOption.icon className="w-6 h-6 text-white" />
                          <span className="text-white font-medium text-xs text-center">{themeOption.name}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* خروج */}
                <button
                  onClick={logout}
                  className="w-full py-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 font-medium hover:bg-red-500/20 transition"
                >
                  <LogOut className="w-5 h-5 inline mr-2" />
                  Logout
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
