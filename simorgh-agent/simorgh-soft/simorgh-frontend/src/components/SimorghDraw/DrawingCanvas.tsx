import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawing, Layer, Pen, Pt, Shape } from '../../utils/cad/shapes';
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

/** What the pointer does. The first two pick and shift the drawing; the rest add to it. */
export type Tool = 'select' | 'pan' | 'line' | 'polyline' | 'rect' | 'circle' | 'arc' | 'text';

/** Tools that put something new on the sheet. */
export const DRAWS: ReadonlySet<Tool> = new Set<Tool>(['line', 'polyline', 'rect', 'circle', 'arc', 'text']);

/** How many points a tool needs before it has drawn something. */
const NEEDS: Partial<Record<Tool, number>> = { line: 2, rect: 2, circle: 2, arc: 3 };

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
  onView: (v: Viewport) => void;
  onSelection: (next: Set<number>) => void;
  /** A drag that has finished: commit it, once, so undo gets one step. */
  onMove: (dx: number, dy: number) => void;
  onCursor: (p: { x: number; y: number } | null) => void;
  onEditText: (index: number) => void;
  /** A finished shape, ready to go on the sheet. */
  onDraw: (shape: Shape) => void;
  /** The text tool has a place and needs the words. */
  onPlaceText: (at: { x: number; y: number }) => void;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: Viewport }
  | { kind: 'move'; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'band'; startX: number; startY: number; x: number; y: number; additive: boolean }
  | null;

/** A shape being drawn: the points given so far, and where the cursor is. */
interface Draft { tool: Tool; pts: Pt[]; cursor: Pt }

const SELECTED = '#2563eb';

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
  pen, textSize, objectSnap,
  onView, onSelection, onMove, onCursor, onEditText, onDraw, onPlaceText,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [space, setSpace] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapped, setSnapped] = useState<Pt | null>(null);
  const [pressed, setPressed] = useState<{ x: number; y: number } | null>(null);
  const [cursorHint, setCursorHint] = useState<{ x: number; y: number } | null>(null);

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

  /** A draft with enough points, as the shape it stands for. */
  const shapeOf = useCallback((tool_: Tool, pts: Pt[]): Shape | null => {
    const [a, b, c] = pts;
    switch (tool_) {
      case 'line':
        if (!b || (a[0] === b[0] && a[1] === b[1])) return null;
        return { t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...pen };
      case 'polyline':
        if (pts.length < 2) return null;
        return { t: 'poly', pts: [...pts], ...pen };
      case 'rect': {
        if (!b) return null;
        const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        if (w < 0.5 || h < 0.5) return null;
        return { t: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h, ...pen };
      }
      case 'circle': {
        if (!b) return null;
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (r < 0.5) return null;
        return { t: 'circle', cx: a[0], cy: a[1], r, ...pen };
      }
      case 'arc': {
        // Centre, then where it starts, then how far it sweeps.
        if (!b || !c) return null;
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (r < 0.5) return null;
        const deg = (p: Pt) => (Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI;
        let a0 = deg(b), a1 = deg(c);
        if (a1 <= a0) a1 += 360;
        return { t: 'arc', cx: a[0], cy: a[1], r, a0, a1, ...pen };
      }
      default:
        return null;
    }
  }, [pen]);

  /** Put the draft on the sheet, if it amounts to anything, and start again. */
  const finishDraft = useCallback((pts: Pt[], tool_: Tool) => {
    const shape = shapeOf(tool_, pts);
    if (shape) onDraw(shape);
    setDraft(null);
    setPressed(null);
  }, [shapeOf, onDraw]);

  // Escape drops what is half-drawn; Enter finishes an open polyline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(null); setPressed(null); }
      if (e.key === 'Enter' && draft?.tool === 'polyline') {
        e.preventDefault();
        finishDraft(draft.pts, 'polyline');
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

    const hit = hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, new Set([...hidden, ...locked]));
    if (hit === null) {
      setDrag({ kind: 'band', startX: p.x, startY: p.y, x: p.x, y: p.y, additive: e.shiftKey });
      if (!e.shiftKey) onSelection(new Set());
      return;
    }

    const next = new Set(selection);
    if (e.shiftKey) {
      if (next.has(hit)) next.delete(hit); else next.add(hit);
      onSelection(next);
      return;
    }
    if (!next.has(hit)) onSelection(new Set([hit]));
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
    if (drag.kind === 'move' && (drag.dx !== 0 || drag.dy !== 0)) onMove(drag.dx, drag.dy);
    if (drag.kind === 'band') {
      const area: Box = {
        x: Math.min(drag.startX, drag.x), y: Math.min(drag.startY, drag.y),
        w: Math.abs(drag.x - drag.startX), h: Math.abs(drag.y - drag.startY),
      };
      if (area.w > 2 && area.h > 2) {
        const found = shapesInBox(shapes, area, new Set([...hidden, ...locked]));
        onSelection(drag.additive ? new Set([...selection, ...found]) : new Set(found));
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

  const selectionBox = useMemo(() => {
    const picked = [...selection].map(i => shapes[i]).filter(Boolean);
    const b = boundsOfAll(picked);
    if (!b) return null;
    return moving ? { ...b, x: b.x + moving.dx, y: b.y + moving.dy } : b;
  }, [selection, shapes, moving]);

  const stroke = unitsPerPixel();

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className="w-full h-full select-none touch-none"
      style={{
        background: '#fff',
        cursor: panning ? 'grab'
          : drag?.kind === 'move' ? 'move'
          : DRAWS.has(tool) ? 'crosshair'
          : 'default',
      }}
      fontFamily="Segoe UI, Arial, sans-serif"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { onCursor(null); setSnapped(null); setCursorHint(null); }}
      onPointerCancel={() => onPointerUp()}
      onDoubleClick={e => {
        // A double click closes an open polyline, the way every CAD does.
        if (draft?.tool === 'polyline') { finishDraft(draft.pts, 'polyline'); return; }
        const p = toDrawing(e.clientX, e.clientY);
        const hit = hitTest(shapes, p.x, p.y, unitsPerPixel() * 6, new Set([...hidden, ...locked]));
        if (hit !== null && shapes[hit].t === 'text') onEditText(hit);
      }}
    >
      <defs>
        <pattern id="sd-grid" width={grid || 10} height={grid || 10} patternUnits="userSpaceOnUse">
          <path d={`M ${grid || 10} 0 L 0 0 0 ${grid || 10}`} fill="none" stroke="#e5e7eb" strokeWidth={stroke} />
        </pattern>
      </defs>

      {/* The paper, then the grid over it — both behind everything drawn. */}
      <rect x={0} y={0} width={drawing.width} height={drawing.height} fill="#fff" stroke="#cbd5e1" strokeWidth={stroke} />
      {showGrid && <rect x={0} y={0} width={drawing.width} height={drawing.height} fill="url(#sd-grid)" />}

      <g pointerEvents="none">
        {shapes.map((s, i) => {
          if (hidden.has(s.layer)) return null;
          const node = shapeToNode(s);
          if (!node) return null;
          const picked = selection.has(i);
          const shift = picked && moving ? `translate(${moving.dx} ${moving.dy})` : undefined;
          const attrs: Record<string, string | number> = { ...node.attrs };
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
        const preview = shapeOf(draft.tool, pts);
        const node = preview ? shapeToNode(preview) : null;
        const props: Record<string, unknown> = { pointerEvents: 'none' };
        if (node) {
          for (const [k, v] of Object.entries(node.attrs)) props[REACT_PROP[k] ?? k] = v;
          props.stroke = SELECTED;
          props.strokeWidth = Math.max(Number(node.attrs['stroke-width']) || 1, stroke);
          props.fill = 'none';
        }
        return (
          <g pointerEvents="none">
            {node && React.createElement(node.tag, props)}
            {/* The legs already fixed, so a polyline shows what it has. */}
            {draft.pts.map((q, i) => (
              <rect key={i} x={q[0] - stroke * 3} y={q[1] - stroke * 3}
                    width={stroke * 6} height={stroke * 6}
                    fill="#fff" stroke={SELECTED} strokeWidth={stroke} />
            ))}
          </g>
        );
      })()}

      {/* The cursor has caught the end or corner of something already drawn. */}
      {snapped && (
        <g pointerEvents="none">
          <rect x={snapped[0] - stroke * 5} y={snapped[1] - stroke * 5}
                width={stroke * 10} height={stroke * 10}
                fill="none" stroke="#f59e0b" strokeWidth={stroke * 1.5} />
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
