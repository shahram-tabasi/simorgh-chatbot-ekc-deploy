// src/context/LanguageContext.tsx
import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { translations, type Language, type Dict, type TranslationKey } from '../locales';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  /** Translate a key. Missing keys fall back to the English entry and
   *  ultimately to the key itself so the UI never goes blank. */
  t: (key: TranslationKey) => string;
  /** Convenience flag for RTL-only conditional styling. */
  isRTL: boolean;
  /** 'rtl' | 'ltr' — handy for the `dir` attribute on inline elements
   *  (we already set `document.documentElement.dir` globally, but
   *  some components need to know explicitly). */
  dir: 'rtl' | 'ltr';
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('app-language') as Language | null;
    if (saved === 'en' || saved === 'fa' || saved === 'de') return saved;
    // First-load default: Persian for FA browsers, English otherwise.
    const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    if (nav.toLowerCase().startsWith('fa')) return 'fa';
    if (nav.toLowerCase().startsWith('de')) return 'de';
    return 'en';
  });

  useEffect(() => {
    localStorage.setItem('app-language', language);
    // Global document direction so the entire layout (sidebar order,
    // text alignment, scrollbars) flips together on Persian. Setting
    // dir on <html> means Tailwind's logical utilities + native
    // <input> RTL also Just Work without per-component dir overrides.
    document.documentElement.dir = language === 'fa' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageContextType>(() => {
    const dict: Dict = translations[language] || translations.en;
    return {
      language,
      setLanguage,
      t: (key: TranslationKey) =>
        (dict[key] ?? translations.en[key] ?? String(key)) as string,
      isRTL: language === 'fa',
      dir: language === 'fa' ? 'rtl' : 'ltr',
    };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
};