/* Original entries from Android's durable, picker-authorized archive registry. */
(() => {
  'use strict';
  const types = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
    svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4',
    m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
    mkv: 'video/x-matroska', '3gp': 'video/3gpp', avi: 'video/x-msvideo',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv', ts: 'video/mp2t',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', flac: 'audio/flac', wma: 'audio/x-ms-wma',
    opus: 'audio/opus', mid: 'audio/midi', midi: 'audio/midi'
  };
  function entryInfo(photo) {
    const entry = photo?.tarEntry || photo?.zipEntry;
    if (!entry?.nativeSourceId) return null;
    const zip = !!photo.zipEntry;
    const offset = zip ? entry.localOffset : entry.offset;
    const size = zip ? entry.compSize : entry.size;
    const method = zip ? entry.method : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(size) || size <= 0 ||
        (method !== 0 && !(zip && method === 8))) return null;
    const name = entry.baseName || entry.fn || photo.originalFilename || photo.displayName || '';
    const ext = name.split('.').pop().toLowerCase();
    const mime = types[ext] || (photo.mediaType === 'video' ? 'video/mp4' :
      photo.mediaType === 'audio' ? 'audio/mpeg' : 'application/octet-stream');
    const length = zip ? entry.uncompSize : entry.size;
    return { token: String(entry.nativeSourceId), kind: zip ? 'zip' : 'tar',
      offset, size, method, mime,
      length: Number.isSafeInteger(length) && length >= 0 ? length : (method === 0 ? size : null) };
  }
  function getOriginalsOrigin() {
    return window.__PICSHELF_IOS_ORIGINALS_ORIGIN || (window.isNativeIOS ? 'picshelf-originals://local/' : 'https://picshelf-originals.invalid/');
  }
  function getThumbnailsOrigin() {
    return window.__PICSHELF_IOS_THUMBNAILS_ORIGIN || (window.isNativeIOS ? 'picshelf-thumbnails://local/' : 'https://picshelf-thumbnails.invalid/');
  }
  const LOOPBACK_ORIG_RE = /^http:\/\/127\.0\.0\.1:\d+\/ps-[a-f0-9]+\/originals\//i;
  const LOOPBACK_THUMB_RE = /^http:\/\/127\.0\.0\.1:\d+\/ps-[a-f0-9]+\/thumbs\//i;
  function isOriginalUrl(url) {
    return typeof url === 'string' && (
      url.startsWith('https://picshelf-originals.invalid/') ||
      url.startsWith('picshelf-originals://local/') ||
      url.startsWith(getOriginalsOrigin()) ||
      LOOPBACK_ORIG_RE.test(url)
    );
  }
  function isThumbnailUrl(url) {
    return typeof url === 'string' && (
      url.startsWith('https://picshelf-thumbnails.invalid/') ||
      url.startsWith('picshelf-thumbnails://local/') ||
      url.startsWith(getThumbnailsOrigin()) ||
      LOOPBACK_THUMB_RE.test(url)
    );
  }
  function originalUrl(photo) {
    const info = entryInfo(photo);
    if (!info) return null;
    const length = info.length === null ? '' : `&length=${info.length}`;
    return `${getOriginalsOrigin()}${encodeURIComponent(info.token)}/${info.kind}/${info.offset}/${info.size}/${info.method}?type=${encodeURIComponent(info.mime)}${length}`;
  }
  async function originalBlob(photo) {
    const url = originalUrl(photo);
    if (!url) throw Error('Archive source unavailable');
    const info = entryInfo(photo);
    if (info.length > 0x7fffffff) {
      // Older Android WebViews cannot materialize a single response above
      // 2 GiB. Keep each response bounded and join its disk-backed Blob parts.
      const parts = [], chunkSize = 8 * 1024 * 1024;
      let offset = 0;
      while (offset < info.length) {
        const requestedEnd = Math.min(info.length - 1, offset + chunkSize - 1);
        const response = await fetch(url, { headers: { Range: `bytes=${offset}-${requestedEnd}` } });
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec((response.headers.get('Content-Range') || '').trim());
        const start = range && Number(range[1]), end = range && Number(range[2]), total = range && Number(range[3]);
        if (response.status !== 206 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            !Number.isSafeInteger(total) || start !== offset || end < start || end > requestedEnd || total !== info.length) {
          await response.body?.cancel().catch(() => {});
          throw Error('Invalid original archive media range');
        }
        const chunk = await response.blob();
        if (chunk.size !== end - start + 1) throw Error('Incomplete original archive media range');
        parts.push(chunk);
        offset = end + 1;
      }
      const blob = new Blob(parts, { type: info.mime });
      if (blob.size !== info.length) throw Error('Incomplete original archive media');
      return blob;
    }
    const response = await fetch(url);
    if (!response.ok) throw Error('Cannot read original archive media');
    const blob = await response.blob();
    if (info.length !== null && blob.size !== info.length) throw Error('Incomplete original archive media');
    return blob.type === info.mime ? blob : new Blob([blob], { type: info.mime });
  }
  function nativeInfo(photo) {
    const info = entryInfo(photo);
    if (!info) return null;
    const { token, kind, offset, size, method } = info;
    return { token, kind, offset, size, method };
  }
  window.ArchiveSources = {
    entryInfo, originalUrl, originalBlob, nativeInfo,
    get originalsOrigin() { return getOriginalsOrigin(); },
    get thumbnailsOrigin() { return getThumbnailsOrigin(); },
    isOriginalUrl, isThumbnailUrl
  };
})();
