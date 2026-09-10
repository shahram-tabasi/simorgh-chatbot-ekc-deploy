import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, XIcon } from 'lucide-react';

// A cell of the parts table, and the bigger box that opens over it.
//
// The columns are narrow because there are nine of them, so a part number reads
// "3RV2321-4…" and a description not at all. Two answers, both of which a
// spreadsheet gives you and neither of which costs the table any width:
//
//   Hover — the whole value in a tooltip. Free, and enough to *read* a cell.
//   Click — a box over the cell, wide enough to read and edit in, with the
//           column's name on it so there is no doubt which field it is.
//
// Every keystroke in the box goes straight into the row, exactly as typing in
// the cell always did. Nothing is staged and there is nothing to lose by
// clicking away, which is why closing it is not a decision.
//
// **It is drawn through a portal.** The table scrolls sideways inside a box
// that clips what overflows it, and a panel positioned inside that box gets its
// head cut off. Rendering to `document.body` at fixed coordinates escapes every
// clipping ancestor there is; the cost is that the position has to be measured
// rather than inherited, and that a scroll closes it rather than dragging it
// out of place.

interface Props {
  /** The column's name, shown as the box's heading. */
  label: string;
  value: string;
  /** Absent for a value that comes from the parts database and is not typed. */
  onChange?: (next: string) => void;
  /** Where a read-only value comes from, so the box can say. */
  source?: string;
  type?: 'text' | 'number';
  min?: number;
  /** The inline input's own colours, kept exactly as they were. */
  className?: string;
  /** Long values get a box with room for several lines. */
  multiline?: boolean;
}

/** Where the box goes, in viewport coordinates. */
interface Place { left: number; top: number; width: number }

const BOX = 420;
const GAP = 6;

export const PartCell: React.FC<Props> = ({
  label, value, onChange, source, type = 'text', min,
  className = '', multiline = false,
}) => {
  const [place, setPlace] = useState<Place | null>(null);
  const cell = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const readOnly = !onChange;

  const openAt = () => {
    const r = cell.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(BOX, window.innerWidth - 16);
    // Above where there is room for it, below where there is not; and never
    // off the side, however near the edge the column happens to sit.
    const height = multiline ? 210 : 150;
    const top = r.top > height + GAP ? r.top - height - GAP : r.bottom + GAP;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPlace({ left, top, width });
  };

  useLayoutEffect(() => {
    if (!place) return;
    field.current?.focus();
    field.current?.select?.();
  }, [place]);

  useEffect(() => {
    if (!place) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !cell.current?.contains(t)) setPlace(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setPlace(null); }
    };
    // A scroll would leave the box behind, pointing at a cell that has moved.
    const scrolled = () => setPlace(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', scrolled);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', scrolled);
    };
  }, [place]);

  const shown = value ?? '';

  return (
    <>
      <input
        ref={cell}
        type={type}
        min={min}
        data-cell={label}
        // Hovering reads the cell without opening anything.
        title={shown ? `${label}: ${shown}` : label}
        className={`cursor-pointer ${className}`}
        value={shown}
        readOnly={readOnly}
        onChange={e => onChange?.(e.target.value)}
        onClick={openAt}
        onFocus={openAt}
      />

      {place && createPortal(
        <div
          ref={box}
          data-cell-panel={label}
          style={{ position: 'fixed', left: place.left, top: place.top, width: place.width }}
          className="z-[200] bg-white border border-gray-300 rounded-lg shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-gray-50 rounded-t-lg">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-700 truncate">{label}</p>
              {readOnly && source && (
                <p className="text-[10px] text-gray-500 truncate">{source}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setPlace(null)}
                  title="Done"
                  className="p-1 rounded text-green-600 hover:bg-green-50"
                >
                  <CheckIcon className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setPlace(null)}
                title="Close"
                className="p-1 rounded text-gray-500 hover:bg-gray-200"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-3">
            {multiline ? (
              <textarea
                ref={field as React.RefObject<HTMLTextAreaElement>}
                data-cell-field={label}
                rows={4}
                className={`w-full border border-gray-300 rounded px-2 py-1.5 text-sm resize-y ${
                  readOnly ? 'bg-gray-50 text-gray-700' : ''}`}
                value={shown}
                readOnly={readOnly}
                onChange={e => onChange?.(e.target.value)}
              />
            ) : (
              <input
                ref={field as React.RefObject<HTMLInputElement>}
                data-cell-field={label}
                type={type}
                min={min}
                className={`w-full border border-gray-300 rounded px-2 py-1.5 text-sm ${
                  readOnly ? 'bg-gray-50 text-gray-700' : ''}`}
                value={shown}
                readOnly={readOnly}
                onChange={e => onChange?.(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') setPlace(null); }}
              />
            )}
            <p className="text-[10px] text-gray-400 mt-1.5">
              {readOnly
                ? 'Read-only — select the text to copy it.'
                : 'Typed straight into the row. Enter or Esc closes.'}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
