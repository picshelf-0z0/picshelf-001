/* Small, cancellable filmstrip previews. This decoder never touches the player. */
(function () {
  'use strict';
  const FRAME_COUNT = 8;
  const FRAME_WIDTH = 160;
  const FRAME_HEIGHT = 90;
  const MAX_BYTES = 3 * 1024 * 1024;
  const MAX_ENTRIES = 3;
  const sessions = new WeakMap();
  const active = new Set();
  const cache = new Map();
  let cacheBytes = 0;

  function alive(session) {
    if (session.cancelled || sessions.get(session.container) !== session) return false;
    try { return !session.options.isCurrent || session.options.isCurrent(); }
    catch (_) { return false; }
  }

  function playing(session) {
    const player = session.options.player;
    return !!player && !player.paused && !player.ended;
  }

  function mayDecode(session) {
    return alive(session) && !session.interrupted && !playing(session);
  }

  function removeEntry(key, entry) {
    entry.frames.forEach(frame => {
      if (frame) { URL.revokeObjectURL(frame.url); cacheBytes -= frame.bytes; }
    });
    cache.delete(key);
  }

  function trimCache() {
    for (const [key, entry] of cache) {
      if (cache.size <= MAX_ENTRIES && cacheBytes <= MAX_BYTES) break;
      if (![...active].some(session => session.entry === entry)) removeEntry(key, entry);
    }
  }

  function cleanupDecoder(session) {
    if (!session.video) return;
    const video = session.video;
    session.video = null;
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
  }

  function interruptDecoder(session) {
    session.interrupted = true;
    session.cancellations.forEach(cancel => cancel());
    session.cancellations.clear();
    cleanupDecoder(session);
  }

  function bindPlayer(session) {
    session.unbindPlayer?.();
    const player = session.options.player;
    if (!player?.addEventListener) { session.unbindPlayer = null; return; }
    const onPlay = () => interruptDecoder(session);
    const onPause = () => requestGeneration(session);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onPause);
    session.unbindPlayer = () => {
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onPause);
    };
  }

  function stop(session) {
    if (!session || session.cancelled) return;
    session.cancelled = true;
    session.unbindPlayer?.();
    interruptDecoder(session);
    active.delete(session);
    trimCache();
  }

  function dispose(container) {
    const session = sessions.get(container);
    if (!session) return;
    stop(session);
    session.layer.remove();
    sessions.delete(container);
  }

  function waitFor(session, names, ready, timeoutMs, action) {
    return new Promise((resolve, reject) => {
      const video = session.video;
      let done = false;
      let timer;
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        names.forEach(name => video.removeEventListener(name, check));
        video.removeEventListener('error', failed);
        session.cancellations.delete(cancel);
        error ? reject(error) : resolve();
      }
      function check() {
        if (!mayDecode(session)) return finish(new Error('cancelled'));
        if (ready()) finish();
      }
      function failed() { finish(new Error('video unavailable')); }
      function cancel() { finish(new Error('cancelled')); }
      names.forEach(name => video.addEventListener(name, check));
      video.addEventListener('error', failed);
      session.cancellations.add(cancel);
      timer = setTimeout(() => finish(new Error('video preview timeout')), timeoutMs);
      try { if (action) action(); check(); } catch (error) { finish(error); }
    });
  }

  function yieldToUi(session) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.cancellations.delete(cancel);
        mayDecode(session) ? resolve() : reject(new Error('cancelled'));
      }, 0);
      function cancel() { clearTimeout(timer); reject(new Error('cancelled')); }
      session.cancellations.add(cancel);
    });
  }

  function label(session, name) { return session.options.labels?.[name] || ''; }

  function showFrame(session, index, frame) {
    if (!alive(session)) return;
    const image = session.images[index];
    image.src = frame.url;
    image.classList.add('ready');
    image.title = typeof session.options.labels?.frameAt === 'function'
      ? session.options.labels.frameAt(frame.time) : '';
    session.status.hidden = true;
  }

  function refreshLabels(session) {
    session.layer.setAttribute('aria-label', label(session, 'label'));
    if (!session.status.hidden) session.status.textContent = label(session, session.failed ? 'unavailable' : 'loading');
    session.entry?.frames.forEach((frame, index) => { if (frame) showFrame(session, index, frame); });
  }

  async function generate(session) {
    try {
      if (!mayDecode(session)) throw new Error('cancelled');
      if (session.entry.complete) return;
      const video = document.createElement('video');
      session.video = video;
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      await waitFor(session, ['loadedmetadata', 'loadeddata', 'durationchange'],
        () => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0,
        10000, () => { video.src = session.options.sourceUrl; video.load(); });
      const duration = video.duration;
      const canvas = document.createElement('canvas');
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('canvas unavailable');
      for (let index = 0; index < FRAME_COUNT; index++) {
        if (!mayDecode(session)) throw new Error('cancelled');
        if (session.entry.frames[index]) continue;
        // Both endpoints are included, while avoiding the decoder's empty end frame.
        const time = Math.min(Math.max(0, duration - .05), Math.max(.001, index * Math.max(0, duration - .05) / (FRAME_COUNT - 1)));
        await waitFor(session, ['seeked', 'loadeddata', 'canplay'],
          () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < .02,
          8000, () => { video.currentTime = time; });
        if (!mayDecode(session)) throw new Error('cancelled');
        const scale = Math.min(FRAME_WIDTH / video.videoWidth, FRAME_HEIGHT / video.videoHeight);
        if (!Number.isFinite(scale) || scale <= 0) throw new Error('invalid video frame');
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        context.fillStyle = '#0f172a';
        context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
        context.drawImage(video, (FRAME_WIDTH - width) / 2, (FRAME_HEIGHT - height) / 2, width, height);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('frame unavailable')), 'image/jpeg', .72));
        if (!mayDecode(session)) throw new Error('cancelled');
        const frame = { url: URL.createObjectURL(blob), bytes: blob.size, time };
        session.entry.frames[index] = frame;
        cacheBytes += frame.bytes;
        showFrame(session, index, frame);
        trimCache();
        await yieldToUi(session);
      }
      session.entry.complete = true;
    } catch (_) {
      if (mayDecode(session)) {
        session.failed = true;
        session.status.textContent = label(session, 'unavailable');
        session.status.hidden = false;
      }
    } finally {
      cleanupDecoder(session);
      if (alive(session)) session.layer.setAttribute('aria-busy', session.entry.complete || session.failed ? 'false' : 'true');
    }
    return stats(session.container);
  }

  function requestGeneration(session) {
    if (!alive(session) || session.entry.complete || session.failed || playing(session)) {
      return session.promise || Promise.resolve(stats(session.container));
    }
    if (session.running) {
      session.resumeRequested = true;
      return session.promise;
    }
    session.interrupted = false;
    session.resumeRequested = false;
    session.running = true;
    // The player has priority over filmstrip seeks. Retain completed frames and
    // resume only missing ones after pause, including a rapid play/pause pair.
    session.promise = generate(session).finally(() => {
      session.running = false;
      if (session.resumeRequested && alive(session) && !playing(session)) requestGeneration(session);
    });
    return session.promise;
  }

  function render(options) {
    const container = options?.container;
    if (!container) return Promise.resolve(null);
    const sourceUrl = typeof options.sourceUrl === 'string' ? options.sourceUrl : '';
    // Caller supplies the local media URL; no resolver, library scan, or whole-file fetch.
    if (!sourceUrl) { dispose(container); return Promise.resolve(null); }
    // Clips sharing an immutable original use the same full-source filmstrip.
    const key = sourceUrl + '\n' + String(options.duration || '');
    const previous = sessions.get(container);
    if (previous && previous.key === key && !previous.cancelled) {
      const playerChanged = previous.options.player !== options.player;
      previous.options = options;
      if (playerChanged) bindPlayer(previous);
      if (playing(previous)) interruptDecoder(previous);
      refreshLabels(previous);
      return requestGeneration(previous);
    }
    dispose(container);
    // Only the current clip needs a decoder, including when a different strip is opened.
    [...active].forEach(session => dispose(session.container));
    let entry = cache.get(key);
    if (entry) cache.delete(key);
    else entry = { frames: new Array(FRAME_COUNT), complete: false };
    cache.set(key, entry);
    const layer = document.createElement('div');
    layer.className = 'trim-thumbnail-layer';
    layer.setAttribute('role', 'img');
    layer.setAttribute('aria-busy', entry.complete ? 'false' : 'true');
    const images = Array.from({ length: FRAME_COUNT }, () => {
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.decoding = 'async';
      layer.appendChild(image);
      return image;
    });
    const status = document.createElement('span');
    status.className = 'trim-thumbnail-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    layer.appendChild(status);
    container.insertBefore(layer, container.firstChild);
    const session = { container, options, key, entry, layer, images, status, cancellations: new Set(), cancelled: false, failed: false, video: null, running: false, interrupted: false, resumeRequested: false, unbindPlayer: null, promise: null };
    sessions.set(container, session);
    active.add(session);
    bindPlayer(session);
    refreshLabels(session);
    trimCache();
    return requestGeneration(session);
  }

  function stats(container) {
    const session = sessions.get(container);
    return {
      frames: session?.entry.frames.filter(Boolean).length || 0,
      complete: !!session?.entry.complete,
      failed: !!session?.failed,
      decoding: !!session?.video,
      waitingForPlayback: !!session && !session.entry.complete && !session.failed && playing(session),
      cacheEntries: cache.size,
      cacheFrames: [...cache.values()].reduce((total, entry) => total + entry.frames.filter(Boolean).length, 0),
      cacheBytes
    };
  }

  window.PicShelfTrimThumbnails = Object.freeze({ render, dispose, stats });
})();
