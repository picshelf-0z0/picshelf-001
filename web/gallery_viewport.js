/* Keep Android's raster surface viewport-sized, independent of library size. */
(() => {
  'use strict';
  const views = new WeakMap();
  // A million rows exceed WebView's CSS height limit. Rebase a bounded
  // physical range while retaining the exact logical row and pixel offset.
  const RANGE_ROWS = 8192, EDGE_ROWS = 2048;
  function enabled() { return !!window.AndroidApp; }
  function reset(grid) {
    const view = views.get(grid);
    if (view) view.baseRow = 0;
  }
  function clear(grid) {
    if (!grid) return;
    views.delete(grid);
    grid.classList.remove('bounded-gallery');
    grid.style.removeProperty('height');
  }
  function position(grid) {
    const view = views.get(grid);
    const viewport = document.querySelector('.app-viewport');
    if (!view?.host.isConnected || !viewport) return;
    const height = Math.min(view.height, viewport.clientHeight);
    view.host.style.height = height + 'px';
    // Once the final row reaches the bottom, sticky positioning moves the
    // surface itself. Do not subtract that last portion of scrolling twice.
    const relative = Math.min(Math.max(0, viewport.scrollTop - grid.offsetTop),
      Math.max(0, view.height - height));
    view.inner.style.top = (view.top - view.baseRow * view.rowHeight - relative) + 'px';
  }
  function relative(grid, viewport, rebase = false) {
    const physical = Math.max(0, viewport.scrollTop - grid.offsetTop);
    const view = views.get(grid);
    if (!view?.host.isConnected) return physical;
    const logical = view.baseRow * view.rowHeight + physical;
    const maxBase = Math.max(0, view.totalRows - RANGE_ROWS);
    if (rebase && maxBase && (physical < EDGE_ROWS * view.rowHeight ||
        physical > (RANGE_ROWS - EDGE_ROWS) * view.rowHeight)) {
      const nextBase = Math.min(maxBase, Math.max(0,
        Math.floor(logical / view.rowHeight) - RANGE_ROWS / 2));
      if (nextBase !== view.baseRow) {
        const delta = (nextBase - view.baseRow) * view.rowHeight;
        view.baseRow = nextBase;
        viewport.scrollTop -= delta;
        position(grid);
      }
    }
    return logical;
  }
  function scrollToRow(grid, row) {
    const view = views.get(grid), viewport = document.querySelector('.app-viewport');
    if (!view || !viewport) return;
    row = Math.max(0, Math.min(view.totalRows - 1, Math.floor(row)));
    view.baseRow = Math.min(Math.max(0, view.totalRows - RANGE_ROWS), Math.max(0, row - RANGE_ROWS / 2));
    viewport.scrollTop = grid.offsetTop + (row - view.baseRow) * view.rowHeight;
    position(grid);
  }
  function reconcile(grid, photos, render, top, bottom, selector, reconcileGrid, rowHeight) {
    if (!enabled()) return false;
    let view = views.get(grid);
    if (!view?.host.isConnected) {
      grid.innerHTML = '';
      const host = document.createElement('div');
      host.className = 'gallery-raster-viewport';
      const inner = document.createElement('div');
      inner.className = 'gallery-raster-cards';
      inner.dataset.galleryViewport = 'true';
      host.append(inner);
      grid.append(host);
      grid.classList.add('bounded-gallery');
      view = {host, inner, baseRow: 0};
      views.set(grid, view);
    } else if (grid._cardMap !== view.inner._cardMap) {
      // Existing edit/filter paths invalidate the card map to request fresh
      // HTML. Preserve that contract, including selection and album surfaces.
      view.inner.innerHTML = '';
      view.inner._cardMap = new Map();
    }
    reconcileGrid(view.inner, photos, render, 0, 0, selector);
    grid._cardMap = view.inner._cardMap;
    view.top = top;
    view.rowHeight = rowHeight;
    view.totalRows = Math.round((top + bottom) / rowHeight) + Math.ceil(photos.length / 2);
    view.baseRow = Math.min(view.baseRow, Math.max(0, view.totalRows - RANGE_ROWS));
    view.height = Math.min(view.totalRows, RANGE_ROWS) * rowHeight;
    // The final Gallery/Dock window may be taller than the estimated row stride
    // (camera location tags, wrapped labels, or the first-row inset). Include
    // its actual extent so the raster surface cannot clip the final actions.
    if ((grid.id === 'galleryPhotoGrid' || grid.id === 'dockPhotoGrid') && bottom === 0) {
      const estimatedWindowHeight = Math.ceil(photos.length / 2) * rowHeight;
      view.height += Math.max(0, view.inner.scrollHeight - estimatedWindowHeight);
    }
    grid.style.height = (view.height + 16) + 'px';
    position(grid);
    return true;
  }
  window.GalleryViewport = {reconcile, position, clear, reset, relative, scrollToRow};
})();
