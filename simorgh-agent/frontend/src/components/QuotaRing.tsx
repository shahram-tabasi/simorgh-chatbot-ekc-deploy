// src/components/QuotaRing.tsx
//
// Compact tier badge: a circular usage ring (same idiom as the
// TokenUsageRing in the chat composer) wrapped in a clickable row
// that routes to /upgrade. Replaces the old linear progress bar
// quota badge in the sidebar — operator wanted the ring style with
// click-to-upgrade affordance.
//
// Colour stages mirror useQuota's warning thresholds:
//   ratio < 0.75   emerald   (plenty left)
//   0.75 ≤ < 1.0   amber     (heads up)
//   ratio ≥ 1.0    red       (quota exceeded)
//
// Admin / Max tiers get a neutral "∞" tile (no ring, no upgrade
// link) since their quota is effectively unlimited.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

interface Props {
  used: number;        // questions_used_today
  total: number;       // questions_limit
  remaining: number;   // questions_remaining
  tier: string;        // 'free' | 'pro' | 'max' | 'admin' | ...
  /** Hide the upgrade link (true for admin / max tiers). */
  unlimited?: boolean;
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

export function QuotaRing({ used, total, remaining, tier, unlimited = false }: Props) {
  const { t } = useLanguage();
  const ratio = useMemo(() => {
    if (!total || total <= 0) return 0;
    return Math.min(1.5, Math.max(0, used / total));
  }, [used, total]);

  // SVG ring math: r=14 → C ≈ 87.96. We cap the visible arc at 100%
  // even if usage briefly overshoots so the ring never wraps around.
  const R = 14;
  const C = 2 * Math.PI * R;
  const dashOffset = C * (1 - Math.min(1, ratio));
  const strokeClass = stageStrokeClass(ratio);
  const textClass = stageTextClass(ratio);
  const tierLabel = tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free';

  const inner = (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] hover:border-white/20 transition group">
      {/* Ring */}
      <span className="relative inline-flex items-center justify-center flex-shrink-0 w-9 h-9" aria-hidden>
        <svg viewBox="0 0 32 32" className="w-full h-full -rotate-90">
          <circle cx="16" cy="16" r={R} className="stroke-white/15" strokeWidth="3" fill="none" />
          {!unlimited && (
            <circle
              cx="16"
              cy="16"
              r={R}
              className={`${strokeClass} transition-all duration-500`}
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
              strokeDasharray={C}
              strokeDashoffset={dashOffset}
            />
          )}
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center text-[9px] font-bold ${unlimited ? 'text-gray-300' : textClass}`}>
          {unlimited ? '∞' : `${remaining}`}
        </span>
      </span>

      {/* Text block */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-gray-300 font-medium truncate">
            {tierLabel} {unlimited ? '' : 'Tier'}
          </span>
          {!unlimited && (
            <span className={`text-[11px] font-mono ${textClass} flex-shrink-0`}>
              {remaining}/{total}
            </span>
          )}
        </div>
        {!unlimited && (
          <div className="mt-0.5 text-[10px] text-blue-300/80 group-hover:text-blue-200 transition">
            {t('upgradePlan')} →
          </div>
        )}
      </div>
    </div>
  );

  if (unlimited) return <div className="mx-2 mb-2">{inner}</div>;
  return (
    <Link to="/upgrade" className="block mx-2 mb-2 no-underline" title={t('upgradePlan')}>
      {inner}
    </Link>
  );
}
