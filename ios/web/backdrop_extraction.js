/* Backdrop-only, on-demand local segmentation. No library scans or persistent media changes. */
(() => {
  'use strict';
  const nativeAssets = location.protocol === 'file:' && window.AndroidApp;
  const base = window.isNativeIOS ? 'picshelf-backdrop://backdrop/'
    : (nativeAssets ? 'https://picshelf-backdrop.local/backdrop/'
      : new URL('vendor/backdrop/', document.baseURI).href);
  const workerUrl = nativeAssets ? base + 'backdrop_worker.js' : new URL('backdrop_worker.js', document.baseURI).href;
  let inferenceTail = Promise.resolve(), worker = null, idleTimer = null, sequence = 0;
  const pending = new Map();
  const canvas = (width, height) => Object.assign(document.createElement('canvas'), { width, height });
  const canceled = () => Object.assign(new Error('Backdrop request superseded'), { name: 'AbortError' });

  function disposeWorker(error) {
    clearTimeout(idleTimer);
    worker?.terminate();
    worker = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }

  function getWorker() {
    clearTimeout(idleTimer);
    if (!worker) {
      // A blob bootstrap supports the existing file:// Android page without
      // moving its origin (and therefore without changing its media storage).
      const bootstrap = URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(workerUrl) + ');'], { type: 'application/javascript' }));
      try { worker = new Worker(bootstrap); } finally { URL.revokeObjectURL(bootstrap); }
      const current = worker;
      worker.onmessage = event => {
        if (worker !== current) return;
        const request = pending.get(event.data?.id);
        if (!request) return;
        pending.delete(event.data.id);
        clearTimeout(request.timer);
        if (event.data.error) request.reject(new Error(event.data.error));
        else request.resolve(event.data);
        // Keep repeated Backdrop edits warm; release model/GPU memory afterward.
        if (!pending.size) idleTimer = setTimeout(() => disposeWorker(new Error('Backdrop worker idle')), 120000);
      };
      worker.onerror = () => { if (worker === current) disposeWorker(new Error('Backdrop worker unavailable')); };
    }
    return worker;
  }

  function infer(image) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      try {
        const target = getWorker();
        const timer = setTimeout(() => disposeWorker(new Error('Backdrop extraction timed out')), 45000);
        pending.set(id, { resolve, reject, timer });
        target.postMessage({ id, type: 'extract', base, image }, [image]);
      } catch (error) {
        image.close();
        const request = pending.get(id);
        if (request) { clearTimeout(request.timer); pending.delete(id); }
        reject(error);
      }
    });
  }

  function copyOriginal(image, width, height) {
    const result = canvas(width, height);
    result.getContext('2d').drawImage(image, 0, 0, width, height);
    return result;
  }

  function workingSize(width, height) {
    const scale = Math.min(1, 1024 / Math.max(width, height), Math.sqrt(786432 / (width * height)));
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  }

  function refine(image, rawMask, width, height) {
    const [mw, mh] = workingSize(width, height);
    const mask = canvas(mw, mh);
    const context = mask.getContext('2d', { willReadFrequently: true });
    context.drawImage(rawMask, 0, 0, mw, mh);
    const pixels = context.getImageData(0, 0, mw, mh), data = pixels.data;
    const matteReady = rawMask._backdropAlphaMode === 'matte';
    let strongPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      // The worker explicitly encodes foreground confidence in ALPHA. Color
      // channels are not confidence and must never become subject opacity.
      const confidence = data[i + 3] / 255;
      if (confidence >= 0.5) strongPixels++;
      data[i] = data[i + 1] = data[i + 2] = 255;
      // Cleaned worker output is already a matte. Applying the confidence
      // curve again would erode the same hair/edge pixels a second time.
      if (!matteReady) {
        const amount = Math.max(0, Math.min(1, (confidence - 0.15) / 0.70));
        data[i + 3] = Math.round(amount * amount * (3 - 2 * amount) * 255);
      }
    }
    if (strongPixels < Math.max(12, mw * mh * 0.001)) throw new Error('No subject detected');
    context.putImageData(pixels, 0, 0);
    const result = copyOriginal(image, width, height);
    const output = result.getContext('2d');
    output.imageSmoothingEnabled = true;
    output.imageSmoothingQuality = 'high';
    output.globalCompositeOperation = 'destination-in';
    output.drawImage(mask, 0, 0, width, height);
    output.globalCompositeOperation = 'source-over';
    return result;
  }

  function extract(image, isCurrent = () => true) {
    // One model instance owns its callback/texture. Serialize requests, including
    // rapid photo navigation; canceled queued work never performs inference.
    const task = inferenceTail.then(async () => {
      if (!isCurrent()) throw canceled();
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      if (!(width > 0 && height > 0)) throw new Error('Backdrop image unavailable');
      const [mw, mh] = workingSize(width, height);
      const input = copyOriginal(image, mw, mh);
      const bitmap = await createImageBitmap(input);
      if (!isCurrent()) { bitmap.close(); throw canceled(); }
      const result = await infer(bitmap);
      if (!isCurrent()) throw canceled();
      const mask = result.mask;
      if (!mask || !(mask.width > 0 && mask.height > 0) || mask.width * mask.height > 4194304 ||
          !(mask.buffer instanceof ArrayBuffer) || mask.buffer.byteLength !== mask.width * mask.height * 4) throw new Error('Backdrop mask unavailable');
      const maskCanvas = canvas(mask.width, mask.height);
      if (mask.alphaMode === 'matte') maskCanvas._backdropAlphaMode = 'matte';
      maskCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(mask.buffer), mask.width, mask.height), 0, 0);
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!isCurrent()) throw canceled();
      const cutoutCanvas = refine(image, maskCanvas, width, height);
      return { cutoutCanvas, maskCanvas, timing: result.timing, delegate: result.delegate };
    });
    inferenceTail = task.catch(() => {});
    return task;
  }

  window.PicShelfBackdrop = Object.freeze({ extract, refine, copyOriginal });
})();
