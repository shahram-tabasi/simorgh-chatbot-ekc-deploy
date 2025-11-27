import { useState, useEffect } from 'react';

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  projectId?: string;
  oeNumber?: string;
  avatar?: string;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Get user info from meta tags (injected by nginx)
    const getUserInfo = (): User | null => {
      const metaTags = document.head.querySelectorAll('meta[name^="x-user-"]');
      const userInfo: any = {};

      metaTags.forEach((tag) => {
        const name = tag.getAttribute('name')?.replace('x-user-', '').replace(/-/g, '_');
        const content = tag.getAttribute('content');
        if (name && content) {
          userInfo[name] = content;
        }
      });

      if (userInfo.id && userInfo.email) {
        return {
          id: userInfo.id,
          email: userInfo.email,
          name: userInfo.name || userInfo.email,
          role: userInfo.role || 'user',
          projectId: userInfo.project_id,
          oeNumber: userInfo.oe_number,
          avatar: userInfo.avatar,
        };
      }

      return null;
    };

    const userInfo = getUserInfo();
    
    if (userInfo) {
      setUser(userInfo);
      setIsAuthenticated(true);
    } else {
      // Try to get from localStorage (fallback)
      const storedUser = localStorage.getItem('simorgh_user');
      if (storedUser) {
        const parsed = JSON.parse(storedUser);
        setUser(parsed);
        setIsAuthenticated(true);
      }
    }

    setIsLoading(false);
  }, []);

  const logout = async () => {
    try {
      // Clear local storage
      localStorage.removeItem('simorgh_user');
      
      // Redirect to .NET Core logout
      window.location.href = 'http://host.docker.internal:5000/logout';
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  return {
    user,
    isAuthenticated,
    isLoading,
    logout,
  };
}