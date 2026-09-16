import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, ChevronRightIcon, MinimizeIcon } from 'lucide-react';
import { PRODUCT_NAME } from '../../branding';

// What the screen does while EPLAN builds the project.
//
// Eplanix showed four short films full-bleed under "Creating project, please
// wait…". The films are the same four; everything else is not.
//
// ── Why it does not show steps any more ──────────────────────────────────
//
// It used to list five stages, lighting each one after twenty-five seconds.
// That was invention. `POST /draw` is a single blocking call: the bridge
// answers once, at the end, and nothing on this side knows what EPLAN is
// doing in between. On a job that finished inside half a minute the first
// stage lit and the other four never did — which is worse than saying
// nothing, because it read as though the job had stalled at step one.
//
// So this shows what is actually known and nothing else: that the request is
// out and unanswered, how long it has been, and what was sent. When there is
// real progress to report — a status endpoint on the bridge, a job id polled
// — this is where it goes, and then the stages can come back and be true.
//
// ── The carousel ─────────────────────────────────────────────────────────
//
// Three cards on a curve: the one playing in the middle, the one before and
// the one after held back, turned and dimmed at the sides. It reads as a deck
// somebody is leafing through rather than a video that fills the wall, which
// is both more modern and unmistakably not the Eplanix screen.

/** Read the way utils/buildStamp.ts reads it — vite/client's types are not in. */
const BASE = (import.meta as { env?: Record<string, string> }).env?.BASE_URL ?? '/';

/** The films, in the order they play. */
const FILMS = [
  { src: 'videos/creative.mp4', title: 'Creative' },
  { src: 'videos/api.mp4', title: 'API' },
  { src: 'videos/innovation.mp4', title: 'Innovation' },
  { src: 'videos/eplanix.mp4', title: 'Eplanix' },
];

/** After this long, it is worth saying that this is longer than usual. */
const LONG_JOB_SECONDS = 5 * 60;

interface Props {
  /** Shown while true; the films stop and unload when it goes false. */
  open: boolean;
  projectName: string;
  switchgear: string;
  /** 'sld' | 'old' | 'sldold' — said in words. */
  generationType: string;
  recordCount: number;
  onHide: () => void;
}

const DRAWING: Record<string, string> = {
  sld: 'Single line diagram',
  old: 'Outline drawing',
  sldold: 'Single line and outline drawings',
};

export const CreatingProjectSlideshow: React.FC<Props> = ({
  open, projectName, switchgear, generationType, recordCount, onHide,
}) => {
  const [current, setCurrent] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [playable, setPlayable] = useState(true);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    if (!open) { setSeconds(0); setCurrent(0); return; }
    const tick = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(tick);
  }, [open]);

  const show = (n: number) => {
    const next = (n + FILMS.length) % FILMS.length;
    setCurrent(next);
    videos.current.forEach((video, i) => {
      if (!video) return;
      if (i === next) {
        video.currentTime = 0;
        // A browser that refuses to autoplay is not a broken application: the
        // panel beside it is the part that matters, so the films step aside.
        video.play().catch(() => setPlayable(false));
      } else {
        video.pause();
        // Held at the first frame, so the cards at the sides are pictures
        // rather than black rectangles.
        video.currentTime = 0;
      }
    });
  };

  useEffect(() => {
    if (open) show(0);
    else videos.current.forEach(v => v?.pause());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') show(current - 1);
      if (e.key === 'ArrowRight') show(current + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open) return null;

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  /** Where a card sits: the centre, one of the two shoulders, or off-stage. */
  const placeOf = (i: number): number => {
    const half = Math.floor(FILMS.length / 2);
    let offset = i - current;
    if (offset > half) offset -= FILMS.length;
    if (offset < -half) offset += FILMS.length;
    return offset;
  };

  const cardStyle = (offset: number): React.CSSProperties => {
    const away = Math.abs(offset);
    if (away > 1) {
      // Off-stage: parked behind the centre so that coming back on is a move
      // inwards rather than a jump.
      return { transform: 'translateX(0) scale(0.6)', opacity: 0, zIndex: 0, pointerEvents: 'none' };
    }
    if (offset === 0) {
      return { transform: 'translateX(0) scale(1) rotateY(0deg)', opacity: 1, zIndex: 3 };
    }
    const side = offset < 0 ? -1 : 1;
    return {
      transform: `translateX(${side * 58}%) scale(0.78) rotateY(${side * -18}deg)`,
      opacity: 0.45,
      zIndex: 2,
      filter: 'saturate(0.6)',
    };
  };

  return createPortal(
    <div className="fixed inset-0 z-[10050] flex flex-col
                    bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
      <div className="flex items-center justify-between px-6 py-3 text-slate-300">
        <span className="text-sm">
          <strong className="text-white">{PRODUCT_NAME}</strong>
          <span className="mx-2 text-slate-600">·</span>
          Building <strong className="text-white">{projectName || 'the project'}</strong> on EPLAN
        </span>
        <button
          onClick={onHide}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white hover:bg-white/10"
          title="Put this away and carry on. The project keeps building."
        >
          <MinimizeIcon className="w-3.5 h-3.5" /> Hide
        </button>
      </div>

      {/* The deck */}
      <div className="flex-1 min-h-0 flex items-center justify-center px-4">
        <div className="relative w-full max-w-5xl" style={{ perspective: '1600px' }}>
          <div className="relative mx-auto w-[min(62vw,760px)] aspect-video"
               style={{ transformStyle: 'preserve-3d' }}>
            {FILMS.map((film, i) => {
              const offset = placeOf(i);
              return (
                <div
                  key={film.src}
                  onClick={() => offset !== 0 && show(i)}
                  style={{ ...cardStyle(offset), transition: 'transform .55s cubic-bezier(.22,.61,.36,1), opacity .55s, filter .55s' }}
                  className={`absolute inset-0 rounded-2xl overflow-hidden bg-black
                              ring-1 ring-white/10 shadow-[0_25px_60px_-15px_rgba(0,0,0,.8)]
                              ${offset !== 0 ? 'cursor-pointer' : ''}`}
                >
                  <video
                    ref={el => { videos.current[i] = el; }}
                    muted
                    playsInline
                    preload={i === 0 ? 'auto' : 'metadata'}
                    onEnded={() => { if (offset === 0) show(current + 1); }}
                    onError={() => setPlayable(false)}
                    className="w-full h-full object-cover"
                  >
                    <source src={`${BASE}${film.src}`} type="video/mp4" />
                  </video>

                  {/* A little weight at the bottom so the title reads over
                      whatever frame the film happens to be on. */}
                  <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
                  <span className="absolute bottom-3 left-4 text-xs tracking-[0.2em] uppercase text-white/80">
                    {film.title}
                  </span>
                </div>
              );
            })}

            {!playable && (
              <div className="absolute inset-0 rounded-2xl bg-slate-900 ring-1 ring-white/10
                              flex items-center justify-center text-slate-500 text-sm z-[4]">
                {PRODUCT_NAME}
              </div>
            )}
          </div>

          <button
            onClick={() => show(current - 1)}
            aria-label="Previous"
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full
                       bg-white/5 text-white/70 hover:bg-white/15 hover:text-white
                       backdrop-blur transition"
          >
            <ChevronLeftIcon className="w-6 h-6" />
          </button>
          <button
            onClick={() => show(current + 1)}
            aria-label="Next"
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full
                       bg-white/5 text-white/70 hover:bg-white/15 hover:text-white
                       backdrop-blur transition"
          >
            <ChevronRightIcon className="w-6 h-6" />
          </button>

          <div className="flex justify-center gap-2 mt-6">
            {FILMS.map((film, i) => (
              <button
                key={film.src}
                onClick={() => show(i)}
                aria-label={film.title}
                title={film.title}
                className={`h-1.5 rounded-full transition-all ${
                  i === current ? 'w-8 bg-white' : 'w-1.5 bg-white/30 hover:bg-white/60'}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* What is actually known. */}
      <div className="px-6 pb-8 pt-2">
        <div className="max-w-3xl mx-auto text-center">
          <p className="flex items-center justify-center gap-3 text-white text-lg">
            {/* Indeterminate, because that is what this is. */}
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
            </span>
            EPLAN is building the project
            <span className="text-slate-400 text-base tabular-nums">{clock}</span>
          </p>

          <p className="mt-3 text-sm text-slate-400">
            {[
              switchgear,
              DRAWING[generationType] || generationType,
              `${recordCount} record${recordCount === 1 ? '' : 's'} sent`,
            ].filter(Boolean).join('  ·  ')}
          </p>

          <p className="mt-4 text-xs text-slate-500 max-w-xl mx-auto leading-relaxed">
            {seconds >= LONG_JOB_SECONDS
              ? 'This is longer than these usually take. It has not failed — EPLAN answers '
                + 'once the whole project is written — but it is worth a look at the EPLAN '
                + 'machine if it stays here.'
              : 'EPLAN answers once, when the project is finished, so there is no progress to '
                + 'report in between. This closes itself the moment it answers.'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default CreatingProjectSlideshow;
