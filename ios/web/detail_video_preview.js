/* A small, temporary cover while the detail player's decoder prepares a frame. */
(() => {
  'use strict';
  const MAX_ENTRIES = 8, MAX_PIXELS = 2 * 1024 * 1024, MAX_SIDE = 512;
  const frames = new Map();
  let pixels = 0, active = null;

  function identity(photo) {
    const e = photo.tarEntry || photo.zipEntry;
    return e?.nativeSourceId ? JSON.stringify([e.nativeSourceId, e.offset, e.localOffset, e.size, e.compSize, e.method]) :
      (photo.videoUrl || photo.fileBlob || photo);
  }
  function removeFrame(id) {
    const entry = frames.get(id);
    if (!entry) return;
    pixels -= entry.canvas.width * entry.canvas.height;
    frames.delete(id);
    entry.canvas.width = entry.canvas.height = 1;
  }
  function capture(photo, video) {
    if (!photo?.id || photo.mediaType === 'audio' || !video || video.style.display === 'none' || video.readyState < 2 || video.seeking ||
        !video.videoWidth || !video.videoHeight || active?.video === video) return;
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      removeFrame(String(photo.id));
      frames.set(String(photo.id), {canvas, time: video.currentTime, identity: identity(photo)});
      pixels += canvas.width * canvas.height;
      while (frames.size > MAX_ENTRIES || pixels > MAX_PIXELS) removeFrame(frames.keys().next().value);
    } catch (_) { /* A cover is optional; never interrupt navigation or playback. */ }
  }
  function clear() {
    const session = active;
    active = null;
    if (!session) return;
    session.resize?.disconnect();
    session.mutations?.disconnect();
    if (session.paint != null) cancelAnimationFrame(session.paint);
    session.element.onload = session.element.onerror = null;
    session.element.remove();
  }
  function layout(session) {
    if (active !== session) return;
    const {video, element, frame, photo} = session;
    const width = video.offsetWidth, height = video.offsetHeight;
    if (!width || !height || video.style.display === 'none') {element.style.display = 'none'; return;}
    const style = getComputedStyle(video);
    Object.assign(element.style, {
      display: 'block', position: 'absolute', left: video.offsetLeft + 'px', top: video.offsetTop + 'px',
      width: width + 'px', height: height + 'px', maxWidth: 'none', maxHeight: 'none',
      margin: '0', padding: '0', border: '0', borderRadius: style.borderRadius,
      boxShadow: 'none', background: '#000', pointerEvents: 'none', zIndex: '3',
      visibility: style.visibility,
      transition: 'none', objectFit: 'contain', objectPosition: '50% 50%',
      // Saved crop/resize posters can already contain the composed output.
      // Only a raw cached video frame receives the player's transforms again.
      transform: frame ? style.transform : 'none', transformOrigin: style.transformOrigin,
      filter: frame ? style.filter : 'none'
    });
    if (!frame) return;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    element.width = Math.max(1, Math.round(width * scale));
    element.height = Math.max(1, Math.round(height * scale));
    const ctx = element.getContext('2d'), source = frame.canvas;
    let sx = 0, sy = 0, sw = source.width, sh = source.height;
    const box = photo.videoCrop?.normBox;
    if (box?.width > 0 && box?.height > 0) {
      sx = Math.max(0, Math.min(1, box.left || 0)) * source.width;
      sy = Math.max(0, Math.min(1, box.top || 0)) * source.height;
      sw = Math.min(source.width - sx, source.width * box.width);
      sh = Math.min(source.height - sy, source.height * box.height);
    }
    if (!(sw > 0 && sh > 0)) return;
    const factor = style.objectFit === 'cover' ? Math.max(element.width / sw, element.height / sh) :
      Math.min(element.width / sw, element.height / sh);
    const dw = sw * factor, dh = sh * factor;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, element.width, element.height);
    ctx.drawImage(source, sx, sy, sw, sh, (element.width - dw) / 2, (element.height - dh) / 2, dw, dh);
  }
  function show(photo, video, time, source = '') {
    clear();
    if (!photo?.id || photo.mediaType === 'audio' || !video?.parentElement) return;
    const cached = frames.get(String(photo.id));
    const frame = cached && cached.identity === identity(photo) && Math.abs(cached.time - time) < .25 ? cached : null;
    const resumeFrames = window.VideoCardPreviews;
    const resumedPoster = resumeFrames?.getAtTime(photo, time);
    const bookmarkPending = window.PicShelfVideoPositions?.peek(photo) === undefined;
    const waitingForResumeFrame = resumeFrames && (bookmarkPending || (!resumedPoster && time > .5));
    const poster = waitingForResumeFrame ? resumeFrames.PLACEHOLDER : (resumedPoster ||
      [photo.posterUrl, photo.thumbUrl, photo.dataUrl].find(url => typeof url === 'string' &&
        !/^data:(?!image\/)/i.test(url) && url !== photo.videoUrl));
    if (!frame && !poster) return;
    if (frame) { frames.delete(String(photo.id)); frames.set(String(photo.id), frame); }
    const element = document.createElement(frame ? 'canvas' : 'img');
    element.id = 'detailVideoLoadingPreview';
    element.setAttribute('aria-hidden', 'true');
    element.draggable = false;
    const session = active = {photo, video, element, frame, source, time, paint: null};
    if (!frame) {element.alt = ''; element.src = poster;}
    video.parentElement.appendChild(element);
    layout(session);
    if (typeof ResizeObserver === 'function') {
      session.resize = new ResizeObserver(() => layout(session));
      session.resize.observe(video);
    }
    if (typeof MutationObserver === 'function') {
      session.mutations = new MutationObserver(() => layout(session));
      session.mutations.observe(video, {attributes: true, attributeFilter: ['style', 'class']});
    }
    element.onerror = () => {if (active === session) clear();};
    if (!frame && resumeFrames) {
      // Lookup and decoding proceed independently; never delay opening/playback.
      resumeFrames.read(photo).then(() => {
        if (active !== session || session.confirmed) return;
        const saved = resumeFrames.getAtTime(photo, session.time);
        if (saved && element.getAttribute('src') !== saved) element.src = saved;
      }).catch(() => {});
    }
  }
  function retarget(video, time) {
    if (active?.video === video && Number.isFinite(time)) {
      active.time = time;
      active.confirmed = false;
    }
  }
  function ready(video) {
    const session = active;
    if (!session || session.video !== video || session.paint != null) return;
    const matches = () => active === session && session.source && video.src === session.source &&
      video.readyState >= 2 && !video.seeking &&
      (Math.abs(video.currentTime - session.time) < .5 ||
        ((!video.paused || session.confirmed) && video.currentTime >= session.time - .5));
    if (!matches()) return;
    // Once the target frame is ready, natural playback may advance and pause
    // before these paints run. A subsequent seek explicitly clears this latch.
    session.confirmed = true;
    // Seeked/loadeddata can precede the compositor's paint. Leave the cover for
    // that paint, then reveal the prepared frame without requiring autoplay.
    session.paint = requestAnimationFrame(() => {
      session.paint = requestAnimationFrame(() => {
        session.paint = null;
        if (matches()) clear();
      });
    });
  }
  window.PicShelfDetailVideoPreview = {
    capture, show, ready, retarget, clear,
    stats: () => ({entries: frames.size, pixels, visible: !!active, cachedFrame: !!active?.frame})
  };
})();
