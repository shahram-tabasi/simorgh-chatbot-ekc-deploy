// src/components/PinnedMessages.tsx
//
// Issue #3 (May 2026): per-chat pinned-message bookmarks.
//
// Storage is localStorage scoped per chat
// (`simorgh_pinned_msgs_<chatId>`). Cross-device persistence would
// need a backend table; not in scope for now. Pin state survives
// chat-switch within the same browser.
//
// UI (operator's third pass, May 2026 — replaces the original
// "Pinned (N) ⌄" pill+dropdown):
//   The panel renders as a SILENT VERTICAL COLUMN OF DASHES at the
//   top-left of the chat — one stretched-dash per pin, no text, no
//   count. Click a dash to jump to that message. The last-clicked
//   dash stays bright violet (the "active" pin); the rest fade to
//   gray. To unpin, use the per-message pin button — this column
//   is read-only navigation.
//
// Exports:
//   • usePinnedMessages(chatId) — hook with pinned[], togglePin,
//     isPinned, clearPin.
//   • <PinnedMessagesPanel> — the dash column.
//   • scrollToPinnedMessage(id) — smooth-scroll + flash highlight
//     helper.
//
// The chat container is expected to render each message wrapper
// with `data-message-id={message.id}` so the smooth-scroll path
// can find it via querySelector.

import { useCallback, useEffect, useState } from 'react';
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

/**
 * GET the user's current pinned_messages map from the auth
 * service, then return a shallow-merged copy with this chat's
 * array replaced. Needed because the PATCH endpoint shallow-
 * merges at the `preferences_data.<key>` level: sending just
 * `{ pinned_messages: { [chatId]: ... } }` would REPLACE the
 * full pinned_messages dict — wiping other chats' pins. We
 * fetch the current full map, splice in this chat's update,
 * and send the whole merged map back. Network cost is a few KB.
 *
 * Falls back to a single-chat map if the GET fails, so the
 * caller's PATCH still works (other devices won't have the
 * latest pins until next successful GET, but local stays
 * authoritative).
 */
async function mergePinnedForChat(
  token: string,
  chatId: string,
  next: PinnedMessage[],
): Promise<Record<string, PinnedMessage[]>> {
  try {
    const r = await fetch('/api/auth/v2/me/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`GET preferences ${r.status}`);
    const data = await r.json();
    const current: Record<string, PinnedMessage[]> =
      (data?.preferences_data?.pinned_messages as Record<string, PinnedMessage[]>) || {};
    return { ...current, [chatId]: next };
  } catch {
    return { [chatId]: next };
  }
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

  // Cross-device sync (issue #4b, May 2026): AuthContext writes
  // server-stored pinned_messages into per-chat localStorage keys
  // on login and on token-refresh, then dispatches this event so
  // mounted hooks can re-read for their current chatId. Without
  // this, the hook would stay on the localStorage snapshot at
  // mount time even after a fresh login overwrote it.
  useEffect(() => {
    const onSync = () => {
      const key = storageKey(chatId);
      if (!key) return;
      try {
        const raw = localStorage.getItem(key);
        setPinned(raw ? (JSON.parse(raw) as PinnedMessage[]) : []);
      } catch { /* localStorage failure → keep current state */ }
    };
    window.addEventListener('simorgh-pins-synced', onSync);
    return () => window.removeEventListener('simorgh-pins-synced', onSync);
  }, [chatId]);

  // Push the chat's full pin list to the auth-service preferences
  // JSONB so other devices see the same pins on next login /
  // refresh. Fire-and-forget — local state is the snappy source of
  // truth for this session, network is for cross-device only.
  const syncPinsToServer = useCallback(async (next: PinnedMessage[]) => {
    if (!chatId) return;
    const token = localStorage.getItem('simorgh_token');
    if (!token) return;
    try {
      await fetch('/api/auth/v2/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          // Backend shallow-merges preferences_data. By sending
          // only `{ pinned_messages: { [chatId]: next } }` we
          // REPLACE the full `pinned_messages` key — which would
          // wipe other chats' pins. So we have to GET first then
          // merge client-side. Cheap: preferences are ~few KB.
          preferences_data: {
            pinned_messages: await mergePinnedForChat(token, chatId, next),
          },
        }),
      });
    } catch {
      /* best-effort — local copy is authoritative for this session */
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
      // Best-effort cross-device sync (issue #4b).
      void syncPinsToServer(next);
      return next;
    });
  }, [persist, syncPinsToServer]);

  const clearPin = useCallback((messageId: string) => {
    setPinned(prev => {
      const next = prev.filter(p => p.messageId !== messageId);
      persist(next);
      void syncPinsToServer(next);
      return next;
    });
  }, [persist, syncPinsToServer]);

  const isPinned = useCallback(
    (messageId: string) => pinned.some(p => p.messageId === messageId),
    [pinned],
  );

  return { pinned, togglePin, isPinned, clearPin };
}

interface PanelProps {
  pinned: PinnedMessage[];
  onJump: (messageId: string) => void;
  // (onUnpin removed — the dash column is read-only navigation
  //  now; unpin happens via the per-message pin button. See the
  //  May-2026 third-pass redesign note at the top of this file.)
}

export function PinnedMessagesPanel({ pinned, onJump }: PanelProps) {
  const { t } = useLanguage();
  // The "active" pin = the last dash the user clicked. It stays
  // bright until they click a different dash; the rest fade to
  // gray. We DO NOT persist this across reloads — being a pure UI
  // state ("where am I right now"), it's cheap to reset on chat
  // switch alongside the pinned array.
  const [activeId, setActiveId] = useState<string | null>(null);

  if (pinned.length === 0) {
    if (activeId !== null) setActiveId(null);
    return null;
  }

  return (
    // Vertical column of stretched-dash buttons, one per pin.
    // Anchored top-left of the chat area, tucked flush against the
    // edge so it doesn't overlap the first AI reply's Simorgh-bird
    // avatar. No outer chip / no count / no text — operator wanted
    // the dashes themselves to be the entire UI (third pass, May
    // 2026). Unpinning happens via the per-message pin button;
    // this column is read-only navigation.
    <div
      className="absolute top-2 -left-1 z-20 select-none flex flex-col gap-1.5
                 px-1.5 py-1 rounded-md bg-black/30 backdrop-blur-sm
                 border border-white/[0.04]"
      aria-label={t('pinned') || 'Pinned'}
    >
      {pinned.map((p) => {
        const isActive = activeId === p.messageId;
        return (
          // group wrapper so the hover preview to the right can
          // pick up the parent's :hover state without any JS.
          <div key={p.messageId} className="group relative">
            <button
              type="button"
              onClick={() => {
                setActiveId(p.messageId);
                onJump(p.messageId);
              }}
              aria-current={isActive ? 'true' : undefined}
              className={`flex items-center justify-center
                          w-5 h-3 rounded-sm transition-colors
                          ${
                            isActive
                              ? 'text-violet-300'
                              : 'text-gray-500 hover:text-gray-200'
                          }`}
            >
              {/* Stretched-dash glyph. SVG rather than unicode "—"
                  so the stroke weight stays consistent across
                  fonts/browsers. Thicker stroke for the active row
                  so the "current" pin reads clearly even at small
                  scale. */}
              <svg
                aria-hidden
                viewBox="0 0 16 4"
                className="w-4 h-1"
              >
                <line
                  x1="1"
                  y1="2"
                  x2="15"
                  y2="2"
                  stroke="currentColor"
                  strokeWidth={isActive ? 2 : 1.5}
                  strokeLinecap="round"
                />
              </svg>
            </button>

            {/* Hover preview — snippet shown to the right of the
                dash column. CSS-only via group-hover; no JS state
                or libraries. opacity-0 + pointer-events-none keeps
                it from blocking clicks when collapsed; a tiny
                transition smooths the appearance. The pointer
                triangle is faked with a small ::before via a
                rounded notch on the left edge. */}
            {p.snippet && (
              <div
                role="tooltip"
                className="pointer-events-none opacity-0 group-hover:opacity-100
                           transition-opacity duration-150
                           absolute left-full top-1/2 -translate-y-1/2 ml-2 z-30
                           min-w-[140px] max-w-[260px] px-2.5 py-1.5
                           rounded-md border border-white/10 bg-slate-900/95
                           backdrop-blur shadow-lg text-[11px] leading-snug
                           text-gray-200 whitespace-normal"
              >
                {p.snippet}
              </div>
            )}
          </div>
        );
      })}
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
