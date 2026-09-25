// src/components/shared/AppDialog.tsx
//
// The app's own message, question and input boxes, in place of the browser's
// alert(), confirm() and prompt().
//
// Those three open a window that belongs to the browser, not to the app: it is
// grey on every theme, it says the server's address in its title, it cannot
// be styled, laid out or translated, and in the desktop client it looks like
// a system error. Everything here is called the same way — one function call
// that returns once the person has answered — so replacing one is replacing a
// line, and nothing about what the question does changes.
//
//   await appAlert('Saved.')
//   if (!(await appConfirm('Delete it?', { danger: true }))) return;
//   const name = await appPrompt('Name', 'Page 1');       // null on Cancel
//   const how = await appChoose('Already drawn…', [{ id: 'redraw', label: … }, …]); // null on Cancel
//
// <AppDialogHost /> is mounted once, beside <App />. It draws into whatever is
// in full screen at the time, because the browser paints nothing outside the
// full-screen element: a box put on document.body while Simorgh Draw fills
// the screen would be there, taking the keyboard, and invisible.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangleIcon, InfoIcon, HelpCircleIcon, XIcon } from 'lucide-react';

type Tone = 'info' | 'warning' | 'danger' | 'success';

export interface DialogChoice {
  id: string;
  label: string;
  /** A line under the label, saying what the choice does. */
  note?: string;
  /** Drawn as the main button. */
  primary?: boolean;
  danger?: boolean;
}

interface DialogRequest {
  id: number;
  kind: 'alert' | 'confirm' | 'prompt' | 'choose';
  title?: string;
  message: string;
  tone: Tone;
  confirmLabel: string;
  cancelLabel: string;
  defaultValue?: string;
  placeholder?: string;
  choices?: DialogChoice[];
  resolve: (value: any) => void;
}

// ── The queue ───────────────────────────────────────────────────────────────
// One box at a time, in the order they were asked for — the same as the
// browser's own, which never stacked either.
let queue: DialogRequest[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

let nextId = 1;

function open<T>(request: Omit<DialogRequest, 'resolve' | 'id'>): Promise<T> {
  return new Promise<T>(resolve => {
    queue = [...queue, { ...request, id: nextId++, resolve }];
    notify();
  });
}

function close(value: unknown) {
  const [current, ...rest] = queue;
  queue = rest;
  notify();
  current?.resolve(value);
}

interface CommonOptions {
  title?: string;
  tone?: Tone;
}

/** A message, and OK. */
export function appAlert(message: string, options: CommonOptions & { okLabel?: string } = {}): Promise<void> {
  return open<void>({
    kind: 'alert', message, title: options.title, tone: options.tone ?? 'info',
    confirmLabel: options.okLabel ?? 'OK', cancelLabel: '',
  });
}

/** A question with two answers. Resolves true for the first. */
export function appConfirm(
  message: string,
  options: CommonOptions & { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return open<boolean>({
    kind: 'confirm', message, title: options.title,
    tone: options.danger ? 'danger' : options.tone ?? 'warning',
    confirmLabel: options.confirmLabel ?? 'OK', cancelLabel: options.cancelLabel ?? 'Cancel',
  });
}

/** A line of text. Resolves null on Cancel, as prompt() does. */
export function appPrompt(
  message: string,
  defaultValue = '',
  options: CommonOptions & { confirmLabel?: string; cancelLabel?: string; placeholder?: string } = {},
): Promise<string | null> {
  return open<string | null>({
    kind: 'prompt', message, title: options.title, tone: options.tone ?? 'info',
    confirmLabel: options.confirmLabel ?? 'OK', cancelLabel: options.cancelLabel ?? 'Cancel',
    defaultValue, placeholder: options.placeholder,
  });
}

/** One of several answers — what two confirm()s in a row used to ask. Null on Cancel. */
export function appChoose(
  message: string,
  choices: DialogChoice[],
  options: CommonOptions & { cancelLabel?: string } = {},
): Promise<string | null> {
  return open<string | null>({
    kind: 'choose', message, title: options.title, tone: options.tone ?? 'warning',
    confirmLabel: '', cancelLabel: options.cancelLabel ?? 'Cancel', choices,
  });
}

// ── The box ─────────────────────────────────────────────────────────────────

const TONE: Record<Tone, { icon: React.ReactNode; ring: string; button: string }> = {
  info:    { icon: <InfoIcon className="w-5 h-5 text-blue-600" />,        ring: 'bg-blue-50',   button: 'bg-blue-600 hover:bg-blue-700' },
  success: { icon: <InfoIcon className="w-5 h-5 text-emerald-600" />,     ring: 'bg-emerald-50', button: 'bg-emerald-600 hover:bg-emerald-700' },
  warning: { icon: <HelpCircleIcon className="w-5 h-5 text-amber-600" />, ring: 'bg-amber-50',  button: 'bg-blue-600 hover:bg-blue-700' },
  danger:  { icon: <AlertTriangleIcon className="w-5 h-5 text-red-600" />, ring: 'bg-red-50',   button: 'bg-red-600 hover:bg-red-700' },
};

const DEFAULT_TITLE: Record<DialogRequest['kind'], string> = {
  alert: 'Simorgh Design Suite', confirm: 'Please confirm', prompt: 'Enter a value', choose: 'Choose',
};

const DialogBox: React.FC<{ request: DialogRequest }> = ({ request }) => {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const tone = TONE[request.tone];

  const cancelValue = request.kind === 'confirm' ? false
    : request.kind === 'alert' ? undefined : null;
  const confirm = () => close(
    request.kind === 'confirm' ? true : request.kind === 'prompt' ? value : undefined);
  const cancel = () => close(cancelValue);

  useEffect(() => {
    if (request.kind === 'prompt') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      okRef.current?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    // Capture, so a table or editor underneath does not also act on Escape.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  return (
    <div
      className="fixed inset-0 z-[100000] bg-black/50 flex items-center justify-center p-4"
      onMouseDown={e => { if (e.target === e.currentTarget && request.kind !== 'alert') cancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col border border-gray-200"
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${tone.ring}`}>{tone.icon}</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-900">{request.title ?? DEFAULT_TITLE[request.kind]}</h3>
          </div>
          {request.kind !== 'alert' && (
            <button className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" onClick={cancel} title="Cancel (Esc)">
              <XIcon className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="px-5 pb-4 overflow-y-auto min-h-0">
          {/* dir="auto": a Persian message reads right to left, an English one left to right. */}
          <p dir="auto" className="text-sm text-gray-700 whitespace-pre-line break-words">{request.message}</p>

          {request.kind === 'prompt' && (
            <input
              ref={inputRef}
              dir="auto"
              value={value}
              placeholder={request.placeholder}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
              className="mt-3 w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:border-blue-500"
            />
          )}

          {request.kind === 'choose' && (
            <div className="mt-3 space-y-2">
              {(request.choices ?? []).map((choice, i) => (
                <button
                  key={choice.id}
                  ref={i === 0 ? okRef : undefined}
                  onClick={() => close(choice.id)}
                  className={`w-full text-left px-3 py-2 rounded border transition-colors ${
                    choice.danger
                      ? 'border-red-300 hover:bg-red-50'
                      : choice.primary
                        ? 'border-blue-400 bg-blue-50 hover:bg-blue-100'
                        : 'border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <span className={`block text-sm font-medium ${choice.danger ? 'text-red-700' : 'text-gray-900'}`}>{choice.label}</span>
                  {choice.note && <span dir="auto" className="block text-xs text-gray-500 mt-0.5">{choice.note}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          {request.kind !== 'alert' && (
            <button
              onClick={cancel}
              className="px-4 py-1.5 text-sm rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-100"
            >
              {request.cancelLabel}
            </button>
          )}
          {request.kind !== 'choose' && (
            <button
              ref={okRef}
              onClick={confirm}
              className={`px-4 py-1.5 text-sm rounded text-white ${tone.button}`}
            >
              {request.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/** Mount once, beside the app. */
export const AppDialogHost: React.FC = () => {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump(n => n + 1);
    listeners.add(listener);
    // Entering or leaving full screen moves where the box has to be drawn.
    document.addEventListener('fullscreenchange', listener);
    return () => {
      listeners.delete(listener);
      document.removeEventListener('fullscreenchange', listener);
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  const host = (document.fullscreenElement as HTMLElement | null) ?? document.body;
  // Keyed by the request, so a second question starts with its own input.
  return createPortal(<DialogBox key={current.id} request={current} />, host);
};
