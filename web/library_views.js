/* Shared metadata views. Call invalidate before rendering a metadata mutation. */
(() => {
  'use strict';
  let revision = 0, cached = null;
  let summaries = new WeakMap();
  let albumSummaries = new WeakMap();
  const galleryCache = new Map();
  const listNames = ['pending', 'saved', 'active', 'favorites', 'trash', 'untaggedSaved'];
  const zero = () => ({ image: 0, video: 0, audio: 0 });
  const legacyVideo = photo => !!(photo && (photo.mediaType === 'video' || photo.videoUrl ||
    (photo.displayName && /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(photo.displayName))));

  function kind(photo) {
    if (photo.mediaType === 'image' || photo.mediaType === 'video' || photo.mediaType === 'audio') return photo.mediaType;
    if (typeof window.screenMediaKind === 'function') return window.screenMediaKind(photo);
    const name = photo.displayName || photo.name || '';
    const mime = photo.mimeType || photo.fileBlob?.type || '';
    if (/^audio\//i.test(mime) || /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus)$/i.test(name) || photo.audioUrl || photo.dataUrl?.startsWith('data:audio/')) return 'audio';
    if (/^video\//i.test(mime) || /\.(mp4|webm|mov|m4v|mkv|avi|3gp|wmv|flv|ts)$/i.test(name) || photo.videoUrl || photo.dataUrl?.startsWith('data:video/')) return 'video';
    return 'image';
  }

  function invalidate() {
    revision++;
    cached = null;
    summaries = new WeakMap();
    albumSummaries = new WeakMap();
    galleryCache.clear();
  }

  function summarize(photos) {
    const saved = summaries.get(photos);
    if (saved) return saved;
    const counts = zero();
    for (const photo of photos) if (photo) counts[kind(photo)]++;
    // Callers may mutate their own arrays. Cache only arrays owned by this module.
    return counts;
  }

  function albumSummary(photos) {
    const cached = albumSummaries.get(photos);
    if (cached) return cached;
    let videoCount = 0;
    for (const photo of photos) if (legacyVideo(photo)) videoCount++;
    return { photoCount: photos.length - videoCount, videoCount };
  }

  function get(state) {
    const photos = state.photos || [];
    if (cached && cached.source === photos && cached.length === photos.length && cached.revision === revision) return cached;
    // Import checkpoints append in place. Other metadata mutations explicitly
    // invalidate or use update(), so retain the already indexed prefix here.
    const append = cached && cached.source === photos && cached.length < photos.length && cached.revision === revision;
    const first = append ? cached.length : 0;
    if (!append) {
      summaries = new WeakMap();
      albumSummaries = new WeakMap();
    }
    galleryCache.clear();
    const result = append ? cached : { source: photos, length: photos.length, revision,
      savedByTag: new Map(), activeByTag: new Map(), latestByTag: new Map(),
      savedTagStats: new Map(), counts: {}, albumCounts: {} };
    if (!append) for (const name of listNames) {
      result[name] = [];
      result.counts[name] = zero();
      summaries.set(result[name], result.counts[name]);
      result.albumCounts[name] = { photoCount: 0, videoCount: 0 };
      albumSummaries.set(result[name], result.albumCounts[name]);
    }
    function add(name, photo, type, video) {
      result[name].push(photo);
      result.counts[name][type]++;
      result.albumCounts[name][video ? 'videoCount' : 'photoCount']++;
    }
    function addTag(map, tag, photo, type, video) {
      let list = map.get(tag);
      if (!list) {
        list = [];
        map.set(tag, list);
        summaries.set(list, zero());
        albumSummaries.set(list, { photoCount: 0, videoCount: 0 });
      }
      list.push(photo);
      summaries.get(list)[type]++;
      albumSummaries.get(list)[video ? 'videoCount' : 'photoCount']++;
    }
    for (let position = first; position < photos.length; position++) {
      const photo = photos[position];
      if (!photo) continue;
      const type = kind(photo);
      const video = legacyVideo(photo);
      if (photo.deletedAt) {
        add('trash', photo, type, video);
        continue;
      }
      add('active', photo, type, video);
      if (photo.isFavorite) add('favorites', photo, type, video);
      const saved = !photo.isPending;
      add(saved ? 'saved' : 'pending', photo, type, video);
      const tags = Array.isArray(photo.tags) ? photo.tags : [];
      if (saved && !tags.length) add('untaggedSaved', photo, type, video);
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        // Carousel/filter badges historically count tag occurrences. Keep that
        // separate from the includes-based album membership lists below.
        if (saved) {
          let stat = result.savedTagStats.get(tag);
          if (!stat) {
            stat = { count: 0, photoCount: 0, videoCount: 0, repPhoto: photo };
            result.savedTagStats.set(tag, stat);
          }
          stat.count++;
          stat[video ? 'videoCount' : 'photoCount']++;
        }
        // Existing includes-based album filters count a photo only once per tag.
        if (tags.indexOf(tag) !== i) continue;
        addTag(result.activeByTag, tag, photo, type, video);
        if (saved) {
          addTag(result.savedByTag, tag, photo, type, video);
          result.latestByTag.set(tag, Math.max(result.latestByTag.has(tag) ? result.latestByTag.get(tag) : 0,
            photo.createdAt || 0, photo.modifiedAt || 0));
        }
      }
    }
    result.length = photos.length;
    if (append) result.revision = ++revision;
    cached = result;
    return result;
  }

  function gallery(state) {
    const views = get(state);
    const query = (state.searchQuery || '').trim().toLowerCase();
    const selected = state.selectedFilterTags || new Set();
    const sort = state.gallerySort || 'date-desc';
    const key = JSON.stringify([query, !!state.onlyFavorites, !!state.onlyUntagged,
      [...selected], state.startDate, state.endDate, sort]);
    if (galleryCache.has(key)) {
      const value = galleryCache.get(key);
      galleryCache.delete(key); galleryCache.set(key, value);
      return value.photos;
    }
    let photos = views.saved;
    if (query) {
      // Search deliberately ignores the album and Favorites filters, as before.
      const terms = query.split(/\s+/).filter(Boolean);
      photos = photos.filter(photo => {
        const name = (photo.displayName || '').toLowerCase();
        const category = (photo.category || '').toLowerCase();
        const tags = Array.isArray(photo.tags) ? photo.tags.map(tag => (tag || '').toLowerCase()) : [];
        const favorite = photo.isFavorite ? 'favorites favourite loved' : '';
        return terms.every(term => name.includes(term) || category.includes(term) ||
          tags.some(tag => tag.includes(term)) || favorite.includes(term));
      });
    } else {
      if (selected.size === 1) photos = views.savedByTag.get(selected.values().next().value) || [];
      else if (selected.size > 1) {
        const matching = new Set();
        for (const tag of selected) for (const photo of views.savedByTag.get(tag) || []) matching.add(photo);
        photos = photos.filter(photo => matching.has(photo));
      }
      if (state.onlyFavorites) photos = photos.filter(photo => photo.isFavorite);
    }
    if (state.onlyUntagged) photos = photos.filter(photo => !photo.tags || !Array.isArray(photo.tags) || photo.tags.length === 0);
    if (state.startDate) photos = photos.filter(photo => photo.createdAt >= state.startDate);
    if (state.endDate) photos = photos.filter(photo => photo.createdAt <= state.endDate + 86399999);
    // Sort a fresh array; shared base/tag lists retain their original ordering.
    photos = photos.slice();
    photos.sort((a, b) => {
      switch (sort) {
        case 'date-asc': return (a.createdAt || 0) - (b.createdAt || 0);
        case 'name-asc': {
          const left = a.displayName || '', right = b.displayName || '';
          return left < right ? -1 : left > right ? 1 : 0;
        }
        case 'name-desc': {
          const left = a.displayName || '', right = b.displayName || '';
          return left > right ? -1 : left < right ? 1 : 0;
        }
        default: return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
    summaries.set(photos, summarize(photos));
    albumSummaries.set(photos, albumSummary(photos));
    galleryCache.set(key, { photos, query, selected: new Set(selected), sort,
      onlyFavorites: !!state.onlyFavorites, onlyUntagged: !!state.onlyUntagged,
      startDate: state.startDate, endDate: state.endDate });
    // Bound cached result references even when a user tries many searches.
    while (galleryCache.size > 3) galleryCache.delete(galleryCache.keys().next().value);
    return photos;
  }

  function capture(photo) {
    return { photo, revision, source: cached?.source, length: cached?.length,
      isPending: photo.isPending, deletedAt: photo.deletedAt, isFavorite: photo.isFavorite,
      tags: Array.isArray(photo.tags) ? photo.tags.slice() : photo.tags,
      createdAt: photo.createdAt, modifiedAt: photo.modifiedAt,
      displayName: photo.displayName, name: photo.name, category: photo.category,
      mediaType: photo.mediaType, mimeType: photo.mimeType || photo.fileBlob?.type || '',
      videoUrl: !!photo.videoUrl, audioUrl: !!photo.audioUrl,
      dataUrl: photo.dataUrl?.startsWith('data:audio/') ? 'data:audio/' :
        photo.dataUrl?.startsWith('data:video/') ? 'data:video/' : '' };
  }

  function matches(photo, options) {
    if (photo.isPending || photo.deletedAt) return false;
    if (options.query) {
      const name = (photo.displayName || '').toLowerCase();
      const category = (photo.category || '').toLowerCase();
      const tags = Array.isArray(photo.tags) ? photo.tags.map(tag => (tag || '').toLowerCase()) : [];
      const favorite = photo.isFavorite ? 'favorites favourite loved' : '';
      if (!options.query.split(/\s+/).filter(Boolean).every(term => name.includes(term) ||
        category.includes(term) || tags.some(tag => tag.includes(term)) || favorite.includes(term))) return false;
    } else {
      if (options.onlyFavorites && !photo.isFavorite) return false;
      if (options.selected.size && !(Array.isArray(photo.tags) && photo.tags.some(tag => options.selected.has(tag)))) return false;
    }
    if (options.onlyUntagged && Array.isArray(photo.tags) && photo.tags.length) return false;
    if (options.startDate && !(photo.createdAt >= options.startDate)) return false;
    if (options.endDate && !(photo.createdAt <= options.endDate + 86399999)) return false;
    return true;
  }

  function compare(a, b, sort) {
    if (sort === 'name-asc' || sort === 'name-desc') {
      const left = a.displayName || '', right = b.displayName || '';
      const result = left < right ? -1 : left > right ? 1 : 0;
      return sort === 'name-desc' ? -result : result;
    }
    return sort === 'date-asc' ? (a.createdAt || 0) - (b.createdAt || 0) :
      (b.createdAt || 0) - (a.createdAt || 0);
  }

  /** Patch a single metadata edit captured before mutation; bulk edits fall back. */
  function update(state, photo, before) {
    if (!cached || !before || before.photo !== photo || before.source !== state.photos ||
        cached.source !== state.photos || before.revision !== revision ||
        before.length !== state.photos.length || cached.length !== state.photos.length) {
      invalidate(); return false;
    }
    const source = state.photos, sourceIndex = source.indexOf(photo);
    if (sourceIndex < 0 || source.indexOf(photo, sourceIndex + 1) >= 0) { invalidate(); return false; }
    const oldType = kind(before), newType = kind(photo);
    const oldVideo = legacyVideo(before), newVideo = legacyVideo(photo);
    const insertions = [];
    function changeCounts(list, had, has) {
      const counts = summaries.get(list), albums = albumSummaries.get(list);
      if (had) { counts[oldType]--; albums[oldVideo ? 'videoCount' : 'photoCount']--; }
      if (has) { counts[newType]++; albums[newVideo ? 'videoCount' : 'photoCount']++; }
    }
    function patch(list, had, has, predicate) {
      if (!had && !has) return;
      if (had && !has) {
        const at = list.indexOf(photo);
        if (at >= 0) list.splice(at, 1);
      } else if (!had && has) insertions.push({ list, predicate, at: 0 });
      changeCounts(list, had, has);
    }
    const tests = {
      active: p => !p.deletedAt,
      pending: p => !!p.isPending && !p.deletedAt,
      saved: p => !p.isPending && !p.deletedAt,
      favorites: p => !!p.isFavorite && !p.deletedAt,
      trash: p => !!p.deletedAt,
      untaggedSaved: p => !p.isPending && !p.deletedAt && (!Array.isArray(p.tags) || !p.tags.length)
    };
    for (const name of listNames) patch(cached[name], tests[name](before), tests[name](photo), tests[name]);
    function occurrences(value) {
      const result = new Map();
      if (Array.isArray(value)) for (const tag of value) result.set(tag, (result.get(tag) || 0) + 1);
      return result;
    }
    const oldTags = occurrences(before.tags), newTags = occurrences(photo.tags);
    const tags = new Set([...oldTags.keys(), ...newTags.keys()]);
    const latestDirty = new Set();
    for (const tag of tags) {
      for (const [name, test] of [['activeByTag', tests.active], ['savedByTag', tests.saved]]) {
        const had = test(before) && oldTags.has(tag), has = test(photo) && newTags.has(tag);
        if (!had && !has) continue;
        let list = cached[name].get(tag);
        if (!list) {
          list = []; cached[name].set(tag, list);
          summaries.set(list, zero()); albumSummaries.set(list, { photoCount: 0, videoCount: 0 });
        }
        patch(list, had, has, p => test(p) && Array.isArray(p.tags) && p.tags.includes(tag));
        if (name === 'savedByTag' && (had !== has || before.createdAt !== photo.createdAt || before.modifiedAt !== photo.modifiedAt)) latestDirty.add(tag);
      }
      const oldCount = tests.saved(before) ? oldTags.get(tag) || 0 : 0;
      const newCount = tests.saved(photo) ? newTags.get(tag) || 0 : 0;
      if (!oldCount && !newCount) continue;
      let stat = cached.savedTagStats.get(tag);
      if (!stat) {
        stat = { count: 0, photoCount: 0, videoCount: 0, repPhoto: photo };
        cached.savedTagStats.set(tag, stat);
      }
      stat.count += newCount - oldCount;
      stat[oldVideo ? 'videoCount' : 'photoCount'] -= oldCount;
      stat[newVideo ? 'videoCount' : 'photoCount'] += newCount;
      if (!stat.count) cached.savedTagStats.delete(tag);
    }
    // Count the insertion positions together, preserving source order with a
    // single prefix scan instead of retaining an ID/rank map for every record.
    if (insertions.length) {
      for (let i = 0; i < sourceIndex; i++) {
        const item = source[i];
        if (!item) continue;
        for (const insertion of insertions) if (insertion.predicate(item)) insertion.at++;
      }
      for (const insertion of insertions) insertion.list.splice(insertion.at, 0, photo);
    }
    for (const tag of tags) {
      for (const name of ['activeByTag', 'savedByTag']) if (!cached[name].get(tag)?.length) cached[name].delete(tag);
      const stat = cached.savedTagStats.get(tag);
      if (stat) stat.repPhoto = cached.savedByTag.get(tag)?.[0] || photo;
    }
    for (const tag of latestDirty) {
      const list = cached.savedByTag.get(tag);
      if (!list) cached.latestByTag.delete(tag);
      else cached.latestByTag.set(tag, list.reduce((max, p) => Math.max(max, p.createdAt || 0, p.modifiedAt || 0), 0));
    }
    for (const options of galleryCache.values()) {
      const list = options.photos, had = matches(before, options), has = matches(photo, options);
      if (!had && !has) continue;
      const moved = had && has && compare(before, photo, options.sort) !== 0;
      if (had && (!has || moved)) {
        const at = list.indexOf(photo);
        if (at >= 0) list.splice(at, 1);
      }
      if (has && (!had || moved)) {
        let low = 0, high = list.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (compare(list[mid], photo, options.sort) < 0) low = mid + 1;
          else high = mid;
        }
        // Stable sort ties follow original library order, including when a
        // previously filtered-out record becomes visible after a favorite edit.
        if (low < list.length && compare(list[low], photo, options.sort) === 0) {
          for (let i = 0; i < sourceIndex; i++) {
            if (source[i] && compare(source[i], photo, options.sort) === 0 && matches(source[i], options)) low++;
          }
        }
        list.splice(low, 0, photo);
      }
      changeCounts(list, had, has);
    }
    revision++;
    cached.revision = revision;
    return true;
  }

  window.LibraryViews = { invalidate, get, gallery, summarize, albumSummary, capture, update };
})();
