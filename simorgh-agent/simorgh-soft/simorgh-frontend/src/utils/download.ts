// src/utils/download.ts
//
// Handing a file to the browser. One place, because every export does it and
// each one got the details slightly wrong on its own.

/** Save a Blob under `filename`. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked late: Safari reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save text under `filename`, as `mime`. */
export function downloadText(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: mime }));
}

/**
 * Anything unsafe in a file name, and the runs of spaces around it, collapse to
 * a single underscore — the same file has to survive Windows and Linux.
 */
export const fileSafe = (s: string): string =>
  (s || 'project').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
