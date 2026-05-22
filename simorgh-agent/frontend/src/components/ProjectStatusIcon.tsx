/**
 * ProjectStatusIcon — the small dot next to a project in the sidebar.
 *
 * Maps the backend's RuntimeStatus to a Lucide icon + color, following
 * the Claude-Code-on-the-web vocabulary the user sketched out:
 *
 *   • blue dot         job finished, container resting → ready for input
 *   • animated dots    container running, CoT in progress
 *   • orange dot       container stopped with an unfinished CoT
 *   • purple branch    fresh simorgh branch, no commits yet
 *   • green branch     commits pushed to origin (latest local == remote)
 *   • red alert        last push rejected — requires_human_review
 *   • hollow circle    never started / archived
 *   • gray dot         cleanly stopped
 *
 * Priority order (highest first): conflict → busy → stopped_incomplete →
 * branch_pushed → branch_created → container state. A project that's
 * "busy AND pushed" shows BUSY (animated dots) because in-flight state
 * matters more than what's already up.
 */
import {
  AlertTriangle,
  Circle,
  GitBranch,
  GitMerge,
  CircleDot,
  Loader2,
} from 'lucide-react';
import type { RuntimeStatus } from '../types';

type Variant =
  | 'conflict'
  | 'busy'
  | 'stopped_incomplete'
  | 'merged'
  | 'pushed'
  | 'created'
  | 'paused'
  | 'stopped'
  | 'error'
  | 'idle';

interface VariantSpec {
  // Lucide component (or null when we render a custom dot).
  Icon: React.ComponentType<{ className?: string }> | null;
  // Tailwind classes — color and any extras (animate-spin, etc.).
  className: string;
  // Whether the icon is rendered as a Lucide SVG or as a styled dot
  // (an inline div with bg color).
  asDot?: boolean;
  // Hover-tooltip text.
  title: string;
}

const VARIANTS: Record<Variant, VariantSpec> = {
  conflict: {
    Icon: AlertTriangle,
    className: 'w-3.5 h-3.5 text-red-400',
    title: 'Push rejected — needs review',
  },
  busy: {
    Icon: Loader2,
    className: 'w-3.5 h-3.5 text-sky-400 animate-spin',
    title: 'Agent running…',
  },
  stopped_incomplete: {
    Icon: null,
    className: 'w-2.5 h-2.5 rounded-full bg-orange-400',
    asDot: true,
    title: 'Stopped before task completed',
  },
  merged: {
    Icon: GitMerge,
    className: 'w-3.5 h-3.5 text-emerald-400',
    title: 'Merged into base branch',
  },
  pushed: {
    Icon: GitBranch,
    className: 'w-3.5 h-3.5 text-emerald-400',
    title: 'Pushed to origin',
  },
  created: {
    Icon: GitBranch,
    className: 'w-3.5 h-3.5 text-violet-400',
    title: 'Branch created on origin',
  },
  paused: {
    Icon: null,
    className: 'w-2.5 h-2.5 rounded-full bg-sky-400',
    asDot: true,
    title: 'Container ready, awaiting input',
  },
  stopped: {
    Icon: null,
    className: 'w-2.5 h-2.5 rounded-full bg-gray-500',
    asDot: true,
    title: 'Container stopped',
  },
  error: {
    Icon: AlertTriangle,
    className: 'w-3.5 h-3.5 text-red-500',
    title: 'Container error',
  },
  idle: {
    Icon: Circle,
    className: 'w-3 h-3 text-gray-600',
    title: 'No active session',
  },
};

function pickVariant(status: RuntimeStatus | undefined): Variant {
  if (!status) return 'idle';
  if (status.branch === 'conflict') return 'conflict';
  if (status.container === 'error') return 'error';
  if (status.container === 'busy') return 'busy';
  if (status.container === 'stopped_incomplete') return 'stopped_incomplete';
  if (status.branch === 'merged') return 'merged';
  if (status.branch === 'pushed') return 'pushed';
  // Container is happily running and the work landed — show the calm
  // blue paused dot, not the purple "branch just created" icon.
  if (status.container === 'running' || status.container === 'paused')
    return 'paused';
  if (status.branch === 'created' || status.branch === 'committed')
    return 'created';
  if (status.container === 'stopped') return 'stopped';
  return 'idle';
}

export interface ProjectStatusIconProps {
  status?: RuntimeStatus;
  /** Override the auto tooltip — useful when the parent already wraps
   * the row in its own Tooltip. */
  title?: string;
  className?: string;
}

export function ProjectStatusIcon({
  status,
  title,
  className,
}: ProjectStatusIconProps) {
  const variant = pickVariant(status);
  const spec = VARIANTS[variant];
  const tooltip = title ?? spec.title;
  const extra = className ? ` ${className}` : '';

  if (spec.asDot || !spec.Icon) {
    return (
      <span
        aria-label={tooltip}
        title={tooltip}
        className={`inline-block flex-shrink-0${extra} ${spec.className}`}
        data-status-variant={variant}
      />
    );
  }

  const { Icon } = spec;
  return (
    <span
      aria-label={tooltip}
      title={tooltip}
      className={`inline-flex flex-shrink-0 items-center justify-center${extra}`}
      data-status-variant={variant}
    >
      <Icon className={spec.className} />
    </span>
  );
}

// Exported for tests so they don't have to re-render the component just
// to assert which variant fires for a given RuntimeStatus.
export const __pickVariant = pickVariant;
