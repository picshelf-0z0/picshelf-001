/* Archive video posters and metadata, independent of image-scroll scheduling. */
(() => {
  'use strict';
  const jobs = new Map(), failures = new WeakMap(), registrations = new WeakMap();
  const previews = new Map();
  let previewBytes = 0;
  let active = 0, scheduled = false, saveTimer;
  const MAX_PENDING = 48, MAX_ACTIVE = 2;
  const supports = photo => !!photo && photo.mediaType === 'video' && !!(photo.tarEntry || photo.zipEntry || photo.fileBlob instanceof Blob);
  const poster = photo => window.VideoCardPreviews?.cardSource(photo) || [photo.thumbUrl, photo.posterUrl, photo.dataUrl].find(url => /^data:image\/(jpeg|png|webp);/i.test(url || '')) || null;
  const ready = photo => !!poster(photo) && Number.isFinite(photo.duration) && photo.duration > 0;
  const placeholder = () => window.ZIP_PLACEHOLDER_DATA_URL || '';
  const mime = photo => ({mp4:'video/mp4',m4v:'video/x-m4v',webm:'video/webm',mov:'video/quicktime',mkv:'video/x-matroska','3gp':'video/3gpp',avi:'video/x-msvideo',flv:'video/x-flv',wmv:'video/x-ms-wmv',ts:'video/mp2t'})[(photo.displayName || '').split('.').pop().toLowerCase()] || 'video/mp4';
  function durationLabel(photo) {
    return ready(photo) || photo._archiveDurationVerified ? window.formatDuration(photo.duration) : '—';
  }
  async function entryBlob(photo) {
    if (photo.fileBlob instanceof Blob) return photo.fileBlob;
    if (!photo.lastEditedAt && !photo.originalDataUrl && window.ArchiveSources?.entryInfo(photo)) {
      return window.ArchiveSources.originalBlob(photo);
    }
    if (!(photo.tarEntry?.tarFile instanceof Blob) && !(photo.zipEntry?.zipFile instanceof Blob)) {
      const saved = await window.getMediaBlobFromIDB?.(photo.id);
      if (saved instanceof Blob) return saved;
      throw Error('Archive unavailable');
    }
    if (photo.tarEntry?.tarFile instanceof Blob) {
      const e = photo.tarEntry;
      return e.tarFile.slice(e.offset, e.offset + e.size, mime(photo));
    }
    const e = photo.zipEntry;
    if (!e?.zipFile) throw Error('Archive unavailable');
    const h = new DataView(await e.zipFile.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
    if (h.byteLength !== 30 || h.getUint32(0, true) !== 0x04034b50) throw Error('Invalid ZIP header');
    const start = e.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const compressed = e.zipFile.slice(start, start + e.compSize, mime(photo));
    if (e.method === 0) return compressed;
    if (e.method !== 8) throw Error('Unsupported ZIP compression');
    try {
      const stream = compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Blob([await new Response(stream).blob()], {type: mime(photo)});
    } catch (_) {
      // Older WebViews use the bundled inflater in a worker, not the UI thread.
      const code = window._ZIP_WORKER_SCRIPT + '\nself.onmessage=async({data})=>{try{const bytes=self.pako.inflateRaw(new Uint8Array(await data.blob.arrayBuffer()));self.postMessage({blob:new Blob([bytes],{type:data.type})});}catch(e){self.postMessage({error:String(e)});}};';
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
        const worker = new Worker(url); URL.revokeObjectURL(url);
        const timer = setTimeout(() => { worker.terminate(); reject(Error('Video extraction timed out')); }, 120000);
        const finish = (value, error) => {clearTimeout(timer);worker.terminate();error ? reject(Error(error)) : resolve(value);};
        worker.onmessage = ({data}) => finish(data.blob, data.error);
        worker.onerror = e => finish(null, e.message);
        worker.postMessage({blob:compressed,type:mime(photo)});
      });
    }
  }
  async function source(photo) {
    if (photo.videoUrl) return photo.videoUrl;
    // Crop/resize save a poster and presentation settings, not new movie bytes.
    // Derived clips can own stripped/replaced bytes, so retain their existing
    // Blob/IndexedDB resolution rather than substituting an inherited archive.
    const presentationOnly = photo.mediaType === 'video' && (photo.videoCrop || photo.videoResize) &&
      !/^clip_/.test(String(photo.id)) && !photo.isMuted && !photo.muteAudioOnExport &&
      photo.trimStart == null && photo.trimEnd == null;
    const native = ((!photo.lastEditedAt && !photo.originalDataUrl) || presentationOnly || photo.sharedVideoSource) && window.ArchiveSources?.originalUrl(photo);
    if (native && !(photo.fileBlob instanceof Blob)) {
      // Android serves the selected entry with byte ranges. Playback does not
      // need to materialize a multi-gigabyte movie in a second WebView Blob.
      photo.videoUrl = native;
      return native;
    }
    if (photo._archiveVideoSourcePromise) return photo._archiveVideoSourcePromise;
    photo._archiveVideoSourcePromise = (async () => {
      photo.fileBlob = await entryBlob(photo);
      photo.videoUrl = URL.createObjectURL(photo.fileBlob);
      return photo.videoUrl;
    })();
    try {return await photo._archiveVideoSourcePromise;} finally {delete photo._archiveVideoSourcePromise;}
  }
  function nativeUrl(photo) {
    const source = !photo.lastEditedAt && !photo.originalDataUrl && window.ArchiveSources?.nativeInfo(photo);
    if (source) return `https://picshelf-thumbnails.invalid/${encodeURIComponent(source.token)}/video-${source.kind}/${source.offset}/${source.size}/${source.method}`;
    const e = photo.tarEntry || photo.zipEntry, file = e?.tarFile || e?.zipFile || photo.fileBlob;
    if (!(file instanceof Blob) || !window.AndroidApp?.registerThumbnailArchive) return null;
    if (!registrations.has(file)) registrations.set(file, window.AndroidApp.registerThumbnailArchive(file.name || '', file.size));
    const token = registrations.get(file);
    if (!token) return null;
    const zip = !!photo.zipEntry;
    return `https://picshelf-thumbnails.invalid/${token}/video-${zip ? 'zip' : 'tar'}/${zip ? e.localOffset : (e?.offset || 0)}/${zip ? e.compSize : (e?.size || file.size)}/${zip ? e.method : 0}`;
  }
  async function browserPreview(photo) {
    // A preview must not retain the original or a playback URL for every scrolled video.
    const native = !photo.lastEditedAt && !photo.originalDataUrl && window.ArchiveSources?.originalUrl(photo);
    const temporary = !photo.videoUrl && !native;
    const url = photo.videoUrl || native || URL.createObjectURL(await entryBlob(photo));
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      if (url.startsWith('https://picshelf-originals.invalid/')) video.crossOrigin = 'anonymous';
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      let duration = null, finished = false;
      const finish = (result, error) => {
        if (finished) return; finished = true; clearTimeout(timer);
        video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
        video.removeAttribute('src'); video.load(); video.remove();
        if (temporary) URL.revokeObjectURL(url);
        error ? reject(error) : resolve(result);
      };
      const capture = () => {
        try {
          if (!video.videoWidth || !video.videoHeight) throw Error('No video frame');
          const canvas = document.createElement('canvas');
          const scale = Math.min(512 / video.videoWidth, 512 / video.videoHeight, 1);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          finish({poster:canvas.toDataURL('image/jpeg', .82),duration});
        } catch (e) {finish(duration ? {duration} : null, duration ? null : e);}
      };
      const timer = setTimeout(() => finish(duration ? {duration} : null, duration ? null : Error('Video metadata timed out')), 15000);
      video.onloadedmetadata = () => {if(Number.isFinite(video.duration)&&video.duration>0)duration=video.duration;};
      video.onloadeddata = () => {const time=Math.min(.5,(duration || 0)/2);if(time>0)video.currentTime=time;else capture();};
      video.onseeked = capture;
      video.onerror = () => finish(null, Error('Unsupported or unreadable video'));
      video.src = url; video.load();
    });
  }
  function updateMounted(photo) {
    for (const card of document.querySelectorAll(`[data-id="${CSS.escape(String(photo.id))}"]`)) {
      const img = card.querySelector('img'), label = card.querySelector('.card-video-pill span');
      if (img && poster(photo)) {img.src=poster(photo);img.classList.remove('zip-deferred-thumb');}
      if (label) label.textContent = durationLabel(photo);
    }
  }
  function remember(photo, url) {
    const old = previews.get(photo);
    if (old) { previewBytes -= old.length; previews.delete(photo); }
    previews.set(photo, url); previewBytes += url.length;
    while (previews.size > 192 || previewBytes > 8 * 1024 * 1024) {
      const [item, value] = previews.entries().next().value;
      previews.delete(item); previewBytes -= value.length;
      // Only evict posters owned by this loader; never discard an edited image.
      for (const key of ['thumbUrl', 'posterUrl', 'dataUrl']) if (item[key] === value) item[key] = null;
    }
  }
  async function probe(photo) {
    const url = nativeUrl(photo);
    let result;
    if (url) {
      try {const response=await fetch(url);if(!response.ok)throw Error('Native video preview failed');result=await response.json();}
      catch (_) { /* Compatibility fallback for providers/codecs unsupported by the native retriever. */ }
    }
    if (!result?.poster) {
      const fallback = await browserPreview(photo).catch(() => null);
      result = fallback?.poster ? fallback : (result || fallback);
    }
    if (!result || !Number.isFinite(result.duration) || result.duration <= 0) throw Error('Video duration unavailable');
    photo.duration = result.duration; photo._archiveDurationVerified = true;
    if (result.poster) {
      photo.thumbUrl = photo.posterUrl = photo.dataUrl = result.poster;
      remember(photo, result.poster);
    }
    // Publish the small preview immediately. Playback/export resolve the original
    // on demand; a restored or slow original must not hold a ready poster hostage.
    updateMounted(photo);
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>window.saveState?.(),1000);
    return poster(photo);
  }
  function pump() {
    scheduled = false;
    while (active < MAX_ACTIVE) {
      const candidates=[...jobs.values()].filter(job=>!job.started);
      // Render is complete by this microtask: prioritize cards actually on screen.
      candidates.sort((a,b)=>(b.priority || 0)-(a.priority || 0) || visible(b.photo)-visible(a.photo));
      const job=candidates[0];if(!job)break;
      job.started=true;active++;
      probe(job.photo).then(job.resolve,()=>{failures.set(job.photo,Date.now());job.resolve(null);}).finally(()=>{jobs.delete(job.photo);active--;pump();});
    }
  }
  function visible(photo) {
    const card=document.querySelector(`[data-id="${CSS.escape(String(photo.id))}"]`);if(!card)return 0;
    const rect=card.getBoundingClientRect();return rect.bottom>0&&rect.top<innerHeight ? 1:0;
  }
  function request(photo, priority = 0, owner = null) {
    if (!supports(photo)) return Promise.resolve(null);
    if (ready(photo)) return Promise.resolve(poster(photo));
    if (Date.now()-(failures.get(photo)||0)<30000) return Promise.resolve(null);
    if (jobs.has(photo)) {const job=jobs.get(photo);job.priority=Math.max(job.priority || 0,priority);if(!owner)job.owner=null;return job.promise;}
    if(jobs.size>=MAX_PENDING){const old=[...jobs.values()].find(job=>!job.started&&!visible(job.photo));if(!old)return Promise.resolve(null);jobs.delete(old.photo);old.resolve(null);}
    let resolve;const promise=new Promise(r=>{resolve=r;});jobs.set(photo,{photo,promise,resolve,started:false,priority,owner});
    if(!scheduled){scheduled=true;queueMicrotask(pump);}return promise;
  }
  function get(photo, enqueue = true) {
    const resumePreview = window.VideoCardPreviews?.cardSource(photo);
    if (resumePreview) return resumePreview;
    if(ready(photo)) { if(previews.has(photo)) remember(photo, poster(photo)); }
    else if(enqueue) request(photo);
    return poster(photo)||placeholder();
  }
  function scheduleDock(photos, grid, center) {
    const ordered = photos.filter(supports).sort((a,b) => Math.abs(a._globalIndex-center)-Math.abs(b._globalIndex-center)).slice(0,24);
    const wanted = new Set(ordered);
    for (const [photo, job] of jobs) {
      if (job.owner === 'dock' && !job.started && !wanted.has(photo)) {jobs.delete(photo);job.resolve(null);}
    }
    for (let i=0;i<ordered.length;i++) {
      const photo=ordered[i], img=grid._cardMap?.get(photo.id)?.querySelector('img');
      const url=get(photo,false);
      if(img && url && img.getAttribute('src')!==url)img.src=url;
      request(photo,24-i,'dock');
    }
  }
  window.ArchiveVideoPreviews={supports,get,scheduleDock,resolve:request,source,durationLabel,stats:()=>({active,pending:jobs.size,previews:previews.size,previewBytes})};
})();
