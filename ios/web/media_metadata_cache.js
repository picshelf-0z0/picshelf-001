/* Small metadata journal, independent of the million-item media catalog. */
(() => {
  'use strict';
  const DB_NAME = 'PicShelfMediaMetadataDB', STORE = 'records';
  let dbPromise = null;
  function clean(value) {
    if (!value || !['ok', 'unsupported'].includes(value.status)) return null;
    const result = {status: value.status, location: null};
    const location = value.location;
    if (Number.isFinite(location?.latitude) && Math.abs(location.latitude) <= 90 &&
        Number.isFinite(location?.longitude) && Math.abs(location.longitude) <= 180) {
      result.location = {latitude: location.latitude, longitude: location.longitude};
      for (const name of ['place', 'city', 'country']) {
        result.location[name] = typeof location[name] === 'string' ? location[name].trim().slice(0, 256) : '';
      }
    }
    if (Number.isFinite(value.createdAt) && value.createdAt > 0) result.createdAt = value.createdAt;
    if (typeof value.cameraModel === 'string' && value.cameraModel.trim()) result.cameraModel = value.cameraModel.trim().slice(0, 256);
    return result;
  }
  function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= 8192; }
  function aborted(signal) {
    if (signal?.aborted) { const error = Error('Metadata journal operation cancelled'); error.name = 'AbortError'; throw error; }
  }
  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'key'});
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error || Error('Metadata journal unavailable')); };
      request.onblocked = () => { settled = true; reject(Error('Metadata journal blocked')); };
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }
  async function transact(key, value, signal) {
    aborted(signal);
    const db = await open();
    aborted(signal);
    return new Promise((resolve, reject) => {
      let tx, record = null;
      const writing = value !== undefined;
      if (writing) {
        try { tx = db.transaction(STORE, 'readwrite', {durability: 'strict'}); }
        catch (error) {
          if (error.name !== 'TypeError' && error.name !== 'NotSupportedError') throw error;
          tx = db.transaction(STORE, 'readwrite');
        }
      } else tx = db.transaction(STORE, 'readonly');
      const cancel = () => { try { tx.abort(); } catch (_) {} };
      const done = () => signal?.removeEventListener('abort', cancel);
      tx.oncomplete = () => { done(); resolve(writing ? true : (record?.key === key ? clean(record.result) : null)); };
      tx.onabort = () => { done(); reject(tx.error || Error('Metadata journal transaction aborted')); };
      tx.onerror = () => {};
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) { cancel(); return; }
      const store = tx.objectStore(STORE);
      if (writing) store.put({key, result: value});
      else { const request = store.get(key); request.onsuccess = () => { record = request.result || null; }; }
    });
  }
  window.MediaMetadataCache = Object.freeze({
    get(key, options = {}) {
      if (!validKey(key)) return Promise.reject(Error('Invalid metadata journal key'));
      return transact(key, undefined, options.signal);
    },
    put(key, value, options = {}) {
      const result = clean(value);
      if (!validKey(key) || !result) return Promise.reject(Error('Invalid metadata journal record'));
      return transact(key, result, options.signal);
    }
  });
})();
