import React, { createContext, useContext, useState, useEffect } from 'react';

export type ThemeType = 'default' | 'pink-ekc' | 'navy-simorgh' | 'dark-matrix' | 'modern-dark' | 'clean-white';

interface ThemeContextType {
  theme: ThemeType;
  setTheme: (theme: ThemeType) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeType>(() => {
    const saved = localStorage.getItem('simorgh_theme');
    return (saved as ThemeType) || 'default';
  });

  const [notificationsEnabled, setNotificationsState] = useState(() => {
    const saved = localStorage.getItem('simorgh_notifications');
    return saved === 'true';
  });

  const setTheme = (newTheme: ThemeType) => {
    setThemeState(newTheme);
    localStorage.setItem('simorgh_theme', newTheme);
  };

  const setNotificationsEnabled = (enabled: boolean) => {
    setNotificationsState(enabled);
    localStorage.setItem('simorgh_notifications', enabled.toString());
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, notificationsEnabled, setNotificationsEnabled }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
