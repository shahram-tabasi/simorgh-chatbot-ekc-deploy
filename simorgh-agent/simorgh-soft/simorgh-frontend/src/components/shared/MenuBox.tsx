import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * A menu at the pointer that stays on the screen.
 *
 * Every one of these used to be placed at the click and left there: right-click
 * a row near the bottom of a long table, or the last template in a long tree,
 * and the menu ran off the bottom edge — so the first entries were the last
 * thing visible and the ones under them could not be reached at all. The
 * commands were there and there was no way to press them, which reads exactly
 * like a command that does nothing.
 *
 * Measured after it is laid out and before it is painted, so it moves up or
 * left to fit and never jumps.
 *
 * It is in `shared/` because every menu in the app has the same edge to fall
 * off, and a menu that has to remember to clamp itself is one that will not.
 */
export const MenuBox: React.FC<{
  x: number; y: number; className: string; children: React.ReactNode;
}> = ({ x, y, className, children }) => {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = box.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    setAt({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y, children]);

  return (
    <div
      ref={box}
      className={`fixed ${className}`}
      style={{ left: at.left, top: at.top }}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </div>
  );
};

export default MenuBox;
