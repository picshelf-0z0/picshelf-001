/* Manual timestamps belong only to the Trim editor; sliders remain authoritative. */
(() => {
  'use strict';
  const digitZeros = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];
  function parse(text) {
    let value = String(text ?? '').trim();
    if (!value || value.length > 24) return null;
    value = Array.from(value, c => {
      const n = c.codePointAt(0), zero = digitZeros.find(z => n >= z && n <= z + 9);
      return zero === undefined ? c : String(n - zero);
    }).join('').replace(/[\u066b,]/g, '.').replace(/\uff1a/g, ':');
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return null;
    const pieces = value.split(':').map(Number);
    if (pieces.slice(1).some(n => n >= 60)) return null;
    const seconds = pieces.reduce((sum, n) => sum * 60 + n, 0);
    return Number.isFinite(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 10 ? seconds : null;
  }
  function format(seconds) {
    const numeric = Number(seconds);
    const ticks = Math.max(0, Math.round((Number.isFinite(numeric) ? numeric : 0) * 10));
    const whole = Math.floor(ticks / 10), hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60, remainder = whole % 60;
    const pad = n => String(n).padStart(2, '0');
    return (hours ? pad(hours) + ':' : '') + pad(minutes) + ':' + pad(remainder) + '.' + ticks % 10;
  }
  let fields, sliders, error, onChange, owner, bound = false, touched = false, lastEdited = 0;
  const dirty = new Set();
  const t = (key, params) => window.t ? window.t(key, params) : key;
  function clearError() {
    if (error) { error.hidden = true; error.textContent = ''; }
    fields?.forEach(input => { input.removeAttribute('aria-invalid'); input.setCustomValidity(''); });
  }
  function invalid(key, params, index, focusInvalid) {
    const text = t(key, params);
    if (error) { error.textContent = text; error.hidden = false; }
    fields[index].setAttribute('aria-invalid', 'true');
    fields[index].setCustomValidity(text);
    if (focusInvalid) fields[index].focus({ preventScroll: true });
    return false;
  }
  function sync(start, end, options = {}) {
    if (!bound) return;
    if (options.reset || (options.owner !== undefined && options.owner !== owner)) {
      dirty.clear(); clearError(); touched = false;
    }
    if (options.owner !== undefined) owner = options.owner;
    [start, end].forEach((value, i) => {
      if (!dirty.has(i)) fields[i].value = format(value);
    });
  }
  function commit({ focusInvalid = true } = {}) {
    if (!bound || !dirty.size) return true;
    clearError();
    const max = Number(sliders[1].max);
    const values = fields.map(input => parse(input.value));
    for (let i = 0; i < 2; i++) {
      if (values[i] === null) return invalid('trim_time_invalid', {}, i, focusInvalid);
      if (!Number.isFinite(max) || max <= 0 || values[i] < 0 || values[i] > max + 0.000001) {
        return invalid('trim_time_bounds', { max: format(max) }, i, focusInvalid);
      }
    }
    // Match the existing tenth-second sliders, including a non-step-aligned end.
    const lastTick = Math.floor((max + 0.000001) * 10) / 10;
    const rounded = values.map(v => Math.min(lastTick, Math.round(v * 10) / 10));
    const gap = Math.min(0.5, lastTick);
    if (rounded[1] - rounded[0] < gap - 0.000001 || rounded[1] <= rounded[0]) {
      return invalid('trim_time_order', { gap: gap.toFixed(1) }, dirty.has(1) ? 1 : 0, focusInvalid);
    }
    const edited = lastEdited;
    const changed = rounded.some((v, i) => Math.abs(v - Number(sliders[i].value)) > 0.000001);
    rounded.forEach((v, i) => { sliders[i].value = String(v); });
    dirty.clear();
    sync(Number(sliders[0].value), Number(sliders[1].value));
    if (changed) onChange?.(Number(sliders[0].value), Number(sliders[1].value), edited);
    return true;
  }
  function markEditing() {
    document.documentElement.classList.toggle('trim-time-editing', fields.includes(document.activeElement));
  }
  function bind(options = {}) {
    if (bound) return;
    fields = ['trimStartTimeVal', 'trimEndTimeVal'].map(id => document.getElementById(id));
    sliders = ['trimStartSlider', 'trimEndSlider'].map(id => document.getElementById(id));
    error = document.getElementById('trimTimeError');
    if (fields.some(x => !x) || sliders.some(x => !x)) return;
    onChange = options.onChange; bound = true;
    fields.forEach((input, i) => {
      input.addEventListener('focus', markEditing);
      input.addEventListener('input', () => { dirty.add(i); touched = true; lastEdited = i; clearError(); });
      input.addEventListener('blur', () => { commit({ focusInvalid: false }); queueMicrotask(markEditing); });
      input.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); if (commit()) input.blur(); }
        if (event.key === 'Escape') {
          event.preventDefault(); sync(Number(sliders[0].value), Number(sliders[1].value), { reset: true }); input.blur();
        }
      });
    });
    // These guards run before the existing Save/Loop listeners read the range.
    for (const id of ['applyTrimBtn', 'trimLoopPreviewBtn']) {
      document.getElementById(id)?.addEventListener('click', event => {
        if (!commit()) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
    }
    document.getElementById('resetTrimBtn')?.addEventListener('click', () => { dirty.clear(); clearError(); touched = false; }, true);
    sliders.forEach(slider => slider.addEventListener('input', () => { dirty.clear(); clearError(); }, true));
    sync(Number(sliders[0].value), Number(sliders[1].value));
  }
  function end() {
    dirty.clear(); clearError(); touched = false;
    if (fields?.includes(document.activeElement)) document.activeElement.blur();
    document.documentElement.classList.remove('trim-time-editing');
  }
  window.PicShelfTrimTimes = Object.freeze({ parse, format, bind, sync, commit, end, isEditing: id => owner === id && touched });
})();
