/* Loading Dock selection toolbar.
   1. It travels with the cards: scrolling down carries it up under the header
      together with the cards (it never covers them and leaves no gap), and a
      short scroll up brings it straight back under the header. At the top of
      the list it is always in place. Scrolling stays native: only the
      toolbar's sticky offset changes, never the cards or the scroll physics.
   2. It stays two rows in every language and phone width: Select All, the
      selection count, Sort and the free-tier save pill on one line; the fixed
      action buttons and the 1-Tap Bulk Tag album chips on the other.
   The toolbar exists only while the Dock has cards; the empty Dock is untouched. */
(() => {
  'use strict';

  // ---- 1. Travel with the cards, return on scroll up ------------------------
  const RETURNED_CLASS = 'is-returned';
  const DIRECTION_SLOP_PX = 8;   // ignore jitter before acting on a direction
  // Only the user's own scrolling moves the toolbar. Scroll corrections from
  // re-renders, tab switches or restored positions never do.
  const GESTURE_WINDOW_MS = 600;
  const DRAG_SLOP_PX = 6;
  let returned = false;
  let lastTop = 0;
  let travel = 0;
  let lastGesture = -Infinity;
  let touchStartY = 0;
  let dragging = false;
  let toolbarHeight = 0;         // measured on resize, never during scrolling

  const byId = id => document.getElementById(id);
  const dockActive = () => !!byId('dockScreen')?.classList.contains('active');
  const noteGesture = () => { lastGesture = performance.now(); };

  function toolbarShown() {
    const toolbar = byId('dockActionStrip');
    return !!toolbar && toolbar.style.display !== 'none' &&
      !document.documentElement.classList.contains('library-loading');
  }

  // Switch between the two sticky offsets and glide between them (FLIP), so
  // the toolbar never jumps. Both positions are exact at the top of the list.
  function setReturned(next, scrollTop) {
    if (next === returned) return;
    returned = next;
    const shell = byId('dockToolbarShell');
    if (!shell) return;
    const tucked = Math.min(Math.max(scrollTop, 0), toolbarHeight);
    shell.classList.toggle(RETURNED_CLASS, next);
    const from = next ? -tucked : tucked;
    if (Math.abs(from) < 0.5 || !shell.animate ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    shell.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }

  function onScroll(event) {
    const top = event.currentTarget.scrollTop;
    const delta = top - lastTop;
    lastTop = top;
    if (!dockActive()) { setReturned(false, top); travel = 0; return; }
    if (top <= 0) { setReturned(false, 0); travel = 0; return; }
    if (!delta) return;
    travel = (travel > 0) === (delta > 0) ? travel + delta : delta;
    if (performance.now() - lastGesture > GESTURE_WINDOW_MS || !toolbarShown()) return;
    if (travel <= -DIRECTION_SLOP_PX) setReturned(true, top);
    else if (travel >= DIRECTION_SLOP_PX) setReturned(false, top);
  }

  // Sticky offsets come from the real header and toolbar heights.
  function measure() {
    const screen = byId('dockScreen'), header = byId('dockPinnedControls'), shell = byId('dockToolbarShell');
    if (!screen || !header || !shell) return;
    toolbarHeight = shell.getBoundingClientRect().height;
    screen.style.setProperty('--dock-pinned-h', header.getBoundingClientRect().height + 'px');
    screen.style.setProperty('--dock-shell-h', toolbarHeight + 'px');
  }

  // ---- 2. Two rows ---------------------------------------------------------
  // Row 1, each step only when the previous one still does not fit: the save
  //   pill shows just its count ("0 / 20"; its words stay for screen readers),
  //   Sort shows its icon only, Select All drops its "(N)", items sit a little
  //   closer, the count badge truncates with an ellipsis (numbers lead in every
  //   language), Select All shows its icon only.
  // Row 2: the action buttons never move. When their labels leave the album
  //   chips too little room, the labels wrap (as they always did on small
  //   phones) so the chips keep room to swipe.
  const BADGE_MIN_PX = 64;
  const CHIPS_MIN_PX = 40;
  let fitQueued = false;

  function fitActionRow() {
    const batch = byId('dockBatchActions');
    const strip = byId('dockQuickTagStrip');
    if (!batch || !strip || !batch.clientWidth) return;
    batch.classList.remove('is-wrap');
    if (strip.clientWidth < CHIPS_MIN_PX) batch.classList.add('is-wrap');
  }

  // The badge's full width, measured on an unanimated probe: a sub-pixel
  // shortfall already draws "…", and the badge pulses (scale) while selected.
  function badgeNaturalWidth(badge) {
    const probe = badge.cloneNode(true);
    probe.removeAttribute('id');
    probe.className = 'dock-selection-badge';
    probe.style.cssText = 'position:absolute;visibility:hidden;flex:none;width:max-content;' +
      'min-width:0;max-width:none;animation:none;transition:none';
    badge.parentElement.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }

  function fitNow() {
    fitQueued = false;
    const group = document.querySelector('#dockActionStrip .dock-select-group');
    if (!group || !group.clientWidth) return;
    fitActionRow();
    const pill = byId('dockLimitIndicator');
    const badge = byId('dockSelectedCountBadge');
    pill?.classList.remove('is-compact');
    group.classList.remove('is-sort-icon', 'is-short', 'is-tight', 'is-icon');
    const badgeNeeds = badge ? badgeNaturalWidth(badge) : 0;
    // Used width: fractional and unaffected by the pulse transform.
    const badgeHas = () => badge ? parseFloat(getComputedStyle(badge).width) : 0;
    const rowFits = () => group.scrollWidth <= group.clientWidth + 1;
    const fits = (need = badgeNeeds) => rowFits() && badgeHas() >= need - 0.01;
    const steps = [
      () => pill?.offsetWidth && pill.querySelector('.dock-limit-label') && pill.classList.add('is-compact'),
      () => byId('dockSortLabel') && group.classList.add('is-sort-icon'),
      () => group.querySelector('.dock-select-all-count') && group.classList.add('is-short'),
      () => group.classList.add('is-tight')
    ];
    if (fits()) return;
    for (const step of steps) {
      step();
      if (fits()) return;
    }
    if (fits(Math.min(badgeNeeds, BADGE_MIN_PX))) return;
    group.classList.add('is-icon');
  }

  // Coalesced to one measurement after the current update finishes.
  function fitSelectRow() {
    if (fitQueued) return;
    fitQueued = true;
    queueMicrotask(fitNow);
  }

  function attach() {
    const viewport = document.querySelector('.app-viewport');
    if (viewport && !viewport._dockToolbarTravel) {
      viewport._dockToolbarTravel = true;
      lastTop = viewport.scrollTop;
      // Passive listeners only: scrolling stays entirely on the compositor.
      const passive = { passive: true, capture: true };
      viewport.addEventListener('touchstart', e => {
        dragging = false;
        touchStartY = e.touches[0] ? e.touches[0].clientY : 0;
      }, passive);
      viewport.addEventListener('touchmove', e => {
        const touch = e.touches[0];
        if (!dragging && touch && Math.abs(touch.clientY - touchStartY) > DRAG_SLOP_PX) dragging = true;
        if (dragging) noteGesture();
      }, passive);
      viewport.addEventListener('touchend', () => { if (dragging) noteGesture(); }, passive);
      viewport.addEventListener('wheel', noteGesture, passive);
      viewport.addEventListener('scroll', onScroll, { passive: true });
    }

    // Refit and re-measure when the toolbar appears, the phone rotates, the
    // language changes the header's height, or fonts finish loading.
    const toolbar = byId('dockActionStrip');
    if (window.ResizeObserver) {
      let lastWidth = -1;
      const observer = new ResizeObserver(entries => {
        measure();
        for (const entry of entries) {
          if (entry.target !== toolbar) continue;
          const width = Math.round(entry.contentRect.width);
          if (width !== lastWidth) { lastWidth = width; fitSelectRow(); }
        }
      });
      [toolbar, byId('dockPinnedControls'), byId('dockToolbarShell')].forEach(node => node && observer.observe(node));
    }
    if (document.fonts) {
      document.fonts.ready?.then(fitSelectRow);
      document.fonts.addEventListener?.('loadingdone', fitSelectRow);
    }
    measure();
    fitSelectRow();
  }

  window.DockToolbar = { fitSelectRow };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
