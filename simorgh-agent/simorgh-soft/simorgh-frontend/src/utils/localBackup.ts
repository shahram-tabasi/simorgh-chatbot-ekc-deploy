// src/utils/localBackup.ts
//
// A copy of the project on this computer, so a bad day costs minutes.
//
// Everything else about saving is about the database: the version that stops
// two computers overwriting each other, the retry when the server cannot be
// reached, the status bar that says whether anything was written. This is the
// floor underneath all of it. If the database is wrong, or the network was
// down while somebody worked, or a save went somewhere it should not have —
// there is still a copy here, on the machine the work was done on, and it can
// be read back.
//
// IndexedDB rather than localStorage: a real project with its templates and
// its parts is megabytes, and localStorage is five, shared with everything
// else, and synchronous. IndexedDB is none of those things.
//
// It is a convenience and it is treated as one. Every call answers rather than
// throwing — a browser in private mode, a disk that is full, a user who
// cleared their site data all end with "no backups" and an application that
// keeps working, never with an error in the middle of somebody's afternoon.

const DB_NAME = 'simorgh-backups';
const STORE = 'snapshots';
const VERSION = 1;

/** How many snapshots are kept per project. */
export const KEEP_PER_PROJECT = 20;

/** What a snapshot says about itself, without reading the whole thing back. */
export interface BackupInfo {
  id: number;
  projectId: string;
  projectName: string;
  /** ISO time the snapshot was taken. */
  at: string;
  /** The project's version when it was taken, when it had one. */
  rev?: number;
  /** Why it was taken — 'saved', 'save failed', 'conflict', 'by hand'. */
  reason: string;
  /** Enough to tell one snapshot from another at a glance. */
  counts: { templates: number; equipments: number; rows: number };
  /** Roughly how big it is, in bytes of JSON. */
  size: number;
}

interface BackupRecord extends BackupInfo {
  data: unknown;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('projectId', 'projectId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);                  // private mode, or storage refused
    }
  });
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise(resolve => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** What is in a project, for the list. */
export function countProject(project: any): BackupInfo['counts'] {
  const equipments = project?.equipments ?? [];
  return {
    templates: ['LV', 'MV', 'HV']
      .reduce((n, t) => n + (project?.templates?.[t]?.length ?? 0), 0),
    equipments: equipments.length,
    rows: equipments.reduce((n: number, e: any) => n + (e?.devices?.length ?? 0), 0),
  };
}

/**
 * Keep a copy of the project as it is now.
 *
 * Answers true when one was written. A project with no id is one that has
 * never been saved, and is kept under the name it is being given, so that even
 * the very first afternoon's work is recoverable.
 */
export async function keepSnapshot(
  project: any, reason: string, rev?: number,
): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  try {
    const json = JSON.stringify(project);
    const record: Omit<BackupRecord, 'id'> = {
      projectId: String(project?._id ?? project?.projectName ?? 'unsaved'),
      projectName: String(project?.projectName ?? ''),
      at: new Date().toISOString(),
      rev,
      reason,
      counts: countProject(project),
      size: json.length,
      data: JSON.parse(json),         // a copy, not a live reference
    };
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(record);
    const ok = await done(tx);
    if (ok) await prune(record.projectId);
    return ok;
  } catch {
    return false;                     // out of quota, most likely
  } finally {
    db.close();
  }
}

/** Drop everything past the newest `KEEP_PER_PROJECT` for one project. */
async function prune(projectId: string): Promise<void> {
  const all = await listSnapshots(projectId);
  const extra = all.slice(KEEP_PER_PROJECT);
  if (extra.length === 0) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    for (const one of extra) tx.objectStore(STORE).delete(one.id);
    await done(tx);
  } finally {
    db.close();
  }
}

/** The snapshots of one project, newest first. Empty when there are none. */
export async function listSnapshots(projectId: string): Promise<BackupInfo[]> {
  const db = await open();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const index = tx.objectStore(STORE).index('projectId');
    const request = index.getAll(projectId);
    const rows: BackupRecord[] = await new Promise(resolve => {
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => resolve([]);
    });
    return rows
      .map(({ data, ...info }) => info)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** One snapshot, whole. Null when it is no longer there. */
export async function readSnapshot(id: number): Promise<any | null> {
  const db = await open();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(id);
    const row: BackupRecord | undefined = await new Promise(resolve => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    return row?.data ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Forget every snapshot of one project. */
export async function forgetProject(projectId: string): Promise<void> {
  const all = await listSnapshots(projectId);
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    for (const one of all) tx.objectStore(STORE).delete(one.id);
    await done(tx);
  } finally {
    db.close();
  }
}
