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
  Feather,
  Lock,
  Shield
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { showWarning } from '../utils/alerts';
import { useAuth, isModernUser, isLegacyUser } from '../context/AuthContext';
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
  /** When true (the active chat is a general/HR session) the Online
   * AI tile in the AI-Mode picker is disabled — general chat is
   * hard-pinned to local Simorgh AI by hr_chat.py force_backend='text',
   * so allowing Online to be picked would be misleading. */
  isGeneralChatActive?: boolean;
}

export default function SettingsPanel({
  externalOpen = false,
  onExternalClose,
  isGeneralChatActive = false,
}: SettingsPanelProps = {}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [langOpen, setLangOpen] = React.useState(false);
  const [aiMode, setAiMode] = React.useState<'online' | 'offline'>('online');

  const { language, setLanguage } = useLanguage();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { theme, setTheme, notificationsEnabled, setNotificationsEnabled } = useTheme();

  const currentLang = languages.find(l => l.code === language) || languages[0];
  const isModern = user ? isModernUser(user) : false;
  const isLegacy = user ? isLegacyUser(user) : false;
  const displayName = user
    ? isLegacyUser(user) ? user.EMPUSERNAME
    : isModernUser(user) ? (user.display_name || user.first_name || user.email)
    : 'Guest User'
    : 'Guest User';
  const userStatus = user
    ? isModernUser(user) ? `${user.user_role?.charAt(0).toUpperCase()}${user.user_role?.slice(1) || 'Free'} • Online`
    : isLegacyUser(user) ? 'Enterprise • Local Network'
    : 'Guest'
    : 'Guest';

  // Sync with external control (both open and close)
  React.useEffect(() => {
    setIsOpen(externalOpen);
  }, [externalOpen]);

  // Load AI mode from localStorage on mount. Used to force online for
  // modern users; that pre-dated the HR direct-RAG path. Now both
  // tiers can pick either mode for project chats. General chats
  // always use Local regardless of this setting (hr_chat.py forces
  // offline_text backend) — the panel's helper text explains this.
  React.useEffect(() => {
    const savedMode = localStorage.getItem('llm_mode') as 'online' | 'offline' | null;
    setAiMode(savedMode ?? 'offline');  // Default to offline now.
  }, []);

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
                      {user && isLegacyUser(user) && user.USER_UID && (
                        <p className="text-gray-500 text-xs mt-0.5">ID: {user.USER_UID}</p>
                      )}
                      {user && isModernUser(user) && (
                        <p className="text-gray-500 text-xs mt-0.5">{user.email}</p>
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

                {/* AI Mode — applies to PROJECT chats only. General
                    chats always use Simorgh AI (the HR direct-RAG path
                    hard-pins offline). The Online tile sets the
                    project-chat per-request mode to "online"; the
                    backend routes to the configured cloud API. Local
                    is the default (and the only useful setting for
                    general chat). */}
                <div>
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-2">AI Mode</h3>
                  <p className="text-[11px] text-gray-500 mb-4 leading-relaxed">
                    General chat always uses <span className="text-violet-300">Simorgh AI</span>.
                    This setting controls <span className="text-sky-300">project chat</span> only.
                  </p>
                  <div className="space-y-3">
                    {/* In general chat the effective mode is ALWAYS
                        offline (hr_chat.py force-pins it), so override
                        the visual selection regardless of saved
                        preference. Saved preference (aiMode) is
                        preserved in localStorage for when the user
                        switches back to a project chat. */}
                    {(() => {
                      const effectiveMode = isGeneralChatActive ? 'offline' : aiMode;
                      return (
                        <>
                    <button
                      onClick={() => handleAiModeChange('online')}
                      disabled={isGeneralChatActive}
                      title={isGeneralChatActive
                        ? "Online AI is project-chat only — general chat always uses Simorgh AI"
                        : undefined}
                      className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                        isGeneralChatActive
                          ? 'border-white/5 opacity-40 cursor-not-allowed'
                          : effectiveMode === 'online'
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      {isGeneralChatActive
                        ? <Lock className="w-6 h-6 text-gray-500" />
                        : <Wifi className="w-6 h-6 text-blue-400" />}
                      <div className="text-left">
                        <div className="text-white font-medium">Online AI</div>
                        <div className="text-xs text-gray-400">
                          {isGeneralChatActive
                            ? 'Disabled in general chat (project chat only)'
                            : 'Configured cloud API · project chat only'}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => handleAiModeChange('offline')}
                      className={`w-full p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
                        effectiveMode === 'offline'
                          ? 'border-violet-500 bg-violet-500/10'
                          : 'border-white/10 hover:border-white/30'
                      }`}
                    >
                      <WifiOff className="w-6 h-6 text-violet-400" />
                      <div className="text-left">
                        <div className="text-white font-medium">
                          Simorgh AI
                          <span className="text-[10px] text-violet-300/80 font-normal ml-1">
                            {isGeneralChatActive ? '(active)' : '(default)'}
                          </span>
                        </div>
                        <div className="text-xs text-gray-400">LLM + VLM</div>
                      </div>
                    </button>
                        </>
                      );
                    })()}
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

                {/* Admin Panel Link */}
                {isModern && user && isModernUser(user) && user.user_role === 'admin' && (
                  <button
                    onClick={() => { handleClose(); navigate('/admin'); }}
                    className="w-full py-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 font-medium hover:bg-amber-500/20 transition"
                  >
                    <Shield className="w-5 h-5 inline mr-2" />
                    Admin Panel
                  </button>
                )}

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
