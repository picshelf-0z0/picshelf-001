/* Shared nonmodal download controls. Only the visible job/file pages are rendered. */
(() => {
  'use strict';
  const PAGE_SIZE = 6, FILE_PAGE_SIZE = 20, MAX_FINISHED = 12;
  const jobs = new Map();
  const order = [], finished = [], retired = new Map();
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const statuses = new Set(['queued', 'preparing', 'processing', 'saving', ...terminal]);
  const fallback = {
    video_download_title: 'Video download', video_download_minimize: 'Minimize download progress',
    video_download_expand: 'Show download progress', video_download_dismiss: 'Dismiss',
    video_download_cancel: 'Cancel download', video_download_cancelling: 'Cancelling…',
    video_download_preparing: 'Preparing video…', video_download_processing: 'Processing video…',
    video_download_saving: 'Saving video…', video_download_completed: 'Video saved',
    video_download_failed: 'Download failed', video_download_cancelled: 'Download cancelled',
    video_download_saving_to: 'Saving to', video_download_saved_to: 'Saved to',
    video_download_processing_hint: 'Processing time depends on the clip and your device. You can keep using the player.',
    video_download_failed_hint: 'The video could not be saved. Please try downloading it again.',
    video_download_cancel_failed: 'Could not cancel yet. Please try again.',
    video_download_progress: 'Download progress', video_download_unnamed: 'Video',
    video_download_other_jobs: 'Other video downloads',
    video_download_already: 'Already downloaded', video_download_again: 'Download another copy',
    video_download_queued: 'Queued', video_download_partial: 'Some files could not be saved',
    video_download_downloads: 'Downloads', video_download_files: 'Files',
    video_download_previous: 'Previous', video_download_next: 'Next',
    video_download_cancelled_count: 'Cancelled: {count}',
    video_download_cancel_file: 'Cancel this file', video_download_cancel_remaining: 'Cancel remaining files',
    video_download_cancel_scope: 'Only this download is cancelled. Saved files and other downloads are kept.',
    video_download_cancel_waiting: 'Cancel waiting downloads',
    video_download_cancel_waiting_hint: 'Cancels all waiting files. Downloads already in progress continue; saved files are kept.',
    video_download_ok: 'OK', video_download_finished_hint: 'Tap OK to close all download cards. Your saved files are kept.',
    download_saved_progress: '{current} of {total} saved', download_failed_count: 'Failed: {count}',
    download_count: '{current} of {total}', download_retry: 'Retry failed',
    download_preparing: 'Preparing media for storage…', download_status_downloading: 'Downloading',
    download_status_completed: 'Completed', download_status_partial: 'Partially completed', download_status_pending: 'Pending',
    download_status_failed: 'Failed', download_status_cancelled: 'Cancelled',download_cancel: 'Cancel'
  };
  let host = null, content = null, announcement = null, announcedStatus = '', observer = null, frame = 0, selectedId = null, minimized = false;
  let badgePosition = null, placementNeeded = true, dragging = null, jobOffset = 0;
  let cancellingWaiting = false, waitingCancelError = false;
  const POSITION_KEY = 'picshelf_download_widget_position_v1';
  try {
    const stored=JSON.parse(localStorage.getItem(POSITION_KEY));
    if(stored && Number.isFinite(stored.left) && Number.isFinite(stored.top))badgePosition={left:stored.left,top:stored.top};
  } catch (_) {}

  function retire(job) {
    clearTimeout(job.dismissTimer);
    jobs.delete(job.id);
    const index=order.indexOf(job.id);if(index>=0)order.splice(index,1);
    const done=finished.indexOf(job.id);if(done>=0)finished.splice(done,1);
    retired.set(job.id,job.attempt||0);
    if (retired.size > 128) retired.delete(retired.keys().next().value);
  }
  function placeBadge() {
    if (!host || !minimized || dragging) return;
    placementNeeded = false;
    if(!badgePosition)badgePosition={left:Math.max(8,innerWidth-52),top:72};
    // Only clamp to a changed viewport. Screens, progress and scrolling never move it.
    host.style.setProperty('--video-badge-left',Math.max(8,Math.min(innerWidth-52,badgePosition.left))+'px');
    host.style.setProperty('--video-badge-top',Math.max(8,Math.min(innerHeight-52,badgePosition.top))+'px');
  }
  function requestPlacement() {
    if (!minimized) return;
    placementNeeded = true; schedule();
  }
  function bindBadgeDrag(chip) {
    let moved = false;
    chip.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      moved = false;
      const box = chip.getBoundingClientRect();
      dragging = {id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top};
      chip.setPointerCapture(event.pointerId);
    });
    chip.addEventListener('pointermove', event => {
      if (dragging?.id !== event.pointerId) return;
      const dx=event.clientX-dragging.x,dy=event.clientY-dragging.y;
      if (!moved && Math.hypot(dx,dy)<6) return;
      moved=true;
      badgePosition={left:Math.max(8,Math.min(innerWidth-52,dragging.left+dx)),top:Math.max(8,Math.min(innerHeight-52,dragging.top+dy))};
      host.style.setProperty('--video-badge-left',badgePosition.left+'px');
      host.style.setProperty('--video-badge-top',badgePosition.top+'px');
    });
    const finish=event=>{if(dragging?.id!==event.pointerId)return;dragging=null;if(moved){placementNeeded=true;try{localStorage.setItem(POSITION_KEY,JSON.stringify(badgePosition));}catch(_){}}schedule();};
    chip.addEventListener('pointerup',finish);
    chip.addEventListener('pointercancel',finish);
    chip.addEventListener('click',event=>{if(moved && event.detail>0){event.preventDefault();event.stopImmediatePropagation();}moved=false;},true);
  }

  function text(key, params = {}) {
    const value = window.t?.(key,params);
    return String(value && value !== key ? value : fallback[key] || key).replace(/\{(\w+)\}/g,(match,name)=>params[name]??match);
  }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }
  function label(tag, className, key) {
    const node = element(tag, className, text(key));
    node.dataset.i18n = key;
    return node;
  }
  function button(className, key, action, glyph) {
    const node = element('button', className, glyph == null ? text(key) : glyph);
    node.type = 'button';
    node.title = node.getAttribute('aria-label') || text(key);
    node.setAttribute('aria-label', text(key));
    node.dataset.i18nTitle = key;
    node.dataset.i18nAria = key;
    if (glyph == null) node.dataset.i18n = key;
    node.onclick = action;
    return node;
  }
  function renderKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return String(node.nodeType);
    return node.tagName + ':' + (node.dataset.action || node.dataset.jobId || node.dataset.fileId || node.dataset.scope || node.className);
  }
  function syncChildren(parent, next) {
    const available = new Map();
    for (const child of parent.childNodes) {
      const key = renderKey(child);
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(child);
    }
    let cursor = parent.firstChild;
    for (const fresh of [...next.childNodes]) {
      const current = available.get(renderKey(fresh))?.shift();
      const node = current || fresh;
      if (current && current.nodeType === Node.ELEMENT_NODE) {
        for (const attribute of [...current.attributes]) {
          if (!fresh.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        }
        for (const attribute of fresh.attributes) {
          if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        // Keep the live control, with the latest job/page callback.
        current.onclick = fresh.onclick;
        syncChildren(current, fresh);
      } else if (current && current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue;
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    for (const unused of available.values()) for (const node of unused) node.remove();
  }
  function statusKey(job) {
    if (job.status === 'completed' && job.alreadyDownloaded) return 'video_download_already';
    if(!job.cancelRequested && job.status==='partial')return 'download_status_partial';
    if(!job.cancelRequested && job.kind && job.kind!=='video') {
      if(job.status==='saving')return 'download_status_downloading';
      if(job.status==='preparing')return 'download_preparing';
      if(job.status==='completed')return 'download_status_completed';
    }
    return job.cancelRequested ? 'video_download_cancelling' : 'video_download_' + job.status;
  }
  function percent(job) {
    return job.progress == null ? '' : `${Math.round(job.progress * 100)}%`;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  function createHost() {
    if (host) return;
    host = element('aside', 'video-download-ui');
    placementNeeded = true;
    host.id = 'videoDownloadUI';
    host.setAttribute('aria-label', text('video_download_downloads'));
    host.dataset.i18nAria = 'video_download_downloads';
    content = element('div', 'video-download-ui__content');
    announcement = element('span', 'video-download-ui__announcement');
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    host.append(content, announcement);
    document.body.appendChild(host);
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    window.addEventListener('resize', requestPlacement, {passive:true});
  }
  function removeHost() {
    host?.remove(); host = null; content = null; announcement = null; announcedStatus = '';
    observer?.disconnect(); observer = null;
    window.removeEventListener('resize',requestPlacement);
    dragging=null;
  }
  function select(id) {
    selectedId = id;
    const index=order.indexOf(id);if(index>=0)jobOffset=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
    schedule();
  }
  function dismiss(id) {
    const job = jobs.get(id);
    if (!job || !terminal.has(job.status)) return;
    retire(job);
    if (selectedId === id) selectedId = [...jobs.values()].reverse().find(item => !terminal.has(item.status))?.id || [...jobs.keys()].at(-1) || null;
    schedule();
  }
  function requestCancel(job) {
    if (job.cancelRequested || terminal.has(job.status) || typeof job.onCancel !== 'function') return;
    job.cancelRequested = true;
    job.cancelError = false;
    schedule();
    try {
      Promise.resolve(job.onCancel(job.id)).catch(() => {
        if (jobs.get(job.id) !== job || terminal.has(job.status)) return;
        job.cancelRequested = false;
        job.cancelError = true;
        schedule();
      });
    } catch (_) {
      job.cancelRequested = false;
      job.cancelError = true;
      schedule();
    }
  }
  function progressNode(job, compact = false) {
    const progress = element('progress', 'video-download-ui__progress' + (compact ? ' is-compact' : ''));
    progress.max = 1;
    if (job.progress != null) progress.value = job.progress;
    progress.setAttribute('aria-label', text('video_download_progress'));
    progress.dataset.i18nAria = 'video_download_progress';
    return progress;
  }
  function hasWaitingDownloads() {
    try{return !!window.DownloadManager?.hasWaitingDownloads?.();}catch(_){return false;}
  }
  function allDownloadsFinished() {
    return jobs.size>0 && !cancellingWaiting && !hasWaitingDownloads() && [...jobs.values()].every(job=>terminal.has(job.status));
  }
  function acknowledgeFinishedDownloads() {
    if(!allDownloadsFinished())return;
    for(const job of [...jobs.values()])retire(job);
    selectedId=null;jobOffset=0;minimized=false;waitingCancelError=false;schedule();
  }
  async function requestCancelWaiting() {
    if(cancellingWaiting || !hasWaitingDownloads())return;
    cancellingWaiting=true;waitingCancelError=false;schedule();
    try{await window.DownloadManager.cancelWaitingDownloads();}
    catch(_){waitingCancelError=true;}
    finally{cancellingWaiting=false;schedule();}
  }
  function count(value) {return Number(value||0).toLocaleString(window.state?.language||'en');}
  function summary(job) {
    return Number.isFinite(job.totalCount) ? text('download_saved_progress',{current:count(job.savedCount),total:count(job.totalCount)}) :
      text(statusKey(job))+(percent(job)?' · '+percent(job):'');
  }
  function pager(offset, total, size, change, scope) {
    const row=element('div','video-download-ui__pager');
    row.dataset.scope=scope;
    const previous=button('video-download-ui__button','video_download_previous',()=>change(Math.max(0,offset-size)));
    previous.disabled=offset<=0;previous.dataset.action=scope+'-previous';
    const next=button('video-download-ui__button','video_download_next',()=>change(offset+size));
    next.disabled=offset+size>=total;next.dataset.action=scope+'-next';
    row.append(previous,element('span','',text('download_count',{current:count(Math.min(offset+size,total)),total:count(total)})),next);
    return row;
  }
  function appendFiles(panel,job) {
    if(typeof job.getItems!=='function')return;
    const toggle=button('video-download-ui__button','video_download_files',()=>{job.filesOpen=!job.filesOpen;schedule();});
    toggle.dataset.action='files';toggle.setAttribute('aria-expanded',String(!!job.filesOpen));panel.append(toggle);
    if(!job.filesOpen)return;
    let page;try{page=job.getItems(job.fileOffset||0,FILE_PAGE_SIZE);}catch(_){return;}
    if(!page || !Array.isArray(page.items))return;
    const list=element('div','video-download-ui__files');
    for(const item of page.items.slice(0,FILE_PAGE_SIZE)) {
      const row=element('div','video-download-ui__file');row.dataset.fileId=String(item.id);
      const copy=element('div','video-download-ui__file-copy');
      copy.append(element('span','video-download-ui__file-name',item.name||text('video_download_unnamed')));
      const key=item.cancelRequested?'video_download_cancelling':'download_status_'+(item.status==='queued'?'pending':item.status);
      copy.append(element('span','video-download-ui__file-status',text(key)));row.append(copy);
      if(['pending','queued','downloading'].includes(item.status) && typeof job.onCancelItem==='function') {
        const cancel=button('video-download-ui__button','download_cancel',()=>{
          Promise.resolve(job.onCancelItem(item.id)).catch(()=>{job.cancelError=true;schedule();});schedule();
        });
        cancel.disabled=!!item.cancelRequested;cancel.dataset.action='file-cancel-'+item.id;row.append(cancel);
      }
      list.append(row);
    }
    panel.append(list);
    if(page.total>FILE_PAGE_SIZE)panel.append(pager(job.fileOffset||0,page.total,FILE_PAGE_SIZE,offset=>{job.fileOffset=offset;schedule();},'files'));
  }
  function appendJobs(panel) {
    jobOffset=Math.min(jobOffset,Math.floor((order.length-1)/PAGE_SIZE)*PAGE_SIZE);
    const list=element('div','video-download-ui__jobs');list.setAttribute('aria-label',text('video_download_downloads'));
    for(const id of order.slice(jobOffset,jobOffset+PAGE_SIZE)) {
      const item=jobs.get(id);if(!item)continue;
      const row=element('div','video-download-ui__job-row');row.dataset.jobId=id;
      const tab=element('button','video-download-ui__job');tab.type='button';
      tab.setAttribute('aria-pressed',String(id===selectedId));tab.dataset.action='job-'+id;
      tab.append(element('span','video-download-ui__job-name',item.name||text('video_download_unnamed')),
        element('span','video-download-ui__job-status',summary(item)));
      if(Number.isFinite(item.totalCount))tab.append(element('span','video-download-ui__job-state',text(statusKey(item))));
      tab.onclick=()=>select(id);row.append(tab);
      if(!terminal.has(item.status)&&typeof item.onCancel==='function'){
        const cancel=button('video-download-ui__button','download_cancel',()=>requestCancel(item));
        cancel.disabled=!!item.cancelRequested;cancel.dataset.action='job-cancel-'+id;row.append(cancel);
      } else if(terminal.has(item.status)) {
        const close=button('video-download-ui__button','video_download_dismiss',()=>dismiss(id));
        close.dataset.action='job-dismiss-'+id;row.append(close);
      }
      list.append(row);
    }
    panel.append(list);
    if(order.length>PAGE_SIZE)panel.append(pager(jobOffset,order.length,PAGE_SIZE,offset=>{jobOffset=offset;schedule();},'jobs'));
  }
  function render() {
    if (dragging) return;
    if (!jobs.size) { removeHost(); return; }
    createHost();
    const job = jobs.get(selectedId) || jobs.get(order.at(-1));
    selectedId = job.id;
    const nextAnnouncement = job.id + ':' + text(statusKey(job));
    if (announcedStatus !== nextAnnouncement) {
      announcedStatus = nextAnnouncement;
      announcement.textContent = text(statusKey(job));
    }
    // Preserve the live scroller and controls during progress updates. Replacing
    // them interrupts touch/scrollbar gestures and can blank older WebViews.
    const fragment = document.createDocumentFragment();
    host.classList.toggle('is-minimized', minimized);
    if (minimized) {
      const chip = button('video-download-ui__chip', 'video_download_expand', () => { minimized = false; schedule(); });
      chip.dataset.action = 'expand';
      chip.textContent = '';
      chip.setAttribute('aria-label',text('video_download_expand')+' · '+text(statusKey(job))+' '+percent(job));
      chip.title=chip.getAttribute('aria-label');
      const glyph=element('span','video-download-ui__chip-glyph',job.status==='cancelled'?'×':job.status==='failed'?'!':job.status==='completed'?'✓':'↓');
      glyph.setAttribute('aria-hidden','true');chip.append(glyph);
      chip.append(label('span', 'video-download-ui__chip-status', statusKey(job)));
      if (percent(job)) chip.append(element('span', 'video-download-ui__percent', percent(job)));
      if (!terminal.has(job.status)) chip.append(progressNode(job, true));
      bindBadgeDrag(chip);
      fragment.append(chip);
    } else {
      const allFinished=allDownloadsFinished();
      const panel = element('section', 'video-download-ui__panel');
      const header = element('div', 'video-download-ui__header');
      header.append(label('strong', 'video-download-ui__title', 'video_download_downloads'));
      const minimize = button('video-download-ui__icon', 'video_download_minimize', () => { minimized = true; placementNeeded=true; schedule(); }, '−');
      minimize.dataset.action = 'minimize';
      const headerActions=element('div','video-download-ui__header-actions');
      if(allFinished){
        const okay=button('video-download-ui__button video-download-ui__ok','video_download_ok',acknowledgeFinishedDownloads);
        okay.dataset.action='acknowledge-all';headerActions.append(okay);
      }
      headerActions.append(minimize);header.append(headerActions);
      panel.append(header);
      const name = element('div', 'video-download-ui__name', job.name || text('video_download_unnamed'));
      name.title = job.name || text('video_download_unnamed');
      panel.append(name);
      if(Number.isFinite(job.totalCount)) {
        const counts=element('div','video-download-ui__counts');counts.append(element('span','',summary(job)));
        if(job.failedCount)counts.append(element('span','',text('download_failed_count',{count:count(job.failedCount)})));
        if(job.cancelledCount)counts.append(element('span','',text('video_download_cancelled_count',{count:count(job.cancelledCount)})));
        panel.append(counts);
      }
      const stateRow = element('div', 'video-download-ui__state');
      stateRow.dataset.status = job.status;
      const status = label('span', 'video-download-ui__status', statusKey(job));
      stateRow.append(status);
      if (percent(job)) stateRow.append(element('span', 'video-download-ui__percent', percent(job)));
      panel.append(stateRow);
      if (!terminal.has(job.status)) panel.append(progressNode(job));
      if (job.path && (job.status === 'completed' || !terminal.has(job.status))) {
        const location = element('div', 'video-download-ui__location');
        location.append(label('span', 'video-download-ui__path-label', job.status === 'completed' ? 'video_download_saved_to' : 'video_download_saving_to'));
        location.append(element('span', 'video-download-ui__path', job.path));
        panel.append(location);
      }
      if (job.status === 'processing') panel.append(label('p', 'video-download-ui__hint', 'video_download_processing_hint'));
      if (job.status === 'failed') panel.append(label('p', 'video-download-ui__hint', job.kind&&job.kind!=='video'?'download_warning_title':'video_download_failed_hint'));
      if (job.cancelError) panel.append(label('p', 'video-download-ui__hint', 'video_download_cancel_failed'));
      if (waitingCancelError) panel.append(label('p', 'video-download-ui__hint', 'video_download_cancel_failed'));
      const actions = element('div', 'video-download-ui__actions');
      if (terminal.has(job.status)) {
        if(['partial','failed'].includes(job.status)&&typeof job.onRetry==='function'){
          const retry=button('video-download-ui__button','download_retry',()=>Promise.resolve(job.onRetry()).catch(()=>{job.cancelError=true;schedule();}));
          retry.dataset.action='retry';actions.append(retry);
        }
        if (job.alreadyDownloaded && typeof job.onDownloadAgain === 'function') {
          const again = button('video-download-ui__button', 'video_download_again', job.onDownloadAgain);
          again.dataset.action = 'download-again'; actions.append(again);
        }
        const close = button('video-download-ui__button', 'video_download_dismiss', () => dismiss(job.id));
        close.dataset.action = 'dismiss'; actions.append(close);
      }
      if(!allFinished && typeof window.DownloadManager?.cancelWaitingDownloads==='function') {
        const cancel=button('video-download-ui__button',cancellingWaiting?'video_download_cancelling':'video_download_cancel_waiting',requestCancelWaiting);
        cancel.disabled=cancellingWaiting || !hasWaitingDownloads();
        cancel.dataset.action='cancel-waiting';actions.append(cancel);
      }
      panel.append(actions);
      if(allFinished)panel.append(label('p','video-download-ui__hint','video_download_finished_hint'));
      else if(typeof window.DownloadManager?.cancelWaitingDownloads==='function')panel.append(label('p','video-download-ui__hint','video_download_cancel_waiting_hint'));
      appendFiles(panel,job);
      appendJobs(panel);
      fragment.append(panel);
    }
    syncChildren(content, fragment);
    if(minimized && placementNeeded)placeBadge();
  }
  function update(value) {
    if (!value || value.id == null || !statuses.has(value.status)) return false;
    const id = String(value.id);
    const attempt=Number(value.attempt)||0;
    if (retired.has(id)) {if(attempt<=retired.get(id))return false;retired.delete(id);}
    let job = jobs.get(id);
    if(job && attempt<(job.attempt||0))return false;
    const retry=job && attempt>(job.attempt||0);
    // Late native progress callbacks cannot reopen an already completed job.
    if (job && terminal.has(job.status) && !terminal.has(value.status) && !retry) return false;
    if (!job) {
      job = { id, name: '', path: '', progress: null, onCancel: null, cancelRequested: false, cancelError: false };
      jobs.set(id, job);
      order.push(id);jobOffset=Math.floor((order.length-1)/PAGE_SIZE)*PAGE_SIZE;
      selectedId = id;
    }
    if(retry){job.cancelRequested=false;job.cancelError=false;job.alreadyDownloaded=false;job.progress=null;const index=finished.indexOf(id);if(index>=0)finished.splice(index,1);}
    const wasTerminal=terminal.has(job.status);
    job.attempt=attempt;
    job.status = value.status;
    if(terminal.has(job.status)&&!wasTerminal){finished.push(id);while(finished.length>MAX_FINISHED){const stale=jobs.get(finished[0]);if(stale)retire(stale);else finished.shift();}}
    if(value.status==='cancelled' && !job.dismissTimer)job.dismissTimer=setTimeout(()=>{if(jobs.get(id)===job && job.status==='cancelled')dismiss(id);},3000);
    else if(value.status!=='cancelled'){clearTimeout(job.dismissTimer);job.dismissTimer=null;}
    if ('name' in value) job.name = String(value.name || '');
    if ('path' in value) job.path = String(value.path || '');
    if ('onCancel' in value) job.onCancel = value.onCancel;
    if ('alreadyDownloaded' in value) job.alreadyDownloaded = !!value.alreadyDownloaded;
    if ('onDownloadAgain' in value) job.onDownloadAgain = value.onDownloadAgain;
    for(const key of ['kind','totalCount','savedCount','failedCount','cancelledCount','getItems','onCancelItem','onRetry'])if(key in value)job[key]=value[key];
    if ('progress' in value) job.progress = Number.isFinite(value.progress) ? Math.max(0, Math.min(1, value.progress)) : null;
    if (value.status === 'completed') job.progress = 1;
    if (terminal.has(value.status)) { job.cancelRequested = false; job.cancelError = false; job.onCancel = null; }
    schedule();
    return true;
  }
  function focus(id) {
    id = String(id);
    if (!jobs.has(id)) return false;
    selectedId = id; minimized = false; schedule();
    const index=order.indexOf(id);if(index>=0)jobOffset=Math.floor(index/PAGE_SIZE)*PAGE_SIZE;
    return true;
  }
  window.VideoDownloadUI = Object.freeze({ update, focus });
})();
