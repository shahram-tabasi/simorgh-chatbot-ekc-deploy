import * as XLSX from 'xlsx-js-style';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tableShapes, replaceTable, tableOrigin, tableIdOf } from '../../utils/cad/table';
import { checkSheet, Message } from '../../utils/cad/schematic';
import { numberWires, autoTagDevices, crossReferences } from '../../utils/cad/annotate';
import {
  ZoomInIcon, ZoomOutIcon, MaximizeIcon, MousePointer2Icon, HandIcon,
  UndoIcon, RedoIcon, CopyIcon, Trash2Icon, GridIcon, RotateCcwIcon,
  EyeIcon, EyeOffIcon, LockIcon, UnlockIcon, DownloadIcon, ScanSearchIcon,
  SaveIcon, TriangleAlertIcon, MinusIcon, WaypointsIcon, SquareIcon, CircleIcon,
  SplineIcon, TypeIcon, Maximize2Icon, Minimize2Icon, MagnetIcon,
  CircleDashedIcon, RulerIcon, ScissorsIcon, ArrowRightToLineIcon,
  CornerDownRightIcon, RotateCwIcon, FlipHorizontalIcon, FlipVerticalIcon,
  ScalingIcon, BringToFrontIcon, SendToBackIcon, TableIcon, RefreshCwIcon,
  HashIcon, TagIcon, ShieldCheckIcon, XIcon, LinkIcon, SparklesIcon,
  AlignStartVerticalIcon, AlignEndVerticalIcon, AlignCenterVerticalIcon,
  AlignStartHorizontalIcon, AlignEndHorizontalIcon, AlignCenterHorizontalIcon,
  AlignHorizontalDistributeCenterIcon, AlignVerticalDistributeCenterIcon,
  LanguagesIcon, CircleHelpIcon, LibraryBigIcon, GroupIcon, UngroupIcon,
  SunIcon, MoonIcon, CableIcon } from 'lucide-react';
import { DrawingEdits } from '../../types/project';
import {
  Drawing, LAYERS, Layer, LAYER_NOTES, Pen, Pt, Shape, layerColor,
} from '../../utils/cad/shapes';
import { renderSvg } from '../../utils/cad/svg';
import { renderDxf } from '../../utils/cad/dxf';
import { LEGIBLE_MM, PaperChoice, textHeightOn } from '../../utils/cad/paper';
import { renderPdf } from '../../utils/cad/pdf';
import {
  History, StylePatch, boundsOfAll, deleteShapes, duplicateShapes, moveShapes,
  restyleShapes, setText, withShapes,
} from '../../utils/cad/edit';
import {
  AlignTo, EditResult, alignShapes, centreOf, cornerLines, distributeShapes,
  blocksOf, extendLine, groupShapes, lineFrom, lineMetrics, mirrorX, mirrorY,
  moveGrip, norm360, placeAsBlock, reorderShapes, rotation, scaling,
  transformShapes, trimLine, ungroupShapes,
} from '../../utils/cad/geom';
import { downloadBlob, downloadText, fileSafe } from '../../utils/download';
import { Lang, LANGS, STRINGS, Strings, dirOf, loadLang, saveLang } from './lang';
import { DrawingHelp } from './DrawingHelp';
import { SymbolLibrary } from './SymbolLibrary';
import { ThemeId, loadTheme, saveTheme } from './theme';
import { DRAWS, DrawingCanvas, PICKS, Tool, Viewport, fitView, viewOn } from './DrawingCanvas';

// Simorgh Draw — the drawing, open for editing.
//
// The sheet arrives as geometry (see cad/shapes.ts), so editing it is editing
// an array of shapes: move, delete, duplicate, retype a label, switch a layer
// off. Every export then goes through the same array, which means what leaves
// as DXF or PDF is what is on the screen, edits and all — the thing that was
// impossible while the sheet was a string of SVG.

export interface EditorSheet {
  name: string;
  drawing: Drawing;
  /** Where this sheet's edits are kept in the project. */
  key: string;
  /** Fingerprint of the sheet as drawn, so a stale edit can be spotted. */
  drawnAs: string;
}

interface Props {
  sheets: EditorSheet[];
  /** Stem for downloaded file names. */
  fileBase: string;
  /** Lines for the title block on exported sheets. */
  titleBlock: string[];
  mmPerUnit?: number;
  /** The sheet exports are put on; 'auto' keeps `mmPerUnit` and grows the sheet. */
  paper?: PaperChoice;
  /** Edits already kept with the project. */
  savedEdits?: DrawingEdits;
  /** Hand the edits back to the project. Absent means they cannot be kept. */
  onSaveEdits?: (next: DrawingEdits) => void;
  /** False on a revision that is view-only. */
  canEdit?: boolean;
}

const SNAPS = [0, 1, 5, 10, 25];

/** What a new line is drawn with, in the words a drawing office uses. */
const LINE_TYPES: { id: string; name: 'solid' | 'dashed' | 'dashDot' | 'dotted'; dash?: string }[] = [
  { id: 'solid', name: 'solid' },
  { id: 'dashed', name: 'dashed', dash: '6 4' },
  { id: 'dash-dot', name: 'dashDot', dash: '10 3 2 3' },
  { id: 'dotted', name: 'dotted', dash: '1.5 3' },
];

const WIDTHS = [0.5, 0.8, 1, 1.3, 1.8, 2.5, 4, 6];
const TEXT_SIZES = [6, 8, 9, 10, 12, 14, 18, 24];

/**
 * The tools, in the order a hand reaches for them.
 *
 * Each names the phrase that describes it rather than carrying one, so the bar
 * reads in whichever of the three languages is chosen without the table having
 * to know about any of them. The letters are the same in every language — they
 * are where the finger goes, not a word.
 */
type ToolName = Extract<keyof Strings, Tool>;
const TOOLS: { id: Tool; name: ToolName; key: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'select', name: 'select', key: 'V', Icon: MousePointer2Icon },
  { id: 'pan', name: 'pan', key: 'H', Icon: HandIcon },
  { id: 'line', name: 'line', key: 'L', Icon: MinusIcon },
  { id: 'polyline', name: 'polyline', key: 'P', Icon: WaypointsIcon },
  { id: 'connect', name: 'connect', key: 'N', Icon: CableIcon },
  { id: 'rect', name: 'rect', key: 'R', Icon: SquareIcon },
  { id: 'circle', name: 'circle', key: 'C', Icon: CircleIcon },
  { id: 'ellipse', name: 'ellipse', key: 'E', Icon: CircleDashedIcon },
  { id: 'arc', name: 'arc', key: 'A', Icon: SplineIcon },
  { id: 'text', name: 'text', key: 'T', Icon: TypeIcon },
  { id: 'dim', name: 'dim', key: 'D', Icon: RulerIcon },
  { id: 'trim', name: 'trim', key: 'X', Icon: ScissorsIcon },
  { id: 'extend', name: 'extend', key: 'W', Icon: ArrowRightToLineIcon },
  { id: 'corner', name: 'corner', key: 'K', Icon: CornerDownRightIcon },
];

/** Lining up, in the order the buttons sit on the bar. */
const ALIGNS: { to: AlignTo; name: keyof Strings; Icon: React.FC<{ className?: string }> }[] = [
  { to: 'left', name: 'alignLeft', Icon: AlignStartVerticalIcon },
  { to: 'centre-x', name: 'centreX', Icon: AlignCenterVerticalIcon },
  { to: 'right', name: 'alignRight', Icon: AlignEndVerticalIcon },
  { to: 'top', name: 'alignTop', Icon: AlignStartHorizontalIcon },
  { to: 'centre-y', name: 'centreY', Icon: AlignCenterHorizontalIcon },
  { to: 'bottom', name: 'alignBottom', Icon: AlignEndHorizontalIcon },
];

export const DrawingEditor: React.FC<Props> = ({
  sheets, fileBase, titleBlock, mmPerUnit = 0.5, paper: initialPaper = 'auto',
  savedEdits, onSaveEdits, canEdit = true,
}) => {
  const [index, setIndex] = useState(0);
  const sheet = sheets[Math.min(index, Math.max(0, sheets.length - 1))];

  // Edits live per sheet, so paging through a set does not lose them.
  const [edits, setEdits] = useState<Record<number, Shape[]>>({});
  // Which sheets this session has actually changed. A boolean would do for the
  // Save button, but not for what Save writes: re-stamping a sheet nobody
  // touched would quietly clear its "edited against an older drawing" warning
  // without anyone having looked at it.
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const dirty = touched.size > 0;
  const touch = (i: number) => setTouched(prev => new Set(prev).add(i));

  // Read at the moment a set of sheets is seeded rather than followed, so
  // keeping edits does not immediately re-seed the canvas from its own output.
  const saved = useRef(savedEdits);
  saved.current = savedEdits;

  useEffect(() => {
    const seeded: Record<number, Shape[]> = {};
    sheets.forEach((sheet, i) => {
      const kept = saved.current?.[sheet.key];
      if (kept?.shapes) seeded[i] = kept.shapes;
    });
    setEdits(seeded);
    setTouched(new Set());
    histories.current.clear();
  }, [sheets]);

  /** Sheets whose edits were made against a drawing that has since changed. */
  const stale = useMemo(
    () => sheets.filter(sheet => {
      const kept = saved.current?.[sheet.key];
      return kept && kept.drawnAs !== sheet.drawnAs;
    }).map(sheet => sheet.name),
    [sheets, savedEdits]);
  const histories = useRef(new Map<number, History<Shape[]>>());
  const historyFor = (i: number) => {
    if (!histories.current.has(i)) histories.current.set(i, new History<Shape[]>());
    return histories.current.get(i)!;
  };

  const shapes = edits[index] ?? sheet?.drawing.shapes ?? [];
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState<Set<Layer>>(new Set());
  const [locked, setLocked] = useState<Set<Layer>>(new Set());
  const [tool, setTool] = useState<Tool>('select');
  // How new geometry is drawn. A drawing office thinks in layer, weight and
  // line type, so that is what the bar offers.
  const [drawLayer, setDrawLayer] = useState<Layer>('SYMBOL');
  const [drawWidth, setDrawWidth] = useState(1);
  const [drawLine, setDrawLine] = useState('solid');
  const [textSize, setTextSize] = useState(9);
  const [objectSnap, setObjectSnap] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // Which language the person at the keyboard reads. Theirs, not the
  // project's, so it is remembered in the browser.
  const [lang, setLang] = useState<Lang>(loadLang);
  const T = STRINGS[lang];
  const dir = dirOf(lang);
  const [showHelp, setShowHelp] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  // Light or dark, remembered on this machine. A viewing preference only: every
  // export comes out of the same geometry in the same colours either way.
  const [themeId, setThemeId] = useState<ThemeId>(loadTheme);
  const chooseTheme = (next: ThemeId) => { setThemeId(next); saveTheme(next); };
  // The corner command takes two lines, so the first one waits here.
  const [pendingCorner, setPendingCorner] = useState<{ index: number; at: Pt } | null>(null);
  const [cornerRadius, setCornerRadius] = useState(0);
  // What a command has to say when it could not do what was asked. Cleared on
  // the next thing that happens, so it never sits there stale.
  const [notice, setNotice] = useState<string | null>(null);

  // Whether the canvas has something half-drawn. The two share a keyboard.
  const [drafting, setDrafting] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState(5);
  const [showGrid, setShowGrid] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [paper, setPaper] = useState<PaperChoice>(initialPaper);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, w: 1000, h: 600 });
  const [, forceRender] = useState(0);

  const chooseLang = (next: Lang) => { setLang(next); saveLang(next); };

  // Leaving a command tool puts down whatever it was holding.
  useEffect(() => {
    if (tool !== 'corner') setPendingCorner(null);
    setNotice(null);
  }, [tool]);

  /** Replace the shapes, recording the step that got us here. */
  const commit = useCallback((next: Shape[], nextSelection?: Set<number>) => {
    historyFor(index).push(shapes);
    setEdits(e => ({ ...e, [index]: next }));
    if (nextSelection) setSelection(nextSelection);
    touch(index);
    forceRender(n => n + 1);
  }, [index, shapes]);

  // ── Imported spreadsheets ────────────────────────────────────────────────
  //
  // One entry per table on the current sheet. The handle is what makes Update
  // possible: with it the same file can be read again after someone has edited
  // it in Excel, without them having to find it a second time. Browsers that
  // do not offer the File System Access API simply get no Update button rather
  // than a button that cannot work.
  const [tables, setTables] = useState<Record<string, {
    id: string; name: string; handle?: FileSystemFileHandle; at: Pt; readAt: Date;
  }>>({});
  const xlsxInput = useRef<HTMLInputElement>(null);
  // Set just before falling back to the plain file input, so its change
  // handler knows which table is being placed and where.
  const pendingImport = useRef<{ id: string; at: Pt } | null>(null);

  /** Rows out of a spreadsheet, as plain strings. */
  const readRows = (file: File): Promise<string[][]> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('unreadable'));
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target?.result as ArrayBuffer), { type: 'array' });
          const sheetOne = wb.Sheets[wb.SheetNames[0]];
          // header:1 keeps it a grid: a drawing wants the rows as they are,
          // not keyed by a header row it has no use for.
          resolve((XLSX.utils.sheet_to_json(sheetOne, {
            header: 1, defval: '', raw: false, blankrows: false,
          }) as unknown[][]).map(r => (r ?? []).map(c => String(c ?? ''))));
        } catch (err) { reject(err as Error); }
      };
      reader.readAsArrayBuffer(file);
    });

  /** Draw a file's rows as a table, at `at`, under `id`. */
  const placeTable = useCallback(async (
    file: File, id: string, at: Pt, handle?: FileSystemFileHandle, replacing = false,
  ) => {
    let rows: string[][];
    try { rows = await readRows(file); }
    catch { setNotice(T.xlsxUnreadable); return; }
    if (rows.length === 0) { setNotice(T.xlsxEmpty); return; }

    const next = tableShapes(rows, at, { textSize, width: drawWidth, header: true }, id);
    if (next.length === 0) { setNotice(T.xlsxEmpty); return; }
    commit(replacing ? replaceTable(shapes, id, next) : [...shapes, ...next]);
    setTables(t => ({ ...t, [id]: { id, name: file.name, handle, at, readAt: new Date() } }));
    setNotice(null);
  }, [shapes, commit, textSize, drawWidth, T]);

  /** Import: pick a spreadsheet and put it on the sheet. */
  const importXlsx = useCallback(async () => {
    const id = `t${Date.now().toString(36)}`;
    // Top-left of what is on screen, inset a little, so it lands where the
    // person is looking rather than at the sheet origin they may be nowhere near.
    const at: Pt = [view.x + view.w * 0.08, view.y + view.h * 0.08];
    const picker = (window as unknown as {
      showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    if (picker) {
      try {
        const [handle] = await picker({
          multiple: false,
          types: [{ description: 'Excel or CSV', accept: {
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            'application/vnd.ms-excel': ['.xls'],
            'text/csv': ['.csv'],
          } }],
        });
        if (!handle) return;
        await placeTable(await handle.getFile(), id, at, handle);
        return;
      } catch (err) {
        // The picker being closed is not an error, and not a reason to open a
        // second one behind it.
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    pendingImport.current = { id, at };
    xlsxInput.current?.click();
  }, [view, placeTable]);


  /** Update: read the same file again, and redraw that table where it sits. */
  const updateXlsx = useCallback(async (id: string) => {
    const entry = tables[id];
    if (!entry?.handle) return;
    try {
      const file = await entry.handle.getFile();
      // Where it is now, not where it was first dropped — it may well have
      // been moved since, and Update should not move it back.
      await placeTable(file, id, tableOrigin(shapes, id) ?? entry.at, entry.handle, true);
    } catch {
      setNotice(T.xlsxGone);
    }
  }, [tables, shapes, placeTable, T]);

  // A table deleted from the sheet should stop offering an Update button.
  const liveTables = useMemo(
    () => Object.values(tables).filter(t => shapes.some(s => tableIdOf(s) === t.id)),
    [tables, shapes]);

  // ── Checks, numbering and designations ───────────────────────────────────
  //
  // The panel follows EPLAN's message management, because that is the shape
  // the office already knows: a run of checks leaves a list you work through,
  // not a popup you dismiss. Clicking a message selects what it is about and
  // takes the view there, which is the whole reason to have the list rather
  // than a count.
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [showChecks, setShowChecks] = useState(false);

  const runChecks = useCallback(() => {
    setMessages(checkSheet(shapes));
    setShowChecks(true);
  }, [shapes]);

  // Re-run on every edit once the panel is open, so the list is never stale
  // enough to send someone to a wire they have already fixed.
  useEffect(() => {
    if (showChecks) setMessages(checkSheet(shapes));
  }, [shapes, showChecks]);

  /** Select what a message is about, and look at it. */
  const goToMessage = useCallback((m: Message) => {
    const valid = m.shapes.filter(i => i >= 0 && i < shapes.length);
    if (valid.length === 0) return;
    setSelection(new Set(valid));
    if (m.at) {
      setView(v => ({ ...v, x: m.at![0] - v.w / 2, y: m.at![1] - v.h / 2 }));
    }
  }, [shapes]);

  const doNumberWires = useCallback((overwrite: boolean) => {
    const r = numberWires(shapes, { textSize, overwrite });
    if (r.numbered === 0) { setNotice(overwrite ? T.wireNoneFound : T.wireAllNumbered); return; }
    commit(r.shapes);
    setNotice(T.wireNumbered.replace('{n}', String(r.numbered)));
  }, [shapes, textSize, commit, T]);

  const doTagDevices = useCallback(() => {
    const r = autoTagDevices(shapes, { textSize });
    if (r.tagged === 0) { setNotice(T.tagAllTagged); return; }
    commit(r.shapes);
    setNotice(T.tagged.replace('{n}', String(r.tagged)));
  }, [shapes, textSize, commit, T]);

  /** Devices that appear on more than one sheet — a coil and its contacts. */
  const xrefs = useMemo(
    () => crossReferences(sheets.map((sh, i) => ({
      name: sh.name,
      shapes: edits[i] ?? sh.drawing.shapes,
    }))),
    [sheets, edits]);

  /**
   * Full screen, and a way back.
   *
   * The browser's own full screen is asked for first — it gives the whole
   * display, which is what a drawing wants. Where it is refused (an iframe
   * without the permission, a browser that will not) the panel still fills the
   * window, so the button always does something.
   */
  const toggleFullscreen = useCallback(() => {
    const el = frame.current;
    if (!fullscreen) {
      setFullscreen(true);
      el?.requestFullscreen?.().catch(() => { /* the window will have to do */ });
    } else {
      setFullscreen(false);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    }
  }, [fullscreen]);

  // Esc leaves the browser's full screen without telling React, so follow it.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const pen: Pen = useMemo(() => ({
    layer: drawLayer,
    // The layer's own colour, so what is drawn on TAG looks like the tags
    // already on the sheet. CAD takes the colour from the layer regardless.
    color: layerColor(drawLayer),
    width: drawWidth,
    dash: LINE_TYPES.find(l => l.id === drawLine)?.dash,
  }), [drawLayer, drawWidth, drawLine]);

  /**
   * A finished piece of work goes on the sheet and is the thing now picked.
   *
   * A run rather than one shape, because one gesture is not always one shape:
   * a dimension is six, and they belong together in one undo step.
   */
  const draw = useCallback((run: Shape[]) => {
    if (run.length === 0) return;
    historyFor(index).push(shapes);
    const next = [...shapes, ...run];
    setEdits(e => ({ ...e, [index]: next }));
    setSelection(new Set(run.map((_, k) => shapes.length + k)));
    touch(index);
    forceRender(n => n + 1);
  }, [index, shapes]);

  // ── Drawing by description ───────────────────────────────────────────────
  //
  // The local model writes shapes; the backend validates every one of them
  // before any reaches here. What comes back goes on through draw(), so it is
  // one undo step and can be thrown away like anything else drawn by hand —
  // which is the point. It is a first draft to correct, not an answer.
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [asking, setAsking] = useState(false);

  const askToDraw = useCallback(async () => {
    const prompt = askText.trim();
    if (prompt.length < 3 || !sheet) return;
    setAsking(true);
    setNotice(null);
    try {
      const response = await fetch(`${(import.meta as { env?: Record<string, string> }).env?.VITE_API_URL || ''}/api/draw/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          width: sheet.drawing.width,
          height: sheet.drawing.height,
          textSize,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) {
        setNotice(body.error || T.askFailed);
        return;
      }
      draw(body.shapes as Shape[]);
      setAskOpen(false);
      setAskText('');
      // How much was thrown away matters as much as what arrived: a draft
      // that lost half its shapes is one to look over rather than build on.
      setNotice(body.droppedCount
        ? T.askDrewSome.replace('{n}', String(body.shapes.length)).replace('{d}', String(body.droppedCount))
        : T.askDrew.replace('{n}', String(body.shapes.length)));
    } catch (err) {
      setNotice(`${T.askFailed} ${(err as Error).message}`);
    } finally {
      setAsking(false);
    }
  }, [askText, sheet, textSize, draw, T]);


  /** The text tool has a place; the words come from here. */
  const placeText = useCallback((at: { x: number; y: number }) => {
    const value = window.prompt(T.promptText);
    if (value == null || value.trim() === '') return;
    draw([{
      t: 'text', x: at.x, y: at.y, s: value, size: textSize,
      layer: drawLayer, color: layerColor(drawLayer), width: 0,
    }]);
  }, [draw, textSize, drawLayer, T]);

  /** Change how the picked shapes are drawn, without redrawing them. */
  const restyle = (patch: StylePatch) => {
    if (selection.size === 0) return;
    commit(restyleShapes(shapes, selection, patch));
  };

  // ── The commands that change what is already there ──────────────────────

  /** Put a command's result on the sheet, or say why it could not go. */
  const applyResult = (r: EditResult) => {
    if (!r.ok) {
      setNotice(r.why === 'parallel' ? T.areParallel
        : r.why === 'no-crossing' ? T.noCrossing
        : T.needALine);
      return;
    }
    setNotice(null);
    commit(r.shapes, new Set(r.selection ?? []));
  };

  /**
   * Trim, extend and corner, on the shape that was clicked.
   *
   * Corner is the one that needs two: the first click is remembered and the
   * status bar asks for the second, which is how EPLAN asks for it too.
   */
  const command = (i: number, at: Pt) => {
    const off = new Set([...hidden, ...locked]);
    if (tool === 'trim') { applyResult(trimLine(shapes, i, at, off)); return; }
    if (tool === 'extend') { applyResult(extendLine(shapes, i, at, off)); return; }
    if (tool !== 'corner') return;
    if (!pendingCorner || pendingCorner.index === i) {
      if (shapes[i]?.t !== 'line') { setNotice(T.needALine); return; }
      setPendingCorner({ index: i, at });
      setNotice(null);
      setSelection(new Set([i]));
      return;
    }
    applyResult(cornerLines(shapes, pendingCorner.index, i, pendingCorner.at, at, cornerRadius));
    setPendingCorner(null);
  };

  /** Turn, mirror or scale what is picked, about the middle of it. */
  const transform = (make: (cx: number, cy: number) => Parameters<typeof transformShapes>[2]) => {
    if (selection.size === 0) return;
    const c = centreOf(shapes, selection);
    if (!c) return;
    commit(transformShapes(shapes, selection, make(c[0], c[1])));
  };

  const rotateBy = (deg: number) => transform((cx, cy) => rotation(cx, cy, deg));

  const rotateFree = () => {
    const answer = window.prompt(T.promptRotate, '90');
    const deg = Number(answer);
    if (answer == null || !Number.isFinite(deg) || deg === 0) return;
    // A drawing office says a turn anticlockwise; sheet space counts the other
    // way, so what is typed is negated to mean what it looks like.
    rotateBy(-deg);
  };

  const scaleFree = () => {
    const answer = window.prompt(T.promptScale, '2');
    const k = Number(answer);
    if (answer == null || !Number.isFinite(k) || k <= 0 || k === 1) return;
    transform((cx, cy) => scaling(cx, cy, k));
  };

  /** A grip let go: the shape at `i` has one of its points somewhere new. */
  const grip = (i: number, id: string, to: Pt) => {
    const s = shapes[i];
    if (!s) return;
    commit(shapes.map((x, k) => (k === i ? moveGrip(x, id, to) : x)), new Set([i]));
  };

  /** One picked shape, replaced by a version of itself. */
  const reshape = (next: Shape) => {
    const i = [...selection][0];
    if (i === undefined || !shapes[i]) return;
    commit(shapes.map((s, k) => (k === i ? next : s)), new Set([i]));
  };

  // ── Blocks ───────────────────────────────────────────────────────────────

  /** The picked shapes made into one block. */
  const group = () => {
    if (selection.size < 2) { setNotice(T.needTwoToGroup); return; }
    const r = groupShapes(shapes, selection, 'GROUP');
    setNotice(null);
    commit(r.shapes, new Set(r.selection));
  };

  /** Whatever blocks the picked shapes belong to, taken apart. */
  const ungroup = () => {
    if (selection.size === 0) return;
    const r = ungroupShapes(shapes, selection);
    if (r.shapes === shapes) { setNotice(T.nothingToUngroup); return; }
    setNotice(null);
    commit(r.shapes, new Set(r.selection));
  };

  /**
   * A symbol from the library, placed as one block in the middle of the view.
   *
   * The middle rather than the origin: the sheet is bigger than the window, and
   * something dropped at 0,0 on an A0 lands somewhere nobody is looking.
   */
  const importSymbol = (run: Shape[], name: string) => {
    if (run.length === 0) return;
    const at: Pt = [view.x + view.w / 2, view.y + view.h / 2];
    const placed = placeAsBlock(run, at, name);
    setShowLibrary(false);
    setNotice(T.libPlaced(name));
    historyFor(index).push(shapes);
    const next = [...shapes, ...placed];
    setEdits(e => ({ ...e, [index]: next }));
    setSelection(new Set(placed.map((_, k) => shapes.length + k)));
    touch(index);
    forceRender(n => n + 1);
  };

  const align = (to: AlignTo) => {
    if (selection.size < 2) return;
    commit(alignShapes(shapes, selection, to));
  };
  const spread = (axis: 'x' | 'y') => {
    if (selection.size < 3) return;
    commit(distributeShapes(shapes, selection, axis));
  };
  const reorder = (to: 'front' | 'back') => {
    if (selection.size === 0) return;
    const r = reorderShapes(shapes, selection, to);
    commit(r.shapes, new Set(r.selection));
  };

  const fit = useCallback(() => {
    if (sheet) setView(fitView(sheet.drawing));
  }, [sheet]);

  // A new sheet starts fitted, with nothing picked.
  useEffect(() => { setSelection(new Set()); fit(); }, [index, sheets, fit]);

  const undo = () => {
    const h = historyFor(index);
    const previous = h.undo(shapes);
    if (previous) { setEdits(e => ({ ...e, [index]: previous })); setSelection(new Set()); touch(index); forceRender(n => n + 1); }
  };
  const redo = () => {
    const h = historyFor(index);
    const next = h.redo(shapes);
    if (next) { setEdits(e => ({ ...e, [index]: next })); setSelection(new Set()); touch(index); forceRender(n => n + 1); }
  };

  const remove = () => {
    if (selection.size === 0) return;
    commit(deleteShapes(shapes, selection), new Set());
  };
  const duplicate = () => {
    if (selection.size === 0) return;
    const { shapes: next, selection: picked } = duplicateShapes(shapes, selection);
    commit(next, new Set(picked));
  };
  const nudge = (dx: number, dy: number) => {
    if (selection.size === 0) return;
    commit(moveShapes(shapes, selection, dx, dy));
  };
  const revert = () => {
    historyFor(index).clear();
    setEdits(e => { const next = { ...e }; delete next[index]; return next; });
    setSelection(new Set());
    touch(index);
    forceRender(n => n + 1);
  };

  /** Hand every sheet's edits to the project, and drop the ones undone away. */
  const keep = () => {
    if (!onSaveEdits) return;
    const next: DrawingEdits = { ...(saved.current ?? {}) };
    const now = new Date().toISOString();
    sheets.forEach((sheet, i) => {
      // A sheet nobody touched keeps the entry it already had, fingerprint and
      // all — saving one sheet must not vouch for another.
      if (!touched.has(i)) return;
      const current = edits[i];
      // Undone all the way back is not an edit; it is the sheet as drawn.
      if (!current || current === sheet.drawing.shapes) delete next[sheet.key];
      else next[sheet.key] = { shapes: current, drawnAs: sheet.drawnAs, editedAt: now };
    });
    onSaveEdits(next);
    setTouched(new Set());
  };

  /** Put every sheet back to as drawn, in the project as well as on screen. */
  const discardAll = () => {
    if (!onSaveEdits) return;
    const next: DrawingEdits = { ...(saved.current ?? {}) };
    for (const sheet of sheets) delete next[sheet.key];
    onSaveEdits(next);
    setEdits({});
    setSelection(new Set());
    histories.current.clear();
    setTouched(new Set());
    forceRender(n => n + 1);
  };

  const zoom = (factor: number) => setView(v => {
    const w = Math.min((sheet?.drawing.width ?? 1000) * 8, Math.max((sheet?.drawing.width ?? 1000) / 400, v.w * factor));
    const h = w * (v.h / v.w);
    return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h };
  });

  const zoomToSelection = () => {
    const box = boundsOfAll([...selection].map(i => shapes[i]).filter(Boolean));
    if (box) setView(viewOn(box));
  };

  // Keyboard, as a drawing office expects it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const step = e.shiftKey ? 10 : snap || 1;
      // Escape and Backspace belong to whatever is half-drawn: Escape drops it,
      // Backspace takes a point back. The canvas answers for both while a
      // draft is open, so this stays out of the way rather than depending on
      // which of the two listeners the browser happens to reach first.
      if (drafting && (e.key === 'Escape' || e.key === 'Backspace')) return;
      switch (e.key) {
        case 'Delete': case 'Backspace': e.preventDefault(); remove(); break;
        case 'F1': e.preventDefault(); setShowHelp(h => !h); break;
        case 'Escape':
          // Back out one step at a time — a help panel, then a half-made
          // corner, then the selection, then the tool, then full screen. The
          // browser takes Escape itself when the window really is full screen;
          // this answers for the window-filling fallback, where nothing else
          // would.
          if (showHelp) setShowHelp(false);
          else if (pendingCorner) setPendingCorner(null);
          else if (selection.size > 0) setSelection(new Set());
          else if (DRAWS.has(tool) || PICKS.has(tool)) setTool('select');
          else if (fullscreen && !document.fullscreenElement) setFullscreen(false);
          break;
        case 'ArrowLeft':  e.preventDefault(); nudge(-step, 0); break;
        case 'ArrowRight': e.preventDefault(); nudge(step, 0); break;
        case 'ArrowUp':    e.preventDefault(); nudge(0, -step); break;
        case 'ArrowDown':  e.preventDefault(); nudge(0, step); break;
        case 'f': case 'F': fit(); break;
        default: {
          // A bare letter picks a tool. With a modifier it is a command, so
          // Ctrl+A stays select-all rather than becoming the arc tool.
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          const wanted = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase());
          if (wanted) { e.preventDefault(); setTool(wanted.id); }
          break;
        }
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
          break;
        case 'y': case 'Y':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); }
          break;
        case 'd': case 'D':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); duplicate(); }
          break;
        case 'g': case 'G':
          // The pair every drawing package binds to this key.
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.shiftKey ? ungroup() : group();
          }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setSelection(new Set(shapes.map((s, i) => (hidden.has(s.layer) || locked.has(s.layer) ? -1 : i))
              .filter(i => i >= 0)));
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Exports ───────────────────────────────────────────────────────────────
  // Every sheet goes out with its own edits applied, not just the one on show.
  const editedDrawing = (i: number) => {
    const s = sheets[i];
    const current = edits[i];
    return current ? withShapes(s.drawing, current) : s.drawing;
  };

  const exportDxf = () => {
    const drawing = editedDrawing(index);
    downloadText(`${fileSafe(fileBase)}_${fileSafe(sheet.name)}.dxf`,
      renderDxf(drawing, { mmPerUnit, paper, titleBlock: [...titleBlock, sheet.name] }), 'image/vnd.dxf');
  };
  const exportPdf = () => {
    downloadBlob(`${fileSafe(fileBase)}.pdf`,
      renderPdf(sheets.map((_, i) => editedDrawing(i)), { mmPerUnit, paper, titleBlock }));
  };
  const exportSvg = () => {
    downloadText(`${fileSafe(fileBase)}_${fileSafe(sheet.name)}.svg`,
      renderSvg(editedDrawing(index), { hidden }), 'image/svg+xml');
  };

  // ── Layers ────────────────────────────────────────────────────────────────
  const layers = useMemo(() => {
    const counts = new Map<Layer, number>();
    for (const s of shapes) counts.set(s.layer, (counts.get(s.layer) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [shapes]);

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    apply(next);
  };

  // What the smallest label on this sheet comes out as, on the chosen paper.
  const smallest = useMemo(() => {
    const sizes = shapes.filter(s => s.t === 'text').map(s => (s as { size: number }).size);
    if (!sheet || sizes.length === 0) return null;
    return textHeightOn(sheet.drawing.width, sheet.drawing.height, paper, mmPerUnit, Math.min(...sizes));
  }, [shapes, sheet, paper, mmPerUnit]);

  const picked = [...selection].map(i => shapes[i]).filter(Boolean);
  /** Which blocks the picked shapes belong to, for the panel and the status bar. */
  const pickedBlocks = blocksOf(picked);
  const onlyText = picked.length === 1 && picked[0].t === 'text'
    ? (picked[0] as Extract<Shape, { t: 'text' }>) : null;
  const anySaved = sheets.some(sheet => Boolean(savedEdits?.[sheet.key]));
  const history = historyFor(index);
  // Undoing all the way back leaves the original array in place, not none of
  // it, so "edited" is a question of identity rather than of presence.
  const isEdited = (i: number) => {
    const current = edits[i];
    return Boolean(current) && current !== sheets[i]?.drawing.shapes;
  };
  const edited = isEdited(index);
  const sheetBlocks = useMemo(() => blocksOf(shapes).length, [shapes]);
  const mm = (v: number) => (v * mmPerUnit).toFixed(1);

  /** What to do next, for the tool that is in hand. */
  const hint =
    tool === 'text' ? T.hintText
    : tool === 'polyline' ? T.hintPolyline
    : tool === 'dim' ? T.hintDim
    : tool === 'trim' ? T.hintTrim
    : tool === 'extend' ? T.hintExtend
    : tool === 'corner' ? (pendingCorner ? T.hintCornerSecond : T.hintCornerFirst)
    : DRAWS.has(tool) ? T.hintTwoClicks
    // Something picked and the pick tool in hand: the handles are on show, so
    // say what they do rather than repeating the general shortcuts.
    : selection.size > 0 && selection.size <= 12 ? T.dragGrips
    : T.hintIdle;

  if (!sheet) {
    return <p className="p-6 text-sm text-gray-500" dir={dir}>{T.nothingToDraw}</p>;
  }

  /**
   * A toolbar button, and the tooltip that explains it.
   *
   * Office, AutoCAD and EPLAN all do the same thing here and for the same
   * reason: a row of thirty pictures is unreadable until each one says what it
   * is. So the tooltip is two parts — the command's **name**, then a line on
   * what it actually does, and the shortcut where there is one.
   *
   * It is drawn rather than left to the browser's `title`, because a native
   * tooltip cannot show two lines and takes a second to appear, which is a
   * second too long when the question is "which of these is trim".
   */
  const Tool: React.FC<{
    on?: () => void; active?: boolean; disabled?: boolean; title: string;
    /** The letter that does the same thing, shown on its own line. */
    keyHint?: string;
    // The tool's own name on the button, so the drawing tools can be reached
    // by what they are rather than by where they sit on the bar.
    tag?: string; children: React.ReactNode;
  }> = ({ on, active, disabled, title, keyHint, tag, children }) => {
    // The phrases are written as "Name — what it does"; the dash is the split.
    const [name, ...rest] = title.split(' — ');
    const detail = rest.join(' — ');
    return (
      <span className="relative group/tip inline-flex">
        <button
          onClick={on} disabled={disabled} data-tool={tag}
          // Kept for the browser, and for anything reading the page aloud.
          title={title}
          aria-label={title}
          className={`p-1.5 rounded-md border text-sm transition-colors disabled:opacity-30 disabled:cursor-default ${
            active ? 'bg-slate-700 border-slate-700 text-white'
                   : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}
        >
          {children}
        </button>
        {!disabled && (
          <span
            role="tooltip"
            data-tip={tag ?? name}
            className="pointer-events-none absolute top-full start-0 mt-1.5 z-[120] hidden group-hover/tip:block w-max max-w-[280px] rounded-md bg-slate-800 text-white shadow-lg px-2.5 py-1.5"
          >
            <span className="block text-[12px] font-semibold leading-tight">
              {name}
              {keyHint && (
                <kbd className="ms-1.5 px-1 py-px rounded bg-white/20 text-[10px] font-mono">
                  {keyHint}
                </kbd>
              )}
            </span>
            {detail && (
              <span className="block text-[11px] text-slate-300 leading-snug mt-0.5">{detail}</span>
            )}
          </span>
        )}
      </span>
    );
  };

  const Divider = () => <span className="w-px h-6 bg-gray-300 mx-1" />;

  return (
    <div
      ref={frame}
      data-sd-theme={themeId}
      className={`border border-gray-200 rounded-lg overflow-hidden bg-white select-none ${
        fullscreen ? 'fixed inset-0 z-[300] rounded-none flex flex-col' : ''}`}
    >
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 bg-gray-50 border-b">
        {sheets.length > 1 && (
          <>
            <select
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
              value={index}
              onChange={e => setIndex(Number(e.target.value))}
            >
              {sheets.map((s, i) => (
                <option key={i} value={i}>{s.name}{isEdited(i) ? ' •' : ''}</option>
              ))}
            </select>
            <Divider />
          </>
        )}

        {TOOLS.map(t => (
          <Tool key={t.id} tag={t.id} title={T[t.name]} keyHint={t.key} active={tool === t.id} on={() => setTool(t.id)}>
            <t.Icon className="w-4 h-4" />
          </Tool>
        ))}
        {/* The corner command needs a radius before it needs a second line. */}
        {tool === 'corner' && (
          <label className="flex items-center gap-1 text-[11px] text-gray-600" title={T.promptRadius}>
            {T.cornerRadius}
            <input
              type="number" min={0} step={1} value={cornerRadius}
              onChange={e => setCornerRadius(Math.max(0, Number(e.target.value) || 0))}
              className="w-14 border border-gray-300 rounded px-1.5 py-1 text-sm"
            />
          </label>
        )}
        <Divider />

        <Tool title={T.zoomIn} on={() => zoom(1 / 1.3)}><ZoomInIcon className="w-4 h-4" /></Tool>
        <Tool title={T.zoomOut} on={() => zoom(1.3)}><ZoomOutIcon className="w-4 h-4" /></Tool>
        <Tool title={T.fit} on={fit}><MaximizeIcon className="w-4 h-4" /></Tool>
        <Tool title={T.zoomSel} disabled={selection.size === 0} on={zoomToSelection}>
          <ScanSearchIcon className="w-4 h-4" />
        </Tool>
        <Divider />

        <Tool title={T.undo} disabled={!history.canUndo} on={undo}><UndoIcon className="w-4 h-4" /></Tool>
        <Tool title={T.redo} disabled={!history.canRedo} on={redo}><RedoIcon className="w-4 h-4" /></Tool>
        <Tool title={T.duplicate} disabled={selection.size === 0} on={duplicate}>
          <CopyIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.del} disabled={selection.size === 0} on={remove}>
          <Trash2Icon className="w-4 h-4" />
        </Tool>
        <Tool title={T.revert} disabled={!edited} on={revert}>
          <RotateCcwIcon className="w-4 h-4" />
        </Tool>
        <Divider />

        <Tool
          title={
            !onSaveEdits ? T.cannotKeep
            : !canEdit ? T.readOnly
            : dirty ? T.save
            : T.savedAlready
          }
          disabled={!onSaveEdits || !canEdit || !dirty}
          on={keep}
        >
          <SaveIcon className="w-4 h-4" />
        </Tool>
        {onSaveEdits && canEdit && (anySaved || dirty) && (
          <button
            onClick={discardAll}
            className="px-2 py-1.5 rounded-md border border-gray-300 bg-white text-xs text-gray-600 hover:bg-gray-100"
            title={T.discardAllTip}
          >
            {T.discardAll}
          </button>
        )}
        <Divider />

        <Tool title={T.grid} active={showGrid} on={() => setShowGrid(g => !g)}>
          <GridIcon className="w-4 h-4" />
        </Tool>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={snap}
          onChange={e => setSnap(Number(e.target.value))}
          title={T.snapTo}
        >
          {SNAPS.map(v => <option key={v} value={v}>{v === 0 ? T.noSnap : `${v}`}</option>)}
        </select>
        <Tool
          title={objectSnap ? T.osnapOn : T.osnapOff}
          active={objectSnap}
          on={() => setObjectSnap(v => !v)}
        >
          <MagnetIcon className="w-4 h-4" />
        </Tool>

        {/* Turning, mirroring, lining up — the commands that change what is
            already there rather than adding to it. All of them work on
            whatever is picked, so all of them are dark until something is. */}
        <Divider />
        <Tool title={T.rotateCCW} disabled={selection.size === 0} on={() => rotateBy(-90)}>
          <RotateCcwIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.rotateCW} disabled={selection.size === 0} on={() => rotateBy(90)}>
          <RotateCwIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.rotateFree} disabled={selection.size === 0} on={rotateFree}>
          <span className="text-[11px] font-semibold leading-none px-0.5">∠</span>
        </Tool>
        <Tool title={T.mirrorH} disabled={selection.size === 0}
              on={() => transform(cx => mirrorX(cx))}>
          <FlipHorizontalIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.mirrorV} disabled={selection.size === 0}
              on={() => transform((_, cy) => mirrorY(cy))}>
          <FlipVerticalIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.scale} disabled={selection.size === 0} on={scaleFree}>
          <ScalingIcon className="w-4 h-4" />
        </Tool>
        {ALIGNS.map(a => (
          <Tool key={a.to} title={T[a.name] as string} disabled={selection.size < 2} on={() => align(a.to)}>
            <a.Icon className="w-4 h-4" />
          </Tool>
        ))}
        <Tool title={T.spreadX} disabled={selection.size < 3} on={() => spread('x')}>
          <AlignHorizontalDistributeCenterIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.spreadY} disabled={selection.size < 3} on={() => spread('y')}>
          <AlignVerticalDistributeCenterIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.toFront} disabled={selection.size === 0} on={() => reorder('front')}>
          <BringToFrontIcon className="w-4 h-4" />
        </Tool>
        <Tool title={T.toBack} disabled={selection.size === 0} on={() => reorder('back')}>
          <SendToBackIcon className="w-4 h-4" />
        </Tool>

        {/* A symbol is one thing, so it comes in as one and can be made into
            one. The library sits next to the commands that act on blocks. */}
        <Divider />
        <Tool tag="library" title={T.openLibrary} on={() => setShowLibrary(true)}>
          <LibraryBigIcon className="w-4 h-4" />
        </Tool>
        <Tool tag="group" title={T.group} keyHint="Ctrl+G" disabled={selection.size < 2} on={group}>
          <GroupIcon className="w-4 h-4" />
        </Tool>
        <Tool tag="ungroup" title={T.ungroup} keyHint="Ctrl+Shift+G"
              disabled={selection.size === 0} on={ungroup}>
          <UngroupIcon className="w-4 h-4" />
        </Tool>

        {/* How the next line is drawn, and how the picked ones are. Changing
            it with something selected restyles that, which is the shortest
            path from "that should be dashed" to it being dashed. */}
        <Divider />
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={drawLayer}
          onChange={e => { setDrawLayer(e.target.value as Layer); restyle({ layer: e.target.value as Layer }); }}
          title={T.layerOf}
        >
          {(Object.keys(LAYERS) as Layer[]).map(l => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={drawWidth}
          onChange={e => { setDrawWidth(Number(e.target.value)); restyle({ width: Number(e.target.value) }); }}
          title={T.widthOf}
        >
          {WIDTHS.map(w => <option key={w} value={w}>{w.toFixed(1)}</option>)}
        </select>
        <select
          className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
          value={drawLine}
          onChange={e => {
            setDrawLine(e.target.value);
            restyle({ dash: LINE_TYPES.find(l => l.id === e.target.value)?.dash ?? '' });
          }}
          title={T.lineTypeOf}
        >
          {LINE_TYPES.map(l => <option key={l.id} value={l.id}>{T[l.name]}</option>)}
        </select>
        {(tool === 'text' || tool === 'dim' || picked.some(p => p.t === 'text')) && (
          <select
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
            value={textSize}
            onChange={e => { setTextSize(Number(e.target.value)); restyle({ size: Number(e.target.value) }); }}
            title={T.textHeightOf}
          >
            {TEXT_SIZES.map(v => <option key={v} value={v}>{v} u</option>)}
          </select>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Which language the editor speaks. Three buttons rather than a
              dropdown: it is the kind of choice that should be one click, and
              a reader looking for their own script finds it by its shape. */}
          <div className="flex items-center rounded-md border border-gray-300 overflow-hidden" title={T.help}>
            <LanguagesIcon className="w-3.5 h-3.5 mx-1.5 text-gray-400 shrink-0" />
            {LANGS.map(l => (
              <button
                key={l.id}
                onClick={() => chooseLang(l.id)}
                data-lang={l.id}
                className={`px-2 py-1.5 text-[11px] font-semibold border-l border-gray-300 ${
                  lang === l.id ? 'bg-slate-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          {/* Light or dark. A sheet is looked at for hours; every CAD package
              on a draughtsman's desk offers this and for the same reason. */}
          <Tool
            tag="theme"
            title={themeId === 'dark' ? T.themeLight : T.themeDark}
            on={() => chooseTheme(themeId === 'dark' ? 'light' : 'dark')}
          >
            {themeId === 'dark' ? <SunIcon className="w-4 h-4" /> : <MoonIcon className="w-4 h-4" />}
          </Tool>
          <Tool tag="help" title={T.help} active={showHelp} on={() => setShowHelp(h => !h)}>
            <CircleHelpIcon className="w-4 h-4" />
          </Tool>
          <Tool
            title={fullscreen ? T.leaveFullscreen : T.fullscreen}
            on={toggleFullscreen}
          >
            {fullscreen ? <Minimize2Icon className="w-4 h-4" /> : <Maximize2Icon className="w-4 h-4" />}
          </Tool>
          <select
            className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
            value={paper}
            onChange={e => setPaper(e.target.value as PaperChoice)}
            title={T.paperOf}
          >
            <option value="auto">{T.fitDrawing}</option>
            {(['A4', 'A3', 'A2', 'A1', 'A0'] as const).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {smallest != null && (
            <span
              className={`text-[11px] tabular-nums ${
                smallest < LEGIBLE_MM ? 'text-amber-700 font-medium' : 'text-gray-500'}`}
              title={smallest < LEGIBLE_MM
                ? `The smallest label plots at ${smallest.toFixed(2)} mm, under the ${LEGIBLE_MM} mm a drawing stays readable at. Fewer feeders to a sheet, or a bigger sheet.`
                : `The smallest label plots at ${smallest.toFixed(2)} mm.`}
            >
              text {smallest.toFixed(1)} mm
            </span>
          )}
          <button
            onClick={exportDxf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-teal-700 text-white text-sm font-medium hover:bg-teal-800"
          >
            <DownloadIcon className="w-4 h-4" /> DXF
          </button>
          <button
            onClick={exportPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-700 text-white text-sm font-medium hover:bg-rose-800"
            title="Vector PDF, one page per sheet. Latin text only — use Print / PDF for Persian."
          >
            <DownloadIcon className="w-4 h-4" /> PDF
          </button>
          <button
            onClick={exportSvg}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
          >
            <DownloadIcon className="w-4 h-4" /> SVG
          </button>
          <button
            onClick={() => setAskOpen(o => !o)}
            title={T.askTip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-700 text-white text-sm font-medium hover:bg-violet-800"
          >
            <SparklesIcon className="w-4 h-4" /> {T.ask}
          </button>
          <button
            onClick={() => doNumberWires(false)}
            title={T.wireNumberTip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
          >
            <HashIcon className="w-4 h-4" /> {T.wireNumber}
          </button>
          <button
            onClick={doTagDevices}
            title={T.tagDevicesTip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
          >
            <TagIcon className="w-4 h-4" /> {T.tagDevices}
          </button>
          <button
            onClick={runChecks}
            title={T.checksTip}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${
              messages && messages.some(m => m.cls === 'error')
                ? 'bg-red-700 text-white hover:bg-red-800'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <ShieldCheckIcon className="w-4 h-4" /> {T.checks}
            {messages && messages.length > 0 && ` (${messages.length})`}
          </button>
          <button
            onClick={importXlsx}
            title={T.xlsxImportTip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
          >
            <TableIcon className="w-4 h-4" /> {T.xlsxImport}
          </button>
          {/* One Update per imported table, named after its file: with several
              on a sheet, "Update" on its own would not say which. Only shown
              where the browser handed back a handle — without one the file
              cannot be re-read and the button would be a lie. */}
          {liveTables.filter(t => t.handle).map(t => (
            <button
              key={t.id}
              onClick={() => updateXlsx(t.id)}
              title={`${T.xlsxUpdateTip} — ${t.name}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800"
            >
              <RefreshCwIcon className="w-4 h-4" />
              {T.xlsxUpdate}: {t.name.length > 18 ? `${t.name.slice(0, 16)}…` : t.name}
            </button>
          ))}
          <input
            ref={xlsxInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              // Cleared so choosing the same file twice still fires onChange.
              e.target.value = '';
              const pending = pendingImport.current;
              pendingImport.current = null;
              if (file && pending) placeTable(file, pending.id, pending.at);
            }}
          />
        </div>
      </div>

      {/* ── Canvas and panels ──────────────────────────────────────────── */}
      <div className={fullscreen ? 'flex flex-1 min-h-0' : 'flex'} style={fullscreen ? undefined : { height: 620 }}>
        <div className="flex-1 min-w-0 bg-slate-100 relative">
          <DrawingCanvas
            drawing={sheet.drawing}
            shapes={shapes}
            selection={selection}
            hidden={hidden}
            locked={locked}
            view={view}
            grid={snap}
            showGrid={showGrid}
            tool={tool}
            pen={pen}
            textSize={textSize}
            objectSnap={objectSnap}
            mmPerUnit={mmPerUnit}
            theme={themeId}
            onView={setView}
            onSelection={setSelection}
            onMove={(dx, dy) => nudge(dx, dy)}
            onCursor={setCursor}
            onDraw={draw}
            onPlaceText={placeText}
            onPick={command}
            onGrip={grip}
            onDrafting={setDrafting}
            onCancelTool={() => { setPendingCorner(null); setTool('select'); }}
            onEditText={i => {
              const current = shapes[i];
              if (current.t !== 'text') return;
              const value = window.prompt(T.promptText, current.s);
              if (value !== null && value !== current.s) commit(setText(shapes, i, value));
            }}
          />
          {showHelp && (
            <DrawingHelp lang={lang} t={T} onClose={() => setShowHelp(false)} />
          )}
          {askOpen && (
            <div className="absolute top-2 left-2 z-30 w-[24rem] rounded-lg border border-violet-300 bg-white shadow-xl">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
                <p className="text-sm font-semibold text-gray-800">
                  <SparklesIcon className="w-4 h-4 inline mr-1 text-violet-600" />{T.ask}
                </p>
                <button className="p-1 rounded hover:bg-gray-100" onClick={() => setAskOpen(false)}>
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
              <div className="p-3">
                <textarea
                  value={askText}
                  onChange={e => setAskText(e.target.value)}
                  rows={3}
                  placeholder={T.askPlaceholder}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-violet-400"
                />
                <p className="text-[11px] text-gray-500 mt-1.5">{T.askNote}</p>
                <div className="flex justify-end mt-2">
                  <button
                    onClick={askToDraw}
                    disabled={asking || askText.trim().length < 3}
                    className="px-3 py-1.5 rounded bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
                  >
                    {asking ? T.askWorking : T.askGo}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showChecks && (
            <div className="absolute top-2 right-2 z-30 w-[22rem] max-h-[70%] flex flex-col rounded-lg border border-gray-300 bg-white shadow-xl">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
                <div>
                  <p className="text-sm font-semibold text-gray-800">{T.checks}</p>
                  <p className="text-[11px] text-gray-500">
                    {messages?.length
                      ? `${messages.filter(m => m.cls === 'error').length} · ${messages.filter(m => m.cls === 'warning').length} · ${messages.filter(m => m.cls === 'note').length}`
                      : T.checksClean}
                  </p>
                </div>
                <button className="p-1 rounded hover:bg-gray-100" onClick={() => setShowChecks(false)}>
                  <XIcon className="w-4 h-4" />
                </button>
              </div>

              <div className="overflow-y-auto">
                {messages?.length === 0 && (
                  <p className="px-3 py-4 text-xs text-gray-500">{T.checksClean}</p>
                )}
                {messages?.map((m, k) => (
                  <button
                    key={`${m.code}-${k}`}
                    onClick={() => goToMessage(m)}
                    className="w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-gray-50"
                  >
                    <span className="flex items-start gap-2">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                        m.cls === 'error' ? 'bg-red-600'
                        : m.cls === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                      }`} />
                      <span className="min-w-0">
                        <span className="block text-xs text-gray-800">{m.text}</span>
                        <span className="block text-[10px] text-gray-400 mt-0.5">
                          {m.category} · {m.code}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}

                {/* Across sheets a repeated designation is not a fault — it is
                    how a coil finds its contacts — so it is listed apart from
                    the messages rather than among them. */}
                {xrefs.length > 0 && (
                  <div className="border-t border-gray-200">
                    <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                      <LinkIcon className="w-3 h-3 inline mr-1" />{T.xrefs}
                    </p>
                    {xrefs.map(x => (
                      <p key={x.tag} className="px-3 py-1.5 text-xs text-gray-700 border-b border-gray-100">
                        <span className="font-mono font-medium">{x.tag}</span>
                        <span className="text-gray-400"> — {T.xrefOn} </span>
                        {x.places.map(p => p.sheet).join(', ')}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {showLibrary && (
            <SymbolLibrary
              t={T}
              lang={lang}
              theme={themeId}
              onImport={importSymbol}
              onClose={() => setShowLibrary(false)}
            />
          )}
        </div>

        <aside className="w-64 shrink-0 border-l bg-white overflow-y-auto" dir={dir}>
          <div className="px-3 py-2 border-b">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{T.layers}</h4>
          </div>
          <ul className="divide-y">
            {layers.map(([layer, count]) => (
              <li key={layer} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: layerColor(layer) }} />
                <span className="flex-1 min-w-0 truncate" title={LAYER_NOTES[layer] ?? layer}>{layer}</span>
                <span className="text-[11px] text-gray-400 tabular-nums">{count}</span>
                <button
                  onClick={() => toggle(hidden, layer, setHidden)}
                  title={hidden.has(layer) ? T.showLayer : T.hideLayer}
                  className="p-0.5 text-gray-500 hover:text-gray-900"
                >
                  {hidden.has(layer) ? <EyeOffIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => toggle(locked, layer, setLocked)}
                  title={locked.has(layer) ? T.unlockLayer : T.lockLayer}
                  className="p-0.5 text-gray-500 hover:text-gray-900"
                >
                  {locked.has(layer) ? <LockIcon className="w-3.5 h-3.5" /> : <UnlockIcon className="w-3.5 h-3.5" />}
                </button>
              </li>
            ))}
          </ul>

          <div className="px-3 py-2 border-y bg-gray-50">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{T.selection}</h4>
          </div>
          <div className="px-3 py-2 text-sm text-gray-700 space-y-2">
            {picked.length === 0 && (
              <p className="text-gray-400 text-[13px] leading-relaxed">{T.nothingPicked}</p>
            )}

            {picked.length === 1 && <Row label={T.typeOf} value={picked[0].t} />}

            {/* The numbers behind the shape, where they can be typed.
                Everything is in millimetres of real size, the same units the
                status bar and the dimension tool use — a drawing office thinks
                in millimetres, not in the sheet's own grid. */}
            {picked.length === 1 && (
              <Geometry
                shape={picked[0]}
                t={T}
                mmPerUnit={mmPerUnit}
                onChange={reshape}
                onFocus={() => historyFor(index).push(shapes)}
              />
            )}
            {picked.length > 1 && <Row label={T.selection} value={T.pickedN(picked.length)} />}

            {/* A block is why several shapes came up from one click, so the
                panel says so rather than leaving it to be worked out. */}
            {pickedBlocks.length > 0 && (
              <>
                <Row
                  label={T.blocksN(pickedBlocks.length)}
                  value={pickedBlocks.map(b => b.name).join(', ')}
                />
                <p className="text-[11px] text-gray-400 leading-relaxed">{T.inBlock}</p>
              </>
            )}

            {/* Everything about how the picked shapes are drawn, changed where
                they were picked. A line whose weight is wrong is clicked and
                put right here, without going back up to the bar and without
                having to know that the bar would have done it too. */}
            {picked.length > 0 && (
              <div className="space-y-2 pt-1">
                <label className="block">
                  <span className="text-[11px] text-gray-500">{T.layerOf}</span>
                  <select
                    data-prop="layer"
                    className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                    value={commonOf(picked, p => p.layer) ?? ''}
                    onChange={e => restyle({ layer: e.target.value as Layer })}
                  >
                    {commonOf(picked, p => p.layer) == null && <option value="">—</option>}
                    {(Object.keys(LAYERS) as Layer[]).map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>

                {/* A label has no line weight to speak of, so it is not asked. */}
                {picked.some(p => p.t !== 'text') && (
                  <>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{T.widthOf}</span>
                      <select
                        data-prop="width"
                        className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={commonOf(picked, p => p.width ?? 1) ?? ''}
                        onChange={e => restyle({ width: Number(e.target.value) })}
                      >
                        {commonOf(picked, p => p.width ?? 1) == null && <option value="">—</option>}
                        {WIDTHS.map(w => <option key={w} value={w}>{w.toFixed(1)}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{T.lineTypeOf}</span>
                      <select
                        data-prop="dash"
                        className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                        value={commonOf(picked, p => lineTypeIdOf(p.dash)) ?? ''}
                        onChange={e => restyle({
                          dash: LINE_TYPES.find(l => l.id === e.target.value)?.dash ?? '',
                        })}
                      >
                        {commonOf(picked, p => lineTypeIdOf(p.dash)) == null && <option value="">—</option>}
                        {LINE_TYPES.map(l => <option key={l.id} value={l.id}>{T[l.name]}</option>)}
                      </select>
                    </label>
                  </>
                )}

                {picked.some(p => p.t === 'text') && (
                  <label className="block">
                    <span className="text-[11px] text-gray-500">{T.textHeightOf}</span>
                    <select
                      data-prop="size"
                      className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                      value={commonOf(picked.filter(p => p.t === 'text'), p => (p as { size: number }).size) ?? ''}
                      onChange={e => restyle({ size: Number(e.target.value) })}
                    >
                      {commonOf(picked.filter(p => p.t === 'text'),
                                p => (p as { size: number }).size) == null && <option value="">—</option>}
                      {TEXT_SIZES.map(v => <option key={v} value={v}>{v} u</option>)}
                    </select>
                  </label>
                )}

                {onlyText ? (
                  <label className="block">
                    <span className="text-[11px] text-gray-500">{T.textOf}</span>
                    <input
                      data-prop="text"
                      className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm"
                      value={onlyText.s}
                      onChange={e => {
                        const value = e.target.value;
                        // Typed a character at a time, so the history step is
                        // taken once on focus rather than per keystroke — but
                        // the project still has to know it is behind.
                        setEdits(prev => ({ ...prev, [index]: setText(shapes, [...selection][0], value) }));
                        touch(index);
                      }}
                      onFocus={() => historyFor(index).push(shapes)}
                    />
                  </label>
                ) : null}

                <p className="text-[11px] text-gray-400 leading-relaxed pt-0.5">{T.appliesToPicked}</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-t bg-gray-50 text-[11px] text-gray-500 tabular-nums">
        <span>{sheet.name}</span>
        <span>{mm(sheet.drawing.width)} × {mm(sheet.drawing.height)} mm</span>
        <span>{cursor ? `X ${mm(cursor.x)}  Y ${mm(cursor.y)} mm` : '—'}</span>
        <span>{T.zoomPct(Math.round((sheet.drawing.width / view.w) * 100))}</span>
        <span>{T.shapesN(shapes.length)}</span>
        {sheetBlocks > 0 && <span>{T.blocksN(sheetBlocks)}</span>}
        {selection.size > 0 && <span className="text-blue-700">{T.pickedN(selection.size)}</span>}
        {edited && <span className="text-amber-700">{T.edited}</span>}
        {dirty
          ? <span className="text-amber-700">{T.notKept}</span>
          : anySaved && <span className="text-emerald-700">{T.keptWithProject}</span>}
        {stale.length > 0 && (
          <span
            className="flex items-center gap-1 text-amber-700"
            title={`The project has changed since ${stale.join(', ')} ${stale.length === 1 ? 'was' : 'were'} edited, so these corrections were made against an older drawing. Revert the sheet to take the new one.`}
          >
            <TriangleAlertIcon className="w-3 h-3" />
            {T.staleN(stale.length)}
          </span>
        )}
        {/* What a command could not do, said once and cleared by the next move. */}
        {notice && (
          <span className="flex items-center gap-1 text-rose-700 font-medium" dir={dir}>
            <TriangleAlertIcon className="w-3 h-3" />
            {notice}
          </span>
        )}
        <span className="ml-auto" dir={dir}>{hint}</span>
      </div>
    </div>
  );
};

/**
 * The one value a set of shapes agrees on, or null when they do not.
 *
 * A dropdown showing "1.0" over a mixed selection would be a lie that becomes
 * true the moment anybody touches it, so a mixed set shows a dash instead and
 * only changes what it is told to.
 */
function commonOf<T>(picked: Shape[], read: (s: Shape) => T): T | null {
  if (picked.length === 0) return null;
  const first = read(picked[0]);
  return picked.every(p => read(p) === first) ? first : null;
}

/** Which of the four line types a dash pattern is, for the dropdown. */
const lineTypeIdOf = (dash?: string): string =>
  LINE_TYPES.find(l => (l.dash ?? '') === (dash ?? ''))?.id ?? 'solid';

/**
 * The numbers behind one shape, in millimetres, editable.
 *
 * This is the other half of the grips: the mouse puts a line roughly where it
 * belongs and these put it exactly there. Both write the same shape, so a line
 * dragged to about 110 mm and then typed as 111.00 ends up at 111.00.
 *
 * Everything is shown in millimetres of real size rather than in the sheet's
 * own units, because that is what the status bar reads, what the dimension
 * tool writes, and what a drawing office measures in.
 */
const Geometry: React.FC<{
  shape: Shape;
  t: Strings;
  mmPerUnit: number;
  onChange: (next: Shape) => void;
  /** Called before the first keystroke of an edit, to take one undo step. */
  onFocus: () => void;
}> = ({ shape, t, mmPerUnit, onChange, onFocus }) => {
  const toMm = (v: number) => Number((v * mmPerUnit).toFixed(2));
  const toUnits = (mm: number) => mm / mmPerUnit;

  const Field: React.FC<{
    label: string; value: number; onSet: (v: number) => void;
    /** Degrees rather than millimetres — no conversion, and it wraps. */
    degrees?: boolean;
    name: string;
  }> = ({ label, value, onSet, degrees, name }) => (
    <label className="block min-w-0">
      <span className="text-[11px] text-gray-500 truncate block">{label}</span>
      <input
        type="number"
        step={degrees ? 1 : 0.1}
        data-geom={name}
        // Rounded for showing, never for storing: what is typed is what is
        // used, and an untouched field puts back exactly what it read.
        value={degrees ? Number(value.toFixed(2)) : toMm(value)}
        onFocus={onFocus}
        onChange={e => {
          const typed = Number(e.target.value);
          if (!Number.isFinite(typed)) return;
          onSet(degrees ? typed : toUnits(typed));
        }}
        className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1 text-sm tabular-nums"
      />
    </label>
  );

  const Pair: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="grid grid-cols-2 gap-2">{children}</div>
  );

  const head = (
    <div className="flex items-baseline justify-between gap-2 pt-1">
      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{t.geometry}</span>
      <span className="text-[10px] text-gray-400">{t.inMm}</span>
    </div>
  );

  switch (shape.t) {
    case 'line': {
      const { length, angle } = lineMetrics(shape);
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="x1" label={t.startX} value={shape.x1} onSet={v => onChange({ ...shape, x1: v })} />
            <Field name="y1" label={t.startY} value={shape.y1} onSet={v => onChange({ ...shape, y1: v })} />
          </Pair>
          <Pair>
            <Field name="x2" label={t.endX} value={shape.x2} onSet={v => onChange({ ...shape, x2: v })} />
            <Field name="y2" label={t.endY} value={shape.y2} onSet={v => onChange({ ...shape, y2: v })} />
          </Pair>
          {/* Length and angle hold the first end and swing the second, which
              is how a line is given a size without first working out where
              its far end would have to be. */}
          <Pair>
            <Field name="length" label={t.lengthOf} value={length}
                   onSet={v => onChange(lineFrom(shape, Math.max(0, v), angle))} />
            <Field name="angle" label={t.angleOf} value={angle} degrees
                   onSet={v => onChange(lineFrom(shape, length, v))} />
          </Pair>
        </div>
      );
    }

    case 'rect':
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="x" label={t.atX} value={shape.x} onSet={v => onChange({ ...shape, x: v })} />
            <Field name="y" label={t.atY} value={shape.y} onSet={v => onChange({ ...shape, y: v })} />
          </Pair>
          <Pair>
            <Field name="w" label={t.widthMm} value={shape.w} onSet={v => onChange({ ...shape, w: Math.max(0, v) })} />
            <Field name="h" label={t.heightMm} value={shape.h} onSet={v => onChange({ ...shape, h: Math.max(0, v) })} />
          </Pair>
        </div>
      );

    case 'circle':
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="cx" label={t.centreXOf} value={shape.cx} onSet={v => onChange({ ...shape, cx: v })} />
            <Field name="cy" label={t.centreYOf} value={shape.cy} onSet={v => onChange({ ...shape, cy: v })} />
          </Pair>
          <Field name="r" label={t.radiusOf} value={shape.r}
                 onSet={v => onChange({ ...shape, r: Math.max(0.01, v) })} />
        </div>
      );

    case 'ellipse':
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="cx" label={t.centreXOf} value={shape.cx} onSet={v => onChange({ ...shape, cx: v })} />
            <Field name="cy" label={t.centreYOf} value={shape.cy} onSet={v => onChange({ ...shape, cy: v })} />
          </Pair>
          <Pair>
            <Field name="rx" label={t.radiusXOf} value={shape.rx} onSet={v => onChange({ ...shape, rx: Math.max(0.01, v) })} />
            <Field name="ry" label={t.radiusYOf} value={shape.ry} onSet={v => onChange({ ...shape, ry: Math.max(0.01, v) })} />
          </Pair>
        </div>
      );

    case 'arc':
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="cx" label={t.centreXOf} value={shape.cx} onSet={v => onChange({ ...shape, cx: v })} />
            <Field name="cy" label={t.centreYOf} value={shape.cy} onSet={v => onChange({ ...shape, cy: v })} />
          </Pair>
          <Field name="r" label={t.radiusOf} value={shape.r}
                 onSet={v => onChange({ ...shape, r: Math.max(0.01, v) })} />
          <Pair>
            <Field name="a0" label={t.sweepFrom} value={shape.a0} degrees
                   onSet={v => onChange({ ...shape, a0: v, a1: v < shape.a1 ? shape.a1 : v + 1 })} />
            <Field name="a1" label={t.sweepTo} value={shape.a1} degrees
                   onSet={v => onChange({ ...shape, a1: v > shape.a0 ? v : shape.a0 + 1 })} />
          </Pair>
        </div>
      );

    case 'text':
      return (
        <div className="space-y-2">
          {head}
          <Pair>
            <Field name="x" label={t.atX} value={shape.x} onSet={v => onChange({ ...shape, x: v })} />
            <Field name="y" label={t.atY} value={shape.y} onSet={v => onChange({ ...shape, y: v })} />
          </Pair>
          <Field name="rot" label={t.rotationOf} value={shape.rot ?? 0} degrees
                 onSet={v => onChange({ ...shape, rot: norm360(v) || undefined })} />
        </div>
      );

    case 'poly': case 'curve':
      // Typing thirty vertices is not editing, it is data entry — the grips
      // are the way to move these, and the panel says so rather than pretending.
      return (
        <div className="space-y-1">
          {head}
          <Row label={t.geometry} value={t.pointsN(shape.t === 'poly' ? shape.pts.length : 3)} />
        </div>
      );
  }
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-2">
    <span className="text-[11px] text-gray-500">{label}</span>
    <span className="text-[13px] text-gray-800 truncate">{value}</span>
  </div>
);
