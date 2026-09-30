// src/services/lockService.ts
//
// Who is working on which switchgear or template — the client half of
// simorgh-backend/projectLocks.js.
//
// A lock belongs to this browser tab (its holder id lives in sessionStorage,
// so a second tab is a second holder) and is shown to colleagues under the
// signed-in user's name. Nothing here is security: it is manners, so that two
// people do not type into the same switchgear and save over each other.

const API = `${(import.meta as { env?: Record<string, string> }).env?.VITE_API_URL || ''}/api`;

export type LockKind = 'equipment' | 'template';

export interface LockInfo {
  key: string;
  holderId: string;
  userName: string;
  since?: string;
}

export const lockKey = (kind: LockKind, id: string) => `${kind}:${id}`;

const HOLDER_KEY = 'simorgh-lock-holder';

const random = () => Math.random().toString(36).slice(2, 10);

/** This tab. Kept for the tab's life, so a reload keeps the locks it held. */
export function holderId(): string {
  try {
    let id = sessionStorage.getItem(HOLDER_KEY);
    if (!id) { id = `tab-${random()}`; sessionStorage.setItem(HOLDER_KEY, id); }
    return id;
  } catch {
    return (window as any).__simorghHolder ??= `tab-${random()}`;
  }
}

/**
 * The name colleagues see beside what this person has open.
 *
 * It is never asked for: it is the signed-in user's, and sign-in (JWT) is
 * being built separately. Until it lands this is empty and colleagues see
 * "Another user". When it lands, this is the one place to read the user's
 * name from the token — nothing else needs to change.
 */
export function userName(): string {
  return '';
}

const post = (path: string, body: unknown) => fetch(`${API}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export type AcquireResult =
  | { ok: true }
  | { ok: false; holder: LockInfo | null }
  /** The server could not be asked — no lock service, no network. */
  | { ok: 'unknown' };

export const lockService = {
  async acquire(projectId: string, key: string): Promise<AcquireResult> {
    try {
      const r = await post(`/projects/${projectId}/locks/acquire`,
        { key, holderId: holderId(), userName: userName() });
      if (r.ok) return { ok: true };
      if (r.status === 423) {
        const body = await r.json().catch(() => ({}));
        return { ok: false, holder: body?.holder ? { key, ...body.holder } : null };
      }
      return { ok: 'unknown' };
    } catch {
      return { ok: 'unknown' };
    }
  },

  release(projectId: string, key?: string): void {
    post(`/projects/${projectId}/locks/release`, { key, holderId: holderId() }).catch(() => { /* it expires by itself */ });
  },

  /** On the way out of the page: the one kind of request a closing tab still sends. */
  releaseAllOnUnload(projectId: string): void {
    try {
      const blob = new Blob([JSON.stringify({ holderId: holderId() })], { type: 'application/json' });
      navigator.sendBeacon(`${API}/projects/${projectId}/locks/release`, blob);
    } catch { /* the locks expire by themselves */ }
  },

  async heartbeat(projectId: string): Promise<{ locks: LockInfo[]; rev: number | null } | null> {
    try {
      const r = await post(`/projects/${projectId}/locks/heartbeat`,
        { holderId: holderId(), userName: userName() });
      if (!r.ok) return null;
      const body = await r.json();
      return { locks: body.locks ?? [], rev: typeof body.rev === 'number' ? body.rev : null };
    } catch {
      return null;
    }
  },
};
