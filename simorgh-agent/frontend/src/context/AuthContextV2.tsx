// src/context/AuthContextV2.tsx
/**
 * Modern Authentication Context (v2)
 *
 * Supports:
 * - Email/password authentication
 * - Google OAuth 2.0
 * - Email verification
 * - Password reset
 * - JWT with refresh tokens
 * - Backward compatibility with legacy TPMS auth
 */

import React, { createContext, useState, useEffect, useContext, ReactNode, useCallback } from 'react';
import axios, { AxiosError } from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// =============================================================================
// Types
// =============================================================================

// Modern user interface
export interface ModernUser {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  avatar_url?: string;
  email_verified: boolean;
  is_active: boolean;
  created_at: string;
  last_login_at?: string;
}

// Legacy user interface (for TPMS compatibility)
export interface LegacyUser {
  ID: number;
  EMPUSERNAME: string;
  USER_UID: string;
}

// Union type for user
export type User = ModernUser | LegacyUser;

// Check if user is modern type
export function isModernUser(user: User): user is ModernUser {
  return 'email' in user && 'id' in user;
}

// Check if user is legacy type
export function isLegacyUser(user: User): user is LegacyUser {
  return 'EMPUSERNAME' in user && 'ID' in user;
}

// Auth context interface
interface AuthContextType {
  // State
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  authMethod: 'modern' | 'legacy' | null;

  // Core auth methods
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  handleGoogleCallback: (code: string, redirectUri?: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAllDevices: () => Promise<void>;

  // Registration
  register: (email: string, password: string, firstName?: string, lastName?: string) => Promise<void>;

  // Email verification
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;

  // Password reset
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;

  // Legacy support
  legacyLogin: (username: string, password: string) => Promise<void>;

  // Project permissions (legacy compatibility)
  checkPermission: (projectId: string) => Promise<boolean>;

  // Utilities
  clearError: () => void;
  refreshAccessToken: () => Promise<boolean>;
}

// Create context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// =============================================================================
// Provider Component
// =============================================================================

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<'modern' | 'legacy' | null>(null);

  // =========================================================================
  // Token Management
  // =========================================================================

  const storeTokens = useCallback((accessToken: string, refresh?: string, method: 'modern' | 'legacy' = 'modern') => {
    setToken(accessToken);
    setAuthMethod(method);
    localStorage.setItem('simorgh_token', accessToken);
    localStorage.setItem('simorgh_auth_method', method);

    if (refresh) {
      setRefreshToken(refresh);
      localStorage.setItem('simorgh_refresh_token', refresh);
    }
  }, []);

  const clearTokens = useCallback(() => {
    setToken(null);
    setRefreshToken(null);
    setAuthMethod(null);
    localStorage.removeItem('simorgh_token');
    localStorage.removeItem('simorgh_refresh_token');
    localStorage.removeItem('simorgh_user');
    localStorage.removeItem('simorgh_auth_method');
  }, []);

  const storeUser = useCallback((userData: User) => {
    setUser(userData);
    localStorage.setItem('simorgh_user', JSON.stringify(userData));
  }, []);

  // =========================================================================
  // Initialize from localStorage
  // =========================================================================

  useEffect(() => {
    const initAuth = async () => {
      const storedToken = localStorage.getItem('simorgh_token');
      const storedUser = localStorage.getItem('simorgh_user');
      const storedRefresh = localStorage.getItem('simorgh_refresh_token');
      const storedMethod = localStorage.getItem('simorgh_auth_method') as 'modern' | 'legacy' | null;

      if (storedToken && storedUser) {
        setToken(storedToken);
        setRefreshToken(storedRefresh);
        setAuthMethod(storedMethod);

        try {
          const userData = JSON.parse(storedUser);
          setUser(userData);

          // Validate token
          await validateToken(storedToken, storedMethod);
        } catch (e) {
          console.error('Failed to parse stored user:', e);
          clearTokens();
        }
      }

      setIsLoading(false);
    };

    initAuth();
  }, [clearTokens]);

  // =========================================================================
  // Token Validation
  // =========================================================================

  const validateToken = async (authToken: string, method: 'modern' | 'legacy' | null) => {
    try {
      const endpoint = method === 'modern' ? '/auth/v2/me' : '/auth/me';
      const response = await axios.get(`${API_BASE}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      storeUser(response.data);
    } catch (error) {
      // Try to refresh token if it's a modern auth
      if (method === 'modern' && refreshToken) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
          clearTokens();
          setUser(null);
        }
      } else {
        clearTokens();
        setUser(null);
      }
    }
  };

  // =========================================================================
  // Refresh Token
  // =========================================================================

  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    const storedRefresh = refreshToken || localStorage.getItem('simorgh_refresh_token');

    if (!storedRefresh) {
      return false;
    }

    try {
      const response = await axios.post(`${API_BASE}/auth/v2/refresh`, {
        refresh_token: storedRefresh
      });

      const { access_token, refresh_token: newRefresh, user: userData } = response.data;

      storeTokens(access_token, newRefresh, 'modern');
      storeUser(userData);

      return true;
    } catch (error) {
      console.error('Token refresh failed:', error);
      clearTokens();
      setUser(null);
      return false;
    }
  }, [refreshToken, storeTokens, storeUser, clearTokens]);

  // =========================================================================
  // Modern Login
  // =========================================================================

  const login = useCallback(async (email: string, password: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await axios.post(`${API_BASE}/auth/v2/login`, {
        email,
        password
      });

      const { access_token, refresh_token, user: userData } = response.data;

      storeTokens(access_token, refresh_token, 'modern');
      storeUser(userData);

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, [storeTokens, storeUser]);

  // =========================================================================
  // Google OAuth
  // =========================================================================

  const loginWithGoogle = useCallback(async () => {
    try {
      setError(null);

      // Get Google auth URL
      const response = await axios.get(`${API_BASE}/auth/v2/google/url`);
      const { auth_url } = response.data;

      // Open Google OAuth in a popup or redirect
      window.location.href = auth_url;
    } catch (error) {
      handleAuthError(error);
      throw error;
    }
  }, []);

  const handleGoogleCallback = useCallback(async (code: string, redirectUri?: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await axios.post(`${API_BASE}/auth/v2/google/callback`, {
        code,
        redirect_uri: redirectUri
      });

      const { access_token, refresh_token, user: userData } = response.data;

      storeTokens(access_token, refresh_token, 'modern');
      storeUser(userData);

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, [storeTokens, storeUser]);

  // =========================================================================
  // Registration
  // =========================================================================

  const register = useCallback(async (
    email: string,
    password: string,
    firstName?: string,
    lastName?: string
  ) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/register`, {
        email,
        password,
        first_name: firstName,
        last_name: lastName
      });

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, []);

  // =========================================================================
  // Email Verification
  // =========================================================================

  const verifyEmail = useCallback(async (verificationToken: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/verify-email`, {
        token: verificationToken
      });

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/resend-verification`, { email });

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, []);

  // =========================================================================
  // Password Reset
  // =========================================================================

  const forgotPassword = useCallback(async (email: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/forgot-password`, { email });

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, []);

  const resetPassword = useCallback(async (resetToken: string, newPassword: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/reset-password`, {
        token: resetToken,
        new_password: newPassword
      });

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(
        `${API_BASE}/auth/v2/change-password`,
        {
          current_password: currentPassword,
          new_password: newPassword
        },
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, [token]);

  // =========================================================================
  // Legacy Login (TPMS)
  // =========================================================================

  const legacyLogin = useCallback(async (username: string, password: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await axios.post(`${API_BASE}/auth/login`, {
        username,
        password
      });

      const { access_token, user: userData } = response.data;

      // Handle user switching (preserve legacy behavior)
      const previousUser = localStorage.getItem('simorgh_user');
      if (previousUser) {
        const previousUserData = JSON.parse(previousUser);
        if (previousUserData.EMPUSERNAME && previousUserData.EMPUSERNAME !== userData.EMPUSERNAME) {
          clearUserData(previousUserData.EMPUSERNAME);
        }
      }

      storeTokens(access_token, undefined, 'legacy');
      storeUser(userData);

      setIsLoading(false);
    } catch (error) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  }, [storeTokens, storeUser]);

  // =========================================================================
  // Logout
  // =========================================================================

  const logout = useCallback(async () => {
    try {
      if (authMethod === 'modern' && token) {
        await axios.post(
          `${API_BASE}/auth/v2/logout`,
          {},
          { headers: { 'Authorization': `Bearer ${token}` } }
        ).catch(() => {}); // Ignore errors
      }
    } finally {
      clearTokens();
      setUser(null);
      setError(null);
    }
  }, [authMethod, token, clearTokens]);

  const logoutAllDevices = useCallback(async () => {
    try {
      if (authMethod === 'modern' && token) {
        await axios.post(
          `${API_BASE}/auth/v2/logout-all`,
          {},
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
      }
    } finally {
      clearTokens();
      setUser(null);
      setError(null);
    }
  }, [authMethod, token, clearTokens]);

  // =========================================================================
  // Project Permissions (Legacy Compatibility)
  // =========================================================================

  const checkPermission = useCallback(async (projectId: string): Promise<boolean> => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios.post(
        `${API_BASE}/auth/check-permission`,
        { project_id: projectId },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      return response.data.has_access;
    } catch (error) {
      console.error('Permission check failed:', error);
      return false;
    }
  }, [token]);

  // =========================================================================
  // Error Handling
  // =========================================================================

  const handleAuthError = (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ detail?: string }>;

      if (axiosError.response?.status === 401) {
        setError('Invalid credentials');
      } else if (axiosError.response?.status === 429) {
        setError('Too many attempts. Please try again later.');
      } else if (axiosError.response?.data?.detail) {
        setError(axiosError.response.data.detail);
      } else {
        setError('An error occurred. Please try again.');
      }
    } else {
      setError('An unexpected error occurred.');
    }
  };

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // =========================================================================
  // Helpers
  // =========================================================================

  const clearUserData = (username: string) => {
    localStorage.removeItem(`simorgh_projects_${username}`);
    localStorage.removeItem(`simorgh_general_chats_${username}`);
  };

  // =========================================================================
  // Context Value
  // =========================================================================

  const value: AuthContextType = {
    user,
    token,
    refreshToken,
    isAuthenticated: !!user && !!token,
    isLoading,
    error,
    authMethod,

    login,
    loginWithGoogle,
    handleGoogleCallback,
    logout,
    logoutAllDevices,

    register,

    verifyEmail,
    resendVerification,

    forgotPassword,
    resetPassword,
    changePassword,

    legacyLogin,
    checkPermission,

    clearError,
    refreshAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Export for compatibility
export default AuthContext;
