// src/utils/autolinkUrls.ts
//
// Pre-process a markdown source string so any bare URL gets
// wrapped as a proper markdown link [url](url). Runs BEFORE
// react-markdown parses, so the resulting links flow through the
// normal renderer (sanitiser, target="_blank" override in
// MarkdownRenderer.tsx, etc.) and become clickable.
//
// Why a custom pass on top of remark-gfm: GFM's autolinkLiteral
// rule fires only for URLs at word boundaries with surrounding
// whitespace — it misses:
//   • Bare `www.example.com` (no scheme; GFM accepts these but
//     only in some configurations).
//   • URLs embedded in Persian/Arabic text where the boundary
//     character is an RTL letter, not whitespace.
//   • URLs immediately followed by sentence-ending punctuation
//     (`.`, `,`, `;`) — GFM eats the punctuation INTO the URL
//     and the rendered link 404s.
//
// This pass is line-by-line; fenced code blocks are skipped so
// URLs inside ``` blocks stay literal. Existing markdown link
// syntax `[text](url)` is preserved unchanged.
//
// Operator request, May 2026: "in general chat any where of ai
// response have a url it be active url means when click url it
// open in new tab".

const URL_RE = /(\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[a-z0-9\-]+(?:\.[a-z0-9\-]+)+[^\s<>"')\]]*)/gi;

const TRAILING_PUNCT_RE = /[,.;:!?،؛؟]+$/;
// Persian comma U+060C, Persian semicolon U+061B, Persian
// question mark U+061F included so we don't swallow them into
// hrefs.

/**
 * Wrap bare URLs in a single line as markdown links, preserving
 * any existing [text](url) constructs.
 */
function linkifyPlainSegment(seg: string): string {
  return seg.replace(URL_RE, (match) => {
    // Strip a single trailing run of punctuation that's almost
    // certainly sentence end, not part of the URL. Keep it
    // outside the link so clicking the URL doesn't 404.
    const trimmed = match.replace(TRAILING_PUNCT_RE, '');
    const tail = match.slice(trimmed.length);
    const href = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
    return `[${trimmed}](${href})${tail}`;
  });
}

/**
 * Within a single line, protect any existing markdown link
 * (`[text](url)`) from being re-linkified, then linkify the
 * "between" segments.
 */
function linkifyLine(line: string): string {
  const PROTECT_RE = /\[[^\]]*\]\([^)]*\)/g;
  let result = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECT_RE.exec(line)) !== null) {
    result += linkifyPlainSegment(line.slice(lastIdx, m.index));
    result += m[0]; // already a markdown link — leave untouched
    lastIdx = m.index + m[0].length;
  }
  result += linkifyPlainSegment(line.slice(lastIdx));
  return result;
}

export function autoLinkUrls(text: string | null | undefined): string {
  if (!text) return text ?? '';
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // Toggle fenced-code-block state on lines that open/close
    // with ``` or ~~~. Don't touch URLs inside code blocks.
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = linkifyLine(lines[i]);
  }
  return lines.join('\n');
}
