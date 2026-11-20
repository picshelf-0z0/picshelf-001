/* Exact-key receipts for completed video exports. Never scans the media library. */
(() => {
  'use strict';
  let database = null;
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
    return value;
  }
  function key(photo, edit) {
    const entry = photo.tarEntry || photo.zipEntry;
    const source = entry?.nativeSourceId ? ['native', entry.nativeSourceId, entry.offset, entry.localOffset, entry.size, entry.compSize, entry.method] :
      ['media', photo.id, photo.fileBlob?.size || photo.fileSize || 0, /^blob:/.test(photo.videoUrl || '') ? null : photo.videoUrl];
    const ownedClip = /^clip_/.test(String(photo.id)) && !photo.sharedVideoSource ?
      [photo.fileBlob?.size || photo.fileSize || null, photo.lastEditedAt || null] : null;
    return JSON.stringify(stable({id: photo.id, source, ownedClip, edit}));
  }
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('PicShelfVideoDownloadsDB', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('receipts', {keyPath:'key'});
      request.onsuccess = () => {request.result.onversionchange = () => {request.result.close();database=null;};resolve(request.result);};
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Download history unavailable'));
    }).catch(error => {database=null;throw error;});
    return database;
  }
  async function find(photo, edit) {
    if (typeof window.AndroidApp?.isDownloadedMediaPresent !== 'function') return null;
    try {
      const db=await open();
      const record=await new Promise((resolve,reject)=>{
        const tx=db.transaction('receipts','readonly'),request=tx.objectStore('receipts').get(key(photo,edit));let value=null;
        request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
      });
      return record && window.AndroidApp.isDownloadedMediaPresent(JSON.stringify(record.result)) ? record.result : null;
    } catch (_) {return null;}
  }
  async function record(photo, edit, result) {
    if (!result?.success || !result.uri || !(result.fileSize>0) || !(result.dateModified>0)) return;
    try {
      const db=await open();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction('receipts','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
        tx.objectStore('receipts').put({key:key(photo,edit),result:{success:true,uri:result.uri,fileSize:result.fileSize,dateModified:result.dateModified,displayPath:result.displayPath,fileName:result.fileName,mime:result.mime}});
      });
    } catch (_) { /* A history failure never changes a successful download. */ }
  }
  window.VideoDownloadHistory={find,record,key};
})();
