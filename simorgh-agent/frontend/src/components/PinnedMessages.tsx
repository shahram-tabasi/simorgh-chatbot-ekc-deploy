// src/components/PinnedMessages.tsx
//
// Issue #3 (May 2026): per-chat pinned-message bookmarks. The
// operator wanted a small "pin" button per AI reply and a handle
// stack to jump back to those replies later — useful for long
// conversations where the user keeps referring to an earlier
// answer.
//
// Storage is localStorage scoped per chat
// (`simorgh_pinned_msgs_<chatId>`). Cross-device persistence would
// need a backend table; not in scope for now. Pin state survives
// chat-switch within the same browser.
//
// This module exports:
//   • usePinnedMessages(chatId) — hook with pinned[], togglePin,
//     isPinned, clearPin.
//   • <PinnedMessagesPanel> — floating "Pinned (N)" chip that
//     expands into a list of tab-style handles; clicking a handle
//     scrolls the chat to that message.
//
// The chat container is expected to render each message wrapper
// with `data-message-id={message.id}` so the smooth-scroll path
// can find it via querySelector.

import { useCallback, useEffect, useState } from 'react';
import { XIcon, ChevronDownIcon } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export interface PinnedMessage {
  messageId: string;
  snippet: string;
  ts: number;
}

const STORAGE_PREFIX = 'simorgh_pinned_msgs_';
const SNIPPET_LEN = 80;
const MAX_PINS_PER_CHAT = 20; // generous; UX gets weird beyond this

function storageKey(chatId: string | null | undefined): string | null {
  return chatId ? `${STORAGE_PREFIX}${chatId}` : null;
}

function snippetOf(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')   // strip code blocks
    .replace(/`[^`]+`/g, '')          // strip inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link → text
    .replace(/[#*_~>|]/g, '')         // strip markdown markers
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .substring(0, SNIPPET_LEN);
}

export function usePinnedMessages(chatId: string | null | undefined) {
  const [pinned, setPinned] = useState<PinnedMessage[]>([]);

  // Load on chat switch — old pins disappear from view until the
  // user switches back.
  useEffect(() => {
    const key = storageKey(chatId);
    if (!key) { setPinned([]); return; }
    try {
      const raw = localStorage.getItem(key);
      setPinned(raw ? (JSON.parse(raw) as PinnedMessage[]) : []);
    } catch {
      setPinned([]);
    }
  }, [chatId]);

  const persist = useCallback((next: PinnedMessage[]) => {
    const key = storageKey(chatId);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* localStorage quota — pin just doesn't persist this session */
    }
  }, [chatId]);

  const togglePin = useCallback((messageId: string, content: string) => {
    setPinned(prev => {
      const exists = prev.some(p => p.messageId === messageId);
      let next: PinnedMessage[];
      if (exists) {
        next = prev.filter(p => p.messageId !== messageId);
      } else {
        // Append at the end so order reflects pin-time (newest at
        // the bottom of the list — matches reading direction).
        // Cap at MAX_PINS_PER_CHAT, evicting the oldest pin.
        const entry: PinnedMessage = {
          messageId,
          snippet: snippetOf(content),
          ts: Date.now(),
        };
        next = [...prev, entry].slice(-MAX_PINS_PER_CHAT);
      }
      persist(next);
      return next;
    });
  }, [persist]);

  const clearPin = useCallback((messageId: string) => {
    setPinned(prev => {
      const next = prev.filter(p => p.messageId !== messageId);
      persist(next);
      return next;
    });
  }, [persist]);

  const isPinned = useCallback(
    (messageId: string) => pinned.some(p => p.messageId === messageId),
    [pinned],
  );

  return { pinned, togglePin, isPinned, clearPin };
}

interface PanelProps {
  pinned: PinnedMessage[];
  onJump: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}

export function PinnedMessagesPanel({ pinned, onJump, onUnpin }: PanelProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  if (pinned.length === 0) return null;

  // The chip glyph is a "stretched dash" (a single elongated
  // horizontal line) matching the operator's reference: visually
  // anchors a pinned point in the conversation without competing
  // with the message content. We render a small SVG rule rather
  // than the unicode "—" so its stroke weight stays consistent
  // across browsers/fonts and aligns optically with the surrounding
  // glyphs.
  const StretchedDash = (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="w-3 h-3 flex-shrink-0"
    >
      <line
        x1="1.5"
        y1="6"
        x2="10.5"
        y2="6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );

  return (
    // Anchored top-LEFT now (was top-right). The composer rebuild
    // pushed the AI's most-recent-reply controls to the right edge,
    // and the operator wanted the pin chip out of that traffic
    // lane — left-3 puts it over the empty rail just below the
    // chat header.
    <div className="absolute top-3 left-3 z-20 select-none">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full
                    border text-[11px] font-medium transition shadow-sm
                    ${
                      open
                        ? 'bg-violet-500/15 border-violet-400/40 text-violet-100'
                        : 'bg-black/40 border-white/15 text-gray-200 hover:bg-black/60 hover:border-white/25'
                    }`}
        aria-expanded={open}
      >
        {StretchedDash}
        <span>{t('pinned') || 'Pinned'}</span>
        <span className="text-gray-400">({pinned.length})</span>
        <ChevronDownIcon
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="mt-2 w-72 max-h-[420px] overflow-y-auto rounded-lg
                        border border-white/10 bg-slate-900/95 backdrop-blur
                        shadow-2xl p-1.5 space-y-1">
          {pinned.length === 0 && (
            <div className="px-2 py-3 text-[11px] text-gray-500 text-center">
              {t('noPins') || 'No pinned messages yet.'}
            </div>
          )}
          {pinned.map((p) => (
            <div
              key={p.messageId}
              role="button"
              tabIndex={0}
              onClick={() => {
                onJump(p.messageId);
                setOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onJump(p.messageId);
                  setOpen(false);
                }
              }}
              className="group flex items-start gap-2 px-2 py-2 rounded-md
                         border border-white/[0.06] hover:border-violet-400/30
                         hover:bg-white/[0.04] transition cursor-pointer"
            >
              {/* Stretched-dash left mark — matches the chip's glyph
                  and the operator's reference image. Same colour as
                  the chip when the row is hovered so the eye reads
                  it as the same family. */}
              <span className="mt-1.5 flex-shrink-0 text-violet-400/70 group-hover:text-violet-300 transition-colors">
                {StretchedDash}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11.5px] text-gray-200 leading-snug line-clamp-2">
                  {p.snippet || '…'}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin(p.messageId);
                }}
                className="flex-shrink-0 p-1 rounded text-gray-500
                           hover:text-red-300 hover:bg-red-500/10
                           opacity-0 group-hover:opacity-100 transition"
                aria-label={t('unpin') || 'Unpin'}
                title={t('unpin') || 'Unpin'}
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Smooth-scroll the chat container to the message with the given id
 * and briefly flash a highlight ring so the user's eye lands on it.
 * Pure DOM — relies on each message wrapper carrying
 * data-message-id={messageId}.
 */
export function scrollToPinnedMessage(messageId: string) {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Flash highlight: add a ring class, remove after 2s.
  const FLASH_CLASS = 'simorgh-pin-flash';
  el.classList.add(FLASH_CLASS);
  window.setTimeout(() => el.classList.remove(FLASH_CLASS), 2000);
}
