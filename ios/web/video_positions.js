/* Small per-video bookmarks; independent of the media catalog and original files. */
(() => {
  'use strict';
  const DB_NAME = 'PicShelfVideoPositionsDB';
  const STORE = 'positions';
  const CACHE_LIMIT = 256;
  const cache = new Map(), reads = new Map(), writes = new Map();
  let dbPromise = null, warned = false;

  function warn(error) {
    if (!warned) { warned = true; console.warn('Video position could not be stored; playback remains available:', error); }
  }
  function supported(photo) { return !!photo?.id && photo.mediaType !== 'audio' && photo.mediaType !== 'image'; }
  function fingerprint(photo) {
    const entry = photo.tarEntry || photo.zipEntry;
    // These references survive restarts. Session blob URLs and editable titles do not.
    if (entry?.nativeSourceId) {
      const zip = !!photo.zipEntry;
      return JSON.stringify(['native', entry.nativeSourceId, zip ? 'zip' : 'tar',
        zip ? entry.localOffset : entry.offset, zip ? entry.compSize : entry.size,
        zip ? entry.uncompSize : entry.size, zip ? entry.method : 0]);
    }
    const blob = photo.fileBlob;
    const size = Number.isFinite(blob?.size) ? blob.size : (Number.isFinite(photo.fileSize) ? photo.fileSize : null);
    const url = typeof photo.videoUrl === 'string' && !/^(blob:|data:)/i.test(photo.videoUrl) ? photo.videoUrl : null;
    return JSON.stringify(['media', String(photo.id), size, url]);
  }
  function position(photo, record) {
    if (!record || record.fingerprint !== fingerprint(photo) || !Number.isFinite(record.time)) return null;
    const start = Number.isFinite(photo.trimStart) && photo.trimStart >= 0 ? photo.trimStart : 0;
    const end = Number.isFinite(photo.trimEnd) && photo.trimEnd > start ? photo.trimEnd :
      (Number.isFinite(record.duration) && record.duration > start ? record.duration :
        (Number.isFinite(photo.duration) && photo.duration > start ? photo.duration : null));
    if (record.time < start || (end !== null && record.time >= end - .05)) return start;
    return Math.max(start, record.time);
  }
  function remember(id, value) {
    cache.delete(id); cache.set(id, value);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function peek(photo) {
    if (!supported(photo)) return null;
    const entry = cache.get(String(photo.id));
    if (!entry || entry.fingerprint !== fingerprint(photo)) return undefined;
    remember(String(photo.id), entry);
    return position(photo, entry.record);
  }
  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error || Error('Video position database unavailable')); };
      request.onblocked = () => { settled = true; reject(Error('Video position database is blocked')); };
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }
  function get(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      let record = null;
      tx.oncomplete = () => resolve(record);
      tx.onabort = () => reject(tx.error || Error('Video position read aborted'));
      tx.onerror = () => {};
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => { record = request.result || null; };
    });
  }
  function put(db, record) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, 'readwrite', {durability: 'strict'}); }
      catch (error) {
        if (error.name !== 'TypeError' && error.name !== 'NotSupportedError') throw error;
        tx = db.transaction(STORE, 'readwrite');
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error('Video position save aborted'));
      tx.onerror = () => {};
      tx.objectStore(STORE).put(record);
    });
  }
  function read(photo) {
    if (!supported(photo)) return Promise.resolve(null);
    const known = peek(photo);
    if (known !== undefined) return Promise.resolve(known);
    const id = String(photo.id), key = fingerprint(photo);
    let group = reads.get(id);
    if (!group) { group = new Map(); reads.set(id, group); }
    if (group.has(key)) return group.get(key).promise;
    const slot = {replacement: undefined, promise: null};
    group.set(key, slot);
    slot.promise = (async () => {
      try {
        const record = await get(await open(), id);
        if (slot.replacement !== undefined) return position(photo, slot.replacement);
        remember(id, {fingerprint: key, record});
        return position(photo, record);
      } catch (error) {
        warn(error);
        if (slot.replacement !== undefined) return position(photo, slot.replacement);
        const known = peek(photo);
        if (known !== undefined) return known;
        // A failed lookup is resolved for this session, so opening a video can
        // proceed without repeatedly trying an unavailable database.
        remember(id, {fingerprint: key, record: null});
        return null;
      } finally {
        group.delete(key);
        if (!group.size && reads.get(id) === group) reads.delete(id);
      }
    })();
    return slot.promise;
  }
  function save(photo, time, duration) {
    if (!supported(photo) || !Number.isFinite(time) || time < 0) return Promise.resolve(false);
    const id = String(photo.id), key = fingerprint(photo);
    const record = {id, fingerprint: key, time, duration: Number.isFinite(duration) && duration > 0 ? duration : null};
    remember(id, {fingerprint: key, record});
    for (const slot of reads.get(id)?.values() || []) slot.replacement = record;
    const running = writes.get(id);
    if (running) { running.next = record; return running.promise; }
    const slot = {next: record, promise: null};
    writes.set(id, slot);
    slot.promise = (async () => {
      try {
        const db = await open();
        while (slot.next) {
          const latest = slot.next; slot.next = null;
          await put(db, latest);
        }
        return true;
      } catch (error) { warn(error); return false; }
      finally { if (writes.get(id) === slot) writes.delete(id); }
    })();
    return slot.promise;
  }
  function flush() { return Promise.all([...writes.values()].map(slot => slot.promise)); }
  window.PicShelfVideoPositions = Object.freeze({peek, read, save, flush});
})();
