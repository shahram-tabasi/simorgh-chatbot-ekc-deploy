import * as XLSX from 'xlsx-js-style';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tableShapes, replaceTable, tableOrigin, tableIdOf } from '../../utils/cad/table';
import { checkSheet, Message } from '../../utils/cad/schematic';
import { MARK_R, checkTerminals, terminalMarks } from '../../utils/cad/terminals';
import { numberWires, autoTagDevices, crossReferences } from '../../utils/cad/annotate';
import { HeaderFields, drawingAreas, hasHeader, sheetHeader, stripHeader } from '../../utils/cad/header';
import {
  ZoomInIcon, ZoomOutIcon, MaximizeIcon, MousePointer2Icon, HandIcon,
  UndoIcon, RedoIcon, CopyIcon, Trash2Icon, GridIcon, RotateCcwIcon,
  EyeIcon, EyeOffIcon, LockIcon, UnlockIcon, DownloadIcon, ScanSearchIcon,
  SaveIcon, TriangleAlertIcon, MinusIcon, WaypointsIcon, SquareIcon, CircleIcon,
  SplineIcon, TypeIcon, Maximize2Icon, Minimize2Icon, MagnetIcon,
  CircleDashedIcon, RulerIcon, ScissorsIcon, ArrowRightToLineIcon,
  CornerDownRightIcon, RotateCwIcon, FlipHorizontalIcon, FlipVerticalIcon,
  ScalingIcon, BringToFrontIcon, SendToBackIcon, TableIcon, RefreshCwIcon,
  HashIcon, TagIcon, ShieldCheckIcon, XIcon, LinkIcon, PaletteIcon,
  AlignStartVerticalIcon, AlignEndVerticalIcon, AlignCenterVerticalIcon,
  AlignStartHorizontalIcon, AlignEndHorizontalIcon, AlignCenterHorizontalIcon,
  AlignHorizontalDistributeCenterIcon, AlignVerticalDistributeCenterIcon,
  LanguagesIcon, CircleHelpIcon, LibraryBigIcon, GroupIcon, UngroupIcon,
  SunIcon, MoonIcon, CableIcon, FrameIcon, FileInputIcon,
  FilePlusIcon, FilesIcon, PencilIcon, ChevronLeftIcon, ChevronRightIcon,
  PanelLeftIcon, PanelRightIcon, PictureInPicture2Icon } from 'lucide-react';
import logoMark from '../../assets/logo-mark.png';
import { DrawingEdits } from '../../types/project';
import {
  Drawing, LAYERS, Layer, LAYER_NOTES, Pen, Pt, Shape, layerColor, translateShape,
} from '../../utils/cad/shapes';
import { readDxf } from '../../utils/cad/readDxf';
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
  transformShapes, translation, trimLine, ungroupShapes,
} from '../../utils/cad/geom';
import { downloadBlob, downloadText, fileSafe } from '../../utils/download';
import { Lang, LANGS, STRINGS, Strings, dirOf, loadLang, saveLang } from './lang';
import { DrawingHelp } from './DrawingHelp';
import { SymbolLibrary } from './SymbolLibrary';
import { symbolDrawing } from '../../utils/cad/symbolArt';
import {
  SymbolArt, countInstances, replaceSymbolInstances,
} from '../../utils/cad/replaceSymbol';
import {
  IEC_SYMBOLS, SymbolId, packSymbolOverride, redrawnSymbolIds,
} from '../../utils/iecSymbols';
import { SymbolArtOverride } from '../../types/project';
import { LibraryKind } from '../../utils/cad/symbolLibraries';
import { CpuIcon, PencilRulerIcon } from 'lucide-react';
import { LadderAsk, LadderAskResult } from '../SimorghLogic/LadderAsk';
import { renderProgram } from '../../utils/ladder/render';
import {
  DrawingGroups, DrawingPage, PageType, copyOfPage, newPage, pageKey,
} from '../../utils/cad/pages';
import { SYMBOL_LIBRARIES } from '../../utils/cad/symbolLibraries';
import { PageNavigator } from './PageNavigator';
import {
  SymPlacement, expandSymbols, libraryItems, symbolCatalogue,
} from '../../utils/cad/symbolSource';
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
  /**
   * Which of the three kinds of document this is — WD, SLD or OLD.
   *
   * Only hand-drawn pages carry it; a generated single line leaves it unset
   * and everything falls back to the single-line library as before.
   */
  kind?: LibraryKind;
}

interface Props {
  sheets: EditorSheet[];
  /** Which sheet to open on. Absent means the first, as it always was. */
  startAt?: number;
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
  /**
   * The page set these sheets are, when the editor was opened on one.
   *
   * Sheet `i` is page `i` — the caller builds one from the other in order.
   * Absent on a generated single line or a blank sheet, and the Page tab is
   * then not offered: there is no set to add to.
   */
  pages?: DrawingPage[];
  pageGroups?: DrawingGroups;
  /**
   * A changed page set, with the edits that go with it.
   *
   * The two travel together and never separately. Changing the set replaces
   * the `sheets` array, which re-seeds this editor from what the project
   * holds — so anything drawn since the last Save has to be handed over in
   * the same call or it is gone. That is why every page command here goes
   * through `pendingEdits()`.
   */
  onPages?: (pages: DrawingPage[], edits: DrawingEdits, groups: DrawingGroups) => void;
  /**
   * Drawn inside another panel — a symbol being redrawn, a template's art.
   *
   * The canvas is 620 pixels tall whatever it is given, which in a panel 300
   * pixels high is a drawing with its lower half below the window: the half
   * you cannot reach to draw on, and the Save button below that. An embedded
   * editor fills the box it is put in instead, top to bottom.
   */
  embedded?: boolean;
  /**
   * The host owns full screen and the symbol library, so this editor does not
   * offer them.
   *
   * For an editor opened *from* the symbol library: a symbol library reached
   * from inside the panel that a symbol is being redrawn in is the library
   * inside itself, and a second full screen inside a panel that is already one
   * is a way of losing the panel.
   */
  lean?: boolean;
  /**
   * Told when there is something to save, and handed the way to save it.
   *
   * A host that frames this editor — the symbol panel — puts Save where the
   * person is looking rather than leaving it as a disc in a nested ribbon.
   * `saveHandle.current` is the editor's own Save, and `onDirty` says whether
   * pressing it would do anything.
   */
  saveHandle?: React.MutableRefObject<(() => void) | null>;
  onDirty?: (dirty: boolean) => void;
  /**
   * The sheet as it stands, every time it changes.
   *
   * For a host that has its own controls over the same geometry — the symbol
   * page's terminal list, which renames and turns the very connection points
   * that can also be dragged on the canvas. Without this the host would be
   * editing the copy it handed in, and a terminal moved with the mouse would
   * jump back the moment it was renamed.
   */
  onSheetChange?: (key: string, shapes: Shape[]) => void;
  /**
   * Geometry drawn under the sheet that is not part of it — see
   * `DrawingCanvas`. The symbol page's frame comes in this way.
   */
  guides?: Shape[] | null;
  /**
   * The host has its own way of bringing a DXF in, so the ribbon's is hidden.
   *
   * On a sheet a DXF is *more* geometry and it belongs where the draughtsman
   * is looking, which is what the ribbon's button does. On the symbol page the
   * DXF **is** the symbol: it replaces the drawing and it has to land in the
   * frame. Two buttons that look the same and do opposite things is worse than
   * either, so the host that means the second one takes the first away.
   */
  ownDxfImport?: boolean;
  /**
   * How much room to leave round the sheet when it is fitted, as a fraction.
   *
   * The default is the thin margin a drawing wants. The symbol page wants more:
   * its frame draws the conductor and the two arrows a little outside the box,
   * and on the default margin the arrow at the bottom of the symbol was off the
   * bottom of the canvas — which reads as the page having drawn it wrong
   * rather than as the view being tight.
   */
  fitPad?: number;
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
 * The tools, split the way the ribbon groups them.
 *
 * Each names the phrase that describes it rather than carrying one, so the bar
 * reads in whichever of the three languages is chosen without the table having
 * to know about any of them. The letters are the same in every language — they
 * are where the finger goes, not a word.
 *
 * The split is by how often a hand reaches for it, not by what it is: the four
 * in `DRAW_BIG` are most of a day's work on an electrical sheet and get their
 * names on the button; the rest are known by their picture once and after that
 * by where they sit.
 */
type ToolName = Extract<keyof Strings, Tool>;
type ToolRow = { id: Tool; name: ToolName; key: string; Icon: React.FC<{ className?: string }> };

const DRAW_BIG: ToolRow[] = [
  { id: 'select', name: 'select', key: 'V', Icon: MousePointer2Icon },
  { id: 'line', name: 'line', key: 'L', Icon: MinusIcon },
  { id: 'connect', name: 'connect', key: 'N', Icon: CableIcon },
  { id: 'text', name: 'text', key: 'T', Icon: TypeIcon },
];

const DRAW_SMALL: ToolRow[] = [
  { id: 'polyline', name: 'polyline', key: 'P', Icon: WaypointsIcon },
  { id: 'dim', name: 'dim', key: 'D', Icon: RulerIcon },
  { id: 'rect', name: 'rect', key: 'R', Icon: SquareIcon },
  { id: 'circle', name: 'circle', key: 'C', Icon: CircleIcon },
  { id: 'ellipse', name: 'ellipse', key: 'E', Icon: CircleDashedIcon },
  { id: 'arc', name: 'arc', key: 'A', Icon: SplineIcon },
  // Not decoration among the shapes: a point placed with this is what makes a
  // wire land on a *device* instead of near one, and it is the difference
  // between a drawing that can be reported on and a picture.
  { id: 'pin', name: 'pin', key: 'G', Icon: LinkIcon },
];

/** The ones that change a line that is already there. */
const EDIT_TOOLS: ToolRow[] = [
  { id: 'trim', name: 'trim', key: 'X', Icon: ScissorsIcon },
  { id: 'extend', name: 'extend', key: 'W', Icon: ArrowRightToLineIcon },
  { id: 'corner', name: 'corner', key: 'K', Icon: CornerDownRightIcon },
];

/** Panning sits with the zooms, because that is the same question. */
const PAN: ToolRow = { id: 'pan', name: 'pan', key: 'H', Icon: HandIcon };

/** All of them, for the keyboard: a letter reaches a tool from any tab. */
const TOOLS: ToolRow[] = [...DRAW_BIG, ...DRAW_SMALL, ...EDIT_TOOLS, PAN];

/** Lining up, in the order the buttons sit on the bar. */
const ALIGNS: { to: AlignTo; name: keyof Strings; Icon: React.FC<{ className?: string }> }[] = [
  { to: 'left', name: 'alignLeft', Icon: AlignStartVerticalIcon },
  { to: 'centre-x', name: 'centreX', Icon: AlignCenterVerticalIcon },
  { to: 'right', name: 'alignRight', Icon: AlignEndVerticalIcon },
  { to: 'top', name: 'alignTop', Icon: AlignStartHorizontalIcon },
  { to: 'centre-y', name: 'centreY', Icon: AlignCenterHorizontalIcon },
  { to: 'bottom', name: 'alignBottom', Icon: AlignEndHorizontalIcon },
];

/**
 * The ribbon's tabs.
 *
 * Four, and deliberately not more. This draws switchboards, not buildings, so
 * the hatch patterns, the 3-D and the sheet-set manager a general CAD package
 * carries have nothing to do here. What is left divides cleanly: **Home** is
 * the geometry, **Electrical** is what makes it a wiring diagram rather than a
 * picture of one, **Output** is what leaves the building, **View** is how the
 * screen looks. Save, undo, the sheet list and the model sit above the tabs,
 * because those are wanted whichever tab is open.
 */
type RibbonTab = 'home' | 'page' | 'elec' | 'out' | 'view';
const TABS: {
  id: RibbonTab;
  name: 'tabHome' | 'tabPage' | 'tabElectrical' | 'tabOutput' | 'tabView';
}[] = [
  { id: 'home', name: 'tabHome' },
  // Second, and only when the editor was opened on a page set. A drawing set
  // is worked one page at a time and the next page is wanted from inside the
  // drawing, not by closing it and going back to the project — which is how a
  // finished sheet turned into "now what".
  { id: 'page', name: 'tabPage' },
  { id: 'elec', name: 'tabElectrical' },
  { id: 'out', name: 'tabOutput' },
  { id: 'view', name: 'tabView' },
];

/**
 * What a button is painted in.
 *
 * `plain` is nearly everything; the colours are reserved for the four commands
 * that produce something — a file, or a draft from the model — because a
 * command with a consequence should not look like one that toggles a grid.
 */
const TONES = {
  plain: 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100',
  ai: 'bg-violet-700 border-violet-700 text-white hover:bg-violet-800',
  dxf: 'bg-teal-700 border-teal-700 text-white hover:bg-teal-800',
  pdf: 'bg-rose-700 border-rose-700 text-white hover:bg-rose-800',
  live: 'bg-emerald-700 border-emerald-700 text-white hover:bg-emerald-800',
  alarm: 'bg-red-700 border-red-700 text-white hover:bg-red-800',
};

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
 *
 * Give it a `label` and it grows into the tall form a ribbon uses for the
 * handful of commands in each group that get reached for by name.
 *
 * It lives out here rather than inside the editor so that React keeps the same
 * component across renders. Declared inside, every keystroke would hand React
 * a brand-new component type, it would throw the old buttons away and build
 * new ones, and anything with a cursor in it would lose the cursor.
 */
const ToolBtn: React.FC<{
  on?: () => void; active?: boolean; disabled?: boolean; title: string;
  /** The letter that does the same thing, shown on its own line. */
  keyHint?: string;
  // The tool's own name on the button, so the drawing tools can be reached
  // by what they are rather than by where they sit on the bar.
  tag?: string;
  /** Put the command's name under its picture, ribbon-style. */
  label?: boolean;
  /** Not this one here — a command the host owns while the editor is embedded. */
  hide?: boolean;
  tone?: keyof typeof TONES;
  children: React.ReactNode;
}> = ({ on, active, disabled, title, keyHint, tag, label, hide, tone = 'plain', children }) => {
  // The phrases are written as "Name — what it does"; the dash is the split.
  const [name, ...rest] = title.split(' — ');
  const detail = rest.join(' — ');
  if (hide) return null;
  return (
    <span className="relative group/tip inline-flex">
      <button
        onClick={on} disabled={disabled} data-tool={tag}
        // Kept for the browser, and for anything reading the page aloud.
        title={title}
        aria-label={title}
        className={`rounded-md border text-sm transition-colors disabled:opacity-30 disabled:cursor-default ${
          label ? 'flex flex-col items-center gap-1 w-[62px] px-1 py-1.5' : 'p-1.5'
        } ${active ? 'bg-slate-700 border-slate-700 text-white' : TONES[tone]}`}
      >
        {children}
        {label && <span className="text-[10px] leading-tight text-center">{name}</span>}
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

/**
 * One group of commands, under the caption that says what they are for.
 *
 * The caption is the whole point. It is what turns a wall of pictures into
 * "those four are about wires", and it is why a ribbon stays readable at sixty
 * commands where a single long row stopped being readable at fifteen.
 */
const RibbonPanel: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <div className="flex shrink-0 flex-col border-e border-gray-200 px-2 last:border-e-0">
    <div className="flex flex-1 items-start gap-1 py-1">{children}</div>
    <div className="pt-0.5 pb-1 text-center text-[10px] leading-none text-gray-400">{name}</div>
  </div>
);

/**
 * The small commands of a group, stacked two deep.
 *
 * Column-major, so a pair reads top-then-bottom the way the eye scans a
 * ribbon, and so a group of eight is four columns wide rather than eight.
 */
const Stack: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-flow-col grid-rows-2 gap-1">{children}</div>
);

/**
 * Where the model's panel sits.
 *
 * Floating is where it started and is the wrong default for a panel you use
 * while drawing: it covers the sheet, which is the one thing you need to see
 * to judge what it drew. Docking it to a side gives it a column of its own,
 * the way every CAD package parks its panels, and the choice is remembered
 * because it is a preference about a desk, not about a drawing.
 */
export type Dock = 'left' | 'right' | 'float';

const DOCK_KEY = 'simorgh-draw-ask-dock';
/** The page tree docks like the model's panel, and remembers its own side. */
const PAGES_DOCK_KEY = 'simorgh-draw-pages-dock';

const loadDock = (key: string, fallback: Dock = 'right'): Dock => {
  try {
    const kept = window.localStorage.getItem(key);
    if (kept === 'left' || kept === 'right' || kept === 'float') return kept;
  } catch { /* a browser that keeps nothing is not an error */ }
  return fallback;
};

const saveDock = (key: string, d: Dock) => {
  try { window.localStorage.setItem(key, d); } catch { /* nothing to do */ }
};

/**
 * The three buttons every dockable panel carries: left, loose, right.
 *
 * One component rather than one per panel, so a second panel docks the way
 * the first one does — a desk where two panels park differently is a desk you
 * have to learn twice.
 */
const DockButtons: React.FC<{
  t: Strings; dock: Dock; onDock: (d: Dock) => void; onClose: () => void;
  /** Dark chrome, for a panel whose title bar is not white. */
  dark?: boolean;
}> = ({ t, dock, onDock, onClose, dark }) => {
  const on = dark ? 'bg-white/25' : 'bg-gray-200';
  const hover = dark ? 'hover:bg-white/20' : 'hover:bg-gray-100';
  return (
    <span className="flex items-center gap-0.5">
      {/* Left, right, or loose. Three buttons rather than a drag-to-the-edge
          gesture: the gesture is charming until the one time it does not
          catch, and then the panel is somewhere you did not put it. */}
      <button
        className={`p-1 rounded ${hover} ${dock === 'left' ? on : ''}`}
        title={t.dockLeft} aria-label={t.dockLeft} onClick={() => onDock('left')}
      >
        <PanelLeftIcon className="w-3.5 h-3.5" />
      </button>
      <button
        className={`p-1 rounded ${hover} ${dock === 'float' ? on : ''}`}
        title={t.undock} aria-label={t.undock} onClick={() => onDock('float')}
      >
        <PictureInPicture2Icon className="w-3.5 h-3.5" />
      </button>
      <button
        className={`p-1 rounded ${hover} ${dock === 'right' ? on : ''}`}
        title={t.dockRight} aria-label={t.dockRight} onClick={() => onDock('right')}
      >
        <PanelRightIcon className="w-3.5 h-3.5" />
      </button>
      <button className={`p-1 rounded ${hover} ms-1`} title={t.closeHelp} onClick={onClose}>
        <XIcon className="w-4 h-4" />
      </button>
    </span>
  );
};

/**
 * The model's panel: what to draw, and what came back when it could not.
 *
 * Module-level, not declared inside the editor, because it holds a textarea.
 * A component declared inside a render is a new component type every keystroke,
 * React throws the old one away and builds a new one, and the cursor goes with
 * it — which is the bug this editor has already been bitten by once.
 */
/**
 * Which of the two the panel is on.
 *
 * Drawing a schematic and writing a PLC program are two different jobs asked
 * in two different ways: one is a sentence, the other needs the vendor settled
 * before the first word is useful. They share a panel because they share a
 * sheet — what either produces lands on the drawing in front of you — and they
 * are two tabs inside it because putting the vendor chips above a request to
 * draw a motor starter would be asking for something that changes nothing.
 */
export type AskMode = 'draw' | 'plc';

const AskPanel: React.FC<{
  t: Strings;
  text: string;
  onText: (v: string) => void;
  asking: boolean;
  onGo: () => void;
  onClose: () => void;
  dock: Dock;
  onDock: (d: Dock) => void;
  mode: AskMode;
  onMode: (m: AskMode) => void;
  /** What to do with a ladder program the assistant wrote. */
  onProgram: (result: LadderAskResult) => void;
  /** What the model actually said, when what it said could not be drawn. */
  raw: { error: string; text: string; model: string } | null;
  /** Which of the three documents the open page is, so the panel says so. */
  kind: LibraryKind;
  onDragStart?: (e: React.MouseEvent) => void;
}> = ({
  t, text, onText, asking, onGo, onClose, dock, onDock, mode, onMode, onProgram,
  raw, kind, onDragStart,
}) => (
  <>
    <div
      className={`flex items-center justify-between px-3 py-2 border-b border-gray-200 ${
        dock === 'float' ? 'cursor-move' : ''}`}
      onMouseDown={dock === 'float' ? onDragStart : undefined}
    >
      <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
        <img src={logoMark} alt="" aria-hidden data-theme-invert className="w-4 h-4 object-contain" />
        {t.ask}
      </p>
      <DockButtons t={t} dock={dock} onDock={onDock} onClose={onClose} />
    </div>
    {/* Two tabs, the way the two environments are two icons in the corner. */}
    <div className="flex items-stretch border-b border-gray-200 bg-gray-50">
      {([['draw', t.askModeDraw, PencilRulerIcon], ['plc', t.askModePlc, CpuIcon]] as const).map(
        ([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => onMode(id)}
            data-ask-mode={id}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[12px] border-b-2 ${
              mode === id
                ? 'border-violet-600 text-violet-800 font-medium bg-white'
                : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
    </div>

    {mode === 'plc' ? (
      <div className="p-3 overflow-y-auto">
        <LadderAsk
          compact
          onProgram={onProgram}
          footnote={
            <p className="text-[11px] text-amber-700 leading-relaxed">{t.askPlcNote}</p>
          }
        />
      </div>
    ) : (
    <div className="p-3 overflow-y-auto">
      {/* What it will draw, and not a general promise: the three pages are
          three documents, and being told which one is about to be drawn is
          the difference between a useful answer and a surprise. */}
      <p className="text-[11px] text-gray-500 mb-1.5">{t.askDrawFor(kind)}</p>
      <textarea
        value={text}
        onChange={e => onText(e.target.value)}
        rows={3}
        placeholder={t.askPlaceholder}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-violet-400"
      />
      <p className="text-[11px] text-gray-500 mt-1.5">{t.askNote}</p>
      <div className="flex justify-end mt-2">
        <button
          onClick={onGo}
          disabled={asking || text.trim().length < 3}
          className="px-3 py-1.5 rounded bg-violet-700 text-white text-sm font-medium hover:bg-violet-800 disabled:opacity-40"
        >
          {asking ? t.askWorking : t.askGo}
        </button>
      </div>
      {/* What it said, when what it said was not a drawing. Without this the
          failure is a dead end: the only question worth answering is what the
          model actually wrote, and nothing but its own words answers it. */}
      {raw && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50">
          <p className="px-2 py-1.5 text-[11px] font-medium text-amber-800 border-b border-amber-200">
            {raw.error}
            {raw.model && <span className="font-normal text-amber-700"> · {raw.model}</span>}
          </p>
          <pre className="px-2 py-1.5 text-[10px] leading-snug text-gray-700 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {raw.text || t.askSaidNothing}
          </pre>
        </div>
      )}
    </div>
    )}
  </>
);

export const DrawingEditor: React.FC<Props> = ({
  sheets, startAt = 0, fileBase, titleBlock, mmPerUnit = 0.5, paper: initialPaper = 'auto',
  savedEdits, onSaveEdits, canEdit = true, pages, pageGroups = [], onPages,
  embedded = false, lean = false, saveHandle, onDirty, guides, ownDxfImport = false,
  fitPad,
  onSheetChange,
}) => {
  const [index, setIndex] = useState(startAt);
  const sheet = sheets[Math.min(index, Math.max(0, sheets.length - 1))];

  // Edits live per sheet, so paging through a set does not lose them.
  const [edits, setEdits] = useState<Record<number, Shape[]>>({});
  // Which sheets this session has actually changed. A boolean would do for the
  // Save button, but not for what Save writes: re-stamping a sheet nobody
  // touched would quietly clear its "edited against an older drawing" warning
  // without anyone having looked at it.
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());
  const dirty = touched.size > 0;
  // Said out to the host, so its own Save button can go grey with this one.
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
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
  // Said out to the host every time it changes, for a host that has its own
  // controls over the same geometry — see `onSheetChange`.
  const key = sheet?.key;
  useEffect(() => {
    if (key) onSheetChange?.(key, shapes);
  }, [key, shapes, onSheetChange]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState<Set<Layer>>(new Set());
  const [locked, setLocked] = useState<Set<Layer>>(new Set());
  const [tool, setTool] = useState<Tool>('select');
  // How new geometry is drawn. A drawing office thinks in layer, weight and
  // line type, so that is what the bar offers.
  const [drawLayer, setDrawLayer] = useState<Layer>('SYMBOL');
  const [drawWidth, setDrawWidth] = useState(1);
  const [drawLine, setDrawLine] = useState('solid');
  // Empty means "whatever the layer says", which is the CAD default and what
  // everything drawn so far has used.
  const [drawColor, setDrawColor] = useState('#111827');
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
  const dxfInput = useRef<HTMLInputElement>(null);
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


  /**
   * A DXF, read onto this sheet.
   *
   * Not as a symbol and not as a whole sheet: as geometry, where the view is,
   * picked so the next drag puts it where it goes. That is what a draughtsman
   * with a supplier's DXF actually wants — the outline of a terminal rail or a
   * cubicle door on the page they are on — and it is how a symbol gets drawn
   * from a manufacturer's file without leaving the editor.
   *
   * Connection points come across as terminals rather than as circles: a DXF
   * that declared a CONN layer has already said where a wire lands, and
   * throwing that away would mean placing them again by hand.
   */
  const placeDxf = useCallback(async (file: File) => {
    let read: ReturnType<typeof readDxf>;
    try { read = readDxf(await file.text(), file.name); }
    catch { setNotice(T.dxfUnreadable); return; }

    const marks = terminalMarks(read.connections.map(([x, y], i) => ({
      x, y, name: String(i + 1),
    })));
    const run = [...read.drawing.shapes, ...marks];
    if (run.length === 0) { setNotice(T.dxfEmpty); return; }

    // The top left of what is on screen, inset a little, so it lands where the
    // person is looking rather than at a sheet origin they may be nowhere near.
    const dx = view.x + view.w * 0.08;
    const dy = view.y + view.h * 0.08;
    const placed = run.map(sh => translateShape(sh, dx, dy));
    commit(
      [...shapes, ...placed],
      new Set(placed.map((_, i) => shapes.length + i)),
    );
    setNotice(T.dxfPlaced(placed.length, marks.length));
  }, [shapes, commit, view, T]);

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

  // The geometry checks and the terminal checks are two lists because they are
  // two modules; they are one list to the person reading them.
  const allChecks = useCallback(
    (run: Shape[]) => [...checkSheet(run), ...checkTerminals(run)], []);

  const runChecks = useCallback(() => {
    setMessages(allChecks(shapes));
    setShowChecks(true);
  }, [allChecks, shapes]);

  // Re-run on every edit once the panel is open, so the list is never stale
  // enough to send someone to a wire they have already fixed.
  useEffect(() => {
    if (showChecks) setMessages(allChecks(shapes));
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

  /**
   * The frame, the zone grid and the title block, on or off.
   *
   * It goes on as ordinary geometry rather than as something the exporter adds
   * at the last moment, which is what the old frame was. The difference shows
   * up the moment anybody wants to use it: this one is on the screen while you
   * draw, so you can see what the title block is about to cover; it comes out
   * in the DXF as lines the customer can edit; and every cell in it is a text
   * shape, so an empty DRAWN box is filled in by double-clicking it and
   * typing a name, not by editing our source.
   *
   * Pressing it again takes it off, because a frame you cannot remove is a
   * frame you will end up with two of.
   */
  const headerOn = useMemo(() => hasHeader(shapes), [shapes]);

  /** What this sheet's title block says — and, through it, how big it is. */
  const headerFields = useCallback((): HeaderFields => ({
    title: sheet.name,
    // The lines the project already hands the exporter for its title block.
    // First is the job, second whatever the job calls this document.
    project: titleBlock[0] ?? '',
    number: titleBlock[1] ?? '',
    sheet: sheets.length > 1 ? `${index + 1} / ${sheets.length}` : '1 / 1',
    size: paper === 'auto' ? '' : paper,
    // A circuit diagram is not to scale and saying so is the honest entry;
    // a layout drawing that is to scale can have this retyped.
    scale: 'NTS',
    date: new Date().toISOString().slice(0, 10),
  }), [sheet, titleBlock, sheets.length, index, paper]);

  /**
   * The part of the sheet a drawing may use — the frame's inside, less the
   * title block.
   *
   * The assistant needs this, and "the sheet" is not it: a drawing that only
   * has to stay on the sheet is free to run through the title block, and one
   * told to keep a margin has no idea the bottom-right corner is spoken for.
   * It is the same rectangle `doHeader` fits an imported drawing into, so what
   * the assistant draws and what the frame allows are one number, not two.
   */
  const designArea = useCallback(() => {
    const { width: W, height: H } = sheet.drawing;
    if (headerOn) {
      const best = drawingAreas(W, H, headerFields(), { mmPerUnit })
        .sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (best) return best;
    }
    // No frame yet: the sheet, inset, so there is room for one later.
    const margin = Math.min(20, Math.min(W, H) / 12);
    return { x: margin, y: margin, w: W - 2 * margin, h: H - 2 * margin };
  }, [sheet, headerOn, mmPerUnit, headerFields]);

  const doHeader = useCallback(() => {
    if (headerOn) { commit(stripHeader(shapes)); setNotice(null); return; }

    const { width: W, height: H } = sheet.drawing;
    const fields = headerFields();
    // The sheet's own scale, so the frame plots at the millimetres a drawing
    // standard names rather than at a size that only looks about right.
    const style = { mmPerUnit };
    const frameShapes = sheetHeader(W, H, fields, style);
    if (frameShapes.length === 0) { setNotice(T.headerTooSmall); return; }

    // The drawing has to end up inside the frame, and on a generated sheet it
    // never does on its own: these sheets are drawn to fill the paper, so a
    // title block dropped into the corner lands on the last feeder every time.
    // Rather than leave someone to find that out at the plotter, the drawing is
    // fitted into the larger of the two rectangles the title block leaves —
    // one step of undo if it is not wanted.
    const content = stripHeader(shapes);
    const box = boundsOfAll(content);
    const areas = drawingAreas(W, H, fields, style);
    let fitted = content;
    let percent = 100;
    if (box && areas.length > 0 && box.w > 0 && box.h > 0) {
      const outside = box.x < areas[0].x || box.y < areas[0].y
        || !areas.some(a => box.x >= a.x && box.y >= a.y
                         && box.x + box.w <= a.x + a.w && box.y + box.h <= a.y + a.h);
      if (outside) {
        // Never blown up, only brought in: a drawing enlarged to fill its frame
        // is a drawing whose line weights and text no longer mean what they did.
        const best = areas
          .map(a => ({ a, k: Math.min(1, a.w / box.w, a.h / box.h) }))
          .sort((p, q) => q.k - p.k)[0];
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        const every = content.map((_, i) => i);
        const scaled = transformShapes(content, every, scaling(cx, cy, best.k));
        const after = boundsOfAll(scaled)!;
        fitted = transformShapes(scaled, every, translation(
          best.a.x + best.a.w / 2 - (after.x + after.w / 2),
          best.a.y + best.a.h / 2 - (after.y + after.h / 2),
        ));
        percent = Math.round(best.k * 100);
      }
    }

    // The frame goes in front of the rest so it draws underneath: a frame over
    // the geometry is a frame that hides a wire.
    commit([...frameShapes, ...fitted]);
    setNotice(percent < 100 ? T.headerFitted.replace('{n}', String(percent)) : null);
  }, [headerOn, shapes, sheet, headerFields, mmPerUnit, commit, T]);

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
  const [ribbon, setRibbon] = useState<RibbonTab>('home');
  /** The whole set, over the drawing — groups, reports, pages from a list. */
  const [tree, setTree] = useState(false);
  /**
   * The symbol on the cursor, and every other face of it.
   *
   * A symbol used to land in the middle of the view and then have to be found
   * and dragged. It hangs on the pointer instead and lands where it is
   * clicked, which is what every CAD does and what a hand already expects.
   * It stays on the cursor after a click — placing four terminals is four
   * clicks, not four trips to the library — and Escape puts it down for good.
   *
   * `variants` is the family: a breaker's LSI, LSIG and LI are one symbol with
   * three faces, and Tab turns between them without letting go, which is
   * EPLAN's own gesture for exactly this.
   */
  const [placing, setPlacing] = useState<
    { at: number; variants: { name: string; shapes: Shape[]; id?: string }[] } | null>(null);
  const [askDock, setAskDock] = useState<Dock>(() => loadDock(DOCK_KEY));
  const chooseDock = (d: Dock) => { setAskDock(d); saveDock(DOCK_KEY, d); };
  // Where a floating panel has been dragged to, in pixels from the canvas's
  // top-left. Null until somebody moves it, so it opens where it always did.
  const [askAt, setAskAt] = useState<{ x: number; y: number } | null>(null);
  // The page tree docks on the left, on the right or floats, the same way and
  // with the same buttons — it is read while drawing, so covering the sheet
  // with it is the one thing it must not do.
  const [treeDock, setTreeDock] = useState<Dock>(() => loadDock(PAGES_DOCK_KEY));
  const chooseTreeDock = (d: Dock) => { setTreeDock(d); saveDock(PAGES_DOCK_KEY, d); };
  const [treeAt, setTreeAt] = useState<{ x: number; y: number } | null>(null);
  // What the model said when what it said could not be drawn.
  const [askRaw, setAskRaw] = useState<{ error: string; text: string; model: string } | null>(null);
  const [askText, setAskText] = useState('');
  const [asking, setAsking] = useState(false);
  const [askMode, setAskMode] = useState<AskMode>('draw');

  /**
   * A ladder program, onto this sheet.
   *
   * Drawn at the sheet's own size and put down as one undo step, like anything
   * else the assistant produces — so a program that is not what was wanted
   * comes straight back off with Ctrl+Z rather than having to be picked apart.
   *
   * Only the first page: what goes on a sheet is a sheet's worth. A program
   * longer than that belongs in Simorgh Logic, which paginates it and prints
   * the set, and the notice says how much was left behind rather than quietly
   * dropping it.
   */
  const drawLadder = useCallback((result: LadderAskResult) => {
    if (!sheet) return;
    const rendered = renderProgram(result.program, {
      width: sheet.drawing.width,
      height: sheet.drawing.height,
      // The explanation goes on the page, under the rails. The panel beside
      // the drawing is not what gets printed or sent to the customer, and
      // "why the overload holds the seal-in" is the part somebody reads the
      // page for six months later.
      explain: true,
    });
    const first = rendered[0];
    if (!first || first.drawing.shapes.length === 0) {
      setNotice(T.askFailed);
      return;
    }
    draw(first.drawing.shapes);
    setAskOpen(false);
    const left = result.program.rungs.length - first.rungs.length;
    setNotice(
      T.askDrewLadder(first.rungs.length)
      + (left > 0 ? ` · ${left} more would not fit — open Simorgh Logic for the whole set` : '')
      + (result.dropped.length ? ` · ${result.dropped.length} could not be drawn` : ''));
  }, [sheet, draw, T]);

  /**
   * Which of the three documents the open page is.
   *
   * A generated single line and the blank sheet carry no kind, and those are
   * single lines — which is what they always were.
   */
  const drawKind: LibraryKind = sheet?.kind ?? 'sld';

  const askToDraw = useCallback(async () => {
    const prompt = askText.trim();
    if (prompt.length < 3 || !sheet) return;
    setAsking(true);
    setNotice(null);
    // Read now rather than at mount: the office's DXF pack is loaded on another
    // screen, and a symbol added there should be in the assistant's vocabulary
    // without reloading the app.
    const library = libraryItems();
    try {
      const response = await fetch(`${(import.meta as { env?: Record<string, string> }).env?.VITE_API_URL || ''}/api/draw/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          width: sheet.drawing.width,
          height: sheet.drawing.height,
          textSize,
          // Where on the sheet it may draw. Without it the model is told the
          // size of the paper and nothing about the frame, so it draws through
          // the title block or huddles in a corner and fills the rest with a
          // line going nowhere — which is exactly what it did.
          area: designArea(),
          // Which of the three documents this page is. The three are laid out
          // nothing like each other — a single line stands for three phases,
          // a wiring diagram draws all of them, a layout has no wires at all —
          // and the page already knows which it is, so the model is told
          // rather than left to guess from the wording of the request.
          kind: drawKind,
          // The library goes with the question. It lives here, in the browser,
          // and the office adds to it — so the model is told what is in it now
          // rather than what was in it when the server was built, and it names
          // a symbol instead of drawing a box and hoping it reads as a breaker.
          // The page's own library, and only that one: a wiring-diagram coil
          // offered on a single line is a coil that ends up on one.
          symbols: symbolCatalogue(library, drawKind),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) {
        setNotice(body.error || T.askFailed);
        // Keep the panel open and show what the model wrote. "It did not
        // answer with drawable JSON" on its own leaves nowhere to go next.
        setAskRaw({
          error: body.error || T.askFailed,
          text: typeof body.raw === 'string' ? body.raw
            : Array.isArray(body.dropped) ? body.dropped.join('\n') : '',
          model: typeof body.model === 'string' ? body.model : '',
        });
        return;
      }
      setAskRaw(null);
      // The model named symbols; the geometry comes from the library here. A
      // name the library does not have after all is counted with the rest of
      // what was thrown away rather than drawn as something else.
      const { shapes: drawn, missing } = expandSymbols(
        body.shapes as (Shape | SymPlacement)[], library, 'sld');
      if (drawn.length === 0) {
        setNotice(missing.length ? T.askNoSymbols.replace('{s}', missing.join(', ')) : T.askFailed);
        return;
      }
      draw(drawn);
      setAskOpen(false);
      setAskText('');
      // How much was thrown away matters as much as what arrived: a draft
      // that lost half its shapes is one to look over rather than build on.
      const lost = (Number(body.droppedCount) || 0) + missing.length;
      setNotice(lost
        ? T.askDrewSome.replace('{n}', String(drawn.length)).replace('{d}', String(lost))
        : T.askDrew.replace('{n}', String(drawn.length)));
    } catch (err) {
      setNotice(`${T.askFailed} ${(err as Error).message}`);
    } finally {
      setAsking(false);
    }
  }, [askText, sheet, textSize, designArea, draw, T]);


  /**
   * Dragging the floating panel by its title bar.
   *
   * Pointer events on the window rather than on the panel, so the drag
   * survives the cursor outrunning it — a panel that drops the moment the
   * mouse leaves it is worse than one that cannot be moved at all.
   */
  const dragPanel = useCallback(
    (set: (at: { x: number; y: number }) => void) => (e: React.MouseEvent) => {
      const canvas = e.currentTarget.parentElement?.parentElement;
      const box = canvas?.getBoundingClientRect();
      if (!box) return;
      const panel = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
      const grab = { x: e.clientX - panel.left, y: e.clientY - panel.top };
      e.preventDefault();
      const move = (ev: MouseEvent) => {
        set({
          // Kept on the canvas: a panel dragged off the edge is a panel that
          // cannot be dragged back.
          x: Math.max(0, Math.min(box.width - 80, ev.clientX - box.left - grab.x)),
          y: Math.max(0, Math.min(box.height - 32, ev.clientY - box.top - grab.y)),
        });
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }, []);

  const dragAsk = useMemo(() => dragPanel(setAskAt), [dragPanel]);
  const dragTree = useMemo(() => dragPanel(setTreeAt), [dragPanel]);

  /** The text tool has a place; the words come from here. */
  const placeText = useCallback((at: { x: number; y: number }) => {
    const value = window.prompt(T.promptText);
    if (value == null || value.trim() === '') return;
    draw([{
      t: 'text', x: at.x, y: at.y, s: value, size: textSize,
      layer: drawLayer, color: layerColor(drawLayer), width: 0,
    }]);
  }, [draw, textSize, drawLayer, T]);

  /**
   * The connection-point tool has a place; the terminal's name comes from here.
   *
   * The suggestion is the next number this sheet has not used, because most
   * terminals are numbered and the ones that are not — A1, 13, I0.0 — are
   * typed over it in one go. Naming is not optional: an unnamed point is a
   * circle, and a circle connects nothing.
   */
  const placePin = useCallback((at: { x: number; y: number }) => {
    const used = new Set(shapes.map(s => s.pin).filter(Boolean) as string[]);
    let n = 1;
    while (used.has(String(n))) n += 1;
    const value = window.prompt(T.promptPin, String(n));
    if (value == null) return;
    const name = value.trim();
    if (!name) { setNotice(T.promptPinName); return; }
    setNotice(null);
    draw([{
      t: 'circle', cx: at.x, cy: at.y, r: MARK_R,
      layer: 'PIN', color: layerColor('PIN'), width: 0.4, pin: name,
    }]);
  }, [draw, shapes, T]);

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
   * A symbol redrawn for this project, onto the sheets it is already on.
   *
   * Saving a redrawn symbol used to change only what would be drawn next: the
   * pages already drawn hold the old picture as geometry, so the breaker on
   * sheet 3 kept the drawing the office had just replaced. That is the whole
   * of "I edit the symbol and it is not applied in the project".
   *
   * Every sheet this editor holds is looked through — not only the one on
   * screen — and every instance found is swapped for the new drawing, on its
   * own wire and at its own height (see cad/replaceSymbol). It is asked for
   * first, because rewriting a drawing somebody has already corrected by hand
   * is not a thing to do quietly, and because an instance that was turned or
   * mirrored after it was placed comes back the way the library draws it.
   */
  /**
   * A symbol's drawing as one object, ink and connection points together.
   *
   * They have to go through the same scale and the same move, so they are
   * handed over as one run. Left behind, the replacement is a device that
   * looks right and cannot be wired: the wires on the sheet still end where
   * they ended and there is nothing there for them to end on.
   */
  const art = (d: ReturnType<typeof symbolDrawing>): SymbolArt => ({
    shapes: [...d.drawing.shapes, ...terminalMarks(d.terminals)],
    pinX: d.pinX,
  });

  const applyRedrawnSymbol = (
    symbolId: SymbolId,
    before: SymbolArtOverride | undefined,
    after: SymbolArtOverride | undefined,
  ) => {
    const title = IEC_SYMBOLS[symbolId]?.title ?? symbolId;
    // Both drawings are worked out from what was handed in rather than read
    // back out of the symbol module: the project has only just been told about
    // the new one and the module learns of it a render later, so reading it
    // here would replace the old drawing with the old drawing.
    //
    // With no project drawing on either side, what the page holds — and what
    // it goes back to — is the office pack's symbol where there is one, and
    // the library's own where there is not.
    const fromPack = ((): SymbolArtOverride | undefined => {
      const o = packSymbolOverride(symbolId);
      if (!o?.art) return undefined;
      const w = o.width && o.width > 0 ? o.width : 1;
      return {
        art: o.art, width: w, height: o.height && o.height > 0 ? o.height : 1,
        pinX: o.pinX ?? w / 2, cells: o.cells ?? 1, editedAt: '',
      };
    })();
    const was = symbolDrawing(symbolId, before ?? fromPack, true);
    const now = symbolDrawing(symbolId, after ?? fromPack, true);

    const counts = sheets.map((sheet, i) =>
      countInstances(edits[i] ?? sheet.drawing.shapes, symbolId, title));
    const places = counts.reduce((n, c) => n + c, 0);
    if (places === 0) {
      setNotice(T.symbolRedrawnNone(title));
      return;
    }
    const pageCount = counts.filter(c => c > 0).length;
    if (!window.confirm(T.symbolRedrawnAsk(title, places, pageCount))) {
      setNotice(T.symbolRedrawnKept(title));
      return;
    }

    const next: Record<number, Shape[]> = { ...edits };
    const changed = new Set<number>(touched);
    let done = 0;
    sheets.forEach((sheet, i) => {
      const current = edits[i] ?? sheet.drawing.shapes;
      // The connection points go down with the ink — see `art`.
      const swap = replaceSymbolInstances(current, symbolId, title, art(was), art(now));
      if (swap.count === 0) return;
      historyFor(i).push(current);
      next[i] = swap.shapes;
      changed.add(i);
      done += swap.count;
    });
    if (done === 0) { setNotice(T.symbolRedrawnNone(title)); return; }

    setEdits(next);
    setTouched(changed);
    setSelection(new Set());
    forceRender(n => n + 1);
    setNotice(T.symbolRedrawnDone(title, done, pageCount));
  };

  /**
   * A symbol chosen in the library: onto the cursor, not onto the sheet.
   *
   * Nothing is committed here. The library closes, the symbol follows the
   * pointer, and the click that puts it down is the one that changes the
   * drawing — so an undo step is made when something is actually placed
   * rather than when a panel was closed.
   */
  const importSymbol = (
    run: Shape[], name: string,
    variants?: { name: string; shapes: Shape[]; id?: string }[],
  ) => {
    if (run.length === 0) return;
    const family = variants?.length ? variants : [{ name, shapes: run }];
    const at = Math.max(0, family.findIndex(v => v.name === name));
    setShowLibrary(false);
    setPlacing({ at, variants: family });
    setTool('place');
    setSelection(new Set());
    setNotice(family.length > 1 ? T.libOnCursorTab(name, family.length) : T.libOnCursor(name));
  };

  /** The symbol on the cursor, moved so its top-left sits at the origin. */
  const ghost = useMemo(() => {
    if (!placing) return null;
    const run = placing.variants[placing.at]?.shapes ?? [];
    const box = boundsOfAll(run);
    return box ? run.map(sh => translateShape(sh, -box.x, -box.y)) : run;
  }, [placing]);

  /** The face on the cursor, put down here as one block. */
  const dropGhost = (at: Pt) => {
    if (!placing) return;
    const face = placing.variants[placing.at];
    if (!face) return;
    const placed = placeAsBlock(face.shapes, at, face.name, 1, face.id);
    if (placed.length === 0) return;
    historyFor(index).push(shapes);
    const next = [...shapes, ...placed];
    setEdits(e => ({ ...e, [index]: next }));
    touch(index);
    forceRender(n => n + 1);
    // Still on the cursor, so a second one is a second click. Said out loud,
    // because a symbol that will not let go is alarming when it is a surprise.
    setNotice(T.libPlacedAgain(face.name));
  };

  /** The next face of the symbol on the cursor — Tab forward, Shift+Tab back. */
  const turnVariant = (by: number) => setPlacing(p => (p && p.variants.length > 1
    ? { ...p, at: (p.at + by + p.variants.length) % p.variants.length }
    : p));

  // A symbol on the cursor belongs to the place tool and to nothing else:
  // reaching for Line or Select puts it down without placing it.
  useEffect(() => { if (tool !== 'place') setPlacing(null); }, [tool]);

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
    if (sheet) setView(fitView(sheet.drawing, fitPad));
  }, [sheet, fitPad]);

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

  /**
   * Every symbol this project draws its own way, put on every page of the set.
   *
   * The office redraws a symbol and asks for the whole job to be laid out
   * again with it. Until now that could not be done and, worse, it could not
   * be *reported* as not done: the single line is generated as SVG and read
   * back as geometry, so a breaker on a sheet was eleven lines that had
   * stopped being a breaker, and the command to replace it searched every page
   * and truthfully found nothing. The pages are stamped now (see
   * `eplanSingleLine`), so every device on them can be found again by what it
   * is.
   *
   * `from` is the library's own drawing and `to` is whatever is drawn for that
   * id now. That pairing is what a page holds: a page drawn before the symbol
   * was redrawn has the built-in one on it. A page that already has an older
   * *override* on it is the one case this does not place exactly — the
   * conductor is worked out from the drawing being replaced, and that one is
   * a drawing nobody kept. Redrawing a symbol offers to update the pages at
   * the time, which is the moment both versions are still known, and this is
   * for catching up everything that was not there for it.
   */
  const redrawAllSymbols = () => {
    const ids = redrawnSymbolIds();
    if (ids.length === 0) { setNotice(T.redrawAllNothingRedrawn); return; }

    const work = ids.map(id => ({
      id,
      title: IEC_SYMBOLS[id]?.title ?? id,
      was: symbolDrawing(id, undefined, true),
      now: symbolDrawing(id, undefined, false),
    }));

    const counts = sheets.map((sheet, i) => {
      const run = edits[i] ?? sheet.drawing.shapes;
      return work.reduce((n, w) => n + countInstances(run, w.id, w.title), 0);
    });
    const places = counts.reduce((n, c) => n + c, 0);
    if (places === 0) { setNotice(T.redrawAllNone); return; }
    const pageCount = counts.filter(c => c > 0).length;
    if (!window.confirm(T.redrawAllAsk(work.length, places, pageCount))) return;

    const next: Record<number, Shape[]> = { ...edits };
    const changed = new Set<number>(touched);
    let done = 0;
    sheets.forEach((sheet, i) => {
      let run = edits[i] ?? sheet.drawing.shapes;
      const started = run;
      for (const w of work) {
        const swap = replaceSymbolInstances(run, w.id, w.title, art(w.was), art(w.now));
        if (swap.count === 0) continue;
        run = swap.shapes;
        done += swap.count;
      }
      if (run === started) return;
      historyFor(i).push(started);
      next[i] = run;
      changed.add(i);
    });
    if (done === 0) { setNotice(T.redrawAllNone); return; }

    setEdits(next);
    setTouched(changed);
    setSelection(new Set());
    forceRender(n => n + 1);
    setNotice(T.redrawAllDone(done, changed.size));
  };

  /**
   * Every sheet's edits, merged onto what the project already holds.
   *
   * Used by Save and by every page command, which is the point of it being a
   * function: adding a page swaps the whole `sheets` array and re-seeds this
   * editor from the project, so a page command that did not carry the edits
   * across would silently throw away whatever had been drawn since the last
   * Save. The bug it prevents is the worst kind — it looks like the drawing
   * was never there.
   */
  const pendingEdits = (): DrawingEdits => {
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
    return next;
  };

  /** Hand every sheet's edits to the project, and drop the ones undone away. */
  const keep = () => {
    if (!onSaveEdits) return;
    onSaveEdits(pendingEdits());
    setTouched(new Set());
  };

  // A host framing this editor gets its Save, so the command can be put where
  // the person is looking instead of only in the ribbon.
  if (saveHandle) saveHandle.current = keep;

  // ── The page set, from inside the drawing ───────────────────────────────
  //
  // Everything here writes the set and the edits in one call and then clears
  // `touched`: the parent has taken the drawings, and the new `sheets` array
  // is about to re-seed this editor from them.

  const page = pages?.[index];

  /** A page of this kind, in the group the current page is filed under. */
  const addPage = (type: PageType) => {
    if (!pages || !onPages) return;
    const made = newPage(pages, type, '', page?.path ?? []);
    onPages([...pages, made], pendingEdits(), pageGroups);
    setTouched(new Set());
    setIndex(pages.length);
    setNotice(T.pageAdded(made.name));
  };

  const renamePage = () => {
    if (!pages || !onPages || !page) return;
    const name = window.prompt(T.pageRenameAsk, page.name);
    if (name == null) return;
    const note = window.prompt(T.pageNoteAsk, page.description ?? '');
    if (note == null) return;
    onPages(
      pages.map(p => (p.id === page.id
        ? { ...p, name: name.trim() || p.name, description: note.trim() }
        : p)),
      pendingEdits(), pageGroups,
    );
    setTouched(new Set());
  };

  const duplicatePage = () => {
    if (!pages || !onPages || !page) return;
    const copy = copyOfPage(pages, page);
    const next = pendingEdits();
    const kept = next[pageKey(page.id)];
    // A copy of the page, not a new page with the same name.
    if (kept) next[pageKey(copy.id)] = { ...kept, editedAt: new Date().toISOString() };
    onPages([...pages.slice(0, index + 1), copy, ...pages.slice(index + 1)], next, pageGroups);
    setTouched(new Set());
    setIndex(index + 1);
    setNotice(T.pageAdded(copy.name));
  };

  const deletePage = () => {
    if (!pages || !onPages || !page) return;
    if (pages.length < 2) { setNotice(T.pageLastOne); return; }
    if (!window.confirm(T.pageDeleteAsk(page.name))) return;
    const next = pendingEdits();
    delete next[pageKey(page.id)];
    onPages(pages.filter(p => p.id !== page.id), next, pageGroups);
    setTouched(new Set());
    setIndex(Math.max(0, index - 1));
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
      // A symbol on the cursor takes Tab and Escape before anything else does.
      // Tab would otherwise walk the browser's focus ring off the canvas,
      // which is the one thing it must not do while something is being aimed.
      if (placing) {
        if (e.key === 'Tab') {
          e.preventDefault();
          turnVariant(e.shiftKey ? -1 : 1);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPlacing(null);
          setTool('select');
          setNotice(null);
          return;
        }
      }
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
    : tool === 'place' && placing
      ? (placing.variants.length > 1
        ? T.hintPlaceVariants(
          placing.variants[placing.at]?.name ?? '', placing.at + 1, placing.variants.length)
        : T.hintPlace)
    : tool === 'pin' ? T.hintPin
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

  // The bar's buttons are defined outside this component so that React keeps
  // the same ones from render to render instead of rebuilding the whole bar.
  const Tool = ToolBtn;

  /**
   * The page tree as a panel: title bar, the three dock buttons, the tree.
   *
   * The same markup wherever it is parked, so docking it is a matter of which
   * frame it is put in and nothing else. It was a modal over the drawing until
   * now, which meant every look at the set hid the sheet the set is for and
   * had to be shut again before a line could be drawn.
   */
  const treePanel = (dock: Dock) => (
    <>
      <div
        className={`flex items-center justify-between px-3 py-2 bg-slate-700 text-white ${
          dock === 'float' ? 'cursor-move' : ''}`}
        onMouseDown={dock === 'float' ? dragTree : undefined}
      >
        <p className="text-sm font-semibold flex items-center gap-1.5 min-w-0">
          <FilesIcon className="w-4 h-4 shrink-0" />
          <span className="truncate">{T.pageTree.split(' — ')[0]}</span>
        </p>
        <DockButtons
          t={T} dock={dock} dark onDock={chooseTreeDock} onClose={() => setTree(false)}
        />
      </div>
      {pages && (
        <PageNavigator
          compact
          dir={dir}
          pages={pages}
          groups={pageGroups}
          edits={pendingEdits()}
          canEdit={canEdit && Boolean(onPages)}
          currentId={page?.id}
          fileBase={fileBase}
          onChange={(next, nextEdits, nextGroups) => {
            onPages?.(next, nextEdits, nextGroups);
            setTouched(new Set());
          }}
          onOpen={id => {
            // The panel stays open. That is what docking it is for: page
            // through the set with the sheet beside it, not one look per trip.
            const at = pages.findIndex(p => p.id === id);
            if (at >= 0) setIndex(at);
          }}
        />
      )}
    </>
  );

  return (
    <div
      ref={frame}
      data-sd-theme={themeId}
      className={`overflow-hidden bg-white select-none ${
        embedded
          ? 'h-full min-h-0 flex flex-col'
          : 'border border-gray-200 rounded-lg'} ${
        fullscreen ? 'fixed inset-0 z-[300] rounded-none border-0 flex flex-col' : ''}`}
    >
      {/* ── Ribbon ─────────────────────────────────────────────────────── */}
      {/*
        The commands, grouped under captions rather than run out as one long
        row of pictures.

        The row was fine at fifteen commands and stopped being fine at sixty.
        It wrapped to three lines, and the group on the end — the one carrying
        the model, the wire numbers and the rule checks — was a single flex
        child that could not wrap at all, so on a narrower window it ran off
        the edge and the overflow rule cut it off. That is where the AI button
        had been hiding. Both complaints are the same fault, and a ribbon
        answers both: every command sits under a caption that says what it is
        for, the panels wrap instead of running off the end, and what is not on
        the open tab is one click away instead of off the screen.

        Four tabs and no more. This draws switchboards, not buildings, so the
        hatches, the 3-D and the sheet-set manager a general CAD package
        carries have no business here.
      */}
      <div className="bg-gray-100 border-b">
        {/* The tabs, and the few commands that stay put behind them: which
            sheet, the model, undo, save, the way out of full screen. Wanted on
            every tab, so they belong to none of them. */}
        <div className="flex items-end gap-1 px-2 pt-1">
          {TABS.filter(t => t.id !== 'page' || pages).map(t => (
            <button
              key={t.id}
              data-ribbon={t.id}
              onClick={() => setRibbon(t.id)}
              className={`rounded-t-md border border-b-0 px-3.5 py-1 text-[12px] font-medium transition-colors ${
                ribbon === t.id
                  ? 'bg-white border-gray-200 text-slate-800'
                  : 'border-transparent text-gray-500 hover:bg-gray-200 hover:text-slate-700'}`}
            >
              {T[t.name]}
            </button>
          ))}

          <div className="ms-auto flex items-center gap-1 pb-1">
            {sheets.length > 1 && (
              <select
                className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                value={index}
                onChange={e => setIndex(Number(e.target.value))}
              >
                {sheets.map((s, i) => (
                  <option key={i} value={i}>{s.name}{isEdited(i) ? ' •' : ''}</option>
                ))}
              </select>
            )}
            {/* The model. Up here, beside undo, because asking it for a draft
                is not a mode you switch into — it is something you reach for
                in the middle of whatever tab you are already on. */}
            <button
              onClick={() => setAskOpen(o => !o)}
              title={T.askTip}
              data-tool="ask"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-white ${
                askOpen ? 'bg-violet-900' : 'bg-violet-700 hover:bg-violet-800'}`}
            >
              {/* Our own mark, not a generic sparkle. Every product on the
                  market puts the same star on its AI button; this one is the
                  bird off the splash screen, and it is ours.
                  Forced to white: the mark is drawn in navy, and navy on
                  violet is a shape you have to look for. */}
              <img
                src={logoMark}
                alt=""
                aria-hidden
                className="w-4 h-4 object-contain brightness-0 invert"
              />
              {T.ask}
            </button>
            <Tool title={T.undo} keyHint="Ctrl+Z" disabled={!history.canUndo} on={undo}>
              <UndoIcon className="w-4 h-4" />
            </Tool>
            <Tool title={T.redo} keyHint="Ctrl+Y" disabled={!history.canRedo} on={redo}>
              <RedoIcon className="w-4 h-4" />
            </Tool>
            <Tool
              tag="save"
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
            <Tool
              tag="fullscreen"
              title={fullscreen ? T.leaveFullscreen : T.fullscreen}
              on={toggleFullscreen}
              hide={lean}
            >
              {fullscreen ? <Minimize2Icon className="w-4 h-4" /> : <Maximize2Icon className="w-4 h-4" />}
            </Tool>
          </div>
        </div>

        {/* The open tab's panels. They wrap rather than run off the end, which
            is the whole of the complaint the old bar earned: at every width,
            full screen or not, every command on the tab is on the screen. It
            is wrap and not a scrollbar on purpose — an `overflow` here would
            clip the tooltips, and the tooltips are what make a row of pictures
            readable in the first place. */}
        <div className="flex flex-wrap items-stretch bg-white px-1">
          {ribbon === 'home' && (
            <>
              <RibbonPanel name={T.panDraw}>
                {DRAW_BIG.map(t => (
                  <Tool key={t.id} tag={t.id} label title={T[t.name]} keyHint={t.key}
                        active={tool === t.id} on={() => setTool(t.id)}>
                    <t.Icon className="w-5 h-5" />
                  </Tool>
                ))}
                <Stack>
                  {DRAW_SMALL.map(t => (
                    <Tool key={t.id} tag={t.id} title={T[t.name]} keyHint={t.key}
                          active={tool === t.id} on={() => setTool(t.id)}>
                      <t.Icon className="w-4 h-4" />
                    </Tool>
                  ))}
                </Stack>
              </RibbonPanel>

              <RibbonPanel name={T.panModify}>
                <Tool label title={T.duplicate} keyHint="Ctrl+D" disabled={selection.size === 0} on={duplicate}>
                  <CopyIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={T.del} keyHint="Del" disabled={selection.size === 0} on={remove}>
                  <Trash2Icon className="w-5 h-5" />
                </Tool>
                <Stack>
                  {EDIT_TOOLS.map(t => (
                    <Tool key={t.id} tag={t.id} title={T[t.name]} keyHint={t.key}
                          active={tool === t.id} on={() => setTool(t.id)}>
                      <t.Icon className="w-4 h-4" />
                    </Tool>
                  ))}
                  <Tool title={T.rotateCCW} disabled={selection.size === 0} on={() => rotateBy(-90)}>
                    <RotateCcwIcon className="w-4 h-4" />
                  </Tool>
                  <Tool title={T.rotateCW} disabled={selection.size === 0} on={() => rotateBy(90)}>
                    <RotateCwIcon className="w-4 h-4" />
                  </Tool>
                  <Tool title={T.rotateFree} disabled={selection.size === 0} on={rotateFree}>
                    <span className="text-[11px] font-semibold leading-none px-0.5">∠</span>
                  </Tool>
                  <Tool title={T.scale} disabled={selection.size === 0} on={scaleFree}>
                    <ScalingIcon className="w-4 h-4" />
                  </Tool>
                  <Tool title={T.mirrorH} disabled={selection.size === 0}
                        on={() => transform(cx => mirrorX(cx))}>
                    <FlipHorizontalIcon className="w-4 h-4" />
                  </Tool>
                  <Tool title={T.mirrorV} disabled={selection.size === 0}
                        on={() => transform((_, cy) => mirrorY(cy))}>
                    <FlipVerticalIcon className="w-4 h-4" />
                  </Tool>
                </Stack>
                {/* The corner command wants a radius before it wants a second
                    line, so the box appears with the command and not before. */}
                {tool === 'corner' && (
                  <label className="flex flex-col gap-0.5 text-[10px] text-gray-500 ps-1"
                         title={T.promptRadius}>
                    {T.cornerRadius}
                    <input
                      type="number" min={0} step={1} value={cornerRadius}
                      onChange={e => setCornerRadius(Math.max(0, Number(e.target.value) || 0))}
                      className="w-16 border border-gray-300 rounded px-1.5 py-1 text-sm"
                    />
                  </label>
                )}
              </RibbonPanel>

              <RibbonPanel name={T.panArrange}>
                <Stack>
                  {ALIGNS.map(a => (
                    <Tool key={a.to} title={T[a.name] as string} disabled={selection.size < 2}
                          on={() => align(a.to)}>
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
                </Stack>
              </RibbonPanel>

              {/* How the next line is drawn, and how the picked ones are.
                  Changing one with something selected restyles that, which is
                  the shortest path from "that should be dashed" to it being
                  dashed. */}
              <RibbonPanel name={T.panProps}>
                <div className="grid grid-cols-2 gap-1">
                  <select
                    className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                    value={drawLayer}
                    onChange={e => { setDrawLayer(e.target.value as Layer); restyle({ layer: e.target.value as Layer }); }}
                    title={T.layerOf}
                  >
                    {(Object.keys(LAYERS) as Layer[]).map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                  <select
                    className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                    value={drawLine}
                    onChange={e => {
                      setDrawLine(e.target.value);
                      restyle({ dash: LINE_TYPES.find(l => l.id === e.target.value)?.dash ?? '' });
                    }}
                    title={T.lineTypeOf}
                  >
                    {LINE_TYPES.map(l => <option key={l.id} value={l.id}>{T[l.name]}</option>)}
                  </select>
                  <select
                    className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                    value={drawWidth}
                    onChange={e => { setDrawWidth(Number(e.target.value)); restyle({ width: Number(e.target.value) }); }}
                    title={T.widthOf}
                  >
                    {WIDTHS.map(w => <option key={w} value={w}>{w.toFixed(1)}</option>)}
                  </select>
                  <div className="flex items-center gap-1">
                    {/* Colour. CAD takes an entity's colour from its layer, so
                        this is an SVG and PDF matter only and the DXF is
                        unaffected — which is why it is a plain swatch and not
                        anywhere near the layer box. With something picked it
                        recolours that; with nothing picked it sets what is
                        drawn next, the way the boxes beside it already do. */}
                    <label
                      className="flex items-center gap-1 border border-gray-300 rounded px-1.5 py-1 bg-white cursor-pointer"
                      title={selection.size > 0 ? T.colourOfPicked : T.colourOfNew}
                    >
                      <PaletteIcon className="w-3.5 h-3.5 text-gray-500" />
                      <input
                        type="color"
                        className="w-6 h-5 border-0 bg-transparent p-0 cursor-pointer"
                        value={drawColor}
                        onChange={e => {
                          setDrawColor(e.target.value);
                          if (selection.size > 0) restyle({ color: e.target.value });
                        }}
                      />
                    </label>
                    {selection.size > 0 && (
                      <button
                        onClick={() => restyle({ color: '' })}
                        title={T.colourClear}
                        className="px-2 py-1 rounded border border-gray-300 bg-white text-xs text-gray-600 hover:bg-gray-100"
                      >
                        {T.colourClearShort}
                      </button>
                    )}
                  </div>
                  {(tool === 'text' || tool === 'dim' || picked.some(p => p.t === 'text')) && (
                    <select
                      className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                      value={textSize}
                      onChange={e => { setTextSize(Number(e.target.value)); restyle({ size: Number(e.target.value) }); }}
                      title={T.textHeightOf}
                    >
                      {TEXT_SIZES.map(v => <option key={v} value={v}>{v} u</option>)}
                    </select>
                  )}
                </div>
              </RibbonPanel>

              {/* A symbol is one thing, so it comes in as one and can be made
                  into one. The library sits with the commands that act on
                  blocks. */}
              <RibbonPanel name={T.panBlock}>
                <Tool tag="library" label title={T.openLibrary} hide={lean} on={() => setShowLibrary(true)}>
                  <LibraryBigIcon className="w-5 h-5" />
                </Tool>
                {/* Beside the library, because it is the library this puts on
                    the pages: redraw a symbol, then bring the whole set up to
                    it in one go. In both ribbons the library is in, for the
                    same reason the library is in both. */}
                <Tool tag="redraw-all" label title={`${T.redrawAll} — ${T.redrawAllTip}`}
                      hide={lean} on={redrawAllSymbols}>
                  <RefreshCwIcon className="w-5 h-5" />
                </Tool>
                <Stack>
                  <Tool tag="group" title={T.group} keyHint="Ctrl+G"
                        disabled={selection.size < 2} on={group}>
                    <GroupIcon className="w-4 h-4" />
                  </Tool>
                  <Tool tag="ungroup" title={T.ungroup} keyHint="Ctrl+Shift+G"
                        disabled={selection.size === 0} on={ungroup}>
                    <UngroupIcon className="w-4 h-4" />
                  </Tool>
                </Stack>
              </RibbonPanel>
            </>
          )}

          {ribbon === 'page' && pages && (
            <>
              <RibbonPanel name={T.panPage}>
                {SYMBOL_LIBRARIES.map(lib => (
                  <Tool
                    key={lib.kind}
                    label
                    title={`${T.pageNew} ${lib.code} — ${lib.note}`}
                    disabled={!onPages || !canEdit}
                    on={() => addPage(lib.kind)}
                  >
                    <FilePlusIcon className="w-5 h-5" />
                  </Tool>
                ))}
              </RibbonPanel>

              <RibbonPanel name={T.panPageThis}>
                <Tool label title={T.pageRename} disabled={!onPages || !canEdit} on={renamePage}>
                  <PencilIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={T.pageDuplicate} disabled={!onPages || !canEdit} on={duplicatePage}>
                  <CopyIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={T.pageDelete} disabled={!onPages || !canEdit} on={deletePage}>
                  <Trash2Icon className="w-5 h-5" />
                </Tool>
                <Stack>
                  <Tool
                    title={T.pagePrev}
                    disabled={index <= 0}
                    on={() => setIndex(i => Math.max(0, i - 1))}
                  >
                    <ChevronLeftIcon className="w-4 h-4" />
                  </Tool>
                  <Tool
                    title={T.pageNext}
                    disabled={index >= sheets.length - 1}
                    on={() => setIndex(i => Math.min(sheets.length - 1, i + 1))}
                  >
                    <ChevronRightIcon className="w-4 h-4" />
                  </Tool>
                </Stack>
                <span className="flex items-center px-2 text-[11px] text-gray-500">
                  {T.pageOf(index + 1, sheets.length)}
                </span>
              </RibbonPanel>

              {/* The tree itself, beside the drawing. Everything the project's
                  own Pages tab can do — groups, the four reports, a set of
                  wiring pages read off an I/O list — in a column that stays
                  open while you draw. The button turns it off again. */}
              <RibbonPanel name={T.panSheet}>
                <Tool label title={T.pageTree} active={tree} on={() => setTree(v => !v)}>
                  <FilesIcon className="w-5 h-5" />
                </Tool>
              </RibbonPanel>
            </>
          )}

          {ribbon === 'elec' && (
            <>
              {/* What makes it a wiring diagram rather than a picture of one.
                  These read the geometry back — which lines share a node, which
                  symbol has no designation — so they belong together and away
                  from the commands that simply add shapes. */}
              <RibbonPanel name={T.panAnnotate}>
                <Tool label title={`${T.wireNumber} — ${T.wireNumberTip}`} on={() => doNumberWires(false)}>
                  <HashIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={`${T.tagDevices} — ${T.tagDevicesTip}`} on={doTagDevices}>
                  <TagIcon className="w-5 h-5" />
                </Tool>
              </RibbonPanel>

              <RibbonPanel name={T.panCheck}>
                <Tool
                  label
                  title={`${T.checks}${messages && messages.length ? ` (${messages.length})` : ''} — ${T.checksTip}`}
                  tone={messages && messages.some(m => m.cls === 'error') ? 'alarm' : 'plain'}
                  on={runChecks}
                >
                  <ShieldCheckIcon className="w-5 h-5" />
                </Tool>
                {xrefs.length > 0 && (
                  <span className="flex items-center gap-1 px-1 text-[11px] text-gray-500"
                        title={T.xrefs}>
                    <LinkIcon className="w-3.5 h-3.5" />{xrefs.length}
                  </span>
                )}
              </RibbonPanel>

              <RibbonPanel name={T.panTable}>
                <Tool label title={`${T.xlsxImport} — ${T.xlsxImportTip}`} on={importXlsx}>
                  <TableIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={`${T.dxfImport} — ${T.dxfImportTip}`}
                      hide={ownDxfImport}
                      on={() => dxfInput.current?.click()}>
                  <FileInputIcon className="w-5 h-5" />
                </Tool>
                {/* One Update per imported table, named after its file: with
                    several on a sheet, "Update" on its own would not say which.
                    Only shown where the browser handed back a handle — without
                    one the file cannot be re-read and the button would lie. */}
                {liveTables.filter(t => t.handle).map(t => (
                  <button
                    key={t.id}
                    onClick={() => updateXlsx(t.id)}
                    title={`${T.xlsxUpdateTip} — ${t.name}`}
                    className="flex items-center gap-1.5 self-start px-3 py-1.5 rounded-md bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800"
                  >
                    <RefreshCwIcon className="w-4 h-4" />
                    {T.xlsxUpdate}: {t.name.length > 18 ? `${t.name.slice(0, 16)}…` : t.name}
                  </button>
                ))}
              </RibbonPanel>

              <RibbonPanel name={T.panBlock}>
                <Tool tag="library" label title={T.openLibrary} hide={lean} on={() => setShowLibrary(true)}>
                  <LibraryBigIcon className="w-5 h-5" />
                </Tool>
                <Tool tag="redraw-all" label title={`${T.redrawAll} — ${T.redrawAllTip}`}
                      hide={lean} on={redrawAllSymbols}>
                  <RefreshCwIcon className="w-5 h-5" />
                </Tool>
              </RibbonPanel>
            </>
          )}

          {ribbon === 'out' && (
            <>
              <RibbonPanel name={T.panSheet}>
                {/* The frame and the title block. On the sheet, not bolted on
                    by the exporter — so what is on the screen while you draw
                    is what comes out of the plotter. */}
                <Tool
                  tag="header"
                  label
                  title={`${T.header} — ${headerOn ? T.headerOff : T.headerTip}`}
                  active={headerOn}
                  on={doHeader}
                >
                  <FrameIcon className="w-5 h-5" />
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
                    className={`self-center text-[11px] tabular-nums ${
                      smallest < LEGIBLE_MM ? 'text-amber-700 font-medium' : 'text-gray-500'}`}
                    title={smallest < LEGIBLE_MM
                      ? `The smallest label plots at ${smallest.toFixed(2)} mm, under the ${LEGIBLE_MM} mm a drawing stays readable at. Fewer feeders to a sheet, or a bigger sheet.`
                      : `The smallest label plots at ${smallest.toFixed(2)} mm.`}
                  >
                    text {smallest.toFixed(1)} mm
                  </span>
                )}
              </RibbonPanel>

              <RibbonPanel name={T.panExport}>
                <button
                  onClick={exportDxf}
                  className="flex items-center gap-1.5 self-start px-3 py-1.5 rounded-md bg-teal-700 text-white text-sm font-medium hover:bg-teal-800"
                >
                  <DownloadIcon className="w-4 h-4" /> DXF
                </button>
                <button
                  onClick={exportPdf}
                  className="flex items-center gap-1.5 self-start px-3 py-1.5 rounded-md bg-rose-700 text-white text-sm font-medium hover:bg-rose-800"
                  title="Vector PDF, one page per sheet. Latin text only — use Print / PDF for Persian."
                >
                  <DownloadIcon className="w-4 h-4" /> PDF
                </button>
                <button
                  onClick={exportSvg}
                  className="flex items-center gap-1.5 self-start px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 text-sm font-medium hover:bg-gray-100"
                >
                  <DownloadIcon className="w-4 h-4" /> SVG
                </button>
              </RibbonPanel>

              <RibbonPanel name={T.panKeep}>
                <Tool
                  label
                  title={
                    !onSaveEdits ? T.cannotKeep
                    : !canEdit ? T.readOnly
                    : dirty ? T.save
                    : T.savedAlready
                  }
                  disabled={!onSaveEdits || !canEdit || !dirty}
                  on={keep}
                >
                  <SaveIcon className="w-5 h-5" />
                </Tool>
                <Tool label title={T.revert} disabled={!edited} on={revert}>
                  <RotateCcwIcon className="w-5 h-5" />
                </Tool>
                {onSaveEdits && canEdit && (anySaved || dirty) && (
                  <button
                    onClick={discardAll}
                    className="self-start px-2 py-1.5 rounded-md border border-gray-300 bg-white text-xs text-gray-600 hover:bg-gray-100"
                    title={T.discardAllTip}
                  >
                    {T.discardAll}
                  </button>
                )}
              </RibbonPanel>
            </>
          )}

          {ribbon === 'view' && (
            <>
              <RibbonPanel name={T.panZoom}>
                <Tool label title={T.fit} on={fit}><MaximizeIcon className="w-5 h-5" /></Tool>
                <Stack>
                  <Tool title={T.zoomIn} on={() => zoom(1 / 1.3)}><ZoomInIcon className="w-4 h-4" /></Tool>
                  <Tool title={T.zoomOut} on={() => zoom(1.3)}><ZoomOutIcon className="w-4 h-4" /></Tool>
                  <Tool title={T.zoomSel} disabled={selection.size === 0} on={zoomToSelection}>
                    <ScanSearchIcon className="w-4 h-4" />
                  </Tool>
                  <Tool tag="pan" title={T.pan} keyHint="H" active={tool === 'pan'}
                        on={() => setTool('pan')}>
                    <HandIcon className="w-4 h-4" />
                  </Tool>
                </Stack>
              </RibbonPanel>

              <RibbonPanel name={T.panAids}>
                <Tool label title={T.grid} active={showGrid} on={() => setShowGrid(g => !g)}>
                  <GridIcon className="w-5 h-5" />
                </Tool>
                <Tool
                  label
                  title={objectSnap ? T.osnapOn : T.osnapOff}
                  active={objectSnap}
                  on={() => setObjectSnap(v => !v)}
                >
                  <MagnetIcon className="w-5 h-5" />
                </Tool>
                <select
                  className="self-start border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                  value={snap}
                  onChange={e => setSnap(Number(e.target.value))}
                  title={T.snapTo}
                >
                  {SNAPS.map(v => <option key={v} value={v}>{v === 0 ? T.noSnap : `${v}`}</option>)}
                </select>
              </RibbonPanel>

              <RibbonPanel name={T.panApp}>
                {/* Light or dark. A sheet is looked at for hours; every CAD
                    package on a draughtsman's desk offers this, for that
                    reason and not for fashion. */}
                <Tool
                  tag="theme"
                  label
                  title={themeId === 'dark' ? T.themeLight : T.themeDark}
                  on={() => chooseTheme(themeId === 'dark' ? 'light' : 'dark')}
                >
                  {themeId === 'dark' ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
                </Tool>
                <Tool tag="help" label title={T.help} keyHint="F1" active={showHelp}
                      on={() => setShowHelp(h => !h)}>
                  <CircleHelpIcon className="w-5 h-5" />
                </Tool>
                {/* Which language the editor speaks. Three buttons rather than
                    a dropdown: it is the kind of choice that should be one
                    click, and a reader looking for their own script finds it
                    by its shape. */}
                <div className="self-start flex items-center rounded-md border border-gray-300 overflow-hidden">
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
              </RibbonPanel>
            </>
          )}
        </div>

        {/* Not rendered at all where the host brings its own DXF in. Hiding
            the button would leave this behind, and a hidden file input is not
            inert — it is still the first one on the page, still reachable, and
            still wired to the *other* meaning of importing a DXF. On the
            symbol page that is the exact difference between replacing the
            drawing and dropping a second copy of it beside the first. */}
        {!ownDxfImport && (
          <input
            ref={dxfInput}
            type="file"
            accept=".dxf"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              // Cleared so choosing the same file twice still fires onChange.
              e.target.value = '';
              if (file) placeDxf(file);
            }}
          />
        )}

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

      {/* ── Canvas and panels ──────────────────────────────────────────── */}
      <div
        className={fullscreen || embedded ? 'flex flex-1 min-h-0' : 'flex'}
        style={fullscreen || embedded ? undefined : { height: 620 }}
      >
        {/* The set, docked left — outermost, so the tree reads as the frame
            the drawing sits in rather than as one more panel beside it. */}
        {tree && pages && treeDock === 'left' && (
          <aside className="w-[24rem] shrink-0 flex flex-col min-h-0 border-e border-gray-200 bg-white">
            {treePanel('left')}
          </aside>
        )}

        {/* Docked left: a column of its own, so it takes room from the canvas
            instead of covering the sheet it is drawing on. */}
        {askOpen && askDock === 'left' && (
          <aside className="w-[22rem] shrink-0 flex flex-col border-e border-gray-200 bg-white">
            <AskPanel
              t={T} text={askText} onText={setAskText} asking={asking}
              onGo={askToDraw} onClose={() => setAskOpen(false)}
              dock={askDock} onDock={chooseDock} raw={askRaw}
              mode={askMode} onMode={setAskMode} onProgram={drawLadder}
              kind={drawKind}
            />
          </aside>
        )}
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
            guides={guides}
            onView={setView}
            onSelection={setSelection}
            onMove={(dx, dy) => nudge(dx, dy)}
            onCursor={setCursor}
            onDraw={draw}
            onPlaceText={placeText}
            onPlacePin={placePin}
            ghost={ghost}
            onPlaceGhost={dropGhost}
            onPick={command}
            onGrip={grip}
            onDrafting={setDrafting}
            onCancelTool={() => {
              setPendingCorner(null);
              setPlacing(null);
              setTool('select');
            }}
            onEditText={i => {
              const current = shapes[i];
              // A connection point carries its name on the pen rather than as
              // words on the sheet, so renaming it is a different edit from
              // retyping a label — the same gesture, a different field.
              if (current.pin && current.t !== 'text') {
                const value = window.prompt(T.promptPin, current.pin);
                if (value == null) return;
                const name = value.trim();
                if (!name) { setNotice(T.promptPinName); return; }
                if (name !== current.pin) {
                  commit(shapes.map((s, j) => (j === i ? { ...s, pin: name } : s)));
                }
                return;
              }
              if (current.t !== 'text') return;
              const value = window.prompt(T.promptText, current.s);
              if (value !== null && value !== current.s) commit(setText(shapes, i, value));
            }}
          />
          {showHelp && (
            <DrawingHelp lang={lang} t={T} onClose={() => setShowHelp(false)} />
          )}
          {/* The model's panel, floating. Docked, it is not here at all —
              it is a column beside the canvas, further down. */}
          {askOpen && askDock === 'float' && (
            <div
              className="absolute z-30 w-[24rem] rounded-lg border border-violet-300 bg-white shadow-xl"
              style={askAt
                ? { left: askAt.x, top: askAt.y }
                : { left: 8, top: 8 }}
            >
              <AskPanel
                t={T} text={askText} onText={setAskText} asking={asking}
                onGo={askToDraw} onClose={() => setAskOpen(false)}
                dock={askDock} onDock={chooseDock} raw={askRaw}
                mode={askMode} onMode={setAskMode} onProgram={drawLadder}
              kind={drawKind}
                onDragStart={dragAsk}
              />
            </div>
          )}

          {/* The set, floating. Dragged by its title bar, kept on the canvas,
              and above the sheet rather than over the whole app: a set you are
              paging through while you draw is a panel, not a dialog. */}
          {tree && pages && treeDock === 'float' && (
            <div
              className="absolute z-30 w-[24rem] max-h-[80%] flex flex-col rounded-lg border border-slate-400 bg-white shadow-xl overflow-hidden"
              style={treeAt ? { left: treeAt.x, top: treeAt.y } : { left: 8, top: 8 }}
            >
              {treePanel('float')}
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
              kind={sheet?.kind}
              selection={picked}
              onImport={importSymbol}
              onRedrawn={applyRedrawnSymbol}
              onClose={() => setShowLibrary(false)}
            />
          )}
        </div>

        {/* The set, docked right — past the model's panel, so the two keep
            the same order whichever side they are parked on. */}
        {tree && pages && treeDock === 'right' && (
          <aside className="w-[24rem] shrink-0 flex flex-col min-h-0 border-s border-gray-200 bg-white order-last">
            {treePanel('right')}
          </aside>
        )}

        {/* Docked right: between the sheet and the layer list, which is where
            a second panel goes on every CAD desk this office has used. */}
        {askOpen && askDock === 'right' && (
          <aside className="w-[22rem] shrink-0 flex flex-col border-s border-gray-200 bg-white">
            <AskPanel
              t={T} text={askText} onText={setAskText} asking={asking}
              onGo={askToDraw} onClose={() => setAskOpen(false)}
              dock={askDock} onDock={chooseDock} raw={askRaw}
              mode={askMode} onMode={setAskMode} onProgram={drawLadder}
              kind={drawKind}
            />
          </aside>
        )}

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
