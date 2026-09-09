import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawing, Layer, Shape } from '../../utils/cad/shapes';
import { shapeToNode } from '../../utils/cad/svg';
import { Box, boundsOf, boundsOfAll, hitTest, shapesInBox } from '../../utils/cad/edit';

// The drawing surface: pan, zoom, pick, drag.
//
// Hit testing is done against the geometry rather than by hanging a handler on
// every element — a sheet is several hundred shapes, and a 1.3-unit line is not
// something a pointer can land on by accident. `distanceTo` in cad/edit.ts
// gives each shape a real distance from the cursor, so a thin line is as easy
// to pick as a filled box, and the shape drawn last wins a tie, which is the
// one the eye sees on top.

export interface Viewport { x: number; y: number; w: number; h: number }

interface Props {
  drawing: Drawing;
  shapes: Shape[];
  selection: ReadonlySet<number>;
  hidden: ReadonlySet<Layer>;
  locked: ReadonlySet<Layer>;
  view: Viewport;
  grid: number;
  showGrid: boolean;
  tool: 'select' | 'pan';
  onView: (v: Viewport) => void;
  onSelection: (next: Set<number>) => void;
  /** A drag that has finished: commit it, once, so undo gets one step. */
  onMove: (dx: number, dy: number) => void;
  onCursor: (p: { x: number; y: number } | null) => void;
  onEditText: (index: number) => void;
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: Viewport }
  | { kind: 'move'; startX: number; startY: number; dx: number; dy: number }
  | { kind: 'band'; startX: number; startY: number; x: number; y: number; additive: boolean }
  | null;

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
  onView, onSelection, onMove, onCursor, onEditText,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [space, setSpace] = useState(false);

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
    const p = toDrawing(e.clientX, e.clientY);
    onCursor(p);
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

  const onPointerUp = () => {
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
      style={{ background: '#fff', cursor: panning ? 'grab' : drag?.kind === 'move' ? 'move' : 'crosshair' }}
      fontFamily="Segoe UI, Arial, sans-serif"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => onCursor(null)}
      onPointerCancel={onPointerUp}
      onDoubleClick={e => {
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
