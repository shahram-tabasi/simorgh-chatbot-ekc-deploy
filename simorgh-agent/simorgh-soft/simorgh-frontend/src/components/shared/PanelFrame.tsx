import React, { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { usePanel } from '../../context/PanelsContext';

// The chrome round a panel that can be rolled up or put away.
//
// Two different things, deliberately kept apart, because a drawing office means
// two different things by them:
//
//   Collapse — roll the body up and leave the title bar. The panel is still
//              there and still holds its place; you have just stopped looking
//              at it. Local to the panel, so it costs nothing to try.
//   Close    — take it off the screen entirely and give its room to whatever
//              was sharing the row. It comes back from View → Panels, which is
//              where EPLAN keeps its navigators too.
//
// Closing is never destructive: a panel is a view of something the project
// already holds, so what is in it is exactly where it was when it reopens.

interface Props {
  /** Stable across sessions — it is the key the open/closed state is kept under. */
  id: string;
  title: string;
  /** A line under the title, for what the panel is for. */
  note?: string;
  /** Shown in View → Panels; defaults to `title`. */
  menuLabel?: string;
  /** Which heading it is grouped under in that menu. */
  group?: string;
  /** Buttons of the panel's own, to the left of collapse and close. */
  actions?: React.ReactNode;
  /** Rolled up to begin with. */
  initiallyCollapsed?: boolean;
  className?: string;
  /** Extra classes for the body, e.g. a height or an overflow rule. */
  bodyClassName?: string;
  children: React.ReactNode;
}

export const PanelFrame: React.FC<Props> = ({
  id, title, note, menuLabel, group, actions,
  initiallyCollapsed = false, className = '', bodyClassName = '', children,
}) => {
  const panel = usePanel({ id, label: menuLabel ?? title, group, note });
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  // Closed panels render nothing at all — no rail, no stub. That is the point:
  // the row beside it gets the whole width back. View → Panels is what knows
  // it exists, and it has known since the first time this ran.
  if (!panel.open) return null;

  return (
    <section
      data-panel={id}
      className={`border border-gray-200 rounded-md bg-white flex flex-col min-h-0 ${className}`}
    >
      <header className="flex items-start gap-2 px-3 py-2 bg-gray-50 border-b rounded-t-md">
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          data-panel-collapse={id}
          className="mt-0.5 p-0.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-200 shrink-0"
        >
          {collapsed ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
        </button>

        {/* The whole heading is the collapse control, the way a tree node is. */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className="min-w-0 flex-1 text-left"
        >
          <h4 className="text-sm font-medium text-gray-800 truncate">{title}</h4>
          {note && !collapsed && (
            <p className="text-[11px] text-gray-500 leading-snug">{note}</p>
          )}
        </button>

        <div className="flex items-center gap-1 shrink-0">
          {actions}
          <button
            onClick={panel.hide}
            title="Close this panel — View → Panels brings it back"
            data-panel-close={id}
            className="p-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-200"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className={`min-h-0 ${bodyClassName}`}>{children}</div>
      )}
    </section>
  );
};
