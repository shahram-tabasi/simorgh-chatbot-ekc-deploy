// src/components/QuotaIndicator.tsx
//
// Compact quota indicator + popover. Replaces the large "Free Tier
// 20/20 — Upgrade plan →" tile that used to sit in the sidebar.
//
// Renders as a small clickable circular ring (intended to live next
// to the "Simorgh AI" wordmark in the sidebar header). The ring
// fills proportionally to questions_used_today / questions_limit,
// stage-coloured like the previous tile:
//
//   ratio < 0.75   emerald   (plenty left)
//   0.75 ≤ < 1.0   amber     (heads up)
//   ratio ≥ 1.0    red       (quota exceeded)
//
// On click, a popover opens with:
//   • tier name + remaining/total
//   • progress bar
//   • "resets at <time>" if resets_at is provided
//   • upgrade-plan link
//
// Admin / Max ("unlimited") tiers render the ring as a static ∞
// glyph and the popover hides the upgrade link.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

interface Props {
  used: number;
  total: number;
  remaining: number;
  tier: string;
  resetsAt?: string;
  /** Hide ring fill / upgrade link for admin / max tiers. */
  unlimited?: boolean;
  /** Where the popover opens relative to the ring. `'bottom'` is
      the default for the sidebar-header layout. The chat-input
      footer at the bottom of the screen passes `'top'` so the
      popover doesn't clip below the viewport. */
  placement?: 'top' | 'bottom';
}

function stageStrokeClass(ratio: number): string {
  if (ratio >= 1.0) return 'stroke-red-400';
  if (ratio >= 0.75) return 'stroke-amber-400';
  return 'stroke-emerald-400';
}
function stageTextClass(ratio: number): string {
  if (ratio >= 1.0) return 'text-red-300';
  if (ratio >= 0.75) return 'text-amber-300';
  return 'text-emerald-300';
}
function stageBarClass(ratio: number): string {
  if (ratio >= 1.0) return 'bg-red-400';
  if (ratio >= 0.75) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function formatResetsAt(raw?: string): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${d.getDate()}/${d.getMonth() + 1} ${hh}:${mm}`;
  } catch {
    return null;
  }
}

export function QuotaIndicator({
  used,
  total,
  remaining,
  tier,
  resetsAt,
  unlimited = false,
  placement = 'bottom',
}: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close popover on outside click. Stops the popover from staying
  // open when the user navigates the sidebar elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const ratio = useMemo(() => {
    if (!total || total <= 0) return 0;
    return Math.min(1.5, Math.max(0, used / total));
  }, [used, total]);
  const percent = Math.round(ratio * 100);

  // SVG ring math: r=11 → C ≈ 69.12. Cap visible arc at 100%.
  const R = 11;
  const C = 2 * Math.PI * R;
  const dashOffset = C * (1 - Math.min(1, ratio));
  const strokeClass = stageStrokeClass(ratio);
  const textClass = stageTextClass(ratio);
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free';
  const resetsAtPretty = formatResetsAt(resetsAt);

  return (
    <div ref={wrapRef} className="relative">
      {/* The button itself — small enough to live in a header row. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          unlimited
            ? `${tierLabel} — unlimited`
            : `${remaining}/${total} ${t('questionsRemaining') || 'remaining'}`
        }
        aria-label="Quota"
        aria-expanded={open}
        className={`relative inline-flex items-center justify-center w-7 h-7 rounded-full
                    transition focus:outline-none
                    ${open ? 'ring-2 ring-violet-400/50' : 'hover:bg-white/[0.06]'}`}
      >
        <svg viewBox="0 0 28 28" className="w-full h-full -rotate-90">
          <circle
            cx="14"
            cy="14"
            r={R}
            className="stroke-white/15"
            strokeWidth="2.5"
            fill="none"
          />
          {!unlimited && (
            <circle
              cx="14"
              cy="14"
              r={R}
              className={`${strokeClass} transition-all duration-500`}
              strokeWidth="2.5"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={C}
              strokeDashoffset={dashOffset}
            />
          )}
        </svg>
        <span
          className={`absolute inset-0 flex items-center justify-center text-[9px] font-bold ${
            unlimited ? 'text-gray-300' : textClass
          }`}
        >
          {unlimited ? '∞' : `${remaining}`}
        </span>
      </button>

      {/* Popover — opens above OR below the ring based on `placement`.
          The chat-input footer at the bottom of the viewport passes
          'top' so the popover doesn't clip below the screen edge.
          Right-anchored either way so wide sidebars / wide composers
          don't push it off-screen on the right. */}
      {open && (
        <div
          className={`absolute right-0 z-50 w-64
                      rounded-lg border border-white/10 bg-slate-900/95
                      backdrop-blur shadow-2xl p-3 text-[12px] text-gray-200
                      ${placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'}`}
        >
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[13px] font-semibold text-white">
              {tierLabel} {unlimited ? '' : (t('tier') || 'Tier')}
            </span>
            {!unlimited && (
              <span className={`text-[11px] font-mono ${textClass}`}>
                {remaining}/{total}
              </span>
            )}
          </div>

          {!unlimited && (
            <>
              {/* Progress bar — same stage colours as the ring above. */}
              <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                <div
                  className={`h-full ${stageBarClass(ratio)} transition-all duration-500`}
                  style={{ width: `${Math.min(100, percent)}%` }}
                />
              </div>
              <div className="mt-1 flex items-baseline justify-between text-[10px] text-gray-400">
                <span>
                  {used} {t('questionsUsedToday') || 'used today'}
                </span>
                <span>{percent}%</span>
              </div>
            </>
          )}

          {resetsAtPretty && !unlimited && (
            <div className="mt-2 text-[11px] text-gray-400">
              {t('resetsAt') || 'Resets at'}{' '}
              <span className="text-gray-200 font-mono">{resetsAtPretty}</span>
            </div>
          )}

          {!unlimited && (
            <Link
              to="/upgrade"
              onClick={() => setOpen(false)}
              className="mt-3 block text-center px-3 py-1.5 rounded-md
                         bg-gradient-to-r from-sky-500/20 via-violet-500/20 to-fuchsia-500/20
                         border border-violet-400/30 text-violet-200 hover:text-white
                         hover:border-violet-400/60 transition text-[12px] font-medium
                         no-underline"
            >
              {t('upgradePlan')} →
            </Link>
          )}

          {unlimited && (
            <div className="text-[11px] text-gray-400 leading-relaxed">
              {t('unlimitedDescription') ||
                'Your tier has unlimited questions per day.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
