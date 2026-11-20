/* Backdrop "Precision" cutout - an additional background-removal option.

   Standard (the existing MediaPipe cutout) stays the default and is not changed.
   Precision runs InSPyReNet (transparent-background "base" model, MIT) on the
   device through the app's native ONNX Runtime engine: it also keeps pets,
   cakes, objects and fine edges that a people-only model drops. The photo never
   leaves the phone.

   The model is not part of the app download. The first time someone picks
   Precision, the app offers a one-time download (size shown, mobile data
   noted); progress shows on the Precision button and the option turns on by
   itself when the verified model is ready.

   Precision returns the same result shape as PicShelfBackdrop.extract, so every
   Backdrop feature (landmarks, blur, colors, custom images, NanoScope, Subject
   Size, Compare, Save) works with it unchanged.

   The chosen option is remembered on this device (localStorage, mirrored to
   IndexedDB with the time it was chosen, like the Albums sort). */
(() => {
  'use strict';
  const STORAGE_KEY = 'photo_org_backdrop_engine';
  const STAMP_KEY = 'photo_org_backdrop_engine_at';
  const ENGINES = ['standard', 'precision'];
  const TIMEOUT_MS = 180000;
  const el = id => document.getElementById(id);
  const tr = (key, fallback, params) => {
    let text = window.t && window.t(key) !== key ? window.t(key) : fallback;
    if (params) for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(String(value));
    return text;
  };
  const toast = message => { if (typeof window.showToast === 'function') window.showToast(message); };
  const megabytes = bytes => Math.max(1, Math.round((Number(bytes) || 0) / 1e6)) + ' MB';

  // ---- Remembered choice ----------------------------------------------------
  const backup = (() => {
    const DB_NAME = 'picshelf_preferences', STORE = 'preferences', RECORD = 'backdropEngine';
    let opening = null;
    function open() {
      if (!opening) {
        opening = new Promise(resolve => {
          let request;
          try { request = indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
          request.onupgradeneeded = () => {
            try { request.result.createObjectStore(STORE); } catch (_) {}
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        });
      }
      return opening;
    }
    function read() {
      return open().then(db => db && new Promise(resolve => {
        try {
          const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      }));
    }
    let queued = null, writing = false;
    function write(record) {
      queued = record;
      if (writing) return;
      writing = true;
      (async () => {
        while (queued) {
          const next = queued;
          queued = null;
          const db = await open();
          if (!db) break;
          await new Promise(resolve => {
            try {
              const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
              tx.objectStore(STORE).put(next, RECORD);
              tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
            } catch (_) { resolve(); }
          });
        }
        writing = false;
      })();
    }
    return { read, write };
  })();

  let engine = 'standard';
  let savedAt = 0;
  let chosenNow = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (ENGINES.includes(saved)) {
      engine = saved;
      savedAt = Number(localStorage.getItem(STAMP_KEY)) || 0;
    }
  } catch (_) {}

  backup.read().then(record => {
    if (chosenNow) return;
    const mode = record && ENGINES.includes(record.engine) ? record.engine : null;
    const at = mode ? Number(record.at) || 0 : 0;
    if (!mode || (mode !== engine && at <= savedAt)) {
      if (savedAt && (mode !== engine || at !== savedAt)) backup.write({ engine, at: savedAt });
      return;
    }
    if (mode === engine) return;
    // localStorage missed the latest choice (the app closed straight after it).
    engine = mode;
    savedAt = at;
    try {
      localStorage.setItem(STORAGE_KEY, engine);
      localStorage.setItem(STAMP_KEY, String(savedAt));
    } catch (_) {}
    sync();
  });

  function remember(next) {
    engine = next;
    chosenNow = true;
    savedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, engine);
      localStorage.setItem(STAMP_KEY, String(savedAt));
    } catch (_) {}
    backup.write({ engine, at: savedAt });
  }

  // ---- Native engine --------------------------------------------------------
  const bridge = () => window.AndroidApp;
  let availableCache = null;
  function available() {
    if (availableCache !== null) return availableCache;
    try {
      const app = bridge();
      availableCache = !!(app && typeof app.backdropPrecisionSegment === 'function' &&
        typeof app.backdropPrecisionAvailable === 'function' && app.backdropPrecisionAvailable() === true);
    } catch (_) { availableCache = false; }
    return availableCache;
  }

  // Model download state: { state: ready|missing|downloading|error, downloaded, total, metered, error }
  let model = null;
  function modelStatus(refresh = false) {
    if (model && !refresh) return model;
    try {
      const app = bridge();
      const parsed = app && typeof app.backdropPrecisionModelStatus === 'function'
        ? JSON.parse(app.backdropPrecisionModelStatus() || '{}') : null;
      model = parsed && parsed.state ? parsed : { state: 'missing', downloaded: 0, total: 0 };
    } catch (_) {
      model = { state: 'missing', downloaded: 0, total: 0 };
    }
    return model;
  }
  const modelReady = () => available() && modelStatus().state === 'ready';

  const pending = new Map();
  let sequence = 0;
  let tail = Promise.resolve();
  const canceled = () => Object.assign(new Error('Backdrop request superseded'), { name: 'AbortError' });

  function onNative(payload) {
    const request = payload && pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    clearTimeout(request.timer);
    if (payload.error || typeof payload.mask !== 'string') request.reject(new Error(payload.error || 'Precision cutout failed'));
    else request.resolve(payload);
  }

  function runNative(imageBase64, isCurrent) {
    return new Promise((resolve, reject) => {
      const id = 'precision_' + (++sequence) + '_' + Date.now();
      let watch = 0;
      const finish = () => { clearTimeout(timer); clearInterval(watch); pending.delete(id); };
      const stop = error => {
        finish();
        try { bridge().backdropPrecisionCancel(id); } catch (_) {}
        reject(error);
      };
      const timer = setTimeout(() => stop(new Error('Precision cutout timed out')), TIMEOUT_MS);
      // A newer photo or option replaces this request: stop the engine instead of letting it finish.
      watch = setInterval(() => { if (!isCurrent()) stop(canceled()); }, 250);
      pending.set(id, {
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
        timer
      });
      try {
        bridge().backdropPrecisionSegment(id, imageBase64);
      } catch (error) {
        finish();
        reject(error);
      }
    });
  }

  let busy = 0;
  function setBusy(delta) {
    busy = Math.max(0, busy + delta);
    renderButton();
  }

  function maskCanvasFrom(payload) {
    const size = Number(payload.size);
    if (!Number.isInteger(size) || size < 64 || size > 2048) throw new Error('Backdrop mask unavailable');
    const binary = atob(payload.mask);
    if (binary.length !== size * size) throw new Error('Backdrop mask unavailable');
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let i = 0, o = 0; i < binary.length; i++, o += 4) {
      // Foreground confidence is ALPHA (as with the Standard worker); colour is not opacity.
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
      rgba[o + 3] = binary.charCodeAt(i);
    }
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
    // The model's matte is final: no extra confidence curve (as transparent-background uses it).
    canvas._backdropAlphaMode = 'matte';
    return canvas;
  }

  // Same contract as PicShelfBackdrop.extract(image, isCurrent).
  function extract(image, isCurrent = () => true) {
    const task = tail.then(async () => {
      if (!isCurrent()) throw canceled();
      if (!modelReady()) throw new Error('Precision cutout unavailable');
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      if (!(width > 0 && height > 0)) throw new Error('Backdrop image unavailable');
      const size = 640;
      // The model sees the whole photo resized to a square (as transparent-background does).
      const input = document.createElement('canvas');
      input.width = size;
      input.height = size;
      const context = input.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      const encoded = input.toDataURL('image/png');
      if (!isCurrent()) throw canceled();
      const started = performance.now();
      let payload;
      setBusy(1);
      try {
        payload = await runNative(encoded.slice(encoded.indexOf(',') + 1), isCurrent);
      } finally {
        setBusy(-1);
      }
      if (!isCurrent()) throw canceled();
      const maskCanvas = maskCanvasFrom(payload);
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!isCurrent()) throw canceled();
      const cutoutCanvas = window.PicShelfBackdrop.refine(image, maskCanvas, width, height);
      return {
        cutoutCanvas, maskCanvas, delegate: 'PRECISION',
        timing: Object.assign({ roundTripMs: performance.now() - started }, payload.timing || {})
      };
    });
    tail = task.catch(() => {});
    return task;
  }

  // ---- On-demand model download ----------------------------------------------
  let wantPrecision = false; // the user asked for Precision; switch to it when the model is ready
  let restoreBack = null;

  function downloadErrorText(status) {
    const error = String(status?.error || '');
    if (error.startsWith('storage')) {
      const needed = Number(error.split(':')[1]) || status?.total || 0;
      return tr('backdrop_precision_download_storage', 'Not enough free storage. Free up {size} and try again.', { size: megabytes(needed) });
    }
    return tr('backdrop_precision_download_failed', 'Check your internet connection and try again.');
  }

  function renderDialog() {
    const dialog = el('backdropPrecisionDialog');
    if (!dialog || dialog.style.display === 'none') return;
    const status = modelStatus();
    const total = status.total || 0;
    const downloading = status.state === 'downloading';
    const failed = status.state === 'error';
    const title = el('backdropPrecisionDialogTitle');
    const text = el('backdropPrecisionDialogText');
    const note = el('backdropPrecisionDialogNote');
    const progress = el('backdropPrecisionProgress');
    const bar = el('backdropPrecisionProgressBar');
    const primary = el('backdropPrecisionDialogPrimary');
    const secondary = el('backdropPrecisionDialogSecondary');
    dialog.dataset.mode = downloading ? 'downloading' : failed ? 'error' : 'offer';
    if (downloading) {
      const percent = total ? Math.min(100, Math.floor(status.downloaded * 100 / total)) : 0;
      title.textContent = tr('backdrop_precision_downloading_title', 'Downloading Precision cutout');
      text.textContent = tr('backdrop_precision_download_progress', '{done} of {total}', { done: megabytes(status.downloaded), total: megabytes(total) }) + ' · ' + percent + '%';
      progress.hidden = false;
      bar.style.width = percent + '%';
      progress.setAttribute('aria-valuenow', String(percent));
      note.textContent = tr('backdrop_precision_download_note', 'You can keep editing. Precision turns on when the download finishes.');
      primary.textContent = tr('backdrop_precision_download_hide', 'Hide');
      secondary.textContent = tr('backdrop_precision_download_stop', 'Stop download');
    } else {
      progress.hidden = true;
      title.textContent = failed
        ? tr('backdrop_precision_download_failed_title', "Download didn't finish")
        : tr('backdrop_precision_download_title', 'Download Precision cutout?');
      text.textContent = failed ? downloadErrorText(status)
        : tr('backdrop_precision_download_body', 'One-time download of {size}. The cutout runs on your phone, so your photos never leave it. Wi-Fi is recommended.', { size: megabytes(total) });
      note.textContent = status.metered ? tr('backdrop_precision_download_metered', "You're on mobile data.") : '';
      primary.textContent = failed
        ? tr('backdrop_precision_download_retry', 'Try again')
        : tr('backdrop_precision_download_start', 'Download');
      secondary.textContent = tr('backdrop_precision_download_later', 'Not now');
    }
    note.hidden = !note.textContent;
  }

  function openDialog() {
    const dialog = el('backdropPrecisionDialog');
    if (!dialog) return;
    modelStatus(true);
    dialog.style.display = 'flex';
    renderDialog();
    if (!restoreBack) {
      // Android Back closes this dialog before anything else.
      const previous = window.handleNativeBackPressed;
      const handler = function () { closeDialog(); return true; };
      window.handleNativeBackPressed = handler;
      restoreBack = () => { if (window.handleNativeBackPressed === handler) window.handleNativeBackPressed = previous; };
    }
  }

  function closeDialog() {
    const dialog = el('backdropPrecisionDialog');
    if (dialog) dialog.style.display = 'none';
    if (restoreBack) { restoreBack(); restoreBack = null; }
  }

  function startDownload() {
    wantPrecision = true;
    try { bridge().backdropPrecisionDownload(); } catch (_) {}
    model = Object.assign({}, modelStatus(true));
    if (model.state !== 'ready') model.state = 'downloading';
    renderButton();
    renderDialog();
  }

  function stopDownload() {
    wantPrecision = false;
    try { bridge().backdropPrecisionStopDownload(); } catch (_) {}
  }

  function onDownload(status) {
    if (!status || !status.state) return;
    const before = model?.state;
    model = status;
    renderButton();
    renderDialog();
    if (status.state === 'ready' && before !== 'ready') {
      closeDialog();
      toast(tr('backdrop_precision_download_ready', 'Precision cutout is ready.'));
      if (wantPrecision) {
        wantPrecision = false;
        remember('precision');
        sync();
        window.dispatchEvent(new CustomEvent('picshelf-backdrop-engine', { detail: { engine: 'precision' } }));
      }
    } else if (status.state === 'error' && before === 'downloading') {
      wantPrecision = false;
      if (el('backdropPrecisionDialog')?.style.display === 'none') toast(downloadErrorText(status));
    } else if (status.state === 'missing' && before === 'downloading') {
      wantPrecision = false;
      toast(tr('backdrop_precision_download_stopped', 'Download stopped. It will continue from where it left off.'));
    }
  }

  // ---- Option in the Backdrop panel -----------------------------------------
  const activeEngine = () => (engine === 'precision' && modelReady() ? 'precision' : 'standard');

  function renderButton() {
    const button = document.querySelector('#studioBackdropEngine .studio-backdrop-engine-btn[data-engine="precision"]');
    if (!button) return;
    const label = button.querySelector('span');
    const icon = button.querySelector('i');
    const status = model || { state: 'missing' };
    const downloading = status.state === 'downloading';
    const working = busy > 0;
    const percent = downloading && status.total ? Math.min(100, Math.floor(status.downloaded * 100 / status.total)) : 0;
    button.classList.toggle('working', working);
    button.classList.toggle('downloading', downloading);
    button.style.setProperty('--precision-progress', percent + '%');
    button.setAttribute('aria-busy', working || downloading ? 'true' : 'false');
    if (icon) icon.className = working ? 'fa-solid fa-circle-notch fa-spin'
      : downloading ? 'fa-solid fa-arrow-down' : 'fa-solid fa-wand-magic-sparkles';
    const progressText = tr('backdrop_precision_downloading', 'Downloading {percent}%', { percent });
    if (label) {
      // While the background is being removed the option says so (with the spinning icon).
      label.textContent = downloading ? progressText
        : working ? tr('backdrop_precision_processing', 'Processing…')
        : tr('backdrop_engine_precision', 'Precision');
      // Narrow screens and long languages: keep the percentage visible (the arrow says "downloading").
      if (downloading && label.scrollWidth > label.clientWidth + 1) label.textContent = percent + '%';
    }
    button.title = working ? tr('backdrop_precision_working', 'Preparing the Precision cutout…')
      : downloading ? progressText
      : tr('backdrop_engine_precision_hint', 'Sharper cutout for any subject: people, pets and objects. Takes a few seconds.');
    if (downloading) button.setAttribute('aria-label', progressText);
    else button.removeAttribute('aria-label');
  }

  function sync() {
    const group = el('studioBackdropEngine');
    if (!group) return;
    const current = activeEngine();
    group.querySelectorAll('.studio-backdrop-engine-btn').forEach(button => {
      const active = button.dataset.engine === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    renderButton();
  }

  function setEngine(next) {
    if (!ENGINES.includes(next)) { sync(); return; }
    if (next === 'precision') {
      if (!available()) {
        sync();
        toast(tr('backdrop_precision_unavailable', 'Precision cutout is not available on this device.'));
        return;
      }
      if (!modelReady()) {
        // First use (or an unfinished download): offer the one-time download.
        sync();
        openDialog();
        return;
      }
    }
    if (next === activeEngine() && next === engine) { sync(); return; }
    if (next === 'standard') wantPrecision = false;
    remember(next);
    sync();
    window.dispatchEvent(new CustomEvent('picshelf-backdrop-engine', { detail: { engine: next } }));
  }

  // The Backdrop panel opens with Standard selected; Precision runs once it is picked.
  function useStandard() {
    if (engine !== 'standard') remember('standard');
    chosenNow = true; // a late read of the saved choice must not switch it back
    sync();
  }

  function attach() {
    const group = el('studioBackdropEngine');
    if (group && !group.dataset.bound) {
      group.dataset.bound = '1';
      group.addEventListener('click', event => {
        const button = event.target.closest('.studio-backdrop-engine-btn');
        if (!button || !group.contains(button)) return;
        event.stopPropagation();
        setEngine(button.dataset.engine);
      });
    }
    const dialog = el('backdropPrecisionDialog');
    if (dialog && !dialog.dataset.bound) {
      dialog.dataset.bound = '1';
      el('backdropPrecisionDialogPrimary')?.addEventListener('click', () => {
        if (dialog.dataset.mode === 'downloading') closeDialog();
        else startDownload();
      });
      el('backdropPrecisionDialogSecondary')?.addEventListener('click', () => {
        if (dialog.dataset.mode === 'downloading') stopDownload();
        closeDialog();
      });
      el('backdropPrecisionDialogClose')?.addEventListener('click', closeDialog);
      dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
    }
    // Nothing native is touched at start-up: the row is brought up to date when the
    // Backdrop panel is shown (and after every change).
    const panel = el('studioPanelBackdrop');
    if (panel && !panel.dataset.engineObserved) {
      panel.dataset.engineObserved = '1';
      new MutationObserver(() => { if (panel.style.display !== 'none') sync(); })
        .observe(panel, { attributes: true, attributeFilter: ['style'] });
    }
    if (engine === 'standard') sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  window.PicShelfBackdropPrecision = Object.freeze({
    available, extract, onNative, onDownload, setEngine, sync, useStandard,
    modelStatus: () => modelStatus(true),
    get engine() { return engine; },
    // The engine actually used: Precision only where it can run and its model is ready.
    get activeEngine() { return activeEngine(); }
  });
})();
