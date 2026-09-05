import React, { useLayoutEffect, useRef, useState } from 'react';

interface Tab {
  id: number;
  title: string;
  component: React.ReactNode;
}
interface TabNavigationProps {
  tabs: Tab[];
  activeTab: number;
  onTabChange: (tabId: number) => void;
}

const SIZE = 40;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP_DEGREES = 85;
const GAP_LEN = CIRCUMFERENCE * (GAP_DEGREES / 360);
const HALF_GAP = GAP_LEN / 2;
const VISIBLE_LEN = CIRCUMFERENCE - GAP_LEN;
// SVG stroke-dasharray always draws its FIRST segment as visible (not a
// gap) — so "visible, gap" (in that order) plus a dashoffset that shifts
// the pattern by (visible + half-gap) is what centers the gap at the
// path's start point (3 o'clock).
const RING_DASHARRAY = `${VISIBLE_LEN} ${GAP_LEN}`;
const RING_DASHOFFSET = VISIBLE_LEN + HALF_GAP;
// Put the gap at the bottom-right of the ring, where the wire curls out.
const GAP_TILT_DEG = 50;
const GAP_RAD = (GAP_TILT_DEG * Math.PI) / 180;
// Exact point on the ring where the gap is centered — the connector curve
// starts here, so it visibly touches the cut edge with no floating gap.
const GAP_POINT = {
  x: CENTER + RADIUS * Math.cos(GAP_RAD),
  y: CENTER + RADIUS * Math.sin(GAP_RAD),
};
// Tangent direction the ring's stroke was travelling in (clockwise) right
// as it reaches the gap — used as the curve's initial direction, so it
// flows out of the ring instead of kinking off at a hard angle.
const GAP_TANGENT = { x: -Math.sin(GAP_RAD), y: Math.cos(GAP_RAD) };
// Fallback end point used only for the very first (pre-measurement) frame.
const FALLBACK_END = { x: SIZE, y: 33 };

interface EndPoint { x: number; y: number; }

const StepCircle: React.FC<{ n: number; active: boolean; endPoint: EndPoint }> = ({ n, active, endPoint }) => {
  const color = active ? '#f97316' /* orange-500 */ : '#1d4ed8' /* blue-700 */;
  return (
    <span className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} className="block overflow-visible">
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="#ffffff"
          stroke={color}
          strokeWidth={STROKE}
          strokeDasharray={RING_DASHARRAY}
          strokeDashoffset={RING_DASHOFFSET}
          transform={`rotate(${GAP_TILT_DEG} ${CENTER} ${CENTER})`}
        />
        {/* Smooth curve from the ring's cut edge to wherever the underline
            actually renders (measured live — see TabNavigation below):
            it leaves the ring tangent to the circle, then curls flat to
            arrive horizontally, blending straight into the underline. */}
        <path
          d={`M ${GAP_POINT.x} ${GAP_POINT.y} C ${GAP_POINT.x + GAP_TANGENT.x * 9} ${GAP_POINT.y + GAP_TANGENT.y * 9}, ${endPoint.x - 10} ${endPoint.y}, ${endPoint.x} ${endPoint.y}`}
          fill="none"
          stroke={color}
          strokeWidth={STROKE - 1}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-base font-bold" style={{ color }}>
        {n}
      </span>
    </span>
  );
};

export const TabNavigation: React.FC<TabNavigationProps> = ({
  tabs,
  activeTab,
  onTabChange
}) => {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const underlineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [endPoints, setEndPoints] = useState<EndPoint[]>([]);

  useLayoutEffect(() => {
    const measure = () => {
      setEndPoints(tabs.map((_, i) => {
        const btn = buttonRefs.current[i];
        const underline = underlineRefs.current[i];
        if (!btn || !underline) return FALLBACK_END;
        const b = btn.getBoundingClientRect();
        const u = underline.getBoundingClientRect();
        // Coordinates relative to the button's own top-left corner, which
        // is exactly where the circle SVG's (0,0) sits too.
        return { x: u.left - b.left, y: u.top - b.top + u.height / 2 };
      }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tabs]);

  return (
    <div className="flex items-center justify-center py-4">
      {tabs.map((tab, index) => {
        const isActive = index === activeTab;
        const isLast = index === tabs.length - 1;
        const color = isActive ? '#f97316' : '#1d4ed8';
        return (
          <button
            key={tab.id}
            ref={el => { buttonRefs.current[index] = el; }}
            type="button"
            onClick={() => onTabChange(index)}
            className={`flex items-start shrink-0 bg-transparent border-0 p-0 cursor-pointer ${isLast ? '' : 'mr-8'}`}
          >
            <StepCircle n={index + 1} active={isActive} endPoint={endPoints[index] ?? FALLBACK_END} />
            {/* Underline spans the FULL column width (from x=0, flush
                against the circle) while the label text itself is
                indented — so the wire visibly runs from the circle,
                continues under the text, and lines up with its end. */}
            <span className="inline-flex flex-col items-stretch">
              <span className="text-base font-bold whitespace-nowrap ml-2" style={{ color }}>{tab.title}</span>
              <span
                ref={el => { underlineRefs.current[index] = el; }}
                className="h-[2px] w-full mt-2"
                style={{ background: color }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
};
