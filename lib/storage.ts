import type { Envelope } from './vault';
export type Draft = { envelope: Envelope; baseline: string; dirty: boolean };
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('dental-library-encrypted-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('drafts');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(
        new Error(
          'Browser storage is unavailable. Export an encrypted backup to keep your changes.',
        ),
      );
  });
}
export async function readDraft(): Promise<Draft | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly');
    const r = tx.objectStore('drafts').get(location.pathname);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => db.close();
  });
}
export async function writeDraft(value: Draft): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(value, location.pathname);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(
        new Error(
          'Could not save to this browser. Export an encrypted backup before closing.',
        ),
      );
    };
    tx.onabort = () => {
      db.close();
      reject(new Error('Browser save was interrupted. Export a backup.'));
    };
  });
}
