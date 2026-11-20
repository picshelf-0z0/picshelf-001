/* Card-only archive previews. Originals remain owned by the detail/export path. */
(function createGalleryThumbnailSession() {
  'use strict';
  const cache = new Map();
  const failures = new WeakMap();
  const busy = new Set();
  const workers = [];
  const nativeArchives = new WeakMap();
  const nativeFailures = new WeakSet();
  const decoded = new Map();
  const decoding = new WeakMap();
  let decodedPixels = 0;
  let previousCenter = -1, previousGrid = null, direction = 1;
  let queue = [], wanted = new Map(), bytes = 0, completed = 0;
  const MAX_ENTRIES = 192, MAX_BYTES = 24 * 1024 * 1024;
  const MAX_DECODED_PIXELS = 8 * 1024 * 1024;

  function retain(img) {
    const url = img.getAttribute('src');
    const isThumb = window.ArchiveSources?.isThumbnailUrl ? window.ArchiveSources.isThumbnailUrl(url) : !!url?.startsWith('https://picshelf-thumbnails.invalid/');
    if (!isThumb || !img.complete || !img.naturalWidth) return false;
    const old = decoded.get(url);
    if (old) { decodedPixels -= old.pixels; if (old.img !== img) old.img.removeAttribute('src'); decoded.delete(url); }
    const pixels = img.naturalWidth * img.naturalHeight;
    img.remove(); // Do not retain the old card subtree through parentNode.
    decoded.set(url, {img, pixels}); decodedPixels += pixels;
    while (decoded.size > 64 || decodedPixels > MAX_DECODED_PIXELS) {
      const [key, item] = decoded.entries().next().value;
      decoded.delete(key); decodedPixels -= item.pixels; item.img.removeAttribute('src');
    }
    return true;
  }

  function workerMain() {
    self.onmessage = async ({ data: job }) => {
      let bitmap;
      try {
        const e = job.entry;
        let blob;
        if (job.originalUrl) {
          const response = await fetch(job.originalUrl);
          if (!response.ok) throw Error('Archive entry unavailable');
          blob = await response.blob();
        } else if (job.kind === 'tar') {
          blob = e.tarFile.slice(e.offset, e.offset + e.size);
        } else {
          const header = new DataView(await e.zipFile.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
          if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) throw Error('Invalid ZIP local header');
          // Central-directory extra fields need not match the local header.
          const start = e.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
          blob = e.zipFile.slice(start, start + e.compSize);
          if (e.method === 8) {
            if (!self.pako || !self.pako.inflateRaw) throw Error('ZIP inflater unavailable');
            blob = new Blob([self.pako.inflateRaw(new Uint8Array(await blob.arrayBuffer()))]);
          } else if (e.method !== 0) throw Error('Unsupported ZIP compression');
        }
        if (blob.size <= 256 * 1024) {
          // Materialize a small entry once. A File.slice-backed object URL
          // otherwise re-enters Android's content provider when remounted.
          // Retain original encoded bytes, without another decode or upscale.
          self.postMessage({ blob: new Blob([await blob.arrayBuffer()]) });
          return;
        }
        // Decode and scale away from WebView's scroll/layout thread. A card
        // never needs the full-resolution bitmap used by the editor/exporter.
        bitmap = await createImageBitmap(blob, { resizeWidth: 512, resizeQuality: 'high' });
        const canvas = new OffscreenCanvas(512, 352);
        const ctx = canvas.getContext('2d');
        const scale = Math.max(512 / bitmap.width, 352 / bitmap.height);
        const w = bitmap.width * scale, h = bitmap.height * scale;
        ctx.drawImage(bitmap, (512 - w) / 2, (352 - h) / 2, w, h);
        const alpha = /\.(png|webp)$/i.test(e.baseName || '');
        const preview = await canvas.convertToBlob({ type: alpha ? 'image/png' : 'image/jpeg', quality: 0.92 });
        self.postMessage({ blob: preview });
      } catch (error) {
        self.postMessage({ error: String(error) });
      } finally {
        if (bitmap) bitmap.close();
      }
    };
  }

  function supports(photo) {
    return !!photo && !!(photo.tarEntry?.tarFile || photo.zipEntry?.zipFile ||
      photo.tarEntry?.nativeSourceId || photo.zipEntry?.nativeSourceId) &&
      !photo.lastEditedAt && !(photo.dataUrl?.startsWith('data:image/') && !photo.dataUrl.startsWith('data:image/svg')) &&
      (!photo.mediaType || photo.mediaType === 'image') &&
      !/\.(gif|svg)$/i.test(photo.displayName || '') &&
      ((typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap === 'function' && !!window._ZIP_WORKER_SCRIPT) ||
      !!window.AndroidApp?.registerThumbnailArchive || !!window.isNativeIOS);
  }
  function register(file) {
    if (!file || !window.AndroidApp?.registerThumbnailArchive) return '';
    if (!nativeArchives.has(file)) {
      let token = '';
      try { token = window.AndroidApp.registerThumbnailArchive(file.name || '', file.size); } catch (_) {}
      nativeArchives.set(file, token);
    }
    return nativeArchives.get(file);
  }
  function nativeUrl(photo) {
    if (nativeFailures.has(photo)) return null;
    const thumbsOrigin = window.ArchiveSources?.thumbnailsOrigin || 'https://picshelf-thumbnails.invalid/';
    const source = !photo.lastEditedAt && !photo.originalDataUrl && window.ArchiveSources?.nativeInfo(photo);
    if (source) return `${thumbsOrigin}${encodeURIComponent(source.token)}/${source.kind}/${source.offset}/${source.size}/${source.method}`;
    const entry = photo.tarEntry || photo.zipEntry;
    const file = entry?.tarFile || entry?.zipFile;
    const token = register(file);
    if (!token) return null;
    return `${thumbsOrigin}${token}/${photo.tarEntry ? 'tar' : 'zip'}/${photo.tarEntry ? entry.offset : entry.localOffset}/${photo.tarEntry ? entry.size : entry.compSize}/${photo.tarEntry ? 0 : entry.method}`;
  }
  function valid(record, photo) {
    return record && record.entry === (photo.tarEntry || photo.zipEntry) &&
      record.source === photo.dataUrl;
  }
  function get(photo) {
    const native = nativeUrl(photo);
    if (native) return native;
    const record = cache.get(photo);
    if (!valid(record, photo)) return null;
    cache.delete(photo);
    cache.set(photo, record);
    return record.url;
  }
  function trim() {
    for (const [photo, record] of cache) {
      if (cache.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
      if (wanted.has(photo)) continue;
      URL.revokeObjectURL(record.url);
      bytes -= record.bytes;
      cache.delete(photo);
    }
  }
  function update(photo, url, eager = false) {
    const target = wanted.get(photo);
    const card = target?.grid._cardMap?.get(photo.id);
    let img = card?.querySelector('img');
    if (img && card.isConnected && url) {
      const reuse = decoded.get(url);
      if (reuse) {
        decoded.delete(url); decodedPixels -= reuse.pixels;
        const previous = img;
        img = reuse.img;
        decoding.delete(img);
        for (const attr of img.getAttributeNames()) if (attr !== 'src') img.removeAttribute(attr);
        for (const attr of previous.getAttributeNames()) if (attr !== 'src') img.setAttribute(attr, previous.getAttribute(attr));
        previous.replaceWith(img);
      }
      if (eager) { img.loading = 'eager'; img.decoding = 'sync'; }
      // Reassigning src on every scroll tick can restart an outstanding load.
      if (img.getAttribute('src') !== url) img.src = url;
      img.classList.remove('zip-deferred-thumb');
      // Eager fetching alone leaves clipped/offscreen images undecoded.
      // Prepare their bitmaps now, before a fling brings them onto the screen.
      if (eager && img.decode && decoding.get(img) !== url) {
        decoding.set(img, url);
        img.decode().catch(() => {});
      }
    }
  }
  function pump() {
    for (const slot of workers) {
      if (slot.photo) continue;
      let photo;
      while (queue.length) {
        const next = queue.shift();
        if (wanted.has(next) && !busy.has(next) && !get(next)) { photo = next; break; }
      }
      if (!photo) break;
      slot.photo = photo;
      slot.entry = photo.tarEntry || photo.zipEntry;
      slot.source = photo.dataUrl;
      busy.add(photo);
      const originalUrl = window.ArchiveSources?.originalUrl(photo);
      slot.worker.postMessage({ kind: photo.tarEntry ? 'tar' : 'zip',
        entry: originalUrl ? { baseName: slot.entry.baseName } : slot.entry, originalUrl });
    }
  }
  function finish(slot, result) {
    const photo = slot.photo;
    if (!photo) return;
    busy.delete(photo);
    slot.photo = null;
    if (result.blob && slot.entry === (photo.tarEntry || photo.zipEntry) && slot.source === photo.dataUrl) {
      const old = cache.get(photo);
      if (old) { URL.revokeObjectURL(old.url); bytes -= old.bytes; }
      const url = URL.createObjectURL(result.blob);
      cache.set(photo, { url, bytes: result.blob.size, entry: slot.entry, source: slot.source });
      bytes += result.blob.size;
      completed++;
      update(photo, url);
      trim();
    } else if (result.error) {
      failures.set(photo, Date.now());
      // Keep unsupported/corrupt entries out of the hot queue. The existing
      // original-image resolver remains the compatibility fallback.
      if (wanted.has(photo)) {
        Promise.resolve(window.resolveZipPhotoDataUrl(photo)).then(url => update(photo, url)).catch(() => {});
      }
    }
    pump();
  }
  function init() {
    if (workers.length) return;
    const url = URL.createObjectURL(new Blob([window._ZIP_WORKER_SCRIPT, '\n(', workerMain.toString(), ')();'], { type: 'text/javascript' }));
    try {
      for (let i = 0; i < 2; i++) {
        const slot = { worker: new Worker(url), photo: null };
        slot.worker.onmessage = e => finish(slot, e.data);
        slot.worker.onerror = e => finish(slot, { error: e.message });
        workers.push(slot);
      }
    } finally { URL.revokeObjectURL(url); }
  }
  function schedule(photos, grid, center) {
    if (grid === previousGrid && center !== previousCenter) direction = Math.sign(center - previousCenter);
    else if (grid !== previousGrid) direction = 1;
    previousCenter = center; previousGrid = grid;
    const priority = photo => {
      const delta = photo._globalIndex - center, distance = Math.abs(delta);
      // Visible rows first, then more runway in the current direction. The
      // decoded LRU covers recently visited rows when direction reverses.
      return distance <= 6 ? distance - 100 : distance * (Math.sign(delta) === direction ? 0.5 : 1.5);
    };
    const ordered = photos.slice().sort((a,b) => priority(a)-priority(b));
    wanted = new Map();
    // Protect every mounted preview from eviction, but only read/decode the
    // viewport and nearby rows. Replace queued stale fling work immediately.
    for (const photo of photos) if (supports(photo)) wanted.set(photo, {grid});
    queue = [];
    for (const photo of ordered.slice(0, 32)) {
      if (!supports(photo)) continue;
      const url = get(photo);
      // The bounded raster surface clips offscreen cards. Browser lazy-loading
      // cannot prefetch those clipped rows, so explicitly warm this small,
      // nearest-first look-ahead window while retaining bounded decode work.
      if (url) update(photo, url, true);
      else if (!busy.has(photo) && Date.now() - (failures.get(photo) || 0) > 10000) queue.push(photo);
    }
    if (queue.length) { init(); pump(); }
    trim();
  }
  function handleError(img, id) {
    const isThumb = window.ArchiveSources?.isThumbnailUrl ? window.ArchiveSources.isThumbnailUrl(img.src) : img.src.startsWith('https://picshelf-thumbnails.invalid/');
    if (!isThumb) return false;
    const photo = [...wanted.keys()].find(p => p.id === id);
    if (!photo) return true;
    nativeFailures.add(photo);
    const target = wanted.get(photo);
    schedule([...wanted.keys()], target.grid, photo._globalIndex);
    return true;
  }
  function dispose() {
    queue = []; wanted.clear();
    for (const slot of workers) { slot.worker.terminate(); slot.photo = null; }
    workers.length = 0; busy.clear();
    for (const record of cache.values()) URL.revokeObjectURL(record.url);
    cache.clear(); bytes = 0;
    for (const record of decoded.values()) record.img.removeAttribute('src');
    decoded.clear(); decodedPixels = 0;
  }
  const session = { supports, get, schedule, handleError, register, retain, dispose,
    createSession: createGalleryThumbnailSession,
    stats: () => ({ cached: cache.size, bytes, queued: queue.length, active: busy.size, completed,
      decoded: decoded.size, decodedBytes: decodedPixels * 4 }) };
  // Organize previews use independent bounded sessions; they must not replace
  // the Gallery/Dock scheduler's wanted images or evict its mounted thumbnails.
  if (!window.GalleryThumbnails) window.GalleryThumbnails = session;
  return session;
})();
