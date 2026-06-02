/**
 * notifyBus — tiny app-wide pub/sub for toast/status events.
 *
 * SignalR-style hub: any component can call `notify({...})` to surface a
 * status update; App.tsx subscribes once and pipes events into the
 * existing <NotificationToast/> queue. Keeps callsites decoupled from
 * React state plumbing.
 */
export type ToastType = "info" | "success" | "warning" | "error" | "progress";

export interface NotifyEvent {
  id:       string;
  type:     ToastType;
  title?:   string;
  message:  string;
  /** 0..100 — shown as a progress bar instead of the auto-dismiss timer. */
  progress?: number;
  /** Override the default 6s auto-dismiss. Set to 0 to keep open until
   *  the caller explicitly dismisses (e.g. long-running progress). */
  timeoutMs?: number;
  /** Caller-stable id — re-emitting with the same `key` UPDATES the
   *  existing toast (good for live progress) instead of stacking a new
   *  one on top of it. */
  key?:     string;
}

type Listener = (ev: NotifyEvent) => void;

const listeners = new Set<Listener>();

function uid(): string {
  // crypto.randomUUID is fine on modern browsers; fall back to Math.random.
  const g = globalThis as any;
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function notify(ev: Omit<NotifyEvent, "id"> & { id?: string }): string {
  const full: NotifyEvent = { id: ev.id || uid(), ...ev };
  listeners.forEach((l) => l(full));
  return full.id;
}

export function subscribeNotify(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
