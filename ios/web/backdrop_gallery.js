/* Backdrop-only image picker: bounded DOM/previews and a full-library scrubber. */
(() => {
  'use strict';
  const STEP = 52, SEGMENT = 2048, BUFFER = 4, MAX_MOUNTED = 32, CHUNK = 8192;
  const rails = new WeakMap(), previewFailures = new WeakMap();
  const previewCache = new Map(), pendingOriginals = new WeakMap();
  const ownedOriginals = new Map(), ORIGINAL_CACHE_BYTES = 32 * 1024 * 1024;
  let selectedOriginal = null, ownedOriginalBytes = 0;
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><path fill="#94a3b8" opacity=".5" d="M8 10h28v24H8zm3 21h22L26 21l-6 7-4-5zm5-17a3 3 0 1 0 0 6 3 3 0 0 0 0-6"/></svg>');
  let indexCache = null;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

  function isImage(photo) {
    if (!photo || photo.deletedAt) return false;
    if (photo.mediaType) return photo.mediaType === 'image';
    const mime = photo.mimeType || photo.fileBlob?.type || '';
    const name = photo.originalFilename || photo.displayName || photo.name || photo.tarEntry?.baseName || photo.zipEntry?.baseName || '';
    if (/^(audio|video)\//i.test(mime) || /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|mid|midi|mp4|webm|mov|m4v|mkv|avi|3gp|wmv|flv|ts)$/i.test(name)) return false;
    return !photo.videoUrl && !photo.audioUrl && !/^data:(audio|video)\//i.test(photo.dataUrl || '');
  }
  function validUrl(url) { return typeof url === 'string' && !!url && url !== placeholder && url !== window.ZIP_PLACEHOLDER_DATA_URL; }
  function trimOriginals(current = null) {
    // Only the selected source and the original being delivered may exceed the
    // cache budget. Evicted previews are resolved again on a future mount.
    const protectedBytes = (ownedOriginals.get(selectedOriginal) || 0) +
      (current !== selectedOriginal ? ownedOriginals.get(current) || 0 : 0);
    for (const [old, size] of ownedOriginals) {
      if (ownedOriginals.size <= 128 && ownedOriginalBytes - protectedBytes <= ORIGINAL_CACHE_BYTES) break;
      if (old !== selectedOriginal && old !== current) {
        URL.revokeObjectURL(old); ownedOriginals.delete(old); ownedOriginalBytes -= size;
        for (const [photo, preview] of previewCache) if (preview === old) previewCache.delete(photo);
      }
    }
  }
  function retainOriginal(url, size) {
    ownedOriginals.set(url, size); ownedOriginalBytes += size;
    trimOriginals(url);
    return url;
  }
  function decode(url) {
    return new Promise((resolve, reject) => {
      if (!validUrl(url)) { reject(new Error('Image unavailable')); return; }
      const img = new Image();
      const timer = setTimeout(() => finish(false), 20000);
      let finished = false;
      function finish(ok) {
        if (finished) return;
        finished = true; clearTimeout(timer); img.onload = img.onerror = null;
        const loaded = ok && img.naturalWidth > 0 && img.naturalHeight > 0;
        img.removeAttribute('src');
        loaded ? resolve(url) : reject(new Error('Image unavailable'));
      }
      img.onload = () => finish(true); img.onerror = () => finish(false); img.src = url;
    });
  }
  async function resolveOriginal(photo) {
    if (!isImage(photo)) throw new Error('Image unavailable');
    if (pendingOriginals.has(photo)) return pendingOriginals.get(photo);
    const task = (async () => {
      // A native archive URL is durable; a previously hydrated blob/thumbnail
      // URL may have been revoked. Never use the preview endpoint as an original.
      const native = !photo.lastEditedAt && window.ArchiveSources?.originalUrl(photo);
      if (native) return decode(native);
      const isThumbUrl = window.ArchiveSources?.isThumbnailUrl ? window.ArchiveSources.isThumbnailUrl(photo.dataUrl) : photo.dataUrl.startsWith('https://picshelf-thumbnails.invalid/');
      if (validUrl(photo.dataUrl) && !isThumbUrl) {
        try { return await decode(photo.dataUrl); } catch (_) {}
      }
      // Archive/fileBlob sources can still contain the unedited original.
      // A broken edited image must not silently replace the chosen edit.
      if (photo.lastEditedAt) throw new Error('Edited image unavailable');
      if (photo.fileBlob instanceof Blob) {
        const url = URL.createObjectURL(photo.fileBlob);
        try {
          await decode(url);
          // Selected background URLs outlive the Gallery's thumbnail LRU.
          return retainOriginal(url, photo.fileBlob.size);
        } catch (error) { URL.revokeObjectURL(url); throw error; }
      }
      if (photo.tarEntry || photo.zipEntry) {
        // Resolve from entry bytes, not a stale cached thumbnail. Hydration of
        // this one temporary record cannot reclassify or reorganize the library.
        const input = { ...photo, dataUrl: null, thumbUrl: null, _resolvingPromise: null };
        const url = await window.resolveZipPhotoDataUrl?.(input);
        // The shared resolver tracks its own URL; retain a separate URL for the
        // editor when it supplies an original Blob, without changing the photo.
        if (input.fileBlob instanceof Blob) {
          const owned = URL.createObjectURL(input.fileBlob);
          try { await decode(owned); return retainOriginal(owned, input.fileBlob.size); }
          catch (error) { URL.revokeObjectURL(owned); throw error; }
        }
        return decode(url);
      }
      return decode(photo.dataUrl);
    })();
    pendingOriginals.set(photo, task);
    try { return await task; } finally { pendingOriginals.delete(photo); }
  }

  function indexFor(options) {
    const views = window.LibraryViews?.get(options.state);
    const source = views?.active || options.state.photos || [];
    const revision = views?.revision;
    const includePending = options.includePending !== false;
    if (indexCache && indexCache.source === source && indexCache.sourceLength === source.length &&
        indexCache.revision === revision && indexCache.activeId === options.activePhotoId &&
        indexCache.includePending === includePending) return indexCache;
    const entry = { source, sourceLength: source.length, revision, activeId: options.activePhotoId,
      includePending, positions: new Uint32Array(source.length), count: 0, complete: false, listeners: new Set(), scanned: 0 };
    indexCache = entry;
    entry.ready = (async () => {
      // Yield before the first scan so the Backdrop panel opens immediately.
      await pause();
      while (entry.scanned < entry.sourceLength && indexCache === entry) {
        const end = Math.min(entry.sourceLength, entry.scanned + CHUNK);
        for (; entry.scanned < end; entry.scanned++) {
          const photo = source[entry.scanned];
          if (isImage(photo) && (includePending || !photo.isPending) && photo.id !== entry.activeId) entry.positions[entry.count++] = entry.scanned;
        }
        for (const update of entry.listeners) update();
        if (entry.scanned < entry.sourceLength) await pause();
      }
      entry.complete = entry.scanned === entry.sourceLength;
      for (const update of entry.listeners) update();
      return entry;
    })();
    return entry;
  }

  class Rail {
    constructor(container) {
      this.container = container; this.cards = new Map(); this.segmentStart = 0; this.generation = 0;
      this.fallbacks = []; this.activeFallbacks = 0; this.selectSequence = 0;
      this.session = window.GalleryThumbnails?.createSession() || null;
      container.textContent = ''; container.dataset.backdropRail = ''; container.setAttribute('role', 'list');
      this.track = document.createElement('div'); this.track.className = 'backdrop-gallery-track'; container.appendChild(this.track);
      this.controls = document.createElement('div'); this.controls.className = 'backdrop-gallery-controls';
      this.slider = document.createElement('input'); this.slider.type = 'range'; this.slider.min = '0'; this.slider.step = '1'; this.slider.value = '0';
      this.slider.className = 'backdrop-gallery-scrubber';
      this.status = document.createElement('span'); this.status.className = 'backdrop-gallery-position';
      this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('aria-atomic', 'true');
      this.controls.append(this.slider, this.status); container.after(this.controls);
      container._cardMap = this.cards;
      this.onScroll = () => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); }); };
      this.onInput = () => this.go(Number(this.slider.value));
      this.onKey = event => {
        const button = event.target.closest?.('[data-backdrop-index]'); if (!button) return;
        let index = Number(button.dataset.backdropIndex);
        if (event.key === 'ArrowRight') index++;
        else if (event.key === 'ArrowLeft') index--;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = this.index.count - 1;
        else return;
        event.preventDefault(); index = clamp(index, 0, this.index.count - 1);
        const first = this.first(), visible = this.visible();
        if (index < first || index >= first + visible) this.go(index < first ? index : index - visible + 1);
        this.paint(); this.track.querySelector(`[data-backdrop-index="${index}"]`)?.focus({ preventScroll: true });
      };
      container.addEventListener('scroll', this.onScroll, { passive: true });
      container.addEventListener('keydown', this.onKey); this.slider.addEventListener('input', this.onInput);
      this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.paint()) : null;
      this.resize?.observe(container);
    }
    visible() { return Math.max(1, Math.min(MAX_MOUNTED - BUFFER * 2, Math.ceil((this.container.clientWidth || 320) / STEP))); }
    maximum() { return Math.max(0, (this.index?.count || 0) - this.visible()); }
    first() { return clamp(this.segmentStart + Math.floor(Math.max(0, this.container.scrollLeft) / STEP), 0, this.maximum()); }
    at(index) { return this.index.source[this.index.positions[index]]; }
    text(key, ...args) { const value = this.options.labels?.[key]; return typeof value === 'function' ? value(...args) : value || ''; }
    render(options) {
      this.options = options;
      const next = indexFor(options);
      if (this.index !== next) {
        this.index?.listeners.delete(this.update);
        this.generation++; this.selectSequence++; this.segmentStart = 0; this.container.scrollLeft = 0;
        this.index = next; this.update = () => this.paint(); next.listeners.add(this.update);
        for (const card of this.cards.values()) card.remove(); this.cards.clear(); this.fallbacks = [];
      }
      this.slider.setAttribute('aria-label', this.text('scroll'));
      this.container.setAttribute('aria-label', this.text('scroll'));
      this.paint(); return next.ready;
    }
    go(value) {
      const first = clamp(Math.round(value) || 0, 0, this.maximum());
      this.segmentStart = clamp(first - Math.floor(SEGMENT / 2), 0, Math.max(0, this.index.count - SEGMENT));
      this.sizeTrack(); this.container.scrollLeft = (first - this.segmentStart) * STEP; this.paint();
    }
    sizeTrack() {
      const length = Math.min(SEGMENT, Math.max(0, this.index.count - this.segmentStart));
      this.track.style.width = Math.max(this.container.clientWidth || 0, length * STEP + 8) + 'px';
    }
    paint() {
      if (this.disposed || !this.index) return;
      this.sizeTrack();
      let first = this.first();
      const relative = first - this.segmentStart;
      if ((relative < 32 && this.segmentStart > 0) || (relative > SEGMENT - this.visible() - 32 && this.segmentStart + SEGMENT < this.index.count)) {
        const remainder = Math.max(0, this.container.scrollLeft) % STEP;
        this.segmentStart = clamp(first - Math.floor(SEGMENT / 2), 0, Math.max(0, this.index.count - SEGMENT));
        this.sizeTrack(); this.container.scrollLeft = (first - this.segmentStart) * STEP + remainder;
      }
      const start = Math.max(0, first - BUFFER), end = Math.min(this.index.count, first + this.visible() + BUFFER);
      const wanted = new Set(), mounted = [];
      for (let index = start; index < end; index++) {
        const photo = this.at(index); if (!photo) continue;
        wanted.add(photo.id); mounted.push(photo);
        let card = this.cards.get(photo.id);
        if (!card) { card = this.createCard(photo); this.cards.set(photo.id, card); this.track.appendChild(card); }
        card.dataset.backdropIndex = String(index); card.style.left = ((index - this.segmentStart) * STEP + 4) + 'px';
        card.tabIndex = index === first ? 0 : -1;
        card.title = this.text('use', photo.displayName || photo.name || this.text('alt'));
        card.setAttribute('aria-label', card.title);
        const selected = !!this.options.selectedUrl && (this.selectedId ? this.selectedId === photo.id && this.options.selectedUrl === this.selectedUrl : this.options.selectedUrl === photo.dataUrl);
        card.classList.toggle('active', selected); card.setAttribute('aria-pressed', String(selected));
        card.querySelector('img').alt = this.text('alt');
      }
      for (const [id, card] of this.cards) if (!wanted.has(id)) { card.querySelector('img')?.removeAttribute('src'); card.remove(); this.cards.delete(id); }
      this.session?.schedule(mounted.filter(photo => !previewFailures.has(photo)), this.container, mounted[0]?._globalIndex || 0);
      this.slider.max = String(this.maximum()); this.slider.value = String(first);
      this.slider.disabled = !this.index.complete || this.maximum() === 0;
      this.container.setAttribute('aria-busy', String(!this.index.complete));
      const status = !this.index.complete ? this.text('loading') : !this.index.count ? this.text('empty') :
        this.text('position', first + 1, Math.min(this.index.count, first + this.visible()), this.index.count);
      if (!this.selectionBusy) this.setStatus(status);
      this.slider.setAttribute('aria-valuetext', status);
      this.pump();
    }
    setStatus(text) { if (this.status.textContent !== text) this.status.textContent = text; }
    createCard(photo) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'backdrop-gallery-thumb'; card.draggable = true;
      card.dataset.id = String(photo.id); card.setAttribute('role', 'listitem');
      const img = document.createElement('img'); img.decoding = 'async'; img.loading = 'eager'; card.appendChild(img);
      let retried = false;
      img.onload = () => { if (img.getAttribute('src') !== placeholder) { card.classList.remove('backdrop-gallery-failed'); previewFailures.delete(photo); } };
      const fallback = () => {
        if (retried || this.disposed) return; retried = true;
        img.src = placeholder;
        this.fallbacks.push({ photo, img, card, generation: this.generation });
        // New cards are attached by paint() after createCard returns.
        Promise.resolve().then(() => this.pump());
      };
      img.onerror = () => { this.session?.handleError(img, photo.id); fallback(); };
      const preview = this.session?.supports(photo) ? this.session.get(photo) || window.GalleryThumbnails?.get(photo) :
        (validUrl(photo.thumbUrl) ? photo.thumbUrl : validUrl(photo.dataUrl) ? photo.dataUrl : null);
      const cached = previewCache.get(photo);
      img.src = preview || cached || placeholder;
      if (previewFailures.has(photo)) { retried = true; card.classList.add('backdrop-gallery-failed'); img.src = placeholder; }
      else if (!preview && !cached && !this.session?.supports(photo)) fallback();
      card.addEventListener('dragstart', event => { event.dataTransfer?.setData('text/plain', String(photo.id)); });
      card.addEventListener('click', async () => {
        this.options.onSelectionStart?.();
        const selection = ++this.selectSequence, generation = this.generation;
        this.selectionBusy = true; this.setStatus(this.text('loading')); card.setAttribute('aria-busy', 'true');
        try {
          const url = await resolveOriginal(photo);
          if (this.disposed || generation !== this.generation || selection !== this.selectSequence || this.options.isCurrent?.() === false) return;
          this.selectedId = photo.id; this.selectedUrl = url; selectedOriginal = url;
          previewFailures.delete(photo); img.src = url;
          this.options.onSelect?.(url, photo); this.options.selectedUrl = url;
          this.selectionBusy = false; this.paint();
        } catch (_) {
          if (!this.disposed && selection === this.selectSequence && this.options.isCurrent?.() !== false) {
            this.selectionBusy = false; this.setStatus(this.text('unavailable')); this.options.onError?.(this.text('unavailable'));
          }
        } finally { card.removeAttribute('aria-busy'); if (selection === this.selectSequence) this.selectionBusy = false; }
      });
      return card;
    }
    pump() {
      while (!this.disposed && this.activeFallbacks < 2 && this.fallbacks.length) {
        const job = this.fallbacks.shift();
        if (!job.img.isConnected || job.generation !== this.generation) continue;
        this.activeFallbacks++;
        resolveOriginal(job.photo).then(url => {
          if (!this.disposed && job.img.isConnected && job.generation === this.generation) {
            previewCache.delete(job.photo); previewCache.set(job.photo, url);
            while (previewCache.size > 64) previewCache.delete(previewCache.keys().next().value);
            job.img.src = url;
          }
        }).catch(() => {
          previewFailures.set(job.photo, true);
          if (job.img.isConnected) { job.card.classList.add('backdrop-gallery-failed'); job.img.src = placeholder; }
        }).finally(() => { this.activeFallbacks--; this.pump(); });
      }
    }
    dispose() {
      this.disposed = true; this.selectSequence++; this.index?.listeners.delete(this.update);
      if (indexCache === this.index && !this.index.complete && !this.index.listeners.size) indexCache = null;
      cancelAnimationFrame(this.frame); this.resize?.disconnect(); this.fallbacks = []; this.session?.dispose();
      this.container.removeEventListener('scroll', this.onScroll); this.container.removeEventListener('keydown', this.onKey);
      this.slider.removeEventListener('input', this.onInput); this.controls.remove(); this.container.textContent = '';
      this.cards.clear(); delete this.container._cardMap; delete this.container.dataset.backdropRail;
    }
    cancelSelection() { this.selectSequence++; this.selectionBusy = false; this.paint(); }
    setSelected(url) {
      this.selectSequence++; this.selectionBusy = false;
      if (this.selectedUrl !== url) this.selectedId = null;
      this.selectedUrl = url; this.options.selectedUrl = url; this.paint();
    }
  }
  window.PicShelfBackdropGallery = Object.freeze({
    render(options) { let rail = rails.get(options.container); if (!rail) { rail = new Rail(options.container); rails.set(options.container, rail); } return rail.render(options); },
    dispose(container) { const rail = rails.get(container); if (rail) { rail.dispose(); rails.delete(container); } },
    resolve: resolveOriginal,
    isImage,
    setSelected(container, url) { selectedOriginal = url || null; trimOriginals(); rails.get(container)?.setSelected(url); },
    cancelSelection(container) { rails.get(container)?.cancelSelection(); },
    // Deterministic navigation also serves keyboard/accessibility and regression checks.
    scrollTo(container, index) { rails.get(container)?.go(index); },
    stats(container) { const r = rails.get(container); return r ? { count: r.index.count, complete: r.index.complete,
      first: r.first(), mounted: r.cards.size, physicalWidth: r.track.offsetWidth, scanned: r.index.scanned } : null; }
  });
})();
