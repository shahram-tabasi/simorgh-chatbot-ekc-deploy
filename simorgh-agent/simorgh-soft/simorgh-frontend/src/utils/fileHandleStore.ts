// src/utils/fileHandleStore.ts
//
// The spreadsheet a switchgear is filled from, kept across reloads.
//
// Device Selection's Update reads the same Excel file again after it has been
// edited and saved. The handle that makes that possible used to live only in
// memory, so a reload — or opening the project tomorrow — lost it, and the
// file had to be imported again before Update did anything. A file handle can
// be put in IndexedDB and taken out again later, which is what this does. The
// browser still asks once per session before a stored handle may be read;
// that question is the browser's, and pressing Update answers it.
//
// Browser storage only, per machine: nothing here is part of the project, and
// every read and write is allowed to fail — the worst case is being asked for
// the file again, which is what happened before this existed.

const DB_NAME = 'simorgh-design-suite';
const STORE = 'excel-handles';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveExcelHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Kept in memory for this session regardless.
  }
}

export async function loadExcelHandle(key: string): Promise<FileSystemFileHandle | null> {
  try {
    const db = await open();
    const handle = await new Promise<FileSystemFileHandle | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

/**
 * Permission to read a stored handle, asked for when it is not already held.
 * Must be called from a click: the browser only shows its question then.
 */
export async function mayRead(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?: (o: unknown) => Promise<PermissionState>;
    requestPermission?: (o: unknown) => Promise<PermissionState>;
  };
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await h.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
