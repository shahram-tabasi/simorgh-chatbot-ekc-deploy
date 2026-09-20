// src/components/shared/SimorghMark.tsx
//
// The suite's own bird, wherever an assistant needs a face.
//
// A generic sparkle says "there is an AI in here", which is a thing every
// product on the screen says. The assistant on these pages is part of *this*
// product, and it should wear the same mark as the splash screen and the
// header — which is also the difference between a feature somebody built and a
// widget somebody bolted on. The chatbot already made this swap; this is that
// component where the rest of the suite can reach it.

import React from 'react';
import logoMark from '../../assets/logo-mark.png';

export const SimorghMark: React.FC<{ className?: string; white?: boolean }> = ({
  className = 'w-4 h-4', white = false,
}) => (
  // `white` for the mark on a coloured ground: the bird is drawn in navy, and
  // navy on a violet header is a shape somebody has to go looking for, which
  // is the opposite of what a mark is for. On a dark page `data-theme-invert`
  // does the same job from `theme.css`, so one asset covers every ground.
  <img
    src={logoMark}
    alt=""
    aria-hidden
    data-theme-invert={white ? undefined : true}
    className={`${className} object-contain select-none${white ? ' brightness-0 invert' : ''}`}
  />
);
