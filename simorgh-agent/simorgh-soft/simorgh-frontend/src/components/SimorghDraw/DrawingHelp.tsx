import React from 'react';
import { XIcon, ExternalLinkIcon } from 'lucide-react';
import { Lang, Strings, dirOf } from './lang';

// Help, without leaving the drawing.
//
// A panel over the canvas rather than a page in another tab: the question a
// draughtsman has mid-line is "which click ends this", and an answer that costs
// them the line they were drawing is not an answer. Everything here is short
// enough to read standing up. The long version — the illustrated guide with the
// whole workflow in it — is a link at the foot, for when there is time.

/**
 * Where the illustrated guide lives.
 *
 * The app is served under a base path (see vite.config), so the link is
 * resolved against it the way the rest of the suite resolves its own assets —
 * a bare `/help-drawing.html` would leave the app's mount point behind.
 */
const env: any = (import.meta as any).env || {};
export const GUIDE_URL =
  `${(env.BASE_URL || '/').replace(/\/+$/, '/')}help-drawing.html`;

interface Props {
  lang: Lang;
  t: Strings;
  onClose: () => void;
  /** Where the full written guide lives. Defaults to the one that ships. */
  guideUrl?: string;
}

const Section: React.FC<{ title: string; lines: string[] }> = ({ title, lines }) => (
  <section>
    <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">{title}</h4>
    <ul className="space-y-1.5">
      {lines.map((line, i) => (
        <li key={i} className="text-[13px] leading-relaxed text-gray-700 flex gap-2">
          <span className="text-slate-300 select-none shrink-0">•</span>
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  </section>
);

export const DrawingHelp: React.FC<Props> = ({ lang, t, onClose, guideUrl = GUIDE_URL }) => (
  <div
    className="absolute inset-0 z-20 bg-slate-900/40 flex items-start justify-center p-4 overflow-auto"
    onClick={onClose}
  >
    <div
      dir={dirOf(lang)}
      className="bg-white rounded-lg shadow-2xl w-[860px] max-w-full my-auto"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4 px-5 py-3 border-b bg-slate-50 rounded-t-lg">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-800">{t.helpTitle}</h3>
          <p className="text-[12px] text-slate-500 mt-0.5">{t.helpIntro}</p>
        </div>
        <button
          onClick={onClose}
          title={t.closeHelp}
          className="p-1 rounded hover:bg-slate-200 text-slate-600 shrink-0"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 px-5 py-4">
        <Section title={t.helpDrawing} lines={t.helpLines.draw} />
        <Section title={t.helpModify} lines={t.helpLines.modify} />
        <Section title={t.helpKeys} lines={t.helpLines.keys} />
        <Section title={t.helpTips} lines={t.helpLines.tips} />
      </div>

      {guideUrl && (
        <div className="px-5 py-3 border-t bg-slate-50 rounded-b-lg">
          <a
            href={guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-700 hover:text-blue-900"
          >
            <ExternalLinkIcon className="w-3.5 h-3.5" />
            {t.helpFullGuide}
          </a>
        </div>
      )}
    </div>
  </div>
);
