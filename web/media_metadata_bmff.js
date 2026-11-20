/* Bounded MP4/M4A/QuickTime location reads for persisted local Blobs.
   Skip movie payloads; inspect only recognized metadata boxes. */
(() => {
  'use strict';
  const MAX_BYTES = 2 * 1024 * 1024, MAX_BOXES = 512, MAX_DEPTH = 8, MAX_TEXT = 65536;
  const utf8 = new TextDecoder('utf-8', { fatal: false });
  function location(latitude, longitude) {
    return Number.isFinite(latitude) && Number.isFinite(longitude) &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? { latitude, longitude } : null;
  }
  function iso6709(text) {
    const match = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\/?$/.exec(text.replace(/\0+$/, '').trim());
    return match ? location(Number(match[1]), Number(match[2])) : null;
  }
  async function read(blob, options = {}) {
    let bytes = 0, boxes = 0, recognized = false;
    const signal = options.signal;
    const validSize = Number.isSafeInteger(blob?.size) && blob.size >= 8;
    if (!validSize) return { status: 'unsupported', location: null };
    function aborted() { if (signal?.aborted) throw new DOMException('Metadata read cancelled', 'AbortError'); }
    async function slice(start, length) {
      aborted();
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
          start > blob.size || length > blob.size - start || bytes + length > MAX_BYTES) throw Error('Metadata read limit');
      bytes += length;
      const buffer = await blob.slice(start, start + length).arrayBuffer();
      aborted();
      if (buffer.byteLength !== length) throw Error('Incomplete metadata');
      return new Uint8Array(buffer);
    }
    const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = data => String.fromCharCode(...data.subarray(4, 8));
    async function header(start, end) {
      if (++boxes > MAX_BOXES || end - start < 8) throw Error('Metadata box limit');
      const data = await slice(start, 8), v = view(data);
      let size = v.getUint32(0, false), count = 8;
      if (size === 1) {
        if (end - start < 16) throw Error('Incomplete extended box');
        const extended = view(await slice(start + 8, 8));
        size = extended.getUint32(0, false) * 4294967296 + extended.getUint32(4, false); count = 16;
      } else if (size === 0) size = end - start;
      if (!Number.isSafeInteger(size) || size < count || size > end - start) throw Error('Invalid metadata box');
      return { kind: type(data), index: v.getUint32(4, false), start: start + count, end: start + size };
    }
    async function stringBox(box) {
      const size = box.end - box.start;
      if (size > MAX_TEXT) return null;
      const data = await slice(box.start, size);
      // QuickTime location atom contains a 16-bit byte count and language before ISO6709.
      if (data.length >= 4) {
        const length = view(data).getUint16(0, false);
        if (length > 0 && length <= data.length - 4) {
          const found = iso6709(utf8.decode(data.subarray(4, 4 + length)));
          if (found) return found;
        }
      }
      return iso6709(utf8.decode(data));
    }
    async function loci(box) {
      const size = box.end - box.start;
      if (size < 20 || size > MAX_TEXT) return null;
      const data = await slice(box.start, size);
      // Full-box flags + language + zero-terminated place + role, then
      // signed 16.16 longitude, latitude and altitude (3GPP location box).
      let offset = 6;
      while (offset < data.length && data[offset] !== 0) offset++;
      offset += 2;
      if (offset + 12 > data.length) return null;
      const v = view(data);
      return location(v.getInt32(offset + 4, false) / 65536, v.getInt32(offset, false) / 65536);
    }
    async function keyList(box) {
      const size = box.end - box.start;
      if (size < 8 || size > MAX_TEXT) return new Set();
      const data = await slice(box.start, size), v = view(data), names = new Set();
      const count = Math.min(v.getUint32(4, false), MAX_BOXES);
      let offset = 8;
      for (let index = 1; index <= count && offset + 8 <= size; index++) {
        const length = v.getUint32(offset, false);
        if (length < 8 || length > size - offset) break;
        const namespace = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
        const name = utf8.decode(data.subarray(offset + 8, offset + length));
        if (namespace === 'mdta' && name === 'com.apple.quicktime.location.ISO6709') names.add(index);
        offset += length;
      }
      return names;
    }
    async function itemData(box) {
      let offset = box.start;
      while (offset + 8 <= box.end) {
        const child = await header(offset, box.end);
        if (child.kind === 'data' && child.end - child.start >= 8 && child.end - child.start <= MAX_TEXT) {
          const data = await slice(child.start, child.end - child.start), encoding = view(data).getUint32(0, false) & 0xffffff;
          if (encoding === 1 || encoding === 0 || encoding === 2) {
            const text = encoding === 2 ? new TextDecoder('utf-16be').decode(data.subarray(8)) : utf8.decode(data.subarray(8));
            const found = iso6709(text);
            if (found) return found;
          }
        }
        offset = child.end;
      }
      return null;
    }
    async function meta(box, depth) {
      if (depth > MAX_DEPTH || box.end - box.start < 8) return null;
      const first = await slice(box.start, 8);
      // ISO meta is a full box; older QuickTime meta starts directly with hdlr.
      let offset = type(first) === 'hdlr' ? box.start : box.start + 4;
      let keys = new Set(); const lists = [];
      while (offset + 8 <= box.end) {
        const child = await header(offset, box.end);
        if (child.kind === 'keys') keys = await keyList(child);
        else if (child.kind === 'ilst') lists.push(child);
        else if (child.kind === '\u00a9xyz') { const found = await stringBox(child); if (found) return found; }
        offset = child.end;
      }
      for (const list of lists) {
        offset = list.start;
        while (offset + 8 <= list.end) {
          const item = await header(offset, list.end);
          if (keys.has(item.index) || item.kind === '\u00a9xyz') { const found = await itemData(item); if (found) return found; }
          offset = item.end;
        }
      }
      return null;
    }
    async function walk(start, end, depth) {
      if (depth > MAX_DEPTH) throw Error('Metadata nesting limit');
      let offset = start;
      while (offset + 8 <= end) {
        const box = await header(offset, end);
        let found = null;
        if (box.kind === 'ftyp') recognized = true;
        else if (box.kind === 'moov' || box.kind === 'udta' || box.kind === 'trak') {
          if (box.kind === 'moov') recognized = true;
          found = await walk(box.start, box.end, depth + 1);
        } else if (box.kind === 'meta') found = await meta(box, depth + 1);
        else if (box.kind === '\u00a9xyz') found = await stringBox(box);
        else if (box.kind === 'loci') found = await loci(box);
        if (found) return found;
        // mdat and sample tables are deliberately skipped by their declared size.
        offset = box.end;
      }
      return null;
    }
    try { const found = await walk(0, blob.size, 0); return { status: recognized ? 'ok' : 'unsupported', location: found }; }
    catch (error) { if (signal?.aborted) throw error; return { status: 'unsupported', location: null }; }
  }
  window.MediaMetadataBMFF = { read };
})();
