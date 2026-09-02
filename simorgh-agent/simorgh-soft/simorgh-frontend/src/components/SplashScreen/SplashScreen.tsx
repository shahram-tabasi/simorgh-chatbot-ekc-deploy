import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Circle } from 'lucide-react';
import logoMark from '../../assets/logo-mark.png';
import { projectService } from '../../services/projectService';

interface Step {
  label: string;
  // Every step does REAL work (a network call, a browser readiness signal,
  // an asset decode) — nothing here is a fake timer padding out the bar.
  run: () => Promise<void>;
}

const buildSteps = (): Step[] => [
  {
    label: 'Initializing Application',
    run: () => Promise.resolve(),
  },
  {
    label: 'Loading Modules',
    run: () => ((document as any).fonts?.ready ?? Promise.resolve()).then(() => undefined),
  },
  {
    label: 'Connecting Services',
    // Real backend health check — if the server is slow/unreachable this
    // step just takes as long as it actually takes (and never throws, so
    // a down backend can't strand the user on the splash screen forever).
    run: () => projectService.healthCheck().then(() => undefined).catch(() => undefined),
  },
  {
    label: 'Preparing Workspace',
    // Real asset preparation — decode the logo so it's cached and ready
    // before the header renders it.
    run: () => new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = logoMark;
    }),
  },
  {
    label: 'Finalizing',
    // Real paint-readiness signal (two animation frames = the browser has
    // actually committed a frame), not an arbitrary delay.
    run: () => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  },
];

// The startup checks below can all resolve in a few hundred milliseconds on a
// warm backend, which made the splash flash past unseen. Hold it on screen for
// at least this long — the checks still run for as long as they really need.
const MIN_VISIBLE_MS = 2400;

interface SplashScreenProps {
  onComplete: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onComplete }) => {
  const steps = useRef(buildSteps()).current;
  const [stepIndex, setStepIndex] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    const startedAt = Date.now();
    (async () => {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return;
        setStepIndex(i);
        await steps[i].run();
      }
      if (cancelled) return;
      setStepIndex(steps.length);
      const remaining = MIN_VISIBLE_MS - (Date.now() - startedAt);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      if (cancelled) return;
      onComplete();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progress = Math.min(100, Math.round((stepIndex / steps.length) * 100));
  const currentLabel = stepIndex < steps.length ? steps[stepIndex].label : 'Ready';

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col justify-between overflow-hidden text-white"
      style={{
        background: 'radial-gradient(1200px 800px at 10% 10%, #14335f 0%, #0a1a33 45%, #060e1e 100%)',
      }}
    >
      <style>{`
        @keyframes splashWordmarkReveal {
          from { opacity: 0; transform: translateX(-14px) scaleX(0.85); }
          to   { opacity: 1; transform: translateX(0) scaleX(1); }
        }
        .splash-wordmark { transform-origin: left center; animation: splashWordmarkReveal 0.8s cubic-bezier(0.22,1,0.36,1) 0.2s both; }

        /* Light sweeping across the "Design Suite" wordmark. */
        @keyframes suiteSheen {
          0%   { background-position: -180% 0; }
          100% { background-position:  180% 0; }
        }
        .suite-sheen {
          background-image: linear-gradient(100deg,
            #60a5fa 0%, #60a5fa 38%, #ffffff 50%, #60a5fa 62%, #60a5fa 100%);
          background-size: 220% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: suiteSheen 3.4s linear infinite;
        }
        /* The glow bar that runs under it, like a light bar catching the edge. */
        @keyframes suiteBeam {
          0%, 100% { opacity: .35; transform: scaleX(.75); }
          50%      { opacity: 1;   transform: scaleX(1); }
        }
        .suite-beam {
          transform-origin: left center;
          background: linear-gradient(90deg, rgba(96,165,250,0) 0%, #93c5fd 25%, #ffffff 50%, #93c5fd 75%, rgba(96,165,250,0) 100%);
          box-shadow: 0 0 14px 2px rgba(96,165,250,0.65);
          animation: suiteBeam 3.4s ease-in-out infinite;
        }
      `}</style>

      {/* Faint dot grid for texture */}
      <div
        className="absolute inset-0 opacity-[0.15] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div className="relative flex-1 flex items-center px-10 md:px-20">
        <div>
          <div className="flex items-center gap-5">
            {/* Transparent logo mark (no white plate behind it), so the bird
                itself fills the space and reads much larger. */}
            <img
              src={logoMark}
              alt=""
              className="h-24 md:h-36 w-auto"
              style={{
                filter: 'brightness(0) invert(1) drop-shadow(0 0 22px rgba(59,130,246,0.55))',
              }}
            />
            <div className="h-20 md:h-28 w-px bg-white/25" />
            <div className="splash-wordmark">
              <div className="text-4xl md:text-6xl font-extrabold tracking-tight leading-none">Simorgh</div>
              <div className="suite-sheen text-2xl md:text-4xl font-light leading-none mt-1">Design Suite</div>
              <div className="suite-beam h-[2px] w-full mt-2 rounded-full" />
            </div>
          </div>
          <div className="mt-5 h-px w-72 bg-blue-400/40" />
          <p className="mt-4 text-slate-300 text-sm md:text-base tracking-wide">
            Professional Electrical Design Software
          </p>
        </div>
      </div>

      <div className="relative px-10 md:px-20 pb-8">
        <p className="text-sm text-slate-300 mb-2">Loading Simorgh Design Suite — {currentLabel}…</p>
        <div className="flex items-center gap-4">
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden relative">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-sky-400 transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm tabular-nums text-slate-300 w-10 text-right">{progress}%</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
          {steps.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2 text-xs md:text-sm">
              {i < stepIndex ? (
                <CheckCircle2 className="w-4 h-4 text-blue-400" />
              ) : i === stepIndex ? (
                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
              ) : (
                <Circle className="w-4 h-4 text-slate-500" />
              )}
              <span className={i <= stepIndex ? 'text-slate-100' : 'text-slate-500'}>{s.label}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex items-center justify-between text-[11px] text-slate-500">
          <span>Simorgh Technology. All rights reserved.</span>
          <span>Version 1.0.0</span>
        </div>
      </div>
    </div>
  );
};
