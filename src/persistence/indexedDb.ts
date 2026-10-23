/**
 * Local persistence: IndexedDB project records + autosave.
 * Local-only — nothing ever leaves the device. Blob payloads are stored as
 * Blobs (no base64, no localStorage), with explicit quota error handling.
 */

export const DB_NAME = 'pixelforge';
export const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_AUTOSAVE = 'autosave';

export class StorageError extends Error {
  code: 'quota' | 'unavailable' | 'failed';
  constructor(message: string, code: StorageError['code']) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export interface ProjectRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  layerCount: number;
  modifiedAt: number;
  savedAt: number;
  /** Serialized `.pixelforge` container. */
  data: Blob;
}

export type ProjectMeta = Omit<ProjectRecord, 'data'>;

export interface AutosaveRecord {
  key: 'current';
  savedAt: number;
  name: string;
  data: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function mapStorageError(e: unknown): StorageError {
  const name = e instanceof Error ? e.name : '';
  if (name === 'QuotaExceededError') {
    return new StorageError(
      'Browser storage is full. The project was not saved. Export your work as a file, then clear old saved projects to free space.',
      'quota',
    );
  }
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'OpenError') {
    return new StorageError(
      'Local storage is unavailable (private browsing or blocked site data). Use “Download Project” to keep a file copy.',
      'unavailable',
    );
  }
  return new StorageError(
    `Local storage failed: ${e instanceof Error ? e.message : String(e)}`,
    'failed',
  );
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('IndexedDB is not available in this browser.', 'unavailable'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(mapStorageError(e));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_AUTOSAVE)) {
        db.createObjectStore(STORE_AUTOSAVE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(mapStorageError(request.error));
    request.onblocked = () =>
      reject(new StorageError('Another PixelForge tab is blocking the local database.', 'failed'));
  });
  return dbPromise.catch((e) => {
    dbPromise = null;
    throw e;
  });
}

export async function saveProjectRecord(record: ProjectRecord): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    tx.objectStore(STORE_PROJECTS).put(record);
    await txDone(tx);
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function getProjectRecord(id: string): Promise<ProjectRecord | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const result = await promisifyRequest(tx.objectStore(STORE_PROJECTS).get(id));
    return (result as ProjectRecord | undefined) ?? null;
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

/** List saved project metadata without loading pixel payloads into memory. */
export async function listProjects(): Promise<ProjectMeta[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const out: ProjectMeta[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        const rec = cursor.value as ProjectRecord;
        out.push({
          id: rec.id,
          name: rec.name,
          width: rec.width,
          height: rec.height,
          layerCount: rec.layerCount,
          modifiedAt: rec.modifiedAt,
          savedAt: rec.savedAt,
        });
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function deleteProjectRecord(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(id);
    await txDone(tx);
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function clearAllProjects(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_PROJECTS, STORE_AUTOSAVE], 'readwrite');
    tx.objectStore(STORE_PROJECTS).clear();
    tx.objectStore(STORE_AUTOSAVE).clear();
    await txDone(tx);
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function putAutosave(record: AutosaveRecord): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_AUTOSAVE, 'readwrite');
    tx.objectStore(STORE_AUTOSAVE).put(record);
    await txDone(tx);
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function getAutosave(): Promise<AutosaveRecord | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_AUTOSAVE, 'readonly');
    const result = await promisifyRequest(tx.objectStore(STORE_AUTOSAVE).get('current'));
    return (result as AutosaveRecord | undefined) ?? null;
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_AUTOSAVE, 'readwrite');
    tx.objectStore(STORE_AUTOSAVE).delete('current');
    await txDone(tx);
  } catch (e) {
    if (e instanceof StorageError) throw e;
    throw mapStorageError(e);
  }
}

/** Best-effort storage quota info for the storage panel. */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    if (est.usage === undefined || est.quota === undefined) return null;
    return { usage: est.usage, quota: est.quota };
  } catch {
    return null;
  }
}
