import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connectionRun } from '../../utils/cad/connect';
import { Drawing, Layer, Pen, Pt, Shape } from '../../utils/cad/shapes';
import {
  Grip, dimensionShapes, gripsOf, lineMetrics, moveGrip, withWholeBlocks,
} from '../../utils/cad/geom';
import { THEMES, Theme, ThemeId, shownIn } from './theme';
import { shapeToNode } from '../../utils/cad/svg';
import {
  Box, boundsOf, boundsOfAll, hitTest, nearestSnap, shapesInBox, snapPoints,
} from '../../utils/cad/edit';

// The drawing surface: pan, zoom, pick, drag — and draw.
//
// Drawing works the way a CAD package does rather than the way a paint program
// does: click where it starts, move, click where it ends. Dragging works too,
// for the hand that expects it, and the two are the same gesture — a press and
// a release far apart finishes the shape, a press and release in the same place
// leaves it waiting for the second click.
//
// A point lands on what is already drawn before it lands on the grid: the ends
// and corners and centres of the geometry catch the cursor first, because a
// line drawn to the end of another that misses by a pixel looks right and
// leaves a gap in the DXF that only turns up when somebody trims to it.
//
// Hit testing is done against the geometry rather than by hanging a handler on
// every element — a sheet is several hundred shapes, and a 1.3-unit line is not
// something a pointer can land on by accident. `distanceTo` in cad/edit.ts
// gives each shape a real distance from the cursor, so a thin line is as easy
// to pick as a filled box, and the shape drawn last wins a tie, which is the
// one the eye sees on top.

export interface Viewport { x: number; y: number; w: number; h: number }

/**
 * What the pointer does.
 *
 * Three kinds: the two that only look at the drawing, the ones that add to it,
 * and the ones that act on the shape they are clicked on — trim, extend and
 * corner, which in a CAD package are commands rather than shapes.
 */
export type Tool =
  | 'select' | 'pan'
  | 'line' | 'polyline' | 'connect' | 'rect' | 'circle' | 'ellipse' | 'arc' | 'text' | 'dim'
  | 'trim' | 'extend' | 'corner';

/** Tools that put something new on the sheet. */
export const DRAWS: ReadonlySet<Tool> = new Set<Tool>(
  ['line', 'polyline', 'connect', 'rect', 'circle', 'ellipse', 'arc', 'text', 'dim']);

/** Tools that operate on the shape they are clicked on. */
export const PICKS: ReadonlySet<Tool> = new Set<Tool>(['trim', 'extend', 'corner']);

/** How many points a tool needs before it has drawn something. */
const NEEDS: Partial<Record<Tool, number>> = {
  line: 2, connect: 2, rect: 2, circle: 2, ellipse: 2, arc: 3, dim: 3,
};

interface Props {
  drawing: Drawing;
  shapes: Shape[];
  selection: ReadonlySet<number>;
  hidden: ReadonlySet<Layer>;
  locked: ReadonlySet<Layer>;
  view: Viewport;
  grid: number;
  showGrid: boolean;
  tool: Tool;
  /** How new geometry is drawn — layer, width, dash. */
  pen: Pen;
  /** Height of new text, in drawing units. */
  textSize: number;
  /** Catch the cursor on the ends and corners of what is already drawn. */
  objectSnap: boolean;
  /** Drawing units to millimetres — what a dimension writes its label in. */
  mmPerUnit: number;
  /**
   * Light or dark. A viewing preference only — every export is drawn from the
   * same geometry in the same colours whichever is on.
   */
  theme?: ThemeId;
  onView: (v: Viewport) => void;
  onSelection: (next: Set<number>) => void;
  /** A drag that has finished: commit it, once, so undo gets one step. */
  onMove: (dx: number, dy: number) => void;
  onCursor: (p: { x: number; y: number } | null) => void;
  onEditText: (index: number) => void;
  /**
   * A finished piece of work, ready to go on the sheet. An array because one
   * gesture is not always one shape — a dimension is six.
   */
  onDraw: (shapes: Shape[]) => void;
  /** The text tool has a place and needs the words. */
  onPlaceText: (at: { x: number; y: number }) => void;
  /** A command tool was used on the shape at `index`. */
  onPick: (index: number, at: Pt) => void;
  /**
   * A grip drag that has finished: the shape at `index` has one of its points
   * moved to `to`. Reported once on release, so undo gets one step for the
   * whole drag rather than one per pixel.
   */
  onGrip: (index: number, grip: string, to: Pt) => void;
  /**
   * Whether something is half-drawn.
   *
   * The editor listens for the same keys this does — Escape and Backspace —
   * and has to know to leave them alone while a draft is open. Asking rather
   * than depending on which listener the browser happens to call first.
   */
  onDrafting?: (active: boolean) => void;
  /** Right-click with nothing half-drawn: the command is over. */
  onCancelTool?: () => void;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: Viewport }
  | { kind: 'move'; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'band'; startX: number; startY: number; x: number; y: number; additive: boolean }
  /** One point of one shape, taken hold of by its grip. */
  | { kind: 'grip'; index: number; grip: string; at: Pt }
  | null;

/** A shape being drawn: the points given so far, and where the cursor is. */
interface Draft { tool: Tool; pts: Pt[]; cursor: Pt }

/**
 * The point a dragged grip is measured from.
 *
 * Holding Shift squares a line up — level, upright or 45° — and that only
 * means anything against a fixed point. For a line's end that is its other
 * end; for a radius or an arc it is the centre. Undefined where there is no
 * such point, and then Shift simply does nothing.
 */
function otherEndOf(s: Shape | undefined, grip: string): Pt | undefined {
  if (!s) return undefined;
  switch (s.t) {
    case 'line':
      return grip === 'a' ? [s.x2, s.y2] : grip === 'b' ? [s.x1, s.y1] : undefined;
    case 'circle': case 'ellipse': case 'arc':
      return grip === 'centre' ? undefined : [s.cx, s.cy];
    case 'curve':
      return grip === 'a' ? [s.x2, s.y2] : grip === 'b' ? [s.x1, s.y1] : undefined;
    case 'poly': {
      // The vertex before this one, so a leg of a polyline squares up the way
      // it did when it was drawn.
      const i = Number(grip.slice(1));
      return Number.isInteger(i) && i > 0 ? s.pts[i - 1] : undefined;
    }
    default:
      return undefined;
  }
}


// SVG spells its attributes with hyphens; React wants the camel-cased prop.
const REACT_PROP: Record<string, string> = {
  'stroke-width': 'strokeWidth',
  'stroke-dasharray': 'strokeDasharray',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'text-anchor': 'textAnchor',
};

export const DrawingCanvas: React.FC<Props> = ({
  drawing, shapes, selection, hidden, locked, view, grid, showGrid, tool,
  pen, textSize, objectSnap, mmPerUnit, theme: themeId = 'light',
  onView, onSelection, onMove, onCursor, onEditText, onDraw, onPlaceText,
  onPick, onGrip, onDrafting, onCancelTool,
}) => {
  const theme: Theme = THEMES[themeId] ?? THEMES.light;
  const SELECTED = theme.selected;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [space, setSpace] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapped, setSnapped] = useState<Pt | null>(null);
  const [pressed, setPressed] = useState<{ x: number; y: number } | null>(null);
  const [cursorHint, setCursorHint] = useState<{ x: number; y: number } | null>(null);
  // What a command tool would act on if it were clicked now, so trim and
  // corner say what they are about to do before they do it.
  const [hover, setHover] = useState<number | null>(null);

  // Holding space turns any tool into the pan tool, as every CAD package does.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(true); };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  /**
   * Where the viewBox actually lands on the element.
   *
   * An `<svg>` scales its viewBox uniformly and centres it — the default
   * `preserveAspectRatio` — so unless the box happens to have the element's
   * shape there are bars down the sides or along the top. Reading a cursor as
   * a straight fraction of the element ignores those bars, and every pick and
   * every zoom then drifts by however wide they are. This is the real mapping.
   */
  const mapping = useCallback((box: Viewport = view) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { scale: 1, ox: 0, oy: 0, r: null as DOMRect | null };
    const scale = Math.min(r.width / box.w, r.height / box.h);
    return {
      scale,
      ox: r.left + (r.width - box.w * scale) / 2,
      oy: r.top + (r.height - box.h * scale) / 2,
      r,
    };
  }, [view]);

  /** Client pixels → drawing units. */
  const toDrawing = useCallback((clientX: number, clientY: number) => {
    const m = mapping();
    return { x: view.x + (clientX - m.ox) / m.scale, y: view.y + (clientY - m.oy) / m.scale };
  }, [mapping, view]);

  /** Units per screen pixel — the tolerance a pick should allow. */
  const unitsPerPixel = useCallback(() => 1 / mapping().scale, [mapping]);

  // The ends and corners of what is already drawn, recomputed only when the
  // sheet changes — a sheet is several hundred shapes and this runs on every
  // pointer move.
  const snaps = useMemo(
    () => (objectSnap && DRAWS.has(tool) ? snapPoints(shapes, hidden) : []),
    [objectSnap, tool, shapes, hidden]);

  /** The shapes a click is allowed to find. */
  const offLimits = useMemo(() => new Set([...hidden, ...locked]), [hidden, locked]);

  /**
   * The handles on what is picked.
   *
   * Only while the pick tool is in hand — a grip under a drawing tool would
   * swallow the click that was meant to start a line. And only for a handful
   * of shapes at a time: grips on two hundred picked shapes are not handles,
   * they are confetti, and the bounding box already says what is selected.
   */
  const GRIP_LIMIT = 12;
  const grips = useMemo<{ index: number; grip: Grip }[]>(() => {
    if (tool !== 'select' || selection.size === 0 || selection.size > GRIP_LIMIT) return [];
    const out: { index: number; grip: Grip }[] = [];
    for (const i of selection) {
      const s = shapes[i];
      if (!s || offLimits.has(s.layer)) continue;
      for (const grip of gripsOf(s)) out.push({ index: i, grip });
    }
    return out;
  }, [tool, selection, shapes, offLimits]);

  /** The grip within reach of a point, nearest first. */
  const gripAt = useCallback((x: number, y: number) => {
    // A little more generous than a shape pick, because a grip is the thing
    // you are aiming at and it sits on top of the geometry it belongs to.
    const reach = unitsPerPixel() * 8;
    let best: { index: number; grip: Grip } | null = null;
    let bestDistance = reach;
    for (const g of grips) {
      const d = Math.hypot(g.grip.at[0] - x, g.grip.at[1] - y);
      if (d <= bestDistance) { best = g; bestDistance = d; }
    }
    return best;
  }, [grips, unitsPerPixel]);

  /**
   * Where a click lands.
   *
   * What is already drawn catches the cursor first, then the grid. Holding
   * shift squares the line up against the point before it — level, upright or
   * at 45°, which is most of what a single line is made of.
   */
  const resolve = useCallback((clientX: number, clientY: number, ortho: boolean, from?: Pt) => {
    const raw = toDrawing(clientX, clientY);
    const near = snaps.length ? nearestSnap(snaps, raw.x, raw.y, unitsPerPixel() * 9) : null;
    if (near) return { point: [near[0], near[1]] as Pt, onGeometry: true };

    let { x, y } = raw;
    if (ortho && from) {
      const dx = x - from[0], dy = y - from[1];
      // The nearest of level, upright and the two diagonals.
      if (Math.abs(Math.abs(dx) - Math.abs(dy)) < Math.min(Math.abs(dx), Math.abs(dy)) * 0.5) {
        const d = (Math.abs(dx) + Math.abs(dy)) / 2;
        x = from[0] + Math.sign(dx) * d;
        y = from[1] + Math.sign(dy) * d;
      } else if (Math.abs(dx) > Math.abs(dy)) y = from[1];
      else x = from[0];
    }
    if (grid > 0) {
      x = Math.round(x / grid) * grid;
      y = Math.round(y / grid) * grid;
    }
    return { point: [x, y] as Pt, onGeometry: false };
  }, [toDrawing, snaps, unitsPerPixel, grid]);

  /**
   * A draft with enough points, as the geometry it stands for.
   *
   * A run rather than one shape: most tools draw a single thing, but a
   * dimension is a line, two extension lines, two arrowheads and a label, and
   * they are all put down together so undo takes them all back together.
   */
  const shapeOf = useCallback((tool_: Tool, pts: Pt[]): Shape[] | null => {
    const [a, b, c] = pts;
    switch (tool_) {
      case 'line':
        if (!b || (a[0] === b[0] && a[1] === b[1])) return null;
        return [{ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...pen }];
      case 'polyline':
        if (pts.length < 2) return null;
        return [{ t: 'poly', pts: [...pts], ...pen }];
      case 'connect':
        if (!b) return null;
        // Always on WIRE, whatever the layer box says: a connection is a
        // connection, and having half of them land on SYMBOL because the bar
        // was left somewhere else is the sort of thing nobody notices until
        // the DXF is open at the customer's.
        return connectionRun(a, b, { ...pen, layer: 'WIRE' }, shapes);
      case 'rect': {
        if (!b) return null;
        const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        if (w < 0.5 || h < 0.5) return null;
        return [{ t: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h, ...pen }];
      }
      case 'circle': {
        if (!b) return null;
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (r < 0.5) return null;
        return [{ t: 'circle', cx: a[0], cy: a[1], r, ...pen }];
      }
      case 'ellipse': {
        // Centre, then a corner of the box it fits in — the two radii at once.
        if (!b) return null;
        const rx = Math.abs(b[0] - a[0]), ry = Math.abs(b[1] - a[1]);
        if (rx < 0.5 || ry < 0.5) return null;
        return [{ t: 'ellipse', cx: a[0], cy: a[1], rx, ry, ...pen }];
      }
      case 'arc': {
        // Centre, then where it starts, then how far it sweeps.
        if (!b || !c) return null;
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (r < 0.5) return null;
        const deg = (p: Pt) => (Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI;
        let a0 = deg(b), a1 = deg(c);
        if (a1 <= a0) a1 += 360;
        return [{ t: 'arc', cx: a[0], cy: a[1], r, a0, a1, ...pen }];
      }
      case 'dim': {
        // From, to, then where the dimension line sits. Two points already
        // draw it against the cursor, so the offset is seen while it is chosen.
        if (!b) return null;
        const run = dimensionShapes(a, b, c ?? b, {
          layer: pen.layer, color: pen.color, width: pen.width,
          textSize, mmPerUnit,
        });
        return run.length ? run : null;
      }
      default:
        return null;
    }
  }, [pen, textSize, mmPerUnit]);

  /** Put the draft on the sheet, if it amounts to anything, and start again. */
  const finishDraft = useCallback((pts: Pt[], tool_: Tool) => {
    const run = shapeOf(tool_, pts);
    if (run && run.length) onDraw(run);
    setDraft(null);
    setPressed(null);
  }, [shapeOf, onDraw]);

  // The editor shares the keyboard with this, so it is told what is open.
  useEffect(() => { onDrafting?.(draft !== null); }, [draft, onDrafting]);

  // Escape drops what is half-drawn, Enter finishes an open polyline, and
  // Backspace takes back the point just put down — the three keys a hand
  // reaches for mid-line without looking away from the drawing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!draft) return;
      if (e.key === 'Escape') { e.preventDefault(); setDraft(null); setPressed(null); }
      if (e.key === 'Enter' && draft.tool === 'polyline') {
        e.preventDefault();
        finishDraft(draft.pts, 'polyline');
      }
      if (e.key === 'Backspace') {
        // One click back. Off the last point there is nothing left to draw
        // from, so the draft goes and the tool waits for a fresh start.
        e.preventDefault();
        const pts = draft.pts.slice(0, -1);
        if (pts.length === 0) { setDraft(null); setPressed(null); }
        else setDraft({ ...draft, pts, cursor: pts[pts.length - 1] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, finishDraft]);

  const panning = tool === 'pan' || space;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Without this the browser starts selecting the text of the panels either
    // side as soon as a rubber band leaves the canvas.
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toDrawing(e.clientX, e.clientY);

    if (panning || e.button === 1) {
      setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, view });
      return;
    }
    if (e.button !== 0) return;

    // Trim, extend and corner act on what they are clicked on.
    if (PICKS.has(tool)) {
      const hit = hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, offLimits);
      if (hit !== null) onPick(hit, [p.x, p.y]);
      return;
    }

    if (DRAWS.has(tool)) {
      const from = draft?.pts[draft.pts.length - 1];
      const { point } = resolve(e.clientX, e.clientY, e.shiftKey, from);

      if (tool === 'text') { onPlaceText({ x: point[0], y: point[1] }); return; }

      const pts = draft && draft.tool === tool ? [...draft.pts, point] : [point];
      const needed = NEEDS[tool];
      if (needed && pts.length >= needed) { finishDraft(pts, tool); return; }
      setDraft({ tool, pts, cursor: point });
      setPressed({ x: e.clientX, y: e.clientY });
      return;
    }

    // A grip is taken before the shape it sits on: it is smaller, it is on
    // top, and it is what the pointer was aiming at.
    const held = gripAt(p.x, p.y);
    if (held && !e.shiftKey) {
      setDrag({ kind: 'grip', index: held.index, grip: held.grip.id, at: held.grip.at });
      return;
    }

    const hit = hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, offLimits);
    if (hit === null) {
      setDrag({ kind: 'band', startX: p.x, startY: p.y, x: p.x, y: p.y, additive: e.shiftKey });
      if (!e.shiftKey) onSelection(new Set());
      return;
    }

    // A symbol from the library is one thing: clicking a line of it takes the
    // whole block, which is what the eye picked and what the hand expects.
    const whole = withWholeBlocks(shapes, [hit]);
    const next = new Set(selection);
    if (e.shiftKey) {
      // Shift over any part of a block adds or drops the block entire.
      if (next.has(hit)) whole.forEach(i => next.delete(i));
      else whole.forEach(i => next.add(i));
      onSelection(next);
      return;
    }
    if (!next.has(hit)) onSelection(whole);
    setDrag({ kind: 'move', startX: p.x, startY: p.y, dx: 0, dy: 0 });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // A drawing tool reads the cursor through the snaps; everything else takes
    // it where it is.
    let p = toDrawing(e.clientX, e.clientY);
    if (DRAWS.has(tool)) {
      const from = draft?.pts[draft.pts.length - 1];
      const { point, onGeometry } = resolve(e.clientX, e.clientY, e.shiftKey, from);
      setSnapped(onGeometry ? point : null);
      p = { x: point[0], y: point[1] };
      if (draft) setDraft({ ...draft, cursor: point });
    }
    setHover(PICKS.has(tool)
      ? hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, offLimits)
      : null);
    onCursor(p);
    setCursorHint(p);
    if (!drag) return;

    if (drag.kind === 'pan') {
      const { scale } = mapping(drag.view);
      onView({
        ...drag.view,
        x: drag.view.x - (e.clientX - drag.startX) / scale,
        y: drag.view.y - (e.clientY - drag.startY) / scale,
      });
      return;
    }
    if (drag.kind === 'move') {
      const snap = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : v);
      setDrag({ ...drag, dx: snap(p.x - drag.startX), dy: snap(p.y - drag.startY) });
      return;
    }
    if (drag.kind === 'grip') {
      // The same rules a new point obeys: it catches the ends and corners of
      // what is already drawn, Shift squares it up against the other end, and
      // failing both it lands on the grid. An end dragged onto another line's
      // end has to land on it exactly, or the DXF gets a gap in it.
      const anchor = otherEndOf(shapes[drag.index], drag.grip);
      const { point, onGeometry } = resolve(e.clientX, e.clientY, e.shiftKey, anchor);
      setSnapped(onGeometry ? point : null);
      setDrag({ ...drag, at: point });
      onCursor({ x: point[0], y: point[1] });
      return;
    }
    setDrag({ ...drag, x: p.x, y: p.y });
  };

  const onPointerUp = (e?: React.PointerEvent<SVGSVGElement>) => {
    // A press and a release far apart is the same gesture as two clicks, for
    // the hand that expects to drag.
    if (DRAWS.has(tool) && draft && pressed && e) {
      const far = Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 6;
      if (far) {
        const from = draft.pts[draft.pts.length - 1];
        const { point } = resolve(e.clientX, e.clientY, e.shiftKey, from);
        const pts = [...draft.pts, point];
        const needed = NEEDS[tool];
        if (needed && pts.length >= needed) { finishDraft(pts, tool); return; }
        setDraft({ ...draft, pts, cursor: point });
      }
      setPressed(null);
      return;
    }
    if (!drag) return;
    if (drag.kind === 'grip') {
      const was = gripsOf(shapes[drag.index] ?? { t: 'line', x1: 0, y1: 0, x2: 0, y2: 0, layer: 'FREE' })
        .find(g => g.id === drag.grip)?.at;
      // A grip put back where it started is not an edit, and should not cost
      // an undo step or mark the sheet changed.
      if (!was || was[0] !== drag.at[0] || was[1] !== drag.at[1]) {
        onGrip(drag.index, drag.grip, drag.at);
      }
      setDrag(null);
      setSnapped(null);
      return;
    }
    if (drag.kind === 'move' && (drag.dx !== 0 || drag.dy !== 0)) onMove(drag.dx, drag.dy);
    if (drag.kind === 'band') {
      const area: Box = {
        x: Math.min(drag.startX, drag.x), y: Math.min(drag.startY, drag.y),
        w: Math.abs(drag.x - drag.startX), h: Math.abs(drag.y - drag.startY),
      };
      if (area.w > 2 && area.h > 2) {
        const found = withWholeBlocks(shapes, shapesInBox(shapes, area, offLimits));
        onSelection(drag.additive ? new Set([...selection, ...found]) : found);
      }
    }
    setDrag(null);
  };

  // Wheel zooms about the cursor, so the thing under the pointer stays put.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const held = toDrawing(e.clientX, e.clientY);
      const factor = Math.exp(e.deltaY * 0.0015);
      const w = Math.min(drawing.width * 8, Math.max(drawing.width / 400, view.w * factor));
      const h = w * (view.h / view.w);
      // Place the new box so the point that was under the cursor still is.
      const m = mapping({ x: 0, y: 0, w, h });
      onView({ x: held.x - (e.clientX - m.ox) / m.scale, y: held.y - (e.clientY - m.oy) / m.scale, w, h });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view, drawing.width, onView, toDrawing, mapping]);

  const moving = drag?.kind === 'move' ? drag : null;
  const band = drag?.kind === 'band' ? drag : null;
  const gripping = drag?.kind === 'grip' ? drag : null;

  /** The shape as it would be if the grip were let go now. */
  const dragged = useMemo(() => {
    if (!gripping) return null;
    const s = shapes[gripping.index];
    return s ? moveGrip(s, gripping.grip, gripping.at) : null;
  }, [gripping, shapes]);

  /**
   * What the drag is doing, in the words EPLAN puts in the same place.
   *
   * A length and an angle while a line is being drawn or dragged; a radius for
   * a circle; the offset for anything else. It follows the cursor, because
   * that is where the eye already is.
   */
  const readout = useMemo<string | null>(() => {
    const say = (v: number) => (v * mmPerUnit).toFixed(2);
    const inHand = dragged ?? (draft ? shapeOf(draft.tool, [...draft.pts, draft.cursor])?.[0] : null);
    if (inHand) {
      if (inHand.t === 'line') {
        const { length, angle } = lineMetrics(inHand);
        return `Length=${say(length)}  Angle=${angle.toFixed(2)}`;
      }
      if (inHand.t === 'circle') return `R=${say(inHand.r)}`;
      if (inHand.t === 'ellipse') return `Rx=${say(inHand.rx)}  Ry=${say(inHand.ry)}`;
      if (inHand.t === 'arc') {
        return `R=${say(inHand.r)}  Sweep=${(inHand.a1 - inHand.a0).toFixed(2)}`;
      }
      if (inHand.t === 'rect') return `${say(inHand.w)} × ${say(inHand.h)}`;
    }
    if (moving && (moving.dx !== 0 || moving.dy !== 0)) {
      return `dX=${say(moving.dx)}  dY=${say(moving.dy)}`;
    }
    return null;
  }, [dragged, draft, shapeOf, moving, mmPerUnit]);

  const selectionBox = useMemo(() => {
    // Hidden while a grip is in hand: the box would be drawn round where the
    // shape was, not where it is going, and two rectangles disagreeing is
    // worse than none.
    if (gripping) return null;
    // And hidden on a single shape that is showing its handles. The handles
    // already say what is picked, and a box drawn tight round a level line is
    // a dashed strip lying on top of the line itself.
    if (selection.size === 1 && grips.length > 0) return null;
    const picked = [...selection].map(i => shapes[i]).filter(Boolean);
    const b = boundsOfAll(picked);
    if (!b) return null;
    return moving ? { ...b, x: b.x + moving.dx, y: b.y + moving.dy } : b;
  }, [selection, shapes, moving, gripping, grips]);

  const stroke = unitsPerPixel();

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className="w-full h-full select-none touch-none"
      style={{
        background: theme.surround,
        cursor: panning ? 'grab'
          : drag?.kind === 'grip' ? 'crosshair'
          : drag?.kind === 'move' ? 'move'
          : DRAWS.has(tool) ? 'crosshair'
          : PICKS.has(tool) ? 'cell'
          : 'default',
      }}
      fontFamily="Segoe UI, Arial, sans-serif"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { onCursor(null); setSnapped(null); setCursorHint(null); setHover(null); }}
      onPointerCancel={() => onPointerUp()}
      onContextMenu={e => {
        // Right-click is Enter, the way it is in every CAD package: it accepts
        // what has been drawn so far. Nothing drawn and it ends the command,
        // which is the other half of the same habit.
        e.preventDefault();
        if (draft) {
          const run = shapeOf(draft.tool, draft.pts);
          if (run && run.length) finishDraft(draft.pts, draft.tool);
          else { setDraft(null); setPressed(null); }
          return;
        }
        onCancelTool?.();
      }}
      onDoubleClick={e => {
        // A double click closes an open polyline, the way every CAD does.
        if (draft?.tool === 'polyline') { finishDraft(draft.pts, 'polyline'); return; }
        const p = toDrawing(e.clientX, e.clientY);
        const hit = hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, offLimits);
        if (hit !== null && shapes[hit].t === 'text') onEditText(hit);
      }}
    >
      <defs>
        <pattern id="sd-grid" width={grid || 10} height={grid || 10} patternUnits="userSpaceOnUse">
          <path d={`M ${grid || 10} 0 L 0 0 0 ${grid || 10}`} fill="none" stroke={theme.grid} strokeWidth={stroke} />
        </pattern>
      </defs>

      {/* The paper, then the grid over it — both behind everything drawn. */}
      <rect x={0} y={0} width={drawing.width} height={drawing.height}
            fill={theme.paper} stroke={theme.edge} strokeWidth={stroke} />
      {showGrid && <rect x={0} y={0} width={drawing.width} height={drawing.height} fill="url(#sd-grid)" />}

      <g pointerEvents="none">
        {shapes.map((s, i) => {
          if (hidden.has(s.layer)) return null;
          const node = shapeToNode(s);
          if (!node) return null;
          const picked = selection.has(i);
          const shift = picked && moving ? `translate(${moving.dx} ${moving.dy})` : undefined;
          const attrs: Record<string, string | number> = { ...node.attrs };
          // Colour 7 behaviour: near-black is shown in the theme's ink, and a
          // layer colour — a blue tag, a red busbar — is left as it is.
          if (typeof attrs.stroke === 'string') attrs.stroke = shownIn(theme, attrs.stroke);
          if (node.tag === 'text' && typeof attrs.fill === 'string') {
            attrs.fill = shownIn(theme, attrs.fill);
          }
          if (picked) {
            attrs.stroke = SELECTED;
            if (node.tag === 'text') attrs.fill = SELECTED;
            else if (attrs.stroke !== undefined && (s.width ?? 1) > 0) {
              attrs['stroke-width'] = Math.max(Number(attrs['stroke-width']) || 1, stroke * 1.6);
            }
          }
          const props: Record<string, unknown> = {
            transform: shift,
            opacity: locked.has(s.layer) ? 0.45 : 1,
          };
          for (const [k, v] of Object.entries(attrs)) props[REACT_PROP[k] ?? k] = v;
          return node.tag === 'text'
            ? <text key={i} {...props}>{node.body}</text>
            : React.createElement(node.tag, { key: i, ...props });
        })}
      </g>

      {/* What is picked, boxed — the CAD convention, drawn over the geometry. */}
      {selectionBox && (
        <rect
          x={selectionBox.x - 3} y={selectionBox.y - 3}
          width={selectionBox.w + 6} height={selectionBox.h + 6}
          fill="none" stroke={SELECTED} strokeWidth={stroke} strokeDasharray={`${stroke * 4} ${stroke * 3}`}
          pointerEvents="none"
        />
      )}

      {/* What is being drawn, before it is on the sheet. The last leg is
          dashed: it follows the cursor and is not committed to. */}
      {draft && (() => {
        const pts = [...draft.pts, draft.cursor];
        const preview = shapeOf(draft.tool, pts) ?? [];
        return (
          <g pointerEvents="none">
            {preview.map((shape, k) => {
              const node = shapeToNode(shape);
              if (!node) return null;
              const props: Record<string, unknown> = { pointerEvents: 'none' };
              for (const [attr, v] of Object.entries(node.attrs)) props[REACT_PROP[attr] ?? attr] = v;
              props.stroke = SELECTED;
              props.strokeWidth = Math.max(Number(node.attrs['stroke-width']) || 1, stroke);
              // A filled arrowhead keeps its fill; everything else is an
              // outline until it is committed to.
              if (node.tag === 'text') props.fill = SELECTED;
              else if (!shape.fill || shape.fill === 'none') props.fill = 'none';
              else props.fill = SELECTED;
              return node.tag === 'text'
                ? <text key={k} {...props}>{node.body}</text>
                : React.createElement(node.tag, { key: k, ...props });
            })}
            {/* The legs already fixed, so a polyline shows what it has. */}
            {draft.pts.map((q, i) => (
              <rect key={`p${i}`} x={q[0] - stroke * 3} y={q[1] - stroke * 3}
                    width={stroke * 6} height={stroke * 6}
                    fill={theme.paper} stroke={SELECTED} strokeWidth={stroke} />
            ))}
          </g>
        );
      })()}

      {/* What trim or corner is about to take hold of. */}
      {hover !== null && shapes[hover] && (() => {
        const node = shapeToNode(shapes[hover]);
        if (!node) return null;
        const props: Record<string, unknown> = { pointerEvents: 'none' };
        for (const [attr, v] of Object.entries(node.attrs)) props[REACT_PROP[attr] ?? attr] = v;
        props.stroke = theme.accent;
        props.strokeWidth = Math.max(Number(node.attrs['stroke-width']) || 1, stroke * 2.5);
        props.fill = 'none';
        props.opacity = 0.9;
        return node.tag === 'text'
          ? <text {...props} fill={theme.accent}>{node.body}</text>
          : React.createElement(node.tag, props);
      })()}

      {/* The shape as the grip is dragging it, over the one still on the
          sheet — so the old position is visible to judge the new one by. */}
      {dragged && (() => {
        const node = shapeToNode(dragged);
        if (!node) return null;
        const props: Record<string, unknown> = { pointerEvents: 'none' };
        for (const [attr, v] of Object.entries(node.attrs)) props[REACT_PROP[attr] ?? attr] = v;
        props.stroke = SELECTED;
        props.strokeWidth = Math.max(Number(node.attrs['stroke-width']) || 1, stroke * 1.6);
        if (node.tag === 'text') props.fill = SELECTED;
        else if (!dragged.fill || dragged.fill === 'none') props.fill = 'none';
        return node.tag === 'text'
          ? <text {...props}>{node.body}</text>
          : React.createElement(node.tag, props);
      })()}

      {/* The handles themselves. A square for a point that moves on its own, a
          diamond for one that moves the whole shape — the difference a hand
          needs to know before it presses, not after. */}
      {grips.length > 0 && !gripping && (
        <g pointerEvents="none">
          {grips.map(({ index, grip }, k) => {
            // About ten screen pixels across at any zoom — the size a pointer
            // can land on without aiming, and what every CAD package uses.
            const r = stroke * 5;
            const [x, y] = grip.at;
            const fill = grip.kind === 'whole' ? theme.paper : SELECTED;
            // Named on the element, so a handle can be reached by which point
            // of which shape it is rather than by where it happens to land.
            const id = `${index}.${grip.id}`;
            return grip.kind === 'whole'
              ? <polygon key={`${id}.${k}`} data-grip={id} data-grip-kind={grip.kind}
                         points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
                         fill={fill} stroke={SELECTED} strokeWidth={stroke} />
              : <rect key={`${id}.${k}`} data-grip={id} data-grip-kind={grip.kind}
                      x={x - r} y={y - r} width={r * 2} height={r * 2}
                      fill={fill} stroke={theme.paper} strokeWidth={stroke * 0.8} />;
          })}
        </g>
      )}

      {/* The cursor has caught the end or corner of something already drawn. */}
      {snapped && (
        <g pointerEvents="none">
          <rect x={snapped[0] - stroke * 5} y={snapped[1] - stroke * 5}
                width={stroke * 10} height={stroke * 10}
                fill="none" stroke={theme.accent} strokeWidth={stroke * 1.5} />
        </g>
      )}

      {/* Where a label would sit, and how tall it would be. */}
      {tool === 'text' && draft === null && cursorHint && (
        <g pointerEvents="none">
          <line x1={cursorHint.x} y1={cursorHint.y} x2={cursorHint.x} y2={cursorHint.y - textSize}
                stroke={SELECTED} strokeWidth={stroke} />
          <line x1={cursorHint.x - textSize * 0.25} y1={cursorHint.y}
                x2={cursorHint.x + textSize * 0.25} y2={cursorHint.y}
                stroke={SELECTED} strokeWidth={stroke} />
        </g>
      )}

      {/* Length and angle while something is in hand. Placed to the lower
          right of the cursor and sized in screen pixels, so it stays legible
          at every zoom instead of growing with the drawing. */}
      {readout && cursorHint && (() => {
        const pad = stroke * 5;
        const size = stroke * 12;
        const w = readout.length * size * 0.55 + pad * 2;
        const x = cursorHint.x + stroke * 14;
        const y = cursorHint.y + stroke * 14;
        return (
          <g pointerEvents="none">
            <rect x={x} y={y} width={w} height={size + pad * 2}
                  fill={theme.id === 'dark' ? '#1f2937' : '#fffbeb'}
                  stroke={theme.edge} strokeWidth={stroke} />
            <text x={x + pad} y={y + pad + size * 0.8} fontSize={size} fill={theme.ink}>
              {readout}
            </text>
          </g>
        );
      })()}

      {band && Math.abs(band.x - band.startX) > 1 && (
        <rect
          x={Math.min(band.startX, band.x)} y={Math.min(band.startY, band.y)}
          width={Math.abs(band.x - band.startX)} height={Math.abs(band.y - band.startY)}
          fill="rgba(37,99,235,0.08)" stroke={SELECTED} strokeWidth={stroke}
          strokeDasharray={`${stroke * 3} ${stroke * 2}`} pointerEvents="none"
        />
      )}
    </svg>
  );
};

/**
 * The whole sheet, with a margin round it.
 *
 * No aspect ratio to match: the element letterboxes the box for us, and the
 * mapping above accounts for the bars, so a plain rectangle is right whatever
 * shape the panel happens to be.
 */
export function fitView(drawing: Drawing, pad = 0.04): Viewport {
  const mx = drawing.width * pad, my = drawing.height * pad;
  return { x: -mx, y: -my, w: drawing.width + mx * 2, h: drawing.height + my * 2 };
}

/** The viewport centred on a selection, for "zoom to selection". */
export function viewOn(box: Box, margin = 40): Viewport {
  return { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 };
}

export { boundsOf };
