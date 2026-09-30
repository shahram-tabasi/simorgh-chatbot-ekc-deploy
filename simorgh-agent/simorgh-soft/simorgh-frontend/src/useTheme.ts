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
// One theme for the whole app, however many components ask for it.
//
// The header button and View > Theme both call this hook. With plain useState
// each would hold its own copy: clicking one would leave the other's tick in
// the wrong place until something else re-rendered it. So the value lives in
// this module and every instance subscribes, which is also why the theme is
// written to <html> rather than being handed down a provider — nothing here
// needs to be wrapped for it to work.
let current: Theme = stored() ?? systemTheme();
const listeners = new Set<(t: Theme) => void>();

function apply(next: Theme) {
  current = next;
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not being able to remember the choice is no reason to refuse it.
  }
  listeners.forEach(fn => fn(next));
}

// Follow the system only while no explicit choice has been made. Registered
// once for the module, not once per component.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', e => {
      if (!stored()) apply(e.matches ? 'dark' : 'light');
    });
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(current);

  useEffect(() => {
    listeners.add(setThemeState);
    // The attribute is already set before the first paint by the script in
    // index.html; this keeps them in step if anything reset it since.
    if (document.documentElement.getAttribute('data-theme') !== current) {
      document.documentElement.setAttribute('data-theme', current);
    }
    setThemeState(current);
    return () => { listeners.delete(setThemeState); };
  }, []);

  const setTheme = useCallback((t: Theme) => apply(t), []);
  const toggle = useCallback(() => apply(current === 'dark' ? 'light' : 'dark'), []);

  return { theme, toggle, setTheme };
}
