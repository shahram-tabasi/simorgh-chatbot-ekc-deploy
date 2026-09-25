import React, { useMemo, useState } from 'react';
import {
  ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon,
  ClipboardPasteIcon, CopyIcon, CopyPlusIcon, FilePlusIcon, FileSpreadsheetIcon,
  FolderIcon, FolderOpenIcon, FolderPlusIcon, ListIcon, MoreVerticalIcon,
  PencilRulerIcon, PlusIcon, SettingsIcon, Trash2Icon,
} from 'lucide-react';
import { DrawingEdits, SheetEdit } from '../../types/project';
import {
  DrawingGroups, DrawingPage, PageNode, PageType, addGroup, copyOfPage, countPages,
  groupPaths, movePageInGroup, newPage, nextGroupName, pageKey, pageTree, pathLabel,
  removeGroup, renameGroup, settleGroups,
} from '../../utils/cad/pages';
import { PAPERS } from '../../utils/cad/paper';
import { SYMBOL_LIBRARIES, libraryOf } from '../../utils/cad/symbolLibraries';
import { IoListImport } from './IoListImport';
import { DrawingReportsModal } from './DrawingReportsModal';
import { ContextMenu, Field, MenuItem, PropertiesModal } from './PageMenu';
import { appConfirm } from '../shared/AppDialog';

// The page tree.
//
// A drawing set is not a list. It is the project, and under it the headings
// the office files by — supply, control, one per board — and under those the
// pages. A flat list of forty pages named WD 1 … WD 40 is a set nobody can
// find anything in by the second week, which is why every drawing office's
// navigator is a tree and why this one is too.
//
// The root is the project and cannot be typed: it is the project's own name,
// read off the job, so it is right without anybody keeping it right. Below it
// everything belongs to the user — groups they make and name, sub-groups
// inside those, pages inside any of them.
//
// Three kinds of page and no more — WD, SLD, OLD — which is the whole of what
// this office issues. The kind rides with the page rather than with the group,
// because a board's folder holds its single line and its wiring diagrams
// together: that is the point of filing by board.
//
// Everything here works on the set, not on a sheet: a page is added, renamed,
// copied, moved between groups, reordered among its siblings or deleted, and
// the editor opens on whichever one was clicked. Deleting takes the geometry
// with it — leaving orphaned shapes behind under a key nothing points at is
// how a project file grows for years and nobody can say why.
//
// A row shows the page and nothing else. The commands are on the right button,
// where a command about one page belongs, and the ones that are typed rather
// than clicked — the name, what the page is for, the group it is filed under,
// the paper it is drawn on — are one form behind Properties. A row carrying
// seven icons is a row you read past, and a set is read far more often than
// it is rearranged.

const SWATCH: Record<PageType, string> = {
  sld: 'bg-blue-100 text-blue-800 border-blue-200',
  wd: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  old: 'bg-amber-100 text-amber-800 border-amber-200',
};

/** A path as one key. The separator cannot be typed, so it cannot collide. */
const keyOf = (path: string[]) => path.join('\0');

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The page on the clipboard.
 *
 * Module-level, so it survives the tree being closed: copying a page in one
 * drawing and pasting it after opening another is the whole point of a
 * clipboard, and a copy that only lasts while the panel is open is a copy
 * nobody can use. It holds the geometry too — pasting a page and getting an
 * empty sheet with a familiar name is not pasting.
 */
let clipboard: { page: DrawingPage; edit?: SheetEdit } | null = null;

/** Where the pointer was, and what it was on. */
type Target =
  | { kind: 'page'; page: DrawingPage }
  | { kind: 'group'; path: string[] }
  | { kind: 'root' }
  | { kind: 'new' };

interface Props {
  pages: DrawingPage[];
  /** Headings made but not yet filled — see DrawingGroups. */
  groups?: DrawingGroups;
  edits?: DrawingEdits;
  /** The set, its geometry and its headings, changed together. */
  onChange: (pages: DrawingPage[], edits: DrawingEdits, groups: DrawingGroups) => void;
  /** Open the editor on this page. */
  onOpen: (id: string) => void;
  canEdit: boolean;
  /** Stem for the report file's name. */
  fileBase: string;
  /** The root of the tree. Shown, never typed — it is the project's own name. */
  projectName?: string;
  /**
   * Narrow: docked in a column beside the drawing rather than given a page.
   *
   * Only the chrome changes — the toolbar loses its labels and the list takes
   * the height it is given — because the tree does the same job either way.
   */
  compact?: boolean;
  /** Which way the running text reads, for the menus and the forms. */
  dir?: 'ltr' | 'rtl';
  /**
   * The page the editor is on, marked in the tree.
   *
   * Worth saying now that the tree stays open beside the drawing: a list of
   * forty pages that does not say which one you are looking at is a list you
   * have to count down every time you turn a page.
   */
  currentId?: string;
}

export const PageNavigator: React.FC<Props> = ({
  pages, groups = [], edits, onChange, onOpen, canEdit, fileBase, projectName,
  compact = false, dir = 'ltr', currentId,
}) => {
  // Where a new page lands. The empty path is the project itself.
  const [into, setInto] = useState<string[]>([]);
  const [shut, setShut] = useState<string[]>([]);
  const [fromList, setFromList] = useState(false);
  const [made, setMade] = useState<number | null>(null);
  const [reporting, setReporting] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; on: Target } | null>(null);
  /** The page whose form is open, and the group whose name is being typed. */
  const [props, setProps] = useState<DrawingPage | null>(null);
  const [groupProps, setGroupProps] = useState<string[] | null>(null);
  /** What is on the clipboard, only so the Paste line redraws when it changes. */
  const [clip, setClip] = useState<string | null>(clipboard?.page.name ?? null);

  const tree = useMemo(() => pageTree(pages, groups), [pages, groups]);
  const folders = useMemo(() => groupPaths(pages, groups), [pages, groups]);
  const open = (path: string[]) => !shut.includes(keyOf(path));
  const toggle = (path: string[]) => {
    const k = keyOf(path);
    setShut(s => (s.includes(k) ? s.filter(v => v !== k) : [...s, k]));
  };

  /** Every change goes through here, so the empty-group list is never stale. */
  const put = (next: DrawingPage[], nextEdits: DrawingEdits, nextGroups: DrawingGroups) =>
    onChange(next, nextEdits, settleGroups(next, nextGroups));

  const add = (type: PageType, path: string[] = into) => {
    const page = newPage(pages, type, '', path);
    put([...pages, page], { ...(edits ?? {}) }, groups);
    onOpen(page.id);
  };

  const addFolder = (inside: string[] = into) => {
    const path = [...inside, nextGroupName(pages, groups, inside)];
    put(pages, { ...(edits ?? {}) }, addGroup(groups, path));
    setInto(path);
    setShut(s => s.filter(k => k !== keyOf(path)));
    // Straight into the name box: a group called "Group 2" is a group nobody
    // named, and the moment to name it is the moment it appears.
    setGroupProps(path);
  };

  const commitGroup = (path: string[], name: string) => {
    const wanted = name.trim();
    setGroupProps(null);
    if (!wanted || wanted === path[path.length - 1]) return;
    const moved = renameGroup(pages, groups, path, wanted);
    const next = [...path.slice(0, -1), wanted];
    put(moved.pages, { ...(edits ?? {}) }, moved.groups);
    setInto(cur => (same(cur, path) ? next : cur));
  };

  const dropFolder = async (path: string[]) => {
    const count = countPages(under(tree, path));
    const warn = count
      ? `Delete ${pathLabel(path)} and the ${count} page${count === 1 ? '' : 's'} in it?`
      : `Delete ${pathLabel(path)}?`;
    if (!await appConfirm(warn, { danger: true, confirmLabel: 'Delete' })) return;
    const gone = removeGroup(pages, groups, path);
    const next = { ...(edits ?? {}) };
    for (const p of gone.removed) delete next[pageKey(p.id)];
    put(gone.pages, next, gone.groups);
    setInto(cur => (cur.length >= path.length && same(cur.slice(0, path.length), path)
      ? path.slice(0, -1) : cur));
  };

  const duplicate = (page: DrawingPage) => {
    const copy = copyOfPage(pages, page);
    const next = { ...(edits ?? {}) };
    const kept = next[pageKey(page.id)];
    // The copy is a copy of what is on the page, not an empty page with the
    // same name. Without this, "duplicate" means "add".
    if (kept) next[pageKey(copy.id)] = { ...kept, editedAt: new Date().toISOString() };
    const at = pages.findIndex(p => p.id === page.id);
    put([...pages.slice(0, at + 1), copy, ...pages.slice(at + 1)], next, groups);
  };

  /** Copy takes the geometry with it, so a paste is the page and not its name. */
  const copy = (page: DrawingPage) => {
    clipboard = { page, edit: edits?.[pageKey(page.id)] };
    setClip(page.name);
  };

  /**
   * Paste: the page on the clipboard, into `path`, after `at` if there is one.
   *
   * A new id every time — pasting the same copy four times is four pages, not
   * one page listed four times — and the geometry comes across under the new
   * id, which is what makes this a copy of the drawing rather than of the tab.
   */
  const paste = (path: string[], at?: DrawingPage) => {
    if (!clipboard) return;
    const copied = { ...copyOfPage(pages, clipboard.page), path };
    const next = { ...(edits ?? {}) };
    if (clipboard.edit?.shapes?.length) {
      next[pageKey(copied.id)] = { ...clipboard.edit, editedAt: new Date().toISOString() };
    }
    const after = at ? pages.findIndex(p => p.id === at.id) : -1;
    const list = after >= 0
      ? [...pages.slice(0, after + 1), copied, ...pages.slice(after + 1)]
      : [...pages, copied];
    put(list, next, groups);
  };

  const remove = async (page: DrawingPage) => {
    const drawn = Boolean(edits?.[pageKey(page.id)]?.shapes?.length);
    const warn = drawn
      ? `Delete ${page.name}? Everything drawn on it goes with it.`
      : `Delete ${page.name}?`;
    if (!await appConfirm(warn, { danger: true, confirmLabel: 'Delete' })) return;
    const next = { ...(edits ?? {}) };
    delete next[pageKey(page.id)];
    put(pages.filter(p => p.id !== page.id), next,
      page.path?.length ? addGroup(groups, page.path) : groups);
  };

  /** The form's one save: name, note, kind, paper and group in a single step. */
  const saveProps = (was: DrawingPage, now: DrawingPage) => {
    setProps(null);
    // The group it leaves stays on the tree even if it was the last page in
    // it: emptying a heading is not deleting it.
    const keep = was.path?.length && !same(was.path, now.path ?? [])
      ? addGroup(groups, was.path) : groups;
    put(pages.map(p => (p.id === was.id ? now : p)), { ...(edits ?? {}) }, keep);
  };

  const shift = (page: DrawingPage, by: number) =>
    put(movePageInGroup(pages, page.id, by), { ...(edits ?? {}) }, groups);

  const shapeCount = (page: DrawingPage) => edits?.[pageKey(page.id)]?.shapes?.length ?? 0;

  /** Where a page sits among the pages filed beside it, for up and down. */
  const among = (page: DrawingPage) => {
    const kin = pages.filter(p => keyOf(p.path ?? []) === keyOf(page.path ?? []));
    return { at: kin.findIndex(p => p.id === page.id), of: kin.length };
  };

  const show = (e: React.MouseEvent, on: Target) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ at: { x: e.clientX, y: e.clientY }, on });
  };

  // ── What the right button offers ───────────────────────────────────────
  // Three menus, because there are three things to point at: a page, a group,
  // and the project the whole set hangs off. Each one only offers what makes
  // sense where the pointer is — a menu with half its lines greyed out is a
  // menu that was written for somewhere else.

  const newPageLines = (path: string[]): MenuItem[] =>
    SYMBOL_LIBRARIES.map(lib => ({
      label: `New ${lib.code}`,
      hint: lib.name,
      icon: FilePlusIcon,
      disabled: !canEdit,
      on: () => add(lib.kind, path),
    }));

  const pasteLine = (path: string[], at?: DrawingPage): MenuItem => ({
    label: 'Paste',
    hint: clip ?? undefined,
    icon: ClipboardPasteIcon,
    disabled: !canEdit || !clipboard,
    on: () => paste(path, at),
  });

  const pageMenu = (page: DrawingPage): MenuItem[] => {
    const { at, of } = among(page);
    return [
      { label: 'Open', icon: PencilRulerIcon, on: () => onOpen(page.id) },
      { sep: true },
      { label: 'Copy', icon: CopyIcon, on: () => copy(page) },
      pasteLine(page.path ?? [], page),
      { label: 'Duplicate', icon: CopyPlusIcon, disabled: !canEdit, on: () => duplicate(page) },
      { label: 'Delete', icon: Trash2Icon, danger: true, disabled: !canEdit, on: () => remove(page) },
      { sep: true },
      {
        label: 'Move up', icon: ArrowUpIcon, disabled: !canEdit || at <= 0,
        on: () => shift(page, -1),
      },
      {
        label: 'Move down', icon: ArrowDownIcon, disabled: !canEdit || at < 0 || at >= of - 1,
        on: () => shift(page, 1),
      },
      { sep: true },
      {
        label: 'Properties…',
        hint: 'name, group, paper',
        icon: SettingsIcon,
        disabled: !canEdit,
        on: () => setProps(page),
      },
    ];
  };

  const groupMenu = (path: string[]): MenuItem[] => [
    ...newPageLines(path),
    {
      label: 'New group inside', icon: FolderPlusIcon, disabled: !canEdit,
      on: () => addFolder(path),
    },
    { sep: true },
    pasteLine(path),
    { sep: true },
    {
      label: 'Properties…', hint: 'name', icon: SettingsIcon, disabled: !canEdit,
      on: () => setGroupProps(path),
    },
    {
      label: 'Delete group', icon: Trash2Icon, danger: true, disabled: !canEdit,
      on: () => dropFolder(path),
    },
  ];

  const rootMenu = (): MenuItem[] => [
    ...newPageLines([]),
    { label: 'New group', icon: FolderPlusIcon, disabled: !canEdit, on: () => addFolder([]) },
    { sep: true },
    pasteLine([]),
    { sep: true },
    {
      label: 'From I/O list…', icon: FileSpreadsheetIcon, disabled: !canEdit,
      on: () => setFromList(true),
    },
    {
      label: 'Reports…', icon: ListIcon, disabled: pages.length === 0,
      on: () => setReporting(true),
    },
  ];

  /** The New button's own menu — the same lines, off a button instead. */
  const newMenu = (): MenuItem[] => [
    ...newPageLines(into),
    { sep: true },
    { label: 'New group', icon: FolderPlusIcon, disabled: !canEdit, on: () => addFolder(into) },
    { sep: true },
    {
      label: 'From I/O list…',
      hint: 'a page per signal',
      icon: FileSpreadsheetIcon,
      disabled: !canEdit,
      on: () => setFromList(true),
    },
  ];

  const menuFor = (on: Target): MenuItem[] => {
    if (on.kind === 'page') return pageMenu(on.page);
    if (on.kind === 'group') return groupMenu(on.path);
    if (on.kind === 'new') return newMenu();
    return rootMenu();
  };

  // ── The rows ───────────────────────────────────────────────────────────
  const rows = (nodes: PageNode[], depth: number): React.ReactNode[] =>
    nodes.flatMap(node => (node.kind === 'group'
      ? folderRow(node, depth)
      : [pageRow(node.page, depth)]));

  const folderRow = (
    node: Extract<PageNode, { kind: 'group' }>, depth: number,
  ): React.ReactNode[] => {
    const here = same(into, node.path);
    const shown = open(node.path);
    const row = (
      <li
        key={`g:${keyOf(node.path)}`}
        style={{ paddingInlineStart: `${12 + depth * 18}px` }}
        className={`flex items-center gap-2 pe-2 py-2 ${here ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
        onContextMenu={e => show(e, { kind: 'group', path: node.path })}
      >
        <button
          onClick={() => toggle(node.path)}
          className="p-0.5 text-gray-400 hover:text-gray-700 shrink-0"
          title={shown ? 'Collapse' : 'Expand'}
        >
          {shown
            ? <ChevronDownIcon className="w-4 h-4" />
            : <ChevronRightIcon className="w-4 h-4" />}
        </button>

        <button
          onClick={() => setInto(node.path)}
          onDoubleClick={() => toggle(node.path)}
          className="flex-1 flex items-center gap-2 text-start min-w-0"
          title="New pages and new groups go in here — right-click for the rest"
        >
          {shown
            ? <FolderOpenIcon className="w-4 h-4 text-amber-500 shrink-0" />
            : <FolderIcon className="w-4 h-4 text-amber-500 shrink-0" />}
          <span className="text-sm font-medium text-gray-800 truncate">{node.name}</span>
          <span className="text-[11px] text-gray-400 shrink-0">
            {node.pages
              ? `${node.pages} page${node.pages === 1 ? '' : 's'}`
              : 'empty'}
          </span>
        </button>

        <MoreBtn on={e => show(e, { kind: 'group', path: node.path })} />
      </li>
    );
    return shown ? [row, ...rows(node.children, depth + 1)] : [row];
  };

  const pageRow = (page: DrawingPage, depth: number): React.ReactNode => {
    const lib = libraryOf(page.type);
    const drawn = shapeCount(page);
    const here = page.id === currentId;

    return (
      <li
        key={page.id}
        style={{ paddingInlineStart: `${30 + depth * 18}px` }}
        className={`flex items-center gap-2.5 pe-2 py-2 ${
          here ? 'bg-blue-50 border-s-2 border-blue-600' : 'hover:bg-gray-50'}`}
        onContextMenu={e => show(e, { kind: 'page', page })}
      >
        <span
          className={`text-[11px] font-bold px-2 py-0.5 rounded border shrink-0 ${SWATCH[page.type]}`}
          title={lib.name}
        >
          {lib.code}
        </span>

        <button
          onClick={() => onOpen(page.id)}
          onDoubleClick={() => onOpen(page.id)}
          className="flex-1 text-start min-w-0"
          title="Open this page — right-click for copy, paste, delete and its properties"
        >
          <span className={`text-sm font-medium ${here ? 'text-blue-800' : 'text-gray-800'}`}>
            {page.name}
          </span>
          {page.description && (
            <span className="text-[11px] text-gray-500 ms-2">{page.description}</span>
          )}
          <span className="block text-[11px] text-gray-400">
            {page.width} × {page.height} mm ·{' '}
            {drawn ? `${drawn} object${drawn === 1 ? '' : 's'}` : 'empty'}
          </span>
        </button>

        <MoreBtn on={e => show(e, { kind: 'page', page })} />
      </li>
    );
  };

  return (
    <div
      className={compact
        ? 'flex flex-col min-h-0 flex-1 bg-white'
        : 'border border-gray-200 rounded-lg bg-white'}
      dir={dir}
    >
      {/* The toolbar: two buttons, and everything else on the right button.
          Six buttons across the top is a header that does not fit a docked
          column, and five of the six were commands about one page anyway. */}
      <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-2 shrink-0">
        <div className="min-w-0 me-auto">
          <p className="font-medium text-sm text-gray-800">
            Pages — {pages.length || 'none yet'}
          </p>
          <p className="text-[11px] text-gray-500 truncate">
            New pages go into{' '}
            <span className="font-medium text-gray-700">
              {into.length ? pathLabel(into) : (projectName || 'the project')}
            </span>
          </p>
        </div>

        <button
          onClick={e => show(e, { kind: 'new' })}
          disabled={!canEdit}
          title="A new page, a new group, or a set of wiring pages read off an I/O list"
          className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 shrink-0"
        >
          <PlusIcon className="w-4 h-4" />
          {!compact && 'New'}
          <ChevronDownIcon className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setReporting(true)}
          disabled={pages.length === 0}
          title="The I/O list, terminal diagram, connection list and device list, read off these pages"
          className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40 shrink-0"
        >
          <ListIcon className="w-4 h-4" />
          {!compact && 'Reports'}
        </button>
      </div>

      {made !== null && (
        <p className="px-4 py-2 bg-emerald-50 border-b border-emerald-200 text-[12px] text-emerald-900 shrink-0">
          {made} page{made === 1 ? '' : 's'} drawn from the list. They are pages like any
          other now — draw on them, and bringing in a newer list adds new pages rather than
          overwriting these.
        </p>
      )}

      {/* The root. It is the project, so it is neither typed nor deleted —
          only chosen, which is how a page is put at the top level. */}
      <ul
        className={`divide-y divide-gray-100 ${compact ? 'flex-1 min-h-0 overflow-y-auto' : ''}`}
        onContextMenu={e => show(e, { kind: 'root' })}
      >
        <li
          className={`flex items-center gap-2 px-3 py-2.5 ${
            into.length === 0 ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
          onContextMenu={e => show(e, { kind: 'root' })}
        >
          <button
            onClick={() => setInto([])}
            className="flex-1 flex items-center gap-2 text-start min-w-0"
            title="New pages go straight under the project"
          >
            <FolderOpenIcon className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="text-sm font-semibold text-gray-900 truncate">
              {projectName || 'Project'}
            </span>
            <span className="text-[11px] text-gray-400 shrink-0">
              {pages.length} page{pages.length === 1 ? '' : 's'}
            </span>
          </button>
          <MoreBtn on={e => show(e, { kind: 'root' })} />
        </li>
        {rows(tree, 0)}
      </ul>

      {pages.length === 0 && groups.length === 0 && (
        <p className="p-6 text-sm text-gray-500">
          No pages yet. Make a group for the board or the part of the job, or start a page
          straight away with New: WD for a wiring diagram, SLD for a single line, OLD for
          a panel layout. Right-click anything here for what can be done to it.
        </p>
      )}

      {menu && (
        <ContextMenu
          at={menu.at}
          dir={dir}
          items={menuFor(menu.on)}
          onClose={() => setMenu(null)}
        />
      )}

      {props && (
        <PageProperties
          page={props}
          folders={folders}
          projectName={projectName}
          dir={dir}
          onClose={() => setProps(null)}
          onSave={now => saveProps(props, now)}
        />
      )}

      {groupProps && (
        <GroupProperties
          path={groupProps}
          pages={countPages(under(tree, groupProps))}
          dir={dir}
          onClose={() => setGroupProps(null)}
          onSave={name => commitGroup(groupProps, name)}
        />
      )}

      {reporting && (
        <DrawingReportsModal
          // Only pages with something drawn on them: an empty page in a report
          // is a row of nothing that somebody has to scroll past.
          pages={pages
            .map(page => ({ name: page.name, shapes: edits?.[pageKey(page.id)]?.shapes ?? [] }))
            .filter(p => p.shapes.length > 0)}
          fileBase={fileBase}
          onClose={() => setReporting(false)}
        />
      )}

      {fromList && (
        <IoListImport
          pages={pages}
          edits={edits}
          onDone={(next, nextEdits, count) => {
            // Pages read off a list are filed where the user was working rather
            // than dumped at the root: twenty of them landing above the groups
            // is twenty things to move by hand.
            const here = new Set(pages.map(p => p.id));
            put(next.map(p => (here.has(p.id) ? p : { ...p, path: into })), nextEdits, groups);
            setFromList(false);
            setMade(count);
          }}
          onClose={() => setFromList(false)}
        />
      )}
    </div>
  );
};

/** The nodes under `path`, for counting what a delete would take with it. */
function under(nodes: PageNode[], path: string[]): PageNode[] {
  for (const node of nodes) {
    if (node.kind !== 'group') continue;
    if (same(node.path, path)) return node.children;
    if (path.length > node.path.length && same(path.slice(0, node.path.length), node.path)) {
      return under(node.children, path);
    }
  }
  return [];
}

/**
 * The same menu, off a button.
 *
 * A right-click is the gesture, but it is a gesture nobody can see, and a
 * trackpad or a touch screen may not have it at all. One dot of a button per
 * row is the smallest thing that says the commands are there.
 */
const MoreBtn: React.FC<{ on: (e: React.MouseEvent) => void }> = ({ on }) => (
  <button
    onClick={on}
    title="Commands for this — also on the right mouse button"
    className="p-1.5 rounded text-gray-400 hover:text-gray-800 hover:bg-gray-200 shrink-0"
  >
    <MoreVerticalIcon className="w-4 h-4" />
  </button>
);

/** The paper sizes a page can be put on by name, plus one it is given by hand. */
const sizeOf = (w: number, h: number): string => {
  const found = PAPERS.find(([, pw, ph]) =>
    (pw === w && ph === h) || (pw === h && ph === w));
  return found ? found[0] : 'custom';
};

/**
 * A page's details: its name, what it is for, which of the three it is, the
 * paper it is drawn on and the group it is filed under.
 *
 * One form and one save, because these are one decision made when a page is
 * started — and because four of them as four menu lines is four dialogs to
 * walk through to set up a page.
 */
const PageProperties: React.FC<{
  page: DrawingPage;
  folders: string[][];
  projectName?: string;
  dir?: 'ltr' | 'rtl';
  onClose: () => void;
  onSave: (page: DrawingPage) => void;
}> = ({ page, folders, projectName, dir, onClose, onSave }) => {
  const [name, setName] = useState(page.name);
  const [note, setNote] = useState(page.description ?? '');
  const [type, setType] = useState<PageType>(page.type);
  const [size, setSize] = useState(sizeOf(page.width, page.height));
  const [portrait, setPortrait] = useState(page.height > page.width);
  const [width, setWidth] = useState(String(page.width));
  const [height, setHeight] = useState(String(page.height));
  const [path, setPath] = useState<string[]>(page.path ?? []);

  const save = () => {
    const paper = PAPERS.find(([id]) => id === size);
    // A named sheet is stored as millimetres like any other, so nothing
    // downstream has to know what an A3 is; only this form does.
    const [w, h] = paper
      ? (portrait ? [paper[2], paper[1]] : [paper[1], paper[2]])
      : [Math.round(Number(width) || page.width), Math.round(Number(height) || page.height)];
    onSave({
      ...page,
      name: name.trim() || page.name,
      description: note.trim(),
      type,
      width: Math.max(10, w),
      height: Math.max(10, h),
      path,
    });
  };

  const input = 'w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm';

  return (
    <PropertiesModal
      title={`${page.name} — properties`}
      note="The name, what the page is for, the paper and where it is filed"
      dir={dir}
      onClose={onClose}
      onSave={save}
    >
      <Field label="Name">
        <input autoFocus value={name} onChange={e => setName(e.target.value)} className={input} />
      </Field>

      <Field label="What the page is for">
        <input
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="the line under the name in the tree"
          className={input}
        />
      </Field>

      <Field
        label="Kind"
        note={SYMBOL_LIBRARIES.find(l => l.kind === type)?.note}
      >
        <select value={type} onChange={e => setType(e.target.value as PageType)} className={input}>
          {SYMBOL_LIBRARIES.map(lib => (
            <option key={lib.kind} value={lib.kind}>{lib.code} — {lib.name}</option>
          ))}
        </select>
      </Field>

      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <Field label="Paper">
            <select value={size} onChange={e => setSize(e.target.value)} className={input}>
              {PAPERS.map(([id, w, h]) => (
                <option key={id} value={id}>{id} — {w} × {h} mm</option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </Field>
        </div>
        {size === 'custom' ? (
          <>
            <div className="w-20">
              <Field label="Width">
                <input
                  type="number" min={10} value={width}
                  onChange={e => setWidth(e.target.value)} className={input}
                />
              </Field>
            </div>
            <div className="w-20">
              <Field label="Height">
                <input
                  type="number" min={10} value={height}
                  onChange={e => setHeight(e.target.value)} className={input}
                />
              </Field>
            </div>
          </>
        ) : (
          <label className="flex items-center gap-1.5 text-sm text-gray-700 pb-1.5 shrink-0">
            <input
              type="checkbox"
              checked={portrait}
              onChange={e => setPortrait(e.target.checked)}
            />
            Portrait
          </label>
        )}
      </div>

      <Field label="Filed under">
        <select
          value={keyOf(path)}
          onChange={e => setPath(folders.find(f => keyOf(f) === e.target.value) ?? [])}
          className={input}
        >
          <option value="">{projectName || 'Project'}</option>
          {folders.map(f => (
            <option key={keyOf(f)} value={keyOf(f)}>{pathLabel(f)}</option>
          ))}
        </select>
      </Field>
    </PropertiesModal>
  );
};

/** A group has one thing to type: what it is called. */
const GroupProperties: React.FC<{
  path: string[];
  pages: number;
  dir?: 'ltr' | 'rtl';
  onClose: () => void;
  onSave: (name: string) => void;
}> = ({ path, pages, dir, onClose, onSave }) => {
  const [name, setName] = useState(path[path.length - 1] ?? '');
  return (
    <PropertiesModal
      title="Group — properties"
      note={`${pathLabel(path)} · ${pages} page${pages === 1 ? '' : 's'}`}
      dir={dir}
      onClose={onClose}
      onSave={() => onSave(name)}
    >
      <Field
        label="Name"
        note="Renaming it renames it on every page filed under it."
      >
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full mt-0.5 border border-gray-300 rounded px-2 py-1.5 text-sm"
        />
      </Field>
    </PropertiesModal>
  );
};
