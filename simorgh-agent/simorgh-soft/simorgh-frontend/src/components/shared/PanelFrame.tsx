import React, { useState } from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, ChevronLeftIcon, XIcon,
} from 'lucide-react';
import { usePanel } from '../../context/PanelsContext';

// The chrome round a panel that can be rolled up or put away.
//
// Two different things, deliberately kept apart, because a drawing office means
// two different things by them:
//
//   Collapse — fold the body away and leave a handle. The panel is still there
//              and still holds its place; you have just stopped looking at it.
//              Local to the panel, so it costs nothing to try.
//   Close    — take it off the screen entirely and give its room to whatever
//              was sharing the row. It comes back from View → Panels, which is
//              where EPLAN keeps its navigators too.
//
// Closing is never destructive: a panel is a view of something the project
// already holds, so what is in it is exactly where it was when it reopens.
//
// **Which way it folds** depends on where it sits. A panel stacked above or
// below its neighbours rolls up, keeping its title bar. A panel *beside* them —
// a tree down the left, a schematic down the right — folds sideways to a narrow
// rail with its name written up it, because folding such a panel upwards would
// leave a full-width title bar sitting on nothing and give the table beside it
// no width at all. `side` is what says so.

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
  /**
   * Which edge of its row the panel is docked to.
   *
   * Set it and the panel folds sideways to a rail against that edge instead of
   * rolling up. Leave it off for a panel that spans its row.
   */
  side?: 'left' | 'right';
  /** Folded away to begin with. */
  initiallyCollapsed?: boolean;
  className?: string;
  /**
   * Extra classes for the body, e.g. a height or an overflow rule.
   *
   * Also the width the panel returns to: a docked panel's own `className`
   * carries its width, and the rail replaces it while folded.
   */
  bodyClassName?: string;
  children: React.ReactNode;
}

export const PanelFrame: React.FC<Props> = ({
  id, title, note, menuLabel, group, actions, side,
  initiallyCollapsed = false, className = '', bodyClassName = '', children,
}) => {
  const panel = usePanel({ id, label: menuLabel ?? title, group, note });
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  // Closed panels render nothing at all — no rail, no stub. That is the point:
  // the row beside it gets the whole width back. View → Panels is what knows
  // it exists, and it has known since the first time this ran.
  if (!panel.open) return null;

  // ── Folded sideways: a rail with the name up it ─────────────────────────
  //
  // The whole rail is the way back, not just the chevron — it is a 36px target
  // and there is only one thing it can mean.
  if (side && collapsed) {
    return (
      <section
        data-panel={id}
        data-panel-rail={id}
        className="w-9 shrink-0 self-stretch border border-gray-200 rounded-md bg-gray-50 flex flex-col items-center py-2 gap-2"
      >
        <button
          onClick={() => setCollapsed(false)}
          data-panel-collapse={id}
          title={`Expand ${title}`}
          aria-expanded={false}
          className="flex-1 w-full flex flex-col items-center gap-2 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded"
        >
          {side === 'left'
            ? <ChevronRightIcon className="w-4 h-4 shrink-0" />
            : <ChevronLeftIcon className="w-4 h-4 shrink-0" />}
          <span className="text-[11px] font-medium tracking-wide whitespace-nowrap [writing-mode:vertical-rl] rotate-180">
            {title}
          </span>
        </button>
        <button
          onClick={panel.hide}
          title="Close this panel — View → Panels brings it back"
          data-panel-close={id}
          className="p-1 rounded text-gray-400 hover:text-gray-900 hover:bg-gray-200 shrink-0"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </section>
    );
  }

  // Which way the header chevron points: back towards the edge the panel is
  // docked to, because that is where it is about to go.
  const FoldIcon = !side ? ChevronDownIcon
    : side === 'left' ? ChevronLeftIcon
    : ChevronRightIcon;

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
          {collapsed ? <ChevronRightIcon className="w-4 h-4" /> : <FoldIcon className="w-4 h-4" />}
        </button>

        {/* The whole heading is the fold control, the way a tree node is. */}
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
