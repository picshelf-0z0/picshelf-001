/* Albums screen: the Sort & filter menu (the button beside "New Album").

   Sort: Default Order, Recent Activity, Latest Photo, Newest First / Oldest
   First (the date each album was created), Name (A - Z) / Name (Z - A)
   (natural order: "Trip 2" before "Trip 10"), Most Photos / Fewest Photos.
   Show: All Albums, Favorites, With Photos, With Videos, Empty Albums.

   The chips under the search bar keep working exactly as before. They and this
   menu share state.albumSort / state.albumFilter, so they always agree;
   renderAlbumsScreen (app.js) does the ordering and filtering.

   The chosen sort is remembered on this device, so it survives app and phone
   restarts. It is written to localStorage, which is read synchronously at
   start-up, and mirrored to IndexedDB, which is on disk as soon as its write
   completes. WebView commits localStorage a moment after a change, so if the
   app is closed straight after one, the IndexedDB copy (stamped with the time
   of the choice) restores it on the next start. */
(() => {
  'use strict';
  const STORAGE_KEY = 'photo_org_album_sort';
  const STAMP_KEY = 'photo_org_album_sort_at';
  const SORTS = {
    'default': { icon: 'fa-solid fa-sort', key: 'albums_sort_default', text: 'Default Order' },
    'recent': { icon: 'fa-solid fa-clock-rotate-left', key: 'albums_sort_activity', text: 'Recent Activity' },
    'photo-desc': { icon: 'fa-regular fa-image', key: 'albums_sort_latest_photo', text: 'Latest Photo' },
    'created-desc': { icon: 'fa-solid fa-arrow-down-short-wide', key: 'gallery_sort_newest', text: 'Newest First' },
    'created-asc': { icon: 'fa-solid fa-arrow-up-wide-short', key: 'gallery_sort_oldest', text: 'Oldest First' },
    'alpha': { icon: 'fa-solid fa-arrow-down-a-z', key: 'gallery_sort_name_asc', text: 'Name (A - Z)' },
    'alpha-desc': { icon: 'fa-solid fa-arrow-down-z-a', key: 'gallery_sort_name_desc', text: 'Name (Z - A)' },
    'count': { icon: 'fa-solid fa-arrow-down-wide-short', key: 'albums_sort_count', text: 'Most Photos' },
    'count-asc': { icon: 'fa-solid fa-arrow-up-short-wide', key: 'albums_sort_fewest', text: 'Fewest Photos' }
  };
  const FILTERS = ['all', 'favorites', 'with_photos', 'with_videos', 'empty'];
  const el = id => document.getElementById(id);
  const app = () => window.state;

  // ---- Remembered choice ----------------------------------------------------
  const backup = (() => {
    const DB_NAME = 'picshelf_preferences', STORE = 'preferences', RECORD = 'albumSort';
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

  let savedMode = null;   // the sort held in storage
  let savedAt = 0;        // when it was chosen
  let chosenNow = false;  // chosen in this session: newer than anything stored
  try {
    const mode = localStorage.getItem(STORAGE_KEY);
    if (SORTS[mode]) {
      savedMode = mode;
      savedAt = Number(localStorage.getItem(STAMP_KEY)) || 0;
    }
  } catch (_) {}
  if (savedMode && app()) app().albumSort = savedMode;
  // The sort in effect. Only a change from it (a chip, the menu) is a new choice.
  let current = app()?.albumSort;

  function persist(mode) {
    if (!SORTS[mode] || mode === current) return;
    current = mode;
    chosenNow = true;
    savedMode = mode;
    savedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, mode);
      localStorage.setItem(STAMP_KEY, String(savedAt));
    } catch (_) {}
    backup.write({ mode, at: savedAt });
  }

  backup.read().then(record => {
    if (chosenNow) return;
    const mode = record && SORTS[record.mode] ? record.mode : null;
    const at = mode ? Number(record.at) || 0 : 0;
    if (!mode || (mode !== savedMode && at <= savedAt)) {
      // Nothing newer in the backup: keep it in step with localStorage.
      if (savedMode && (mode !== savedMode || at !== savedAt)) backup.write({ mode: savedMode, at: savedAt });
      return;
    }
    if (mode === savedMode) return;
    // localStorage missed the latest choice (the app closed straight after it).
    savedMode = mode;
    savedAt = at;
    current = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
      localStorage.setItem(STAMP_KEY, String(at));
    } catch (_) {}
    const s = app();
    if (!s || s.albumSort === mode) return;
    s.albumSort = mode;
    if (el('albumsCardGrid')?.childElementCount && typeof window.renderAlbumsScreen === 'function') window.renderAlbumsScreen();
    else sync();
  });

  // ---- Button and menu --------------------------------------------------------
  function counts() {
    const s = app();
    const views = s && window.LibraryViews?.get?.(s);
    if (!views) return null;
    const tags = Array.isArray(s.tags) ? s.tags : [];
    let withPhotos = 0, withVideos = 0, empty = 0;
    for (const tag of tags) {
      const photos = views.savedByTag.get(tag.name);
      if (photos && photos.length) {
        withPhotos++;
        if (window.LibraryViews.albumSummary(photos).videoCount > 0) withVideos++;
      } else {
        empty++;
      }
    }
    // The first three match the chips under the search bar.
    return { all: tags.length, favorites: views.favorites.length, with_photos: withPhotos, with_videos: withVideos, empty };
  }

  function fillCounts() {
    const values = counts();
    if (!values) return;
    el('albumSortMenu')?.querySelectorAll('[data-count]').forEach(node => {
      const value = values[node.dataset.count];
      const text = typeof value === 'number' ? String(value) : '';
      if (node.textContent !== text) node.textContent = text;
    });
  }

  function sync() {
    const s = app();
    if (!s) return;
    persist(s.albumSort);
    const wrapper = el('albumSort');
    if (wrapper) {
      // The menu sorts album cards; the Tag Manager view has no cards.
      const show = (s.currentAlbumView || 'albums') === 'albums';
      if (wrapper.hidden === show) wrapper.hidden = !show;
      if (!show) closeMenu();
    }
    const mode = SORTS[s.albumSort] ? s.albumSort : 'default';
    const conf = SORTS[mode];
    const icon = el('albumSortIcon');
    if (icon && icon.className !== conf.icon) icon.className = conf.icon;
    const label = el('albumSortLabel');
    if (label) {
      // data-i18n keeps the label right when the app language changes.
      if (label.getAttribute('data-i18n') !== conf.key) label.setAttribute('data-i18n', conf.key);
      const text = window.t ? window.t(conf.key) : conf.text;
      if (label.textContent !== text) label.textContent = text;
    }
    const filter = FILTERS.includes(s.albumFilter) ? s.albumFilter : 'all';
    const dot = el('albumSortFilterDot');
    if (dot && dot.hidden !== (filter === 'all')) dot.hidden = filter === 'all';
    const menu = el('albumSortMenu');
    if (!menu) return;
    menu.querySelectorAll('.album-sort-option').forEach(option => {
      const on = option.dataset.sort === mode;
      option.classList.toggle('active', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    menu.querySelectorAll('.album-sort-filter').forEach(option => {
      const on = option.dataset.filter === filter;
      option.classList.toggle('active', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const reset = el('albumSortResetBtn');
    if (reset) reset.hidden = mode === 'default' && filter === 'all';
    if (!menu.hidden) fillCounts();
  }

  // Keep the whole menu above the bottom navigation; it scrolls inside if needed.
  function fit(menu) {
    menu.style.maxHeight = '';
    const top = menu.getBoundingClientRect().top;
    const nav = document.querySelector('.bottom-nav');
    const navBox = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
    const navTop = navBox && navBox.height > 0 ? navBox.top : window.innerHeight;
    const bottom = Math.min(window.innerHeight, navTop) - 10;
    menu.style.maxHeight = `${Math.max(180, Math.floor(bottom - top))}px`;
  }

  let restoreBack = null;
  function closeMenu() {
    const menu = el('albumSortMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    el('albumSortBtn')?.setAttribute('aria-expanded', 'false');
    el('albumSort')?.classList.remove('open');
    if (restoreBack) {
      restoreBack();
      restoreBack = null;
    }
  }

  function openMenu() {
    const menu = el('albumSortMenu');
    if (!menu) return;
    menu.hidden = false;
    el('albumSortBtn')?.setAttribute('aria-expanded', 'true');
    el('albumSort')?.classList.add('open');
    menu.scrollTop = 0;
    sync();
    fit(menu);
    // Android Back closes the menu before anything else.
    const previous = window.handleNativeBackPressed;
    const handler = function () {
      closeMenu();
      return true;
    };
    window.handleNativeBackPressed = handler;
    restoreBack = () => {
      if (window.handleNativeBackPressed === handler) window.handleNativeBackPressed = previous;
    };
  }

  function toggleMenu(event) {
    if (event) event.stopPropagation();
    const menu = el('albumSortMenu');
    if (!menu) return;
    if (menu.hidden) openMenu();
    else closeMenu();
  }

  // Show the start of the newly ordered or filtered list.
  function showStart() {
    if (!el('albumsScreen')?.classList.contains('active')) return;
    const viewport = document.querySelector('.app-viewport');
    if (viewport && viewport.scrollTop > 0) viewport.scrollTop = 0;
  }

  function setSort(mode) {
    closeMenu();
    const s = app();
    if (!s || !SORTS[mode] || s.albumSort === mode) return;
    s.albumSort = mode;
    if (typeof window.renderAlbumsScreen === 'function') window.renderAlbumsScreen();
    else sync();
    showStart();
  }

  function setFilter(filter) {
    closeMenu();
    const s = app();
    if (!s || !FILTERS.includes(filter) || s.albumFilter === filter) return;
    if (typeof window.setAlbumFilter === 'function') window.setAlbumFilter(filter);
    showStart();
  }

  function reset() {
    closeMenu();
    const s = app();
    if (!s) return;
    const sortChanged = s.albumSort !== 'default';
    s.albumSort = 'default';
    if (s.albumFilter !== 'all' && typeof window.setAlbumFilter === 'function') window.setAlbumFilter('all');
    else if (sortChanged && typeof window.renderAlbumsScreen === 'function') window.renderAlbumsScreen();
    else sync();
    showStart();
  }

  // A tap outside closes the menu without also pressing what is underneath.
  document.addEventListener('click', event => {
    const menu = el('albumSortMenu');
    if (!menu || menu.hidden) return;
    const wrapper = el('albumSort');
    if (wrapper && wrapper.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
  function attach() {
    document.querySelector('.app-viewport')?.addEventListener('scroll', closeMenu, { passive: true });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  window.AlbumSort = {
    sync, toggleMenu, closeMenu, setSort, setFilter, reset,
    get mode() { return app()?.albumSort; }
  };
})();
