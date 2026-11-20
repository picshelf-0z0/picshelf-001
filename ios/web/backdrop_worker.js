/* Backdrop inference stays off the UI thread and loads only when requested. */
(() => {
  'use strict';

  let segmenter = null;
  let segmenterBase = '';
  let delegate = '';
  let fileset = null;
  let queue = Promise.resolve();

  async function createSegmenter(base, requestedDelegate) {
    const options = {
      baseOptions: {
        modelAssetPath: base + 'selfie_multiclass_256x256.tflite',
        delegate: requestedDelegate
      },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false
    };
    if (typeof OffscreenCanvas === 'function') {
      options.canvas = new OffscreenCanvas(1, 1);
    } else if (requestedDelegate === 'GPU') {
      throw new Error('Offscreen GPU processing is unavailable');
    }
    const instance = await self.Vision.ImageSegmenter.createFromOptions(fileset, options);
    const labels = instance.getLabels();
    if (!labels || labels[0] !== 'background') {
      instance.close();
      throw new Error('Unexpected Backdrop model categories');
    }
    return instance;
  }

  async function initialize(base) {
    if (segmenter && segmenterBase === base) return false;
    if (segmenter) segmenter.close();
    segmenter = null;
    delegate = '';
    segmenterBase = base;
    if (!self.Vision) importScripts(base + 'vision_bundle.js');
    // A classic worker needs the classic (non-module) WASM loader.
    fileset = await self.Vision.FilesetResolver.forVisionTasks(base + 'wasm', false);
    try {
      // Still-photo extraction avoids the expensive first-use GPU shader build.
      segmenter = await createSegmenter(base, 'CPU');
      delegate = 'CPU';
      return false;
    } catch (_) {
      segmenter = await createSegmenter(base, 'GPU');
      delegate = 'GPU';
      return true;
    }
  }

  function foregroundByte(value) {
    return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, 1 - value)) * 255) : 0;
  }

  function subjectSupport(values, width, height) {
    // Work at the model's spatial scale. These arrays never grow with photo
    // resolution, and no second model inference or image decode is needed.
    const scale = Math.min(1, 256 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const count = w * h;
    const confidence = new Float32Array(count);
    const labels = new Uint32Array(count);
    const queue = new Uint32Array(count);
    const areas = new Uint32Array(count + 1);
    const peaks = new Float32Array(count + 1);
    for (let y = 0; y < h; y++) {
      const py = (y + 0.5) * height / h - 0.5, iy = Math.floor(py), fy = py - iy;
      const y0 = Math.max(0, Math.min(height - 1, iy)), y1 = Math.max(0, Math.min(height - 1, iy + 1));
      for (let x = 0; x < w; x++) {
        const px = (x + 0.5) * width / w - 0.5, ix = Math.floor(px), fx = px - ix;
        const x0 = Math.max(0, Math.min(width - 1, ix)), x1 = Math.max(0, Math.min(width - 1, ix + 1));
        const top = foregroundByte(values[y0 * width + x0]) * (1 - fx) + foregroundByte(values[y0 * width + x1]) * fx;
        const bottom = foregroundByte(values[y1 * width + x0]) * (1 - fx) + foregroundByte(values[y1 * width + x1]) * fx;
        confidence[y * w + x] = (top * (1 - fy) + bottom * fy) / 255;
      }
    }
    let components = 0, largest = 0;
    for (let start = 0; start < count; start++) {
      if (labels[start] || confidence[start] <= 0.25) continue;
      const label = ++components;
      let head = 0, tail = 1, peak = 0;
      labels[start] = label; queue[0] = start;
      while (head < tail) {
        const pixel = queue[head++], y = Math.floor(pixel / w), x = pixel - y * w;
        peak = Math.max(peak, confidence[pixel]);
        for (let sy = Math.max(0, y - 1); sy <= Math.min(h - 1, y + 1); sy++) {
          for (let sx = Math.max(0, x - 1); sx <= Math.min(w - 1, x + 1); sx++) {
            const next = sy * w + sx;
            if (!labels[next] && confidence[next] > 0.25) { labels[next] = label; queue[tail++] = next; }
          }
        }
      }
      areas[label] = tail; peaks[label] = peak; largest = Math.max(largest, tail);
    }
    if (!components) return null;
    const keep = new Uint8Array(count), horizontal = new Uint8Array(count), support = new Uint8Array(count);
    // Preserve all confident subjects and substantial soft subjects. Never
    // select just one person or the component nearest the center of the image.
    for (let i = 0; i < count; i++) {
      const label = labels[i];
      if (label && (peaks[label] >= 0.8 || areas[label] >= largest * 0.08)) keep[i] = 1;
    }
    // Two-pixel protection around retained regions preserves soft hair/edges.
    // Separable sliding windows keep dilation linear in this bounded grid.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = 0; x <= Math.min(2, w - 1); x++) sum += keep[row + x];
      for (let x = 0; x < w; x++) {
        horizontal[row + x] = sum > 0 ? 1 : 0;
        if (x >= 2) sum -= keep[row + x - 2];
        if (x + 3 < w) sum += keep[row + x + 3];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y <= Math.min(2, h - 1); y++) sum += horizontal[y * w + x];
      for (let y = 0; y < h; y++) {
        support[y * w + x] = sum > 0 ? 1 : 0;
        if (y >= 2) sum -= horizontal[(y - 2) * w + x];
        if (y + 3 < h) sum += horizontal[(y + 3) * w + x];
      }
    }
    return { values: support, width: w, height: h };
  }

  function supportAt(support, x, y, width, height) {
    const px = (x + 0.5) * support.width / width - 0.5, ix = Math.floor(px), fx = px - ix;
    const py = (y + 0.5) * support.height / height - 0.5, iy = Math.floor(py), fy = py - iy;
    const x0 = Math.max(0, Math.min(support.width - 1, ix)), x1 = Math.max(0, Math.min(support.width - 1, ix + 1));
    const y0 = Math.max(0, Math.min(support.height - 1, iy)), y1 = Math.max(0, Math.min(support.height - 1, iy + 1));
    const a = support.values[y0 * support.width + x0] * (1 - fx) + support.values[y0 * support.width + x1] * fx;
    const b = support.values[y1 * support.width + x0] * (1 - fx) + support.values[y1 * support.width + x1] * fx;
    return a * (1 - fy) + b * fy;
  }

  function matteAlpha(confidence) {
    const amount = Math.max(0, Math.min(1, (confidence - 0.15) / 0.70));
    return amount * amount * (3 - 2 * amount);
  }

  function encodeForegroundMask(values, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > 4194304 || !values || values.length !== width * height) {
      throw new Error('Backdrop model returned an invalid confidence mask');
    }
    const support = subjectSupport(values, width, height);
    let cleaned = false;
    // If cleanup has no visible effect, preserve the previous confidence mask
    // byte for byte, including its existing refinement behavior.
    if (support) for (let y = 0; y < height && !cleaned; y++) {
      for (let x = 0; x < width; x++) {
        const confidence = foregroundByte(values[y * width + x]) / 255;
        if (confidence <= 0.15 || confidence >= 0.8) continue;
        const alpha = matteAlpha(confidence) * 255;
        if (Math.round(alpha * supportAt(support, x, y, width, height)) < Math.round(alpha)) { cleaned = true; break; }
      }
    }
    const rgba = new Uint8ClampedArray(values.length * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, offset = i * 4, byte = foregroundByte(values[i]), confidence = byte / 255;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 255;
      rgba[offset + 3] = !cleaned ? byte : confidence <= 0.15 ? 0 : Math.round(matteAlpha(confidence) *
        (confidence >= 0.8 ? 1 : supportAt(support, x, y, width, height)) * 255);
    }
    return { width, height, buffer: rgba.buffer, alphaMode: cleaned ? 'matte' : 'confidence' };
  }

  function extractMask(image) {
    let mask = null;
    let maskMs = 0;
    segmenter.segment(image, result => {
      const started = performance.now();
      const background = result.confidenceMasks && result.confidenceMasks[0];
      if (!background) throw new Error('Backdrop model returned no confidence mask');
      const width = background.width;
      const height = background.height;
      const values = background.getAsFloat32Array();
      // Include every person category, including clothing and accessories.
      // Mask data belongs to MediaPipe: copy it before this callback returns.
      mask = encodeForegroundMask(values, width, height);
      maskMs = performance.now() - started;
    });
    if (!mask) throw new Error('Backdrop model returned no result');
    return { mask, maskMs };
  }

  async function extract(message, queuedAt) {
    const started = performance.now();
    const image = message.image;
    try {
      if (!image || !image.width || !image.height || typeof message.base !== 'string' || !message.base) {
        throw new Error('Backdrop extraction input is unavailable');
      }
      const base = message.base.endsWith('/') ? message.base : message.base + '/';
      const initStarted = performance.now();
      let delegateFallback = await initialize(base);
      const initMs = performance.now() - initStarted;
      const inferenceStarted = performance.now();
      let output;
      try {
        output = extractMask(image);
      } catch (error) {
        if (delegate !== 'CPU') throw error;
        // A delegate may initialize successfully but fail when its graph runs.
        try { segmenter.close(); } catch (_) { /* Discard failed CPU graph. */ }
        segmenter = null;
        segmenter = await createSegmenter(base, 'GPU');
        delegate = 'GPU';
        delegateFallback = true;
        output = extractMask(image);
      }
      self.postMessage({
        id: message.id,
        mask: output.mask,
        timing: {
          initMs,
          inferenceMs: performance.now() - inferenceStarted,
          maskMs: output.maskMs,
          totalMs: performance.now() - started,
          queueMs: started - queuedAt,
          delegateFallback
        },
        delegate
      }, [output.mask.buffer]);
    } catch (error) {
      self.postMessage({ id: message.id, error: error && error.message ? error.message : 'Backdrop extraction failed' });
    } finally {
      try { image && image.close && image.close(); } catch (_) { /* Already released. */ }
    }
  }

  self.onmessage = event => {
    const message = event.data;
    if (!message || message.type !== 'extract') return;
    const queuedAt = performance.now();
    // Initialization is asynchronous; serialize it along with every inference.
    queue = queue.then(() => extract(message, queuedAt), () => extract(message, queuedAt));
  };
})();
