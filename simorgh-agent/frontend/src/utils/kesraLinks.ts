// src/utils/kesraLinks.ts
//
// Auto-link mentions of Kesra/کسرا/کسری in assistant replies.
//
// EKC uses an internal HR system called "Kesra" — operators wanted
// every textual mention of the software to be a click-through link
// to https://kasra.electrokavir.com (override-able at build time via
// VITE_KESRA_URL). This runs BEFORE markdown parsing so the result
// goes through react-markdown's normal sanitizer pipeline.
//
// Constraints:
//   - Don't double-wrap when the LLM already linked the word.
//   - Don't touch text inside code fences / inline code.
//   - Match Persian, English, and a common Persian misspelling.

const KESRA_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_KESRA_URL) ||
  'https://kasra.electrokavir.com';

// Word forms we recognise. Case-insensitive for the Latin form;
// Persian/Arabic letters don't have a case so the regex is plain.
//   - English: kesra, kasra
//   - Persian: کسرا, کسری
// Word-boundary handling for Persian is "look for a non-letter
// before/after" because \b doesn't behave with non-ASCII letters.
const TOKEN = /(\b(?:kesra|kasra)\b|(?<![\p{L}\p{M}])(?:کسرا|کسری)(?![\p{L}\p{M}]))/giu;

/** Stream the markdown source, skipping over fenced code blocks and
 *  inline code spans, and replacing bare Kesra mentions with a
 *  markdown link. Mentions already inside `[...]` or `(http...)` are
 *  left alone via a cheap lookahead/behind on the surrounding chars. */
export function autoLinkKesra(md: string): string {
  if (!md || typeof md !== 'string') return md;
  if (!TOKEN.test(md)) return md;
  // Reset lastIndex — TOKEN is /g and the `.test` call above
  // advanced it; without this the actual replace starts mid-string.
  TOKEN.lastIndex = 0;

  // Split on code fences first so we never touch code content.
  const segments: { code: boolean; text: string }[] = [];
  const fence = /(```[\s\S]*?```|`[^`\n]*`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md)) !== null) {
    if (m.index > last) segments.push({ code: false, text: md.slice(last, m.index) });
    segments.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < md.length) segments.push({ code: false, text: md.slice(last) });

  return segments
    .map((seg) => (seg.code ? seg.text : linkifyOutsideMarkdownLinks(seg.text)))
    .join('');
}

/** Replace Kesra mentions outside of existing `[label](url)` links
 *  and outside of explicit URLs. We do this by walking the string and
 *  carving out untouchable spans first. */
function linkifyOutsideMarkdownLinks(s: string): string {
  // Carve out [..](..) markdown links and bare URLs so we don't try to
  // wrap the word twice when the LLM already produced a link.
  const skip = /\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g;
  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = skip.exec(s)) !== null) {
    result += linkifyPlain(s.slice(cursor, m.index));
    result += m[0];
    cursor = m.index + m[0].length;
  }
  result += linkifyPlain(s.slice(cursor));
  return result;
}

function linkifyPlain(s: string): string {
  TOKEN.lastIndex = 0;
  return s.replace(TOKEN, (match) => `[${match}](${KESRA_URL})`);
}
