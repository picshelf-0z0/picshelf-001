/* Shared presentation for Palette Studio's native color popup. */
(() => {
  'use strict';
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('modalPickerNativeInput');
    if (!input) return;
    const modal = document.createElement('div');
    modal.id = 'spectrumPickerModal';
    modal.hidden = true;
    modal.innerHTML = `
      <section class="spectrum-dialog" role="dialog" aria-modal="true" aria-labelledby="spectrumTitle">
        <header class="spectrum-heading">
          <span data-i18n="color_modal_eyebrow">PALETTE STUDIO</span>
          <h3 id="spectrumTitle" data-i18n="spectrum_title">Choose a color</h3>
        </header>
        <div class="spectrum-preview">
          <span class="spectrum-swatch" id="spectrumPreviewSwatch" aria-hidden="true"></span>
          <div><span class="spectrum-caption" data-i18n="spectrum_selected">Selected color</span>
            <output id="spectrumHex" dir="ltr"></output></div>
        </div>
        <div class="spectrum-options">
          <div id="spectrumBasic">
            <p class="spectrum-label" data-i18n="spectrum_basics">Basic colors</p>
            <div class="spectrum-swatches"></div>
          </div>
          <div id="spectrumSliders" hidden>
            ${[['Hue', 'hue', 360], ['Saturation', 'saturation', 100], ['Brightness', 'brightness', 100]].map(([name, key, max]) => `
              <div class="spectrum-channel">
                <div class="spectrum-label-row"><label for="spectrum${name}" data-i18n="spectrum_${key}">${name}</label><output id="spectrum${name}Value" for="spectrum${name}" dir="ltr"></output></div>
                <input id="spectrum${name}" type="range" min="0" max="${max}" step="1" value="0">
              </div>`).join('')}
          </div>
          <button class="spectrum-more" type="button" aria-expanded="false" aria-controls="spectrumSliders" data-i18n="spectrum_more">More</button>
        </div>
        <footer class="spectrum-actions">
          <button class="spectrum-cancel" type="button" data-i18n="crop_cancel">Cancel</button>
          <button class="spectrum-set" type="button" data-i18n="spectrum_set">Set color</button>
        </footer>
      </section>`;
    document.body.append(modal);
    const get = id => modal.querySelector('#' + id);
    const ranges = ['Hue', 'Saturation', 'Brightness'].map(name => get('spectrum' + name));
    const more = modal.querySelector('.spectrum-more');
    let hsv = [0, 0, 0], draft = '#000000', expanded = false, returnFocus = null;

    function toHSV(hex) {
      const rgb = hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255);
      const [r, g, b] = rgb, max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
      let h = 0;
      if (delta) h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      return [(h * 60 + 360) % 360, max ? delta / max * 100 : 0, max * 100];
    }
    function toHex([h, s, v]) {
      s /= 100; v /= 100;
      const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
      const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
    }
    function render() {
      get('spectrumPreviewSwatch').style.background = draft;
      get('spectrumHex').textContent = draft.toUpperCase();
      ranges.forEach((range, i) => {
        range.value = Math.round(hsv[i]);
        get(range.id + 'Value').textContent = Math.round(hsv[i]) + (i === 0 ? '°' : '%');
        range.setAttribute('aria-valuetext', get(range.id + 'Value').textContent);
      });
      ranges[1].style.setProperty('--spectrum-track', `linear-gradient(to right, ${toHex([hsv[0], 0, hsv[2]])}, ${toHex([hsv[0], 100, hsv[2]])})`);
      ranges[2].style.setProperty('--spectrum-track', `linear-gradient(to right, #000000, ${toHex([hsv[0], hsv[1], 100])})`);
      modal.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === draft)));
    }
    function mode() {
      get('spectrumBasic').hidden = expanded;
      get('spectrumSliders').hidden = !expanded;
      more.dataset.i18n = expanded ? 'spectrum_less' : 'spectrum_more';
      more.textContent = window.t(more.dataset.i18n);
      more.setAttribute('aria-expanded', String(expanded));
    }
    function close() {
      modal.hidden = true;
      if (document.getElementById('customColorPickerModal')?.style.display !== 'none') returnFocus?.focus({ preventScroll: true });
    }
    function open(event) {
      event.preventDefault();
      returnFocus = input;
      draft = input.value.toLowerCase();
      hsv = toHSV(draft);
      mode(); render();
      modal.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = window.t(el.dataset.i18n); });
      modal.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', window.t(el.dataset.i18nAria)); });
      modal.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = window.t(el.dataset.i18nTitle); });
      input.setAttribute('aria-label', window.t('color_modal_spectrum_hint'));
      modal.hidden = false;
      (expanded ? ranges[0] : modal.querySelector('[data-color]')).focus({ preventScroll: true });
    }
    const colors = ['#ff0000', '#00ffff', '#0000ff', '#00ff00', '#ff00ff', '#ffff00', '#000000', '#ffffff'];
    const names = ['red', 'cyan', 'blue', 'green', 'magenta', 'yellow', 'black', 'white'];
    colors.forEach((color, i) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.color = color;
      button.dataset.i18nAria = 'spectrum_' + names[i];
      button.dataset.i18nTitle = 'spectrum_' + names[i];
      button.style.background = color;
      button.addEventListener('click', () => { draft = color; hsv = toHSV(color); render(); });
      modal.querySelector('.spectrum-swatches').append(button);
    });
    input.setAttribute('aria-haspopup', 'dialog');
    input.dataset.i18nAria = 'color_modal_spectrum_hint';
    input.addEventListener('click', open);
    ranges.forEach((range, i) => range.addEventListener('input', () => { hsv[i] = Number(range.value); draft = toHex(hsv); render(); }));
    more.addEventListener('click', () => { expanded = !expanded; mode(); });
    modal.querySelector('.spectrum-cancel').addEventListener('click', close);
    modal.querySelector('.spectrum-set').addEventListener('click', () => {
      input.value = draft;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    });
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    window.addEventListener('keydown', event => {
      if (modal.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...modal.querySelectorAll('button, input')].filter(el => el.getClientRects().length);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }, true);
    window.addEventListener('popstate', event => {
      if (!modal.hidden) { event.stopImmediatePropagation(); close(); }
    }, true);
    window.ColorSpectrumPicker = { close, isOpen: () => !modal.hidden };
  });
})();
