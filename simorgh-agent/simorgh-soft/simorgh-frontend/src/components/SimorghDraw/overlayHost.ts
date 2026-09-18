import { useEffect, useState } from 'react';

// Where a panel drawn over everything actually has to live.
//
// The editor's full screen is the browser's own — `requestFullscreen` on the
// editor's frame — and the browser paints *only that element's subtree* while
// it is on. Anything sent to `document.body` is still in the document, still
// laid out, still clickable by a test runner; it is simply not drawn. That is
// the whole of the "in full screen it will not show a symbol" bug: the symbol
// library mounted, took the clicks, and appeared nowhere, because it was a
// sibling of the element the browser was showing rather than a child of it.
//
// z-index cannot fix it and did not: the panel was lifted from 250 to 320 to
// beat the editor's 300 and the symptom stayed, which is what says the problem
// is not stacking order but which tree the node is in.
//
// So a panel that must appear over the editor asks here for its host, and gets
// whichever element is full screen — or the body, when none is. `fixed` still
// means the viewport either way: a full-screen element fills the viewport, so
// `fixed inset-0` inside it covers the screen exactly as it did before.

/** The element an overlay must be drawn into to be seen right now. */
export function overlayHost(): HTMLElement {
  const full = typeof document === 'undefined' ? null : document.fullscreenElement;
  return full instanceof HTMLElement ? full : document.body;
}

/**
 * The overlay host, kept right as full screen comes and goes.
 *
 * Moving the portal moves the DOM nodes and keeps the React component that
 * owns them, so a library open when full screen is entered stays open, with
 * its search text and its picked symbol, and simply becomes visible again.
 */
export function useOverlayHost(): HTMLElement | null {
  // Null on the first render: `document.fullscreenElement` is read in an
  // effect so that a component rendered while the browser is still settling
  // into full screen does not park its panel on the body for good.
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const follow = () => setHost(overlayHost());
    follow();
    document.addEventListener('fullscreenchange', follow);
    return () => document.removeEventListener('fullscreenchange', follow);
  }, []);

  return host;
}
