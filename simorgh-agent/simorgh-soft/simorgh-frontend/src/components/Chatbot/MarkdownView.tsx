// Minimal Markdown renderer for the chatbot.
//
// Supports the subset that actually shows up in assistant replies:
//   • inline:   **bold**, *italic*, `code`, [text](url)
//   • blocks:   #/##/###/#### headings, ``` fenced code, > blockquote,
//               - / * bullet lists, 1. ordered lists, --- horizontal rule
//   • tables:   GitHub-style pipe tables with a header separator
//
// We hand-roll this so the chatbot stays dependency-light (react-markdown +
// remark-gfm would pull ~80 KB gzipped just for chat output). The output is
// React nodes — no `dangerouslySetInnerHTML` — so user text can't inject
// arbitrary HTML.

import React from 'react';

/** Render inline markdown inside a paragraph or list item. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Tokenise in priority order: code → bold → italic → link → plain.
  // We process left-to-right by scanning for the next match of any pattern.
  const tokens: { type: string; match: RegExpMatchArray }[] = [];
  const patterns: { type: string; re: RegExp }[] = [
    { type: 'code',   re: /`([^`\n]+)`/g },
    { type: 'bold',   re: /\*\*([^*\n]+)\*\*/g },
    { type: 'italic', re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g },
    { type: 'under',  re: /__([^_\n]+)__/g },
    { type: 'link',   re: /\[([^\]\n]+)\]\(([^)\s]+)\)/g },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(text)) !== null) {
      tokens.push({ type: p.type, match: m });
    }
  }
  tokens.sort((a, b) => (a.match.index || 0) - (b.match.index || 0));

  // Filter out overlapping tokens (keep earlier one).
  const filtered: typeof tokens = [];
  let lastEnd = -1;
  for (const t of tokens) {
    const start = t.match.index || 0;
    if (start >= lastEnd) {
      filtered.push(t);
      lastEnd = start + t.match[0].length;
    }
  }

  let cursor = 0;
  filtered.forEach((t, i) => {
    const start = t.match.index || 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    const k = `${keyPrefix}-${i}`;
    if (t.type === 'code')   out.push(<code key={k} className="px-1 py-0.5 rounded bg-gray-100 text-pink-700 font-mono text-[11px]">{t.match[1]}</code>);
    else if (t.type === 'bold' || t.type === 'under') out.push(<strong key={k} className="font-semibold">{t.match[1]}</strong>);
    else if (t.type === 'italic') out.push(<em key={k}>{t.match[1]}</em>);
    else if (t.type === 'link')   out.push(<a key={k} href={t.match[2]} target="_blank" rel="noreferrer noopener" className="text-blue-600 underline hover:no-underline">{t.match[1]}</a>);
    cursor = start + t.match[0].length;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

interface Props {
  text: string;
  /** Tailwind class for inverted (user-message) colours, if needed. */
  invert?: boolean;
}

export const MarkdownView: React.FC<Props> = ({ text, invert }) => {
  if (!text) return null;

  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang\n…\n```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={key++} className="my-1.5 p-2 rounded bg-gray-900 text-gray-100 text-[11px] font-mono overflow-x-auto whitespace-pre">
          {buf.join('\n')}
        </pre>
      );
      continue;
    }

    // Headings (#, ##, ###, ####)
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? 'text-base font-bold mt-2'
        : level === 2 ? 'text-sm font-bold mt-1.5'
        : level === 3 ? 'text-[13px] font-semibold mt-1'
        : 'text-xs font-semibold mt-1';
      blocks.push(<div key={key++} className={cls}>{renderInline(h[2], `h${key}`)}</div>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-2 border-gray-300" />);
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="my-1 pl-3 border-l-2 border-gray-300 text-gray-600 italic">
          {buf.map((b, bi) => <div key={bi}>{renderInline(b, `bq${key}-${bi}`)}</div>)}
        </blockquote>
      );
      continue;
    }

    // GH-style table: header | header  /  --- | ---  /  cell | cell ...
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (s: string) =>
        s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="my-1.5 overflow-x-auto">
          <table className="text-[11px] border-collapse">
            <thead>
              <tr className="bg-gray-100">
                {header.map((h, hi) => (
                  <th key={hi} className="px-2 py-1 border border-gray-300 text-left font-semibold">
                    {renderInline(h, `th${key}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri % 2 ? 'bg-gray-50' : ''}>
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2 py-1 border border-gray-200 align-top">
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1 pl-5 list-disc space-y-0.5">
          {items.map((it, ii) => <li key={ii}>{renderInline(it, `li${key}-${ii}`)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-1 pl-5 list-decimal space-y-0.5">
          {items.map((it, ii) => <li key={ii}>{renderInline(it, `oli${key}-${ii}`)}</li>)}
        </ol>
      );
      continue;
    }

    // Blank line → spacer (skip; paragraphs handled below)
    if (line.trim() === '') { i++; continue; }

    // Paragraph — accumulate consecutive non-blank, non-block lines.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1 leading-relaxed">
        {buf.flatMap((b, bi) => {
          const node = renderInline(b, `p${key}-${bi}`);
          return bi === 0 ? node : [<br key={`br${bi}`} />, ...node];
        })}
      </p>
    );
  }

  return <div className={invert ? 'text-white' : 'text-gray-800'}>{blocks}</div>;
};

export default MarkdownView;
