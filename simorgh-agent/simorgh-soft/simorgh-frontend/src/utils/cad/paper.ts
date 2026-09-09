// src/utils/cad/paper.ts
//
// Putting a sheet on paper: the part DXF and PDF agree on.
//
// A drawing is built in its own units with y downwards. Both file formats need
// it in millimetres on a real sheet, so the scale, the sheet size and the
// margin are decided once, here, and each back-end only has to say which way
// its y axis runs.

/** ISO A landscape sizes, smallest first — the first that fits is the one used. */
export const PAPERS: [string, number, number][] = [
  ['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841],
];

/** Frame inset from the paper edge, in millimetres. */
export const MARGIN = 10;

export interface Paper { name: string; w: number; h: number }

export interface Fit {
  paper: Paper;
  /** Millimetres per drawing unit. */
  scale: number;
  /** Where the drawing's top-left corner lands on the paper, in millimetres. */
  ox: number;
  oy: number;
}

/** The smallest ISO landscape sheet the content fits on, else one made to fit. */
export function paperFor(w: number, h: number): Paper {
  for (const [name, pw, ph] of PAPERS) {
    if (w <= pw - 2 * MARGIN && h <= ph - 2 * MARGIN) return { name, w: pw, h: ph };
  }
  return { name: 'CUSTOM', w: w + 2 * MARGIN, h: h + 2 * MARGIN };
}

/** The sheet sizes a user can ask for by name, plus letting the drawing decide. */
export type PaperChoice = 'auto' | 'A4' | 'A3' | 'A2' | 'A1' | 'A0';

/**
 * A drawing put on the sheet the user named, at whatever scale that takes.
 *
 * Choosing the paper and choosing the scale are the same decision made from
 * opposite ends. `fitToPaper` fixes the scale and lets the sheet grow — which
 * is why a wide single line comes out on a metre of roll. Name a sheet instead
 * and the scale is whatever fits it, which is how a drawing office works when
 * the paper is what it has.
 */
export function fitToNamedPaper(width: number, height: number, choice: PaperChoice, fallback: number): Fit {
  if (choice === 'auto') return fitToPaper(width, height, fallback);
  const found = PAPERS.find(([name]) => name === choice);
  if (!found) return fitToPaper(width, height, fallback);
  const [name, pw, ph] = found;
  const scale = Math.min((pw - 2 * MARGIN) / width, (ph - 2 * MARGIN) / height);
  const paper: Paper = { name, w: pw, h: ph };
  return { paper, scale, ox: (pw - width * scale) / 2, oy: (ph - height * scale) / 2 };
}

/** Below this, a plotted label stops being readable. */
export const LEGIBLE_MM = 1.8;

/**
 * How tall a label of `units` comes out on a chosen sheet, in millimetres.
 *
 * Naming a sheet fixes the scale, and the scale decides whether anyone can
 * read the drawing. A wide single line on an A4 is a legal drawing and an
 * unreadable one, so the number is worth putting in front of the person
 * choosing, rather than leaving them to find out at the plotter.
 */
export function textHeightOn(
  width: number, height: number, choice: PaperChoice, fallbackScale: number, units: number,
): number {
  return fitToNamedPaper(width, height, choice, fallbackScale).scale * units;
}

/** A drawing of `width` × `height` units, scaled and centred on its sheet. */
export function fitToPaper(width: number, height: number, scale: number): Fit {
  const w = width * scale, h = height * scale;
  const paper = paperFor(w, h);
  return { paper, scale, ox: (paper.w - w) / 2, oy: (paper.h - h) / 2 };
}

/** Where the title block sits, given the lines it has to carry. */
export function titleBlockBox(paper: Paper, rows: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(170, paper.w - 2 * MARGIN);
  return { x: paper.w - MARGIN - w, y: MARGIN, w, h: 6 + Math.min(rows, 5) * 6 };
}
