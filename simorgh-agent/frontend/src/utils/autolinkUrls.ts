// src/utils/autolinkUrls.ts
//
// Pre-process a markdown source string so any bare URL gets
// wrapped as a proper markdown autolink `<URL>`. Runs BEFORE
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
//   • Bare EKC company hostnames (bpms.electrokavir.com etc.)
//     that have no scheme and aren't `www.`-prefixed.
//   • LAN IPv4 references (192.168.x.x, 10.x.x.x, …).
//
// This pass is line-by-line; fenced code blocks are skipped so
// URLs inside ``` blocks stay literal. Existing markdown link
// syntax `[text](url)` is preserved unchanged.
//
// Scheme normalisation (May 2026 operator feedback): the EKC
// deployment mixes HTTP and HTTPS hosts — confirmed from the
// landing page in host-nginx-config/landing/index.html:
//
//   https://simorghai.electrokavir.com/...        (main app)
//   http://bpms.electrokavir.com/                  (BPMS)
//   http://kasra.electrokavir.com/lego.web/...     (Kasra HR)
//   http://hr.electrokavir.com/employee/...        (HR)
//   http://192.168.0.150                            (LAN host)
//
// So a single default scheme is wrong. We use a host-scheme map
// (derived from the landing page) and override whatever the LLM
// emitted to match — emitting `https://kasra.electrokavir.com`
// would otherwise initiate a TLS handshake against a plain-HTTP
// server and the click would open a blank tab.

// =============================================================
// Host → preferred scheme. Source: host-nginx-config/landing/.
// =============================================================
const HOST_SCHEME_MAP: Record<string, 'http' | 'https'> = {
  // Main app — TLS terminated by the front nginx.
  'simorghai.electrokavir.com': 'https',
  // Internal services — plain HTTP per landing page.
  'bpms.electrokavir.com': 'http',
  'kasra.electrokavir.com': 'http',
  'kesra.electrokavir.com': 'http', // common Persian transliteration
  'hr.electrokavir.com': 'http',
};

const LAN_IP_RE_TEST =
  /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/;

function canonicalSchemeForHost(host: string): 'http' | 'https' | null {
  const lc = host.toLowerCase();
  if (HOST_SCHEME_MAP[lc]) return HOST_SCHEME_MAP[lc];
  if (LAN_IP_RE_TEST.test(host)) return 'http';
  return null; // unknown host — caller decides
}

// =============================================================
// URL token detector.
//   1. `https?://...`        (any scheme'd URL)
//   2. `www.foo.bar/...`     (www. host, no scheme)
//   3. `<host>.electrokavir.com/...`  (EKC subdomain, no scheme)
//   4. LAN IPv4 with optional port + path
// =============================================================
const URL_RE = new RegExp(
  [
    // 1
    '\\bhttps?:\\/\\/[^\\s<>"\\\')\\]]+',
    // 2
    '\\bwww\\.[a-z0-9\\-]+(?:\\.[a-z0-9\\-]+)+[^\\s<>"\\\')\\]]*',
    // 3 — bare EKC company host. Subdomain optional; we add a path
    //     part as anything-not-whitespace so query strings come along.
    '\\b(?:[a-z0-9\\-]+\\.)*electrokavir\\.com(?:\\/[^\\s<>"\\\')\\]]*)?',
    // 4 — LAN IPv4 (any in 10/172.16-31/192.168) with optional :port + /path
    '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})(?::\\d{1,5})?(?:\\/[^\\s<>"\\\')\\]]*)?',
  ].join('|'),
  'gi',
);

const TRAILING_PUNCT_RE = /[,.;:!?،؛؟]+$/;
// Persian comma U+060C, Persian semicolon U+061B, Persian
// question mark U+061F included so we don't swallow them into
// hrefs.

interface UrlParts {
  scheme: string | null;
  host: string;
  rest: string; // port + path + query + fragment
}

function parseUrlParts(raw: string): UrlParts {
  let scheme: string | null = null;
  let work = raw;
  const m = work.match(/^(https?):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase();
    work = work.slice(m[0].length);
  }
  // work is now host[:port][/path?query#frag]
  const slashIdx = work.indexOf('/');
  if (slashIdx === -1) {
    const portIdx = work.indexOf(':');
    if (portIdx === -1) {
      return { scheme, host: work, rest: '' };
    }
    return { scheme, host: work.slice(0, portIdx), rest: work.slice(portIdx) };
  }
  const hostPort = work.slice(0, slashIdx);
  const portIdx = hostPort.indexOf(':');
  if (portIdx === -1) {
    return { scheme, host: hostPort, rest: work.slice(slashIdx) };
  }
  return {
    scheme,
    host: hostPort.slice(0, portIdx),
    rest: hostPort.slice(portIdx) + work.slice(slashIdx),
  };
}

function linkifyPlainSegment(seg: string): string {
  return seg.replace(URL_RE, (match) => {
    // Strip a single trailing run of punctuation that's almost
    // certainly sentence end, not part of the URL. Keep it
    // outside the link so clicking the URL doesn't 404.
    const trimmed = match.replace(TRAILING_PUNCT_RE, '');
    const tail = match.slice(trimmed.length);
    const { scheme, host, rest } = parseUrlParts(trimmed);

    // Scheme priority:
    //   1. If the host has a canonical scheme in our map → use it
    //      (overrides whatever the LLM emitted, since wrong scheme
    //      = TLS handshake against plain-HTTP server = blank tab).
    //   2. Else, preserve the LLM's scheme if it was set.
    //   3. Else, fall back to http — matches the landing page's
    //      default for non-simorghai EKC hosts.
    const canonical = canonicalSchemeForHost(host);
    const finalScheme = canonical || scheme || 'http';

    // CommonMark autolink form: `<URL>` is parsed as a single
    // atomic link, GFM won't reparse the inner text → fixes the
    // double-anchor blank-page bug (see commit ca7ec9e).
    return `<${finalScheme}://${host}${rest}>${tail}`;
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
