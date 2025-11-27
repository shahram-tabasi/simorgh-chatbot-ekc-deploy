import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  UserIcon, LogOutIcon, SettingsIcon, HelpCircleIcon, 
  ChevronDownIcon, ShieldIcon 
} from 'lucide-react';
import { User } from '../hooks/useAuth';

interface UserProfileProps {
  user: User | null;
  onLogout: () => void;
}

export function UserProfile({ user, onLogout }: UserProfileProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!user) return null;

  const getRoleColor = (role: string) => {
    switch (role.toLowerCase()) {
      case 'admin':
        return 'text-red-400';
      case 'manager':
        return 'text-purple-400';
      default:
        return 'text-blue-400';
    }
  };

  const getRoleBadge = (role: string) => {
    switch (role.toLowerCase()) {
      case 'admin':
        return 'bg-red-500/20 text-red-400';
      case 'manager':
        return 'bg-purple-500/20 text-purple-400';
      default:
        return 'bg-blue-500/20 text-blue-400';
    }
  };

  return (
    <div className="relative">
      {/* Profile button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-all"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
          {user.avatar ? (
            <img src={user.avatar} alt={user.name} className="w-full h-full rounded-full" />
          ) : (
            <UserIcon className="w-4 h-4 text-white" />
          )}
        </div>
        <div className="text-left hidden md:block">
          <div className="text-sm font-medium text-white">{user.name}</div>
          <div className={`text-xs ${getRoleColor(user.role)}`}>
            {user.role}
          </div>
        </div>
        <ChevronDownIcon
          className={`w-4 h-4 text-gray-400 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Dropdown menu */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />

            {/* Menu */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute right-0 mt-2 w-72 rounded-lg bg-black/90 backdrop-blur-xl border border-white/10 shadow-xl z-50 overflow-hidden"
            >
              {/* User info section */}
              <div className="p-4 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center">
                    {user.avatar ? (
                      <img src={user.avatar} alt={user.name} className="w-full h-full rounded-full" />
                    ) : (
                      <UserIcon className="w-6 h-6 text-white" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">
                      {user.name}
                    </div>
                    <div className="text-xs text-gray-400 truncate">
                      {user.email}
                    </div>
                  </div>
                </div>

                {/* Role badge */}
                <div className="mt-3 flex items-center gap-2">
                  <ShieldIcon className="w-3 h-3 text-gray-400" />
                  <span className={`text-xs px-2 py-1 rounded ${getRoleBadge(user.role)}`}>
                    {user.role.toUpperCase()}
                  </span>
                </div>

                {/* Project info */}
                {user.projectId && (
                  <div className="mt-2 text-xs text-gray-400">
                    <span className="font-medium">Project:</span> {user.projectId}
                    {user.oeNumber && ` / ${user.oeNumber}`}
                  </div>
                )}
              </div>

              {/* Menu items */}
              <div className="p-2">
                <button
                  onClick={() => {
                    setIsOpen(false);
                    // Open settings
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                >
                  <SettingsIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-white">Settings</span>
                </button>

                <button
                  onClick={() => {
                    setIsOpen(false);
                    // Open help
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/10 transition-colors text-left"
                >
                  <HelpCircleIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-white">Help & Support</span>
                </button>

                <div className="my-2 border-t border-white/10" />

                <button
                  onClick={() => {
                    setIsOpen(false);
                    onLogout();
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-red-500/10 transition-colors text-left group"
                >
                  <LogOutIcon className="w-4 h-4 text-gray-400 group-hover:text-red-400" />
                  <span className="text-sm text-white group-hover:text-red-400">
                    Logout
                  </span>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}