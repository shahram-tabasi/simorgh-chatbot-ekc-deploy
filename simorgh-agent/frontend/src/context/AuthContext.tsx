// src/context/AuthContext.tsx
import React, { createContext, useState, useEffect, useContext, ReactNode, useCallback } from 'react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

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
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Core auth methods
  login: (emailOrUsername: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => void;

  // Registration & verification
  register: (email: string, password: string, firstName?: string, lastName?: string) => Promise<void>;
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;

  // Password reset
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;

  // Legacy support
  checkPermission: (projectId: string) => Promise<boolean>;

  // Utilities
  clearError: () => void;
}

// Create context
const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Auth Provider Props
interface AuthProviderProps {
  children: ReactNode;
}

// Auth Provider Component
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Store tokens and user
  const storeAuth = useCallback((accessToken: string, userData: User) => {
    setToken(accessToken);
    setUser(userData);
    localStorage.setItem('simorgh_token', accessToken);
    localStorage.setItem('simorgh_user', JSON.stringify(userData));
  }, []);

  // Clear auth
  const clearAuth = useCallback(() => {
    setUser(null);
    setToken(null);
    setError(null);
    localStorage.removeItem('simorgh_token');
    localStorage.removeItem('simorgh_user');
    localStorage.removeItem('simorgh_refresh_token');
  }, []);

  // Initialize auth from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem('simorgh_token');
    const storedUser = localStorage.getItem('simorgh_user');

    if (storedToken && storedUser) {
      try {
        const userData = JSON.parse(storedUser);
        setToken(storedToken);
        setUser(userData);
        validateToken(storedToken, userData);
      } catch (e) {
        clearAuth();
        setIsLoading(false);
      }
    } else {
      setIsLoading(false);
    }
  }, [clearAuth]);

  // Validate token
  const validateToken = async (authToken: string, userData: User) => {
    try {
      // Try modern API first if user has email, otherwise use legacy
      const endpoint = isModernUser(userData) ? '/auth/v2/me' : '/auth/me';

      const response = await axios.get(`${API_BASE}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      setUser(response.data);
      setIsLoading(false);
    } catch (error) {
      console.error('Token validation failed:', error);
      clearAuth();
      setIsLoading(false);
    }
  };

  // Modern login (email/password)
  const login = async (emailOrUsername: string, password: string) => {
    try {
      setError(null);
      setIsLoading(true);

      // Detect if it's an email or username
      const isEmail = emailOrUsername.includes('@');

      if (isEmail) {
        // Modern login
        const response = await axios.post(`${API_BASE}/auth/v2/login`, {
          email: emailOrUsername,
          password
        });

        const { access_token, refresh_token, user: userData } = response.data;

        storeAuth(access_token, userData);
        if (refresh_token) {
          localStorage.setItem('simorgh_refresh_token', refresh_token);
        }
      } else {
        // Legacy login (TPMS username)
        const response = await axios.post(`${API_BASE}/auth/login`, {
          username: emailOrUsername,
          password
        });

        const { access_token, user: userData } = response.data;

        // Handle user switching
        const previousUser = localStorage.getItem('simorgh_user');
        if (previousUser) {
          const previousUserData = JSON.parse(previousUser);
          if (previousUserData.EMPUSERNAME && previousUserData.EMPUSERNAME !== userData.EMPUSERNAME) {
            clearUserData(previousUserData.EMPUSERNAME);
          }
        }

        storeAuth(access_token, userData);
      }

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Google OAuth login
  const loginWithGoogle = async () => {
    try {
      setError(null);
      const response = await axios.get(`${API_BASE}/auth/v2/google/url`);
      window.location.href = response.data.auth_url;
    } catch (error: any) {
      handleAuthError(error);
      throw error;
    }
  };

  // Register
  const register = async (email: string, password: string, firstName?: string, lastName?: string) => {
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
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Verify email
  const verifyEmail = async (verificationToken: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/verify-email`, {
        token: verificationToken
      });

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Resend verification email
  const resendVerification = async (email: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/resend-verification`, { email });

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Forgot password
  const forgotPassword = async (email: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/forgot-password`, { email });

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Reset password
  const resetPassword = async (resetToken: string, newPassword: string) => {
    try {
      setError(null);
      setIsLoading(true);

      await axios.post(`${API_BASE}/auth/v2/reset-password`, {
        token: resetToken,
        new_password: newPassword
      });

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      handleAuthError(error);
      throw error;
    }
  };

  // Logout function
  const logout = () => {
    const currentUser = user;
    if (currentUser && isLegacyUser(currentUser)) {
      console.log('🚪 Logging out user:', currentUser.EMPUSERNAME);
    }
    clearAuth();
  };

  // Helper function to clear specific user's localStorage data
  const clearUserData = (username: string) => {
    console.log('🧹 Clearing data for user:', username);
    localStorage.removeItem(`simorgh_projects_${username}`);
    localStorage.removeItem(`simorgh_general_chats_${username}`);
  };

  // Handle auth errors
  const handleAuthError = (error: any) => {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        setError('Invalid credentials');
      } else if (error.response?.status === 429) {
        setError('Too many attempts. Please try again later.');
      } else if (error.response?.data?.detail) {
        setError(error.response.data.detail);
      } else {
        setError('An error occurred. Please try again.');
      }
    } else {
      setError('An unexpected error occurred.');
    }
  };

  // Check project permission (legacy)
  const checkPermission = async (projectId: string): Promise<boolean> => {
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
  };

  const value: AuthContextType = {
    user,
    token,
    isAuthenticated: !!user && !!token,
    isLoading,
    error,
    login,
    loginWithGoogle,
    logout,
    register,
    verifyEmail,
    resendVerification,
    forgotPassword,
    resetPassword,
    checkPermission,
    clearError
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Custom hook to use auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
