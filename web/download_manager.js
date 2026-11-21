/**
 * Aura Photo Organizer - Centralized Production-Grade Download & Export Manager
 * 
 * Features:
 * - Unified DownloadSession architecture for all download actions
 * - Persistent DownloadRegistry with duplicate detection (Download New Only vs Download All)
 * - Deterministic file collision handling: photo.jpg, photo (1).jpg, etc.
 * - Atomic batch numbering (001, 002, 003...) per date and per album
 * - Exact Android MediaStore physical structure:
 *     Pictures/PhotoOrganizer/Gallery Images/DD-MM-YY/001/
 *     Pictures/PhotoOrganizer/Collections/<Album Name>/DD-MM-YY/001/
 * - Multi-album separation under a unified parent DownloadSession
 * - Full asynchronous progress reporting (Downloading X of Y) with cancellation & retry
 * - Complete parity across Android (MediaStore IS_PENDING), iOS (PhotoKit PHPhotoLibrary), and Web
 * - Persistent download history
 */

(function (window) {
  'use strict';

  // Constants
  const STORAGE_KEYS = {
    SESSIONS: 'aura_download_sessions',
    REGISTRY: 'aura_download_registry',
    ITEMS: 'aura_download_items',
    BATCH_COUNTERS: 'aura_download_batch_counters'
  };

  const ROOT_FOLDER = 'PicShelf';

  function downloadText(key, fallback, params = {}) {
    const translated = typeof window.t === 'function' ? window.t(key, params) : null;
    return translated && translated !== key ? translated : fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token);
  }

  function displayCount(value) {
    return Number(value || 0).toLocaleString(window.state?.language || 'en');
  }

  // The native bridge keeps its existing status protocol; translate only its UI text.
  function localizedStatus(status) {
    if (status === 'Cancelled') return downloadText('download_cancelled', 'Download cancelled');
    const count = /^Saved (\d+) of (\d+)$/.exec(status);
    if (count) return downloadText('download_saved_progress', '{current} of {total} saved', { current: displayCount(count[1]), total: displayCount(count[2]) });
    if (status.startsWith('Saved ')) return downloadText('download_saved_file', 'Saved: {name}', { name: status.slice(6) });
    if (status.startsWith('Failed: ')) return downloadText('download_failed_reason', 'Failed: {error}', { error: status.slice(8) });
    if (status.startsWith('Failed ')) return downloadText('download_failed_file', 'Failed: {name}', { name: status.slice(7) });
    return status;
  }

  const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);


  // In-memory mutex for atomic batch number allocation
  let _batchAllocationLock = Promise.resolve();

  // Active download session state
  let _activeSession = null;
  let _isCancelled = false;
  let _preparationQueue = Promise.resolve();
  const _pendingPreparations = new Set();
  const _bulkQueue = [], _bulkWaiters = new Map(), _bulkFinished = new Set();
  let _runningBulkSession = null;
  let _progressWidgetSession = null;
  let _progressWidgetObserver = null;
  let _progressWidgetCounts = { current: 0, total: 0 };
  let _progressWidgetStatusText = '';
  let _progressWidgetFinished = false;
  let _progressToastObserver = null, _progressToastResize = null, _progressToastFrame = 0;
  let _progressToastHideTimer = null, _progressToastWasVisible = false;
  let _progressCancelledTimer = null;

  function positionProgressAboveToast() {
    _progressToastFrame = 0;
    const modal = document.getElementById('downloadProgressModal');
    const toast = document.getElementById('toastMessage');
    if (!modal || modal.style.display === 'none' || !toast) return;
    const style = getComputedStyle(toast);
    const visible = toast.classList.contains('show') && style.display !== 'none' && style.visibility !== 'hidden';
    if (!visible) {
      // Keep the gap through the existing snackbar's 250ms fade-out.
      if (_progressToastWasVisible) {
        if (_progressToastHideTimer == null) _progressToastHideTimer = setTimeout(() => {
          _progressToastHideTimer = null; _progressToastWasVisible = false;
          scheduleProgressToastPosition();
        }, 280);
        return;
      }
      modal.style.removeProperty('--download-widget-toast-bottom');
      return;
    }
    clearTimeout(_progressToastHideTimer); _progressToastHideTimer = null;
    _progressToastWasVisible = true;
    const toastRect = toast.getBoundingClientRect(), modalRect = modal.getBoundingClientRect();
    const overlapsHorizontally = toastRect.right > modalRect.left && toastRect.left < modalRect.right;
    // offsetHeight excludes the snackbar's entrance transform: reserve its
    // final position immediately, without following its animation or scrolling.
    const bottom = overlapsHorizontally ? Math.ceil((parseFloat(style.bottom) || 0) + toast.offsetHeight + 8) : 0;
    modal.style.setProperty('--download-widget-toast-bottom', `${bottom}px`);
  }

  function scheduleProgressToastPosition() {
    if (!_progressToastFrame) _progressToastFrame = requestAnimationFrame(positionProgressAboveToast);
  }

  function observeProgressToast() {
    const toast = document.getElementById('toastMessage');
    if (_progressToastObserver || !toast || typeof MutationObserver !== 'function') return;
    _progressToastObserver = new MutationObserver(scheduleProgressToastPosition);
    _progressToastObserver.observe(toast, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], childList: true, characterData: true, subtree: true });
    if (typeof ResizeObserver === 'function') {
      _progressToastResize = new ResizeObserver(scheduleProgressToastPosition);
      _progressToastResize.observe(toast);
    }
    window.addEventListener('resize', scheduleProgressToastPosition);
  }

  function stopObservingProgressToast() {
    _progressToastObserver?.disconnect(); _progressToastObserver = null;
    _progressToastResize?.disconnect(); _progressToastResize = null;
    window.removeEventListener('resize', scheduleProgressToastPosition);
    cancelAnimationFrame(_progressToastFrame); _progressToastFrame = 0;
    clearTimeout(_progressToastHideTimer); _progressToastHideTimer = null;
    _progressToastWasVisible = false;
    document.getElementById('downloadProgressModal')?.style.removeProperty('--download-widget-toast-bottom');
  }

  function updateProgressWidget() {
    const modal = document.getElementById('downloadProgressModal');
    const toggle = document.getElementById('downloadProgressToggle');
    if (!modal || !toggle) return;
    const compact = modal.classList.contains('is-minimized');
    const label = downloadText(compact ? 'download_background_show' : 'download_background_minimize', compact ? 'Show download progress' : 'Minimize progress');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!compact));
    toggle.title = label;
    const title = document.getElementById('downloadProgressTitle');
    if (title?.dataset.i18n) title.textContent = downloadText(title.dataset.i18n, title.textContent);
    const text = document.getElementById('downloadProgressToggleText');
    if (text) text.textContent = compact ? title?.textContent || label : label;
    const count = document.getElementById('downloadProgressCompactCount');
    const countText = downloadText('download_count', '{current} of {total}', { current: displayCount(_progressWidgetCounts.current), total: displayCount(_progressWidgetCounts.total) });
    if (count) count.textContent = countText;
    const fullCount = document.getElementById('downloadProgressCount');
    if (fullCount) fullCount.textContent = countText;
    const session = _progressWidgetSession;
    if (session) {
      const saved = document.getElementById('downloadProgressSuccessPill');
      if (saved) saved.textContent = downloadText('download_saved_count', 'Saved: {count}', { count: displayCount(session.successfulCount) });
      const failed = document.getElementById('downloadProgressFailedPill');
      if (failed) failed.textContent = downloadText('download_failed_count', 'Failed: {count}', { count: displayCount(session.failedCount) });
      const status = document.getElementById('downloadProgressStatusText');
      if (status) {
        status.textContent = _progressWidgetFinished
          ? (session.failedCount > 0 && session.status !== 'cancelled'
            ? downloadText('download_summary', 'Saved: {saved}. Failed: {failed}.', { saved: displayCount(session.successfulCount), failed: displayCount(session.failedCount) })
            : downloadText('download_saved_library', 'Media saved to your device: {count}.', { count: displayCount(session.successfulCount) }))
          : (_progressWidgetStatusText ? localizedStatus(_progressWidgetStatusText) : downloadText('download_preparing', 'Preparing media for storage…'));
      }
      const retry = document.getElementById('downloadProgressRetryBtn');
      if (_progressWidgetFinished && session.failedCount > 0 && retry) retry.textContent = downloadText('download_retry_count', 'Retry failed ({count})', { count: displayCount(session.failedCount) });
    }
    const icon = document.getElementById('downloadProgressToggleIcon');
    if (icon) icon.className = 'fa-solid ' + (compact ? 'fa-cloud-arrow-down' : 'fa-minus');
    const hint = document.getElementById('downloadProgressBackgroundHint');
    if (hint) hint.textContent = downloadText('download_background_hint', 'Downloads continue while you use the app.');
    scheduleProgressToastPosition();
  }

  function prepareProgressWidget(modal, session) {
    clearTimeout(_progressCancelledTimer); _progressCancelledTimer = null;
    _progressWidgetSession = session;
    _progressWidgetStatusText = '';
    _progressWidgetFinished = false;
    // This progress surface is not a dialog: it must not dim the app, trap
    // its navigation, or intercept touches outside its own small panel.
    modal.classList.remove('modal-overlay', 'dialog-mode');
    modal.classList.add('download-progress-widget', 'is-minimized');
    modal.setAttribute('role', 'region');
    modal.removeAttribute('aria-modal');
    const card = modal.querySelector('.dialog-card');
    if (card && !document.getElementById('downloadProgressToggle')) {
      const toggle = document.createElement('button');
      toggle.id = 'downloadProgressToggle';
      toggle.className = 'download-progress-toggle';
      toggle.type = 'button';
      toggle.innerHTML = '<i id="downloadProgressToggleIcon" class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i><span id="downloadProgressToggleText"></span><span id="downloadProgressCompactCount"></span>';
      toggle.onclick = () => {
        modal.classList.toggle('is-minimized');
        updateProgressWidget();
      };
      card.prepend(toggle);
      const hint = document.createElement('p');
      hint.id = 'downloadProgressBackgroundHint';
      hint.dataset.i18n = 'download_background_hint';
      card.appendChild(hint);
    }
    if (!_progressWidgetObserver && typeof MutationObserver === 'function') {
      _progressWidgetObserver = new MutationObserver(updateProgressWidget);
      _progressWidgetObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
    observeProgressToast();
    updateProgressWidget();
  }

  // =========================================================================
  // UTILITY HELPERS
  // =========================================================================

  function getLocalDateDDMMYY(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `${dd}-${mm}-${yy}`;
  }

  function getLocalTime12Hour(date = new Date()) {
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
  }

  function sanitizeAlbumName(name) {
    if (!name || typeof name !== 'string') return 'Collection';
    // Remove illegal filesystem chars: / \ : * ? " < > | and control characters
    let clean = name.replace(/[/\\:*?"<>|\x00-\x1F]/g, '_');
    // Prevent path traversal
    clean = clean.replace(/\.{2,}/g, '_');
    // Normalize whitespace
    clean = clean.replace(/\s+/g, ' ').trim();
    // Strip leading/trailing dots and underscores
    clean = clean.replace(/^[._]+|[._]+$/g, '');
    return clean || 'Collection';
  }

  function sanitizeFileName(name, defaultBase = 'Photo') {
    if (!name || typeof name !== 'string') return `${defaultBase}.jpg`;
    // Strip existing extension
    const base = name.replace(/\.[^/.]+$/, '');
    let clean = base.replace(/[/\\:*?"<>|\x00-\x1F]/g, '_').trim();
    clean = clean.replace(/\.{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
    return (clean || defaultBase) + '.jpg';
  }

  function formatExportFileName(localDate, batchNumber, index, rawName, defaultBase = 'Photo') {
    const base = (rawName || defaultBase).replace(/\.[^/.]+$/, '');
    let clean = base.replace(/[/\\:*?"<>|\x00-\x1F]/g, '_').replace(/\s+/g, '_').trim();
    clean = clean.replace(/\.{2,}/g, '_').replace(/^[._]+|[._]+$/g, '');
    if (!clean) clean = defaultBase;
    const indexStr = String(index).padStart(2, '0');
    return `${localDate}_${batchNumber}_${indexStr}_${clean}.jpg`;
  }

  function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
  }

  function computeQuickHash(str) {
    if (!str) return 'empty';
    let hash = 0;
    const len = Math.min(str.length, 4096); // Hash header & length for speed
    for (let i = 0; i < len; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return `h_${Math.abs(hash)}_${str.length}`;
  }

  function resolveDeterministicCollision(fileName, usedNamesSet) {
    if (!usedNamesSet.has(fileName.toLowerCase())) {
      usedNamesSet.add(fileName.toLowerCase());
      return fileName;
    }
    const ext = '.jpg';
    const base = fileName.substring(0, fileName.length - ext.length);
    let counter = 1;
    let candidate = `${base} (${counter})${ext}`;
    while (usedNamesSet.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${base} (${counter})${ext}`;
    }
    usedNamesSet.add(candidate.toLowerCase());
    return candidate;
  }

  async function ensureJpegDataUrl(dataUrl) {
    if (!dataUrl) return null;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/jpeg;base64,')) {
      return dataUrl;
    }
    if (typeof window.convertToJpegBlob === 'function') {
      try {
        const res = await window.convertToJpegBlob(dataUrl, 0.95, false);
        if (res && res.dataUrl) return res.dataUrl;
      } catch (e) {
        console.warn('[DownloadManager] convertToJpegBlob error:', e);
      }
    }
    return new Promise((resolve) => {
      const img = new Image();
      if (typeof dataUrl === 'string' && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 800;
          canvas.height = img.naturalHeight || img.height || 800;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/jpeg', 0.95));
        } catch (err) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // =========================================================================
  // PERSISTENT STORAGE LAYER
  // =========================================================================

  // In-memory caches to guarantee 100% reliability and speed even with 50K+ photos
  const _activeSessionMap = new Map();
  const _activeSessionItemsMap = new Map();
  let _registryCache = null;

  const Storage = {
    getSessions() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.SESSIONS);
        const stored = raw ? JSON.parse(raw) : [];
        if (_activeSessionMap.size > 0) {
          const storedIds = new Set(stored.map(s => s.sessionId));
          for (const [sId, sObj] of _activeSessionMap.entries()) {
            if (!storedIds.has(sId)) {
              stored.unshift(sObj);
            }
          }
        }
        return stored;
      } catch (e) {
        console.error('[DownloadManager] Failed to load sessions:', e);
        return Array.from(_activeSessionMap.values());
      }
    },

    saveSession(session) {
      if (!session) return;
      _activeSessionMap.set(session.sessionId, session);
      try {
        const sessions = Storage.getSessions();
        const idx = sessions.findIndex(s => s.sessionId === session.sessionId);
        if (idx >= 0) {
          sessions[idx] = session;
        } else {
          sessions.unshift(session);
        }
        // Cap to recent 500 sessions for performance
        if (sessions.length > 500) sessions.length = 500;
        localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sessions));
      } catch (e) {
        // Safe degrade without throwing when storage quota is reached
      }
    },

    getSession(sessionId) {
      if (_activeSessionMap.has(sessionId)) {
        return _activeSessionMap.get(sessionId);
      }
      return Storage.getSessions().find(s => s.sessionId === sessionId) || null;
    },

    getRegistry() {
      if (_registryCache) return _registryCache;
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.REGISTRY);
        _registryCache = raw ? JSON.parse(raw) : {};
      } catch (e) {
        console.error('[DownloadManager] Failed to load registry:', e);
        _registryCache = {};
      }
      return _registryCache;
    },

    recordRegistryEntry(entry, flushImmediately = false) {
      try {
        const registry = Storage.getRegistry();
        const assetId = entry.assetId;
        if (!registry[assetId]) {
          registry[assetId] = [];
        }
        registry[assetId].push(entry);
        if (flushImmediately) {
          Storage.flushRegistry();
        }
      } catch (e) {
        console.error('[DownloadManager] Failed to record registry entry:', e);
      }
    },

    flushRegistry() {
      try {
        if (_registryCache) {
          localStorage.setItem(STORAGE_KEYS.REGISTRY, JSON.stringify(_registryCache));
        }
      } catch (e) {
        // Safe degrade when storage quota is reached
      }
    },

    isAssetPreviouslyDownloaded(assetId, targetScope = null, cachedRegistry = null) {
      const registry = cachedRegistry || Storage.getRegistry();
      const entries = registry[assetId];
      if (!entries || !entries.length) return false;
      if (!targetScope) return true;
      if (window.isNativeIOS) {
        return entries.some(e => {
          const norm = String(e.exportLocation || '').replace(/^(Pictures|Movies|Music)\//, '').replace(/\/+$/, '');
          if (targetScope === ROOT_FOLDER) {
            return norm === ROOT_FOLDER || norm === '';
          }
          return e.sourceAlbumName === targetScope || norm === `${ROOT_FOLDER}/${targetScope}`;
        });
      }
      // If targetScope is provided, check if exported to that exact scope or album
      return entries.some(e => e.sourceAlbumName === targetScope || (e.exportLocation && e.exportLocation.includes(targetScope)));
    },

    getItems(sessionId) {
      if (_activeSessionItemsMap.has(sessionId)) {
        return _activeSessionItemsMap.get(sessionId);
      }
      try {
        const raw = localStorage.getItem(`${STORAGE_KEYS.ITEMS}_${sessionId}`);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        return [];
      }
    },

    saveItems(sessionId, items) {
      if (!sessionId || !items) return;
      _activeSessionItemsMap.set(sessionId, items);
      try {
        // Strip huge dataUrls to prevent QuotaExceededError and keep lightweight metadata
        const session=Storage.getSession(sessionId);
        const lightweight = items.slice(0, 300).map((it,index) => ({
          id: it.id,
          sessionId: it.sessionId,
          assetId: it.assetId,
          sourceAlbumId: it.sourceAlbumId,
          sourceAlbumName: it.sourceAlbumName,
          filename: it.filename,
          status: isWaitingItemCancelled(session,it,index) ? 'cancelled' : it.status,
          destination: it.destination,
          error: it.error,
          startedAt: it.startedAt,
          completedAt: it.completedAt,
          fileSize: it.fileSize || 0
        }));
        localStorage.setItem(`${STORAGE_KEYS.ITEMS}_${sessionId}`, JSON.stringify(lightweight));
      } catch (e) {
        // In-memory store is fully preserved, safe to ignore persistent quota
      }
    },

    getBatchCounters() {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.BATCH_COUNTERS);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },

    // Atomic Batch Number Allocation per date/scope (e.g. 001, 002, 003)
    async allocateNextBatchNumber(dateStr, scopeKey = 'gallery') {
      return new Promise((resolve) => {
        _batchAllocationLock = _batchAllocationLock.then(() => {
          const counters = Storage.getBatchCounters();
          const fullKey = `${scopeKey}_${dateStr}`;
          const current = (counters[fullKey] || 0) + 1;
          counters[fullKey] = current;
          try {
            localStorage.setItem(STORAGE_KEYS.BATCH_COUNTERS, JSON.stringify(counters));
          } catch (e) {
            console.error('[DownloadManager] Error saving batch counters:', e);
          }
          const batchStr = String(current).padStart(3, '0');
          resolve(batchStr);
        });
      });
    }
  };

  // =========================================================================
  // CORE DOWNLOAD SERVICE
  // =========================================================================

  function snapshotExportPhoto(photo) {
    // Share immutable media bytes; copy only export inputs, not the full catalog record.
    const snapshot = {};
    for (const key of ['id','displayName','originalFilename','mediaType','fileBlob','fileSize','videoUrl','dataUrl',
      'originalDataUrl','lastEditedAt','gradient','category','trimStart','trimEnd','isMuted','muteAudioOnExport',
      'audioRemoved','sharedVideoSource']) if (photo[key] !== undefined) snapshot[key] = photo[key];
    if (photo.tarEntry) snapshot.tarEntry = { ...photo.tarEntry };
    if (photo.zipEntry) snapshot.zipEntry = { ...photo.zipEntry };
    if (photo.videoCrop) snapshot.videoCrop = { ...photo.videoCrop, normBox: photo.videoCrop.normBox ? { ...photo.videoCrop.normBox } : undefined };
    if (photo.videoResize) snapshot.videoResize = { ...photo.videoResize };
    if (photo.videoLooks) snapshot.videoLooks = JSON.parse(JSON.stringify(photo.videoLooks));
    return snapshot;
  }

  function isWaitingItemCancelled(session,item,index) {
    return !!session && index>=session.cancelWaitingFrom && index<session.cancelWaitingTo && ['pending','failed'].includes(item.status);
  }

  function publishDownload(session, progressCurrent = null, finished = false) {
    if (typeof window.VideoDownloadUI?.update !== 'function') return false;
    const total = session.selectedAssetCount || 0;
    const saved = session.successfulCount || 0, failed = session.failedCount || 0, cancelled = session.cancelledCount || 0;
    const progress = Number.isFinite(progressCurrent) ? progressCurrent : saved + failed + cancelled;
    let status = session.status === 'downloading' ? 'saving' : session.status;
    if (status === 'cancelled' && _runningBulkSession === session && !finished) status = 'saving';
    const only = total === 1 ? Storage.getItems(session.sessionId)[0] : null;
    const name = session.sourceAlbumName || (only && (only.photoRef?.displayName || only.filename)) || downloadText('download_history_gallery','Gallery');
    window.VideoDownloadUI.update({
      id: 'bulk:' + session.sessionId, kind: session.sourceType === 'album' ? 'album' : 'media', attempt: session.attempt || 0,
      name, status, progress: total ? Math.min(finished ? 1 : .999, progress / total) : 0,
      totalCount: total, savedCount: saved, failedCount: failed, cancelledCount: cancelled,
      path: session.exportDisplayPath || 'Pictures/' + session.destinationRelativePath.replace(/^Pictures\//,''),
      onCancel: () => DownloadManager.cancelSession(session.sessionId),
      onRetry: failed || session.status === 'failed' ? () => DownloadManager.retrySession(session.sessionId) : null,
      getItems: (offset,limit) => DownloadManager.getItemPage(session.sessionId,offset,limit),
      onCancelItem: itemId => DownloadManager.cancelItem(session.sessionId,itemId)
    });
    return true;
  }

  function queuePreparation(prepare) {
    const preparation={cancelled:false,onCancel:null};
    _pendingPreparations.add(preparation);
    const request = _preparationQueue.then(async () => {
      if(preparation.cancelled)return {completion:Promise.resolve(null)};
      const next = await prepare(preparation);
      if (!next || preparation.cancelled) return { completion: Promise.resolve(null) };
      const completions = [];
      if (next.options?.sourceType === 'multi_album') {
        for (const album of next.options.albums || []) {
          if(preparation.cancelled)break;
          if (!album.photos?.length) continue;
          const session = await createDownloadSession({ ...next.options, ...album, sourceType:'album', albums:undefined },null,preparation);
          if(session)completions.push(enqueueBulkSession(session));
        }
      } else {
        const session = await createDownloadSession(next.options,next.retrySessionId,preparation);
        if (session) completions.push(enqueueBulkSession(session));
      }
      return { completion: Promise.all(completions) };
    }).finally(()=>_pendingPreparations.delete(preparation));
    // Preparation and duplicate decisions are ordered, but a running export never blocks adding another job.
    _preparationQueue = request.then(()=>undefined,()=>undefined);
    return request.then(result=>result.completion);
  }

  function enqueueBulkSession(session) {
    if (_bulkWaiters.has(session.sessionId)) return _bulkWaiters.get(session.sessionId).promise;
    if (session.status === 'cancelled') { DownloadManager.finishProgressModal(session); return Promise.resolve(session); }
    session.status = 'queued';
    _bulkFinished.delete(session.sessionId);
    Storage.saveSession(session);
    DownloadManager.showProgressModal(session);
    let resolve;
    const promise = new Promise(done=>{resolve=done;});
    _bulkWaiters.set(session.sessionId,{promise,resolve});
    _bulkQueue.push(session);
    void runBulkQueue();
    return promise;
  }

  async function runBulkQueue() {
    if (_runningBulkSession) return;
    while (_bulkQueue.length) {
      const session = _bulkQueue.shift();
      if (session.status === 'cancelled') continue;
      _runningBulkSession = _activeSession = session;
      _isCancelled = false;
      session.status = 'downloading';
      Storage.saveSession(session);
      DownloadManager.showProgressModal(session);
      try { await DownloadManager.processSessionItems(session); }
      catch (error) {
        session.error = error?.message || 'Export failed';
        if (session.status !== 'cancelled') session.status = 'failed';
        Storage.saveSession(session);
        DownloadManager.finishProgressModal(session);
      } finally {
        _runningBulkSession = null;
        if (_activeSession === session) _activeSession = null;
        const waiter = _bulkWaiters.get(session.sessionId);
        _bulkWaiters.delete(session.sessionId);
        waiter?.resolve(session);
      }
    }
  }

  async function createDownloadSession(options, retrySessionId = null, preparation = null) {
    if (retrySessionId) {
      const retry = Storage.getSession(retrySessionId);
      if (!retry) return null;
      if (_bulkWaiters.has(retrySessionId)) return retry;
      retry.attempt = (retry.attempt || 0) + 1;
      retry.status = 'queued';
      retry.error = null;
      retry.waitingCount=retry.failedCount||0;
      return retry;
    }
    const now = new Date(), localDate = getLocalDateDDMMYY(now), localTime = getLocalTime12Hour(now);
    const sourceType = options.sourceType || 'gallery', sessionId = generateSessionId();
    const albumName = sourceType === 'album' ? options.albumName || null : null;
    const cleanAlbum = albumName ? sanitizeAlbumName(albumName) : null;
    const batchNumber = await Storage.allocateNextBatchNumber(localDate,cleanAlbum ? `album_${cleanAlbum}` : 'gallery');
    if(preparation?.cancelled)return null;
    const destinationRelativePath = cleanAlbum ? `${ROOT_FOLDER}/${cleanAlbum}/` : `${ROOT_FOLDER}/`;
    const photos = options.photos || [];
    const session = { sessionId, sourceType, sourceAlbumId:options.albumId || null, sourceAlbumName:albumName,
      createdAt:Date.now(), localDate, localTime, batchNumber, selectedAssetCount:photos.length,
      successfulCount:0, failedCount:0, cancelledCount:0, waitingCount:photos.length, status:'preparing', destinationRelativePath,
      exportDisplayPath:destinationRelativePath, albumBatches:{} };
    const items = [], usedNames = new Set(), directories = new Set();
    Storage.saveSession(session);
    // Register the same growing array once so queued rows and Cancel are available during preparation.
    _activeSessionItemsMap.set(sessionId,items);
    DownloadManager.showProgressModal(session);
    await new Promise(resolve=>setTimeout(resolve,0));
    let lastYield = performance.now();
    for (let index=0;index<photos.length;index++) {
      if (session.status === 'cancelled') break;
      const photo = photos[index], rawName = photo.displayName || photo.originalFilename || `Photo_${index+1}`;
      const mime=photo.mediaType ? photo.mediaType+'/' : window.NativeDownloads?.mediaInfo?.(photo)?.mime || 'image/';
      const directory=mime.startsWith('video/')?'Movies':mime.startsWith('audio/')?'Music':'Pictures';
      if(!directories.has(directory)) {
        directories.add(directory);
        session.exportDisplayPath=window.isNativeIOS
          ? 'Files › On My iPhone › '+destinationRelativePath
          : [...directories].map(name=>name+'/'+destinationRelativePath).join(' · ');
      }
      items.push({ id:`item_${sessionId}_${index}`, sessionId, assetId:photo.id || `asset_${Date.now()}_${index}`,
        sourceAlbumId:options.albumId || null, sourceAlbumName:albumName,
        filename:resolveDeterministicCollision(formatExportFileName(localDate,batchNumber,index+1,rawName),usedNames),
        status:'pending', destination:destinationRelativePath, dataUrl:photo.dataUrl || null, photoRef:snapshotExportPhoto(photo),
        error:null, startedAt:null, completedAt:null, fileSize:0 });
      if ((index&127)===127 && performance.now()-lastYield>8) {
        await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();
      }
    }
    Storage.saveItems(sessionId,items);
    if(session.status !== 'cancelled') session.status='queued';
    Storage.saveSession(session);
    return session;
  }

  const DownloadManager = {
    // Expose helpers & Storage for testability and inspection
    Storage,
    getLocalDateDDMMYY,
    getLocalTime12Hour,
    sanitizeAlbumName,
    isWaitingItemCancelled,

    /**
     * Primary entry point for ALL download actions in the app.
     * 
     * Supported options:
     * - sourceType: 'gallery' | 'album' | 'multi_album'
     * - photos: Array of photo objects [{ id, displayName, dataUrl, ... }]
     * - albumName: string (optional, for 'album')
     * - albumId: string (optional)
     * - albums: Array of { albumName, photos } (for 'multi_album')
     * - bypassDuplicateCheck: boolean (optional, true when user clicks "Download All")
     */
    async startDownload(options) {
      if (!options) return;
      return queuePreparation(async preparation => {
        const sourceType = options.sourceType || 'gallery';
        const groups = sourceType === 'multi_album' ? (options.albums || []) : [{
          photos: Array.isArray(options.photos) ? options.photos : [], albumName: options.albumName
        }];
        const valid = p => p && (p.dataUrl || p.gradient || p.id);
        let totalCount = 0, duplicatesCount = 0, lastYield = performance.now();
        const newPhotos = [], newAlbums = [];
        const registry = options.bypassDuplicateCheck ? null : Storage.getRegistry();
        const targetScope = sourceType === 'album' ? sanitizeAlbumName(options.albumName) : (sourceType === 'multi_album' ? 'Albums' : ROOT_FOLDER);

        // On iOS, verify candidate registry entries against actual files on disk in
        // Files › On My iPhone › PicShelf/ so deleted or legacy entries never falsely report "Already downloaded".
        if (window.isNativeIOS && registry && typeof window.AndroidApp?.verifyDownloadedFiles === 'function') {
          const candidateRefs = [];
          const candidatePayload = [];
          const seenAssets = new Set();
          for (const group of groups) {
            const photos = Array.isArray(group.photos) ? group.photos : [];
            for (let index = 0; index < photos.length; index++) {
              const photo = photos[index];
              if (!valid(photo) || seenAssets.has(photo.id)) continue;
              seenAssets.add(photo.id);
              const entries = registry[photo.id];
              if (!entries || !entries.length) continue;
              for (let ei = 0; ei < entries.length; ei++) {
                const e = entries[ei];
                candidateRefs.push({ assetId: photo.id, entry: e });
                candidatePayload.push({
                  savedUri: e.savedUri || null,
                  exportLocation: e.exportLocation || `${ROOT_FOLDER}/`,
                  filename: e.filename || ''
                });
              }
            }
          }
          if (candidatePayload.length > 0) {
            try {
              const verified = await window.AndroidApp.verifyDownloadedFiles(JSON.stringify(candidatePayload));
              if (Array.isArray(verified) && verified.length === candidateRefs.length) {
                const staleSet = new Set();
                for (let vi = 0; vi < verified.length; vi++) {
                  if (verified[vi] !== true) staleSet.add(candidateRefs[vi].entry);
                }
                if (staleSet.size > 0) {
                  let mutated = false;
                  for (const assetId of seenAssets) {
                    const list = registry[assetId];
                    if (!list || !list.length) continue;
                    const kept = list.filter(e => !staleSet.has(e));
                    if (kept.length !== list.length) {
                      mutated = true;
                      if (kept.length > 0) registry[assetId] = kept;
                      else delete registry[assetId];
                    }
                  }
                  if (mutated) Storage.flushRegistry();
                }
              }
            } catch (_) {}
          }
        }
        for (const group of groups) {
          const fresh = [], scope = sourceType === 'multi_album' && group.albumName ? sanitizeAlbumName(group.albumName) : targetScope;
          const photos = Array.isArray(group.photos) ? group.photos : [];
          for (let index = 0; index < photos.length; index++) {
            if(preparation.cancelled)return null;
            const photo = photos[index];
            if (valid(photo)) {
              totalCount++;
              if (options.bypassDuplicateCheck) break;
              if (Storage.isAssetPreviouslyDownloaded(photo.id, scope, registry)) duplicatesCount++;
              else if (sourceType === 'multi_album') fresh.push(photo);
              else newPhotos.push(photo);
            }
            if ((index & 511) === 511 && performance.now() - lastYield > 8) {
              await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now();
            }
          }
          if (options.bypassDuplicateCheck && totalCount) break;
          if (fresh.length) newAlbums.push({ ...group, photos: fresh });
        }
        if (!totalCount) {
          window.showToast?.(downloadText('download_no_media', 'No media selected to download'));
          return;
        }
        if (duplicatesCount) {
          const newCount = totalCount - duplicatesCount;
          return new Promise(resolve => {
            preparation.onCancel=()=>{document.getElementById('downloadDuplicateCancelBtn')?.click();resolve(null);};
            DownloadManager.showDuplicateModal({
            totalCount, duplicatesCount, newCount,
            onDownloadNewOnly: () => {
              if (!newCount) {
                window.showToast?.(downloadText('download_all_duplicates_notice', 'All selected media has already been downloaded.'));
                resolve(null);
                return;
              }
              const next = { ...options, photos: newPhotos, bypassDuplicateCheck: true };
              if (sourceType === 'multi_album') next.albums = newAlbums;
              resolve({options:next});
            },
            onDownloadAll: () => resolve({options:{ ...options, bypassDuplicateCheck: true }}),
            onCancel: () => resolve(null)
            });
          });
        }
        return {options};
      });
    },

    /**
     * Executes a validated download session.
     */
    async executeSession(options, retrySessionId = null) {
      if (!options && !retrySessionId) return;
      return queuePreparation(async()=>({options,retrySessionId}));
    },

    /**
     * Iterates and exports all items in a session safely.
     */
    async processSessionItems(session) {
      if (window.NativeDownloads && typeof window.AndroidApp?.executeDownloadChunk === 'function') {
        return window.NativeDownloads.process(session);
      }
      const items = Storage.getItems(session.sessionId);
      const pendingItems = items.filter(i => i.status === 'pending' || i.status === 'failed');
      const total = items.length;
      session.waitingCount ??= Math.max(0,total-(session.successfulCount||0)-(session.cancelledCount||0));
      session.nextItemIndex=0;

      let successCount = session.successfulCount || 0;
      let failedCount = session.failedCount || 0;

      // Check if native Android bridge is available
      const hasNativeAndroid = (window.AndroidApp && (typeof window.AndroidApp.executeDownloadItem === 'function' || typeof window.AndroidApp.executeDownloadBatch === 'function'));

      let lastUiUpdate = Date.now();
      const isHugeBatch = total > 100;
      const uiUpdateInterval = isHugeBatch ? 35 : 0; // ms throttle for 60fps UI

      for (let i = 0; i < pendingItems.length; i++) {
        if (_isCancelled) {
          session.status = 'cancelled';
          session.successfulCount = successCount;
          session.failedCount = failedCount;
          Storage.flushRegistry();
          Storage.saveSession(session);
          DownloadManager.updateProgressModal(session, i, total, 'Cancelled');
          DownloadManager.finishProgressModal(session);
          return;
        }

        const item = pendingItems[i];
        const itemIndex=Number(String(item.id).slice(`item_${session.sessionId}_`.length));
        session.nextItemIndex=itemIndex+1;
        if(isWaitingItemCancelled(session,item,itemIndex))break;
        if(item.status==='cancelled')continue;
        session.waitingCount=Math.max(0,(session.waitingCount||0)-1);
        item.startedAt = Date.now();
        item.status = 'downloading';

        try {
          let rawDataUrl = item.dataUrl;
          if (item.photoRef && (!rawDataUrl || rawDataUrl.startsWith('data:image/svg')) && (item.photoRef.zipEntry || item.photoRef.tarEntry)) {
            if (typeof window.resolveZipPhotoDataUrl === 'function') {
              try {
                rawDataUrl = await window.resolveZipPhotoDataUrl(item.photoRef);
              } catch (_) {}
            }
          }
          if (!rawDataUrl && item.photoRef) {
            rawDataUrl = item.photoRef.dataUrl || (typeof window.generateGradientImage === 'function' && item.photoRef.gradient ? window.generateGradientImage(item.photoRef.displayName, item.photoRef.category, item.photoRef.gradient) : null);
          }

          // Ensure valid JPEG dataUrl (converting SVGs/gradients if needed)
          let validDataUrl = await ensureJpegDataUrl(rawDataUrl);
          if (!validDataUrl && rawDataUrl) validDataUrl = rawDataUrl;
          if(session.status==='cancelled')break;
          if(item.cancelRequested){item.status='cancelled';item.cancelRequested=false;session.cancelledCount=(session.cancelledCount||0)+1;continue;}

          if (hasNativeAndroid) {
            let itemOk = false;
            let itemErr = null;
            const dataToPass = validDataUrl || rawDataUrl;
            if (typeof window.AndroidApp.executeDownloadItem === 'function') {
              const itemPayload = {
                sessionId: session.sessionId,
                assetId: item.assetId,
                fileName: item.filename,
                relativePath: item.destination,
                dataUrl: dataToPass,
                index: i + 1,
                total: total
              };
              itemOk = window.AndroidApp.executeDownloadItem(JSON.stringify(itemPayload));
              if (!itemOk) itemErr = 'Native write failed';
            } else {
              // Batch fallback
              const singleBatch = {
                sessionId: session.sessionId,
                sourceType: session.sourceType,
                destinationRelativePath: session.destinationRelativePath,
                items: [{
                  assetId: item.assetId,
                  displayName: item.filename.replace(/\.jpg$/, ''),
                  fileName: item.filename,
                  dataUrl: dataToPass,
                  relativePath: item.destination
                }]
              };
              window.AndroidApp.executeDownloadBatch(JSON.stringify(singleBatch));
              itemOk = true;
            }

            if (itemOk) {
              item.status = 'completed';
              item.completedAt = Date.now();
              successCount++;
              Storage.recordRegistryEntry({
                assetId: item.assetId,
                originalIdentifier: item.assetId,
                contentHash: computeQuickHash(dataToPass),
                filename: item.filename,
                sourceType: session.sourceType,
                sourceAlbumId: item.sourceAlbumId,
                sourceAlbumName: item.sourceAlbumName,
                sessionId: session.sessionId,
                exportLocation: item.destination,
                exportTimestamp: Date.now(),
                fileSize: item.fileSize || 0
              }, false);
            } else {
              item.status = 'failed';
              item.error = itemErr || 'Write failed';
              failedCount++;
            }
          } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.auraBridge) {
            // iOS bridge
            const payload = {
              action: 'executeDownloadBatch',
              sessionId: session.sessionId,
              sourceType: session.sourceType,
              albumName: item.sourceAlbumName || session.sourceAlbumName,
              items: [{
                assetId: item.assetId,
                displayName: item.filename,
                dataUrl: validDataUrl || rawDataUrl,
                albumName: item.sourceAlbumName
              }]
            };
            window.webkit.messageHandlers.auraBridge.postMessage(payload);
            item.status = 'completed';
            item.completedAt = Date.now();
            successCount++;
          } else {
            // Browser / Desktop Web Fallback
            let blob = null;
            const dataToPass = validDataUrl || rawDataUrl;
            if (dataToPass && (dataToPass.startsWith('data:') || dataToPass.startsWith('blob:'))) {
              if (typeof window.convertToJpegBlob === 'function') {
                const converted = await window.convertToJpegBlob(dataToPass, 0.95, false);
                blob = converted.blob;
              } else if (typeof window.dataUrlToBlob === 'function') {
                blob = window.dataUrlToBlob(dataToPass);
              }
            } else if (dataToPass) {
              try {
                const resp = await fetch(dataToPass);
                if (resp.ok) {
                  blob = await resp.blob();
                }
              } catch (fetchErr) {
                console.warn('[DownloadManager] Fetch fallback error:', fetchErr);
              }
            }
            if (blob && (item.isMuted || item.muteAudioOnExport) && typeof window.stripAudioFromMediaBuffer === 'function') {
              try {
                const bBuf = await blob.arrayBuffer();
                const sBuf = window.stripAudioFromMediaBuffer(bBuf, item.filename);
                blob = new Blob([sBuf], { type: blob.type || 'video/mp4' });
              } catch (e) {
                console.warn('[DownloadManager] stripAudio error:', e);
              }
            }

            if (blob && typeof window.saveAs === 'function') {
              window.saveAs(blob, item.filename);
            } else if (typeof window.triggerBrowserDownload === 'function') {
              window.triggerBrowserDownload(blob || dataToPass, item.filename);
            }

            item.status = 'completed';
            item.completedAt = Date.now();
            item.fileSize = blob ? blob.size : (dataToPass ? Math.round(dataToPass.length * 0.75) : 0);
            successCount++;

            Storage.recordRegistryEntry({
              assetId: item.assetId,
              originalIdentifier: item.assetId,
              contentHash: computeQuickHash(dataToPass),
              filename: item.filename,
              sourceType: session.sourceType,
              sourceAlbumId: item.sourceAlbumId,
              sourceAlbumName: item.sourceAlbumName,
              sessionId: session.sessionId,
              exportLocation: item.destination,
              exportTimestamp: Date.now(),
              fileSize: item.fileSize
            }, false);
          }
        } catch (err) {
          item.status = 'failed';
          item.error = err ? err.message : 'Write failed';
          failedCount++;
          console.error('[DownloadManager] Error downloading item:', item.filename, err);
        }

        const now = Date.now();
        const isLastItem = (i === pendingItems.length - 1);
        session.successfulCount = successCount;
        session.failedCount = failedCount;

        if (isLastItem || (now - lastUiUpdate >= uiUpdateInterval)) {
          lastUiUpdate = now;
          DownloadManager.updateProgressModal(session, i + 1, total, item.status === 'completed' ? `Saved ${item.filename}` : `Failed ${item.filename}`);
          if (i % 250 === 0 || isLastItem) {
            Storage.saveSession(session);
            Storage.saveItems(session.sessionId, items);
          }
        }

        // Cooperative non-blocking yield to keep browser completely responsive
        if (isHugeBatch) {
          if (i % 30 === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        } else {
          await new Promise(r => setTimeout(r, 15));
        }
      }

      session.successfulCount = successCount;
      session.failedCount = failedCount;
      if (session.status !== 'cancelled') session.status = session.cancelledCount
        ? (session.successfulCount || session.failedCount ? 'partial' : 'cancelled')
        : session.failedCount === 0 ? 'completed' : (session.successfulCount > 0 ? 'partial' : 'failed');

      Storage.flushRegistry();
      Storage.saveSession(session);
      Storage.saveItems(session.sessionId, items);

      DownloadManager.finishProgressModal(session);
    },

    // =========================================================================
    // NATIVE BRIDGE CALLBACKS
    // =========================================================================

    onNativeItemProgress(sessionId, assetId, success, error, index, total) {
      const session = Storage.getSession(sessionId);
      if (!session) return;
      const items = Storage.getItems(sessionId);
      const item = items.find(i => i.assetId === assetId);

      if (item) {
        item.status = success ? 'completed' : 'failed';
        item.error = error || null;
        item.completedAt = Date.now();
        if (success) {
          Storage.recordRegistryEntry({
            assetId: item.assetId,
            originalIdentifier: item.assetId,
            contentHash: computeQuickHash(item.dataUrl),
            filename: item.filename,
            sourceType: session.sourceType,
            sourceAlbumId: item.sourceAlbumId,
            sourceAlbumName: item.sourceAlbumName,
            sessionId: session.sessionId,
            exportLocation: item.destination,
            exportTimestamp: Date.now(),
            fileSize: item.fileSize || 0
          });
        }
        session.successfulCount = items.filter(it => it.status === 'completed').length;
        session.failedCount = items.filter(it => it.status === 'failed').length;
        Storage.saveItems(sessionId, items);
        Storage.saveSession(session);
      }

      DownloadManager.updateProgressModal(session, index, total, success
        ? downloadText('download_saved_file', 'Saved: {name}', { name: item ? item.filename : '' })
        : downloadText('download_failed_reason', 'Failed: {error}', { error: error || '' }));
    },

    onNativeSessionFinished(sessionId, successCount, failedCount) {
      const session = Storage.getSession(sessionId);
      if (!session) return;
      const items = Storage.getItems(sessionId);
      session.successfulCount = items.length > 0 ? items.filter(it => it.status === 'completed').length : successCount;
      session.failedCount = items.length > 0 ? items.filter(it => it.status === 'failed').length : failedCount;
      if (session.status !== 'cancelled') session.status = session.failedCount === 0 ? 'completed' : (session.successfulCount > 0 ? 'partial' : 'failed');
      Storage.saveSession(session);
      DownloadManager.finishProgressModal(session);
    },

    getItemPage(sessionId, offset = 0, limit = 25) {
      const session = Storage.getSession(sessionId), items = Storage.getItems(sessionId);
      const start = Math.max(0,Math.floor(Number(offset)||0)), count = Math.max(1,Math.min(50,Math.floor(Number(limit)||25)));
      return { total: session?.selectedAssetCount || items.length, items: items.slice(start,start+count).map((item,index)=>({
        id:item.id, name:item.photoRef?.displayName || item.filename,
        status: isWaitingItemCancelled(session,item,start+index) || session?.status === 'cancelled' && _runningBulkSession !== session && ['pending','downloading'].includes(item.status) ? 'cancelled' : item.status,
        progress:item.progress, cancelRequested:!!item.cancelRequested
      })) };
    },

    hasWaitingDownloads() {
      if(window.NativeDownloads?.hasWaitingDownloads?.())return true;
      for(const preparation of _pendingPreparations)if(!preparation.cancelled)return true;
      for(const session of _activeSessionMap.values())if(['queued','preparing'].includes(session.status)||session.status==='downloading'&&session.waitingCount>0)return true;
      return false;
    },

    cancelWaitingDownloads() {
      // Capture before yielding. New requests and already admitted work are not affected.
      const preparations=[..._pendingPreparations].filter(preparation=>!preparation.cancelled);
      const sessions=[..._activeSessionMap.values()].filter(session=>['queued','preparing','downloading'].includes(session.status));
      let cancelled=window.NativeDownloads?.cancelWaitingDownloads?.()||0;
      for(const preparation of preparations){preparation.cancelled=true;preparation.onCancel?.();}
      for(const session of sessions){
        if(session!==_runningBulkSession){
          if(['queued','preparing'].includes(session.status)){
            cancelled+=session.waitingCount||0;
            DownloadManager.cancelSession(session.sessionId);
          }
          continue;
        }
        const count=session.waitingCount||0;
        if(count){
          session.cancelWaitingFrom=session.nextItemIndex||0;
          session.cancelWaitingTo=Storage.getItems(session.sessionId).length;
          session.waitingCount=0;
          session.cancelledCount=(session.cancelledCount||0)+count;
          cancelled+=count;
          Storage.saveSession(session);
          Storage.saveItems(session.sessionId,Storage.getItems(session.sessionId));
        }
        publishDownload(session);
      }
      return cancelled;
    },

    cancelItem(sessionId, itemId) {
      const session=Storage.getSession(sessionId);
      if(!session || !['queued','preparing','downloading'].includes(session.status))return false;
      const prefix=`item_${sessionId}_`, index=String(itemId).startsWith(prefix)?Number(String(itemId).slice(prefix.length)):-1;
      const item=Number.isSafeInteger(index)&&index>=0?Storage.getItems(sessionId)[index]:null;
      if(!item || item.id!==itemId || !['pending','downloading'].includes(item.status) || item.cancelRequested || isWaitingItemCancelled(session,item,index))return false;
      if(item.status==='pending') {
        item.status='cancelled';item.completedAt=Date.now();
        session.cancelledCount=(session.cancelledCount||0)+1;
        session.waitingCount=Math.max(0,(session.waitingCount||0)-1);
      } else {
        item.cancelRequested=true;
        if(typeof window.NativeDownloads?.cancelItem==='function')window.NativeDownloads.cancelItem(session,item);
      }
      Storage.saveSession(session);
      Storage.saveItems(sessionId,Storage.getItems(sessionId));
      publishDownload(session);
      return true;
    },

    cancelSession(sessionId) {
      const session=Storage.getSession(sessionId);
      if(!session || !['queued','preparing','downloading'].includes(session.status))return false;
      session.status='cancelled';
      session.waitingCount=0;
      Storage.saveSession(session);
      if(_runningBulkSession===session) {
        _isCancelled=true;
        window.NativeDownloads?.cancelSession?.(session);
        window.AndroidApp?.cancelDownloadSession?.(sessionId);
        publishDownload(session);
      } else {
        session.cancelledCount=Math.max(0,session.selectedAssetCount-(session.successfulCount||0)-(session.failedCount||0));
        const queued=_bulkQueue.indexOf(session);if(queued>=0)_bulkQueue.splice(queued,1);
        Storage.saveSession(session);
        DownloadManager.finishProgressModal(session);
        const waiter=_bulkWaiters.get(sessionId);_bulkWaiters.delete(sessionId);waiter?.resolve(session);
      }
      return true;
    },

    cancelActiveSession() {
      const session=_progressWidgetSession || _activeSession;
      if(session)DownloadManager.cancelSession(session.sessionId);
      const cancelBtn = document.getElementById('downloadProgressCancelBtn');
      if (cancelBtn) cancelBtn.disabled = true;
      const title = document.getElementById('downloadProgressTitle');
      if (title) {
        title.dataset.i18n = 'download_cancelling';
        title.textContent = downloadText('download_cancelling', 'Cancelling…');
      }
      updateProgressWidget();
    },

    retrySession(sessionId) {
      DownloadManager.closeProgressModal();
      return DownloadManager.executeSession(null, sessionId);
    },

    // =========================================================================
    // UI MODALS: DUPLICATE RESOLUTION & PROGRESS
    // =========================================================================

    showDuplicateModal({ totalCount, duplicatesCount, newCount, onDownloadNewOnly, onDownloadAll, onCancel }) {
      const modal = document.getElementById('downloadDuplicateModal');
      if (!modal) {
        // Fallback: if modal DOM not loaded yet, download new only by default
        onDownloadNewOnly();
        return;
      }

      const totalEl = document.getElementById('duplicateModalTotalText');
      const dupsEl = document.getElementById('duplicateModalDupsText');
      const newEl = document.getElementById('duplicateModalNewText');

      if (totalEl) totalEl.textContent = downloadText('download_dup_selected', 'Selected: {count}', { count: displayCount(totalCount) });
      if (dupsEl) dupsEl.textContent = downloadText('download_dup_already', 'Already downloaded: {count}', { count: displayCount(duplicatesCount) });
      if (newEl) newEl.textContent = downloadText('download_dup_new', 'New: {count}', { count: displayCount(newCount) });

      const newOnlyBtn = document.getElementById('downloadNewOnlyBtn');
      const allBtn = document.getElementById('downloadAllDuplicatesBtn');
      const cancelBtn = document.getElementById('downloadDuplicateCancelBtn');
      const closeBtn = document.getElementById('downloadDuplicateCloseBtn');
      let settled=false, closeObserver=null;
      const choose=action=>{
        if(settled)return;settled=true;closeObserver?.disconnect();
        modal.style.display='none';action?.();
      };

      if (newOnlyBtn) {
        newOnlyBtn.onclick = () => {
          choose(onDownloadNewOnly);
        };
      }
      if (allBtn) {
        allBtn.onclick = () => {
          choose(onDownloadAll);
        };
      }
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          choose(onCancel);
        };
      }
      if(closeBtn)closeBtn.onclick=()=>choose(onCancel);

      modal.style.display = 'flex';
      if(typeof MutationObserver==='function') {
        closeObserver=new MutationObserver(()=>{if(modal.style.display==='none')choose(onCancel);});
        closeObserver.observe(modal,{attributes:true,attributeFilter:['style']});
      }
    },

    showProgressModal(session) {
      if(publishDownload(session)) {
        const old=document.getElementById('downloadProgressModal');if(old)old.style.display='none';
        return;
      }
      const modal = document.getElementById('downloadProgressModal');
      if (!modal) return;
      prepareProgressWidget(modal, session);

      const titleEl = document.getElementById('downloadProgressTitle');
      const pathEl = document.getElementById('downloadProgressPath');
      const countEl = document.getElementById('downloadProgressCount');
      const barEl = document.getElementById('downloadProgressBarFill');
      const successEl = document.getElementById('downloadProgressSuccessPill');
      const failedEl = document.getElementById('downloadProgressFailedPill');
      const retryBtn = document.getElementById('downloadProgressRetryBtn');
      const doneBtn = document.getElementById('downloadProgressDoneBtn');
      const cancelBtn = document.getElementById('downloadProgressCancelBtn');
      const iconWrap = modal.querySelector('.download-progress-icon-wrap');

      const fullPath = session.exportDisplayPath || (session.destinationRelativePath.startsWith('Pictures/')
        ? session.destinationRelativePath
        : `Pictures/${session.destinationRelativePath}`);

      if (iconWrap) {
        iconWrap.innerHTML = '<i class="fa-solid fa-cloud-arrow-down" style="color: #38bdf8; font-size: 26px;"></i>';
      }
      if (titleEl) {
        titleEl.dataset.i18n = 'download_exporting';
        titleEl.textContent = downloadText('download_exporting', 'Exporting media…');
      }
      if (pathEl) pathEl.textContent = fullPath;
      if (countEl) countEl.textContent = downloadText('download_count', '{current} of {total}', { current: displayCount(0), total: displayCount(session.selectedAssetCount) });
      if (barEl) barEl.style.width = '0%';
      if (successEl) successEl.textContent = downloadText('download_saved_count', 'Saved: {count}', { count: displayCount(0) });
      const statusEl = document.getElementById('downloadProgressStatusText');
      if (statusEl) statusEl.textContent = downloadText('download_preparing', 'Preparing media for storage…');
      if (failedEl) failedEl.style.display = 'none';
      if (retryBtn) retryBtn.style.display = 'none';
      if (doneBtn) doneBtn.style.display = 'none';
      if (cancelBtn) { cancelBtn.style.display = 'inline-flex'; cancelBtn.disabled = false; }

      _progressWidgetCounts = { current: 0, total: session.selectedAssetCount };
      modal.style.display = 'flex';
      updateProgressWidget();
    },

    updateProgressModal(session, current, total, statusText = '', progressCurrent = current) {
      if(publishDownload(session,progressCurrent))return;
      if (_progressWidgetSession && _progressWidgetSession.sessionId !== session.sessionId) return;
      const countEl = document.getElementById('downloadProgressCount');
      const barEl = document.getElementById('downloadProgressBarFill');
      const successEl = document.getElementById('downloadProgressSuccessPill');
      const failedEl = document.getElementById('downloadProgressFailedPill');
      const statusEl = document.getElementById('downloadProgressStatusText');

      const pathEl = document.getElementById('downloadProgressPath');
      if (pathEl && session.exportDisplayPath) pathEl.textContent = session.exportDisplayPath;
      const progress = Number.isFinite(progressCurrent) ? progressCurrent : current;
      const percent = total > 0 ? Math.min(current < total ? 99 : 100, Math.round((progress / total) * 100)) : 0;
      if (countEl) countEl.textContent = downloadText('download_count', '{current} of {total}', { current: displayCount(current), total: displayCount(total) });
      if (barEl) barEl.style.width = `${percent}%`;
      if (successEl) successEl.textContent = downloadText('download_saved_count', 'Saved: {count}', { count: displayCount(session.successfulCount) });
      if (statusEl && statusText) statusEl.textContent = localizedStatus(statusText);

      if (failedEl) {
        if (session.failedCount > 0) {
          failedEl.style.display = 'inline-flex';
          failedEl.textContent = downloadText('download_failed_count', 'Failed: {count}', { count: displayCount(session.failedCount) });
        } else {
          failedEl.style.display = 'none';
        }
      }
      _progressWidgetCounts = { current, total };
      if (statusText) _progressWidgetStatusText = statusText;
      updateProgressWidget();
    },

    finishProgressModal(session) {
      if(session.status==='cancelled') {
        session.cancelledCount=Math.max(0,(session.selectedAssetCount||0)-(session.successfulCount||0)-(session.failedCount||0));
        Storage.saveSession(session);
      }
      if(typeof window.VideoDownloadUI?.update==='function') {
        if(_bulkFinished.has(session.sessionId))return;
        _bulkFinished.add(session.sessionId);
        publishDownload(session,null,true);
        if(session.status!=='cancelled') {
          const path=session.exportDisplayPath || 'Pictures/'+session.destinationRelativePath.replace(/^Pictures\//,'');
          let text=session.status==='completed'
            ? downloadText('download_saved_path','Export complete! Saved to {path}',{path})
            : downloadText('download_summary','Saved: {saved}. Failed: {failed}.',{saved:displayCount(session.successfulCount),failed:displayCount(session.failedCount)});
          if(session.cancelledCount)text+=' '+downloadText('video_download_cancelled_count','Cancelled: {count}',{count:displayCount(session.cancelledCount)});
          window.showToast?.(text);
        }
        return;
      }
      if (_progressWidgetSession && _progressWidgetSession.sessionId !== session.sessionId) return;
      const modal = document.getElementById('downloadProgressModal');
      const titleEl = document.getElementById('downloadProgressTitle');
      const pathEl = document.getElementById('downloadProgressPath');
      const barEl = document.getElementById('downloadProgressBarFill');
      const cancelBtn = document.getElementById('downloadProgressCancelBtn');
      const doneBtn = document.getElementById('downloadProgressDoneBtn');
      const retryBtn = document.getElementById('downloadProgressRetryBtn');
      const statusEl = document.getElementById('downloadProgressStatusText');
      const countEl = document.getElementById('downloadProgressCount');
      const successEl = document.getElementById('downloadProgressSuccessPill');
      const failedEl = document.getElementById('downloadProgressFailedPill');
      const iconWrap = modal ? modal.querySelector('.download-progress-icon-wrap') : null;

      const savedCount = session.successfulCount || 0;
      const totalCount = session.selectedAssetCount || savedCount;
      const cancelled = session.status === 'cancelled';
      const fullPath = session.exportDisplayPath || (session.destinationRelativePath.startsWith('Pictures/')
        ? session.destinationRelativePath
        : `Pictures/${session.destinationRelativePath}`);

      if (pathEl) pathEl.textContent = fullPath;
      if (barEl) barEl.style.width = cancelled ? `${totalCount ? Math.min(100, Math.round(savedCount / totalCount * 100)) : 0}%` : '100%';
      if (countEl) countEl.textContent = downloadText('download_count', '{current} of {total}', { current: displayCount(savedCount), total: displayCount(totalCount) });
      if (successEl) successEl.textContent = downloadText('download_saved_count', 'Saved: {count}', { count: displayCount(savedCount) });

      if (cancelBtn) cancelBtn.style.display = 'none';
      if (doneBtn) {
        doneBtn.style.display = 'inline-flex';
        doneBtn.innerHTML = '<i class="fa-solid fa-check" style="margin-right: 6px;"></i><span data-i18n="download_done">' + escapeText(downloadText('download_done', 'Done')) + '</span>';
      }

      if (cancelled) {
        if (failedEl) failedEl.style.display = 'none';
        if (titleEl) {
          titleEl.dataset.i18n = 'download_cancelled';
          titleEl.textContent = downloadText('download_cancelled', 'Download cancelled');
        }
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-ban" style="color: #94a3b8; font-size: 28px;"></i>';
        if (statusEl) statusEl.textContent = downloadText('download_saved_library', 'Media saved to your device: {count}.', { count: displayCount(savedCount) });
        if (retryBtn) retryBtn.style.display = 'none';
      } else if (session.failedCount > 0) {
        if (failedEl) {
          failedEl.style.display = 'inline-flex';
          failedEl.textContent = downloadText('download_failed_count', 'Failed: {count}', { count: displayCount(session.failedCount) });
        }
        if (titleEl) {
          titleEl.dataset.i18n = 'download_warning_title';
          titleEl.textContent = downloadText('download_warning_title', 'Export finished with errors');
        }
        if (iconWrap) {
          iconWrap.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color: #f59e0b; font-size: 28px;"></i>';
        }
        if (statusEl) {
          statusEl.textContent = downloadText('download_summary', 'Saved: {saved}. Failed: {failed}.', { saved: displayCount(savedCount), failed: displayCount(session.failedCount) });
        }
        if (retryBtn) {
          retryBtn.style.display = 'inline-flex';
          retryBtn.textContent = downloadText('download_retry_count', 'Retry failed ({count})', { count: displayCount(session.failedCount) });
          retryBtn.onclick = () => DownloadManager.retrySession(session.sessionId);
        }
      } else {
        if (failedEl) failedEl.style.display = 'none';
        if (titleEl) {
          titleEl.dataset.i18n = 'download_complete_title';
          titleEl.textContent = downloadText('download_complete_title', 'Export complete! ✨');
        }
        if (iconWrap) {
          iconWrap.innerHTML = '<i class="fa-solid fa-circle-check" style="color: #10b981; font-size: 30px;"></i>';
        }
        if (statusEl) {
          statusEl.textContent = downloadText('download_saved_library', 'Media saved to your device: {count}.', { count: displayCount(savedCount) });
        }
        if (retryBtn) retryBtn.style.display = 'none';
      }

      _progressWidgetCounts = { current: savedCount, total: totalCount };
      _progressWidgetFinished = true;
      updateProgressWidget();
      if (typeof window.showToast === 'function') {
        const msg = cancelled ? downloadText('download_cancelled', 'Download cancelled') : session.failedCount === 0
          ? `📥 ${downloadText('download_saved_path', 'Export complete! Saved to {path}', { path: fullPath })}`
          : `⚠️ ${downloadText('download_summary', 'Saved: {saved}. Failed: {failed}.', { saved: displayCount(session.successfulCount), failed: displayCount(session.failedCount) })}`;
        window.showToast(msg);
      }
      if (cancelled && _progressCancelledTimer == null && modal?.style.display !== 'none') {
        const cancelledSession = _progressWidgetSession;
        _progressCancelledTimer = setTimeout(() => {
          _progressCancelledTimer = null;
          if (_progressWidgetSession === cancelledSession && cancelledSession?.status === 'cancelled') DownloadManager.closeProgressModal();
        }, 3000);
      }
    },

    closeProgressModal() {
      const modal = document.getElementById('downloadProgressModal');
      if (modal) modal.style.display = 'none';
      _progressWidgetObserver?.disconnect();
      _progressWidgetObserver = null;
      clearTimeout(_progressCancelledTimer); _progressCancelledTimer = null;
      stopObservingProgressToast();
    },

    // =========================================================================
    // HISTORY VIEWER (Section 18)
    // =========================================================================

    getHistory() {
      const sessions = Storage.getSessions();
      return sessions.map(s => {
        let label = downloadText('download_history_gallery', 'Gallery');
        if (s.sourceType === 'album' && s.sourceAlbumName) {
          label = s.sourceAlbumName;
        } else if (s.sourceType === 'multi_album') {
          label = downloadText('download_history_multi', 'Multiple albums');
        }
        return {
          sessionId: s.sessionId,
          dateFormatted: `${s.localDate} · ${s.localTime}`,
          countText: downloadText('download_history_count', 'Items: {count}', { count: displayCount(s.successfulCount || s.selectedAssetCount) }),
          sourceText: label,
          batchText: downloadText('download_history_batch', 'Batch {number}', { number: s.batchNumber }),
          destination: s.exportDisplayPath || `Pictures/${s.destinationRelativePath}`,
          status: s.status
        };
      });
    },

    openHistoryModal() {
      const modal = document.getElementById('downloadHistoryModal');
      const listEl = document.getElementById('downloadHistoryList');
      if (!modal || !listEl) return;
      const history = DownloadManager.getHistory();
      if (history.length === 0) {
        listEl.innerHTML = `
          <div class="download-history-empty" style="text-align: center; padding: 24px; color: rgba(255,255,255,0.5); font-size: 13px;">
            <i class="fa-solid fa-cloud-arrow-down" style="font-size: 28px; opacity: 0.3; margin-bottom: 8px; display: block;"></i>
            ${escapeText(downloadText('download_history_empty', 'No downloads yet'))}
          </div>
        `;
      } else {
        listEl.innerHTML = history.map(item => `
          <div class="download-history-item">
            <div class="download-history-row">
              <span class="download-history-date">${escapeText(item.dateFormatted)}</span>
              <span class="download-history-batch">${escapeText(item.batchText)}</span>
            </div>
            <div class="download-history-sub">
              <span><strong>${escapeText(item.countText)}</strong></span>
              <span>•</span>
              <span>${escapeText(item.sourceText)}</span>
              <span>•</span>
              <span data-download-status="${escapeText(item.status)}" style="color: ${item.status === 'completed' ? '#10b981' : (item.status === 'failed' ? '#ef4444' : '#f59e0b')}; text-transform: capitalize;">${escapeText(downloadText(item.status === 'queued' ? 'video_download_queued' : item.status === 'preparing' ? 'download_preparing' : 'download_status_' + item.status, item.status))}</span>
            </div>
            <div class="download-history-dest" title="${escapeText(item.destination)}">
              ${escapeText(item.destination)}
            </div>
          </div>
        `).join('');
      }
      modal.style.display = 'flex';
    }
  };

  // Expose globally
  window.DownloadManager = DownloadManager;

})(window);
