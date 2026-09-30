// src/components/SimorghDraw/theme.ts
//
// Light or dark, for the drawing editor only.
//
// Every CAD package on a draughtsman's desk offers this, and the reason is not
// fashion: a sheet is looked at for hours, often in a workshop office with the
// blinds down, and a white A0 at full screen is a lamp pointed at the face.
//
// Two rules keep it honest.
//
//   **It is a viewing preference, not a property of the drawing.** DXF, PDF and
//   SVG come out of the same geometry with the same colours whichever theme is
//   on. What leaves the app never depends on how somebody likes to look at it.
//
//   **Dark does not repaint the geometry, it flips the near-blacks.** A CAD
//   system shows colour 7 as white on black and black on white, and leaves
//   every other colour alone — a red busbar is red on both. Anything else and a
//   layer's colour stops meaning what the layer list says it means.

export type ThemeId = 'light' | 'dark';

export interface Theme {
  id: ThemeId;
  /** Behind the sheet. */
  surround: string;
  /** The sheet itself. */
  paper: string;
  /** The sheet's edge. */
  edge: string;
  /** The grid over it. */
  grid: string;
  /** What a shape with no colour of its own is drawn in. */
  ink: string;
  /** Picked geometry, and the draft of something being drawn. */
  selected: string;
  /** The snap marker and the highlight a command tool puts on a shape. */
  accent: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  light: {
    id: 'light',
    surround: '#f1f5f9',
    paper: '#ffffff',
    edge: '#cbd5e1',
    grid: '#e5e7eb',
    ink: '#111111',
    selected: '#2563eb',
    accent: '#f59e0b',
  },
  dark: {
    id: 'dark',
    // Not black: a true black sheet makes thin lines shimmer, and every CAD
    // package that tried it went back to a dark slate.
    surround: '#0b1220',
    paper: '#111827',
    edge: '#334155',
    grid: '#1f2937',
    ink: '#e5e7eb',
    selected: '#60a5fa',
    accent: '#fbbf24',
  },
};

/** How bright a colour is, 0…1. Rough, but enough to tell ink from a signal. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A shape's colour as this theme shows it.
 *
 * Near-black becomes the theme's ink and everything else is left alone, which
 * is the rule a CAD system applies to colour 7. A blue tag stays blue.
 */
export function shownIn(theme: Theme, color: string | undefined): string {
  const own = color ?? '#111111';
  if (theme.id === 'light') return own;
  return luminance(own) < 0.28 ? theme.ink : own;
}

const KEY = 'simorgh-draw-theme';

/** The theme last chosen on this machine. Light unless somebody said otherwise. */
export function loadTheme(): ThemeId {
  try {
    const kept = window.localStorage.getItem(KEY);
    if (kept === 'light' || kept === 'dark') return kept;
    // Nobody has said: follow the machine, the way every other app now does.
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch { /* a browser that will not keep anything is not an error */ }
  return 'light';
}

export function saveTheme(id: ThemeId): void {
  try { window.localStorage.setItem(KEY, id); } catch { /* nothing to do */ }
}
