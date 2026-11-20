/* Settings > Export Backup / Import Backup.
 *
 * Export Backup makes one file with every photo, video and audio file in the library together
 * with how the library is organized: albums, favorites, Dock / Gallery / Trash status, names,
 * dates, places, edits and saved clips. The page lists the media and the library index; the
 * file itself (Download/PicShelf/PicShelf-backup-<date>.picshelf) is written by a background
 * job that keeps running when PicShelf is closed and shows its progress in a notification.
 *
 * Import works like Google Photos and iPhone restores: media already in the library is never
 * duplicated or replaced. Each backup item is matched to an item that is already here (by id,
 * then one-to-one by original file name, size and type); for those only what is missing is
 * added (albums, favorites, saved and trashed status, names). Items that are not here are
 * restored with their photos and videos, in the screens they were on. Nothing is deleted or
 * moved to Trash, a preview comes first and Undo afterwards. The media is copied in the
 * background as well; if PicShelf is closed meanwhile, the restore finishes when it is opened.
 *
 * Backups made by earlier versions (organization only, no media) are still imported.
 */
(() => {
  'use strict';

  const FORMAT = 'picshelf-library-backup';
  // Schema 5 rows are arrays in COLUMNS order. Ids and names are front-coded: a row keeps the
  // length of the prefix it shares with the previous row's value, then the rest. Schema 3 used
  // one object per row (still imported); schema 4 was never released. Schema 6 is the full
  // backup: whole library items whose media is referenced by entry number.
  const SCHEMA = 6;
  const FULL_SCHEMA = 6;
  const ORGANIZATION_SCHEMA = 5;
  const COLUMNS = ['idShared', 'idRest', 'nameShared', 'nameRest', 'kindFlags', 'fileSize', 'tags', 'extra'];
  const KINDS = ['image', 'video', 'audio'];
  const FLAG_DOCK = 1, FLAG_FAVORITE = 2, FLAG_TRASH = 4, FLAG_CLIP = 8;
  const EXTENSION = '.picshelf';
  const ROWS_PER_LINE = 2048;
  const WRITE_CHUNK = 1 << 20;
  const READ_CHUNK = 1 << 20;
  const MAX_LINE = 64 << 20;
  const MAX_FILE = 1536 << 20;
  const MAX_RECORDS = 5000000;
  const SLICE_MS = 16;
  // Full backup: media the page holds itself is copied through the bridge in base64 chunks.
  const INLINE_DATA = 128 * 1024;       // data: URLs up to this many characters stay in the index
  const INLINE_COVER = 16 * 1024;       // album covers are kept smaller: they are all in one line
  const STAGE_BYTES = 3 * 1024 * 1024;  // bytes per bridge call while staging a Blob
  const STAGE_CHARS = 4 * 1024 * 1024;  // base64 characters per bridge call while staging a data: URL
  const PLAN_BATCH = 4096;
  const INDEX_LINE = 1 << 20;
  const POLL_MS = 700;
  const HELD_PARALLEL = 4;
  const THEMES = ['dark', 'light', 'system'];
  const HEX = /^#[0-9a-f]{6}$/i;
  const ANY_HEX = /^#[0-9a-f]{3,8}$/i;
  const STYLE = /^[a-z0-9_-]{1,32}$/i;
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  const CONTROL_TEST = new RegExp('[\\u0000-\\u001f\\u007f' + String.fromCharCode(0x2028, 0x2029) + ']');
  // Text new to this library is shown by page templates; never let it become markup or code.
  const RISKY = {
    '<': String.fromCharCode(0x2039), '>': String.fromCharCode(0x203a), '"': String.fromCharCode(0x201d),
    "'": String.fromCharCode(0x2019), '`': String.fromCharCode(0x02cb), '\\': String.fromCharCode(0x2216)
  };
  const RISKY_TEST = /[<>"'`\\]/;
  const VIRTUAL = /^https:\/\/picshelf-(thumbnails|originals)\.invalid\/([^/?#]+)\/((?:video-|metadata-)?)(tar|zip)\/(\d+)\/(\d+)\/(\d+)([^#]*)$/;
  const SAFE_DATA = /^data:(?:image|video|audio)\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*;base64,[A-Za-z0-9+/]*={0,2}$/i;
  const SAFE_ASSET = /^assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
  const URL_KEY = /(?:url|uri|src|poster)$/i;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
  const SKIP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const EMPTY = Object.freeze([]);
  const UNSET = Object.freeze({});
  const CANCELLED = new Error('cancelled');

  class BackupError extends Error {
    constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
  }

  const el = id => document.getElementById(id);
  const t = (key, params) => (typeof window.t === 'function' ? window.t(key, params) : key);
  const bridge = () => window.AndroidApp;
  const native = name => typeof window.AndroidApp?.[name] === 'function';
  const fullNative = () => native('libraryBackupExportBegin') && native('libraryBackupStatus');
  const locale = () => document.documentElement.lang || window.state?.language || 'en';
  const fmt = value => { try { return new Intl.NumberFormat(locale()).format(value); } catch (_) { return String(value); } };
  const toast = message => { if (typeof window.showToast === 'function') window.showToast(message); };
  const parse = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; } };
  const libraryReady = () => window.libraryStartupReady === true && Array.isArray(window.state?.photos);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  // Timer clamping must not stretch a large backup; a message port still yields to input.
  const tasks = [];
  const port = new MessageChannel();
  port.port1.onmessage = () => tasks.shift()?.();
  const yieldTask = () => new Promise(resolve => { tasks.push(resolve); port.port2.postMessage(null); });

  // idle | export (listing media) | job (background job shown) | read | confirm | apply |
  // finish (adding restored items) | result | message
  let phase = 'idle';
  let cancelRequested = false;
  let pickPending = false;
  let restoreBack = null;
  let actions = { primary: null, secondary: null, dismiss: null };
  let storageWaiter = null;
  let notificationWaiter = null;
  let notificationsAsked = false;
  let watchTimer = null;
  let watchedJob = '';
  let finishing = false;
  const failedFinish = new Set();

  // ---------------------------------------------------------------- dialog

  function setText(id, value) { const node = el(id); if (node) node.textContent = value || ''; }
  function showText(id, value) { const node = el(id); if (node) { node.textContent = value || ''; node.hidden = !value; } }
  function setButton(id, spec) {
    const node = el(id);
    if (!node) return;
    node.hidden = !spec;
    node.textContent = spec ? spec.label : '';
  }

  function setProgress(fraction) {
    const box = el('libraryBackupProgress'), bar = el('libraryBackupProgressBar');
    if (!box || !bar) return;
    const percent = fraction === null || fraction === undefined || !Number.isFinite(fraction)
      ? null : Math.max(0, Math.min(100, Math.round(fraction * 100)));
    box.classList.toggle('indeterminate', percent === null);
    bar.style.width = percent === null ? '' : percent + '%';
    box.setAttribute('aria-valuenow', String(percent ?? 0));
  }

  function render(spec) {
    const dialog = el('libraryBackupDialog');
    if (!dialog) return;
    setText('libraryBackupDialogEyebrow', spec.eyebrow);
    setText('libraryBackupDialogTitle', spec.title);
    showText('libraryBackupDialogText', spec.text);
    const progress = el('libraryBackupProgress');
    if (progress) progress.hidden = spec.progress === undefined;
    if (spec.progress !== undefined) setProgress(spec.progress);
    showText('libraryBackupDialogLabel', spec.label);
    const list = el('libraryBackupSummary');
    if (list) {
      const parts = spec.parts || [];
      list.replaceChildren(...parts.map(text => {
        const item = document.createElement('li');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-check';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = text;
        item.append(icon, label);
        return item;
      }));
      list.hidden = !parts.length;
    }
    showText('libraryBackupDialogNote', spec.note);
    showText('libraryBackupDialogNote2', spec.note2);
    const body = el('libraryBackupDialogBody');
    if (body) body.scrollTop = 0;
    setButton('libraryBackupDialogPrimary', spec.primary);
    setButton('libraryBackupDialogSecondary', spec.secondary);
    const buttons = el('libraryBackupDialogButtons');
    if (buttons) buttons.hidden = !spec.primary && !spec.secondary;
    actions = { primary: spec.primary?.run || null, secondary: spec.secondary?.run || null, dismiss: spec.dismiss || closeDialog };
    if (dialog.style.display !== 'flex') {
      dialog.style.display = 'flex';
      if (!restoreBack) {
        // Android Back acts like the dialog's close button before anything else.
        const previous = window.handleNativeBackPressed;
        const handler = function () { dismiss(); return true; };
        window.handleNativeBackPressed = handler;
        restoreBack = () => { if (window.handleNativeBackPressed === handler) window.handleNativeBackPressed = previous; };
      }
    }
  }

  function closeDialog() {
    const dialog = el('libraryBackupDialog');
    if (dialog) dialog.style.display = 'none';
    if (restoreBack) { restoreBack(); restoreBack = null; }
    actions = { primary: null, secondary: null, dismiss: null };
    phase = 'idle';
  }

  function dismiss() {
    if (phase === 'apply' || phase === 'finish') return;
    (actions.dismiss || closeDialog)();
  }

  function bindDialog() {
    el('libraryBackupDialogPrimary')?.addEventListener('click', () => actions.primary?.());
    el('libraryBackupDialogSecondary')?.addEventListener('click', () => actions.secondary?.());
    el('libraryBackupDialogClose')?.addEventListener('click', dismiss);
  }

  const cancelWork = () => { cancelRequested = true; };

  // ---------------------------------------------------------------- shared helpers

  function kindOf(photo) {
    if (KINDS.includes(photo?.mediaType)) return photo.mediaType;
    try { const kind = window.screenMediaKind?.(photo); if (KINDS.includes(kind)) return kind; } catch (_) {}
    return 'image';
  }

  function sizeOf(photo) {
    const size = Number(photo.fileSize || photo.size || 0);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  function sourceNameOf(photo) { return photo.zipEntry?.baseName || photo.tarEntry?.baseName || photo.displayName; }
  function nameKey(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
  function cleanText(value, max) { return typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, max) : ''; }
  function safeText(value) { return value.replace(/[<>"'`\\]/g, character => RISKY[character]); }

  function hasLocation(photo) {
    const location = photo.location;
    return !!(location && typeof location === 'object' &&
      (typeof location.latitude === 'number' || location.place || location.city || location.country));
  }

  // Same units as Android's Files app and the backup notification (1 GB = 1000 MB).
  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
    let unit = 0, amount = value;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
    try {
      return new Intl.NumberFormat(locale(), { style: 'unit', unit: units[unit], unitDisplay: 'short',
        maximumFractionDigits: unit >= 3 ? 1 : 0 }).format(amount);
    } catch (_) {
      return (unit >= 3 ? amount.toFixed(1) : Math.round(amount)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
    }
  }

  // ---------------------------------------------------------------- permissions

  function requestStorage() {
    return new Promise(resolve => {
      const timer = setTimeout(() => { storageWaiter = null; resolve(false); }, 120000);
      storageWaiter = granted => { clearTimeout(timer); storageWaiter = null; resolve(!!granted); };
      try { bridge().libraryBackupRequestStorage(); } catch (_) { storageWaiter(false); }
    });
  }

  // Progress and "finished" notifications (Android 13+ asks once). The work runs either way.
  function askNotifications() {
    if (notificationsAsked || !native('libraryBackupRequestNotifications')) return Promise.resolve();
    try { if (bridge().libraryBackupNotificationsAllowed()) return Promise.resolve(); } catch (_) { return Promise.resolve(); }
    notificationsAsked = true;
    return new Promise(resolve => {
      const timer = setTimeout(() => { notificationWaiter = null; resolve(); }, 120000);
      notificationWaiter = () => { clearTimeout(timer); notificationWaiter = null; resolve(); };
      try { bridge().libraryBackupRequestNotifications(); } catch (_) { notificationWaiter(); }
    });
  }

  function notificationCopy() {
    return JSON.stringify({
      channelProgress: t('backup_notify_channel_progress'), channelDone: t('backup_notify_channel_done'),
      exportTitle: t('backup_notify_export'), restoreTitle: t('backup_notify_restore'),
      progress: '{percent}%', cancel: t('backup_cancel'),
      exportDoneTitle: t('backup_saved_title'), exportDoneText: t('backup_saved_body', { folder: '{folder}', name: '{name}' }),
      restoreDoneTitle: t('backup_notify_restore_done'), restoreDoneText: t('backup_notify_restore_done_text'),
      failedTitle: t('backup_failed_title'), failedText: t('backup_notify_failed_text'), spaceText: t('backup_failed_space')
    });
  }

  // ---------------------------------------------------------------- export (organization only)
  // Used where no background job is available (the page outside the Android app).

  function pad(value) { return String(value).padStart(2, '0'); }

  function fileName() {
    const now = new Date();
    return `PicShelf-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${EXTENSION}`;
  }

  function appVersion() {
    try { return String(parse(bridge()?.getAppUpdateState?.() || '').versionName || '').slice(0, 40); } catch (_) { return ''; }
  }

  function exportAlbum(album) {
    if (!album || typeof album.name !== 'string' || !album.name.trim()) return null;
    const out = { name: album.name };
    if (typeof album.color === 'string') out.color = album.color;
    for (const key of ['createdAt', 'lastModifiedAt', 'lastViewedAt']) if (Number.isFinite(album[key])) out[key] = album[key];
    if (album.isFavorite === true) out.isFavorite = true;
    if (typeof album.surface3DStyle === 'string' && STYLE.test(album.surface3DStyle)) out.surface3DStyle = album.surface3DStyle;
    return out;
  }

  function exportDeletedAlbum(album) {
    if (!album || typeof album.name !== 'string' || !album.name.trim()) return null;
    const out = { name: album.name };
    if (typeof album.color === 'string') out.color = album.color;
    if (Number.isFinite(album.photoCount)) out.photoCount = album.photoCount;
    if (Number.isFinite(album.deletedAt)) out.deletedAt = album.deletedAt;
    return out;
  }

  // Length of the prefix two values share, never splitting a surrogate pair. Neighbouring
  // ids usually share as much as the previous pair did, so that length is checked natively first.
  function shared(previous, value, hint) {
    const max = Math.min(previous.length, value.length, 4095);
    let length = 0;
    if (hint > 0 && hint <= max && value.startsWith(hint === previous.length ? previous : previous.substring(0, hint))) length = hint;
    while (length < max && previous.charCodeAt(length) === value.charCodeAt(length)) length++;
    if (length > 0 && length < value.length && (value.charCodeAt(length - 1) & 0xfc00) === 0xd800) length--;
    return length;
  }

  function kindCode(photo) {
    const type = photo.mediaType;
    if (type === 'image') return 0;
    if (type === 'video') return 1;
    if (type === 'audio') return 2;
    const kind = kindOf(photo);
    return kind === 'video' ? 1 : kind === 'audio' ? 2 : 0;
  }

  // One row per item, in COLUMNS order; trailing empty columns are left out.
  function exportRow(photo, previous) {
    const id = typeof photo.id === 'string' ? photo.id : String(photo.id);
    const name = typeof photo.displayName === 'string' ? photo.displayName : '';
    const idShared = shared(previous.id, id, previous.idShared), nameShared = shared(previous.name, name, previous.nameShared);
    previous.id = id;
    previous.name = name;
    previous.idShared = idShared;
    previous.nameShared = nameShared;
    const size = photo.fileSize;
    const row = [
      idShared, id.slice(idShared), nameShared, name.slice(nameShared),
      ((photo.isPending ? FLAG_DOCK : 0) | (photo.isFavorite ? FLAG_FAVORITE : 0) | (photo.deletedAt ? FLAG_TRASH : 0) |
        (photo.sharedVideoSource ? FLAG_CLIP : 0)) + 16 * kindCode(photo),
      typeof size === 'number' && size > 0 ? size : sizeOf(photo)
    ];
    let tags = null;
    if (Array.isArray(photo.tags) && photo.tags.length) {
      tags = photo.tags.filter(tag => typeof tag === 'string' && tag);
      if (!tags.length) tags = null;
    }
    let extra = null;
    const source = photo.zipEntry?.baseName || photo.tarEntry?.baseName;
    if (typeof source === 'string' && source && source !== photo.displayName) (extra ||= {}).s = source;
    const location = photo.location;
    if (location && typeof location === 'object') {
      const out = {};
      if (Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) { out.latitude = location.latitude; out.longitude = location.longitude; }
      for (const key of ['place', 'city', 'country']) if (typeof location[key] === 'string' && location[key]) out[key] = location[key];
      if (Object.keys(out).length) (extra ||= {}).l = out;
    }
    if (typeof photo.cameraModel === 'string' && photo.cameraModel) (extra ||= {}).m = photo.cameraModel;
    if (Number.isFinite(photo.duration) && photo.duration > 0) (extra ||= {}).u = photo.duration;
    if (tags || extra) row.push(tags || []);
    if (extra) row.push(extra);
    return row;
  }

  function counts(photos) {
    let favorites = 0, saved = 0, dock = 0, trash = 0;
    for (const photo of photos) {
      if (photo.deletedAt) { trash++; continue; }
      if (photo.isFavorite) favorites++;
      if (photo.isPending) dock++; else saved++;
    }
    return { items: photos.length, favorites, saved, dock, trash };
  }

  function appearanceSettings(state) {
    const settings = { theme: state.themePref, accentColor: state.accentColor };
    if (Array.isArray(state.savedCustomColors)) settings.savedCustomColors = state.savedCustomColors.filter(color => typeof color === 'string');
    return settings;
  }

  function buildHeader(state, photos) {
    const tags = (Array.isArray(state.tags) ? state.tags : []).map(exportAlbum).filter(Boolean);
    // "photos" must stay the last key: the rows follow on the next lines.
    return {
      format: FORMAT,
      schema: ORGANIZATION_SCHEMA,
      app: 'PicShelf',
      appVersion: appVersion(),
      exportedAt: new Date().toISOString(),
      counts: { ...counts(photos), albums: tags.length },
      settings: appearanceSettings(state),
      tags,
      deletedAlbums: (Array.isArray(state.deletedAlbums) ? state.deletedAlbums : []).map(exportDeletedAlbum).filter(Boolean),
      columns: COLUMNS,
      kinds: KINDS,
      flags: { dock: FLAG_DOCK, favorite: FLAG_FAVORITE, trash: FLAG_TRASH, clip: FLAG_CLIP },
      photos: []
    };
  }

  function browserSink(name) {
    const parts = [];
    return {
      write(text) { parts.push(text); },
      async finish() {
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = name.replace(EXTENSION, '.json');
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return { ok: true, name: link.download, folder: 'Downloads' };
      },
      abort() { parts.length = 0; }
    };
  }

  async function exportOrganization() {
    phase = 'export';
    cancelRequested = false;
    const eyebrow = t('settings_export_backup');
    render({ eyebrow, title: t('backup_export_title'), text: t('backup_export_body'), progress: 0,
      secondary: { label: t('backup_cancel'), run: cancelWork }, dismiss: cancelWork });
    let sink = null;
    try {
      const state = window.state;
      const photos = state.photos.filter(photo => photo && photo.id != null);
      sink = browserSink(fileName());
      const head = JSON.stringify(buildHeader(state, photos));
      sink.write(head.slice(0, -2) + '\n');
      const total = photos.length;
      const previous = { id: '', name: '', idShared: 0, nameShared: 0 };
      let batch = [];
      let sliceStart = performance.now();
      for (let index = 0; index < total; index++) {
        batch.push(exportRow(photos[index], previous));
        if (batch.length === ROWS_PER_LINE || index + 1 === total) {
          sink.write(JSON.stringify(batch).slice(1, -1) + (index + 1 < total ? ',\n' : '\n'));
          batch = [];
          if (performance.now() - sliceStart > SLICE_MS) {
            setProgress(index / total);
            await yieldTask();
            sliceStart = performance.now();
            if (cancelRequested) throw CANCELLED;
          }
        }
      }
      sink.write(']}\n');
      if (cancelRequested) throw CANCELLED;
      setProgress(1);
      const saved = await sink.finish();
      sink = null;
      phase = 'result';
      render({ eyebrow, title: t('backup_saved_title'),
        text: t('backup_saved_body', { folder: saved.folder || 'Downloads', name: saved.name || '' }),
        note: t('backup_saved_note'), primary: { label: t('backup_done'), run: closeDialog } });
    } catch (error) {
      if (sink) sink.abort();
      if (error === CANCELLED) { closeDialog(); return; }
      console.error('Backup export failed:', error);
      phase = 'message';
      render({ eyebrow, title: t('backup_failed_title'), text: t('backup_export_failed'),
        primary: { label: t('backup_retry'), run: () => { closeDialog(); exportBackup(); } },
        secondary: { label: t('backup_close'), run: closeDialog } });
    }
  }

  // ---------------------------------------------------------------- full backup: listing (phase A)

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
    'image/avif': 'avif', 'image/heic': 'heic', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'weba',
    'application/pdf': 'pdf'
  };

  function extensionOf(name, type) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(typeof name === 'string' ? name : '');
    if (match) return match[1].toLowerCase();
    return MIME_EXT[String(type || '').split(';')[0].trim().toLowerCase()] || 'bin';
  }

  // A readable name inside the backup (it opens in archive tools, e.g. 7-Zip).
  function entryName(number, name, type) {
    let base = String(name || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
    if (base.length > 56) base = base.slice(base.length - 56).replace(/^[._-]+/, '');
    if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
      const ext = extensionOf('', type);
      if (ext !== 'bin') base = (base || 'media') + '.' + ext;
    }
    return 'media/' + String(number).padStart(7, '0') + (base ? '-' + base : '');
  }

  function readBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        resolve(text.slice(text.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('read'));
      reader.readAsDataURL(blob);
    });
  }

  function decodedLength(base64) {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor(base64.length / 4) * 3 + (base64.length % 4 ? (base64.length % 4) - 1 : 0) - padding;
  }

  // Reads the archive entry of a ZIP the page holds in memory: where its data starts.
  async function zipDataStart(zipFile, localOffset) {
    const header = new DataView(await zipFile.slice(localOffset, localOffset + 30).arrayBuffer());
    if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP header');
    return localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  }

  /**
   * Lists every media file once (clips and copies share their original's entry) and turns the
   * library into index records. Media the page holds itself is staged through the bridge.
   */
  function createListing(jobId) {
    let next = 0, mediaBytes = 0, plan = [];
    const archiveKeys = new Map();
    const heldBlobs = new WeakMap();
    const heldUrls = new Map();
    const heldData = new Map();
    const memoryKeys = new WeakMap();
    let queue = [];

    function flushPlan(force) {
      if (!plan.length || (!force && plan.length < PLAN_BATCH)) return;
      const text = JSON.stringify(plan);
      plan = [];
      if (!bridge().libraryBackupExportPlan(jobId, text)) throw new BackupError('storage');
    }

    function addEntry(entry) {
      plan.push(entry);
      mediaBytes += entry.length;
      flushPlan(false);
    }

    // Album covers can show another item's archive picture: find that item once.
    let virtualIndex = null;
    function resolveVirtual(key) {
      if (!virtualIndex) {
        virtualIndex = new Map();
        for (const photo of window.state.photos) {
          const info = photo && window.ArchiveSources?.entryInfo(photo);
          if (!info) continue;
          const item = `${info.token}|${info.kind}|${info.offset}|${info.size}|${info.method}`;
          if (!virtualIndex.has(item)) virtualIndex.set(item, photo);
        }
      }
      const photo = virtualIndex.get(key);
      return photo ? archiveOriginal(photo)?.n : undefined;
    }

    // An original in one of PicShelf's archives (most media): the job copies its bytes.
    function archiveOriginal(photo) {
      const info = window.ArchiveSources?.entryInfo(photo);
      if (!info) return null;
      const name = photo.tarEntry?.baseName || photo.zipEntry?.baseName || photo.zipEntry?.fn || photo.originalFilename || photo.displayName || '';
      const key = `${info.token}|${info.kind}|${info.offset}|${info.size}|${info.method}`;
      let number = archiveKeys.get(key);
      if (number === undefined) {
        if (info.length === null) {
          // A compressed ZIP entry of unknown size: the page reads it like an export does.
          number = next++;
          archiveKeys.set(key, number);
          queue.push({ number, original: true, name, load: () => window.ArchiveSources.originalBlob(photo) });
        } else {
          number = next++;
          archiveKeys.set(key, number);
          queue.push({ number, archive: { t: 'a', name: entryName(number, name, info.mime), source: info.token, kind: info.kind,
            offset: info.offset, size: info.size, method: info.method, length: info.length } });
        }
      }
      return { n: number, baseName: typeof name === 'string' ? name : '' };
    }

    // An entry of an archive file the page holds in memory (imports from older versions).
    function memoryOriginal(photo) {
      const tar = photo.tarEntry?.tarFile instanceof Blob ? photo.tarEntry : null;
      const zip = !tar && photo.zipEntry?.zipFile instanceof Blob ? photo.zipEntry : null;
      const entry = tar || zip;
      if (!entry) return null;
      const archive = tar ? entry.tarFile : entry.zipFile;
      const offset = tar ? entry.offset : entry.localOffset;
      const size = tar ? entry.size : entry.compSize;
      const method = tar ? 0 : entry.method;
      const length = tar ? entry.size : (Number.isSafeInteger(entry.uncompSize) ? entry.uncompSize : (method === 0 ? size : null));
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 ||
          (method !== 0 && method !== 8) || length === null) return null;
      const name = entry.baseName || entry.fn || photo.displayName || '';
      let keys = memoryKeys.get(archive);
      if (!keys) memoryKeys.set(archive, keys = new Map());
      const key = `${offset}|${size}|${method}`;
      let number = keys.get(key);
      if (number === undefined) {
        number = next++;
        keys.set(key, number);
        queue.push({ number, original: true, name, method, size, length,
          load: async () => {
            const start = tar ? offset : await zipDataStart(archive, offset);
            return archive.slice(start, start + size);
          } });
      }
      return { n: number, baseName: typeof name === 'string' ? name : '' };
    }

    function heldBlob(blob) {
      let number = heldBlobs.get(blob);
      if (number === undefined) {
        number = next++;
        heldBlobs.set(blob, number);
        queue.push({ number, blob, name: '', type: blob.type });
      }
      return number;
    }

    function heldUrl(url) {
      let number = heldUrls.get(url);
      if (number === undefined) {
        number = next++;
        heldUrls.set(url, number);
        queue.push({ number, url, name: '' });
      }
      return number;
    }

    function heldDataUrl(text) {
      let number = heldData.get(text);
      if (number === undefined) {
        number = next++;
        heldData.set(text, number);
        queue.push({ number, data: text, name: '' });
      }
      return number;
    }

    function encodeValue(value, key, ownOriginal, inlineLimit) {
      if (value === null || value === undefined) return value === null ? null : undefined;
      const type = typeof value;
      if (type === 'string') {
        if (value.startsWith('blob:')) return { $m: heldUrl(value), as: 'url' };
        if (value.startsWith('data:')) {
          const comma = value.indexOf(',');
          if (value.length > inlineLimit && comma > 0 && /;base64$/i.test(value.slice(0, comma))) {
            return { $m: heldDataUrl(value), as: 'data', prefix: value.slice(0, comma) };
          }
          return value;
        }
        if (value.startsWith('https://picshelf-')) {
          const match = VIRTUAL.exec(value);
          if (!match) return null;
          const token = (() => { try { return decodeURIComponent(match[2]); } catch (_) { return ''; } })();
          const coordinates = `${token}|${match[4]}|${match[5]}|${match[6]}|${match[7]}`;
          let number = archiveKeys.get(coordinates);
          if (number === undefined) number = resolveVirtual(coordinates);
          if (number === undefined) return null;
          return { $v: match[1], p: match[3], q: match[8], n: number };
        }
        return value;
      }
      if (type === 'number' || type === 'boolean') return value;
      if (type !== 'object') return undefined;
      if (value instanceof Blob) return { $m: heldBlob(value), as: 'blob', type: value.type };
      if (value instanceof Promise || (typeof Node === 'function' && value instanceof Node)) return undefined;
      if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let index = 0; index < value.length; index++) {
          const item = encodeValue(value[index], key, ownOriginal, inlineLimit);
          out[index] = item === undefined ? null : item;
        }
        return out;
      }
      const out = {};
      for (const name of Object.keys(value)) {
        if (SKIP_KEYS.has(name)) continue;
        const item = encodeValue(value[name], name, ownOriginal, inlineLimit);
        if (item !== undefined) out[name] = item;
      }
      return out;
    }

    // One library item as it is saved (see LibraryStore): session-only values are left out.
    function encodeRecord(photo) {
      const nativeOriginal = !!(photo.tarEntry?.nativeSourceId || photo.zipEntry?.nativeSourceId);
      const original = nativeOriginal ? archiveOriginal(photo) : memoryOriginal(photo);
      const archived = nativeOriginal || !!original;
      const edited = !!photo.lastEditedAt;
      // Playback uses the same bytes as fileBlob (the library saves them once as well).
      if (photo.fileBlob instanceof Blob && typeof photo.videoUrl === 'string' && photo.videoUrl.startsWith('blob:') &&
          !(archived && !edited) && !heldUrls.has(photo.videoUrl)) {
        heldUrls.set(photo.videoUrl, heldBlob(photo.fileBlob));
      }
      const out = {};
      for (const key of Object.keys(photo)) {
        if (key === '_globalIndex' || SKIP_KEYS.has(key)) continue;
        let value = photo[key];
        if ((key === 'tarEntry' || key === 'zipEntry') && value && typeof value === 'object') continue;
        if (archived && !edited) {
          // Archive previews are rebuilt from the original; never back them up as files.
          if (key === 'fileBlob') value = null;
          else if ((key === 'dataUrl' || key === 'thumbUrl' || key === 'videoUrl') && typeof value === 'string' &&
            (value.startsWith('blob:') || value.startsWith('https://picshelf-thumbnails.invalid/') ||
              value.startsWith('https://picshelf-originals.invalid/') || value.startsWith('picshelf-thumbnails://local/') ||
              value.startsWith('picshelf-originals://local/'))) value = null;
        }
        const encoded = encodeValue(value, key, original, INLINE_DATA);
        if (encoded !== undefined) out[key] = encoded;
      }
      if (original) out.$o = original;
      out.$k = kindOf(photo);
      return out;
    }

    function encodeAlbum(album) {
      if (!album || typeof album !== 'object' || typeof album.name !== 'string' || !album.name.trim()) return null;
      return encodeValue(album, '', null, INLINE_COVER);
    }

    async function stageBlob(number, blob, entry) {
      const size = blob.size;
      if (!bridge().libraryBackupExportStageBegin(jobId, number, size)) throw new BackupError('storage');
      let complete = true;
      try {
        for (let offset = 0; offset < size; offset += STAGE_BYTES) {
          const base64 = await readBase64(blob.slice(offset, Math.min(size, offset + STAGE_BYTES)));
          if (!bridge().libraryBackupExportStageAppend(jobId, base64)) throw new BackupError('storage');
          if (cancelRequested) throw CANCELLED;
        }
      } catch (error) {
        if (error === CANCELLED || error instanceof BackupError) throw error;
        // The bytes are gone (e.g. a file removed meanwhile): the entry is kept, marked unreadable.
        complete = false;
      }
      if (!bridge().libraryBackupExportStageEnd(jobId, complete)) throw new BackupError('storage');
      addEntry({ ...entry, stage: number, length: entry.length ?? size });
    }

    async function stageData(number, text) {
      const comma = text.indexOf(',');
      const payload = text.slice(comma + 1);
      if (!BASE64.test(payload)) {
        // Not plain base64 after all: copy its decoded bytes.
        let blob = null;
        try { blob = await (await fetch(text)).blob(); } catch (_) {}
        return stageBlob(number, blob || new Blob([]), { t: 'f', name: entryName(number, '', text.slice(5, comma)) });
      }
      const length = decodedLength(payload);
      if (!bridge().libraryBackupExportStageBegin(jobId, number, length)) throw new BackupError('storage');
      for (let offset = 0; offset < payload.length; offset += STAGE_CHARS) {
        if (!bridge().libraryBackupExportStageAppend(jobId, payload.slice(offset, offset + STAGE_CHARS))) throw new BackupError('storage');
        if (cancelRequested) throw CANCELLED;
        if (offset + STAGE_CHARS < payload.length) await yieldTask();
      }
      if (!bridge().libraryBackupExportStageEnd(jobId, true)) throw new BackupError('storage');
      addEntry({ t: 'f', name: entryName(number, '', text.slice(5, comma).split(';')[0]), stage: number, length });
    }

    // Archive entries need no reading: list them right away. True while media waits to be staged.
    function drain() {
      while (queue.length && queue[0].archive) addEntry(queue.shift().archive);
      return queue.length > 0;
    }

    // Stages queued media in entry order, so the backup lists entries by number.
    async function flushQueue() {
      while (queue.length) {
        const item = queue.shift();
        if (item.archive) { addEntry(item.archive); continue; }
        if (item.data !== undefined) { await stageData(item.number, item.data); continue; }
        let blob = item.blob || null;
        if (!blob) {
          try {
            blob = item.url ? await (await fetch(item.url)).blob() : await item.load();
          } catch (_) { blob = null; }
        }
        const name = entryName(item.number, item.name, blob?.type || item.type);
        if (!(blob instanceof Blob)) {
          // Unreadable: the slot stays (shorter than listed, so it is marked unreadable).
          await stageBlob(item.number, new Blob([]), { t: 'f', name, length: Math.max(1, item.length || 0) });
          continue;
        }
        const entry = { t: 'f', name };
        if (item.method === 8) { entry.method = 8; entry.size = blob.size; entry.length = item.length; }
        await stageBlob(item.number, blob, entry);
      }
      if (cancelRequested) throw CANCELLED;
    }

    return {
      encodeRecord, encodeAlbum, flushQueue, drain,
      finish() { drain(); flushPlan(true); },
      get entries() { return next; },
      get bytes() { return mediaBytes; },
      get pending() { return queue.length > 0; }
    };
  }

  async function exportBackup() {
    if (phase === 'job' || phase === 'finish') return;
    if (phase !== 'idle' || pickPending) { toast(t('backup_busy')); return; }
    if (!libraryReady()) { toast(t('backup_library_loading')); return; }
    if (!fullNative()) { exportOrganization(); return; }
    const active = jobStatus();
    if (showActiveJob(active)) return;
    phase = 'export';
    cancelRequested = false;
    const eyebrow = t('settings_export_backup');
    const state = window.state;
    // One consistent list; the dialog keeps the library from being edited meanwhile.
    const photos = state.photos.filter(photo => photo && photo.id != null);
    render({ eyebrow, title: t('backup_export_title'), text: t('backup_full_preparing', { count: fmt(photos.length) }), progress: null,
      secondary: { label: t('backup_cancel'), run: cancelWork }, dismiss: cancelWork });
    await askNotifications();
    let jobId = '';
    try {
      if (cancelRequested) throw CANCELLED;
      let started = parse(bridge().libraryBackupExportBegin(fileName(), notificationCopy()));
      if (!started.ok && started.error === 'permission' && native('libraryBackupRequestStorage')) {
        if (!(await requestStorage())) throw new BackupError('permission');
        started = parse(bridge().libraryBackupExportBegin(fileName(), notificationCopy()));
      }
      if (!started.ok || !started.id) throw new BackupError(started.error || 'storage');
      jobId = started.id;
      const listing = createListing(jobId);
      let indexParts = [], indexSize = 0;
      const writeIndex = (text, force) => {
        indexParts.push(text);
        indexSize += text.length;
        if (indexSize >= INDEX_LINE || force) {
          const chunk = indexParts.join('');
          indexParts = []; indexSize = 0;
          if (!bridge().libraryBackupExportIndex(jobId, chunk)) throw new BackupError('storage');
        }
      };
      const tags = (Array.isArray(state.tags) ? state.tags : []).map(listing.encodeAlbum).filter(Boolean);
      const header = {
        format: FORMAT, schema: FULL_SCHEMA, kind: 'full', app: 'PicShelf', appVersion: appVersion(),
        exportedAt: new Date().toISOString(),
        counts: { ...counts(photos), albums: tags.length },
        settings: appearanceSettings(state),
        tags,
        deletedAlbums: listing.encodeAlbum({ name: '-', list: Array.isArray(state.deletedAlbums) ? state.deletedAlbums : [] })?.list || [],
        favoritesCustomCover: typeof state.favoritesCustomCover === 'string' && state.favoritesCustomCover
          ? listing.encodeAlbum({ name: '-', cover: state.favoritesCustomCover })?.cover ?? null : null,
        favorites3DStyle: typeof state.favorites3DStyle === 'string' && STYLE.test(state.favorites3DStyle) ? state.favorites3DStyle : null,
        kinds: KINDS,
        photos: []
      };
      await listing.flushQueue();
      const head = JSON.stringify(header);
      writeIndex(head.slice(0, -2) + '\n');
      const total = photos.length;
      let line = [], lineSize = 0;
      let sliceStart = performance.now();
      for (let index = 0; index < total; index++) {
        const record = listing.encodeRecord(photos[index]);
        if (listing.drain()) await listing.flushQueue();
        const text = JSON.stringify(record);
        line.push(text);
        lineSize += text.length;
        if (lineSize >= INDEX_LINE || line.length >= ROWS_PER_LINE || index + 1 === total) {
          writeIndex(line.join(',') + (index + 1 < total ? ',\n' : '\n'));
          line = []; lineSize = 0;
        }
        if (performance.now() - sliceStart > SLICE_MS) {
          setProgress(index / total);
          await yieldTask();
          sliceStart = performance.now();
          if (cancelRequested) throw CANCELLED;
        }
      }
      writeIndex(']}\n', true);
      listing.finish();
      if (cancelRequested) throw CANCELLED;
      setProgress(1);
      const queued = parse(bridge().libraryBackupExportStart(jobId));
      if (!queued.ok) {
        jobId = '';
        throw new BackupError(queued.error || 'storage', queued.needed);
      }
      watchedJob = queued.id || started.id;
      showJob(jobStatus());
    } catch (error) {
      if (jobId) { try { bridge().libraryBackupExportAbort(jobId); } catch (_) {} }
      if (error === CANCELLED) { closeDialog(); return; }
      console.error('Backup export failed:', error);
      phase = 'message';
      if (error?.code === 'space') {
        render({ eyebrow, title: t('backup_space_title'), text: t('backup_space_body', { size: formatBytes(error.detail || 0) }),
          primary: { label: t('backup_close'), run: closeDialog } });
        return;
      }
      if (error?.code === 'busy') { closeDialog(); toast(t('backup_busy')); return; }
      render({ eyebrow, title: t('backup_failed_title'),
        text: error?.code === 'permission' ? t('backup_permission') : t('backup_export_failed'),
        primary: { label: t('backup_retry'), run: () => { closeDialog(); exportBackup(); } },
        secondary: { label: t('backup_close'), run: closeDialog } });
    }
  }

  // ---------------------------------------------------------------- background jobs (phase B)

  function jobStatus() {
    if (!native('libraryBackupStatus')) return {};
    try { return parse(bridge().libraryBackupStatus()); } catch (_) { return {}; }
  }

  const activeState = state => state === 'queued' || state === 'running' || state === 'cancelling' || state === 'preparing';

  // Opening Export or Import while a backup or restore runs shows that job instead.
  function showActiveJob(status) {
    if (!status?.id) return false;
    if (status.type === 'restore' && status.state === 'done') { finishRestore(status.id); return true; }
    if (!activeState(status.state) || status.state === 'preparing') return false;
    if (status.state === 'cancelling') { toast(t('backup_busy')); return true; }
    watchedJob = status.id;
    showJob(status);
    return true;
  }

  function jobProgress(status) {
    const total = Number(status.total) || 0, done = Math.min(total, Number(status.done) || 0);
    return { fraction: total > 0 ? done / total : null,
      label: total > 0 ? t('backup_full_size', { done: formatBytes(done), total: formatBytes(total) }) : '' };
  }

  function showJob(status) {
    const restore = status.type === 'restore';
    phase = 'job';
    const progress = jobProgress(status);
    render({
      eyebrow: t(restore ? 'settings_import_backup' : 'settings_export_backup'),
      title: t(restore ? 'backup_restoring_title' : 'backup_running_title'),
      text: t(restore ? 'backup_restoring_body' : 'backup_running_body'),
      progress: progress.fraction, label: progress.label,
      primary: { label: t('backup_background'), run: closeDialog },
      secondary: { label: t('backup_cancel'), run: () => cancelJob(status.id, restore) },
      dismiss: closeDialog
    });
    watch();
  }

  function cancelJob(id, restore) {
    try { bridge().libraryBackupCancel(id); } catch (_) {}
    closeDialog();
    toast(t(restore ? 'backup_restore_stopped' : 'backup_stopped'));
    watch();
  }

  // Follows the job while PicShelf is open; the notification covers the rest.
  function watch() {
    if (watchTimer) return;
    watchTimer = setInterval(poll, POLL_MS);
  }

  function stopWatching() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  function poll() {
    if (document.visibilityState === 'hidden') return;
    const status = jobStatus();
    if (!status.id || (watchedJob && status.id !== watchedJob)) {
      stopWatching();
      if (phase === 'job') closeDialog();
      return;
    }
    if (activeState(status.state)) {
      if (phase === 'job') {
        const progress = jobProgress(status);
        setProgress(progress.fraction);
        showText('libraryBackupDialogLabel', progress.label);
      }
      return;
    }
    stopWatching();
    settle(status);
  }

  // A job reached its end while PicShelf is open (or it ended while PicShelf was closed).
  function settle(status) {
    const restore = status.type === 'restore';
    if (status.state === 'cancelled') {
      acknowledge(status.id);
      if (phase === 'job') closeDialog();
      return;
    }
    if (status.state === 'failed') {
      acknowledge(status.id);
      if (phase !== 'idle' && phase !== 'job') return;
      phase = 'message';
      const text = status.error === 'space' ? t('backup_failed_space')
        : status.error === 'source' ? t('backup_failed_source')
          : restore ? t('backup_read_failed') : t('backup_export_failed');
      render({ eyebrow: t(restore ? 'settings_import_backup' : 'settings_export_backup'),
        title: t(restore ? 'backup_not_restored_title' : 'backup_failed_title'), text,
        primary: { label: t('backup_close'), run: closeDialog } });
      return;
    }
    if (status.state !== 'done') return;
    if (restore) { finishRestore(status.id, true); return; }
    if (phase === 'job') { showSaved(status); return; }
    if (phase !== 'idle') return;
    // Saved while its dialog was hidden: the notification has the details.
    acknowledge(status.id);
    toast(t('backup_saved_title'));
  }

  function acknowledge(id) { try { bridge().libraryBackupAcknowledge(id); } catch (_) {} }

  function showSaved(status) {
    phase = 'result';
    const result = status.result || {};
    const done = () => { acknowledge(status.id); closeDialog(); };
    const skipped = Number(result.skipped) || 0;
    render({
      eyebrow: t('settings_export_backup'),
      title: t('backup_saved_title'),
      text: t('backup_saved_body', { folder: result.folder || 'Download/PicShelf', name: result.name || '' }) +
        (result.bytes > 0 ? '\n' + formatBytes(result.bytes) : ''),
      note: t('backup_full_saved_note'),
      note2: skipped > 0 ? t('backup_skipped_note', { count: fmt(skipped) }) : '',
      primary: { label: t('backup_done'), run: done },
      secondary: native('libraryBackupShareResult')
        ? { label: t('backup_share'), run: () => { try { bridge().libraryBackupShareResult(status.id, t('backup_share_title')); } catch (_) {} } }
        : null,
      dismiss: done
    });
  }

  // ---------------------------------------------------------------- reading

  function nativeReader(opened) {
    let closed = false;
    return {
      size: Number(opened.size) || 0,
      progress() { try { return closed ? -1 : bridge().libraryBackupProgress(opened.token); } catch (_) { return -1; } },
      async read() { return closed ? '' : (bridge().libraryBackupRead(opened.token, READ_CHUNK) || ''); },
      close() {
        if (closed) return;
        closed = true;
        try { bridge().libraryBackupClose(opened.token); } catch (_) {}
      }
    };
  }

  function fileReader(file) {
    let consumed = 0, reader = null;
    async function open() {
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      let stream = file.stream().pipeThrough(new TransformStream({
        transform(chunk, controller) { consumed += chunk.byteLength; controller.enqueue(chunk); }
      }));
      if (head[0] === 0x1f && head[1] === 0x8b) {
        if (typeof DecompressionStream !== 'function') throw new BackupError('read');
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
      }
      reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    }
    return {
      size: file.size,
      progress: () => (file.size > 0 ? consumed / file.size : -1),
      async read() {
        if (!reader) await open();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return '';
          if (value) return value;
        }
      },
      close() { try { reader?.cancel().catch(() => {}); } catch (_) {} }
    };
  }

  // ---------------------------------------------------------------- matching

  function cleanLocation(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const latitude = Number(raw.latitude), longitude = Number(raw.longitude);
    if (raw.latitude !== undefined && raw.longitude !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      out.latitude = latitude; out.longitude = longitude;
    }
    for (const key of ['place', 'city', 'country']) out[key] = safeText(cleanText(raw[key], 120));
    return out.latitude !== undefined || out.place || out.city || out.country ? out : null;
  }

  function cleanAlbum(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanText(raw.name, 120);
    if (!name) return null;
    const album = { name, color: typeof raw.color === 'string' && ANY_HEX.test(raw.color) ? raw.color : '#f43f5e' };
    for (const key of ['createdAt', 'lastModifiedAt', 'lastViewedAt']) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) album[key] = value;
    }
    album.isFavorite = raw.isFavorite === true;
    if (typeof raw.surface3DStyle === 'string' && STYLE.test(raw.surface3DStyle)) album.surface3DStyle = raw.surface3DStyle;
    return album;
  }

  function hasTag(list, tag) {
    const lower = tag.toLowerCase();
    for (let index = 0; index < list.length; index++) {
      const value = list[index];
      if (value === tag || (typeof value === 'string' && value.toLowerCase() === lower)) return true;
    }
    return false;
  }

  // Counts toward the free plan's saves: in the Gallery, or a Dock item marked as a favorite.
  function counted(deletedAt, isPending, isFavorite) { return !deletedAt && (!isPending || !!isFavorite); }

  function createMatcher(header) {
    const state = window.state;
    const photos = state.photos;
    const full = header.schema === FULL_SCHEMA;
    const exportedAt = Date.parse(typeof header.exportedAt === 'string' ? header.exportedAt : '') || 0;
    const now = Date.now();
    // Rows come in library order, so most are found by comparing with the next item. An id
    // index is built only when the order no longer lines up (items added or removed since).
    const matched = new Uint8Array(photos.length);
    let cursor = 0;
    let idIndex = null;
    const idOf = photo => (typeof photo.id === 'string' ? photo.id : String(photo.id));
    function indexOfId(id) {
      for (let step = 0; step < 8 && cursor + step < photos.length; step++) {
        const photo = photos[cursor + step];
        if (photo && photo.id != null && idOf(photo) === id) return cursor + step;
      }
      if (!idIndex) {
        idIndex = new Map();
        for (let index = 0; index < photos.length; index++) {
          const photo = photos[index];
          if (photo && photo.id != null) {
            const key = idOf(photo);
            if (!idIndex.has(key)) idIndex.set(key, index);
          }
        }
      }
      const index = idIndex.get(id);
      return index === undefined ? -1 : index;
    }
    let previousId = '', previousName = '';
    let bySize = null;
    const sizeBuckets = new Map();
    const albums = new Map();
    for (const album of Array.isArray(state.tags) ? state.tags : []) {
      if (album && typeof album.name === 'string') albums.set(album.name.toLowerCase(), album);
    }
    const colors = new Map();
    for (const album of [...(Array.isArray(header.deletedAlbums) ? header.deletedAlbums : []), ...(Array.isArray(state.deletedAlbums) ? state.deletedAlbums : [])]) {
      if (album && typeof album.name === 'string' && typeof album.color === 'string' && ANY_HEX.test(album.color)) colors.set(album.name.toLowerCase(), album.color);
    }
    const plan = {
      source: photos, sourceLength: photos.length, full, header,
      exportedAt: typeof header.exportedAt === 'string' ? header.exportedAt : '',
      total: 0, matched: 0, missing: 0, invalid: 0, quotaDelta: 0,
      changes: [], albums: [], albumPins: [], appearance: null, covers: new Map(),
      fresh: [], lastMatch: null,
      counts: { trash: 0, favorites: 0, saved: 0, tagged: 0, names: 0, places: 0 }
    };

    function addAlbum(album) {
      const entry = {
        name: album.name, color: album.color || colors.get(album.name.toLowerCase()) || '#f43f5e',
        createdAt: album.createdAt || now, lastModifiedAt: album.lastModifiedAt || album.createdAt || now,
        lastViewedAt: album.lastViewedAt || 0, isFavorite: !!album.isFavorite
      };
      if (album.surface3DStyle) entry.surface3DStyle = album.surface3DStyle;
      plan.albums.push(entry);
      albums.set(entry.name.toLowerCase(), entry);
      return entry;
    }

    // Albums in the backup: missing ones are added; albums already here keep their own settings.
    for (const raw of Array.isArray(header.tags) ? header.tags : []) {
      const album = cleanAlbum(raw);
      if (!album) continue;
      const existing = albums.get(album.name.toLowerCase());
      if (existing) {
        if (album.isFavorite && !existing.isFavorite && !plan.albumPins.includes(existing) && !plan.albums.includes(existing)) plan.albumPins.push(existing);
        continue;
      }
      const entry = addAlbum({ ...album, name: safeText(album.name) });
      // A full backup also has the album's own cover picture.
      if (full && raw.customCoverUrl !== undefined && raw.customCoverUrl !== null) plan.covers.set(entry, raw.customCoverUrl);
    }

    function resolveTag(tag) {
      const existing = albums.get(tag.toLowerCase());
      return existing ? existing.name : safeText(tag);
    }

    function sameMedia(photo, kind, size, name) {
      if (kind && kind !== kindOf(photo)) return false;
      const local = sizeOf(photo);
      // The same id with different bytes is trusted only if the names agree as well.
      if (local > 0 && size > 0 && local !== size) return nameKey(photo.displayName) === nameKey(name);
      return true;
    }

    // Re-imported media has new ids: pair it one-to-one by original name, size and type.
    // Returns a library index, or -1.
    function sizeMatch(kind, size, original) {
      const key = nameKey(original);
      if (!key) return -1;
      if (!bySize) {
        bySize = new Map();
        for (let index = 0; index < photos.length; index++) {
          const photo = photos[index];
          const bytes = photo ? sizeOf(photo) : 0;
          if (!bytes) continue;
          const value = bySize.get(bytes);
          if (value === undefined) bySize.set(bytes, index);
          else if (Array.isArray(value)) value.push(index);
          else bySize.set(bytes, [value, index]);
        }
      }
      const value = bySize.get(size);
      if (value === undefined) return -1;
      if (typeof value === 'number') {
        // Most sizes belong to one item only: compare it directly.
        if (matched[value]) return -1;
        const photo = photos[value];
        if (kindOf(photo) !== kind) return -1;
        const source = sourceNameOf(photo);
        return source === original || nameKey(source) === key ? value : -1;
      }
      // Several items share this size: split them once by type and original name.
      let named = sizeBuckets.get(size);
      if (!named) {
        named = new Map();
        const list = value;
        // Media added after the backup was made cannot also match an entry by id: pair it first.
        const later = index => exportedAt > 0 && Number.isFinite(photos[index].dockAddedAt) && photos[index].dockAddedAt > exportedAt;
        for (const index of [...list.filter(later), ...list.filter(index => !later(index))]) {
          const photo = photos[index];
          const bucketKey = kindOf(photo) + '|' + nameKey(sourceNameOf(photo));
          let bucket = named.get(bucketKey);
          if (!bucket) named.set(bucketKey, bucket = { items: [], next: 0 });
          bucket.items.push(index);
        }
        sizeBuckets.set(size, named);
      }
      const bucket = named.get(kind + '|' + key);
      if (!bucket) return -1;
      while (bucket.next < bucket.items.length) {
        const index = bucket.items[bucket.next++];
        if (!matched[index]) return index;
      }
      return -1;
    }

    // Adds only what the item is missing. An unchanged item allocates nothing.
    function planItem(photo, flags, saved, name, tags, extra) {
      plan.matched++;
      const trashed = (flags & FLAG_TRASH) !== 0;
      // A backup entry that was in Trash never changes an item that is in use here.
      if (trashed && !photo.deletedAt) return;
      let set = null;
      if (!trashed && photo.deletedAt) { (set ||= {}).deletedAt = null; plan.counts.trash++; }
      if ((flags & FLAG_FAVORITE) && !photo.isFavorite) { (set ||= {}).isFavorite = true; plan.counts.favorites++; }
      if (saved && photo.isPending) { (set ||= {}).isPending = false; plan.counts.saved++; }
      if (Array.isArray(tags) && tags.length) {
        const local = Array.isArray(photo.tags) ? photo.tags : EMPTY;
        let added = null;
        for (let index = 0; index < tags.length && local.length + (added ? added.length : 0) < 500; index++) {
          const raw = tags[index];
          // Albums the item is already in (the usual case) need no cleaning or comparing.
          if (typeof raw !== 'string' || local.includes(raw)) continue;
          const tag = cleanText(raw, 120);
          if (!tag || hasTag(local, tag) || (added && hasTag(added, tag))) continue;
          const resolved = resolveTag(tag);
          if (resolved !== tag && (hasTag(local, resolved) || (added && hasTag(added, resolved)))) continue;
          (added ||= []).push(resolved);
        }
        if (added) { (set ||= {}).tags = local.concat(added); plan.counts.tagged++; }
      }
      if (typeof name === 'string' && name && name !== photo.displayName) {
        const clean = safeText(cleanText(name, 300));
        if (clean && clean !== photo.displayName) { (set ||= {}).displayName = clean; plan.counts.names++; }
      }
      if (extra && typeof extra === 'object') {
        let places = false;
        if (extra.l && !hasLocation(photo)) {
          const location = cleanLocation(extra.l);
          if (location) { (set ||= {}).location = location; places = true; }
        }
        if (extra.m && !photo.cameraModel) {
          const camera = safeText(cleanText(extra.m, 120));
          if (camera) { (set ||= {}).cameraModel = camera; places = true; }
        }
        if (places) plan.counts.places++;
      }
      if (!set) return;
      const before = counted(photo.deletedAt, photo.isPending, photo.isFavorite);
      const after = counted('deletedAt' in set ? set.deletedAt : photo.deletedAt,
        'isPending' in set ? set.isPending : photo.isPending,
        'isFavorite' in set ? set.isFavorite : photo.isFavorite);
      if (!before && after) plan.quotaDelta++;
      plan.changes.push({ item: photo, set });
    }

    // The library item a backup entry describes, or -1.
    function locate(id, kind, size, name, flags, original) {
      let index = indexOfId(id);
      if (index >= 0 && (matched[index] || !sameMedia(photos[index], kind, size, name))) index = -1;
      if (index >= 0) cursor = index + 1;
      else if (size > 0 && !(flags & FLAG_CLIP)) {
        // A saved clip shares its original's bytes: it is matched by id only.
        const source = typeof original === 'string' && original ? original : name;
        if (typeof source === 'string' && source) index = sizeMatch(kind || 'image', size, source);
      }
      return index;
    }

    function add(row) {
      if (++plan.total > MAX_RECORDS) throw new BackupError('incomplete');
      let id, name, kind, flags, size, tags, extra, saved;
      if (Array.isArray(row)) {
        const idShared = row[0], nameShared = row[2];
        if (!Number.isInteger(idShared) || idShared < 0 || idShared > previousId.length || typeof row[1] !== 'string' ||
            !Number.isInteger(nameShared) || nameShared < 0 || nameShared > previousName.length || typeof row[3] !== 'string') {
          throw new BackupError('incomplete');
        }
        id = previousId = (idShared ? previousId.slice(0, idShared) : '') + row[1];
        name = previousName = (nameShared ? previousName.slice(0, nameShared) : '') + row[3];
        const kindFlags = row[4] | 0;
        flags = kindFlags & 15;
        kind = KINDS[kindFlags >> 4] || 'image';
        size = row[5]; tags = row[6]; extra = row[7];
        saved = (flags & FLAG_DOCK) === 0;
      } else if (row && typeof row === 'object') {
        // Schema 3 and the earlier "full data backup" kept one object per item.
        id = row.id; name = row.displayName; kind = KINDS.includes(row.mediaType) ? row.mediaType : '';
        flags = (row.isPending === true ? FLAG_DOCK : 0) | (row.isFavorite === true ? FLAG_FAVORITE : 0) |
          (row.deletedAt ? FLAG_TRASH : 0) | (row.sharedVideoSource === true ? FLAG_CLIP : 0);
        size = row.fileSize; tags = row.tags; saved = row.isPending === false;
        extra = { s: row.sourceName, l: row.location, m: row.cameraModel };
      } else {
        plan.invalid++;
        return;
      }
      if (typeof id === 'number' && Number.isFinite(id)) id = String(id);
      if (typeof id !== 'string' || !id || id.length > 300) { plan.invalid++; return; }
      size = typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
      const original = typeof extra?.s === 'string' && extra.s ? extra.s : name;
      const index = locate(id, kind, size, name, flags, original);
      if (index < 0) { plan.missing++; return; }
      matched[index] = 1;
      planItem(photos[index], flags, saved, name, tags, extra);
    }

    // Schema 6: whole library items. Items already here are merged; others are restored.
    function addRecord(record) {
      if (++plan.total > MAX_RECORDS) throw new BackupError('incomplete');
      if (!record || typeof record !== 'object' || Array.isArray(record)) { plan.invalid++; return; }
      let id = record.id;
      if (typeof id === 'number' && Number.isFinite(id)) id = String(id);
      if (typeof id !== 'string' || !id || id.length > 300) { plan.invalid++; return; }
      const kind = KINDS.includes(record.$k) ? record.$k : (KINDS.includes(record.mediaType) ? record.mediaType : '');
      const flags = (record.isPending === true ? FLAG_DOCK : 0) | (record.isFavorite === true ? FLAG_FAVORITE : 0) |
        (record.deletedAt ? FLAG_TRASH : 0) | (record.sharedVideoSource === true ? FLAG_CLIP : 0);
      const size = typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) && record.fileSize > 0 ? Math.floor(record.fileSize) : 0;
      const name = typeof record.displayName === 'string' ? record.displayName : '';
      const original = record.$o && typeof record.$o.baseName === 'string' ? record.$o.baseName : '';
      const index = locate(id, kind, size, name, flags, original || name);
      if (index < 0) {
        plan.missing++;
        // Restored after the library item the backup had before it (or first).
        plan.fresh.push({ record, after: plan.lastMatch });
        return;
      }
      matched[index] = 1;
      plan.lastMatch = photos[index];
      planItem(photos[index], flags, record.isPending === false, name, record.tags,
        { s: original, l: record.location, m: record.cameraModel });
    }

    function finish(settings) {
      // Like Restore from Trash: every album an item is in exists once the item is in use again.
      for (const { item, set } of plan.changes) {
        if ('deletedAt' in set ? set.deletedAt : item.deletedAt) continue;
        if (!set.tags && !('deletedAt' in set) && !('isPending' in set)) continue;
        for (const tag of set.tags || item.tags || EMPTY) {
          if (typeof tag === 'string' && tag && !albums.has(tag.toLowerCase())) addAlbum({ name: tag });
        }
      }
      plan.appearance = planAppearance(settings);
      plan.resolveTag = resolveTag;
      plan.ensureAlbum = tag => { if (!albums.has(tag.toLowerCase())) addAlbum({ name: tag }); };
      return plan;
    }

    return { add, addRecord, finish, get count() { return plan.total; } };
  }

  function planAppearance(settings) {
    if (!settings || typeof settings !== 'object') return null;
    const state = window.state, next = {};
    if (THEMES.includes(settings.theme) && settings.theme !== state.themePref) next.theme = settings.theme;
    if (typeof settings.accentColor === 'string' && HEX.test(settings.accentColor) &&
        settings.accentColor.toLowerCase() !== String(state.accentColor || '').toLowerCase()) next.accentColor = settings.accentColor;
    if (Array.isArray(settings.savedCustomColors)) {
      const colors = settings.savedCustomColors.filter(color => typeof color === 'string' && HEX.test(color)).slice(0, 24);
      if (colors.length && JSON.stringify(colors) !== JSON.stringify(state.savedCustomColors || [])) next.savedCustomColors = colors;
    }
    return Object.keys(next).length ? next : null;
  }

  function checkHeader(header) {
    if (!header || header.format !== FORMAT || !Number.isInteger(header.schema) || header.schema < 1 || header.schema === 4) throw new BackupError('invalid');
    if (header.schema > SCHEMA) throw new BackupError('newer');
  }

  // Parses a block of whole rows with one JSON.parse. Returns true when the closing line was reached.
  function parseBlock(block, addRow) {
    let text = block.trim();
    let footer = false;
    if (text.endsWith(']}')) {
      const cut = text.lastIndexOf('\n');
      if ((cut < 0 ? text : text.slice(cut + 1).trim()) === ']}') {
        footer = true;
        text = cut < 0 ? '' : text.slice(0, cut).trim();
      }
    }
    if (text.endsWith(',')) text = text.slice(0, -1);
    if (text) {
      let rows;
      try { rows = JSON.parse('[' + text + ']'); } catch (_) { throw new BackupError('incomplete'); }
      for (let index = 0; index < rows.length; index++) addRow(rows[index]);
    }
    return footer;
  }

  async function readPlan(reader, onProgress, expectFull) {
    if (reader.size > MAX_FILE) throw new BackupError('invalid');
    let sliceStart = performance.now();
    async function pause() {
      if (performance.now() - sliceStart < SLICE_MS) return;
      const fraction = reader.progress ? reader.progress() : -1;
      onProgress(fraction >= 0 ? Math.min(0.99, fraction) : null);
      await yieldTask();
      sliceStart = performance.now();
      if (cancelRequested) throw CANCELLED;
    }
    let buffer = await reader.read();
    if (!buffer) throw new BackupError('invalid');
    if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
    let newline = buffer.indexOf('\n');
    while (newline < 0 && buffer.length <= MAX_LINE) {
      const more = await reader.read();
      if (!more) break;
      buffer += more;
      newline = buffer.indexOf('\n');
    }
    const head = (newline < 0 ? buffer : buffer.slice(0, newline)).trim();

    if (/^\{\s*"format"\s*:\s*"picshelf-library-backup"/.test(head) && head.endsWith('"photos":[')) {
      let header;
      try { header = JSON.parse(head + ']}'); } catch (_) { throw new BackupError('invalid'); }
      checkHeader(header);
      const full = header.schema === FULL_SCHEMA;
      if (full !== (expectFull === true)) throw new BackupError('invalid');
      const matcher = createMatcher(header);
      const addRow = full ? matcher.addRecord : matcher.add;
      let rest = newline < 0 ? '' : buffer.slice(newline + 1);
      buffer = '';
      let ended = false, done = false;
      while (!ended) {
        const last = rest.lastIndexOf('\n');
        if (last >= 0) {
          const block = rest.slice(0, last);
          rest = rest.slice(last + 1);
          ended = parseBlock(block, addRow);
          await pause();
          continue;
        }
        if (done) {
          if (rest.trim()) ended = parseBlock(rest, addRow);
          break;
        }
        if (rest.length > MAX_LINE) throw new BackupError('incomplete');
        const chunk = await reader.read();
        if (chunk) rest += chunk; else done = true;
      }
      const expected = header.counts?.items;
      if (!ended || (Number.isSafeInteger(expected) && expected !== matcher.count)) throw new BackupError('incomplete');
      return matcher.finish(header.settings);
    }
    if (expectFull) throw new BackupError('invalid');

    // A backup saved by an earlier version, or one reformatted by another app: parse it whole.
    let text = buffer;
    for (;;) {
      const chunk = await reader.read();
      if (!chunk) break;
      text += chunk;
      if (text.length > (512 << 20)) throw new BackupError('invalid');
      await pause();
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new BackupError('invalid'); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.photos)) throw new BackupError('invalid');
    let header;
    if (data.format === FORMAT) {
      checkHeader(data);
      if (data.schema === FULL_SCHEMA) throw new BackupError('invalid');
      header = data;
    } else {
      if (!Array.isArray(data.tags)) throw new BackupError('invalid');
      header = { exportedAt: data.exportedAt, tags: data.tags, settings: { theme: data.theme, accentColor: data.accentColor, savedCustomColors: data.savedCustomColors } };
    }
    const matcher = createMatcher(header);
    for (let index = 0; index < data.photos.length; index++) {
      matcher.add(data.photos[index]);
      if ((index & 4095) === 4095) await pause();
    }
    const expected = data.counts?.items;
    if (Number.isSafeInteger(expected) && expected !== matcher.count) throw new BackupError('incomplete');
    return matcher.finish(header.settings);
  }

  // ---------------------------------------------------------------- import

  function formatDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    try { return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
    catch (_) { return date.toLocaleString(); }
  }

  function summaryParts(plan) {
    const parts = [];
    const add = (key, count) => { if (count > 0) parts.push(t(key, { count: fmt(count) })); };
    add('backup_part_albums', plan.albums.length + plan.albumPins.length);
    add('backup_part_trash', plan.counts.trash);
    add('backup_part_favorites', plan.counts.favorites);
    add('backup_part_saved', plan.counts.saved);
    add('backup_part_tagged', plan.counts.tagged);
    add('backup_part_names', plan.counts.names);
    add('backup_part_places', plan.counts.places);
    if (plan.appearance) parts.push(t('backup_part_appearance'));
    return parts;
  }

  function countChanges(changes) {
    const result = { trash: 0, favorites: 0, saved: 0, tagged: 0, names: 0, places: 0 };
    for (const { set } of changes) {
      if ('deletedAt' in set) result.trash++;
      if (set.isFavorite) result.favorites++;
      if ('isPending' in set) result.saved++;
      if (set.tags) result.tagged++;
      if (set.displayName) result.names++;
      if (set.location || set.cameraModel) result.places++;
    }
    return result;
  }

  function unlimited() {
    try { return typeof window.hasUnlimitedGallerySaves === 'function' && window.hasUnlimitedGallerySaves(); } catch (_) { return false; }
  }

  function freeLimit() { return window.FREE_GALLERY_SAVE_LIMIT || 40; }

  function savedNow() {
    try { return typeof window.getGallerySaveQuotaCount === 'function' ? window.getGallerySaveQuotaCount() : 0; } catch (_) { return 0; }
  }

  function overFreeLimit(plan) {
    if (!(plan.quotaDelta > 0)) return false;
    try {
      if (unlimited()) return false;
      return savedNow() + plan.quotaDelta > freeLimit();
    } catch (_) { return true; }
  }

  function showImportProblem(code) {
    phase = 'message';
    const invalid = code === 'invalid';
    const text = invalid ? t('backup_invalid')
      : code === 'newer' ? t('backup_newer')
        : code === 'incomplete' ? t('backup_incomplete')
          : code === 'changed' ? t('backup_changed')
            : code === 'source' ? t('backup_source_missing')
              : t('backup_read_failed');
    render({ eyebrow: t('settings_import_backup'), title: t(invalid ? 'backup_invalid_title' : 'backup_not_restored_title'), text,
      primary: { label: t('backup_close'), run: closeDialog } });
  }

  function startImport() {
    if (phase === 'job' || phase === 'finish') return;
    if (phase !== 'idle' || pickPending) { toast(t('backup_busy')); return; }
    if (!libraryReady()) { toast(t('backup_library_loading')); return; }
    if (fullNative() && showActiveJob(jobStatus())) return;
    if (native('libraryBackupPick')) {
      pickPending = true;
      try { bridge().libraryBackupPick(); } catch (_) { pickPending = false; toast(t('backup_picker_failed')); }
      return;
    }
    el('importBackupFileInput')?.click();
  }

  function importFile(file) {
    if (!file) return;
    if (phase !== 'idle') { toast(t('backup_busy')); return; }
    if (!libraryReady()) { toast(t('backup_library_loading')); return; }
    runImport(fileReader(file), null);
  }

  async function runImport(reader, opened) {
    phase = 'read';
    cancelRequested = false;
    render({ eyebrow: t('settings_import_backup'), title: t('backup_reading_title'), text: t('backup_reading_body'),
      progress: reader.size > 0 ? 0 : null, secondary: { label: t('backup_cancel'), run: cancelWork }, dismiss: cancelWork });
    let plan;
    try {
      plan = await readPlan(reader, setProgress, opened?.full === true);
    } catch (error) {
      reader.close();
      if (error === CANCELLED) { closeDialog(); return; }
      console.warn('Backup import stopped:', error);
      showImportProblem(error?.code || 'read');
      return;
    }
    if (plan.full) {
      // The reader token stays open: a restore copies media out of this same file.
      showFullPreview(plan, opened, reader);
      return;
    }
    reader.close();
    showPreview(plan);
  }

  function showPreview(plan) {
    const eyebrow = t('settings_import_backup');
    const date = formatDate(plan.exportedAt);
    const meta = [date ? t('backup_confirm_date', { date }) : '',
      t('backup_confirm_found', { found: fmt(plan.matched), items: fmt(plan.total) })].filter(Boolean).join('\n');
    const missing = plan.missing > 0 ? t('backup_missing_note', { missing: fmt(plan.missing) }) : '';
    const parts = summaryParts(plan);
    if (!parts.length) {
      phase = 'message';
      render({ eyebrow, title: t('backup_nothing_title'), text: meta + '\n' + t('backup_nothing_body'), note: missing,
        primary: { label: t('backup_done'), run: closeDialog } });
      return;
    }
    phase = 'confirm';
    render({ eyebrow, title: t('backup_confirm_title'), text: meta, label: t('backup_confirm_will'), parts,
      note: overFreeLimit(plan) ? t('backup_limit') : t('backup_confirm_note'), note2: missing,
      primary: { label: t('backup_restore'), run: () => restore(plan) },
      secondary: { label: t('backup_cancel'), run: closeDialog } });
  }

  function refreshLibrary() {
    if (typeof window.refreshAfterLibraryRestore === 'function') window.refreshAfterLibraryRestore();
    else window.LibraryViews?.invalidate?.();
    window.saveState?.(true);
    window.renderAll?.();
  }

  function applyAppearance(next) {
    const state = window.state;
    if (next.savedCustomColors) state.savedCustomColors = next.savedCustomColors.slice();
    if (next.theme && typeof window.setAppTheme === 'function') window.setAppTheme(next.theme, false, false);
    if (next.accentColor && typeof window.setAppAccentColor === 'function') window.setAppAccentColor(next.accentColor, false, true, false);
  }

  function applyChanges(plan, undo, changes) {
    const state = window.state;
    for (const { item, set } of changes || plan.changes) {
      const previous = {};
      for (const key of Object.keys(set)) previous[key] = Object.prototype.hasOwnProperty.call(item, key) ? item[key] : UNSET;
      undo.items.push({ item, previous });
      Object.assign(item, set);
    }
    if (plan.albums.length) state.tags = (Array.isArray(state.tags) ? state.tags : []).concat(plan.albums.map(album => ({ ...album })));
    for (const album of plan.albumPins) {
      if (!album.isFavorite) { album.isFavorite = true; undo.pins.push(album); }
    }
    if (plan.appearance) {
      undo.appearance = { theme: state.themePref, accentColor: state.accentColor, savedCustomColors: (state.savedCustomColors || []).slice() };
      applyAppearance(plan.appearance);
    }
  }

  function apply(plan) {
    const state = window.state;
    const undo = { items: [], tags: state.tags, pins: [], appearance: null };
    applyChanges(plan, undo);
    refreshLibrary();
    return undo;
  }

  function revertChanges(undo) {
    const state = window.state;
    for (let index = undo.items.length - 1; index >= 0; index--) {
      const { item, previous } = undo.items[index];
      for (const [key, value] of Object.entries(previous)) {
        if (value === UNSET) delete item[key];
        else item[key] = value;
      }
    }
    state.tags = undo.tags;
    for (const album of undo.pins) album.isFavorite = false;
    if (undo.appearance) applyAppearance(undo.appearance);
  }

  function revert(undo) {
    revertChanges(undo);
    refreshLibrary();
  }

  function restore(plan) {
    if (phase !== 'confirm') return;
    // The preview was computed for this exact library list.
    if (window.state.photos !== plan.source) { showImportProblem('changed'); return; }
    if (overFreeLimit(plan)) {
      // Free plan: the regular upgrade screen explains the save limit.
      closeDialog();
      if (typeof window.checkCanSavePhotosToGallery === 'function') window.checkCanSavePhotosToGallery(plan.quotaDelta);
      else toast(t('backup_limit'));
      return;
    }
    phase = 'apply';
    let undo;
    try {
      undo = apply(plan);
    } catch (error) {
      console.error('Backup restore failed:', error);
      showImportProblem('read');
      return;
    }
    phase = 'result';
    const missing = plan.missing > 0 ? t('backup_missing_note', { missing: fmt(plan.missing) }) : '';
    render({ eyebrow: t('settings_import_backup'), title: t('backup_restored_title'), label: t('backup_restored_label'),
      parts: summaryParts(plan), note2: missing,
      primary: { label: t('backup_done'), run: closeDialog },
      secondary: { label: t('backup_undo'), run: () => { revert(undo); closeDialog(); toast(t('backup_undone')); } } });
  }

  // ---------------------------------------------------------------- full restore

  function refsOf(value, visit) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) refsOf(item, visit); return; }
    if (typeof value.$m === 'number') { visit(value.$m, true); return; }
    if (typeof value.$v === 'string') return;
    for (const key of Object.keys(value)) refsOf(value[key], visit);
  }

  // The media entries a restore needs: originals become one archive, other media is read back.
  function neededEntries(plan, table) {
    const needed = new Map();
    const ok = number => Number.isSafeInteger(number) && number >= 0 && number < table.length &&
      Array.isArray(table[number]) && table[number][2] === 1;
    let restorable = 0, unreadable = 0;
    for (const item of plan.fresh) {
      const record = item.record;
      if (record.$o) {
        if (!ok(record.$o.n)) { item.skip = true; unreadable++; continue; }
        needed.set(record.$o.n, false);
      }
      refsOf(record, (number, held) => { if (ok(number) && !needed.has(number)) needed.set(number, held); });
      restorable++;
    }
    for (const cover of plan.covers.values()) refsOf(cover, (number, held) => { if (ok(number) && !needed.has(number)) needed.set(number, held); });
    const favoritesCover = plan.header.favoritesCustomCover;
    if (favoritesCover && typeof favoritesCover === 'object' && !window.state.favoritesCustomCover) {
      refsOf(favoritesCover, (number, held) => { if (ok(number) && !needed.has(number)) needed.set(number, held); });
    }
    const list = [];
    let bytes = 0;
    for (const [number, held] of [...needed.entries()].sort((a, b) => a[0] - b[0])) {
      const [offset, length] = table[number];
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) continue;
      list.push([number, offset, length, 'bin', held ? 1 : 0]);
      bytes += length;
    }
    return { list, bytes, restorable, unreadable };
  }

  function freeBytes() {
    try { return parse(bridge().libraryBackupFreeBytes()); } catch (_) { return {}; }
  }

  // Saves the free plan allows: new items over the limit are placed in the Dock instead.
  function quotaPlan(plan, freshCounted) {
    if (unlimited()) return { budget: Infinity, over: 0 };
    const budget = Math.max(0, freeLimit() - savedNow());
    const over = Math.max(0, plan.quotaDelta + freshCounted - budget);
    return { budget, over };
  }

  function showFullPreview(plan, opened, reader) {
    const eyebrow = t('settings_import_backup');
    let table = [];
    try { table = parse(bridge().libraryBackupEntries(opened.token)).entries || []; } catch (_) {}
    const entries = neededEntries(plan, table);
    const date = formatDate(plan.exportedAt);
    const meta = [date ? t('backup_confirm_date', { date }) : '',
      t('backup_confirm_found', { found: fmt(plan.matched), items: fmt(plan.total) })].filter(Boolean).join('\n');
    const parts = [];
    if (entries.restorable > 0) parts.push(t('backup_confirm_new', { count: fmt(entries.restorable), size: formatBytes(entries.bytes) }));
    parts.push(...summaryParts(plan));
    const close = () => { reader.close(); closeDialog(); };
    const unreadable = entries.unreadable > 0 ? t('backup_not_restored_note', { count: fmt(entries.unreadable) }) : '';
    if (!parts.length) {
      phase = 'message';
      render({ eyebrow, title: t('backup_nothing_title'), text: meta + '\n' + t('backup_nothing_body'), note: unreadable,
        primary: { label: t('backup_done'), run: close }, dismiss: close });
      return;
    }
    const free = freeBytes();
    const needed = entries.bytes + (entries.list.length ? 96 * 1024 * 1024 : 0);
    if (entries.list.length && Number(free.app) >= 0 && Number(free.app) < needed) {
      phase = 'message';
      render({ eyebrow, title: t('backup_space_title'), text: t('backup_space_body', { size: formatBytes(needed) }),
        primary: { label: t('backup_close'), run: close }, dismiss: close });
      return;
    }
    let freshCounted = 0;
    for (const item of plan.fresh) {
      const record = item.record;
      if (!item.skip && counted(record.deletedAt, record.isPending === true, record.isFavorite === true)) freshCounted++;
    }
    const quota = quotaPlan(plan, freshCounted);
    phase = 'confirm';
    render({ eyebrow, title: t('backup_confirm_title'), text: meta, label: t('backup_confirm_will'), parts,
      note: quota.over > 0 ? t('backup_full_limit', { limit: fmt(freeLimit()) }) : t('backup_confirm_note'), note2: unreadable,
      primary: { label: t('backup_restore'), run: () => startRestore(plan, opened, reader, entries) },
      secondary: { label: t('backup_cancel'), run: close }, dismiss: close });
  }

  async function startRestore(plan, opened, reader, entries) {
    if (phase !== 'confirm') return;
    if (!entries.list.length) {
      // Nothing to copy (merges, or items without media files): finish right away.
      reader.close();
      phase = 'finish';
      render({ eyebrow: t('settings_import_backup'), title: t('backup_finishing_title'), text: t('backup_finishing_body'), progress: null });
      try { await applyFullPlan(plan, { sourceId: '', entries: [] }, ''); }
      catch (error) { console.error('Backup restore failed:', error); showImportProblem(error?.code || 'read'); }
      return;
    }
    phase = 'job';
    await askNotifications();
    const started = parse(bridge().libraryBackupRestoreStart(opened.token, JSON.stringify(entries.list), notificationCopy()));
    reader.close();
    if (!started.ok || !started.id) {
      phase = 'message';
      if (started.error === 'space') {
        render({ eyebrow: t('settings_import_backup'), title: t('backup_space_title'),
          text: t('backup_space_body', { size: formatBytes(started.needed || entries.bytes) }), primary: { label: t('backup_close'), run: closeDialog } });
      } else if (started.error === 'busy') { closeDialog(); toast(t('backup_busy')); }
      else showImportProblem('read');
      return;
    }
    watchedJob = started.id;
    showJob(jobStatus());
  }

  // Phase C: the media is copied; add the items (again from the backup's index, so the result
  // is right even if the library changed meanwhile or PicShelf was restarted).
  async function finishRestore(id, automatic) {
    if (finishing || (automatic && failedFinish.has(id))) return;
    if (phase !== 'idle' && phase !== 'job') return;
    finishing = true;
    stopWatching();
    phase = 'finish';
    cancelRequested = false;
    const eyebrow = t('settings_import_backup');
    render({ eyebrow, title: t('backup_finishing_title'), text: t('backup_finishing_body'), progress: null });
    let reader = null;
    try {
      const result = parse(bridge().libraryBackupRestoreResult(id));
      if (!Array.isArray(result.entries)) throw new BackupError('read');
      const opened = parse(bridge().libraryBackupReopen(id));
      if (!opened.ok || !opened.token) throw new BackupError('read');
      reader = nativeReader(opened);
      const plan = await readPlan(reader, fraction => setProgress(fraction === null ? null : fraction * 0.3), true);
      reader.close();
      reader = null;
      await applyFullPlan(plan, result, id);
    } catch (error) {
      reader?.close();
      console.error('Backup restore could not finish:', error);
      // The copied media stays; opening PicShelf (or Import Backup) again retries.
      failedFinish.add(id);
      showImportProblem(error?.code || 'read');
    } finally {
      finishing = false;
    }
  }

  function readHeld(token, place, type) {
    if (!(place.length > 0)) return Promise.resolve(new Blob([], { type: type || '' }));
    const photo = { tarEntry: { nativeSourceId: token, offset: place.offset, size: place.length, baseName: 'entry.' + extensionOf('', type) } };
    return window.ArchiveSources.originalBlob(photo).then(blob => (type && blob.type !== type ? new Blob([blob], { type }) : blob));
  }

  function blobToDataUrl(blob, prefix) {
    return readBase64(blob).then(base64 => prefix + ',' + base64);
  }

  function safeUrl(value) {
    if (!value) return value;
    if (value.startsWith('data:')) return SAFE_DATA.test(value) ? value : null;
    if (value.startsWith('assets/')) return SAFE_ASSET.test(value) && !value.includes('..') ? value : null;
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || /[<>"'`\\\s]/.test(value) ? null : value;
  }

  function cleanString(key, value) {
    if (URL_KEY.test(key) || /^(?:data:[a-z]+\/|blob:|https?:\/\/|javascript:|vbscript:|file:\/\/|content:\/\/)/i.test(value)) return safeUrl(value);
    if (!CONTROL_TEST.test(value) && !RISKY_TEST.test(value)) return value;
    return safeText(value.replace(CONTROL, ' '));
  }

  async function applyFullPlan(plan, result, jobId) {
    const state = window.state;
    const eyebrow = t('settings_import_backup');
    phase = 'finish';
    const sourceId = typeof result.sourceId === 'string' ? result.sourceId : '';
    const heldToken = typeof result.heldToken === 'string' ? result.heldToken : '';
    const places = new Map();
    for (const entry of result.entries || []) {
      if (!Array.isArray(entry) || entry[3] !== 1 || !(entry[1] >= 0)) continue;
      places.set(entry[0], { offset: entry[1], length: entry[2], held: entry[4] === 1 });
    }
    const values = new Map(); // entry number -> Blob (read once, shared by every item using it)
    const urls = new Map();   // entry number -> object URL
    const created = [];
    async function loadHeld(numbers) {
      const list = [...numbers].filter(number => !values.has(number) && places.get(number)?.held && heldToken);
      for (let start = 0; start < list.length; start += HELD_PARALLEL) {
        await Promise.all(list.slice(start, start + HELD_PARALLEL).map(number =>
          readHeld(heldToken, places.get(number), '').then(blob => { values.set(number, blob); }, () => { values.set(number, null); })));
      }
    }
    async function decode(value, key, ownPlace) {
      if (value === null || typeof value !== 'object') {
        return typeof value === 'string' ? cleanString(key, value) : value;
      }
      if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let index = 0; index < value.length; index++) out[index] = await decode(value[index], key, ownPlace);
        return out;
      }
      if (typeof value.$m === 'number') {
        const blob = values.get(value.$m);
        if (!(blob instanceof Blob)) return null;
        const type = typeof value.type === 'string' && /^[a-z0-9.+/-]{0,100}$/i.test(value.type) ? value.type : blob.type;
        const typed = type !== blob.type ? new Blob([blob], { type }) : blob;
        if (value.as === 'blob') return typed;
        if (value.as === 'url') {
          let url = urls.get(value.$m);
          if (!url) { url = URL.createObjectURL(typed); urls.set(value.$m, url); created.push(url); }
          return url;
        }
        if (value.as === 'data') {
          const prefix = typeof value.prefix === 'string' && /^data:[a-z0-9.+/-]+(?:;[a-z0-9.+=-]+)*$/i.test(value.prefix) ? value.prefix : 'data:' + (type || 'application/octet-stream') + ';base64';
          return cleanString('dataUrl', await blobToDataUrl(blob, prefix));
        }
        return null;
      }
      if (typeof value.$v === 'string') {
        const place = ownPlace && ownPlace.number === value.n ? ownPlace : (places.has(value.n) && !places.get(value.n).held ? { ...places.get(value.n) } : null);
        if (!place || !sourceId || (value.$v !== 'thumbnails' && value.$v !== 'originals')) return null;
        const prefix = value.p === 'video-' || value.p === 'metadata-' ? value.p : '';
        const query = typeof value.q === 'string' && /^(?:\?[A-Za-z0-9=&%._+-]*)?$/.test(value.q) ? value.q : '';
        return `https://picshelf-${value.$v}.invalid/${encodeURIComponent(sourceId)}/${prefix}tar/${place.offset}/${place.length}/0${query}`;
      }
      const out = {};
      for (const name of Object.keys(value)) {
        if (SKIP_KEYS.has(name) || name === '$o' || name === '$k') continue;
        const item = await decode(value[name], name, ownPlace);
        if (item !== undefined) out[name] = item;
      }
      return out;
    }

    try {
      const ids = new Set();
      for (const photo of state.photos) if (photo && photo.id != null) ids.add(String(photo.id));
      let freshCounted = 0;
      for (const item of plan.fresh) {
        const record = item.record;
        if (counted(record.deletedAt, record.isPending === true, record.isFavorite === true)) freshCounted++;
      }
      // Free plan: saves beyond the limit stay in (or go to) the Dock instead of being lost.
      let budget = quotaPlan(plan, 0).budget;
      const changes = [];
      for (const change of plan.changes) {
        const { item, set } = change;
        const after = counted('deletedAt' in set ? set.deletedAt : item.deletedAt,
          'isPending' in set ? set.isPending : item.isPending, 'isFavorite' in set ? set.isFavorite : item.isFavorite);
        if (after && !counted(item.deletedAt, item.isPending, item.isFavorite)) {
          if (budget > 0) budget--;
          else {
            const kept = { ...set };
            delete kept.isPending;
            if (item.isPending) delete kept.isFavorite;
            if (!Object.keys(kept).length) continue;
            changes.push({ item, set: kept });
            continue;
          }
        }
        changes.push(change);
      }
      const added = [];
      let failed = 0, docked = 0, done = 0;
      const total = plan.fresh.length || 1;
      let sliceStart = performance.now();
      for (const item of plan.fresh) {
        const record = item.record;
        let ownPlace = null;
        if (record.$o) {
          const place = places.get(record.$o.n);
          if (!place || place.held || !sourceId) { failed++; continue; }
          ownPlace = { ...place, number: record.$o.n };
        }
        const numbers = new Set();
        refsOf(record, number => numbers.add(number));
        if (numbers.size) await loadHeld(numbers);
        const photo = await decode(record, '', ownPlace);
        if (ownPlace) {
          photo.tarEntry = { nativeSourceId: sourceId, offset: ownPlace.offset, size: ownPlace.length,
            baseName: cleanString('baseName', typeof record.$o.baseName === 'string' ? record.$o.baseName.slice(0, 300) : '') };
          if (own(photo, 'zipEntry')) photo.zipEntry = null;
        }
        let id = typeof photo.id === 'number' ? String(photo.id) : photo.id;
        if (typeof id !== 'string' || !id || ids.has(id)) id = `restored_${Date.now().toString(36)}_${added.length}_${Math.random().toString(36).slice(2, 7)}`;
        photo.id = id;
        ids.add(id);
        if (!Array.isArray(photo.tags)) photo.tags = [];
        photo.tags = photo.tags.filter(tag => typeof tag === 'string' && tag).map(tag => plan.resolveTag(cleanText(tag, 120))).filter(Boolean);
        if (counted(photo.deletedAt, photo.isPending, photo.isFavorite)) {
          if (budget > 0) budget--;
          else { photo.isPending = true; photo.isFavorite = false; docked++; }
        }
        if (!photo.deletedAt) for (const tag of photo.tags) plan.ensureAlbum(tag);
        added.push({ photo, after: item.after });
        if (++done && performance.now() - sliceStart > SLICE_MS) {
          setProgress(0.3 + 0.6 * (done / total));
          await yieldTask();
          sliceStart = performance.now();
        }
      }
      // Covers of restored albums, and the Favorites cover if this library has none.
      const covers = new Map();
      for (const [album, cover] of plan.covers) {
        const numbers = new Set();
        refsOf(cover, number => numbers.add(number));
        if (numbers.size) await loadHeld(numbers);
        const value = typeof cover === 'string' ? cleanString('customCoverUrl', cover) : await decode(cover, 'customCoverUrl', null);
        if (typeof value === 'string' && value) covers.set(album, value);
      }
      let favoritesCover = null;
      const backupCover = plan.header.favoritesCustomCover;
      if (backupCover && !state.favoritesCustomCover) {
        const numbers = new Set();
        refsOf(backupCover, number => numbers.add(number));
        if (numbers.size) await loadHeld(numbers);
        const value = typeof backupCover === 'string' ? cleanString('customCoverUrl', backupCover) : await decode(backupCover, 'customCoverUrl', null);
        if (typeof value === 'string' && value) favoritesCover = value;
      }

      // Albums that were in Trash, unless this library already has them.
      const deletedAlbums = [];
      const knownAlbums = new Set();
      for (const album of [...(Array.isArray(state.deletedAlbums) ? state.deletedAlbums : []), ...(Array.isArray(state.tags) ? state.tags : []), ...plan.albums]) {
        if (album && typeof album.name === 'string') knownAlbums.add(album.name.toLowerCase());
      }
      for (const raw of Array.isArray(plan.header.deletedAlbums) ? plan.header.deletedAlbums : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const name = cleanText(raw.name, 120);
        if (!name || knownAlbums.has(name.toLowerCase())) continue;
        const album = await decode(raw, '', null);
        album.name = safeText(name);
        if (typeof album.color !== 'string' || !ANY_HEX.test(album.color)) album.color = '#f43f5e';
        knownAlbums.add(name.toLowerCase());
        deletedAlbums.push(album);
      }

      // Everything is ready: change the library in one step.
      const undo = { items: [], tags: state.tags, pins: [], appearance: null, added: new Set(), urls: created,
        favoritesCover: state.favoritesCustomCover, favorites3DStyle: state.favorites3DStyle, media: [],
        deletedAlbums: state.deletedAlbums };
      applyChanges(plan, undo, changes);
      if (deletedAlbums.length) state.deletedAlbums = (Array.isArray(state.deletedAlbums) ? state.deletedAlbums : []).concat(deletedAlbums);
      for (const album of plan.albums) {
        const cover = covers.get(album);
        if (!cover) continue;
        const live = state.tags.find(tag => tag && tag.name === album.name);
        if (live) live.customCoverUrl = cover;
      }
      if (favoritesCover) {
        state.favoritesCustomCover = favoritesCover;
        if (typeof plan.header.favorites3DStyle === 'string' && STYLE.test(plan.header.favorites3DStyle)) state.favorites3DStyle = plan.header.favorites3DStyle;
      }
      if (added.length) {
        const groups = new Map();
        const front = [];
        for (const entry of added) {
          undo.added.add(entry.photo);
          if (!entry.after) { front.push(entry.photo); continue; }
          let group = groups.get(entry.after);
          if (!group) groups.set(entry.after, group = []);
          group.push(entry.photo);
        }
        const next = front;
        for (const photo of state.photos) {
          next.push(photo);
          const group = groups.get(photo);
          if (group) { for (const item of group) next.push(item); groups.delete(photo); }
        }
        // An anchor removed meanwhile: its items go at the end of the library.
        for (const group of groups.values()) for (const item of group) next.push(item);
        state.photos = next;
        // Videos and audio the page held play from the same saved copy as before.
        for (const { photo } of added) {
          if (!(photo.fileBlob instanceof Blob)) continue;
          const kind = KINDS.includes(photo.mediaType) ? photo.mediaType : kindOf(photo);
          if (kind !== 'video' && kind !== 'audio') continue;
          try {
            if (typeof saveMediaBlobToIDB === 'function') saveMediaBlobToIDB(photo.id, photo.fileBlob);
            undo.media.push(photo.id);
            if (typeof activeMediaBlobUrls !== 'undefined') {
              const url = typeof photo.videoUrl === 'string' && photo.videoUrl.startsWith('blob:') ? photo.videoUrl : URL.createObjectURL(photo.fileBlob);
              if (url !== photo.videoUrl) created.push(url);
              activeMediaBlobUrls.set(photo.id, url);
              photo.videoUrl = url;
            }
          } catch (_) {}
        }
      }
      setProgress(0.95);
      if (typeof window.refreshAfterLibraryRestore === 'function') window.refreshAfterLibraryRestore();
      else window.LibraryViews?.invalidate?.();
      window.renderAll?.();
      if (typeof window.saveStateImmediate === 'function') await window.saveStateImmediate();
      else window.saveState?.(true);
      if (sourceId) { try { bridge().libraryBackupReleaseSource(sourceId); } catch (_) {} }
      if (jobId) acknowledge(jobId);
      setProgress(1);
      const parts = [];
      if (added.length) parts.push(t('backup_part_new', { count: fmt(added.length) }));
      parts.push(...summaryParts({ ...plan, counts: countChanges(changes) }));
      phase = 'result';
      const notes = [];
      if (docked > 0) notes.push(t('backup_full_limit', { limit: fmt(freeLimit()) }));
      if (failed > 0) notes.push(t('backup_not_restored_note', { count: fmt(failed) }));
      render({ eyebrow, title: t('backup_restored_title'), label: parts.length ? t('backup_restored_label') : '',
        text: parts.length ? '' : t('backup_nothing_body'), parts, note: notes[0] || '', note2: notes[1] || '',
        primary: { label: t('backup_done'), run: closeDialog },
        secondary: { label: t('backup_undo'), run: () => { revertFull(undo); closeDialog(); toast(t('backup_undone')); } } });
    } catch (error) {
      for (const url of created) { try { URL.revokeObjectURL(url); } catch (_) {} }
      throw error;
    }
  }

  function revertFull(undo) {
    const state = window.state;
    if (undo.added.size) state.photos = state.photos.filter(photo => !undo.added.has(photo));
    revertChanges(undo);
    state.deletedAlbums = undo.deletedAlbums;
    state.favoritesCustomCover = undo.favoritesCover;
    state.favorites3DStyle = undo.favorites3DStyle;
    for (const id of undo.media) {
      try { if (typeof deleteMediaBlobFromIDB === 'function') deleteMediaBlobFromIDB(id); } catch (_) {}
      try { if (typeof activeMediaBlobUrls !== 'undefined') activeMediaBlobUrls.delete(id); } catch (_) {}
    }
    for (const url of undo.urls) { try { URL.revokeObjectURL(url); } catch (_) {} }
    if (typeof window.refreshAfterLibraryRestore === 'function') window.refreshAfterLibraryRestore();
    else window.LibraryViews?.invalidate?.();
    window.saveState?.(true);
    window.renderAll?.();
  }

  // ---------------------------------------------------------------- native callbacks

  function checkPending() {
    if (!libraryReady() || phase !== 'idle' || !native('libraryBackupTakePending')) return;
    let raw = '';
    try { raw = bridge().libraryBackupTakePending(); } catch (_) {}
    if (!raw) return;
    pickPending = false;
    const opened = parse(raw);
    if (!opened.ok || !opened.token) {
      showImportProblem(opened.error === 'too_large' ? 'invalid' : 'read');
      return;
    }
    runImport(nativeReader(opened), opened);
  }

  function onPickCanceled(failed) {
    pickPending = false;
    if (failed) toast(t('backup_picker_failed'));
  }

  function onStoragePermission(granted) { storageWaiter?.(granted); }
  function onNotificationPermission() { notificationWaiter?.(); }

  // Once the library is ready: finish a restore whose media was copied while PicShelf was
  // closed, report a job that ended, or keep following one that still runs.
  function resumeJobs() {
    if (!fullNative() || !libraryReady()) return false;
    const status = jobStatus();
    if (status.interrupted) {
      try { bridge().libraryBackupClearInterrupted(); } catch (_) {}
      if (phase === 'idle') {
        phase = 'message';
        render({ eyebrow: t('settings_export_backup'), title: t('backup_failed_title'), text: t('backup_interrupted'),
          primary: { label: t('backup_close'), run: closeDialog } });
        return true;
      }
    }
    if (!status.id) return false;
    if (activeState(status.state)) { watchedJob = status.id; watch(); return false; }
    if (status.type === 'restore' && (status.state === 'done' || status.state === 'failed')) {
      if (phase !== 'idle') return false;
      settle(status);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- setup

  bindDialog();
  // Import Backup keeps its button; on Android it opens a backup-only file picker whose
  // result survives Android closing PicShelf while the picker is open.
  const importInput = el('importBackupFileInput');
  importInput?.closest('label')?.addEventListener('click', event => {
    if (!native('libraryBackupPick')) return;
    event.preventDefault();
    event.stopPropagation();
    startImport();
  }, true);
  // A file picked just before Android restarted PicShelf is restored once the library is ready.
  let polls = 0;
  const startupPoll = setInterval(() => {
    if (window.libraryStartupReady === true || ++polls > 600) {
      clearInterval(startupPoll);
      setTimeout(() => { if (!resumeJobs()) checkPending(); }, 300);
    }
  }, 500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !libraryReady()) return;
    if (watchTimer) poll();
    else if (phase === 'idle') resumeJobs();
  });

  window.PicShelfBackup = Object.freeze({
    exportBackup, startImport, importFile, checkPending, onPickCanceled, onStoragePermission, onNotificationPermission,
    busy: () => {
      if (pickPending || phase === 'export' || phase === 'read' || phase === 'apply' || phase === 'finish') return true;
      // A backup or restore still copying: an app update would stop it.
      const status = fullNative() ? jobStatus() : {};
      return !!status.id && (activeState(status.state) || (status.type === 'restore' && status.state === 'done'));
    }
  });
})();
