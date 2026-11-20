/* Deferred metadata reads. Import/indexing and visible media decoding always take priority. */
(() => {
  'use strict';
  const VERSION = 2, MAX_PENDING = 48, MAX_PREFIX = 2 * 1024 * 1024;
  const jobs = new Map(), checked = new WeakMap();
  let failures = new WeakMap();
  const sessionSources = new WeakMap();
  let active = null, timer = null, saveTimer = null, dirty = false, importBusy = false;
  let epoch = 0, cursor = 0, sweepSource = null, sweeping = false, sweepTimer = null;
  let extractBuffer = null, onChanged = null;
  const state = () => window.state;
  const enabled = () => state()?.gpsMetadataEnabled !== false;
  function blocked() {
    const storage = window.LibraryStore?.getStatus?.();
    const video = document.getElementById('detailVideo');
    return importBusy || typeof window._onNativeTarBatch === 'function' ||
      typeof window._onNativeZipBatch === 'function' || document.hidden ||
      document.body?.classList.contains('is-scrolling') ||
      (video && !video.paused && !video.ended && video.style.display !== 'none') ||
      !!storage?.preparingFiles || !!storage?.pending;
  }
  function info(photo) {
    try { return window.ArchiveSources?.entryInfo(photo) || null; } catch (_) { return null; }
  }
  function signature(photo) {
    const source = info(photo);
    if (source) return `${VERSION}:${source.token}:${source.kind}:${source.offset}:${source.size}:${source.method}`;
    return photo.fileBlob || photo.tarEntry?.tarFile || photo.zipEntry?.zipFile || photo.originalDataUrl || photo.dataUrl || null;
  }
  function canRead(photo) {
    return !!photo?.id && !photo.deletedAt && !!signature(photo) &&
      !/^(demo_|model_|gallery_|gps_sample_)/.test(String(photo.id));
  }
  function eligible(photo) {
    if (!enabled() || !canRead(photo)) return false;
    const key = signature(photo);
    const missingNames = photo.location && ['place', 'city', 'country'].some(name => !photo.location[name]);
    const journalNames = window.MediaMetadataCache && missingNames && photo.metadataReadSource === key;
    return checked.get(photo) !== key && (photo.metadataReadSource !== key || journalNames) &&
      Date.now() - (failures.get(photo) || 0) > 30000;
  }
  function markChanged() {
    dirty = true;
    // An unrelated app save may commit between metadata results. Advance the
    // mutation version for every changed record so lifecycle flushes see it.
    window.LibraryStore?.markDirty?.();
    if (saveTimer) return;
    saveTimer = setTimeout(function flushMetadata() {
      saveTimer = null;
      if (!dirty) return;
      if (blocked()) { saveTimer = setTimeout(flushMetadata, 5000); return; }
      dirty = false;
      // Location/camera metadata does not change album membership or card ordering.
      window.saveState?.(true);
    }, 60000);
  }
  function coords(value, keepNames = false) {
    const latitude = value?.latitude, longitude = value?.longitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    const result = { latitude, longitude,
      displayCoords: `${Math.abs(latitude).toFixed(4)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? 'E' : 'W'}`,
      place: '', city: '', country: '' };
    if (keepNames) for (const name of ['place', 'city', 'country']) {
      if (typeof value[name] === 'string') result[name] = value[name].trim().slice(0, 256);
    }
    return result;
  }
  function durableKey(photo, source = signature(photo)) {
    return typeof source === 'string' && info(photo) ? `${photo.id}|${source}` : null;
  }
  function current(job) {
    const p = job.photo;
    return !importBusy && !job.controller.signal.aborted && enabled() && job.epoch === epoch && p.id === job.id &&
      state()?.photos === job.library && !p.deletedAt && signature(p) === job.key && p.location === job.location;
  }
  async function persistLocation(photo) {
    if (!photo?.id) return false;
    const key = durableKey(photo), location = coords(photo?.location, true);
    if (!key || !location || !enabled() || !window.MediaMetadataCache) return false;
    const source = signature(photo), originalLocation = photo.location, generation = epoch;
    try {
      const saved = await window.MediaMetadataCache.put(key, {status: 'ok', location,
        cameraModel: photo.cameraModel, createdAt: photo.createdAt});
      return saved === true && enabled() && generation === epoch && signature(photo) === source && photo.location === originalLocation;
    } catch (_) { return false; }
  }
  async function prefixBlob(photo) {
    if (photo.fileBlob instanceof Blob) return photo.fileBlob.slice(0, MAX_PREFIX);
    const tar = photo.tarEntry;
    if (tar?.tarFile instanceof Blob) return tar.tarFile.slice(tar.offset, tar.offset + Math.min(tar.size, MAX_PREFIX));
    const zip = photo.zipEntry;
    if (zip?.zipFile instanceof Blob) {
      const h = new DataView(await zip.zipFile.slice(zip.localOffset, zip.localOffset + 30).arrayBuffer());
      if (h.byteLength !== 30 || h.getUint32(0, true) !== 0x04034b50) return null;
      const start = zip.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      if (zip.method === 0) return zip.zipFile.slice(start, start + Math.min(zip.compSize, MAX_PREFIX));
      // Compressed archives use the native metadata endpoint. Never inflate an
      // arbitrarily large entry on the WebView thread just to inspect metadata.
      return null;
    }
    return null;
  }
  function sessionInfo(photo) {
    const entry = photo.tarEntry || photo.zipEntry;
    const archive = entry?.tarFile || entry?.zipFile;
    const file = archive || photo.fileBlob;
    if (!(file instanceof Blob) || !file.name || !window.AndroidApp?.registerThumbnailArchive) return null;
    // A session File may not have a durable descriptor (some document providers
    // do not grant persistence). Resolve its picker-authorized URI only when the
    // idle queue actually reads it, never while rendering or importing.
    if (!sessionSources.has(file)) {
      let token = '';
      try { token = window.AndroidApp.registerThumbnailArchive(file.name, file.size) || ''; } catch (_) {}
      sessionSources.set(file, token);
    }
    const token = sessionSources.get(file);
    if (!token) return null;
    const zip = !!(archive && photo.zipEntry);
    const offset = archive ? (zip ? entry.localOffset : entry.offset) : 0;
    const size = archive ? (zip ? entry.compSize : entry.size) : file.size;
    const method = zip ? entry.method : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 ||
        !(method === 0 || (zip && method === 8))) return null;
    const name = entry?.baseName || entry?.fn || file.name;
    const type = {mp4:'video/mp4',m4v:'video/x-m4v',mov:'video/quicktime',webm:'video/webm',
      mkv:'video/x-matroska','3gp':'video/3gpp',mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',
      wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg',opus:'audio/opus',jpg:'image/jpeg',
      jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',avif:'image/avif'}[name.split('.').pop().toLowerCase()];
    const length = zip ? entry.uncompSize : size;
    return {token, kind:zip ? 'zip' : 'tar', offset, size, method,
      mime:type || (!archive && file.type) || 'application/octet-stream',
      length:Number.isSafeInteger(length) && length >= 0 ? length : null};
  }
  async function readBmff(job) {
    const photo = job.photo, entry = photo.tarEntry || photo.zipEntry;
    const name = entry?.baseName || entry?.fn || photo.originalFilename || photo.displayName || photo.fileBlob?.name || '';
    if (!window.MediaMetadataBMFF || !(photo.mediaType === 'video' || photo.mediaType === 'audio' ||
        /\.(mp4|m4a|m4v|mov|3gp)$/i.test(name))) return null;
    let blob = photo.fileBlob;
    if (!(blob instanceof Blob) && photo.tarEntry?.tarFile instanceof Blob) {
      const e = photo.tarEntry; blob = e.tarFile.slice(e.offset, e.offset + e.size);
    } else if (!(blob instanceof Blob) && photo.zipEntry?.zipFile instanceof Blob && photo.zipEntry.method === 0) {
      const e = photo.zipEntry, h = new DataView(await e.zipFile.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
      if (h.byteLength !== 30 || h.getUint32(0, true) !== 0x04034b50) return null;
      const start = e.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      blob = e.zipFile.slice(start, start + e.compSize);
    }
    return blob instanceof Blob ? window.MediaMetadataBMFF.read(blob, { signal: job.controller.signal }) : null;
  }
  async function read(job) {
    if (job.cacheKey && window.MediaMetadataCache) {
      try {
        const cached = await window.MediaMetadataCache.get(job.cacheKey, {signal: job.controller.signal});
        if (cached && ['ok', 'unsupported'].includes(cached.status)) { job.cacheHit = true; return cached; }
      } catch (error) { if (job.controller.signal.aborted) throw error; }
      if (!current(job)) return null;
    }
    // A catalog checkpoint can contain coordinates before a later name lookup.
    // Read that journal once per session; never re-read its original media.
    if (job.cacheOnly) return null;
    const source = info(job.photo) || sessionInfo(job.photo);
    if (source) {
      const thumbsOrigin = window.ArchiveSources?.thumbnailsOrigin || 'https://picshelf-thumbnails.invalid/';
      const url = `${thumbsOrigin}${encodeURIComponent(source.token)}/metadata-${source.kind}/${source.offset}/${source.size}/${source.method}?type=${encodeURIComponent(source.mime)}${source.length == null ? '' : `&length=${source.length}`}`;
      const timeout = setTimeout(() => job.controller.abort(), 10000);
      try {
        const response = await fetch(url, { signal: job.controller.signal });
        if (!response.ok) throw Error('Metadata source unavailable');
        const result = await response.json();
        if (!result || !['ok', 'unsupported'].includes(result.status)) throw Error('Invalid metadata response');
        if (result.status === 'unsupported' || !coords(result.location)) {
          const fallback = await readBmff(job);
          if (fallback?.location) return { ...result, ...fallback };
        }
        return result;
      } finally { clearTimeout(timeout); }
    }
    const bmff = await readBmff(job);
    if (bmff) return bmff;
    if (typeof extractBuffer !== 'function') return null;
    const blob = await prefixBlob(job.photo);
    if (!blob) return null;
    const result = extractBuffer(await blob.arrayBuffer());
    return { status: 'ok', location: result?.coords || null,
      createdAt: result?.timestamp || null, cameraModel: result?.cameraModel || null };
  }
  function schedulePump(delay = 0) {
    if (timer || active || !jobs.size || !enabled()) return;
    timer = setTimeout(() => { timer = null; pump(); }, delay);
  }
  async function pump() {
    if (active || !enabled() || !jobs.size) return;
    if (blocked()) { schedulePump(500); return; }
    const job = jobs.values().next().value;
    jobs.delete(job.photo);
    if (!eligible(job.photo)) { job.resolve(false); schedulePump(); return; }
    active = job;
    try {
      const result = await read(job);
      const p = job.photo;
      if (!result && job.cacheOnly && current(job)) checked.set(p, job.key);
      // A setting change, a different library, edit, deletion, or a user-entered
      // location while the read was pending must win over this background result.
      if (!result || !current(job)) { job.resolve(false); return; }
      // Commit the small source-specific record before exposing its coordinates.
      // This avoids making the entire catalog dirty or delaying the next import.
      let journaled = !!job.cacheHit;
      if (!journaled && job.cacheKey && window.MediaMetadataCache) {
        try { journaled = await window.MediaMetadataCache.put(job.cacheKey, result, {signal: job.controller.signal}) === true; }
        catch (_) { /* An unavailable journal falls back to ordinary persistence. */ }
      }
      if (!current(job)) { job.resolve(false); return; }
      checked.set(p, job.key);
      let changed = false, markerChanged = false;
      const location = coords(result.location, !!job.cacheHit);
      if (!p.location && location) { p.location = location; changed = true; }
      else if (job.cacheHit && location && p.location?.latitude === location.latitude && p.location?.longitude === location.longitude) {
        for (const name of ['place', 'city', 'country']) {
          if (!p.location[name] && location[name]) { p.location[name] = location[name]; changed = true; }
        }
      }
      if (!p.cameraModel && typeof result.cameraModel === 'string' && result.cameraModel.trim()) {
        p.cameraModel = result.cameraModel.trim().slice(0, 256); changed = true;
      }
      if (!p.createdAt && Number.isFinite(result.createdAt) && result.createdAt > 0) { p.createdAt = result.createdAt; changed = true; }
      // Persist completion for durable sources, including metadata-free files.
      // This prevents re-reading a million unchanged originals on every restart.
      if (typeof job.key === 'string' && info(p) && p.metadataReadSource !== job.key) {
        p.metadataReadSource = job.key; markerChanged = true;
      }
      if ((changed || markerChanged) && !journaled) markChanged();
      if (changed) (onChanged || window.refreshMediaLocationUI)?.(p);
      job.resolve(changed);
    } catch (_) {
      if (!job.controller.signal.aborted) failures.set(job.photo, Date.now());
      job.resolve(false);
    }
    finally { active = null; schedulePump(50); }
  }
  function request(photo, background = false) {
    if (!eligible(photo)) return Promise.resolve(false);
    if (active?.photo === photo) return active.promise;
    const existing = jobs.get(photo);
    if (existing) {
      if (!background) jobs.delete(photo);
      if (!background) { const rest = [...jobs]; jobs.clear(); jobs.set(photo, existing); for (const [p, j] of rest) jobs.set(p, j); }
      return existing.promise;
    }
    if (jobs.size >= MAX_PENDING) return Promise.resolve(false);
    let resolve; const promise = new Promise(r => { resolve = r; });
    const job = { photo, id: photo.id, promise, resolve, key: signature(photo), cacheKey: durableKey(photo), location: photo.location,
      library: state()?.photos, epoch, controller: new AbortController() };
    job.cacheOnly = photo.metadataReadSource === job.key;
    if (!background && jobs.size) { const rest = [...jobs]; jobs.clear(); jobs.set(photo, job); for (const [p, j] of rest) jobs.set(p, j); }
    else jobs.set(photo, job);
    schedulePump(100);
    return promise;
  }
  function schedule(photos) {
    if (!enabled() || !photos) return;
    for (let i = 0; i < Math.min(photos.length, MAX_PENDING); i++) request(photos[i]);
  }
  function sweep() {
    sweepTimer = null;
    if (!sweeping || !enabled()) return;
    const photos = state()?.photos;
    if (photos !== sweepSource) { sweepSource = photos; cursor = 0; }
    if (!blocked() && Array.isArray(photos) && jobs.size < MAX_PENDING && !active) {
      for (let i = 0; i < 32 && cursor < photos.length; i++) {
        const photo = photos[cursor++];
        if (eligible(photo)) { request(photo, true); break; }
      }
    }
    if (!photos || cursor < photos.length || blocked()) sweepTimer = setTimeout(sweep, 500);
    else sweeping = false;
  }
  function startSweep() {
    if (!enabled()) return;
    sweeping = true;
    if (!sweepTimer) sweepTimer = setTimeout(sweep, 1000);
  }
  function onSettingsChanged() {
    epoch++;
    failures = new WeakMap();
    active?.controller.abort();
    for (const job of jobs.values()) job.resolve(false);
    jobs.clear(); clearTimeout(timer); timer = null;
    clearTimeout(sweepTimer); sweepTimer = null; sweeping = false;
    if (enabled()) { cursor = 0; startSweep(); }
  }
  function setImportBusy(value) {
    importBusy = !!value;
    if (importBusy) active?.controller.abort();
    if (!importBusy) { schedulePump(); startSweep(); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedulePump(); if (sweeping) startSweep(); } });
  window.MediaMetadata = { request, schedule, startSweep, onSettingsChanged, setImportBusy, persistLocation,
    configure(options = {}) { extractBuffer = options.extractBuffer || extractBuffer; onChanged = options.onChanged || onChanged; },
    stats: () => ({ active: active ? 1 : 0, pending: jobs.size, cursor, sweeping, importBusy, dirty }) };
})();
