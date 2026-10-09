import type { TemplateProject } from '../../types/project';
import { validateProject } from './projectFile';

/**
 * Browser-local persistence in IndexedDB. Data stays in this browser profile;
 * nothing is sent anywhere. Stored:
 *   - project layouts (fields, mapping, settings, column names)
 *   - the template PDF, if the project's "store PDF in this browser" setting is on
 *   - uploaded fonts
 * Never stored: spreadsheet rows, photos, generated PDFs.
 */

const DB_NAME = 'pdf-template-studio';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const BLOBS = 'blobs';

export class StorageUnavailableError extends Error {}
export class StorageQuotaError extends Error {}

export interface StoredProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  pdfName: string | null;
  fieldCount: number;
  hasPdf: boolean;
}

interface StoredProjectRecord {
  id: string;
  project: TemplateProject;
  savedAt: string;
  hasPdf: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageUnavailableError('This browser does not allow local storage (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(
        new StorageUnavailableError(`Local storage could not be opened: ${req.error?.message ?? 'unknown error'}. Private browsing windows may block it.`),
      );
    req.onblocked = () => reject(new StorageUnavailableError('Local storage is blocked by another tab. Close other tabs of this app and try again.'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function wrapError(err: unknown): Error {
  const e = err as DOMException | undefined;
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message ?? ''))) {
    return new StorageQuotaError('The browser storage is full. Turn off "Store PDF in this browser", remove old projects, or export the project to a file.');
  }
  return err instanceof Error ? err : new Error(String(err));
}

function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let t: IDBTransaction;
        try {
          t = db.transaction(stores, mode);
          result = run(t);
        } catch (err) {
          reject(wrapError(err));
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(wrapError(t.error));
        t.onabort = () => reject(wrapError(t.error ?? new Error('Storage transaction aborted.')));
      }),
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(wrapError(req.error));
  });
}

const pdfKey = (projectId: string) => `pdf:${projectId}`;
const fontKey = (fontId: string) => `font:${fontId}`;

export async function saveProject(project: TemplateProject, pdfBytes: Uint8Array | null, fonts: Map<string, Uint8Array>): Promise<void> {
  const storePdf = project.settings.storePdfInBrowser && !!pdfBytes;
  await tx([PROJECTS, BLOBS], 'readwrite', (t) => {
    const record: StoredProjectRecord = { id: project.id, project, savedAt: new Date().toISOString(), hasPdf: storePdf };
    t.objectStore(PROJECTS).put(record);
    const blobs = t.objectStore(BLOBS);
    if (storePdf) blobs.put(pdfBytes, pdfKey(project.id));
    else blobs.delete(pdfKey(project.id));
    for (const f of project.fonts) {
      const bytes = fonts.get(f.id);
      if (bytes) blobs.put(bytes, fontKey(f.id));
    }
  });
}

export async function listProjects(): Promise<StoredProjectSummary[]> {
  const all = await tx([PROJECTS], 'readonly', (t) => request(t.objectStore(PROJECTS).getAll() as IDBRequest<StoredProjectRecord[]>));
  return all
    .map((r) => ({
      id: r.id,
      name: r.project?.name ?? 'Untitled',
      updatedAt: r.project?.updatedAt ?? r.savedAt,
      pdfName: r.project?.pdf?.fileName ?? null,
      fieldCount: r.project?.fields?.length ?? 0,
      hasPdf: !!r.hasPdf,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface LoadedProject {
  project: TemplateProject;
  warnings: string[];
  pdfBytes: Uint8Array | null;
  fonts: Map<string, Uint8Array>;
}

export async function loadProject(id: string): Promise<LoadedProject> {
  const { recordReq, pdfReq } = await tx([PROJECTS, BLOBS], 'readonly', (t) => ({
    recordReq: request(t.objectStore(PROJECTS).get(id) as IDBRequest<StoredProjectRecord | undefined>),
    pdfReq: request(t.objectStore(BLOBS).get(pdfKey(id)) as IDBRequest<Uint8Array | undefined>),
  }));
  const record = await recordReq;
  if (!record) throw new Error('This project is no longer stored in this browser.');
  // Stored data is validated like an imported file (it may come from an older version).
  const { project, warnings } = validateProject(record.project);
  const pdfBytes = (await pdfReq) ?? null;
  const fonts = new Map<string, Uint8Array>();
  await tx([BLOBS], 'readonly', (t) => {
    for (const f of project.fonts) {
      const req = t.objectStore(BLOBS).get(fontKey(f.id)) as IDBRequest<Uint8Array | undefined>;
      req.onsuccess = () => {
        if (req.result) fonts.set(f.id, req.result);
      };
    }
  });
  for (const f of project.fonts) if (!fonts.has(f.id)) warnings.push(`Font "${f.name}" is not stored in this browser. Add it again in the Fonts panel.`);
  return { project, warnings, pdfBytes: pdfBytes ? new Uint8Array(pdfBytes) : null, fonts };
}

export async function deleteProject(id: string): Promise<void> {
  const record = await tx([PROJECTS], 'readonly', (t) => request(t.objectStore(PROJECTS).get(id) as IDBRequest<StoredProjectRecord | undefined>));
  const fontIds = (record?.project?.fonts ?? []).map((f) => f.id);
  await tx([PROJECTS, BLOBS], 'readwrite', (t) => {
    t.objectStore(PROJECTS).delete(id);
    t.objectStore(BLOBS).delete(pdfKey(id));
    for (const fid of fontIds) t.objectStore(BLOBS).delete(fontKey(fid));
  });
}

/** Remove everything this app stored in this browser. */
export async function clearAllLocalData(): Promise<void> {
  await tx([PROJECTS, BLOBS], 'readwrite', (t) => {
    t.objectStore(PROJECTS).clear();
    t.objectStore(BLOBS).clear();
  });
  try {
    localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export const LAST_PROJECT_KEY = 'pdf-template-studio:last-project';

export function rememberLastProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    /* storage may be disabled; not critical */
  }
}

export function lastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}
