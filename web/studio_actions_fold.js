/* Photo editor: give the photo the room while editing.

   While the editing panel (Lux, Filters, Light, Color, Optics, Backdrop) is
   open, the action row (Crop, Resize, Collections, Share, Download, Delete) and
   Albums & Tags fold away under the tools, as in the Trim and NanoScope modes.
   The "More actions" bar brings them back at any time (Crop and Resize keep
   working from inside the editor), and closing the editor restores everything.

   Driven by the editor drawer's own "open" class, so every way into or out of
   the editor (tools, Crop/Resize returning to Backdrop, back button) behaves the
   same. Trim and NanoScope keep their own fold bars. */
(() => {
  'use strict';
  function attach() {
    const drawer = document.getElementById('detailEditStudioDrawer');
    const container = document.querySelector('.detail-container');
    const bar = document.getElementById('studioActionsFoldBar');
    if (!drawer || !container || !bar || bar.dataset.bound) return;
    bar.dataset.bound = '1';
    let restoreTimer = 0;
    const refit = () => { if (typeof window.fitDetailElements === 'function') window.fitDetailElements(); };

    function update() {
      clearTimeout(restoreTimer);
      if (drawer.classList.contains('open')) {
        if (container.classList.contains('studio-editing')) return;
        container.classList.add('studio-editing');
        container.classList.remove('studio-actions-unfolded');
        bar.setAttribute('aria-expanded', 'false');
        refit();
        return;
      }
      if (!container.classList.contains('studio-editing')) return;
      const restore = () => {
        if (drawer.classList.contains('open')) return;
        container.classList.remove('studio-editing', 'studio-actions-unfolded');
        bar.setAttribute('aria-expanded', 'false');
        refit();
      };
      // Video: bring the rows back once the editing panel has slid away; a layout change
      // while that panel is still on screen can freeze Android WebView's video picture.
      if (window.state?.activeMediaType === 'video') restoreTimer = setTimeout(restore, 330);
      else restore();
    }

    bar.addEventListener('click', event => {
      event.stopPropagation();
      const unfolded = container.classList.toggle('studio-actions-unfolded');
      bar.setAttribute('aria-expanded', unfolded ? 'true' : 'false');
      refit();
    });
    new MutationObserver(update).observe(drawer, { attributes: true, attributeFilter: ['class'] });
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
