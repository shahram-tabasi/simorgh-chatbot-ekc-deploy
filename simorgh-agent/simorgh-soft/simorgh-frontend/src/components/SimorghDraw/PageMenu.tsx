import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// The menu that comes up on a right-click, and the little modal the page's own
// details are typed into.
//
// A row in the page tree used to carry seven buttons — up, down, file under,
// rename, duplicate, delete, open — which is seven pictures per page times
// forty pages of a set, and a column of pages you cannot read for the controls
// on top of it. The commands did not go away; they moved to where a command
// about one thing belongs, which is on that thing, under the right button.
//
// Two rules keep it readable. What you do often is in the menu itself — open,
// copy, paste, delete. What you do once, when a page is made, is behind
// Properties: the name, what the page is for, which group it is filed under,
// the paper it is drawn on. A menu you read is better than a menu that has
// everything at the top level, and a page's details are a form, not four
// menu lines.

export interface MenuItem {
  /** A rule between groups of commands. Everything else is ignored. */
  sep?: boolean;
  label?: string;
  /** Right-hand note: a shortcut, or what the command will act on. */
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  on?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** Roughly what the menu measures before it is on screen, for clamping. */
const WIDTH = 236;

/**
 * A menu at the pointer.
 *
 * `fixed`, and above everything the editor puts up: in full screen the editor
 * owns z-300 and its own panels sit at z-320, so a menu that lost to them
 * would open behind the panel it was opened from.
 */
export const ContextMenu: React.FC<{
  at: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
  dir?: 'ltr' | 'rtl';
}> = ({ at, items, onClose, dir }) => {
  const box = useRef<HTMLDivElement>(null);
  const [where, setWhere] = useState<{ left: number; top: number }>({ left: at.x, top: at.y });

  // Measured rather than guessed: a menu whose last command is off the bottom
  // of the window is a command nobody can reach.
  useLayoutEffect(() => {
    const el = box.current;
    const w = el?.offsetWidth || WIDTH;
    const h = el?.offsetHeight || 8 + items.length * 30;
    setWhere({
      left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)),
    });
  }, [at.x, at.y, items.length]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[400]"
      onMouseDown={onClose}
      onWheel={onClose}
      onContextMenu={e => { e.preventDefault(); onClose(); }}
    >
      <div
        ref={box}
        dir={dir}
        style={{ left: where.left, top: where.top, minWidth: WIDTH }}
        className="absolute rounded-lg border border-gray-200 bg-white shadow-2xl py-1 text-sm"
        onMouseDown={e => e.stopPropagation()}
        onContextMenu={e => e.stopPropagation()}
      >
        {items.map((item, i) => (item.sep ? (
          <div key={`s${i}`} className="my-1 border-t border-gray-100" />
        ) : (
          <button
            key={item.label}
            disabled={item.disabled}
            onClick={() => { item.on?.(); onClose(); }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-start disabled:opacity-35 disabled:cursor-default ${
              item.danger
                ? 'text-red-600 enabled:hover:bg-red-50'
                : 'text-gray-700 enabled:hover:bg-gray-100'}`}
          >
            {item.icon
              ? <item.icon className="w-4 h-4 shrink-0" />
              : <span className="w-4 shrink-0" />}
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="text-[11px] text-gray-400 shrink-0">{item.hint}</span>
            )}
          </button>
        )))}
      </div>
    </div>
  );
};

/** One labelled field in the properties form. */
export const Field: React.FC<{ label: string; note?: string; children: React.ReactNode }> = ({
  label, note, children,
}) => (
  <label className="block">
    <span className="text-[11px] font-medium text-gray-600">{label}</span>
    {children}
    {note && <span className="block text-[11px] text-gray-400 mt-0.5">{note}</span>}
  </label>
);

/**
 * The frame every properties form is typed into.
 *
 * Its own overlay rather than the tree's, so it reads the same whether the
 * tree is docked in a column or floating over the drawing — and above the
 * menu that opened it, which is the one thing that is certainly on screen.
 */
export const PropertiesModal: React.FC<{
  title: string;
  note?: string;
  onClose: () => void;
  onSave: () => void;
  saveLabel?: string;
  dir?: 'ltr' | 'rtl';
  children: React.ReactNode;
}> = ({ title, note, onClose, onSave, saveLabel = 'Save', dir, children }) => (
  <div
    className="fixed inset-0 z-[420] bg-black/50 flex items-center justify-center p-4"
    onMouseDown={onClose}
  >
    <div
      dir={dir}
      className="bg-white rounded-lg shadow-2xl w-[26rem] max-w-full"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-4 py-2.5 bg-slate-700 text-white rounded-t-lg">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-[11px] text-white/70 mt-0.5">{note}</p>}
      </div>
      <form
        className="p-4 space-y-3"
        onSubmit={e => { e.preventDefault(); onSave(); }}
      >
        {children}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            {saveLabel}
          </button>
        </div>
      </form>
    </div>
  </div>
);
