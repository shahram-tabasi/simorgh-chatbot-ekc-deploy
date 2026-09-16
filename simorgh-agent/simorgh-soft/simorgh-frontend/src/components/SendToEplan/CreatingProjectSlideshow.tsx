import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, ChevronRightIcon, MinimizeIcon, CheckIcon } from 'lucide-react';
import { PRODUCT_NAME } from '../../branding';

// What the screen does while EPLAN builds the project.
//
// Eplanix showed four short films on a full-screen slider under the words
// "Creating project, please wait…", and they are here — the same four, from
// the same place. The reason to keep them is not decoration. Creating a
// project on the EPLAN server takes minutes, and a screen that sits still for
// minutes is a screen somebody reloads, presses again, or reports as hung.
//
// What is different is everything around them. The original said only "please
// wait" with three animated dots, and answered no part of the real question:
// how far along is it, and is anything still happening. So beside the film
// there is the job — the switchgear, the drawing being made, how many records
// went, how long it has been — and the steps it goes through, each ticked as
// it passes. The film is what makes the wait bearable; the panel is what makes
// it trustworthy.
//
// It can be put away. A wait of minutes is a wait somebody wants to spend
// doing something else, and hiding the films does not stop the job — the tab
// keeps its own "Sending…" state underneath.

// Read the way utils/buildStamp.ts reads it: this project does not pull in
// vite/client's types, so `import.meta.env` is not typed here.
const BASE = (import.meta as { env?: Record<string, string> }).env?.BASE_URL ?? '/';

/** The films, in the order they play. */
const FILMS = [
  { src: 'videos/creative.mp4', title: 'Creative' },
  { src: 'videos/api.mp4', title: 'API' },
  { src: 'videos/innovation.mp4', title: 'Innovation' },
  { src: 'videos/eplanix.mp4', title: 'Eplanix' },
];

/**
 * What the EPLAN side is doing, in the order it does it.
 *
 * Not measured — the bridge reports one answer at the end, not progress — so
 * these advance on their own timing and the last one stays lit until the job
 * really finishes. Said plainly in the caption underneath, because a progress
 * bar that is quietly making it up is worse than none.
 */
const STEPS = [
  'Sending the records to the EPLAN bridge',
  'Opening the project on the EPLAN server',
  'Placing the feeders and their parts',
  'Drawing the pages',
  'Finishing and saving',
];

/** How long each step is given before the next lights up, in ms. */
const STEP_MS = 25_000;

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

  // The clock, and the steps that come off it.
  useEffect(() => {
    if (!open) { setSeconds(0); setCurrent(0); return; }
    const tick = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(tick);
  }, [open]);

  const step = Math.min(STEPS.length - 1, Math.floor((seconds * 1000) / STEP_MS));

  const show = (n: number) => {
    const next = (n + FILMS.length) % FILMS.length;
    setCurrent(next);
    videos.current.forEach((video, i) => {
      if (!video) return;
      if (i === next) {
        video.currentTime = 0;
        // A browser that refuses to autoplay is not a broken application: the
        // panel beside it is the part that matters, so the failure is noted
        // and the films step aside.
        video.play().catch(() => setPlayable(false));
      } else {
        video.pause();
      }
    });
  };

  // Start on the first film, and stop everything when the job ends.
  useEffect(() => {
    if (open) show(0);
    else videos.current.forEach(v => v?.pause());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Arrow keys, because a slideshow that only answers the mouse is annoying
  // on the sort of screen this is shown on.
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

  const mins = Math.floor(seconds / 60);
  const clock = `${mins}:${String(seconds % 60).padStart(2, '0')}`;

  return createPortal(
    <div className="fixed inset-0 z-[10050] bg-slate-950/95 backdrop-blur-sm flex flex-col">
      {/* Top line: whose project, and a way out of the way. */}
      <div className="flex items-center justify-between px-6 py-3 text-slate-300">
        <span className="text-sm">
          <strong className="text-white">{PRODUCT_NAME}</strong>
          <span className="mx-2 text-slate-600">·</span>
          Creating <strong className="text-white">{projectName || 'the project'}</strong> on EPLAN
        </span>
        <button
          onClick={onHide}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white hover:bg-white/10"
          title="Put this away and carry on. The project keeps building."
        >
          <MinimizeIcon className="w-3.5 h-3.5" /> Hide
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row items-center justify-center gap-8 px-6 pb-6">
        {/* The films */}
        <div className="relative w-full max-w-3xl aspect-video rounded-2xl overflow-hidden
                        shadow-2xl ring-1 ring-white/10 bg-black shrink-0">
          {FILMS.map((film, i) => (
            <video
              key={film.src}
              ref={el => { videos.current[i] = el; }}
              muted
              playsInline
              preload={i === 0 ? 'auto' : 'metadata'}
              onEnded={() => show(current + 1)}
              onError={() => setPlayable(false)}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${
                i === current ? 'opacity-100' : 'opacity-0'}`}
            >
              <source src={`${BASE}${film.src}`} type="video/mp4" />
            </video>
          ))}

          {!playable && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              {PRODUCT_NAME}
            </div>
          )}

          <button
            onClick={() => show(current - 1)}
            aria-label="Previous"
            className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white/80 hover:bg-black/70 hover:text-white transition"
          >
            <ChevronLeftIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => show(current + 1)}
            aria-label="Next"
            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/40 text-white/80 hover:bg-black/70 hover:text-white transition"
          >
            <ChevronRightIcon className="w-5 h-5" />
          </button>

          {/* Dots rather than only arrows: how many there are, and where you
              are among them, without having to click to find out. */}
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-2">
            {FILMS.map((film, i) => (
              <button
                key={film.src}
                onClick={() => show(i)}
                aria-label={film.title}
                title={film.title}
                className={`h-1.5 rounded-full transition-all ${
                  i === current ? 'w-7 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/70'}`}
              />
            ))}
          </div>
        </div>

        {/* The job */}
        <div className="w-full max-w-sm text-slate-300">
          <div className="flex items-baseline justify-between mb-4">
            <p className="text-white font-medium">Working…</p>
            <p className="text-sm tabular-nums text-slate-400">{clock}</p>
          </div>

          <dl className="text-sm space-y-1.5 mb-5">
            {[
              ['Switchgear', switchgear || '—'],
              ['Drawing', DRAWING[generationType] || generationType || '—'],
              ['Records sent', String(recordCount)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-slate-200 text-right truncate">{value}</dd>
              </div>
            ))}
          </dl>

          <ol className="space-y-2">
            {STEPS.map((text, i) => (
              <li key={text} className="flex items-start gap-2.5 text-sm">
                <span className={`mt-0.5 w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[10px] ${
                  i < step ? 'bg-emerald-500 text-white'
                  : i === step ? 'bg-blue-500 text-white animate-pulse'
                  : 'bg-slate-700 text-slate-500'}`}>
                  {i < step ? <CheckIcon className="w-2.5 h-2.5" /> : i + 1}
                </span>
                <span className={i <= step ? 'text-slate-200' : 'text-slate-500'}>{text}</span>
              </li>
            ))}
          </ol>

          <p className="mt-5 text-xs text-slate-500 leading-relaxed">
            These steps run on the EPLAN server, which reports once at the end rather than
            as it goes — so they are timed, not measured. What is certain is that the job
            is still running: this screen closes itself the moment it answers.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default CreatingProjectSlideshow;
