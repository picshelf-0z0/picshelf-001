/* Loading Dock sort: Newest First / Oldest First (by date added to the Dock)
   and Name (A - Z) / Name (Z - A). The choice is remembered on this device, so
   it survives app and phone restarts.

   "Date added" is the moment media reaches the Dock. Everything already in the
   Dock when the library loads keeps its existing relative order; media that
   arrives afterwards (Camera, Upload, shared media) is stamped once on arrival
   and is saved with the library. Cards and their rendering are untouched: this
   only decides the order of the list the Dock already renders.

   Built for million-item libraries: arrivals are found by comparing the
   library's first and last records with the previous check (new media only
   ever enters at the front or the end), so the cost is O(new media), never
   O(library). Stamps are written by the library's own saves (app.js calls
   noteArrivals before each save) - this never requests a save itself. */
(() => {
  'use strict';
  const STORAGE_KEY = 'photo_org_dock_sort';
  const MODES = {
    'date-desc': { icon: 'fa-solid fa-arrow-down-short-wide', key: 'gallery_sort_newest', text: 'Newest First' },
    'date-asc': { icon: 'fa-solid fa-arrow-up-wide-short', key: 'gallery_sort_oldest', text: 'Oldest First' },
    'name-asc': { icon: 'fa-solid fa-arrow-down-a-z', key: 'gallery_sort_name_asc', text: 'Name (A - Z)' },
    'name-desc': { icon: 'fa-solid fa-arrow-down-z-a', key: 'gallery_sort_name_desc', text: 'Name (Z - A)' }
  };
  let mode = 'date-desc';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (MODES[saved]) mode = saved;
  } catch (_) {}

  // ---- Date added -----------------------------------------------------------
  let primed = false;
  let head = null, tail = null;   // the library's first and last records at the last check
  let stampVersion = 0;

  function libraryLoaded() {
    try {
      // eslint-disable-next-line no-undef
      if (typeof _libraryHydrated !== 'undefined') return _libraryHydrated === true;
    } catch (_) {}
    return window.libraryStartupReady === true;
  }

  // New media only ever enters the library at its front (Camera, single
  // uploads) or its end (bulk imports). Records in front of the previous first
  // record, or after the previous last one, are new: O(new media).
  function noteArrivals() {
    if (!libraryLoaded()) return;
    const photos = window.state?.photos;
    const n = Array.isArray(photos) ? photos.length : 0;
    if (!primed) {
      // Media present when the library loads keeps its current order.
      primed = true;
      head = n ? photos[0] : null;
      tail = n ? photos[n - 1] : null;
      return;
    }
    if (!n) { head = tail = null; return; }
    if (photos[0] === head && photos[n - 1] === tail) return;
    let now = 0;
    const stamp = photo => {
      if (!photo || photo.dockAddedAt || !photo.isPending || photo.deletedAt) return;
      if (!now) now = Date.now();
      photo.dockAddedAt = now;
    };
    if (!head && !tail) {
      for (let i = 0; i < n; i++) stamp(photos[i]);   // the library was empty
    } else {
      // A previous first/last record that was removed (rare) cannot locate a
      // boundary; nothing is stamped then rather than guessing.
      if (photos[0] !== head && head) {
        const at = photos.indexOf(head);
        for (let i = 0; i < at; i++) stamp(photos[i]);
      }
      if (photos[n - 1] !== tail && tail) {
        const at = photos.lastIndexOf(tail);
        if (at >= 0) for (let i = at + 1; i < n; i++) stamp(photos[i]);
      }
    }
    head = photos[0];
    tail = photos[n - 1];
    if (now) stampVersion++;
  }

  // ---- Ordering -------------------------------------------------------------
  const nameKeys = new WeakMap();
  function nameKey(photo) {
    let key = nameKeys.get(photo);
    if (key === undefined) {
      // Case-insensitive, numbers in natural order (IMG_2 before IMG_10).
      key = String(photo.displayName || photo.name || '').toLowerCase()
        .replace(/\d+/g, digits => digits.padStart(16, '0'));
      nameKeys.set(photo, key);
    }
    return key;
  }

  // Newest first; media that arrived together keeps its existing order - the
  // result of a stable sort by date added, in O(n) for the usual cases (an
  // import appends its batches in order; Camera puts the newest first).
  function newestFirst(arrived) {
    let ascending = true, descending = true;
    for (let i = 1; i < arrived.length && (ascending || descending); i++) {
      const d = arrived[i].dockAddedAt - arrived[i - 1].dockAddedAt;
      if (d < 0) ascending = false;
      else if (d > 0) descending = false;
    }
    if (descending) return arrived;
    if (!ascending) return arrived.sort((a, b) => b.dockAddedAt - a.dockAddedAt);
    const out = new Array(arrived.length);
    let w = 0, end = arrived.length;
    while (end > 0) {
      let start = end - 1;
      const time = arrived[start].dockAddedAt;
      while (start > 0 && arrived[start - 1].dockAddedAt === time) start--;
      for (let i = start; i < end; i++) out[w++] = arrived[i];
      end = start;
    }
    return out;
  }

  let cache = null;
  function order(pending) {
    if (!Array.isArray(pending)) return pending;
    const revision = window.LibraryViews?.get?.(window.state || state)?.revision ?? 0;
    noteArrivals();
    syncButton();
    if (cache && cache.source === pending && cache.length === pending.length && cache.revision === revision &&
        cache.mode === mode && cache.stamps === stampVersion) return cache.list;
    let list;
    if (mode === 'date-desc' || mode === 'date-asc') {
      const arrived = [], rest = [];
      for (const photo of pending) ((photo && photo.dockAddedAt) ? arrived : rest).push(photo);
      list = arrived.length ? newestFirst(arrived).concat(rest) : pending;
      if (mode === 'date-asc') list = list.slice().reverse();
    } else {
      list = pending.slice();
      list.sort((a, b) => {
        const left = nameKey(a), right = nameKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      if (mode === 'name-desc') list.reverse();
    }
    cache = { source: pending, length: pending.length, revision, mode, stamps: stampVersion, list };
    return list;
  }

  // ---- Control --------------------------------------------------------------
  const el = id => document.getElementById(id);

  function syncButton() {
    const conf = MODES[mode];
    const icon = el('dockSortIcon'), label = el('dockSortLabel');
    if (icon && icon.className !== conf.icon) icon.className = conf.icon;
    const text = window.t ? window.t(conf.key) : conf.text;
    if (label && label.textContent !== text) label.textContent = text;
    document.querySelectorAll('#dockSortMenu .dock-sort-option').forEach(option => {
      const current = option.dataset.sort === mode;
      option.classList.toggle('active', current);
      option.setAttribute('aria-checked', current ? 'true' : 'false');
    });
  }

  function closeMenu() {
    const menu = el('dockSortMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    el('dockSortBtn')?.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(event) {
    if (event) event.stopPropagation();
    const menu = el('dockSortMenu');
    if (!menu) return;
    if (!menu.hidden) { closeMenu(); return; }
    syncButton();
    menu.hidden = false;
    el('dockSortBtn')?.setAttribute('aria-expanded', 'true');
  }

  function set(next) {
    closeMenu();
    if (!MODES[next] || next === mode) return;
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    cache = null;
    // Show the start of the newly ordered list.
    const viewport = document.querySelector('.app-viewport');
    if (viewport && el('dockScreen')?.classList.contains('active')) viewport.scrollTop = 0;
    if (typeof window.renderDock === 'function') window.renderDock({ resetScroll: true });
    else syncButton();
  }

  document.addEventListener('click', event => {
    const wrapper = el('dockSort');
    if (wrapper && !wrapper.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  function attach() {
    document.querySelector('.app-viewport')?.addEventListener('scroll', closeMenu, { passive: true });
    syncButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  window.DockSort = { order, set, toggleMenu, closeMenu, noteArrivals, get mode() { return mode; } };
})();
