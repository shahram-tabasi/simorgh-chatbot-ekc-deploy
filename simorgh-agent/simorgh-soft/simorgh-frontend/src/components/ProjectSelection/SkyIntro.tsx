// src/components/ProjectSelection/SkyIntro.tsx
//
// The sky the project screen sits in: stars, a meteor shower, the Simorgh
// title above the dialog, and the Simorgh itself — which beats its wings over
// the title for a moment, where it stands in the office's artwork, and then
// flies off the screen.
//
// The artwork came on a green screen. It was keyed out once, offline, and what
// ships is the result (public/intro/): the title as a WebP with its own alpha,
// the flight as a VP9 WebM with alpha. Keyed so the glow stays: the alpha is
// how much greener a pixel is than the screen, and the colour is un-mixed from
// the screen, so a half-transparent feather keeps its own cyan instead of a
// green cast. The video's frame edges are feathered, so the tail and the wing
// tips that leave the frame fade out rather than stop at a line.
//
// Nothing here takes a click. It is all behind or above the dialog with
// pointer-events off, and "reduce motion" leaves a still sky and the title.

import React, { useEffect, useRef, useState } from 'react';

const BASE = ((import.meta as { env?: Record<string, string> }).env?.BASE_URL ?? '/').replace(/\/+$/, '/');
const asset = (name: string) => `${BASE}intro/${name}`;

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Stars and meteors ───────────────────────────────────────────────────────

interface Star { x: number; y: number; r: number; base: number; tw: number; ph: number; hue: number; depth: number }
interface Meteor { x: number; y: number; vx: number; vy: number; len: number; life: number; age: number; w: number }

/** The sky, drawn on one canvas behind everything. */
export const Starfield: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = prefersReducedMotion();

    let w = 0, h = 0, dpr = 1;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let nextMeteor = 0;
    let raf = 0;
    let last = performance.now();

    // A shower comes from one radiant: every meteor runs the same way, down
    // and to the left, the way the swirl in the title turns.
    const HEADING = (205 * Math.PI) / 180;

    const seed = () => {
      const area = w * h;
      const count = Math.min(1400, Math.round(area / 1400));
      stars = Array.from({ length: count }, () => {
        const depth = Math.random();
        const big = Math.random() < 0.035;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: big ? 1.1 + Math.random() * 1.1 : 0.25 + depth * 0.8,
          base: big ? 0.85 : 0.25 + Math.random() * 0.55,
          tw: 0.6 + Math.random() * 2.2,
          ph: Math.random() * Math.PI * 2,
          // Mostly white, some a little blue, a few warm — as a real sky is.
          hue: Math.random() < 0.7 ? 0 : Math.random() < 0.75 ? 205 : 40,
          depth,
        };
      });
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (still) drawFrame(0, 0);
    };

    const spawn = (t: number) => {
      const speed = 900 + Math.random() * 900;              // px / s
      const heading = HEADING + (Math.random() - 0.5) * 0.12;
      // Start along the top and the right edge, so the trails cross the sky.
      const fromTop = Math.random() < 0.6;
      const x = fromTop ? w * (0.25 + Math.random() * 0.85) : w + 20;
      const y = fromTop ? -20 : h * Math.random() * 0.55;
      meteors.push({
        x, y,
        vx: Math.cos(heading) * speed,
        vy: -Math.sin(heading) * speed,
        len: 140 + Math.random() * 220,
        life: 0.7 + Math.random() * 0.9,
        age: 0,
        w: 1 + Math.random() * 1.4,
      });
      // Now and then several at once — a shower, not a trickle.
      const burst = Math.random() < 0.18 ? 2 + Math.floor(Math.random() * 3) : 0;
      for (let i = 0; i < burst; i++) {
        const m = meteors[meteors.length - 1];
        meteors.push({ ...m, x: m.x + (Math.random() - 0.3) * 260, y: m.y - Math.random() * 160,
          len: m.len * (0.6 + Math.random() * 0.5), life: m.life * (0.8 + Math.random() * 0.4), age: -Math.random() * 0.35 });
      }
      nextMeteor = t + 350 + Math.random() * 1500;
    };

    const drawFrame = (t: number, dt: number) => {
      ctx.clearRect(0, 0, w, h);

      // Two faint nebulae, so the sky has depth rather than being flat black.
      const neb = (cx: number, cy: number, rad: number, color: string) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      };
      neb(w * 0.18, h * 0.22, Math.max(w, h) * 0.45, 'rgba(37, 99, 235, 0.10)');
      neb(w * 0.82, h * 0.78, Math.max(w, h) * 0.40, 'rgba(20, 184, 166, 0.07)');

      const secs = t / 1000;
      for (const s of stars) {
        // A slow drift, nearer stars faster — enough to feel alive, not to notice.
        const x = still ? s.x : (s.x - secs * (1.5 + s.depth * 4)) % w;
        const px = x < 0 ? x + w : x;
        const twinkle = still ? 1 : 0.65 + 0.35 * Math.sin(secs * s.tw + s.ph);
        const a = s.base * twinkle;
        ctx.fillStyle = s.hue === 0 ? `rgba(255,255,255,${a})`
          : s.hue === 205 ? `rgba(186,222,255,${a})` : `rgba(255,236,200,${a})`;
        ctx.beginPath();
        ctx.arc(px, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.r > 1.1) {
          // The bright ones get a glow and a faint cross.
          const g = ctx.createRadialGradient(px, s.y, 0, px, s.y, s.r * 6);
          g.addColorStop(0, `rgba(190,225,255,${0.35 * a})`);
          g.addColorStop(1, 'rgba(190,225,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(px - s.r * 6, s.y - s.r * 6, s.r * 12, s.r * 12);
          ctx.strokeStyle = `rgba(210,235,255,${0.25 * a})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(px - s.r * 5, s.y); ctx.lineTo(px + s.r * 5, s.y);
          ctx.moveTo(px, s.y - s.r * 5); ctx.lineTo(px, s.y + s.r * 5);
          ctx.stroke();
        }
      }

      if (still) return;

      if (t >= nextMeteor) spawn(t);
      meteors = meteors.filter(m => m.age < m.life && m.x > -m.len && m.y < h + m.len);
      for (const m of meteors) {
        m.age += dt;
        if (m.age < 0) continue;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        const k = m.age / m.life;
        const fade = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
        const speed = Math.hypot(m.vx, m.vy);
        const tx = m.x - (m.vx / speed) * m.len;
        const ty = m.y - (m.vy / speed) * m.len;
        const trail = ctx.createLinearGradient(m.x, m.y, tx, ty);
        trail.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
        trail.addColorStop(0.15, `rgba(170,225,255,${0.6 * fade})`);
        trail.addColorStop(1, 'rgba(56,189,248,0)');
        ctx.strokeStyle = trail;
        ctx.lineWidth = m.w;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // The head.
        const head = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.w * 5);
        head.addColorStop(0, `rgba(255,255,255,${fade})`);
        head.addColorStop(1, 'rgba(160,220,255,0)');
        ctx.fillStyle = head;
        ctx.fillRect(m.x - m.w * 5, m.y - m.w * 5, m.w * 10, m.w * 10);
      }
    };

    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      drawFrame(t, dt);
      raf = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener('resize', resize);
    // Nothing is drawn for a tab nobody is looking at.
    const onVisible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) { last = performance.now(); raf = requestAnimationFrame(loop); }
    };
    document.addEventListener('visibilitychange', onVisible);
    if (!still) { nextMeteor = performance.now() + 600; raf = requestAnimationFrame(loop); }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" aria-hidden="true" />;
};

// ── The title, and the Simorgh over it ──────────────────────────────────────

/**
 * The Simorgh, beating its wings over the title for one full cycle of the
 * artwork, then flying up and out of the screen. Gone once it has left.
 */
const SimorghFlight: React.FC = () => {
  const [phase, setPhase] = useState<'arrive' | 'fly' | 'gone'>('arrive');
  const [useVideo] = useState(() => {
    if (typeof document === 'undefined') return false;
    const v = document.createElement('video');
    return v.canPlayType('video/webm; codecs="vp9"') !== '';
  });

  useEffect(() => {
    if (prefersReducedMotion()) { setPhase('gone'); return; }
    // One full beat of the wings where the artwork puts it, then away.
    const t = window.setTimeout(() => setPhase('fly'), 5600);
    return () => window.clearTimeout(t);
  }, []);

  if (phase === 'gone') return null;
  const common = {
    className: `simorgh-bird ${phase === 'fly' ? 'simorgh-bird-fly' : 'simorgh-bird-arrive'}`,
    onAnimationEnd: (e: React.AnimationEvent) => {
      if (e.animationName === 'simorghFlyAway') setPhase('gone');
    },
    'aria-hidden': true as const,
  };
  return useVideo ? (
    <video
      {...common}
      src={asset('simorgh-flight.webm')}
      poster={asset('simorgh-bird-poster.webp')}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
    />
  ) : (
    <img {...common} src={asset('simorgh-bird-poster.webp')} alt="" />
  );
};

/** The title above the dialog, with the Simorgh standing over it. */
export const SkyTitle: React.FC = () => (
  <div className="simorgh-title-block">
    <style>{`
      /* Everything is sized from one width, so the bird keeps its place over
         the title at any window size: the title is 0.350 of its width tall,
         the bird is 0.62 of it wide and 0.646 of its own width tall, and it
         stands with its tail 42% of the way down the title — where it is in
         the office's artwork. The block reserves the room above the title the
         bird needs, so it is never cut off at the top of a short window. */
      .simorgh-title-block {
        --tw: min(620px, 90vw, 62vh);
        --th: calc(var(--tw) * 0.3504);
        --bw: calc(var(--tw) * 0.62);
        --bh: calc(var(--bw) * 0.6458);
        position: relative;
        width: var(--tw);
        padding-top: calc(var(--bh) - var(--th) * 0.42);
        pointer-events: none;
        user-select: none;
      }
      .simorgh-title {
        position: relative;
        display: block;
        width: 100%;
        height: auto;
        animation: simorghTitleIn 1.6s cubic-bezier(.2,.7,.2,1) both;
        filter: drop-shadow(0 0 18px rgba(56,189,248,.25));
      }
      /* A band of light passing across the lettering now and then, cut to the
         shape of the title so it never lights the sky around it. */
      .simorgh-title-sheen {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        height: var(--th);
        -webkit-mask: url('${asset('simorgh-title.webp')}') center / 100% 100% no-repeat;
                mask: url('${asset('simorgh-title.webp')}') center / 100% 100% no-repeat;
        background: linear-gradient(105deg, transparent 0%, transparent 40%,
          rgba(255,255,255,.55) 50%, transparent 60%, transparent 100%);
        background-size: 260% 100%;
        mix-blend-mode: screen;
        animation: simorghSheen 7s ease-in-out 2.2s infinite;
      }
      .simorgh-bird {
        position: absolute;
        left: 50%;
        top: 0;
        width: var(--bw);
        height: var(--bh);
        margin-left: calc(var(--bw) / -2);
        object-fit: contain;
        z-index: 2;
        filter: drop-shadow(0 0 24px rgba(125,211,252,.35));
      }
      .simorgh-bird-arrive { animation: simorghArrive 1.4s ease-out both; }
      .simorgh-bird-fly {
        animation: simorghFlyAway 3.2s cubic-bezier(.5,.02,.75,.2) forwards;
      }
      @keyframes simorghTitleIn {
        from { opacity: 0; transform: translateY(14px) scale(.97); filter: blur(6px) drop-shadow(0 0 18px rgba(56,189,248,.25)); }
        to   { opacity: 1; transform: none; filter: blur(0) drop-shadow(0 0 18px rgba(56,189,248,.25)); }
      }
      @keyframes simorghSheen {
        0%   { background-position: 130% 0; }
        45%  { background-position: -30% 0; }
        100% { background-position: -30% 0; }
      }
      @keyframes simorghArrive {
        from { opacity: 0; transform: translateY(26px) scale(.9); }
        to   { opacity: 1; transform: none; }
      }
      /* Up and away to the top right: it gathers speed, climbs, turns a
         little into the climb and grows smaller as it goes, the way a bird
         leaving looks — and is off the screen before it fades. */
      @keyframes simorghFlyAway {
        0%   { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 1; }
        25%  { transform: translate(4vw, -6vh) scale(.92) rotate(-4deg); opacity: 1; }
        100% { transform: translate(62vw, -95vh) scale(.35) rotate(-14deg); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .simorgh-title, .simorgh-title-sheen { animation: none; }
      }
    `}</style>
    <SimorghFlight />
    <div style={{ position: 'relative' }}>
      <img className="simorgh-title" src={asset('simorgh-title.webp')} alt="Simorgh Design Suite" draggable={false} />
      <div className="simorgh-title-sheen" />
    </div>
  </div>
);
