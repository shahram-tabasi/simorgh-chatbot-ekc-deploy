import React, { useState } from 'react';
import {
  CopyIcon, FilePlusIcon, PencilIcon, PencilRulerIcon, Trash2Icon,
  ChevronUpIcon, ChevronDownIcon,
} from 'lucide-react';
import { DrawingEdits } from '../../types/project';
import {
  DrawingPage, PageType, copyOfPage, movePage, newPage, pageKey,
} from '../../utils/cad/pages';
import { SYMBOL_LIBRARIES, libraryOf } from '../../utils/cad/symbolLibraries';

// The page tree.
//
// Three kinds of page and no more — WD, SLD, OLD — which is the whole of what
// this office issues. The list is grouped by kind rather than sorted by name,
// because the three are three documents that happen to share a project: a
// wiring diagram is sheet 4 of the wiring diagrams whatever was drawn between
// sheet 3 and it.
//
// Everything here works on the set, not on a sheet: a page is added, renamed,
// copied, moved or deleted, and the editor opens on whichever one was
// double-clicked. Deleting takes the geometry with it — leaving orphaned shapes
// behind under a key nothing points at is how a project file grows for years
// and nobody can say why.

const SWATCH: Record<PageType, string> = {
  sld: 'bg-blue-100 text-blue-800 border-blue-200',
  wd: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  old: 'bg-amber-100 text-amber-800 border-amber-200',
};

interface Props {
  pages: DrawingPage[];
  edits?: DrawingEdits;
  /** The set and its geometry, changed together. */
  onChange: (pages: DrawingPage[], edits: DrawingEdits) => void;
  /** Open the editor on this page. */
  onOpen: (id: string) => void;
  canEdit: boolean;
}

export const PageNavigator: React.FC<Props> = ({
  pages, edits, onChange, onOpen, canEdit,
}) => {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftNote, setDraftNote] = useState('');

  const add = (type: PageType) => {
    const page = newPage(pages, type);
    onChange([...pages, page], { ...(edits ?? {}) });
    onOpen(page.id);
  };

  const duplicate = (page: DrawingPage) => {
    const copy = copyOfPage(pages, page);
    const next = { ...(edits ?? {}) };
    const kept = next[pageKey(page.id)];
    // The copy is a copy of what is on the page, not an empty page with the
    // same name. Without this, "duplicate" means "add".
    if (kept) next[pageKey(copy.id)] = { ...kept, editedAt: new Date().toISOString() };
    const at = pages.findIndex(p => p.id === page.id);
    onChange([...pages.slice(0, at + 1), copy, ...pages.slice(at + 1)], next);
  };

  const remove = (page: DrawingPage) => {
    const drawn = Boolean(edits?.[pageKey(page.id)]?.shapes?.length);
    const warn = drawn
      ? `Delete ${page.name}? Everything drawn on it goes with it.`
      : `Delete ${page.name}?`;
    if (!window.confirm(warn)) return;
    const next = { ...(edits ?? {}) };
    delete next[pageKey(page.id)];
    onChange(pages.filter(p => p.id !== page.id), next);
  };

  const startRename = (page: DrawingPage) => {
    setRenaming(page.id);
    setDraft(page.name);
    setDraftNote(page.description ?? '');
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = draft.trim();
    onChange(
      pages.map(p => (p.id === renaming
        ? { ...p, name: name || p.name, description: draftNote.trim() }
        : p)),
      { ...(edits ?? {}) },
    );
    setRenaming(null);
  };

  const shift = (page: DrawingPage, by: number) =>
    onChange(movePage(pages, page.id, by), { ...(edits ?? {}) });

  const shapeCount = (page: DrawingPage) => edits?.[pageKey(page.id)]?.shapes?.length ?? 0;

  return (
    <div className="border border-gray-200 rounded-lg">
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center flex-wrap gap-2">
        <div className="min-w-0 me-auto">
          <p className="font-medium text-sm text-gray-800">
            Pages — {pages.length || 'none yet'}
          </p>
          <p className="text-[11px] text-gray-500">
            Three kinds of page: wiring diagram, single line, layout. The kind picks
            the symbol library the page draws from.
          </p>
        </div>
        {SYMBOL_LIBRARIES.map(lib => (
          <button
            key={lib.kind}
            onClick={() => add(lib.kind)}
            disabled={!canEdit}
            title={`${lib.name} — ${lib.note}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40"
          >
            <FilePlusIcon className="w-4 h-4" /> New {lib.code}
          </button>
        ))}
      </div>

      {pages.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">
          No pages yet. Start one with New WD for a wiring diagram, New SLD for a
          single line, or New OLD for a panel layout.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {pages.map((page, i) => {
            const lib = libraryOf(page.type);
            const drawn = shapeCount(page);
            return (
              <li key={page.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${SWATCH[page.type]}`}>
                  {lib.code}
                </span>

                {renaming === page.id ? (
                  <div className="flex-1 flex items-center gap-2 min-w-0">
                    <input
                      autoFocus
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      className="border border-blue-300 rounded px-2 py-1 text-sm w-32"
                    />
                    <input
                      value={draftNote}
                      onChange={e => setDraftNote(e.target.value)}
                      placeholder="What the page is for"
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 min-w-0"
                    />
                    <button
                      onClick={commitRename}
                      className="px-3 py-1 rounded bg-blue-600 text-white text-sm"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onOpen(page.id)}
                    className="flex-1 text-start min-w-0"
                  >
                    <span className="text-sm font-medium text-gray-800">{page.name}</span>
                    {page.description && (
                      <span className="text-[11px] text-gray-500 ms-2">{page.description}</span>
                    )}
                    <span className="block text-[11px] text-gray-400">
                      {page.width} × {page.height} mm ·{' '}
                      {drawn ? `${drawn} object${drawn === 1 ? '' : 's'}` : 'empty'}
                    </span>
                  </button>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  <IconBtn title="Move up" disabled={!canEdit || i === 0} on={() => shift(page, -1)}>
                    <ChevronUpIcon className="w-4 h-4" />
                  </IconBtn>
                  <IconBtn title="Move down" disabled={!canEdit || i === pages.length - 1} on={() => shift(page, 1)}>
                    <ChevronDownIcon className="w-4 h-4" />
                  </IconBtn>
                  <IconBtn title="Rename" disabled={!canEdit} on={() => startRename(page)}>
                    <PencilIcon className="w-4 h-4" />
                  </IconBtn>
                  <IconBtn title="Duplicate" disabled={!canEdit} on={() => duplicate(page)}>
                    <CopyIcon className="w-4 h-4" />
                  </IconBtn>
                  <IconBtn title="Delete" disabled={!canEdit} on={() => remove(page)} danger>
                    <Trash2Icon className="w-4 h-4" />
                  </IconBtn>
                  <button
                    onClick={() => onOpen(page.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700"
                  >
                    <PencilRulerIcon className="w-4 h-4" /> Open
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const IconBtn: React.FC<{
  title: string; on: () => void; disabled?: boolean; danger?: boolean;
  children: React.ReactNode;
}> = ({ title, on, disabled, danger, children }) => (
  <button
    title={title}
    onClick={on}
    disabled={disabled}
    className={`p-1.5 rounded border border-transparent disabled:opacity-30 ${
      danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-500 hover:bg-gray-200'}`}
  >
    {children}
  </button>
);
