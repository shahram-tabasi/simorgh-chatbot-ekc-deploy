// src/context/AuthContext.tsx
import React, { createContext, useState, useEffect, useContext, ReactNode } from 'react';
import axios from 'axios';

const API_BASE_react = import.meta.env.VITE_API_BASE || 'http://localhost:8000';



// User interface matching backend response
export interface User {
  ID: number;
  EMPUSERNAME: string;
  USER_UID: string;
}

// Auth context interface
interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  checkPermission: (projectId: string) => Promise<boolean>;
  error: string | null;
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

  // Initialize auth from localStorage
  useEffect(() => {
    const storedToken = localStorage.getItem('simorgh_token');
    const storedUser = localStorage.getItem('simorgh_user');

    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));

      // Validate token by fetching current user
      validateToken(storedToken);
    } else {
      setIsLoading(false);
    }
  }, []);

  // Validate token
  const validateToken = async (authToken: string) => {
    try {
      const response = await axios.get(`${API_BASE_react}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      setUser(response.data);
      setIsLoading(false);
    } catch (error) {
      // Token invalid - clear auth
      console.error('Token validation failed:', error);
      logout();
    }
  };

  // Login function
  const login = async (username: string, password: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await axios.post(`${API_BASE_react}/auth/login`, {
        username,
        password
      });

      const { access_token, user: userData } = response.data;

      // Store in state
      setToken(access_token);
      setUser(userData);

      // Store in localStorage
      localStorage.setItem('simorgh_token', access_token);
      localStorage.setItem('simorgh_user', JSON.stringify(userData));

      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);

      if (error.response?.status === 401) {
        setError('Invalid username or password');
      } else {
        setError('Login failed. Please try again.');
      }

      throw error;
    }
  };

  // Logout function
  const logout = () => {
    setUser(null);
    setToken(null);
    setError(null);

    localStorage.removeItem('simorgh_token');
    localStorage.removeItem('simorgh_user');
  };

  // Check project permission
  const checkPermission = async (projectId: string): Promise<boolean> => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await axios.post(
        `${API_BASE_react}/auth/check-permission`,
        { project_id: projectId },
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
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
    login,
    logout,
    checkPermission,
    error
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
