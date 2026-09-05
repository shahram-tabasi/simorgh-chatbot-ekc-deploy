/**
 * TokenUsageRing — circular progress for context-window usage.
 *
 * Mirrors the Claude-Code "context window" ring the user pointed out
 * in their reference screenshot. Three colour stages, by ratio of
 * tokens-used to context-limit:
 *
 *   < 0.80   sky-blue   (calm, plenty of room)
 *   ≥ 0.80   amber      (heads up — compaction trigger is at 0.75 in
 *                        backend, so by 0.80 we're squarely in the
 *                        zone where the next turn may auto-compact)
 *   ≥ 0.95   red        (hard limit imminent)
 *
 * Renders as a 22×22 SVG with a stroke arc; falls back to a neutral
 * grey ring when total is unknown so the input bar layout doesn't
 * jump when telemetry is missing.
 */
import { useMemo } from 'react';

export interface TokenUsageRingProps {
  /** Tokens currently in the prompt (system + history + user). */
  used?: number | null;
  /** Model context limit (e.g. 32768 for gpt-oss, 1_000_000 for Opus). */
  total?: number | null;
  /** Optional override for the centre label; default is "PCT%". */
  label?: string;
  /** Tailwind size override; defaults to w-5 h-5. */
  className?: string;
}

interface Stage {
  stroke: string;
  text: string;
  label: string;
}

function stageFor(ratio: number): Stage {
  if (ratio >= 0.95) {
    return { stroke: 'stroke-red-400', text: 'text-red-300', label: 'Context near limit' };
  }
  if (ratio >= 0.8) {
    return { stroke: 'stroke-amber-400', text: 'text-amber-300', label: 'Context filling up' };
  }
  return { stroke: 'stroke-sky-400', text: 'text-sky-300', label: 'Context window' };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

export function TokenUsageRing({
  used,
  total,
  label,
  className = 'w-5 h-5',
}: TokenUsageRingProps) {
  const ratio = useMemo(() => {
    if (!total || total <= 0 || used == null) return 0;
    return Math.min(1, Math.max(0, used / total));
  }, [used, total]);

  const known = total != null && total > 0 && used != null;
  const stage = stageFor(ratio);
  const pct = Math.round(ratio * 100);
  const tooltip = known
    ? `${stage.label}: ${formatTokens(used!)} / ${formatTokens(total!)} (${pct}%)`
    : 'Context usage unknown';

  // SVG circle math: r=8 → C=2πr ≈ 50.265. The stroke uses
  // strokeDasharray=C and strokeDashoffset = C*(1−ratio) to fill.
  const R = 8;
  const C = 2 * Math.PI * R;
  const dashOffset = C * (1 - ratio);

  return (
    <span
      className={`relative inline-flex items-center justify-center flex-shrink-0 ${className}`}
      title={tooltip}
      aria-label={tooltip}
      data-token-ring-pct={pct}
    >
      <svg viewBox="0 0 20 20" className="w-full h-full -rotate-90">
        {/* Track */}
        <circle
          cx="10"
          cy="10"
          r={R}
          className="stroke-white/15"
          strokeWidth="2.2"
          fill="none"
        />
        {/* Progress arc */}
        {known && (
          <circle
            cx="10"
            cy="10"
            r={R}
            className={`${stage.stroke} transition-all duration-500`}
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={C}
            strokeDashoffset={dashOffset}
          />
        )}
      </svg>
      {label !== undefined && (
        <span
          className={`absolute inset-0 flex items-center justify-center text-[8px] font-semibold ${stage.text}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}

// Exported so a future test suite can pin the stage thresholds without
// re-rendering the SVG.
export const __stageFor = stageFor;
export const __formatTokens = formatTokens;
