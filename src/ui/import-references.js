const DB_NAME = 'qingpu-import-references-v1';
const STORE_NAME = 'images';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('IndexedDB 不可用'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

export async function loadImportReferences(songId) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(songId);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error ?? new Error('原图参考读取失败'));
    });
  } catch {
    return [];
  }
}

export async function saveImportReferences(songId, images) {
  if (!songId || !images?.length) return false;
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(images, songId);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error ?? new Error('原图参考保存失败'));
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteImportReferences(songId) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(songId);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error ?? new Error('原图参考删除失败'));
    });
  } catch {
    // 原图参考是增强功能，删除失败不影响歌曲本身。
  }
}
