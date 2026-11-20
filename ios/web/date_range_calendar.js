/* Android's system date dialog covers the range being edited. Keep the calendar
   in the date form, using the existing inputs and existing filter handlers. */
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.AndroidApp) return;
    const modal = document.getElementById('datePickerModal');
    if (!modal || modal.classList.contains('date-inline-enabled')) return;
    const body = modal.querySelector('.date-form-scroll');
    const fields = modal.querySelector('.date-range-fields');
    const panel = document.createElement('div');
    panel.className = 'date-inline-calendar';
    panel.hidden = true;
    fields.after(panel);
    const error = document.createElement('p'); error.className = 'date-calendar-error'; error.setAttribute('role','alert'); error.hidden = true; fields.after(error);
    modal.classList.add('date-inline-enabled');
    const controls = new Map(), yearControls = new Map();
    let active = null, year = 0, month = 0, draft = '', mode = 'calendar';
    const firstYear = 1000, lastYear = 9999, yearRowHeight = 44;
    let wheel = null, wheelContent = null, wheelShell = null, wheelYear = 0;
    let wheelPadding = 88, wheelFrame = null, wheelSettleTimer = null, panelLayoutFrame = null;
    let wheelTouching = false, wheelFormatter = null;
    const wheelRows = new Map(), wheelTouches = new Map();
    const locale = () => document.documentElement.lang || 'en';
    const label = key => window.t ? window.t(key) : key;
    const makeDate = (y, m, d) => { const date = new Date(2000, 0, 1, 12); date.setFullYear(y,m,d); return date; };
    const valueOf = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    function sync() {
      if ([...controls.keys()].every(input=>input.validity.valid)) error.hidden = true;
      for (const [input, button] of controls) {
        // Keep the range readable and in the requested day-month-year order.
        // ISO values remain in the existing inputs for filtering and validation.
        button.textContent = input.value ? input.value.split('-').reverse().join('-') : 'DD-MM-YYYY';
        button.setAttribute('aria-label', label(input.id === 'fromDatePicker' ? 'date_field_from' : 'date_field_to') + ': ' + button.textContent);
        button.setAttribute('aria-expanded', String(active === input && mode === 'calendar'));
        const yearButton = yearControls.get(input);
        if (yearButton) {
          const selectedYear = input.value ? Number(input.value.split('-')[0]) : null;
          yearButton.textContent = selectedYear == null ? 'YYYY' : new Intl.NumberFormat(locale(), {useGrouping:false}).format(selectedYear);
          yearButton.setAttribute('aria-label', label(input.id === 'fromDatePicker' ? 'date_field_from' : 'date_field_to') + ': ' + label('date_field_year') + (selectedYear == null ? '' : ' ' + yearButton.textContent));
          yearButton.setAttribute('aria-expanded', String(active === input && mode === 'year'));
        }
      }
    }
    function close() {
      if (wheelFrame != null) cancelAnimationFrame(wheelFrame);
      if (panelLayoutFrame != null) cancelAnimationFrame(panelLayoutFrame);
      clearTimeout(wheelSettleTimer);
      wheelFrame = panelLayoutFrame = wheelSettleTimer = null;
      wheelTouching = false; wheelFormatter = null; wheelRows.clear(); wheelTouches.clear();
      wheel = wheelContent = wheelShell = null;
      active = null; panel.hidden = true; modal.classList.remove('date-calendar-open', 'date-year-open'); sync();
    }
    function commit(value) {
      if (!active) return;
      const button = controls.get(active);
      active.value = value;
      active.dispatchEvent(new Event('change', {bubbles:true}));
      close(); button.focus({preventScroll:true});
    }
    function button(text, action, className = '') {
      const el = document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = text; el.onclick = action; return el;
    }
    const clampYear = value => Math.max(firstYear, Math.min(lastYear, value));
    const yearAtScroll = () => clampYear(firstYear + Math.round((wheel?.scrollTop || 0) / yearRowHeight));
    function renderYearRows() {
      if (!wheel || !wheelContent || mode !== 'year' || !active) return;
      const start = Math.max(firstYear, firstYear + Math.floor(wheel.scrollTop / yearRowHeight) - 3);
      const end = Math.min(lastYear, start + Math.ceil(wheel.clientHeight / yearRowHeight) + 7);
      // Retain rows while they remain visible; rebuilding them on every frame
      // interrupts painting during a native fling and wastes layout work.
      const touchedRows = new Set(wheelTouches.values());
      for (const [value, row] of wheelRows) {
        // Keep the gesture's target attached until release, even offscreen,
        // so touchend can still bubble when a long drag passes that year.
        if ((value < start || value > end) && !touchedRows.has(row.element)) { row.element.remove(); wheelRows.delete(value); }
      }
      const format = wheelFormatter || (wheelFormatter = new Intl.NumberFormat(locale(), {useGrouping:false}));
      for (let value = start; value <= end; value++) {
        let row = wheelRows.get(value);
        if (!row) {
          const option = document.createElement('div');
          option.className = 'date-year-option'; option.id = 'dateYearOption' + value;
          option.dataset.year = value; option.setAttribute('role','option');
          option.setAttribute('aria-posinset', value - firstYear + 1);
          option.setAttribute('aria-setsize', lastYear - firstYear + 1);
          option.textContent = format.format(value);
          option.onclick = () => selectWheelYear(value);
          row = {element:option, padding:null, selected:null}; wheelRows.set(value,row);
          // Preserve ascending DOM order for assistive technology, too.
          const next = [...wheelContent.children].find(el => Number(el.dataset.year) > value);
          wheelContent.insertBefore(option,next || null);
        }
        if (row.padding !== wheelPadding) {
          row.element.style.top = (wheelPadding + (value - firstYear) * yearRowHeight) + 'px'; row.padding = wheelPadding;
        }
        const selected = value === wheelYear;
        if (row.selected !== selected) { row.element.setAttribute('aria-selected',String(selected)); row.selected = selected; }
      }
      const descendant = 'dateYearOption' + wheelYear;
      if (wheel.getAttribute('aria-activedescendant') !== descendant) wheel.setAttribute('aria-activedescendant',descendant);
    }
    function selectWheelYear(value) {
      if (!wheel) return;
      clearTimeout(wheelSettleTimer);
      wheelYear = clampYear(value);
      wheel.scrollTop = (wheelYear - firstYear) * yearRowHeight;
      renderYearRows();
      wheel.focus({preventScroll:true});
    }
    function settleWheel() {
      if (!wheel || mode !== 'year' || wheelTouching) return;
      wheelYear = yearAtScroll();
      const top = (wheelYear - firstYear) * yearRowHeight;
      if (Math.abs(wheel.scrollTop - top) > .5) {
        wheel.scrollTo({top, behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
      }
      renderYearRows();
    }
    function commitYear() {
      if (!active || !wheel || mode !== 'year') return;
      // Read the latest position even if the scroll RAF or inertia is pending.
      const value = yearAtScroll(), input = active, trigger = yearControls.get(input);
      const model = document.getElementById(input.id === 'fromDatePicker' ? 'fromDateYear' : 'toDateYear');
      model.value = String(value);
      // Preserve the existing month/day and leap-day validation path.
      model.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      close(); trigger?.focus({preventScroll:true});
    }
    function fitYearWheel() {
      if (!wheel || !wheelShell || mode !== 'year' || panel.hidden) return;
      // Only the Date form scrolls. Its sticky range fields stay above the wheel.
      const fieldTop = fields.offsetTop;
      body.scrollTop = Math.max(0, fieldTop - body.offsetTop);
      const scale = body.offsetHeight ? body.getBoundingClientRect().height / body.offsetHeight : 1;
      const panelBox = panel.getBoundingClientRect(), bodyBox = body.getBoundingClientRect();
      const chromeHeight = panelBox.height / scale - wheelShell.offsetHeight;
      const available = Math.max(yearRowHeight, (bodyBox.bottom - panelBox.top) / scale - chromeHeight);
      const height = Math.min(yearRowHeight * 5, Math.max(yearRowHeight, Math.floor((available + .5) / yearRowHeight) * yearRowHeight));
      wheelShell.style.height = height + 'px';
      wheelPadding = (height - yearRowHeight) / 2;
      wheelContent.style.height = ((lastYear - firstYear + 1) * yearRowHeight + wheelPadding * 2) + 'px';
      // Padding grows equally around the center; keep the live scroll position
      // rather than snapping a drag when the viewport reports a resize.
      wheelYear = yearAtScroll();
      renderYearRows();
    }
    function scheduleYearLayout() {
      if (mode !== 'year' || !active) return;
      if (panelLayoutFrame != null) cancelAnimationFrame(panelLayoutFrame);
      panelLayoutFrame = requestAnimationFrame(() => {
        panelLayoutFrame = requestAnimationFrame(() => { panelLayoutFrame = null; fitYearWheel(); });
      });
    }
    function renderYearWheel() {
      if (wheelFrame != null) cancelAnimationFrame(wheelFrame);
      clearTimeout(wheelSettleTimer); wheelFrame = wheelSettleTimer = null;
      wheelTouching = false; wheelFormatter = null; wheelRows.clear(); wheelTouches.clear();
      panel.replaceChildren(); panel.classList.add('date-year-panel');
      const title = document.createElement('div'); title.className = 'date-year-heading';
      title.textContent = label(active.id === 'fromDatePicker' ? 'date_field_from' : 'date_field_to') + ' · ' + label('date_field_year');
      panel.append(title);
      wheelShell = document.createElement('div'); wheelShell.className = 'date-year-wheel-shell';
      wheelShell.style.height = (yearRowHeight * 5) + 'px'; wheelPadding = yearRowHeight * 2;
      const highlight = document.createElement('div'); highlight.className = 'date-year-wheel-highlight'; highlight.setAttribute('aria-hidden','true');
      wheel = document.createElement('div'); wheel.id = 'dateYearWheel'; wheel.className = 'date-year-wheel'; wheel.tabIndex = 0;
      wheel.setAttribute('role','listbox'); wheel.setAttribute('aria-label',title.textContent);
      wheelContent = document.createElement('div'); wheelContent.className = 'date-year-wheel-content'; wheelContent.setAttribute('role','presentation');
      wheelContent.style.height = ((lastYear - firstYear + 1) * yearRowHeight + wheelPadding * 2) + 'px';
      wheel.append(wheelContent); wheelShell.append(highlight,wheel); panel.append(wheelShell);
      wheel.addEventListener('scroll', event => {
        if (event.currentTarget !== wheel) return;
        clearTimeout(wheelSettleTimer);
        if (wheelFrame == null) wheelFrame = requestAnimationFrame(() => { wheelFrame = null; if (wheel) { wheelYear = yearAtScroll(); renderYearRows(); } });
        if (!wheelTouching) wheelSettleTimer = setTimeout(settleWheel, 140);
      }, {passive:true});
      wheel.addEventListener('touchstart', event => {
        if (event.currentTarget !== wheel) return;
        for (const touch of event.changedTouches) {
          if (wheel.contains(touch.target)) wheelTouches.set(touch.identifier,touch.target.closest?.('.date-year-option') || null);
        }
        wheelTouching = wheelTouches.size > 0; clearTimeout(wheelSettleTimer);
      }, {passive:true});
      const endWheelTouch = event => {
        if (event.currentTarget !== wheel) return;
        for (const touch of event.changedTouches) wheelTouches.delete(touch.identifier);
        wheelTouching = wheelTouches.size > 0;
        clearTimeout(wheelSettleTimer);
        // Subsequent inertia scroll events keep postponing this until rest.
        if (!wheelTouching) wheelSettleTimer = setTimeout(settleWheel, 140);
      };
      wheel.addEventListener('touchend', endWheelTouch, {passive:true});
      wheel.addEventListener('touchcancel', endWheelTouch, {passive:true});
      wheel.addEventListener('keydown', event => {
        const steps = {ArrowUp:-1,ArrowDown:1,PageUp:-10,PageDown:10};
        if (Object.prototype.hasOwnProperty.call(steps,event.key)) selectWheelYear(yearAtScroll() + steps[event.key]);
        else if (event.key === 'Home') selectWheelYear(firstYear);
        else if (event.key === 'End') selectWheelYear(lastYear);
        else if (event.key === 'Enter' || event.key === ' ') commitYear();
        else return;
        event.preventDefault(); event.stopPropagation();
      });
      const actions = document.createElement('div'); actions.className = 'date-calendar-actions';
      actions.append(button(label('nanoscope_curve_clear'),()=>commit(''),'date-year-clear'),button(label('crop_cancel'),()=>{const target=yearControls.get(active);close();target?.focus({preventScroll:true});},'date-year-cancel'),button(label('date_calendar_set'),commitYear,'date-year-set'));
      panel.append(actions); wheel.scrollTop = (wheelYear - firstYear) * yearRowHeight; renderYearRows(); scheduleYearLayout();
    }
    function render() {
      if (mode === 'year') { renderYearWheel(); return; }
      panel.classList.remove('date-year-panel');
      panel.replaceChildren();
      const header = document.createElement('div'); header.className = 'date-calendar-header';
      const title = document.createElement('span'); title.setAttribute('aria-live','polite');
      title.textContent = new Intl.DateTimeFormat(locale(), {month:'long',year:'numeric'}).format(makeDate(year,month,1));
      const move = delta => { month += delta; if(month<0){month=11;year--;} if(month>11){month=0;year++;} render(); };
      const prev = button('‹',()=>move(-1)), next = button('›',()=>move(1));
      prev.setAttribute('aria-label',new Intl.DateTimeFormat(locale(),{month:'long',year:'numeric'}).format(makeDate(year,month-1,1)));
      next.setAttribute('aria-label',new Intl.DateTimeFormat(locale(),{month:'long',year:'numeric'}).format(makeDate(year,month+1,1)));
      prev.disabled = year === 1000 && month === 0; next.disabled = year === 9999 && month === 11;
      header.append(prev,title,next); panel.append(header);
      const grid = document.createElement('div'); grid.className = 'date-calendar-days';
      for(let i=0;i<7;i++){const el=document.createElement('span');el.textContent=new Intl.DateTimeFormat(locale(),{weekday:'short'}).format(new Date(2026,0,4+i,12));grid.append(el);}
      for(let i=0;i<makeDate(year,month,1).getDay();i++)grid.append(document.createElement('span'));
      const days = makeDate(year,month+1,0).getDate();
      for(let day=1;day<=days;day++){
        const value=valueOf(year,month,day);
        // Choosing a day edits the range immediately. Apply Dates is still the
        // only action that commits these manually selected dates to the Gallery.
        const el=button(new Intl.NumberFormat(locale()).format(day),()=>commit(value),'date-calendar-day');
        el.setAttribute('aria-label',new Intl.DateTimeFormat(locale(),{dateStyle:'full'}).format(makeDate(year,month,day)));
        el.setAttribute('aria-pressed',String(value===draft)); grid.append(el);
      }
      panel.append(grid);
      const actions=document.createElement('div');actions.className='date-calendar-actions';
      actions.append(button(label('nanoscope_curve_clear'),()=>commit('')),button(label('crop_cancel'),()=>{const target=controls.get(active);close();target?.focus({preventScroll:true});}),button(label('date_calendar_set'),()=>commit(draft)));
      panel.append(actions);
    }
    function open(input) {
      document.activeElement?.blur();
      if(active===input && mode === 'calendar'){close();return;}
      close(); mode = 'calendar';
      active=input; draft=input.value||valueOf(new Date().getFullYear(),new Date().getMonth(),new Date().getDate());
      [year,month]=draft.split('-').map(Number);month--;
      panel.hidden=false;modal.classList.add('date-calendar-open');sync();render();
      requestAnimationFrame(()=>{
        if (active !== input || mode !== 'calendar' || panel.hidden) return;
        // Scroll only this form; keep both range fields above the calendar.
        const delta=fields.getBoundingClientRect().top-body.getBoundingClientRect().top;
        if(panel.getBoundingClientRect().bottom>body.getBoundingClientRect().bottom)body.scrollTop+=delta;
      });
    }
    function openYear(input) {
      document.activeElement?.blur();
      if (active === input && mode === 'year') { close(); return; }
      close(); mode = 'year'; active = input;
      wheelYear = clampYear(input.value ? Number(input.value.split('-')[0]) : new Date().getFullYear());
      panel.hidden = false; modal.classList.add('date-calendar-open','date-year-open'); sync(); renderYearWheel();
    }
    for(const prefix of ['from','to']){
      const input=document.getElementById(prefix+'DatePicker');
      const trigger=button('',()=>open(input),'date-inline-trigger');
      input.hidden=true; input.style.display='none'; input.after(trigger); controls.set(input,trigger);
      input.addEventListener('change',sync);
      input.addEventListener('invalid',event=>{event.preventDefault();error.textContent=input.validationMessage;error.hidden=false;trigger.focus({preventScroll:true});});
      const yearInput = document.getElementById(prefix+'DateYear');
      yearInput.hidden = true; yearInput.style.display = 'none'; yearInput.tabIndex = -1;
      const yearTrigger = button('',()=>openYear(input),'date-year-trigger');
      yearTrigger.id = prefix + 'DateYearTrigger'; yearTrigger.setAttribute('aria-haspopup','listbox'); yearTrigger.setAttribute('aria-controls','dateYearWheel');
      yearTrigger.addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if (active !== input || mode !== 'year') openYear(input);
        wheel?.focus({preventScroll:true});
        event.preventDefault(); event.stopPropagation();
      });
      yearInput.after(yearTrigger); yearControls.set(input,yearTrigger);
      yearInput.addEventListener('input',sync);
    }
    const closeForYear = event => { if(event.target.matches('.date-year-entry input')) close(); };
    modal.addEventListener('focusin', closeForYear);
    modal.addEventListener('pointerdown', closeForYear);
    modal.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&active){
        const target = mode === 'year' ? yearControls.get(active) : null;
        event.stopPropagation(); close();
        if (target) { event.preventDefault(); target.focus({preventScroll:true}); }
      }
    });
    window.addEventListener('resize',scheduleYearLayout,{passive:true});
    window.visualViewport?.addEventListener('resize',scheduleYearLayout,{passive:true});
    new MutationObserver(()=>{if(modal.style.display==='none')close();else sync();}).observe(modal,{attributes:true,attributeFilter:['style']});
    new MutationObserver(()=>{sync();if(active)render();}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    document.getElementById('dateFilterChip').addEventListener('click',()=>{close();body.scrollTop=0;});
    sync();
  });
})();
