import React, { useEffect, useState } from 'react';
import { ModernLogin } from './ModernLogin';
import Login from '../Login';

/**
 * LoginRouter - Automatically routes to the appropriate login page
 * based on access location (local network vs external/internet)
 *
 * - Local network access (192.168.x.x, localhost) → Legacy Login
 * - External access (simorghai.electrokavir.com) → Modern Login with Google OAuth
 */
export const LoginRouter: React.FC = () => {
  const [loginMode, setLoginMode] = useState<'modern' | 'legacy' | 'loading'>('loading');

  useEffect(() => {
    detectLoginMode();
  }, []);

  const detectLoginMode = async () => {
    // Method 1: Check hostname
    const hostname = window.location.hostname;

    // Local network patterns
    const isLocalNetwork =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) !== null;

    if (isLocalNetwork) {
      setLoginMode('legacy');
      return;
    }

    // Method 2: Try to get login mode from API (set by nginx)
    try {
      const response = await fetch('/api/login-mode');
      if (response.ok) {
        const data = await response.json();
        if (data.mode === 'legacy') {
          setLoginMode('legacy');
          return;
        }
      }
    } catch (error) {
      // API not available, fallback to hostname detection
      console.log('Login mode API not available, using hostname detection');
    }

    // Default to modern for external access
    setLoginMode('modern');
  };

  // Show loading state
  if (loginMode === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-white/70">Loading...</p>
        </div>
      </div>
    );
  }

  // Render appropriate login
  return loginMode === 'legacy' ? <Login /> : <ModernLogin />;
};

export default LoginRouter;
