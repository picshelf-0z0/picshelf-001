/* Durable library records and original files. UI/scroll state stays in app.js. */
(function () {
  'use strict';
  const DB_NAME = 'PicShelfLibraryDB';
  let dbPromise, running, requested = false, source;
  const PAGE_SIZE = 512;
  let savedAssets = new Set(), currentPages = [], revision = null, stagingAssets = null;
  let preparingFiles = 0;
  let mutationVersion = 0, committedVersion = 0, requestedAppend = null;
  const reservedAssets = new Set();
  let savedNativeSources = new Set();
  const status = { phase: 'idle', savedCount: 0, durability: 'unknown' };
  const blobIds = new WeakMap(), urlIds = new Map(), liveUrls = new Map();
  const unavailableLegacyUrls = new Set();
  // Timer clamping (especially after Android backgrounds the page) must not
  // delay a pending save by seconds. MessageChannel still yields to input.
  const tasks = [], channel = new MessageChannel();
  channel.port1.onmessage = () => tasks.shift()?.();
  const yieldTask = () => new Promise(resolve => { tasks.push(resolve); channel.port2.postMessage(null); });

  function open() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      let settled = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, keyPath] of [['photos', 'slot'], ['assets', 'id'], ['library', 'id'], ['pages', 'id']]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        }
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
        resolve(request.result);
      };
      request.onerror = () => { settled = true; dbPromise = null; reject(request.error); };
      request.onblocked = () => { settled = true; dbPromise = null; reject(new Error('Library upgrade is blocked by another open app window')); };
    });
    return dbPromise;
  }

  function complete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Library transaction aborted'));
      tx.onerror = () => {}; // onabort reports the failure; never acknowledge a request alone.
    });
  }

  function asset(blob, pending) {
    let id = blobIds.get(blob);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-${Math.random()}`;
      blobIds.set(blob, id);
    }
    if (!savedAssets.has(id) && !stagingAssets?.has(id)) pending.set(id, { id, blob });
    return id;
  }

  function encodePhoto(photo, pending) {
    const nativeId = photo.tarEntry?.nativeSourceId || photo.zipEntry?.nativeSourceId;
    const archived = !!nativeId || photo.tarEntry?.tarFile instanceof Blob || photo.zipEntry?.zipFile instanceof Blob;
    const copy = { ...photo };
    // A native source is durably journaled before these records are accepted.
    // Keep its small descriptor; never copy the archive into IndexedDB as well.
    for (const key of ['tarEntry', 'zipEntry']) {
      if (copy[key]?.nativeSourceId) {
        copy[key] = { ...copy[key] };
        delete copy[key].tarFile;
        delete copy[key].zipFile;
      }
    }
    // Virtual-window positions and in-flight work belong to this session.
    // Scrolling must not turn otherwise unchanged media into disk writes.
    delete copy._globalIndex;
    // Archive previews are disposable; the original archive is retained once,
    // shared by every entry. Never persist thousands of decoded preview copies.
    if (archived && !photo.lastEditedAt) {
      copy.fileBlob = null;
      for (const key of ['dataUrl', 'thumbUrl', 'videoUrl']) {
        if (typeof copy[key] === 'string' && (copy[key].startsWith('blob:') || copy[key].startsWith('https://picshelf-thumbnails.invalid/') || copy[key].startsWith('https://picshelf-originals.invalid/') || copy[key].startsWith('picshelf-thumbnails://local/') || copy[key].startsWith('picshelf-originals://local/'))) copy[key] = null;
      }
    }
    const jobs = [];
    function encode(value) {
      if (value instanceof Blob) return { __libraryAsset: asset(value, pending), kind: 'blob' };
      if (typeof value === 'string' && value.startsWith('blob:')) {
        // Old versions saved session URLs without their bytes. Keep those
        // records, without letting one already-lost source block migration.
        if (unavailableLegacyUrls.has(value)) return { __libraryUnavailableUrl: value };
        const id = urlIds.get(value);
        const reference = { __libraryAsset: id, kind: 'url' };
        if (!id || !savedAssets.has(id) && !stagingAssets?.has(id) && !pending.has(id)) {
          jobs.push((async () => {
            const response = await fetch(value);
            if (!response.ok) throw new Error('Could not retain an imported media file');
            reference.__libraryAsset = asset(await response.blob(), pending);
            urlIds.set(value, reference.__libraryAsset);
          })());
        }
        return reference;
      }
      if (!value || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
      if (value instanceof Promise || value instanceof Node) return undefined;
      if (Array.isArray(value)) return value.map(encode);
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        const encoded = encode(item);
        if (encoded !== undefined) result[key] = encoded;
      }
      return result;
    }
    // Playback uses the same bytes as fileBlob. Share that asset rather than
    // copying a video a second time just because it also has an object URL.
    if (copy.fileBlob instanceof Blob && copy.videoUrl?.startsWith('blob:')) {
      urlIds.set(copy.videoUrl, asset(copy.fileBlob, pending));
    }
    const encoded = encode(copy);
    return jobs.length ? Promise.all(jobs).then(() => encoded) : encoded;
  }

  function durableTransaction(db, stores) {
    let tx;
    try { tx = db.transaction(stores, 'readwrite', { durability: 'strict' }); }
    catch (error) {
      if (error.name !== 'TypeError' && error.name !== 'NotSupportedError') throw error;
      tx = db.transaction(stores, 'readwrite');
    }
    status.durability = tx.durability || 'default';
    return tx;
  }

  async function pageKey(rows) {
    if (!globalThis.crypto?.subtle) return 'unique:' + Date.now() + ':' + Math.random();
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return 'sha256:' + Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  }

  async function load() {
    const db = await open();
    status.phase = 'loading';
    const tx = db.transaction(['library', 'photos', 'assets', 'pages'], 'readonly');
    const done = complete(tx), assets = new Map(), photos = [], checks = [];
    let header, failure;
    const nativeSources = new Set();
    const fail = error => { failure = error; try { tx.abort(); } catch (_) {} };
    function decode(value) {
      if (!value || typeof value !== 'object') return value;
      if (typeof value.nativeSourceId === 'string') nativeSources.add(value.nativeSourceId);
      if (value.__libraryUnavailableUrl) {
        unavailableLegacyUrls.add(value.__libraryUnavailableUrl);
        return value.__libraryUnavailableUrl;
      }
      if (value.__libraryAsset) {
        const id = value.__libraryAsset, blob = assets.get(id);
        if (!(blob instanceof Blob)) throw new Error('Missing library file; saved data has been preserved');
        if (value.kind === 'blob') return blob;
        if (!liveUrls.has(id)) {
          const url = URL.createObjectURL(blob);
          liveUrls.set(id, url); urlIds.set(url, id);
        }
        return liveUrls.get(id);
      }
      // IndexedDB already returned detached objects. The page hash captures
      // its serialized bytes before decoding, so reuse this graph instead of
      // allocating another copy of every record and nested metadata object.
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item && typeof item === 'object') value[key] = decode(item);
      }
      return value;
    }
    // Requests are chained inside one read transaction: a concurrent writer
    // cannot remove pages while this reader is assembling the committed library.
    function readPhotos() {
      if (header.schema === 2) {
        // Keep a bounded request pipeline instead of a JS/IndexedDB round-trip
        // for every page. Restore into fixed slots to retain the exact order.
        let next = 0;
        photos.length = header.count;
        function requestPage() {
          if (next >= header.pages.length) return;
          const index = next++, key = header.pages[index], offset = index * PAGE_SIZE;
          const request = tx.objectStore('pages').get(key);
          request.onsuccess = () => {
            try {
              const rows = request.result?.rows;
              if (!Array.isArray(rows) || rows.length !== Math.min(PAGE_SIZE, header.count - offset)) throw new Error('Incomplete library page');
              if (key.startsWith('sha256:') && globalThis.crypto?.subtle) {
                checks.push(pageKey(rows).then(actual => { if (actual !== key) failure = new Error('Library integrity check failed'); }).catch(error => { failure = error; }));
              }
              for (let i = 0; i < rows.length; i++) photos[offset + i] = decode(rows[i]);
              requestPage();
            } catch (error) { fail(error); }
          };
        }
        for (let i = 0; i < Math.min(16, header.pages.length); i++) requestPage();
      } else {
        const request = tx.objectStore('photos').getAll(IDBKeyRange.lowerBound(photos.length), PAGE_SIZE);
        request.onsuccess = () => {
          try {
            for (const row of request.result) {
              if (row.slot !== photos.length) throw new Error('Invalid legacy library order');
              photos.push(decode(row.photo));
            }
            if (request.result.length === PAGE_SIZE) readPhotos();
          } catch (error) { fail(error); }
        };
      }
    }
    function readAssets(after) {
      const request = tx.objectStore('assets').getAll(after ? IDBKeyRange.lowerBound(after, true) : null, PAGE_SIZE);
      request.onsuccess = () => {
        try {
          for (const record of request.result) {
            if (!(record.blob instanceof Blob)) throw new Error('Invalid library file');
            assets.set(record.id, record.blob); blobIds.set(record.blob, record.id);
          }
          if (request.result.length === PAGE_SIZE) readAssets(request.result[PAGE_SIZE - 1].id);
          else readPhotos();
        } catch (error) { fail(error); }
      };
    }
    const request = tx.objectStore('library').get('current');
    request.onsuccess = () => {
      try {
        header = request.result;
        if (!header) {
          for (const name of ['photos', 'pages']) {
            const count = tx.objectStore(name).count();
            count.onsuccess = () => { if (count.result) fail(new Error('Library manifest missing; saved data has been preserved')); };
          }
          return;
        }
        if (![1, 2].includes(header.schema) || !Number.isSafeInteger(header.count) || header.count < 0 || !Array.isArray(header.tags) || !Array.isArray(header.deletedAlbums)) throw new Error('Invalid library manifest');
        if (header.schema === 2 && (header.pageSize !== PAGE_SIZE || !Array.isArray(header.pages) || header.pages.length !== Math.ceil(header.count / PAGE_SIZE))) throw new Error('Invalid library page index');
        readAssets();
      } catch (error) { fail(error); }
    };
    try {
      await done;
      await Promise.all(checks);
      if (failure) throw failure;
      if (!header) { revision = null; currentPages = []; savedAssets = new Set(); return null; }
      if (photos.length !== header.count) throw new Error('Incomplete library; saved data has been preserved');
      const restored = { photos, tags: decode(header.tags), deletedAlbums: decode(header.deletedAlbums), favoritesCustomCover: decode(header.favoritesCustomCover) };
      revision = header.revision || null;
      currentPages = header.schema === 2 ? header.pages : [];
      savedAssets = new Set(assets.keys());
      if (nativeSources.size && (!window.AndroidApp?.validateArchiveSources ||
          !window.AndroidApp.validateArchiveSources(JSON.stringify([...nativeSources])))) {
        throw new Error('Imported archive unavailable; saved library has been preserved');
      }
      savedNativeSources = nativeSources;
      if (window.AndroidApp?.retainArchiveSources) {
        const retainLoadedSources = async () => {
          const check = db.transaction('library', 'readonly'), checked = complete(check);
          const head = check.objectStore('library').get('current');
          await checked;
          // A second WebView may have committed after our read snapshot.
          // Never collect originals against that older snapshot.
          if ((head.result?.revision || null) === revision) {
            window.AndroidApp.retainArchiveSources(JSON.stringify([...nativeSources]));
          }
          if (nativeSources.size) window.AndroidApp.startArchiveCopies?.();
        };
        if (navigator.locks?.request) await navigator.locks.request(DB_NAME + ':writer', retainLoadedSources);
        else await retainLoadedSources();
      }
      status.savedCount = photos.length;
      return restored;
    } catch (error) { throw failure || error; }
    finally { status.phase = 'idle'; }
  }

  async function cleanup(db, newRevision, usedAssets, nativeSources) {
    // An archive being prepared must not be collected before its media records
    // are committed. Do not block unrelated metadata saves on that large copy.
    if (preparingFiles) return;
    if (navigator.locks?.request) {
      return navigator.locks.request(DB_NAME + ':prepared-files', { mode: 'exclusive', ifAvailable: true },
        lock => lock ? cleanupUnused(db, newRevision, usedAssets, nativeSources) : undefined);
    }
    return cleanupUnused(db, newRevision, usedAssets, nativeSources);
  }

  async function cleanupUnused(db, newRevision, usedAssets, nativeSources) {
    const tx = durableTransaction(db, ['library', 'assets', 'pages']);
    const done = complete(tx);
    let matched = false;
    const request = tx.objectStore('library').get('current');
    request.onsuccess = () => {
      if (request.result?.revision !== newRevision) return;
      matched = true;
      const keepPages = new Set(request.result.pages);
      // Bounded key reads also reclaim orphaned pages from an
      // interrupted staging pass. The committed pages are never removed.
      for (const [name, keep] of [['pages', keepPages], ['assets', usedAssets]]) {
        function sweep(after) {
          const keys = tx.objectStore(name).getAllKeys(after ? IDBKeyRange.lowerBound(after, true) : null, PAGE_SIZE);
          keys.onsuccess = () => {
            for (const key of keys.result) if (!keep.has(key)) tx.objectStore(name).delete(key);
            if (keys.result.length === PAGE_SIZE) sweep(keys.result[PAGE_SIZE - 1]);
          };
        }
        sweep();
      }
    };
    await done;
    if (matched && nativeSources) window.AndroidApp?.retainArchiveSources?.(JSON.stringify([...nativeSources]));
  }

  async function withPreparedFiles(files, callback) {
    const prepare = async () => {
      preparingFiles++;
      const pending = new Map(), ids = [];
      try {
        for (const file of files) {
          if (!(file instanceof Blob)) continue;
          const id = asset(file, pending);
          ids.push(id); reservedAssets.add(id);
        }
        const db = await open();
        // A transaction containing only originals leaves library/page writes
        // free to commit favorites, trash and album edits during the copy.
        if (pending.size) {
          const tx = durableTransaction(db, ['assets']), done = complete(tx);
          try {
            for (const record of pending.values()) if (!savedAssets.has(record.id)) tx.objectStore('assets').put(record);
          } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
          await done;
          for (const id of ids) savedAssets.add(id);
        }
        return await callback();
      } finally {
        preparingFiles--;
        if (!preparingFiles) reservedAssets.clear();
      }
    };
    return navigator.locks?.request
      ? navigator.locks.request(DB_NAME + ':prepared-files', { mode: 'shared' }, prepare)
      : prepare();
  }

  function markDirty() { mutationVersion++; }

  function captureAppend(current) {
    if (running || requested || committedVersion !== mutationVersion || current.photos.length !== status.savedCount) return null;
    return { photos: current.photos, count: status.savedCount, revision, version: mutationVersion };
  }

  async function write(current, appendHint) {
    const db = await open();
    const check = db.transaction('library', 'readonly');
    const checked = complete(check);
    const previous = check.objectStore('library').get('current');
    await checked;
    if ((previous.result?.revision || null) !== revision) throw new Error('The library changed in another app window; reopen before saving');
    const writeVersion = mutationVersion;
    const append = previous.result?.schema === 2 && appendHint &&
      appendHint.revision === revision && appendHint.version === mutationVersion &&
      committedVersion === mutationVersion && appendHint.photos === current.photos &&
      appendHint.count === status.savedCount && current.photos.length >= appendHint.count;
    // Import batches append records only. Reuse committed prefix pages unless
    // another action dirtied the library, in which case use the full checkpoint.
    const firstPage = append ? Math.floor(appendHint.count / PAGE_SIZE) : 0;
    const photos = current.photos.slice();
    let sliceStarted = performance.now();
    async function allowInput() {
      if (document.visibilityState !== 'hidden' && performance.now() - sliceStarted >= 8) {
        await yieldTask();
        sliceStarted = performance.now();
      }
    }
    function snapshot(value) {
      if (!value || typeof value !== 'object' || value instanceof Blob) return value;
      if (Array.isArray(value)) return value.map(snapshot);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
    }
    const albums = snapshot({ tags: current.tags, deletedAlbums: current.deletedAlbums || [], favoritesCustomCover: current.favoritesCustomCover || null });
    const pending = new Map(), usedAssets = append ? new Set(savedAssets) : new Set();
    const nativeSources = append ? new Set(savedNativeSources) : new Set();
    const pages = append ? currentPages.slice(0, firstPage) : [], staged = [];
    const expectedRevision = revision;
    stagingAssets = new Set();
    status.phase = 'staging';
    status.processed = 0;
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.nativeSourceId === 'string') nativeSources.add(value.nativeSourceId);
      if (value.__libraryAsset) { usedAssets.add(value.__libraryAsset); return; }
      for (const item of Object.values(value)) collect(item);
    }
    async function stage() {
      if (!staged.length && !pending.size) return;
      const stores = [];
      if (staged.length) stores.push('pages');
      if (pending.size) stores.push('assets');
      const tx = durableTransaction(db, stores);
      const done = complete(tx);
      try {
        for (const record of pending.values()) tx.objectStore('assets').put(record);
        for (const page of staged) tx.objectStore('pages').put(page);
      } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
      await done;
      for (const id of pending.keys()) stagingAssets.add(id);
      pending.clear(); staged.length = 0;
    }
    for (let offset = firstPage * PAGE_SIZE; offset < photos.length; offset += PAGE_SIZE) {
      const rows = [];
      const end = Math.min(offset + PAGE_SIZE, photos.length);
      for (let slot = offset; slot < end; slot++) {
        let row = encodePhoto(photos[slot], pending);
        if (row instanceof Promise) row = await row;
        collect(row); rows.push(row);
        if ((slot - offset + 1) % 32 === 0 && performance.now() - sliceStarted >= 8) await allowInput();
      }
      const id = await pageKey(rows);
      pages.push(id);
      if (currentPages[offset / PAGE_SIZE] !== id) staged.push({ id, rows });
      if (staged.length >= 8 || pending.size >= PAGE_SIZE) await stage();
      status.processed = end;
      await allowInput();
      // SHA-256 already yields off-thread per page. An additional message-port
      // task can be heavily throttled when Android/Chromium backgrounds us.
      if (!globalThis.crypto?.subtle && offset % (PAGE_SIZE * 8) === 0) await yieldTask();
    }
    const albumState = await encodePhoto(albums, pending);
    collect(albumState);
    await stage();
    const old = previous.result;
    if (old?.schema === 2 && pages.length === currentPages.length && pages.every((id, index) => id === currentPages[index]) &&
        JSON.stringify(albumState) === JSON.stringify({ tags: old.tags, deletedAlbums: old.deletedAlbums, favoritesCustomCover: old.favoritesCustomCover })) {
      // A previous process may have left staged pages behind before crashing.
      // Reclaim those even when this checkpoint has no user-data changes.
      await cleanup(db, expectedRevision, usedAssets, nativeSources);
      savedNativeSources = nativeSources;
      savedAssets = new Set([...usedAssets, ...[...reservedAssets].filter(id => savedAssets.has(id))]);
      committedVersion = writeVersion;
      stagingAssets = null;
      return;
    }
    status.phase = 'committing';
    const nextRevision = Date.now() + ':' + Math.random();
    const tx = durableTransaction(db, ['library', 'photos']);
    const done = complete(tx);
    let conflict = false;
    const head = tx.objectStore('library').get('current');
    head.onsuccess = () => {
      try {
        if ((head.result?.revision || null) !== expectedRevision) { conflict = true; tx.abort(); return; }
        tx.objectStore('library').put({ id: 'current', schema: 2, revision: nextRevision, count: photos.length, pageSize: PAGE_SIZE, pages, nativeSources: [...nativeSources], ...albumState });
        // v1 records are removed only in the same atomic commit that replaces
        // their manifest. Killing the app before this point leaves v1 readable.
        if (head.result?.schema === 1) tx.objectStore('photos').clear();
      } catch (_) { tx.abort(); }
    };
    try { await done; }
    catch (error) { throw conflict ? new Error('The library changed in another app window; reopen before saving') : error; }
    revision = nextRevision; currentPages = pages;
    savedNativeSources = nativeSources;
    status.savedCount = photos.length;
    committedVersion = writeVersion;
    status.phase = 'cleanup';
    try {
      // Obsolete tail pages are reclaimed by the next ordinary checkpoint.
      if (!append) await cleanup(db, nextRevision, usedAssets, nativeSources);
      savedAssets = new Set([...usedAssets, ...[...reservedAssets].filter(id => savedAssets.has(id))]);
    }
    catch (error) {
      // A completed manifest is still durable if optional cleanup is interrupted.
      for (const id of stagingAssets) savedAssets.add(id);
      console.warn('Library cleanup deferred:', error);
    }
    stagingAssets = null;
  }

  function save(getState, appendHint = null) {
    if (!appendHint) markDirty();
    source = getState;
    requestedAppend = appendHint;
    requested = true;
    if (!running) running = (async () => {
      try {
        while (requested) {
          requested = false;
          const hint = requestedAppend;
          requestedAppend = null;
          // Serialize staging, manifest replacement and cleanup across app
          // windows, so one writer cannot reclaim another writer's new files.
          if (navigator.locks?.request) await navigator.locks.request(DB_NAME + ':writer', () => write(source(), hint));
          else await write(source(), hint);
        }
      } catch (error) {
        // Append checkpoints intentionally skip markDirty(). If one fails,
        // retain retryable work even without a pending app save debounce.
        markDirty();
        throw error;
      } finally { stagingAssets = null; status.phase = 'idle'; }
    })().finally(() => { running = null; });
    return running;
  }

  function flush(getState) {
    // Lifecycle events also fire for the file picker. A clean library needs no
    // new checkpoint; any running checkpoint already represents admitted work.
    // Explicit mutations still use save(), including a pending app debounce.
    if (running) return running;
    if (mutationVersion !== committedVersion) return save(getState);
    return Promise.resolve();
  }

  async function inspectLegacyURLs(value) {
    const urls = new Set();
    function visit(item) {
      if (typeof item === 'string' && item.startsWith('blob:')) urls.add(item);
      else if (item && typeof item === 'object' && !(item instanceof Blob)) Object.values(item).forEach(visit);
    }
    visit(value);
    for (const url of urls) {
      try { const response = await fetch(url); if (!response.ok) throw new Error('Missing source'); }
      catch (_) { unavailableLegacyUrls.add(url); }
    }
    if (unavailableLegacyUrls.size) console.warn('Legacy media URLs whose bytes were not saved by the previous version:', unavailableLegacyUrls.size);
  }

  let lastErrorNotice = 0;
  function reportFailure() {
    if (Date.now() - lastErrorNotice < 10000) return;
    lastErrorNotice = Date.now();
    const messages = {
      en: 'Media storage failed. Keep the app open and check available device storage.',
      hi: 'मीडिया स्टोरेज में समस्या है। ऐप खुला रखें और डिवाइस में खाली जगह जाँचें।',
      bn: 'মিডিয়া স্টোরেজে সমস্যা হয়েছে। অ্যাপ খোলা রাখুন এবং ডিভাইসে খালি জায়গা পরীক্ষা করুন।',
      te: 'మీడియా నిల్వలో సమస్య వచ్చింది. యాప్‌ను తెరిచి ఉంచి, పరికరంలో ఖాళీ స్థలాన్ని తనిఖీ చేయండి.',
      ta: 'மீடியா சேமிப்பில் சிக்கல் ஏற்பட்டது. செயலியைத் திறந்து வைத்திருங்கள்; சாதனத்தில் காலி இடத்தைச் சரிபார்க்கவும்.',
      mr: 'मीडिया स्टोरेजमध्ये समस्या आली. ॲप उघडे ठेवा आणि डिव्हाइसमधील मोकळी जागा तपासा.',
      gu: 'મીડિયા સ્ટોરેજમાં સમસ્યા આવી. ઍપ ખુલ્લી રાખો અને ઉપકરણમાં ખાલી જગ્યા તપાસો.',
      kn: 'ಮಾಧ್ಯಮ ಸಂಗ್ರಹಣೆಯಲ್ಲಿ ಸಮಸ್ಯೆ ಉಂಟಾಗಿದೆ. ಆ್ಯಪ್ ತೆರೆದಿಡಿ ಮತ್ತು ಸಾಧನದಲ್ಲಿ ಖಾಲಿ ಜಾಗವನ್ನು ಪರಿಶೀಲಿಸಿ.',
      ml: 'മീഡിയ സംഭരണത്തിൽ പ്രശ്നമുണ്ടായി. ആപ്പ് തുറന്നുവെച്ച് ഉപകരണത്തിലെ ഒഴിവുള്ള സ്ഥലം പരിശോധിക്കുക.',
      pa: 'ਮੀਡੀਆ ਸਟੋਰੇਜ ਵਿੱਚ ਸਮੱਸਿਆ ਆਈ ਹੈ। ਐਪ ਖੁੱਲ੍ਹੀ ਰੱਖੋ ਅਤੇ ਡਿਵਾਈਸ ਵਿੱਚ ਖਾਲੀ ਥਾਂ ਜਾਂਚੋ।'
    };
    if (typeof window.showToast === 'function') window.showToast(messages[window.state?.language] || messages.en, 10000);
  }

  window.LibraryStore = { load, save, flush, markDirty, captureAppend, withPreparedFiles, inspectLegacyURLs, reportFailure,
    getStatus: () => ({ ...status, preparingFiles, pending: !!running || preparingFiles > 0 }) };
})();
