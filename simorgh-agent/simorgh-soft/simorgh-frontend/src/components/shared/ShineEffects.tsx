import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// The light effects used across the brand surfaces (splash screen, startup
// dialog, app header), packaged so any artwork or wordmark can carry them
// without copying keyframes around:
//
//   <ShineStyles />                                   ← once per screen
//   <ShineImage src={loadArtwork} className="w-full" />
//   <SheenText className="text-4xl">Design Suite</SheenText>
//   <LightBeam className="w-72" />
//
// ShineImage puts a light sweeping diagonally across the picture plus a soft
// glow around it; the sweep is masked to the image itself, so a PNG with a
// transparent background stays background-free.
// ─────────────────────────────────────────────────────────────────────────────

// Injects the keyframes/classes. Rendering it more than once on a page is
// harmless — the rules are identical.
export const ShineStyles: React.FC = () => (
  <style>{`
    @keyframes shineSweep {
      0%   { transform: translateX(-130%) skewX(-18deg); opacity: 0; }
      12%  { opacity: 1; }
      55%  { opacity: 1; }
      100% { transform: translateX(230%) skewX(-18deg); opacity: 0; }
    }
    @keyframes shineGlowPulse {
      0%, 100% { opacity: .55; }
      50%      { opacity: 1; }
    }
    @keyframes shineTextSheen {
      0%   { background-position: -180% 0; }
      100% { background-position:  180% 0; }
    }
    @keyframes shineBeamPulse {
      0%, 100% { opacity: .35; transform: scaleX(.75); }
      50%      { opacity: 1;   transform: scaleX(1); }
    }
    .shine-sweep {
      position: absolute;
      top: -25%;
      bottom: -25%;
      width: 45%;
      pointer-events: none;
      background: linear-gradient(90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,0.10) 35%,
        rgba(255,255,255,0.75) 50%,
        rgba(255,255,255,0.10) 65%,
        rgba(255,255,255,0) 100%);
      mix-blend-mode: screen;
      filter: blur(6px);
    }
    .shine-text {
      background-size: 220% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .shine-beam { transform-origin: left center; }

    /* Anyone who asked their system not to animate gets the artwork, still. */
    @media (prefers-reduced-motion: reduce) {
      .shine-sweep { display: none; }
      .shine-text  { animation: none !important; background-position: 50% 0 !important; }
      .shine-beam  { animation: none !important; opacity: .8 !important; transform: none !important; }
    }
  `}</style>
);

interface ShineImageProps {
  src: string;
  alt?: string;
  /** Classes for the <img> itself (sizing, e.g. "h-40 w-auto"). */
  className?: string;
  /** Classes for the wrapper (positioning, e.g. "mx-auto"). */
  wrapperClassName?: string;
  /** Seconds for one pass of the light. */
  sweepSeconds?: number;
  /** Seconds to wait between passes. */
  sweepDelay?: number;
  /** Glow colour behind the artwork; pass '' for no glow. */
  glow?: string;
  /** Knock the artwork out to white — for a dark logo over a dark ground. */
  whiteOut?: boolean;
  style?: React.CSSProperties;
}

// An image with a light sweeping across it and a soft glow around it.
export const ShineImage: React.FC<ShineImageProps> = ({
  src,
  alt = '',
  className = '',
  wrapperClassName = '',
  sweepSeconds = 2.6,
  sweepDelay = 1.6,
  glow = 'rgba(59,130,246,0.55)',
  whiteOut = false,
  style,
}) => {
  const filters = [
    whiteOut ? 'brightness(0) invert(1)' : '',
    glow ? `drop-shadow(0 0 22px ${glow})` : '',
  ].filter(Boolean).join(' ');

  // The moving band lives inside a box masked by the artwork itself, so the
  // light lands on the picture and never on the empty space around it — a
  // transparent PNG doesn't pick up a glowing rectangle.
  const maskToArtwork: React.CSSProperties = {
    WebkitMaskImage: `url("${src}")`,
    maskImage: `url("${src}")`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
  };

  return (
    <span className={`relative inline-block ${wrapperClassName}`}>
      <img
        src={src}
        alt={alt}
        className={className}
        style={{
          ...(filters ? { filter: filters } : {}),
          ...(glow ? { animation: `shineGlowPulse ${sweepSeconds + sweepDelay}s ease-in-out infinite` } : {}),
          ...style,
        }}
      />
      <span
        className="absolute inset-0 overflow-hidden pointer-events-none"
        style={maskToArtwork}
        aria-hidden
      >
        <span
          className="shine-sweep"
          style={{
            left: 0,
            animation: `shineSweep ${sweepSeconds}s ease-in-out ${sweepDelay}s infinite`,
          }}
        />
      </span>
    </span>
  );
};

interface SheenTextProps {
  children: React.ReactNode;
  className?: string;
  /** Base colour of the text. */
  base?: string;
  /** Colour of the light passing over it. */
  highlight?: string;
  seconds?: number;
}

// Text with a light travelling across the letters.
export const SheenText: React.FC<SheenTextProps> = ({
  children,
  className = '',
  base = '#60a5fa',
  highlight = '#ffffff',
  seconds = 3.4,
}) => (
  <span
    className={`shine-text ${className}`}
    style={{
      backgroundImage: `linear-gradient(100deg, ${base} 0%, ${base} 38%, ${highlight} 50%, ${base} 62%, ${base} 100%)`,
      animation: `shineTextSheen ${seconds}s linear infinite`,
    }}
  >
    {children}
  </span>
);

interface LightBeamProps {
  className?: string;
  /** Colour at the centre of the beam. */
  color?: string;
  edge?: string;
  seconds?: number;
}

// The glowing bar that sits under a wordmark.
export const LightBeam: React.FC<LightBeamProps> = ({
  className = '',
  color = '#ffffff',
  edge = '#93c5fd',
  seconds = 3.4,
}) => (
  <span
    className={`shine-beam block h-[2px] rounded-full ${className}`}
    style={{
      background: `linear-gradient(90deg, rgba(96,165,250,0) 0%, ${edge} 25%, ${color} 50%, ${edge} 75%, rgba(96,165,250,0) 100%)`,
      boxShadow: `0 0 14px 2px ${edge}a6`,
      animation: `shineBeamPulse ${seconds}s ease-in-out infinite`,
    }}
  />
);

// ─────────────────────────────────────────────────────────────────────────────
// Ownership line shown on the splash screen / startup dialog.
//
// The words live in src/branding.ts now — everything that signs anything takes
// them from there, so the signature on a drawing, a report and the splash are
// the same signature. Re-exported under the old names so nothing that already
// imports them has to change.
// ─────────────────────────────────────────────────────────────────────────────
export { COMPANY_NAME as COMPANY_NAME_EN, COPYRIGHT_LINE as COMPANY_RIGHTS_EN } from '../../branding';
