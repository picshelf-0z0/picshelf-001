/* Android export only. Existing dialogs, duplicate choices and history remain owned by DownloadManager. */
(function () {
  'use strict';
  const requests = new Map(), registrations = new WeakMap();
  let sequence = 0;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  // Logical downloads can queue freely. Keep just one render and one direct
  // single-file copy active; album copies retain their existing bounded batch.
  const lanes={render:{busy:false,queue:[]},copy:{busy:false,queue:[]}};
  function pumpLane(lane) {
    if(lane.busy)return;
    const entry=lane.queue.shift();if(!entry)return;
    lane.busy=true;entry.started=true;entry.session.cancellations?.delete(entry.cancel);
    // Admission is synchronous; protect work even before its preparing-status microtask.
    if(!entry.item)entry.session.laneStarted=true;
    Promise.resolve().then(()=>{if(entry.session.status==='cancelled'||entry.item?.cancelRequested||entry.item?.status==='cancelled')throw Error('Cancelled');return entry.work();})
      .then(entry.resolve,entry.reject).finally(()=>{lane.busy=false;pumpLane(lane);});
  }
  function inLane(session,item,kind,work) {
    const lane=lanes[kind];
    return new Promise((resolve,reject)=>{
      const entry={session,item,work,resolve,reject,started:false};
      entry.cancel=()=>{if(entry.started)return;const index=lane.queue.indexOf(entry);if(index>=0)lane.queue.splice(index,1);session.cancellations?.delete(entry.cancel);reject(Error('Cancelled'));};
      session.cancellations?.add(entry.cancel);lane.queue.push(entry);pumpLane(lane);
    });
  }
  function cancelSession(session) {
    for(const lane of Object.values(lanes))for(const entry of [...lane.queue])if(entry.session.sessionId===session.sessionId)entry.cancel();
  }
  function cancelItem(session,item) {
    if(!item||['completed','cancelled'].includes(item.status))return false;
    item.cancelRequested=true;
    for(const lane of Object.values(lanes))for(const entry of [...lane.queue])if(entry.session.sessionId===session.sessionId&&entry.item?.id===item.id)entry.cancel();
    if(item.nativeStarted)try{return window.AndroidApp.cancelDownloadItem?.(session.sessionId,item.id)!==false;}catch(_){}
    return true;
  }
  function hasWaitingDownloads() {
    for(const session of singleJobs.values())if(session.status==='queued'&&!session.laneStarted)return true;
    for(const lane of Object.values(lanes))if(lane.queue.some(entry=>entry.item&&!entry.item.cancelRequested&&entry.item.status!=='cancelled'&&entry.session.status!=='cancelled'))return true;
    return false;
  }
  function cancelWaitingDownloads() {
    // This synchronous snapshot cannot race admission, and never calls a native cancel bridge.
    const singles=[...singleJobs.values()].filter(session=>session.status==='queued'&&!session.laneStarted);
    const bulk=[];
    for(const lane of Object.values(lanes))for(const entry of lane.queue)if(entry.item&&!entry.item.cancelRequested&&entry.item.status!=='cancelled'&&entry.session.status!=='cancelled')bulk.push(entry);
    for(const session of singles){
      session.status='cancelled';session.cancellations.forEach(cancel=>cancel());session.cancellations.clear();singleStatus(session,'cancelled');
    }
    for(const entry of bulk){entry.item.cancelRequested=true;entry.cancel();}
    return singles.length+bulk.length;
  }
  const videoTypes = {mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',avi:'video/x-msvideo', '3gp':'video/3gpp',ts:'video/mp2t',flv:'video/x-flv'};
  const audioTypes = {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac'};
  const removedVideoAudio = photo => !!(photo.audioRemoved || photo.isMuted || photo.muteAudioOnExport || /^clip_noaudio_/.test(String(photo.id)));
  function mediaInfo(photo) {
    const entry = photo.tarEntry || photo.zipEntry;
    const name = entry?.baseName || entry?.fn || photo.fileBlob?.name || photo.originalFilename || photo.displayName || '';
    const ext = name.split('.').pop().toLowerCase();
    if (photo.mediaType === 'video' || videoTypes[ext]) return {ext:videoTypes[ext]?ext:'mp4',mime:videoTypes[ext]||'video/mp4',movie:true};
    if (photo.mediaType === 'audio' || audioTypes[ext]) return {ext:audioTypes[ext]?ext:'mp3',mime:audioTypes[ext]||'audio/mpeg',movie:true};
    return {ext:'jpg',mime:'image/jpeg',jpeg:/^(jpg|jpeg)$/i.test(ext),movie:false};
  }
  function nativeSource(photo, info) {
    if (photo.lastEditedAt || photo.originalDataUrl || photo.isMuted || photo.muteAudioOnExport) return null;
    if (!info.movie && !info.jpeg) return null;
    const source = window.ArchiveSources?.nativeInfo(photo);
    if (source) return source;
    const entry = photo.tarEntry || photo.zipEntry;
    const file = entry?.tarFile || entry?.zipFile || photo.fileBlob;
    if (file instanceof Blob) {
      if (!registrations.has(file)) {
        let token='';
        try { token=window.GalleryThumbnails?.register(file) || window.AndroidApp.registerThumbnailArchive(file.name || '',file.size); } catch (_) {}
        registrations.set(file,token);
      }
      const token = registrations.get(file);
      if (token) return {token,kind:photo.zipEntry?'zip':'tar',offset:photo.zipEntry?entry.localOffset:(entry?.offset || 0),size:photo.zipEntry?entry.compSize:(entry?.size || file.size),method:photo.zipEntry?entry.method:0};
    }
    const url = info.movie ? photo.videoUrl : photo.dataUrl;
    if (!entry && /^(assets\/|web\/|file:\/\/\/android_asset\/)/.test(url || '')) return {asset:url};
    return null;
  }
  function readBlob(url) {
    // Android's bundled file:// assets support XHR, but not fetch().
    return new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest();
      request.open('GET',url,true);request.responseType='blob';
      request.onload=()=>{
        if((request.status===0 || (request.status>=200 && request.status<300)) && request.response instanceof Blob && request.response.size>0)resolve(request.response);
        else reject(Error('Cannot read original media'));
      };
      request.onerror=()=>reject(Error('Cannot read original media'));
      request.onabort=()=>reject(Error('Original media read cancelled'));
      request.send();
    });
  }
  async function originalBlob(photo, info) {
    const edited = photo.lastEditedAt || photo.originalDataUrl;
    if (edited && !info.movie && photo.dataUrl) return readBlob(photo.dataUrl);
    if (photo.fileBlob instanceof Blob) return photo.fileBlob;
    if (!edited && window.ArchiveSources?.entryInfo(photo)) return window.ArchiveSources.originalBlob(photo);
    if (photo.tarEntry?.tarFile instanceof Blob) {
      const e = photo.tarEntry;
      return e.tarFile.slice(e.offset, e.offset + e.size);
    }
    if (photo.zipEntry?.zipFile instanceof Blob) {
      const e = photo.zipEntry;
      const header = new DataView(await e.zipFile.slice(e.localOffset, e.localOffset+30).arrayBuffer());
      if (header.byteLength !== 30 || header.getUint32(0,true) !== 0x04034b50) throw Error('Invalid ZIP header');
      const start = e.localOffset+30+header.getUint16(26,true)+header.getUint16(28,true);
      const compressed = e.zipFile.slice(start,start+e.compSize);
      if (e.method === 0) return compressed;
      if (e.method !== 8) throw Error('Unsupported ZIP compression');
      try { return await new Response(compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob(); }
      catch (_) {
        // Older WebViews: isolate decompression from the UI, one original at a time.
        const code = window._ZIP_WORKER_SCRIPT + '\nself.onmessage=async({data})=>{try{self.postMessage({blob:new Blob([self.pako.inflateRaw(new Uint8Array(await data.arrayBuffer()))])});}catch(e){self.postMessage({error:String(e)});}};';
        return new Promise((resolve,reject)=>{
          const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(url);URL.revokeObjectURL(url);
          worker.onmessage=({data})=>{worker.terminate();data.error?reject(Error(data.error)):resolve(data.blob);};
          worker.onerror=e=>{worker.terminate();reject(Error(e.message));};worker.postMessage(compressed);
        });
      }
    }
    const saved = await window.getMediaBlobFromIDB?.(photo.id);
    if (saved instanceof Blob) return saved;
    let url = info.movie ? photo.videoUrl : photo.dataUrl;
    if (!url && photo.gradient) url=window.generateGradientImage(photo.displayName,photo.category,photo.gradient);
    if (!url || (info.movie && /^data:image\//.test(url))) throw Error('Original media unavailable');
    return readBlob(url);
  }
  async function stage(photo, info, session) {
    let blob=await originalBlob(photo,info);
    if (info.movie && (photo.isMuted || photo.muteAudioOnExport)) {
      if (typeof window.stripAudioFromMediaBuffer !== 'function') throw Error('Muted export unavailable');
      blob=new Blob([window.stripAudioFromMediaBuffer(await blob.arrayBuffer(),photo.displayName)],{type:info.mime});
    } else if (!info.movie) {
      const header=new Uint8Array(await blob.slice(0,2).arrayBuffer());
      if (header[0]!==255 || header[1]!==216) {
        const url=URL.createObjectURL(blob);
        try { blob=(await window.convertToJpegBlob(url,0.95,false)).blob; if(!blob)throw Error('Image conversion failed'); }
        finally { URL.revokeObjectURL(url); }
      }
    }
    if (session.status==='cancelled') throw Error('Cancelled');
    const token=window.AndroidApp.beginDownloadStream(session.sessionId,blob.size);
    if (!token) throw Error('Cannot stage original media');
    try {
      for(let offset=0;offset<blob.size;offset+=1048576){
        if(session.status==='cancelled')throw Error('Cancelled');
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob.slice(offset,offset+1048576));});
        if(!window.AndroidApp.appendDownloadStream(token,base64))throw Error('Could not write original media');
        if(offset%1048576===0)await pause();
      }
      if(!window.AndroidApp.sealDownloadStream(token))throw Error('Incomplete original media');
      return {staged:token,expectedSize:blob.size};
    } catch(error){window.AndroidApp.discardDownloadStream(token);throw error;}
  }
  function send(session, batch, onProgress) {
    const requestId='export-'+(++sequence);
    return new Promise((resolve,reject)=>{
      requests.set(requestId,{resolve,reject,onProgress});
      try{window.AndroidApp.executeDownloadChunk(JSON.stringify({requestId,sessionId:session.sessionId,items:batch}));}
      catch(error){requests.delete(requestId);reject(error);}
    });
  }
  async function process(session) {
    const manager=window.DownloadManager,storage=manager.Storage,items=storage.getItems(session.sessionId);
    const references=new Map(),neededIds=new Set(),photoById=new Map(),destinations=new Set(),receiptWrites=new Set();
    let batch=[],lastSaved=performance.now(),lastUi=0,lastYield=performance.now();
    session.waitingCount ??= Math.max(0,items.length-(session.successfulCount||0)-(session.cancelledCount||0));
    session.nextItemIndex=0;
    const yieldIfNeeded=async()=>{if(performance.now()-lastYield>8){await pause();lastYield=performance.now();}};
    // One bounded scan; do not duplicate a million-item queue or map the whole library.
    const previousSuccessfulCount=session.successfulCount||0;
    session.successfulCount=0;session.failedCount=0;session.cancelledCount=session.cancelledCount||0;
    for(let index=0;index<items.length;index++){
      if(session.cancelWaitingFrom===0&&session.cancelWaitingTo>=items.length){session.successfulCount=previousSuccessfulCount;neededIds.clear();break;}
      const item=items[index];
      if(item.status==='completed')session.successfulCount++;
      else if(item.status==='cancelled'||manager.isWaitingItemCancelled(session,item,index))continue;
      else if(!item.photoRef)neededIds.add(item.assetId);
      if((index&511)===511)await yieldIfNeeded();
    }
    if(neededIds.size){
      let index=0;
      for(const photo of window.state?.photos||[]){
        if(neededIds.has(photo.id))photoById.set(photo.id,photo);
        if(photoById.size===neededIds.size)break;
        if((++index&511)===0)await yieldIfNeeded();
      }
    }
    if(session.status!=='cancelled')window.AndroidApp.resumeDownloadSession(session.sessionId);
    const checkpoint=()=>{
      if(performance.now()-lastSaved>1500){storage.saveSession(session);storage.saveItems(session.sessionId,items);lastSaved=performance.now();}
    };
    const update=(progressCurrent,force=false)=>{
      const completed=session.successfulCount+session.failedCount+session.cancelledCount;
      if(force||performance.now()-lastUi>120||completed===items.length){
        manager.updateProgressModal(session,completed,items.length,session.status==='cancelled'?'Cancelled':`Saved ${session.successfulCount} of ${items.length}`,progressCurrent);
        lastUi=performance.now();
      }
    };
    const record=(item,result)=>{
      item.completedAt=Date.now();item.error=result.error||null;
      const individuallyCancelled=item.cancelRequested || (result.cancelled && session.status!=='cancelled');
      item.status=result.success?'completed':individuallyCancelled?'cancelled':session.status==='cancelled'?'pending':'failed';
      item.nativeStarted=false;item.cancelRequested=false;
      if(result.success){
        item.fileSize=result.fileSize||0;session.successfulCount++;
        if (item.receiptPhoto && window.VideoDownloadHistory) {
          const pending = Promise.resolve(window.VideoDownloadHistory.record(item.receiptPhoto, item.receiptEdit, result)).catch(()=>{});
          receiptWrites.add(pending);pending.finally(()=>receiptWrites.delete(pending));
        }
        storage.recordRegistryEntry({assetId:item.assetId,originalIdentifier:item.assetId,contentHash:'original:'+item.assetId+':'+item.fileSize,filename:item.filename,sourceType:session.sourceType,sourceAlbumId:item.sourceAlbumId,sourceAlbumName:item.sourceAlbumName,sessionId:session.sessionId,exportLocation:item.destination,exportTimestamp:Date.now(),fileSize:item.fileSize},false);
      } else if(item.status==='failed')session.failedCount++;
      else if(item.status==='cancelled')session.cancelledCount++;
      delete item.receiptPhoto;delete item.receiptEdit;
    };
    const flush=async()=>{
      if(!batch.length)return;
      const queued=batch;batch=[];
      const sending=[],recorded=new Set();
      for(const payload of queued){const item=references.get(payload.id);if(item?.cancelRequested||item?.status==='cancelled'){
        if(item.status!=='cancelled')record(item,{success:false,cancelled:true});
        references.delete(payload.id);if(payload.source.staged)window.AndroidApp.discardDownloadStream(payload.source.staged);
      }else sending.push(payload);}
      if(!sending.length){update();checkpoint();return;}
      const before=session.successfulCount+session.failedCount+session.cancelledCount;
      let clipProgress=before;
      const recordOnce=(id,result)=>{
        const item=references.get(id);
        if(!item||recorded.has(id))return;
        recorded.add(id);record(item,result);
      };
      try {
        const perform=()=>{
          for(const payload of sending){const item=references.get(payload.id);if(item)item.nativeStarted=true;}
          return send(session,sending,message=>{
          for(const result of message.results||[])recordOnce(result.id,result);
          let progressCurrent=session.successfulCount+session.failedCount+session.cancelledCount;
          if(message.totalBytes>0&&message.bytesWritten>=0){
            // Bytes move the existing bar during a large file, while the count
            // only includes files that native MediaStore actually published.
            const fraction=Math.min(1,message.bytesWritten/message.totalBytes);
            progressCurrent=Math.max(progressCurrent,Math.min(before+sending.length-0.001,before+sending.length*fraction));
          }
          if(sending.length===1 && sending[0].videoEdit){
            if(Number.isFinite(message.fraction)){
              const fraction=Math.max(0,Math.min(1,message.fraction));
              const completedFraction=message.phase==='processing'?fraction*.95:.95+fraction*.05;
              clipProgress=Math.max(clipProgress,before+Math.min(.999,completedFraction));
            }
            progressCurrent=Math.max(progressCurrent,clipProgress);
          }
          update(progressCurrent,true);checkpoint();
          });
        };
        const results=sending.length===1&&sending[0].videoEdit
          ?await inLane(session,references.get(sending[0].id),'render',perform):await perform();
        const returned=new Map(results.map(result=>[result.id,result]));
        for(const payload of sending)recordOnce(payload.id,returned.get(payload.id)||{success:false,error:'Missing native result'});
      } catch(error){for(const payload of sending)recordOnce(payload.id,{success:false,error:error.message});}
      finally {for(const payload of sending){references.delete(payload.id);if(payload.source.staged)window.AndroidApp.discardDownloadStream(payload.source.staged);}}
      await Promise.all(receiptWrites);update();checkpoint();await yieldIfNeeded();
    };
    try {
      for(let index=0;index<items.length;index++){
        if(session.status==='cancelled')break;
        // A waiting-tail cancellation is logical, so a million skipped files cost no per-file work.
        if(index>=session.cancelWaitingFrom&&index<session.cancelWaitingTo){index=session.cancelWaitingTo-1;session.nextItemIndex=index+1;continue;}
        const item=items[index];
        session.nextItemIndex=index+1;
        if(!['pending','failed','downloading'].includes(item.status))continue;
        session.waitingCount=Math.max(0,(session.waitingCount||0)-1);
        item.status='downloading';item.startedAt=Date.now();
        try {
          if(!item.photoRef)item.photoRef=photoById.get(item.assetId);
          const photo=item.photoRef;if(!photo)throw Error('Original media unavailable');
          if(item.cancelRequested){record(item,{success:false,cancelled:true});continue;}
          const info=mediaInfo(photo);
          const video = info.mime.startsWith('video/');
          const edit = video ? videoEditSnapshot(photo) : null;
          if (video) {
            item.receiptPhoto={...photo,tarEntry:photo.tarEntry?{...photo.tarEntry}:undefined,zipEntry:photo.zipEntry?{...photo.zipEntry}:undefined};
            item.receiptEdit=edit;
          }
          const previous = video ? await window.VideoDownloadHistory?.find(photo, edit) : null;
          if(item.cancelRequested){record(item,{success:false,cancelled:true});continue;}
          if (session.status === 'cancelled') {item.status='pending';break;}
          const renderVideo=video && !previous && Object.keys(edit).length>0;
          if(renderVideo) await flush();
          const outputExt = previous ? previous.fileName.split('.').pop() : info.ext;
          item.filename=item.filename.replace(/\.[^.]+$/,'.'+outputExt);
          const legacyClip=video && /^clip_/.test(String(photo.id)) && !photo.sharedVideoSource;
          const ownedBlob=!previous && legacyClip ? photo.fileBlob || await window.getMediaBlobFromIDB?.(photo.id) : null;
          if(item.cancelRequested){record(item,{success:false,cancelled:true});continue;}
          if(session.status==='cancelled'){item.status='pending';break;}
          const inputPhoto=renderVideo ? {...photo,lastEditedAt:null,originalDataUrl:null,isMuted:false,muteAudioOnExport:false} : photo;
          let source=previous ? {exported:previous,expectedSize:previous.fileSize} : ownedBlob instanceof Blob ? null : nativeSource(inputPhoto,info);
          const stageSession={sessionId:session.sessionId,get status(){return item.cancelRequested?'cancelled':session.status;}};
          if(!source){await flush();source=await stage(ownedBlob instanceof Blob ? {...inputPhoto,fileBlob:ownedBlob} : inputPhoto,info,stageSession);}
          if(item.cancelRequested){if(source.staged)window.AndroidApp.discardDownloadStream(source.staged);record(item,{success:false,cancelled:true});continue;}
          if(session.status==='cancelled'){if(source.staged)window.AndroidApp.discardDownloadStream(source.staged);item.status='pending';break;}
          const directory=info.mime.startsWith('video/')?'Movies':info.mime.startsWith('audio/')?'Music':'Pictures';
          const displayPath=window.isNativeIOS
            ? 'Files › On My iPhone › '+session.destinationRelativePath.replace(/^Pictures\//,'')
            : directory+'/'+session.destinationRelativePath.replace(/^Pictures\//,'');
          if(!destinations.has(displayPath)){destinations.add(displayPath);session.exportDisplayPath=[...destinations].join(' · ');}
          const expectedSize=source.expectedSize||photo.zipEntry?.uncompSize||photo.tarEntry?.size||photo.fileBlob?.size||photo.fileSize||0;
          references.set(item.id,item);batch.push({id:item.id,fileName:item.filename,relativePath:item.destination,mime:previous?.mime || info.mime,expectedSize,source,...(renderVideo ? {videoEdit:edit} : {})});
          if(batch.length===16||source.staged||renderVideo)await flush();
        } catch(error){record(item,{success:false,error:error.message});update();checkpoint();}
        if(performance.now()-lastYield>8)await yieldIfNeeded();
      }
      await flush();
      if(session.status!=='cancelled')session.status=session.failedCount?(session.successfulCount?'partial':'failed'):
        session.cancelledCount?(session.successfulCount?'partial':'cancelled'):'completed';
    } finally {
      storage.flushRegistry();storage.saveSession(session);storage.saveItems(session.sessionId,items);
      manager.finishProgressModal(session);
    }
  }
  function singleMediaCopy(photo) {
    const info=mediaInfo(photo),key=String(photo.id)+'\ncopy:'+info.mime+':'+(photo.lastEditedAt||0);
    const current=singleJobs.get(key);if(current&&current.status!=='cancelled'){window.VideoDownloadUI?.focus(current.sessionId);return current.promise;}
    const snapshot={...photo,tarEntry:photo.tarEntry?{...photo.tarEntry}:undefined,zipEntry:photo.zipEntry?{...photo.zipEntry}:undefined};
    let fileName=(photo.displayName||'PicShelf_media').replace(/[/\\:*?"<>|\x00-\x1F]/g,'_');
    if(!fileName.toLowerCase().endsWith('.'+info.ext))fileName+='.'+info.ext;
    const session={sessionId:'single-'+Date.now()+'-'+(++sequence),kind:'media',status:'queued',fileName,displayPath:window.isNativeIOS?'Files › On My iPhone › PicShelf/':((info.mime.startsWith('audio/')?'Music':'Pictures')+'/PicShelf/'),cancellations:new Set(),promise:null};
    session.cancel=()=>{if(['completed','failed','cancelled'].includes(session.status))return;session.status='cancelled';session.cancellations.forEach(cancel=>cancel());session.cancellations.clear();try{window.AndroidApp.cancelDownloadSession?.(session.sessionId);}catch(_){}};
    singleJobs.set(key,session);singleStatus(session,'queued');
    session.promise=(async()=>{let source;try{
      return await inLane(session,null,'copy',async()=>{
        singleStatus(session,'preparing');source=nativeSource(snapshot,info)||await stage(snapshot,info,session);checkSingle(session);
        window.AndroidApp.resumeDownloadSession?.(session.sessionId);singleStatus(session,'saving',0);
        const results=await send(session,[{id:session.sessionId,awaitAcknowledgement:true,copyOnly:true,videoEdit:{},fileName,relativePath:'PicShelf/',mime:info.mime,source,
          expectedSize:source.expectedSize||snapshot.fileSize||snapshot.fileBlob?.size||0}],message=>{
            if(session.status!=='cancelled')singleStatus(session,'saving',Number.isFinite(message.fraction)?message.fraction:null);
          });
        const result=acceptSingleResult(session,results[0]);singleStatus(session,'completed',1,result);return result;
      });
    }catch(error){if(session.status==='cancelled')return{success:false,cancelled:true};singleStatus(session,'failed',null,{error:error.message});throw error;}
    finally{if(source?.staged)window.AndroidApp.discardDownloadStream(source.staged);session.cancellations.forEach(cancel=>cancel());session.cancellations.clear();if(session.status==='cancelled')singleStatus(session,'cancelled');if(singleJobs.get(key)===session)singleJobs.delete(key);}})();
    return session.promise;
  }
  // Single-video edits are rendered by Android. Keep the existing bulk export
  // path above independent, including its image conversion and duplicate rules.
  const singleJobs = new Map();
  function videoEditSnapshot(photo) {
    const edit = {};
    if (photo.videoCrop) {
      const crop = photo.videoCrop;
      edit.crop = {
        cropW: crop.cropW, cropH: crop.cropH, aspect: crop.aspect,
        normBox: crop.normBox ? { ...crop.normBox } : undefined,
        rotation: crop.rotation || 0, customAngle: crop.customAngle || 0,
        flipH: !!crop.flipH, flipV: !!crop.flipV
      };
    } else if (photo.videoResize) {
      const resize = photo.videoResize;
      edit.resize = {
        targetW: resize.targetW, targetH: resize.targetH, fitMode: resize.fitMode || 'contain',
        rotation: resize.rotation || 0, customAngle: resize.customAngle || 0,
        flipH: !!resize.flipH, flipV: !!resize.flipV
      };
    }
    if (photo.trimStart != null) edit.trimStart = photo.trimStart;
    if (photo.trimEnd != null) edit.trimEnd = photo.trimEnd;
    if (removedVideoAudio(photo)) edit.mute = true;
    if (photo.videoLooks) edit.looks = JSON.parse(JSON.stringify(photo.videoLooks));
    return edit;
  }
  function checkSingle(session) {
    if (session.status === 'cancelled') throw Error('Cancelled');
  }
  function acceptSingleResult(session,result) {
    if(session.status==='cancelled' && result?.success && result.uri){
      const cleaned=window.AndroidApp.discardCancelledVideoDownload?.(session.sessionId,result.uri);
      if(cleaned===false){session.status='failed';throw Error('Cancelled download cleanup could not be confirmed');}
      if(cleaned===true)window.AndroidApp.acknowledgeVideoDownloadResult?.(session.sessionId);
    }
    checkSingle(session);
    if(!result?.success)throw Error(result?.error||'Media export failed');
    window.AndroidApp.acknowledgeVideoDownloadResult?.(session.sessionId);
    return result;
  }
  function singleStatus(session, status, progress = null, result = null) {
    if (session.status === 'cancelled' && status !== 'cancelled') return;
    session.status = status;
    if (Number.isFinite(progress)) {
      session.progress = Math.max(session.progress || 0, Math.max(0, Math.min(1, progress)));
      progress = session.progress;
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    window.VideoDownloadUI?.update({
      id: session.sessionId, kind: session.kind || 'video', name: result?.fileName || session.fileName,
      status, progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null,
      path: result?.displayPath || session.displayPath,
      error: result?.error || null, onCancel: terminal ? null : session.cancel
    });
  }
  function cancellableRead(session, start) {
    checkSingle(session);
    return new Promise((resolve, reject) => {
      let done = false;
      let abort;
      const finish = (value, error) => {
        if (done) return;
        done = true;
        session.cancellations.delete(cancel);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => {
        if (done) return;
        try { abort?.(); } catch (_) {}
        finish(null, Error('Cancelled'));
      };
      session.cancellations.add(cancel);
      try { abort = start(value => finish(value), error => finish(null, error)); }
      catch (error) { finish(null, error); }
    });
  }
  function readSingleUrl(url, session) {
    return cancellableRead(session, (resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.responseType = 'blob';
      request.onload = () => {
        if ((request.status === 0 || (request.status >= 200 && request.status < 300)) && request.response instanceof Blob && request.response.size > 0) resolve(request.response);
        else reject(Error('Cannot read original media'));
      };
      request.onerror = () => reject(Error('Cannot read original media'));
      request.onabort = () => reject(Error('Cancelled'));
      request.onprogress = () => {
        if (session.status !== 'cancelled') singleStatus(session, 'preparing');
      };
      request.send();
      return () => request.abort();
    });
  }
  async function singleOriginalBlob(photo, session) {
    checkSingle(session);
    if (photo.fileBlob instanceof Blob) return photo.fileBlob;
    if (photo.tarEntry?.tarFile instanceof Blob) {
      const entry = photo.tarEntry;
      return entry.tarFile.slice(entry.offset, entry.offset + entry.size);
    }
    if (photo.zipEntry?.zipFile instanceof Blob) {
      const entry = photo.zipEntry;
      const header = new DataView(await entry.zipFile.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      checkSingle(session);
      if (header.byteLength !== 30 || header.getUint32(0, true) !== 0x04034b50) throw Error('Invalid ZIP header');
      const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      const compressed = entry.zipFile.slice(start, start + entry.compSize);
      if (entry.method === 0) return compressed;
      if (entry.method !== 8) throw Error('Unsupported ZIP compression');
      // Only the fallback for unregistered browser Blobs needs decompression.
      // Isolate it from playback and terminate its worker immediately on cancel.
      const code = window._ZIP_WORKER_SCRIPT + '\nself.onmessage=async({data})=>{try{let blob;try{blob=await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();}catch(_){blob=new Blob([self.pako.inflateRaw(new Uint8Array(await data.arrayBuffer()))]);}self.postMessage({blob});}catch(e){self.postMessage({error:String(e)});}};';
      return cancellableRead(session, (resolve, reject) => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = ({ data }) => { worker.terminate(); data.error ? reject(Error(data.error)) : resolve(data.blob); };
        worker.onerror = event => { worker.terminate(); reject(Error(event.message)); };
        worker.postMessage(compressed);
        return () => worker.terminate();
      });
    }
    const saved = await cancellableRead(session, (resolve, reject) => {
      Promise.resolve(window.getMediaBlobFromIDB?.(photo.id)).then(resolve, reject);
    });
    checkSingle(session);
    if (saved instanceof Blob) return saved;
    const url = photo.videoUrl || photo.dataUrl;
    if (!url || /^data:image\//.test(url)) throw Error('Original video unavailable');
    return readSingleUrl(url, session);
  }
  async function stageSingleVideo(photo, session) {
    const blob = await singleOriginalBlob(photo, session);
    checkSingle(session);
    const token = window.AndroidApp.beginDownloadStream(session.sessionId, blob.size);
    if (!token) throw Error('Cannot stage original video');
    try {
      let lastUi = 0;
      for (let offset = 0; offset < blob.size; offset += 1048576) {
        checkSingle(session);
        const end = Math.min(blob.size, offset + 1048576);
        const base64 = await cancellableRead(session, (resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(reader.error || Error('Cannot read original video'));
          reader.onabort = () => reject(Error('Cancelled'));
          reader.readAsDataURL(blob.slice(offset, end));
          return () => reader.abort();
        });
        checkSingle(session);
        if (!window.AndroidApp.appendDownloadStream(token, base64)) throw Error('Could not stage original video');
        if (performance.now() - lastUi >= 100 || end === blob.size) {
          singleStatus(session, 'preparing', (end / blob.size) * .05);
          lastUi = performance.now();
        }
        await pause();
      }
      checkSingle(session);
      if (!window.AndroidApp.sealDownloadStream(token)) throw Error('Incomplete original video');
      return { staged: token, expectedSize: blob.size };
    } catch (error) { window.AndroidApp.discardDownloadStream(token); throw error; }
  }
  function singleVideo(photo, options = {}) {
    const info = mediaInfo(photo);
    // Preserve the existing audio route when older callers use videoUrl for audio.
    if (!info.mime.startsWith('video/')) return singleMediaCopy(photo);
    const edit = videoEditSnapshot(photo);
    const key = String(photo.id) + '\n' + JSON.stringify(edit);
    const current = singleJobs.get(key);
    if (current && current.status !== 'cancelled') { window.VideoDownloadUI?.focus(current.sessionId); return current.promise; }
    const snapshot = { ...photo, tarEntry: photo.tarEntry ? { ...photo.tarEntry } : undefined, zipEntry: photo.zipEntry ? { ...photo.zipEntry } : undefined,
      videoCrop: photo.videoCrop ? {...photo.videoCrop,normBox:photo.videoCrop.normBox?{...photo.videoCrop.normBox}:undefined} : undefined,
      videoResize: photo.videoResize ? {...photo.videoResize} : undefined,
      videoLooks: photo.videoLooks ? JSON.parse(JSON.stringify(photo.videoLooks)) : undefined };
    const edited = Object.keys(edit).length > 0;
    // Native decides whether these settings require actual processing. Keep the
    // source container until then, including no-op metadata such as trimStart: 0.
    const ext = info.ext;
    const mime = info.mime;
    let fileName = (photo.displayName || 'PicShelf_video').replace(/[/\\:*?"<>|\x00-\x1F]/g, '_');
    if (!fileName.toLowerCase().endsWith('.' + ext)) fileName += '.' + ext;
    const session = { sessionId: 'single-' + Date.now() + '-' + (++sequence), status: 'queued', fileName, displayPath: window.isNativeIOS ? 'Files › On My iPhone › PicShelf/' : 'Movies/PicShelf/', cancellations: new Set(), promise: null };
    session.cancel = () => {
      if (['completed', 'failed', 'cancelled'].includes(session.status)) return;
      session.status = 'cancelled';
      session.cancellations.forEach(cancel => cancel());
      session.cancellations.clear();
      try { window.AndroidApp.cancelDownloadSession?.(session.sessionId); } catch (_) {}
    };
    singleJobs.set(key, session);
    singleStatus(session, 'queued');
    session.promise = (async () => {
      let source;
      try {
        const previous = await window.VideoDownloadHistory?.find(snapshot, edit);
        checkSingle(session);
        if (previous && !options.downloadAgain) {
          singleStatus(session, 'completed', 1, previous);
          window.VideoDownloadUI?.update({id:session.sessionId,status:'completed',alreadyDownloaded:true,
            onDownloadAgain:()=>singleVideo(snapshot,{downloadAgain:true}).catch(error=>console.warn('Video download failed',error))});
          return {...previous,alreadyDownloaded:true};
        }
        return await inLane(session,null,edited&&!previous?'render':'copy',async()=>{
        singleStatus(session,'preparing');
        // Declarative video edits do not replace the original movie bytes.
        // Older clips can own separately edited bytes despite retaining the
        // parent's archive reference. Never replace those bytes with the parent.
        const legacyClip = /^clip_/.test(String(snapshot.id)) && !snapshot.sharedVideoSource;
        const ownedBlob = !previous && legacyClip ? snapshot.fileBlob || await window.getMediaBlobFromIDB?.(snapshot.id) : null;
        checkSingle(session);
        if (ownedBlob instanceof Blob) source = await stageSingleVideo({...snapshot,fileBlob:ownedBlob},session);
        else source = previous ? {exported:previous,expectedSize:previous.fileSize} : window.ArchiveSources?.nativeInfo(snapshot) || nativeSource({ ...snapshot, originalDataUrl: null, lastEditedAt: null, isMuted: false, muteAudioOnExport: false }, info);
        if (!source) source = await stageSingleVideo(snapshot, session);
        checkSingle(session);
        window.AndroidApp.resumeDownloadSession?.(session.sessionId);
        const processing = edited && !previous;
        const outputName = previous ? fileName.replace(/\.[^.]+$/,'.'+previous.fileName.split('.').pop()) : fileName;
        singleStatus(session, processing ? 'processing' : 'saving', session.progress || 0);
        let lastUi = 0, lastPhase = '';
        const results = await send(session, [{ id: session.sessionId, awaitAcknowledgement:true, fileName:outputName, relativePath: 'PicShelf/', mime:previous?.mime || mime,
          expectedSize: source.expectedSize || snapshot.zipEntry?.uncompSize || snapshot.tarEntry?.size || snapshot.fileBlob?.size || snapshot.fileSize || 0,
          source, videoEdit: previous ? {} : edit }], message => {
          if (session.status === 'cancelled') return;
          const phase = message.phase === 'processing' ? 'processing' : 'saving';
          const fraction = Number.isFinite(message.fraction) ? message.fraction :
            message.totalBytes > 0 ? message.bytesWritten / message.totalBytes : null;
          if (phase !== lastPhase || performance.now() - lastUi >= 100 || fraction >= 1) {
            const overall = Number.isFinite(fraction) ? processing
              ? (phase === 'processing' ? Math.max(source.staged ? .05 : 0, fraction * .95) : .95 + fraction * .05)
              : (source.staged ? .05 + fraction * .95 : fraction) : null;
            singleStatus(session, phase, overall);
            lastUi = performance.now(); lastPhase = phase;
          }
        });
        const result = acceptSingleResult(session,results[0]);
        singleStatus(session, 'completed', 1, result);
        await Promise.resolve(window.VideoDownloadHistory?.record(snapshot, edit, result)).catch(()=>{});
        return result;
        });
      } catch (error) {
        if (session.status !== 'cancelled') singleStatus(session, 'failed', null, { error: error.message });
        if (session.status === 'cancelled') return { success: false, cancelled: true };
        throw error;
      } finally {
        if (source?.staged) window.AndroidApp.discardDownloadStream(source.staged);
        session.cancellations.forEach(cancel => cancel());
        session.cancellations.clear();
        if (session.status === 'cancelled') singleStatus(session, 'cancelled');
        if(singleJobs.get(key)===session)singleJobs.delete(key);
      }
    })();
    return session.promise;
  }
  window.NativeDownloads={process,mediaInfo,singleVideo,cancelItem,cancelSession,hasWaitingDownloads,cancelWaitingDownloads,onChunk(message){
    const pending=requests.get(message.requestId);if(!pending)return;
    if(message.progress===true){
      try{pending.onProgress?.(message);}catch(error){console.warn('[NativeDownloads] Progress callback failed',error);}
      return;
    }
    requests.delete(message.requestId);pending.resolve(Array.isArray(message.results)?message.results:[]);
  }};
})();
