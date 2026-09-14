import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'simorgh-theme';

/** What the operating system asks for, when nothing has been chosen here. */
function systemTheme(): Theme {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
}

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    // Private windows and blocked site data both throw here rather than
    // returning nothing, and neither is a reason to fail to render.
    return null;
  }
}

/**
 * Light or dark, remembered.
 *
 * The theme is applied as data-theme on <html>, which is what theme.css keys
 * off. Kept there rather than on a React-rendered wrapper so it is set before
 * the first paint (see index.html) and so portalled nodes — modals render into
 * document.body, outside the app tree — are covered by the same rule.
 */
export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => stored() ?? systemTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  }, [theme]);

  // Follow the system only while no explicit choice has been made.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (!stored()) setThemeState(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(() => setThemeState(t => (t === 'dark' ? 'light' : 'dark')), []);

  return { theme, toggle, setTheme };
}
