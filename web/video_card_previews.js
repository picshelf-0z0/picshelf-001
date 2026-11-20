/* Last viewed video frames belong to cards, not to original media or the catalog. */
(() => {
  'use strict';
  const DB_NAME = 'PicShelfVideoCardPreviewsDB', STORE = 'frames';
  const MAX_ENTRIES = 64, MAX_BYTES = 8 * 1024 * 1024, MAX_SIDE = 512;
  const PLACEHOLDER = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E';
  const cache = new Map(), reads = new Map(), captures = new Map(), writes = new Map();
  const deferred = new Map();
  const queue = [];
  let bytes = 0, activeReads = 0, dbPromise = null, warned = false;

  function warn(error) {
    if (!warned) { warned = true; console.warn('Video card preview unavailable; playback is unchanged:', error); }
  }
  function supported(photo) { return !!photo?.id && photo.mediaType === 'video'; }
  function fingerprint(photo) {
    const e = photo.tarEntry || photo.zipEntry, blob = photo.fileBlob;
    const source = e?.nativeSourceId
      ? [e.nativeSourceId, photo.tarEntry ? 'tar' : 'zip', e.offset, e.localOffset, e.size, e.compSize, e.uncompSize, e.method]
      : [String(photo.id), blob?.size ?? photo.fileSize ?? null,
        typeof photo.videoUrl === 'string' && !/^(blob:|data:)/i.test(photo.videoUrl) ? photo.videoUrl : null];
    return JSON.stringify([source, photo.videoCrop || null, photo.videoResize || null,
      photo.videoLooks || null, photo.lastEditedAt || null, photo.trimStart ?? null, photo.trimEnd ?? null]);
  }
  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, {keyPath: 'id'});
      };
      request.onsuccess = () => {
        if (settled) {request.result.close(); return;}
        settled = true;
        const db = request.result;
        db.onversionchange = () => {db.close(); dbPromise = null;};
        resolve(db);
      };
      request.onerror = () => {settled = true; reject(request.error || Error('Preview database unavailable'));};
      request.onblocked = () => {settled = true; reject(Error('Preview database blocked'));};
    }).catch(error => {dbPromise = null; throw error;});
    return dbPromise;
  }
  function readRecord(db, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      let record = null;
      tx.objectStore(STORE).get(id).onsuccess = e => {record = e.target.result || null;};
      tx.oncomplete = () => resolve(record);
      tx.onabort = () => reject(tx.error || Error('Preview read aborted'));
      tx.onerror = () => {};
    });
  }
  function writeRecord(db, record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error('Preview save aborted'));
      tx.onerror = () => {};
      tx.objectStore(STORE).put(record);
    });
  }
  function persist(record) {
    const running = writes.get(record.id);
    if (running) {running.next = record; return running.promise;}
    const slot = {next: record, promise: null};
    writes.set(record.id, slot);
    slot.promise = (async () => {
      try {
        const db = await open();
        while (slot.next) {const latest = slot.next; slot.next = null; await writeRecord(db, latest);}
      } catch (error) {warn(error);}
      finally {if (writes.get(record.id) === slot) writes.delete(record.id);}
    })();
    return slot.promise;
  }
  function forget(id) {
    const old = cache.get(id);
    if (!old) return;
    cache.delete(id); bytes -= old.bytes;
    if (old.url) URL.revokeObjectURL(old.url);
  }
  function remember(id, key, blob, time = null) {
    forget(id);
    const item = {fingerprint: key, url: blob ? URL.createObjectURL(blob) : null, bytes: blob?.size || 0, time};
    cache.set(id, item); bytes += item.bytes;
    while (cache.size > MAX_ENTRIES || bytes > MAX_BYTES) forget(cache.keys().next().value);
    return cache.get(id)?.url || null;
  }
  function updateMounted(photo, url) {
    if (!url) return;
    const cards = new Set();
    for (const id of ['galleryPhotoGrid', 'dockPhotoGrid', 'favoritesPhotoGrid', 'trashPhotoGrid']) {
      const card = document.getElementById(id)?._cardMap?.get(photo.id);
      if (card) cards.add(card);
    }
    // Picker previews may not have a grid map. Search only mounted elements.
    for (const card of document.querySelectorAll(`[data-id="${CSS.escape(String(photo.id))}"]`)) cards.add(card);
    for (const card of cards) {
      const image = card.querySelector('img');
      if (image && image.getAttribute('src') !== url) {
        image.src = url;
        image.classList.remove('zip-deferred-thumb');
      }
    }
  }
  function currentRead(slot) {
    return !slot.invalid && reads.get(slot.id) === slot && !captures.has(slot.id) &&
      fingerprint(slot.photo) === slot.fingerprint;
  }
  function originalPoster(photo) {
    return [photo.thumbUrl, photo.posterUrl, photo.dataUrl].find(url =>
      typeof url === 'string' && url && url !== photo.videoUrl && !/^data:(?!image\/)/i.test(url)) ||
      window.ZIP_PLACEHOLDER_DATA_URL || PLACEHOLDER;
  }
  function publishFallback(photo) {
    // A verified miss is cached before re-entering the existing poster loader.
    // It can now enqueue its normal metadata work without another resume read.
    let url;
    try {url = window.ensurePhotoDataUrlSync?.(photo);} catch (_) {}
    updateMounted(photo, url || originalPoster(photo));
  }
  function finishRead(slot, url = null) {
    if (reads.get(slot.id) === slot) reads.delete(slot.id);
    if (deferred.get(slot.id) === slot) deferred.delete(slot.id);
    slot.resolve(url);
  }
  function makeRead(photo, key, priority = false) {
    const slot = {id: String(photo.id), photo, fingerprint: key, invalid: false, priority, resolve: null};
    slot.promise = new Promise(resolve => {slot.resolve = resolve;});
    reads.set(slot.id, slot);
    return slot;
  }
  function pump() {
    while (queue.length < 48 && deferred.size) {
      const slot = [...deferred.values()].find(item => item.priority) || deferred.values().next().value;
      deferred.delete(slot.id);
      if (slot.priority) queue.unshift(slot); else queue.push(slot);
    }
    while (activeReads < 2 && queue.length) {
      const slot = queue.shift();
      if (!currentRead(slot)) {finishRead(slot); continue;}
      activeReads++;
      (async () => {
        try {
          const record = await readRecord(await open(), slot.id);
          if (!currentRead(slot)) return;
          const blob = record?.fingerprint === slot.fingerprint && record.blob instanceof Blob ? record.blob : null;
          const url = remember(slot.id, slot.fingerprint, blob, record?.time);
          if (url) updateMounted(slot.photo, url); else publishFallback(slot.photo);
          slot.resolve(url);
        } catch (error) {
          warn(error);
          if (currentRead(slot)) {
            remember(slot.id, slot.fingerprint, null);
            publishFallback(slot.photo);
          }
        } finally {
          finishRead(slot);
          activeReads--; pump();
        }
      })();
    }
  }
  function get(photo) {
    if (!supported(photo)) return null;
    const id = String(photo.id), key = fingerprint(photo), old = cache.get(id);
    if (old?.fingerprint === key) {cache.delete(id); cache.set(id, old); return old.url;}
    if (old) forget(id);
    if (captures.has(id)) return null;
    const pending = reads.get(id);
    if (pending?.fingerprint === key && !pending.invalid) return null;
    if (pending) {
      pending.invalid = true;
      // A deferred slot has no running I/O that could settle it later.
      // Resolve it before replacing the same ID with a different source/edit.
      if (deferred.get(id) === pending) finishRead(pending);
    }
    if (queue.length >= 48) return null;
    const slot = makeRead(photo, key);
    queue.push(slot); pump();
    return null;
  }
  function read(photo, priority = true) {
    if (!supported(photo)) return Promise.resolve(null);
    const url = get(photo), id = String(photo.id), key = fingerprint(photo);
    if (cache.get(id)?.fingerprint === key) return Promise.resolve(url);
    if (captures.has(id)) return captures.get(id).promise.then(() => get(photo));
    const pending = reads.get(id);
    if (pending?.fingerprint === key && !pending.invalid) {
      if (priority) {
        pending.priority = true;
        const index = queue.indexOf(pending);
        if (index > 0) {queue.splice(index, 1); queue.unshift(pending);}
      }
      return pending.promise;
    }
    // Retain only a small next batch, never every item in a massive library.
    if (deferred.size >= 48) {
      const oldest = [...deferred.values()].find(item => !item.priority);
      if (!oldest) return Promise.resolve(null);
      oldest.invalid = true;
      finishRead(oldest);
      updateMounted(oldest.photo, originalPoster(oldest.photo));
    }
    const slot = makeRead(photo, key, priority);
    deferred.set(id, slot);
    return slot.promise;
  }
  function cardSource(photo) {
    const url = get(photo);
    if (url || !supported(photo)) return url;
    const id = String(photo.id), key = fingerprint(photo);
    if (cache.get(id)?.fingerprint === key) return null;
    read(photo, false);
    return reads.has(id) || captures.has(id) ? PLACEHOLDER : null;
  }
  function getAtTime(photo, time) {
    if (!supported(photo) || !Number.isFinite(time)) return null;
    const item = cache.get(String(photo.id));
    return item?.fingerprint === fingerprint(photo) && Number.isFinite(item.time) &&
      Math.abs(item.time - time) <= .5 ? item.url : null;
  }
  function compose(photo, video) {
    const crop = photo.videoCrop, resize = !crop && photo.videoResize;
    let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
    const box = crop?.normBox;
    if (box?.width > 0 && box?.height > 0) {
      sx = Math.max(0, Math.min(1, box.left || 0)) * sw;
      sy = Math.max(0, Math.min(1, box.top || 0)) * sh;
      sw = Math.min(sw - sx, sw * box.width); sh = Math.min(sh - sy, sh * box.height);
    }
    if (!(sw > 0 && sh > 0)) return null;
    let w = crop?.cropW || resize?.targetW || sw, h = crop?.cropH || resize?.targetH || sh;
    if (crop && (!crop.cropW || !crop.cropH) && crop.aspect && crop.aspect !== 'free' && !box) {
      const parts = crop.aspect.split(':').map(Number);
      if (parts[0] > 0 && parts[1] > 0) {w = sw; h = sw * parts[1] / parts[0];}
    }
    if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) return null;
    const edit = crop || resize || {}, angle = (Number(edit.rotation) || 0) * Math.PI / 180;
    const boundW = Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle));
    const boundH = Math.abs(h * Math.cos(angle)) + Math.abs(w * Math.sin(angle));
    const scale = Math.min(1, MAX_SIDE / Math.max(boundW, boundH));
    w *= scale; h *= scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(boundW * scale));
    canvas.height = Math.max(1, Math.round(boundH * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle);
    ctx.scale(edit.flipH ? -1 : 1, edit.flipV ? -1 : 1);
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
    ctx.filter = photo.videoLooks?.filter || 'none';
    const factor = crop || resize?.fitMode === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
    const dw = sw * factor, dh = sh * factor;
    ctx.drawImage(video, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    return canvas;
  }
  function capture(photo, video) {
    if (!supported(photo) || !video || video.readyState < 2 || video.seeking ||
        !Number.isFinite(video.currentTime) || video.currentTime < 0 ||
        !Number.isFinite(video.videoWidth) || !Number.isFinite(video.videoHeight) || video.videoWidth <= 0 || video.videoHeight <= 0) return Promise.resolve(false);
    const id = String(photo.id), key = fingerprint(photo), time = video.currentTime;
    let canvas;
    try {canvas = compose(photo, video);} catch (error) {warn(error); return Promise.resolve(false);}
    if (!canvas) return Promise.resolve(false);
    if (reads.has(id)) reads.get(id).invalid = true;
    const slot = {promise: null};
    captures.set(id, slot);
    slot.promise = new Promise(resolve => {
      const finish = async blob => {
        canvas.width = canvas.height = 1;
        let published = false;
        try {
          if (!blob || captures.get(id) !== slot || fingerprint(photo) !== key) {resolve(false); return;}
          const url = remember(id, key, blob, time);
          updateMounted(photo, url);
          published = !!url;
          await persist({id, fingerprint: key, time, blob});
          resolve(true);
        } catch (error) {warn(error); resolve(false);}
        finally {
          if (captures.get(id) === slot) {
            captures.delete(id);
            if (!published) {
              // Capture invalidates an older read. If encoding fails, restart
              // that lookup (or restore its cached fallback) instead of leaving
              // a cold card on the neutral placeholder indefinitely.
              const restored = cardSource(photo);
              if (restored && restored !== PLACEHOLDER) updateMounted(photo, restored);
              else if (!restored) publishFallback(photo);
            }
          }
        }
      };
      try {canvas.toBlob(finish, 'image/jpeg', .86);} catch (error) {warn(error); finish(null);}
    });
    return slot.promise;
  }
  async function flush() {
    await Promise.all([...captures.values()].map(slot => slot.promise));
    await Promise.all([...writes.values()].map(slot => slot.promise));
  }
  window.VideoCardPreviews = {capture, get, cardSource, read, getAtTime, PLACEHOLDER, flush,
    stats: () => ({entries: cache.size, bytes, queuedReads: queue.length, deferredReads: deferred.size, activeReads, pendingWrites: writes.size, captures: captures.size})};
})();
