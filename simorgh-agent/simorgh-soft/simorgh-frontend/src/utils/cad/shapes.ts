// src/utils/cad/shapes.ts
//
// A drawing, before it is a file.
//
// The single line and the panel layout used to build SVG strings directly, so
// the only thing that could come out of them was SVG — and, through the print
// dialog, a PDF of that SVG. A drawing office wants the geometry itself: the
// same sheet as DXF, opened and edited in AutoCAD, BricsCAD, ZWCAD or EPLAN.
//
// So the drawing is built once, here, as plain geometry — lines, arcs, text,
// on named layers — and each back-end renders it: `renderSvg` for the screen,
// `renderDxf` for CAD. Adding a third back-end costs one file, not a rewrite.
//
// Coordinates are the ones the sheets already use: pixels, origin top-left,
// y downwards. `renderDxf` flips and scales to millimetres; nothing upstream
// needs to know.

/** Where a text sits relative to its anchor point — SVG's text-anchor. */
export type Anchor = 'start' | 'middle' | 'end';

/**
 * Layers a sheet draws on. The names are what a draughtsman sees in the CAD
 * layer manager, so they say what the geometry *is*, not what it looks like.
 */
export type Layer =
  | 'FRAME'    // sheet border and title band
  | 'TITLE'    // sheet heading text
  | 'TEXT'     // notes, ratings, descriptions
  | 'TAG'      // device designations (-Q1, -F2 …)
  | 'BUS'      // busbar
  | 'WIRE'     // connections between devices
  | 'SYMBOL'   // device symbols
  | 'LOAD'     // motors, outgoing arrows
  | 'TABLE'    // the data block under each feeder
  | 'PANEL'    // panel/column outlines in the layout
  | 'SLOT'     // feeder bands in the layout
  | 'PIN'      // connection points on a symbol — where a wire is allowed to land
  | 'FREE';    // spare space in the layout

/** DXF colour (ACI) and linetype for each layer. */
export const LAYERS: Record<Layer, { aci: number; linetype: 'CONTINUOUS' | 'DASHED' }> = {
  FRAME:  { aci: 7, linetype: 'CONTINUOUS' },
  TITLE:  { aci: 7, linetype: 'CONTINUOUS' },
  TEXT:   { aci: 3, linetype: 'CONTINUOUS' },
  TAG:    { aci: 5, linetype: 'CONTINUOUS' },
  BUS:    { aci: 1, linetype: 'CONTINUOUS' },
  WIRE:   { aci: 7, linetype: 'CONTINUOUS' },
  SYMBOL: { aci: 7, linetype: 'CONTINUOUS' },
  LOAD:   { aci: 6, linetype: 'CONTINUOUS' },
  TABLE:  { aci: 8, linetype: 'CONTINUOUS' },
  PANEL:  { aci: 7, linetype: 'CONTINUOUS' },
  SLOT:   { aci: 4, linetype: 'CONTINUOUS' },
  PIN:    { aci: 2, linetype: 'CONTINUOUS' },
  FREE:   { aci: 8, linetype: 'DASHED' },
};

/** The AutoCAD Color Index, as the swatch a layer list shows for it. */
const ACI_HEX: Record<number, string> = {
  1: '#e11d48', 2: '#ca8a04', 3: '#16a34a', 4: '#0891b2',
  5: '#2563eb', 6: '#c026d3', 7: '#111827', 8: '#6b7280', 9: '#9ca3af',
};

/** The colour a CAD layer manager would show against this layer. */
export const layerColor = (layer: Layer): string => ACI_HEX[LAYERS[layer].aci] ?? '#111827';

/** What each layer holds, for a layer list that has to be read by a human. */
export const LAYER_NOTES: Record<Layer, string> = {
  FRAME: 'Sheet border and title block',
  TITLE: 'Sheet headings',
  TEXT: 'Notes, ratings, descriptions',
  TAG: 'Device designations',
  BUS: 'Busbar',
  WIRE: 'Connections between devices',
  SYMBOL: 'Device symbols',
  LOAD: 'Motors and outgoing arrows',
  TABLE: 'The data block under each feeder',
  PANEL: 'Column outlines',
  SLOT: 'Feeder bands',
  PIN: 'Connection points',
  FREE: 'Spare space and picture symbols',
};

/** How a shape is drawn. `layer` decides the DXF colour; `color` only the SVG. */
export interface Pen {
  layer: Layer;
  /** SVG stroke / text colour. CAD takes its colour from the layer. */
  color?: string;
  width?: number;
  /** SVG fill. `renderDxf` fills triangles and quads, and outlines the rest. */
  fill?: string;
  /**
   * SVG stroke-dasharray. `renderDxf` reads the pattern back and gives the
   * entity a CAD line type — DASHED, DASHDOT or DOT — so a dashed line stays
   * dashed in the customer's CAD system too.
   */
  dash?: string;
  /**
   * The block this shape belongs to, if any.
   *
   * A symbol brought in from the library arrives as a dozen lines and arcs that
   * are one *thing* — a contactor, a CT — and picking one line of it is never
   * what anybody meant. Shapes sharing a `block` are picked, moved and deleted
   * together, and go out as a real DXF BLOCK so the customer's CAD sees one
   * object too.
   *
   * The value is an id, not a name: `blockName` is what it is called. Two
   * copies of the same symbol carry the same name and different ids, which is
   * exactly what a CAD INSERT is.
   */
  block?: string;
  /** What the block is called, for the DXF block table and the layer list. */
  blockName?: string;
  /**
   * This shape is a connection point of its block, and this is what that point
   * is called — `A1`, `13`, `I0.0`, `2`.
   *
   * A wire that ends on one of these is joined to the *device*, not merely to a
   * coordinate that happens to be near it. That is the whole difference between
   * a picture of a circuit and a circuit: with it, a connection list can say
   * `-K1:A1 → -X1:3` and mean it; without it, all anyone can report is that two
   * lines meet somewhere.
   *
   * It lives on `Pen` rather than in a shape of its own so that everything that
   * already moves, scales, mirrors, groups and exports a shape carries it
   * along without knowing it exists.
   */
  pin?: string;
}

export type Pt = [number, number];

export type Shape =
  | ({ t: 'line'; x1: number; y1: number; x2: number; y2: number } & Pen)
  | ({ t: 'rect'; x: number; y: number; w: number; h: number } & Pen)
  | ({ t: 'circle'; cx: number; cy: number; r: number } & Pen)
  /** SVG draws it directly; DXF R12 has no ellipse and walks it instead. */
  | ({ t: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & Pen)
  /** Angles in degrees, measured in sheet space (y down) — see `renderDxf`. */
  | ({ t: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number } & Pen)
  /** Quadratic Bézier — CAD gets it flattened, SVG gets the curve. */
  | ({ t: 'curve'; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number } & Pen)
  | ({ t: 'poly'; pts: Pt[]; close?: boolean } & Pen)
  /**
   * `rot` turns the text about its own anchor, degrees anticlockwise on the
   * page — the way both DXF and a drawing office measure it, so a label written
   * up the side of a column is 90 in all three back-ends.
   */
  | ({ t: 'text'; x: number; y: number; s: string; size: number; anchor?: Anchor;
       bold?: boolean; title?: string; rot?: number } & Pen);

/**
 * A sheet: its size in drawing units and the geometry on it.
 *
 * The helpers are deliberately thin — they exist so the drawing code reads as
 * geometry rather than as string building, which is what made the old SVG
 * impossible to retarget.
 */
export class Drawing {
  readonly shapes: Shape[] = [];

  constructor(
    public width: number,
    public height: number,
    /** Goes into the DXF as a comment and the SVG as its accessible title. */
    public name = '',
  ) {}

  add(shape: Shape): this { this.shapes.push(shape); return this; }

  line(x1: number, y1: number, x2: number, y2: number, pen: Pen): this {
    return this.add({ t: 'line', x1, y1, x2, y2, ...pen });
  }

  rect(x: number, y: number, w: number, h: number, pen: Pen): this {
    return this.add({ t: 'rect', x, y, w, h, ...pen });
  }

  circle(cx: number, cy: number, r: number, pen: Pen): this {
    return this.add({ t: 'circle', cx, cy, r, ...pen });
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, pen: Pen): this {
    return this.add({ t: 'ellipse', cx, cy, rx, ry, ...pen });
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, pen: Pen): this {
    return this.add({ t: 'arc', cx, cy, r, a0, a1, ...pen });
  }

  curve(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, pen: Pen): this {
    return this.add({ t: 'curve', x1, y1, cx, cy, x2, y2, ...pen });
  }

  poly(pts: Pt[], pen: Pen & { close?: boolean }): this {
    const { close, ...rest } = pen;
    return this.add({ t: 'poly', pts, close, ...rest });
  }

  text(
    x: number, y: number, s: string, size: number,
    pen: Pen & { anchor?: Anchor; bold?: boolean; title?: string },
  ): this {
    const { anchor, bold, title, ...rest } = pen;
    // Empty labels would become stray zero-length TEXT entities in CAD.
    if (s === '') return this;
    return this.add({ t: 'text', x, y, s, size, anchor, bold, title, ...rest });
  }

  /** Every layer the sheet actually drew on, in the order LAYERS declares. */
  usedLayers(): Layer[] {
    const used = new Set(this.shapes.map(s => s.layer));
    return (Object.keys(LAYERS) as Layer[]).filter(l => used.has(l));
  }
}

/** One shape moved. Every back-end and the editor share this one definition. */
export function translateShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.t) {
    case 'line':    return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    case 'rect':    return { ...s, x: s.x + dx, y: s.y + dy };
    case 'circle':  return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    case 'ellipse': return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    case 'arc':     return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    case 'curve':   return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, cx: s.cx + dx, cy: s.cy + dy,
                              x2: s.x2 + dx, y2: s.y2 + dy };
    case 'poly':    return { ...s, pts: s.pts.map(p => [p[0] + dx, p[1] + dy] as Pt) };
    case 'text':    return { ...s, x: s.x + dx, y: s.y + dy };
  }
}

/** Points along a quadratic Bézier — how CAD back-ends flatten `curve`. */
export function flattenCurve(
  x1: number, y1: number, cx: number, cy: number, x2: number, y2: number,
  segments = 12,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    pts.push([
      u * u * x1 + 2 * u * t * cx + t * t * x2,
      u * u * y1 + 2 * u * t * cy + t * t * y2,
    ]);
  }
  return pts;
}
