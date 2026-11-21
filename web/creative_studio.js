/* ============================================================================
   PicShelf Creative Studio
   Collage Maker (1-9 Photos + Templates + Pop Out + 1M+ Virtualized Picker),
   Stylish Text, Stickers, Doodle/Draw, Enhance & Retouch (Before/After Curtain),
   and Smart Object Remover — 100% Offline, Fast, Android & iOS Parity.
   ============================================================================ */
(() => {
  'use strict';

  const CREATIVE_TOOLS = new Set(['collage', 'text', 'stickers', 'draw', 'enhance', 'remove']);

  const COLLAGE_RATIOS = [
    { id: '1:1',  label: '1:1',  w: 1,  h: 1 },
    { id: '4:5',  label: '4:5',  w: 4,  h: 5 },
    { id: '3:4',  label: '3:4',  w: 3,  h: 4 },
    { id: '9:16', label: '9:16', w: 9,  h: 16 },
    { id: '16:9', label: '16:9', w: 16, h: 9 },
    { id: '3:2',  label: '3:2',  w: 3,  h: 2 },
    { id: '2:3',  label: '2:3',  w: 2,  h: 3 }
  ];

  // Normalized cell rectangles [x, y, w, h] in 0..1 space (plus optional shape 'arch'|'circle')
  const COLLAGE_LAYOUTS = [
    // 1-Photo Layouts (so single-photo collages & frames work!)
    { id: '1-frame',    name: '1 Frame',   count: 1, cells: [[0, 0, 1, 1]] },
    { id: '1-polaroid', name: 'Polaroid',  count: 1, cells: [[0.06, 0.05, 0.88, 0.78]], footer: true },
    { id: '1-arch',     name: 'Arch',      count: 1, cells: [[0.06, 0.05, 0.88, 0.90]], shape: 'arch' },
    { id: '1-mirror',   name: 'Mirror 2',  count: 2, mirror: true, cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
    // 2-Photo Layouts
    { id: '2-v',        name: '2 Split',   count: 2, cells: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]] },
    { id: '2-h',        name: '2 Stack',   count: 2, cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]] },
    { id: '2-asym',     name: '2 Hero',    count: 2, cells: [[0, 0, 0.64, 1], [0.64, 0, 0.36, 1]] },
    { id: '2-pip',      name: '2 Story',   count: 2, cells: [[0, 0, 1, 0.66], [0, 0.66, 1, 0.34]] },
    // 3-Photo Layouts
    { id: '3-cols',     name: '3 Cols',    count: 3, cells: [[0, 0, 1/3, 1], [1/3, 0, 1/3, 1], [2/3, 0, 1/3, 1]] },
    { id: '3-rows',     name: '3 Film',    count: 3, cells: [[0, 0, 1, 1/3], [0, 1/3, 1, 1/3], [0, 2/3, 1, 1/3]] },
    { id: '3-hero-l',   name: '3 Hero L',  count: 3, cells: [[0, 0, 0.55, 1], [0.55, 0, 0.45, 0.5], [0.55, 0.5, 0.45, 0.5]] },
    { id: '3-hero-t',   name: '3 Hero T',  count: 3, cells: [[0, 0, 1, 0.55], [0, 0.55, 0.5, 0.45], [0.5, 0.55, 0.5, 0.45]] },
    // 4-Photo Layouts
    { id: '4-grid',     name: '2×2 Grid',  count: 4, cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
    { id: '4-hero-t',   name: '4 Hero T',  count: 4, cells: [[0, 0, 1, 0.58], [0, 0.58, 1/3, 0.42], [1/3, 0.58, 1/3, 0.42], [2/3, 0.58, 1/3, 0.42]] },
    { id: '4-hero-l',   name: '4 Hero L',  count: 4, cells: [[0, 0, 0.58, 1], [0.58, 0, 0.42, 1/3], [0.58, 1/3, 0.42, 1/3], [0.58, 2/3, 0.42, 1/3]] },
    { id: '4-strips',   name: '4 Strips',  count: 4, cells: [[0, 0, 0.25, 1], [0.25, 0, 0.25, 1], [0.5, 0, 0.25, 1], [0.75, 0, 0.25, 1]] },
    // 5-Photo Layouts
    { id: '5-2x3',      name: '5 Classic', count: 5, cells: [[0, 0, 0.5, 0.52], [0.5, 0, 0.5, 0.52], [0, 0.52, 1/3, 0.48], [1/3, 0.52, 1/3, 0.48], [2/3, 0.52, 1/3, 0.48]] },
    { id: '5-mosaic',   name: '5 Mosaic',  count: 5, cells: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 1/3], [0.5, 1/3, 0.5, 1/3], [0, 0.5, 0.5, 0.5], [0.5, 2/3, 0.5, 1/3]] },
    // 6-Photo Layouts
    { id: '6-2x3',      name: '6 Grid',    count: 6, cells: [[0, 0, 0.5, 1/3], [0.5, 0, 0.5, 1/3], [0, 1/3, 0.5, 1/3], [0.5, 1/3, 0.5, 1/3], [0, 2/3, 0.5, 1/3], [0.5, 2/3, 0.5, 1/3]] },
    { id: '6-3x2',      name: '6 Wide',    count: 6, cells: [[0, 0, 1/3, 0.5], [1/3, 0, 1/3, 0.5], [2/3, 0, 1/3, 0.5], [0, 0.5, 1/3, 0.5], [1/3, 0.5, 1/3, 0.5], [2/3, 0.5, 1/3, 0.5]] },
    // 9-Photo Even 3x3 Squares (specifically requested in user reviews!)
    { id: '9-3x3',      name: '3×3 Nine',  count: 9, cells: [
      [0, 0, 1/3, 1/3], [1/3, 0, 1/3, 1/3], [2/3, 0, 1/3, 1/3],
      [0, 1/3, 1/3, 1/3], [1/3, 1/3, 1/3, 1/3], [2/3, 1/3, 1/3, 1/3],
      [0, 2/3, 1/3, 1/3], [1/3, 2/3, 1/3, 1/3], [2/3, 2/3, 1/3, 1/3]
    ] }
  ];

  const COLLAGE_TEMPLATES = [
    { id: 'none',      name: 'Clean Grid',     bgType: 'color',    bgValue: '#0f172a', spacing: 10, margin: 14, radius: 12, badge: '' },
    { id: 'polaroid',  name: 'Polaroid',       bgType: 'color',    bgValue: '#fafaf9', spacing: 14, margin: 22, radius: 6,  badge: 'MEMORIES' },
    { id: 'editorial', name: 'Editorial',      bgType: 'color',    bgValue: '#111827', spacing: 16, margin: 24, radius: 4,  badge: 'COLLECTION' },
    { id: 'vlog',      name: 'Vlog Story',     bgType: 'gradient', bgValue: 'linear-gradient(135deg,#0f172a,#312e81,#701a75)', spacing: 12, margin: 20, radius: 22, badge: 'VLOG · DAILY' },
    { id: 'vacation',  name: 'Dream Vacation', bgType: 'gradient', bgValue: 'linear-gradient(135deg,#0284c7,#38bdf8,#fef3c7)', spacing: 12, margin: 20, radius: 18, badge: 'DREAM VACATION' },
    { id: 'gold_luxe', name: '24K Luxe',       bgType: 'gradient', bgValue: 'linear-gradient(135deg,#18181b,#27272a,#451a03)', spacing: 14, margin: 24, radius: 14, badge: 'LUXE EDITION', goldFrame: true },
    { id: 'pastel',    name: 'Pastel Diary',   bgType: 'gradient', bgValue: 'linear-gradient(135deg,#fdf2f8,#fce7f3,#ede9fe)', spacing: 14, margin: 22, radius: 24, badge: 'AESTHETIC' },
    { id: 'filmstrip', name: '35mm Film',      bgType: 'color',    bgValue: '#09090b', spacing: 14, margin: 28, radius: 4,  badge: 'KODAK 400 · 35MM', filmHoles: true }
  ];

  const BG_COLORS = [
    '#ffffff', '#fafaf9', '#f1f5f9', '#0f172a', '#09090b', '#1e1b4b',
    '#fdf2f8', '#fce7f3', '#ec4899', '#8b5cf6', '#38bdf8', '#10b981',
    '#fef3c7', '#f59e0b', '#ef4444', '#78350f'
  ];

  const BG_GRADIENTS = [
    { id: 'g1', css: 'linear-gradient(135deg,#0f172a,#312e81,#701a75)', stops: ['#0f172a', '#312e81', '#701a75'] },
    { id: 'g2', css: 'linear-gradient(135deg,#ec4899,#8b5cf6,#3b82f6)', stops: ['#ec4899', '#8b5cf6', '#3b82f6'] },
    { id: 'g3', css: 'linear-gradient(135deg,#f43f5e,#fb923c,#fde047)', stops: ['#f43f5e', '#fb923c', '#fde047'] },
    { id: 'g4', css: 'linear-gradient(135deg,#0284c7,#38bdf8,#fef3c7)', stops: ['#0284c7', '#38bdf8', '#fef3c7'] },
    { id: 'g5', css: 'linear-gradient(135deg,#fdf2f8,#fce7f3,#ede9fe)', stops: ['#fdf2f8', '#fce7f3', '#ede9fe'] },
    { id: 'g6', css: 'linear-gradient(135deg,#064e3b,#10b981,#a7f3d0)', stops: ['#064e3b', '#10b981', '#a7f3d0'] },
    { id: 'g7', css: 'linear-gradient(135deg,#18181b,#27272a,#451a03)', stops: ['#18181b', '#27272a', '#451a03'] },
    { id: 'g8', css: 'linear-gradient(135deg,#fef9c3,#fbcfe8,#c7d2fe)', stops: ['#fef9c3', '#fbcfe8', '#c7d2fe'] }
  ];

  const FONT_STYLES = [
    { id: 'modern',    name: 'Modern',    font: '800 56px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', stroke: false, glow: false },
    { id: 'serif',     name: 'Luxury',    font: 'italic 700 58px Georgia,"Times New Roman",serif', stroke: false, glow: false },
    { id: 'script',    name: 'Script',    font: 'italic 600 62px "Snell Roundhand","Brush Script MT",cursive', stroke: false, glow: false },
    { id: 'editorial', name: 'Editorial', font: '900 54px Impact,"Arial Black",sans-serif', uppercase: true, tracking: 2 },
    { id: 'neon',      name: 'Neon',      font: '800 56px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', glow: true },
    { id: 'outline',   name: 'Outline',   font: '900 60px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', hollow: true },
    { id: 'retro',     name: 'Retro',     font: '700 48px "Courier New",Courier,monospace', stroke: false, shadow: true },
    { id: 'gold',      name: '24K Gold',  font: '800 58px Georgia,serif', gold: true },
    { id: 'pill',      name: 'Tag Pill',  font: '800 46px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', pill: true },
    { id: 'comic',     name: 'Pop',       font: '900 58px "Trebuchet MS",sans-serif', stroke: true, shadow: true }
  ];

  const STICKER_PACKS = {
    trending: { label: 'Trending', items: ['✨', '💖', '🔥', '👑', '🦋', '🌟', '💫', '🎀', '🌈', '⚡', '💎', '🫧', '🌙', '⭐', '🪩', '🪽', '🧿', '🫶'] },
    hearts:   { label: 'Hearts',   items: ['❤️', '🩷', '🧡', '💛', '💚', '💙', '💜', '🤍', '🖤', '💕', '💞', '💓', '💗', '💘', '💝', '💌', '💋', '🌹'] },
    party:    { label: 'Party',    items: ['🎂', '🎉', '🥳', '🎈', '🥂', '🎁', '💐', '🎊', '🕯️', '🏆', '🎶', '🪩', '🧁', '🍾', '👑', '🎀', '🪅', '🎆'] },
    travel:   { label: 'Travel',   items: ['✈️', '🌴', '🏖️', '🗼', '🏔️', '🌅', '📷', '🗺️', '🚗', '⛵', '🌺', '☀️', '🌊', '🎡', '🏕️', '🗽', '🏛️', '🧳'] },
    nature:   { label: 'Nature',   items: ['🌸', '🌺', '🌻', '🌷', '🌹', '🌼', '💐', '🍀', '🌿', '🪴', '🌵', '🍂', '🍁', '🦋', '🐝', '🌈', '☁️', '🌙'] },
    food:     { label: 'Food',     items: ['🥐', '☕', '🍓', '🍦', '🍕', '🥑', '🧁', '🧋', '🍒', '🍋', '🍩', '🍷', '🍰', '🍔', '🌮', '🍣', '🍉', '🥂'] },
    cute:     { label: 'Cute',     items: ['🐶', '🐱', '🐰', '🐻', '🐼', '🐨', '🦊', '🦁', '🦄', '🐥', '🐾', '🐝', '🦋', '🐬', '🦩', '🐢', '🦖', '🧸'] },
    mood:     { label: 'Mood',     items: ['😍', '🥰', '😎', '🤩', '😂', '😭', '🥺', '🤭', '😜', '🥳', '😇', '🤠', '🫶', '✌️', '🤟', '🙌', '👏', '💯'] },
    badges:   { label: 'Stamps',   kind: 'badge', items: ['ENJOY', 'VLOG', 'LOVE', 'NEW', 'MOOD', 'VIP', 'MEMORIES', 'PURE', '100%', '2026', 'DREAM', 'GLOW', 'VIBES', 'HAPPY', 'VACAY', 'BESTIE', 'AESTHETIC', 'LIMITED'] },
    decor:    { label: 'Decor',    kind: 'decor', items: [
      { id: 'washi_pink', label: 'Tape 🎀' },
      { id: 'washi_gold', label: 'Gold Tape' },
      { id: 'star_burst', label: 'Starburst' },
      { id: 'heart_ring', label: 'Heart Ring' },
      { id: 'sparkle_halo', label: 'Halo ✨' },
      { id: 'sunburst', label: 'Sunburst' },
      { id: 'speech_bubble', label: 'Bubble 💬' },
      { id: 'laurel', label: 'Laurel 🏆' },
      { id: 'crown_vec', label: 'Crown 👑' },
      { id: 'neon_arrow', label: 'Arrow ➜' },
      { id: 'ribbon', label: 'Ribbon' },
      { id: 'film_frame', label: 'Film 🎞️' }
    ] }
  };

  const CUSTOM_COLOR_KEY = 'picshelf_creative_custom_colors_v1';
  function getSavedCustomColors() {
    const out = [];
    const seen = new Set();
    const pushCol = (c) => {
      if (typeof c !== 'string') return;
      const h = c.trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(h) && !seen.has(h)) { seen.add(h); out.push(h); }
    };
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOM_COLOR_KEY) || '[]');
      if (Array.isArray(saved)) saved.forEach(pushCol);
    } catch (_) {}
    if (Array.isArray(window.state?.customColors)) {
      window.state.customColors.forEach(pushCol);
    }
    if (window.state?.accentColor) pushCol(window.state.accentColor);
    return out.slice(0, 12);
  }
  function rememberCustomColor(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex.trim())) return;
    const norm = hex.trim().toLowerCase();
    try {
      const cur = JSON.parse(localStorage.getItem(CUSTOM_COLOR_KEY) || '[]');
      const next = [norm, ...(Array.isArray(cur) ? cur.filter(c => c.toLowerCase() !== norm) : [])].slice(0, 10);
      localStorage.setItem(CUSTOM_COLOR_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  const PALETTE_COLORS = [
    '#ffffff', '#0f172a', '#f43f5e', '#ec4899', '#a855f7', '#6366f1',
    '#38bdf8', '#14b8a6', '#22c55e', '#facc15', '#fb923c', '#ef4444'
  ];

  // Runtime state (zero allocation until a Creative Studio tool is opened)
  const cs = {
    initialized: false,
    activeTool: null,
    photoId: null,
    baseImg: null,          // HTMLImageElement of current active photo
    workCanvas: null,       // Working base image (includes Remove edits if any)
    enhancedCanvas: null,   // Cached preview of Enhance output
    stageCanvas: null,      // #detailCreativeCanvas
    displayW: 0,
    displayH: 0,
    dpr: 1,

    // Collage state
    collage: {
      sub: 'layout',
      layoutId: '2-v',
      templateId: 'none',
      ratio: '1:1',
      spacing: 10,
      margin: 14,
      radius: 12,
      bgType: 'color',
      bgValue: '#0f172a',
      outputMaxDim: 2400,
      selectedCell: 0,
      swapSourceCell: -1,
      pickerOpen: false,
      cells: []
    },

    // Text + Sticker shared layer stack (sorted back-to-front)
    layers: [],
    selectedLayerId: null,
    textStyleId: 'modern',
    textColor: '#ffffff',
    textBgMode: 'none', // 'none' | 'solid' | 'frosted'
    stickerPack: 'trending',

    // Draw / Doodle state
    draw: {
      brush: 'pen', // 'pen' | 'neon' | 'marker' | 'dashed' | 'sparkle' | 'eraser'
      color: '#f43f5e',
      size: 10,
      opacity: 100,
      strokes: [],
      redo: [],
      activeStroke: null
    },

    // Enhance & Landmark-Guided Selfie Retouch state
    enhance: {
      sub: 'preset',
      preset: 'original', // 'original' | 'selfie' | 'hd' | '2x' | 'vivid' | 'portrait'
      clarity: 0,
      smooth: 0,
      blemish: 0,
      wrinkle: 0,
      texture: 0,    // -50 (Velvet Porcelain) .. +50 (Crisp Dewy)
      underEye: 0,
      eyes: 0,
      teeth: 0,
      brighten: 0,
      glow: 0,
      cheekBlush: 0,
      cheekColor: '#f472b6',
      lipTint: 0,
      lipColor: '#e11d48',
      makeupTarget: 'lip', // 'cheek' | 'lip' for Palette Studio shade rail
      faces: null,   // null = not yet detected, [] = no face, [...] = native landmarks
      faceReqId: null,
      splitPos: 0.5,
      dirty: true
    },

    // Smart Remove state (Picsart MI-GAN AI On-Demand + Exemplar Patch-Copy Fallback)
    remove: {
      brushSize: 30,
      autoApply: false,
      maskCanvas: null,
      hasMask: false,
      undoStack: [], // Array of canvas snapshots (max 6)
      painting: false,
      lastPt: null,
      busy: false,
      activeReqId: null,
      pendingRunAfterDownload: false,
      modelStatus: { state: 'missing', downloaded: 0, total: 28079181, error: null }
    },

    // Pointer interaction state
    pointer: {
      active: false,
      mode: null, // 'drag-layer' | 'transform-layer' | 'pan-cell' | 'draw' | 'remove' | 'split'
      startX: 0,
      startY: 0,
      origX: 0,
      origY: 0,
      origScale: 1,
      origRot: 0,
      startDist: 1,
      startAngle: 0,
      moved: false
    },

    rafId: 0
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function uid(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

  function getActivePhoto() {
    if (!window.state || !window.state.activePhotoId) return null;
    if (typeof window.findPhotoById === 'function') return window.findPhotoById(window.state.activePhotoId);
    return (window.state.photos || []).find(p => p.id === window.state.activePhotoId) || null;
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      if (!url) { reject(new Error('No URL')); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => (img.naturalWidth > 0 ? resolve(img) : reject(new Error('Empty image')));
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });
  }

  async function resolvePhotoImg(photo) {
    if (!photo) return null;
    try {
      if (window.PicShelfBackdropGallery?.resolve) {
        const url = await window.PicShelfBackdropGallery.resolve(photo);
        return await loadImageFromUrl(url);
      }
    } catch (_) {}
    if (photo.dataUrl) {
      try { return await loadImageFromUrl(photo.dataUrl); } catch (_) {}
    }
    return null;
  }

  // ==========================================================================
  // Working Base Image & Stage Sizing
  // ==========================================================================
  function ensureBaseImageLoaded() {
    const detailImg = document.getElementById('detailImage');
    const photo = getActivePhoto();
    if (!photo) return Promise.resolve(false);

    if (cs.photoId === photo.id && cs.baseImg && cs.workCanvas) {
      return Promise.resolve(true);
    }

    cs.photoId = photo.id;
    const srcUrl = (detailImg && detailImg.naturalWidth > 0 && detailImg.src) ? detailImg.src : photo.dataUrl;
    return loadImageFromUrl(srcUrl).catch(() => resolvePhotoImg(photo)).then(img => {
      if (!img) return false;
      cs.baseImg = img;
      // Fast working preview canvas (capped at 1080px max edge for instant 60 FPS interactivity)
      const maxEdge = 1080;
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const ww = Math.max(64, Math.round(img.naturalWidth * scale));
      const wh = Math.max(64, Math.round(img.naturalHeight * scale));
      const wc = document.createElement('canvas');
      wc.width = ww;
      wc.height = wh;
      wc.getContext('2d').drawImage(img, 0, 0, ww, wh);
      cs.workCanvas = wc;
      cs.enhancedCanvas = null;
      cs.enhance.dirty = true;
      cs.enhance.faces = null;
      cs.enhance.faceReqId = null;
      cs.remove.maskCanvas = document.createElement('canvas');
      cs.remove.maskCanvas.width = ww;
      cs.remove.maskCanvas.height = wh;
      cs.remove.hasMask = false;
      cs.remove.undoStack = [];
      // Seed collage cell 0 with active photo
      if (!cs.collage.cells.length) {
        initCollageCells(true);
      } else {
        cs.collage.cells[0] = makeCell(photo, img, img.src);
      }
      return true;
    }).catch(() => false);
  }

  function makeCell(photo = null, img = null, url = null) {
    return { photo, img, url, panX: 0, panY: 0, zoom: 1, rotation: 0, flipH: false, popOut: false };
  }

  function getCollageLayout() {
    return COLLAGE_LAYOUTS.find(l => l.id === cs.collage.layoutId) || COLLAGE_LAYOUTS[4];
  }

  function getCollageRatioObj() {
    return COLLAGE_RATIOS.find(r => r.id === cs.collage.ratio) || COLLAGE_RATIOS[0];
  }

  function initCollageCells(resetAll = false) {
    const layout = getCollageLayout();
    const photo = getActivePhoto();
    const existing = resetAll ? [] : cs.collage.cells;
    const next = [];
    for (let i = 0; i < layout.count; i++) {
      if (existing[i] && existing[i].img) {
        next.push(existing[i]);
      } else if (i === 0 && cs.baseImg) {
        next.push(makeCell(photo, cs.baseImg, cs.baseImg.src));
      } else if (layout.mirror && i === 1 && cs.baseImg) {
        const c = makeCell(photo, cs.baseImg, cs.baseImg.src);
        c.flipH = true;
        next.push(c);
      } else {
        next.push(makeCell(null, null, null));
      }
    }
    cs.collage.cells = next;
    cs.collage.selectedCell = clamp(cs.collage.selectedCell, 0, Math.max(0, next.length - 1));
    cs.collage.swapSourceCell = -1;
  }

  async function autoFillEmptyCollageCells() {
    const layout = getCollageLayout();
    const active = getActivePhoto();
    const pool = (window.state?.detailPhotoList && window.state.detailPhotoList.length > 1)
      ? window.state.detailPhotoList
      : (window.state?.photos || []);
    const usedIds = new Set(cs.collage.cells.map(c => c.photo?.id).filter(Boolean));
    if (active) usedIds.add(active.id);

    const isImg = window.PicShelfBackdropGallery?.isImage || (p => p && !p.deletedAt && p.mediaType !== 'video' && p.mediaType !== 'audio');
    const candidates = [];
    const scanCap = Math.min(pool.length, 300);
    for (let i = 0; i < scanCap && candidates.length < layout.count; i++) {
      const p = pool[i];
      if (isImg(p) && !usedIds.has(p.id)) {
        candidates.push(p);
        usedIds.add(p.id);
      }
    }
    let ci = 0;
    let filled = 0;
    for (let i = 0; i < cs.collage.cells.length && ci < candidates.length; i++) {
      if (!cs.collage.cells[i].img) {
        const p = candidates[ci++];
        const img = await resolvePhotoImg(p);
        if (img) {
          cs.collage.cells[i] = makeCell(p, img, img.src);
          filled++;
          scheduleRender();
        }
      }
    }
    if (filled > 0) {
      window.showToast?.(`✨ Filled ${filled} collage slot${filled > 1 ? 's' : ''}!`);
    } else {
      window.showToast?.('Tap any slot to pick photos from your library');
    }
  }

  function layoutStageCanvas() {
    const canvas = cs.stageCanvas;
    const wrapper = document.getElementById('detailImageWrapper');
    const stage = document.getElementById('detailImageStage');
    if (!canvas || !wrapper || !stage) return;

    const wRect = wrapper.getBoundingClientRect();
    const maxW = Math.max(160, (wRect.width || wrapper.clientWidth || 360) - 20);
    const maxH = Math.max(160, (wRect.height || wrapper.clientHeight || 420) - 12);

    let ar = 1;
    if (cs.activeTool === 'collage') {
      const r = getCollageRatioObj();
      ar = r.w / r.h;
    } else if (cs.workCanvas) {
      ar = cs.workCanvas.width / cs.workCanvas.height;
    } else if (cs.baseImg) {
      ar = cs.baseImg.naturalWidth / cs.baseImg.naturalHeight;
    }

    let dispW, dispH;
    if (ar >= maxW / maxH) {
      dispW = Math.round(maxW);
      dispH = Math.max(1, Math.round(maxW / ar));
    } else {
      dispH = Math.round(maxH);
      dispW = Math.max(1, Math.round(maxH * ar));
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cs.displayW = dispW;
    cs.displayH = dispH;
    cs.dpr = dpr;

    canvas.style.width = dispW + 'px';
    canvas.style.height = dispH + 'px';
    const targetW = Math.max(1, Math.round(dispW * dpr));
    const targetH = Math.max(1, Math.round(dispH * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    // Align split overlay exactly to canvas bounds
    const splitEl = document.getElementById('creativeSplitOverlay');
    if (splitEl) {
      splitEl.style.width = dispW + 'px';
      splitEl.style.height = dispH + 'px';
      splitEl.style.left = `calc(50% - ${Math.round(dispW / 2)}px)`;
      splitEl.style.top = `calc(50% - ${Math.round(dispH / 2)}px)`;
      splitEl.style.right = 'auto';
      splitEl.style.bottom = 'auto';
    }
  }

  // ==========================================================================
  // Image Processing: Landmark-Guided Frequency Separation Selfie Retouch
  // ==========================================================================
  const CHEEK_SHADES = ['#f472b6', '#fb7185', '#fb923c', '#e879f9', '#d97706', '#f43f5e'];
  const LIP_SHADES   = ['#e11d48', '#ec4899', '#be123c', '#f97316', '#9d174d', '#d97757'];

  function hexToRgb(hex) {
    const clean = String(hex || '#e11d48').replace('#', '');
    const n = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16) || 0xe11d48;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function requestFaceLandmarksIfNeeded() {
    if (!cs.workCanvas || cs.enhance.faces !== null) {
      updateFaceStatusHint();
      return;
    }
    if (window.AndroidApp && typeof window.AndroidApp.detectFaceLandmarks === 'function') {
      const reqId = uid('face');
      cs.enhance.faceReqId = reqId;
      updateFaceStatusHint('Detecting facial landmarks…');
      try {
        const dataUrl = cs.workCanvas.toDataURL('image/jpeg', 0.85);
        window.AndroidApp.detectFaceLandmarks(reqId, dataUrl);
      } catch (_) {
        cs.enhance.faces = [];
        updateFaceStatusHint();
      }
    } else {
      cs.enhance.faces = [];
      updateFaceStatusHint();
    }
  }

  function updateFaceStatusHint(customMsg = null) {
    const el = document.getElementById('creativeFaceStatusHint');
    if (!el) return;
    if (customMsg) { el.textContent = customMsg; return; }
    if (Array.isArray(cs.enhance.faces) && cs.enhance.faces.length > 0) {
      const n = cs.enhance.faces.length;
      el.textContent = `✨ ${n} face${n > 1 ? 's' : ''} detected · Precision landmark skin & makeup active`;
    } else {
      el.textContent = 'Drag the Before / After divider on the photo to compare';
    }
  }

  function hasEnhanceAdjustments() {
    const e = cs.enhance;
    return (
      e.preset !== 'original' ||
      e.clarity > 0 || e.smooth > 0 || e.blemish > 0 || e.wrinkle > 0 || e.texture !== 0 ||
      e.underEye > 0 || e.eyes > 0 || e.teeth > 0 || e.brighten > 0 || e.glow > 0 ||
      e.cheekBlush > 0 || e.lipTint > 0
    );
  }

  function getEffectiveEnhanceParams() {
    const e = cs.enhance;
    let clarity = e.clarity, smooth = e.smooth, blemish = e.blemish, wrinkle = e.wrinkle;
    let texture = e.texture, underEye = e.underEye, eyes = e.eyes, teeth = e.teeth;
    let brighten = e.brighten, glow = e.glow, cheekBlush = e.cheekBlush, lipTint = e.lipTint;
    let satBoost = 0, contrastBoost = 0;

    if (e.preset === 'selfie') {
      // Instant "Perfect Your Selfie" studio formula!
      smooth = Math.max(smooth, 54);
      blemish = Math.max(blemish, 64);
      wrinkle = Math.max(wrinkle, 42);
      underEye = Math.max(underEye, 48);
      eyes = Math.max(eyes, 38);
      teeth = Math.max(teeth, 32);
      brighten = Math.max(brighten, 18);
      glow = Math.max(glow, 26);
      cheekBlush = Math.max(cheekBlush, 30);
      lipTint = Math.max(lipTint, 26);
      clarity = Math.max(clarity, 18);
      satBoost = 6;
    } else if (e.preset === 'hd') {
      clarity = Math.max(clarity, 55); contrastBoost = 12; satBoost = 8;
    } else if (e.preset === '2x') {
      clarity = Math.max(clarity, 85); contrastBoost = 16; satBoost = 10;
    } else if (e.preset === 'vivid') {
      clarity = Math.max(clarity, 40); contrastBoost = 18; satBoost = 28; brighten = Math.max(brighten, 14);
    } else if (e.preset === 'portrait') {
      smooth = Math.max(smooth, 68); blemish = Math.max(blemish, 55); wrinkle = Math.max(wrinkle, 48);
      underEye = Math.max(underEye, 40); glow = Math.max(glow, 42); brighten = Math.max(brighten, 24);
      texture = texture === 0 ? -18 : texture;
    }
    return {
      clarity, smooth, blemish, wrinkle, texture, underEye, eyes, teeth,
      brighten, glow, cheekBlush, lipTint, satBoost, contrastBoost,
      cheekColor: e.cheekColor, lipColor: e.lipColor
    };
  }

  function tracePoly(ctx, pts, w, h) {
    if (!pts || pts.length < 3) return false;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    ctx.closePath();
    return true;
  }

  function polyCenter(pts, w, h) {
    if (!pts || !pts.length) return null;
    let sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of pts) {
      const px = p[0] * w, py = p[1] * h;
      sx += px; sy += py;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return { x: sx / pts.length, y: sy / pts.length, w: maxX - minX, h: maxY - minY, maxY, minY };
  }

  // Builds crisp feathered landmark region masks (skin protection, under-eye, eyes, teeth, lips, cheeks)
  function buildFaceRegionMasks(w, h, faces) {
    if (!Array.isArray(faces) || !faces.length) return null;
    const makeMask = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const skinC = makeMask(), underEyeC = makeMask(), eyeC = makeMask(), teethC = makeMask(), lipC = makeMask(), cheekC = makeMask(), hiCheekC = makeMask();
    const sCtx = skinC.getContext('2d'), uCtx = underEyeC.getContext('2d'), eCtx = eyeC.getContext('2d');
    const tCtx = teethC.getContext('2d'), lCtx = lipC.getContext('2d'), chCtx = cheekC.getContext('2d'), hiCtx = hiCheekC.getContext('2d');

    const unit = Math.min(w, h) / 600;
    for (const f of faces) {
      const b = f.bounds || { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
      const fw = b.w * w, fh = b.h * h;

      // 1. Face Skin Mask (face contour MINUS eyes, eyebrows, lips!)
      sCtx.save();
      sCtx.filter = `blur(${Math.max(3, Math.round(fw * 0.045))}px)`;
      sCtx.fillStyle = '#fff';
      if (tracePoly(sCtx, f.faceContour, w, h)) {
        sCtx.fill();
      } else {
        sCtx.beginPath();
        sCtx.ellipse((b.x + b.w / 2) * w, (b.y + b.h / 2) * h, fw * 0.48, fh * 0.54, 0, 0, Math.PI * 2);
        sCtx.fill();
      }
      // Protect eyes, eyebrows, and lips so they stay razor-sharp!
      sCtx.globalCompositeOperation = 'destination-out';
      sCtx.filter = `blur(${Math.max(2, Math.round(fw * 0.018))}px)`;
      for (const excl of [f.leftEye, f.rightEye, f.outerLips]) {
        if (tracePoly(sCtx, excl, w, h)) sCtx.fill();
      }
      // Eyebrows: stroke + fill so both closed (Android ML Kit) & open ridge (iOS Vision) protect brows cleanly
      sCtx.lineCap = 'round';
      sCtx.lineJoin = 'round';
      sCtx.lineWidth = Math.max(4, fw * 0.055);
      sCtx.strokeStyle = '#fff';
      for (const brow of [f.leftEyebrow, f.rightEyebrow]) {
        if (brow && brow.length >= 2) {
          sCtx.beginPath();
          sCtx.moveTo(brow[0][0] * w, brow[0][1] * h);
          for (let k = 1; k < brow.length; k++) sCtx.lineTo(brow[k][0] * w, brow[k][1] * h);
          sCtx.stroke();
          if (brow.length >= 3) { sCtx.closePath(); sCtx.fill(); }
        }
      }
      sCtx.restore();

      // 2. Eyes & Under-Eye Dark Circle Crescents
      for (const eyePts of [f.leftEye, f.rightEye]) {
        const ec = polyCenter(eyePts, w, h);
        if (!ec) continue;
        eCtx.save();
        eCtx.filter = `blur(${Math.max(1, Math.round(ec.w * 0.08))}px)`;
        eCtx.fillStyle = '#fff';
        if (tracePoly(eCtx, eyePts, w, h)) eCtx.fill();
        eCtx.restore();

        // Curved crescent directly under lower eyelid
        const uy = ec.maxY + Math.max(4, ec.h * 0.68);
        const urx = Math.max(8, ec.w * 0.62);
        const ury = Math.max(4, ec.h * 0.62);
        uCtx.save();
        const ug = uCtx.createRadialGradient(ec.x, uy, ury * 0.15, ec.x, uy, urx);
        ug.addColorStop(0, 'rgba(255,255,255,0.95)');
        ug.addColorStop(0.6, 'rgba(255,255,255,0.45)');
        ug.addColorStop(1, 'rgba(255,255,255,0)');
        uCtx.fillStyle = ug;
        uCtx.beginPath();
        uCtx.ellipse(ec.x, uy, urx, ury, 0, 0, Math.PI * 2);
        uCtx.fill();
        // Exclude eye itself from under-eye brightening
        uCtx.globalCompositeOperation = 'destination-out';
        if (tracePoly(uCtx, eyePts, w, h)) uCtx.fill();
        uCtx.restore();
      }

      // 3. Outer Lips (minus Inner Lips) & Teeth (Inner Lips)
      if (f.outerLips && f.outerLips.length >= 3) {
        lCtx.save();
        lCtx.filter = `blur(${Math.max(1.5, Math.round(fw * 0.012))}px)`;
        lCtx.fillStyle = '#fff';
        if (tracePoly(lCtx, f.outerLips, w, h)) lCtx.fill();
        if (f.innerLips && f.innerLips.length >= 3) {
          lCtx.globalCompositeOperation = 'destination-out';
          if (tracePoly(lCtx, f.innerLips, w, h)) lCtx.fill();
        }
        lCtx.restore();
      }
      if (f.innerLips && f.innerLips.length >= 3) {
        tCtx.save();
        tCtx.filter = `blur(${Math.max(1, Math.round(unit * 1.5))}px)`;
        tCtx.fillStyle = '#fff';
        if (tracePoly(tCtx, f.innerLips, w, h)) tCtx.fill();
        tCtx.restore();
      }

      // 4. Cheeks (Blush + Upper Cheekbone Highlighter Glow)
      const le = polyCenter(f.leftEye, w, h), re = polyCenter(f.rightEye, w, h);
      const nb = polyCenter(f.noseBottom, w, h);
      const lpt = Array.isArray(f.leftCheek) ? [f.leftCheek[0] * w, f.leftCheek[1] * h]
        : (le ? [le.x - fw * 0.04, (le.y + (nb ? nb.y : (b.y + b.h * 0.62) * h)) * 0.5 + fh * 0.05] : [(b.x + b.w * 0.28) * w, (b.y + b.h * 0.58) * h]);
      const rpt = Array.isArray(f.rightCheek) ? [f.rightCheek[0] * w, f.rightCheek[1] * h]
        : (re ? [re.x + fw * 0.04, (re.y + (nb ? nb.y : (b.y + b.h * 0.62) * h)) * 0.5 + fh * 0.05] : [(b.x + b.w * 0.72) * w, (b.y + b.h * 0.58) * h]);
      const cheekR = Math.max(14, fw * 0.17);
      for (const [cx, cy] of [lpt, rpt]) {
        const cg = chCtx.createRadialGradient(cx, cy, cheekR * 0.1, cx, cy, cheekR);
        cg.addColorStop(0, 'rgba(255,255,255,0.9)');
        cg.addColorStop(0.55, 'rgba(255,255,255,0.42)');
        cg.addColorStop(1, 'rgba(255,255,255,0)');
        chCtx.fillStyle = cg;
        chCtx.beginPath();
        chCtx.arc(cx, cy, cheekR, 0, Math.PI * 2);
        chCtx.fill();

        // Subtle champagne highlighter glow just above the blush on the cheekbone
        const hy = cy - cheekR * 0.38;
        const hr = cheekR * 0.72;
        const hg = hiCtx.createRadialGradient(cx, hy, hr * 0.08, cx, hy, hr);
        hg.addColorStop(0, 'rgba(255,255,255,0.85)');
        hg.addColorStop(1, 'rgba(255,255,255,0)');
        hiCtx.fillStyle = hg;
        hiCtx.beginPath();
        hiCtx.arc(cx, hy, hr, 0, Math.PI * 2);
        hiCtx.fill();
      }
    }
    return {
      skin: sCtx.getImageData(0, 0, w, h).data,
      underEye: uCtx.getImageData(0, 0, w, h).data,
      eye: eCtx.getImageData(0, 0, w, h).data,
      teeth: tCtx.getImageData(0, 0, w, h).data,
      lip: lCtx.getImageData(0, 0, w, h).data,
      cheek: chCtx.getImageData(0, 0, w, h).data,
      hiCheek: hiCtx.getImageData(0, 0, w, h).data
    };
  }

  // Smooth universal YCbCr skin-tone probability (works across ALL skin tones from deep to fair!)
  function skinProbability(r, g, b) {
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    // Soft bell around classic skin chroma cluster [Cb: 75..130, Cr: 130..180]
    const dCb = cb < 78 ? (78 - cb) / 14 : (cb > 128 ? (cb - 128) / 14 : 0);
    const dCr = cr < 132 ? (132 - cr) / 14 : (cr > 178 ? (cr - 178) / 14 : 0);
    const d = Math.hypot(dCb, dCr);
    return d >= 1 ? 0 : (1 - d * d);
  }

  // Fast separable box blur on RGBA Uint8ClampedArray (O(W*H))
  function boxBlurRGBA(src, w, h, radius) {
    const r = Math.max(1, Math.min(radius, 12));
    const tmp = new Uint8ClampedArray(src.length);
    const dst = new Uint8ClampedArray(src.length);
    const div = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let rSum = 0, gSum = 0, bSum = 0;
      const row = y * w;
      for (let i = -r; i <= r; i++) {
        const idx = (row + clamp(i, 0, w - 1)) * 4;
        rSum += src[idx]; gSum += src[idx + 1]; bSum += src[idx + 2];
      }
      for (let x = 0; x < w; x++) {
        const out = (row + x) * 4;
        tmp[out] = (rSum / div) | 0;
        tmp[out + 1] = (gSum / div) | 0;
        tmp[out + 2] = (bSum / div) | 0;
        tmp[out + 3] = src[out + 3];
        const addIdx = (row + clamp(x + r + 1, 0, w - 1)) * 4;
        const subIdx = (row + clamp(x - r, 0, w - 1)) * 4;
        rSum += src[addIdx] - src[subIdx];
        gSum += src[addIdx + 1] - src[subIdx + 1];
        bSum += src[addIdx + 2] - src[subIdx + 2];
      }
    }
    for (let x = 0; x < w; x++) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let i = -r; i <= r; i++) {
        const idx = (clamp(i, 0, h - 1) * w + x) * 4;
        rSum += tmp[idx]; gSum += tmp[idx + 1]; bSum += tmp[idx + 2];
      }
      for (let y = 0; y < h; y++) {
        const out = (y * w + x) * 4;
        dst[out] = (rSum / div) | 0;
        dst[out + 1] = (gSum / div) | 0;
        dst[out + 2] = (bSum / div) | 0;
        dst[out + 3] = tmp[out + 3];
        const addIdx = (clamp(y + r + 1, 0, h - 1) * w + x) * 4;
        const subIdx = (clamp(y - r, 0, h - 1) * w + x) * 4;
        rSum += tmp[addIdx] - tmp[subIdx];
        gSum += tmp[addIdx + 1] - tmp[subIdx + 1];
        bSum += tmp[addIdx + 2] - tmp[subIdx + 2];
      }
    }
    return dst;
  }

  function renderEnhancedToCanvas(sourceCanvas) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0);

    const p = getEffectiveEnhanceParams();
    const anyWork = p.clarity || p.smooth || p.blemish || p.wrinkle || p.texture ||
                    p.underEye || p.eyes || p.teeth || p.brighten || p.glow ||
                    p.cheekBlush || p.lipTint || p.satBoost || p.contrastBoost;
    if (!anyWork) return out;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const orig = new Uint8ClampedArray(data);

    const needFine = p.clarity > 0 || p.wrinkle > 0 || p.texture !== 0 || p.smooth > 0 || p.eyes > 0;
    const needMed  = p.smooth > 0 || p.blemish > 0;
    const scaleRad = Math.max(1, Math.min(w, h) / 480);
    const blurFine = needFine ? boxBlurRGBA(orig, w, h, Math.max(2, Math.round(2.5 * scaleRad))) : null;
    const blurMed  = needMed  ? boxBlurRGBA(orig, w, h, Math.max(5, Math.round(7.5 * scaleRad))) : null;

    const masks = buildFaceRegionMasks(w, h, cs.enhance.faces);
    const hasFace = !!masks;

    const sharpAmt   = (p.clarity / 100) * 1.35;
    const smoothAmt  = (p.smooth / 100) * 0.84;
    const blemishAmt = (p.blemish / 100);
    const wrinkleAmt = (p.wrinkle / 100) * 0.85;
    const texGain    = 1.0 + (p.texture / 50) * 0.55; // -50 -> 0.45 Velvet, +50 -> 1.55 Dewy Crisp
    const underEyeAmt = (p.underEye / 100) * 0.55;
    const eyeAmt     = (p.eyes / 100);
    const teethAmt   = (p.teeth / 100);
    const brightLift = (p.brighten / 100) * 28;
    const glowAmt    = (p.glow / 100) * 0.24;
    const cheekAmt   = (p.cheekBlush / 100) * 0.42;
    const lipAmt     = (p.lipTint / 100) * 0.58;
    const contrast   = 1 + (p.contrastBoost / 100) * 0.7;
    const sat        = 1 + (p.satBoost / 100) * 0.9;
    const [chR, chG, chB] = hexToRgb(p.cheekColor);
    const [lpR, lpG, lpB] = hexToRgb(p.lipColor);

    const softLight = (base, blend) => {
      const b = base / 255, s = blend / 255;
      return (s < 0.5 ? (2 * b * s + b * b * (1 - 2 * s)) : (2 * b * (1 - s) + Math.sqrt(Math.max(0, b)) * (2 * s - 1))) * 255;
    };

    for (let i = 0; i < data.length; i += 4) {
      let r = orig[i], g = orig[i + 1], b = orig[i + 2];

      // Determine continuous skin weight (0..1): landmark skin mask blended with universal skin probability
      const ycbcrSkin = skinProbability(r, g, b);
      const faceSkinMask = hasFace ? (masks.skin[i + 3] / 255) : 0;
      const skinW = hasFace ? (faceSkinMask * (0.35 + 0.65 * ycbcrSkin)) : (ycbcrSkin * 0.85);

      // 1. Blemish, Acne & Dark Spot Removal (localized dark/red outlier healing inside skin!)
      if (blemishAmt > 0 && skinW > 0.05 && blurMed) {
        const mr = blurMed[i], mg = blurMed[i + 1], mb = blurMed[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const mLum = 0.299 * mr + 0.587 * mg + 0.114 * mb;
        const darkDip = mLum - lum; // > 0 when pixel is a dark spot / acne mark
        const redSpike = (r - g) - (mr - mg); // > 0 when pixel is a red pimple / blotch
        const totalDiff = Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb);
        if ((darkDip > 4 && totalDiff < 145) || (redSpike > 6 && totalDiff < 130)) {
          const spotStr = clamp(Math.max(darkDip / 22, redSpike / 20), 0, 1);
          const healW = spotStr * blemishAmt * skinW * 0.92;
          r += (mr - r) * healW;
          g += (mg - g) * healW;
          b += (mb - b) * healW;
        }
      }

      // 2. Wrinkle & Fine-Line Attenuation (lifts negative high-frequency crease valleys on skin!)
      if (wrinkleAmt > 0 && skinW > 0.05 && blurFine) {
        const fr = blurFine[i], fg = blurFine[i + 1], fb = blurFine[i + 2];
        const valley = ((fr - r) + (fg - g) + (fb - b)) * 0.333;
        if (valley > 2.5 && valley < 42) {
          const wCrease = clamp((valley - 2.5) / 18, 0, 1) * wrinkleAmt * skinW;
          r += (fr - r) * wCrease;
          g += (fg - g) * wCrease;
          b += (fb - b) * wCrease;
        }
      }

      // 3. Frequency-Separated Skin Smoothing + Natural Pore Texture Control
      if ((smoothAmt > 0 || p.texture !== 0) && skinW > 0.05 && blurFine) {
        const fr = blurFine[i], fg = blurFine[i + 1], fb = blurFine[i + 2];
        // Low-frequency tone smoothing (edge-preserving so jawline/eyelashes never blur)
        if (smoothAmt > 0 && blurMed) {
          const mr = blurMed[i], mg = blurMed[i + 1], mb = blurMed[i + 2];
          const edgeDiff = Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb);
          if (edgeDiff < 82) {
            const wLow = (1 - edgeDiff / 82) * smoothAmt * skinW;
            const lowR = r + (mr - r) * wLow;
            const lowG = g + (mg - g) * wLow;
            const lowB = b + (mb - b) * wLow;
            // Re-inject controlled natural micro-texture (high-freq layer = orig - blurFine)
            // Keeps 28% micro-pore texture at default so skin looks studio-retouched, NEVER plastic!
            const keepPore = clamp(0.28 * texGain, 0.08, 0.72);
            r = lowR + (r - fr) * keepPore;
            g = lowG + (g - fg) * keepPore;
            b = lowB + (b - fb) * keepPore;
          }
        } else if (p.texture !== 0) {
          const delta = (texGain - 1.0) * skinW * 0.8;
          r += (r - fr) * delta;
          g += (g - fg) * delta;
          b += (b - fb) * delta;
        }
      }

      // 4. Under-Eye Dark Circles Removal (landmark-targeted crescent lift + warm color neutralize)
      if (underEyeAmt > 0 && hasFace) {
        const uw = masks.underEye[i + 3] / 255;
        if (uw > 0.02) {
          const lift = underEyeAmt * uw;
          r += (255 - r) * lift * 0.24 + 10 * lift;
          g += (255 - g) * lift * 0.20 + 7 * lift;
          b += (255 - b) * lift * 0.12; // slightly less blue neutralizes dark purple under-eye shadow!
        }
      }

      // 5. Eye Brightening & Iris Sparkle (landmark-targeted)
      if (eyeAmt > 0 && hasFace && blurFine) {
        const ew = masks.eye[i + 3] / 255;
        if (ew > 0.02) {
          const eStr = eyeAmt * ew;
          // Crisp iris catchlight sharpening
          r += (r - blurFine[i]) * eStr * 1.1;
          g += (g - blurFine[i + 1]) * eStr * 1.1;
          b += (b - blurFine[i + 2]) * eStr * 1.1;
          // Subtle sclera brightening on lighter eye pixels
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 110) {
            const wh = eStr * 0.22 * clamp((lum - 110) / 100, 0, 1);
            r = r + (255 - r) * wh;
            g = g + (255 - g) * wh;
            b = b + (255 - b) * wh * 1.08;
          }
        }
      }

      // 6. Teeth Whitening (landmark-targeted inside innerLips!)
      if (teethAmt > 0 && hasFace) {
        const tw = masks.teeth[i + 3] / 255;
        if (tw > 0.02) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 95) {
            const wT = teethAmt * tw * clamp((lum - 95) / 90, 0, 1);
            // Desaturate yellow cast & gently lift luminance
            const avg = (r + g + b) / 3;
            r = r + (avg - r) * (wT * 0.55) + wT * 18;
            g = g + (avg - g) * (wT * 0.55) + wT * 19;
            b = b + (avg - b) * (wT * 0.55) + wT * 24;
          }
        }
      }

      // 7. Cheek Blush & Cheekbone Champagne Glow (landmark-targeted!)
      if (cheekAmt > 0 && hasFace) {
        const cw = masks.cheek[i + 3] / 255;
        if (cw > 0.02) {
          const blend = cheekAmt * cw * (0.4 + 0.6 * ycbcrSkin);
          const tr = softLight(r, chR), tg = softLight(g, chG), tb = softLight(b, chB);
          r = r + (tr - r) * blend;
          g = g + (tg - g) * blend;
          b = b + (tb - b) * blend;
        }
        const hw = masks.hiCheek[i + 3] / 255;
        if (hw > 0.02) {
          const hi = cheekAmt * hw * 0.28;
          r += (255 - r) * hi;
          g += (248 - g) * hi;
          b += (235 - b) * hi;
        }
      }

      // 8. Natural Lip Tint & Gloss (landmark-targeted, preserves lip creases!)
      if (lipAmt > 0 && hasFace) {
        const lw = masks.lip[i + 3] / 255;
        if (lw > 0.02) {
          const blend = lipAmt * lw;
          // Realistic Multiply + Soft-Light hybrid keeps natural shadows & texture
          const mulR = (r * lpR) / 255, mulG = (g * lpG) / 255, mulB = (b * lpB) / 255;
          const slR = softLight(r, lpR), slG = softLight(g, lpG), slB = softLight(b, lpB);
          const tintR = slR * 0.62 + mulR * 0.38;
          const tintG = slG * 0.62 + mulG * 0.38;
          const tintB = slB * 0.62 + mulB * 0.38;
          r = r + (tintR - r) * blend;
          g = g + (tintG - g) * blend;
          b = b + (tintB - b) * blend;
          // Subtle glossy specular highlight on naturally bright lip ridges
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 140) {
            const gloss = blend * 0.24 * clamp((lum - 140) / 90, 0, 1);
            r += (255 - r) * gloss; g += (255 - g) * gloss; b += (255 - b) * gloss;
          }
        }
      }

      // 9. Global HD Clarity / 2X Crisp Unsharp Mask (reduced on smoothed skin so pores stay silky!)
      if (sharpAmt > 0 && blurFine) {
        const skinDamp = (smoothAmt > 0 && skinW > 0.2) ? (1 - smoothAmt * skinW * 0.72) : 1.0;
        const dr = r - blurFine[i], dg = g - blurFine[i + 1], db = b - blurFine[i + 2];
        if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 6) {
          r += dr * sharpAmt * skinDamp;
          g += dg * sharpAmt * skinDamp;
          b += db * sharpAmt * skinDamp;
        }
      }

      // 10. Global Contrast, Saturation, Brighten & Radiant Glow
      if (contrast !== 1) {
        r = (r - 128) * contrast + 128;
        g = (g - 128) * contrast + 128;
        b = (b - 128) * contrast + 128;
      }
      if (sat !== 1) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }
      if (brightLift > 0) {
        const bMask = hasFace ? (0.45 + 0.55 * skinW) : 1.0;
        const lum = (r + g + b) / 765;
        const lift = brightLift * bMask * (1 - lum * 0.52);
        r += lift; g += lift; b += lift;
      }
      if (glowAmt > 0) {
        const gMask = hasFace ? (0.4 + 0.6 * skinW) : 1.0;
        const ga = glowAmt * gMask;
        r = r + (255 - r) * ga * 0.65;
        g = g + (255 - g) * ga * 0.52;
        b = b + (255 - b) * ga * 0.36;
      }

      data[i]     = clamp(Math.round(r), 0, 255);
      data[i + 1] = clamp(Math.round(g), 0, 255);
      data[i + 2] = clamp(Math.round(b), 0, 255);
    }

    ctx.putImageData(imgData, 0, 0);
    return out;
  }

  function ensureEnhancedPreview() {
    if (!cs.workCanvas) return null;
    if (!hasEnhanceAdjustments()) {
      cs.enhancedCanvas = cs.workCanvas;
      cs.enhance.dirty = false;
      return cs.workCanvas;
    }
    if (cs.enhance.dirty || !cs.enhancedCanvas) {
      cs.enhancedCanvas = renderEnhancedToCanvas(cs.workCanvas);
      cs.enhance.dirty = false;
    }
    return cs.enhancedCanvas;
  }

  // ==========================================================================
  // Smart Remove: Native Picsart MI-GAN 512 ONNX + Exemplar Patch-Copy Fallback
  // ==========================================================================
  function hasNativeObjectRemove() {
    try {
      return !!(window.AndroidApp && typeof window.AndroidApp.objectRemoveAvailable === 'function' && window.AndroidApp.objectRemoveAvailable());
    } catch (_) {
      return false;
    }
  }

  function refreshRemoveModelStatus() {
    if (hasNativeObjectRemove() && typeof window.AndroidApp.objectRemoveModelStatus === 'function') {
      try {
        const parsed = JSON.parse(window.AndroidApp.objectRemoveModelStatus() || '{}');
        if (parsed && parsed.state) cs.remove.modelStatus = parsed;
      } catch (_) {}
    }
    updateRemoveAiBar();
  }

  function updateRemoveAiBar() {
    const statusEl = document.getElementById('creativeRemoveAiStatus');
    const dlBtn = document.getElementById('creativeRemoveDownloadBtn');
    const progWrap = document.getElementById('creativeRemoveProgress');
    const progFill = document.getElementById('creativeRemoveProgressFill');
    const applyBtn = document.getElementById('creativeRemoveApplyBtn');
    if (!statusEl) return;

    const nativeOk = hasNativeObjectRemove();
    const st = cs.remove.modelStatus || { state: 'missing', downloaded: 0, total: 28079181 };
    const pct = st.total > 0 ? clamp(Math.round((st.downloaded / st.total) * 100), 0, 100) : 0;

    statusEl.classList.remove('ready', 'busy');
    if (applyBtn) applyBtn.disabled = !!cs.remove.busy;

    if (cs.remove.busy) {
      statusEl.classList.add('busy');
      statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI removing object cleanly…';
      if (dlBtn) dlBtn.style.display = 'none';
      if (progWrap) progWrap.style.display = 'none';
      return;
    }

    if (!nativeOk) {
      statusEl.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Brush object, then tap Remove';
      if (dlBtn) dlBtn.style.display = 'none';
      if (progWrap) progWrap.style.display = 'none';
      return;
    }

    if (st.state === 'ready') {
      statusEl.classList.add('ready');
      statusEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> AI Object Removal Ready (MI-GAN)';
      if (dlBtn) dlBtn.style.display = 'none';
      if (progWrap) progWrap.style.display = 'none';
    } else if (st.state === 'downloading') {
      statusEl.classList.add('busy');
      const mbDone = (st.downloaded / (1024 * 1024)).toFixed(1);
      const mbTot = (st.total / (1024 * 1024)).toFixed(0);
      statusEl.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> Downloading AI Eraser ${pct}% (${mbDone}/${mbTot} MB)`;
      if (dlBtn) {
        dlBtn.style.display = 'inline-flex';
        dlBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
      }
      if (progWrap) progWrap.style.display = 'block';
      if (progFill) progFill.style.width = `${pct}%`;
    } else {
      statusEl.innerHTML = st.state === 'error'
        ? '<i class="fa-solid fa-triangle-exclamation"></i> AI download paused — tap to retry'
        : '<i class="fa-solid fa-wand-magic-sparkles"></i> Paint object &amp; tap Remove (AI 28 MB)';
      if (dlBtn) {
        dlBtn.style.display = 'inline-flex';
        dlBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Download AI (28 MB)';
      }
      if (progWrap) progWrap.style.display = 'none';
    }
  }

  function triggerObjectRemove() {
    if (!cs.workCanvas || !cs.remove.maskCanvas || !cs.remove.hasMask) {
      window.showToast?.('Brush over the object to remove first');
      return false;
    }
    if (cs.remove.busy) return false;

    // Prefer native Picsart MI-GAN 512 ONNX neural inpainting on Android & iOS!
    if (hasNativeObjectRemove()) {
      refreshRemoveModelStatus();
      const st = cs.remove.modelStatus;
      if (st.state === 'ready') {
        runNativeMiganRemove();
        return true;
      }
      if (st.state === 'downloading') {
        cs.remove.pendingRunAfterDownload = true;
        window.showToast?.('AI Eraser downloading… will remove automatically when ready!');
        return true;
      }
      // Kick off one-time 28 MB download and auto-run MI-GAN as soon as it finishes!
      cs.remove.pendingRunAfterDownload = true;
      window.AndroidApp.objectRemoveDownload();
      refreshRemoveModelStatus();
      window.showToast?.('⚡ Downloading AI Eraser (28 MB one-time)…');
      return true;
    }

    // Pure-browser fallback: Exemplar Patch-Copy Inpainter
    if (applyExemplarFallbackRemove()) {
      window.showToast?.('✨ Object removed!');
      return true;
    }
    return false;
  }

  function runNativeMiganRemove() {
    if (!cs.workCanvas || !cs.remove.maskCanvas || !cs.remove.hasMask) return;
    cs.remove.busy = true;
    const reqId = uid('rm');
    cs.remove.activeReqId = reqId;
    updateRemoveAiBar();

    // Save undo snapshot before applying
    const w = cs.workCanvas.width, h = cs.workCanvas.height;
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = h;
    snap.getContext('2d').drawImage(cs.workCanvas, 0, 0);
    cs.remove._pendingSnap = snap;

    const imgDataUrl = cs.workCanvas.toDataURL('image/jpeg', 0.96);
    const maskDataUrl = cs.remove.maskCanvas.toDataURL('image/png');
    try {
      window.AndroidApp.objectRemoveInpaint(reqId, imgDataUrl, maskDataUrl);
    } catch (e) {
      cs.remove.busy = false;
      cs.remove.activeReqId = null;
      cs.remove._pendingSnap = null;
      updateRemoveAiBar();
      applyExemplarFallbackRemove();
    }
  }

  // Exemplar patch-copy fallback (samples real surrounding texture patches instead of flat triangles)
  function applyExemplarFallbackRemove() {
    if (!cs.workCanvas || !cs.remove.maskCanvas || !cs.remove.hasMask) return false;
    const w = cs.workCanvas.width, h = cs.workCanvas.height;
    const mCtx = cs.remove.maskCanvas.getContext('2d', { willReadFrequently: true });
    const maskData = mCtx.getImageData(0, 0, w, h).data;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (maskData[(row + x) * 4 + 3] > 20) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return false;

    const wCtx = cs.workCanvas.getContext('2d', { willReadFrequently: true });
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = h;
    snap.getContext('2d').drawImage(cs.workCanvas, 0, 0);
    cs.remove.undoStack.push(snap);
    if (cs.remove.undoStack.length > 6) cs.remove.undoStack.shift();

    const pad = Math.min(96, Math.max(40, Math.round(Math.max(maxX - minX, maxY - minY) * 0.6)));
    const rx0 = Math.max(0, minX - pad), ry0 = Math.max(0, minY - pad);
    const rx1 = Math.min(w - 1, maxX + pad), ry1 = Math.min(h - 1, maxY + pad);
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;

    const roi = wCtx.getImageData(rx0, ry0, rw, rh);
    const px = roi.data;
    const orig = new Uint8ClampedArray(px);
    const known = new Uint8Array(rw * rh);
    const origMask = new Uint8Array(rw * rh);

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const m = maskData[((ry0 + y) * w + (rx0 + x)) * 4 + 3] > 20 ? 1 : 0;
        origMask[y * rw + x] = m;
        known[y * rw + x] = m ? 0 : 1;
      }
    }

    // Collect valid unmasked candidate source centers for texture patch matching
    const PR = 4; // 9x9 patch
    const sources = [];
    const stride = Math.max(3, Math.round(Math.sqrt(rw * rh) / 38));
    for (let sy = PR; sy < rh - PR; sy += stride) {
      for (let sx = PR; sx < rw - PR; sx += stride) {
        if (!origMask[sy * rw + sx] && !origMask[(sy - PR) * rw + (sx - PR)] &&
            !origMask[(sy + PR) * rw + (sx + PR)] && !origMask[(sy - PR) * rw + (sx + PR)] &&
            !origMask[(sy + PR) * rw + (sx - PR)]) {
          sources.push(sx, sy);
        }
      }
    }

    // Criminisi-style priority onion-peel copying real exemplar patches from surrounding background
    const step = 3;
    for (let pass = 0; pass < Math.max(rw, rh); pass++) {
      let bestX = -1, bestY = -1, bestConf = -1;
      for (let y = PR; y < rh - PR; y += step) {
        for (let x = PR; x < rw - PR; x += step) {
          if (known[y * rw + x]) continue;
          let kCnt = 0;
          for (let dy = -PR; dy <= PR; dy += 2) {
            for (let dx = -PR; dx <= PR; dx += 2) {
              if (known[(y + dy) * rw + (x + dx)]) kCnt++;
            }
          }
          if (kCnt > bestConf) { bestConf = kCnt; bestX = x; bestY = y; }
        }
      }
      if (bestX < 0 || bestConf <= 0) break;

      let bestSx = -1, bestSy = -1, bestErr = 1e18;
      for (let s = 0; s < sources.length; s += 2) {
        const sx = sources[s], sy = sources[s + 1];
        let err = 0;
        for (let dy = -PR; dy <= PR; dy += 2) {
          for (let dx = -PR; dx <= PR; dx += 2) {
            const ti = (bestY + dy) * rw + (bestX + dx);
            if (!known[ti]) continue;
            const si = (sy + dy) * rw + (sx + dx);
            const dr = px[ti * 4] - orig[si * 4];
            const dg = px[ti * 4 + 1] - orig[si * 4 + 1];
            const db = px[ti * 4 + 2] - orig[si * 4 + 2];
            err += dr * dr + dg * dg + db * db;
            if (err >= bestErr) break;
          }
          if (err >= bestErr) break;
        }
        // Slight proximity preference keeps horizon/sand continuity intact
        const distPen = ((sx - bestX) * (sx - bestX) + (sy - bestY) * (sy - bestY)) * 0.15;
        if (err + distPen < bestErr) { bestErr = err + distPen; bestSx = sx; bestSy = sy; }
      }
      if (bestSx < 0) break;

      for (let dy = -PR; dy <= PR; dy++) {
        for (let dx = -PR; dx <= PR; dx++) {
          const ti = (bestY + dy) * rw + (bestX + dx);
          if (known[ti]) continue;
          const si = (bestSy + dy) * rw + (bestSx + dx);
          px[ti * 4] = orig[si * 4];
          px[ti * 4 + 1] = orig[si * 4 + 1];
          px[ti * 4 + 2] = orig[si * 4 + 2];
          known[ti] = 1;
        }
      }
    }

    wCtx.putImageData(roi, rx0, ry0);
    mCtx.clearRect(0, 0, w, h);
    cs.remove.hasMask = false;
    cs.enhance.dirty = true;
    scheduleRender();
    return true;
  }

  // ==========================================================================
  // Drawing Routines (Preview & 4K Export Shared!)
  // ==========================================================================
  function drawRoundedRectPath(ctx, x, y, w, h, r, shape = null) {
    ctx.beginPath();
    if (shape === 'arch') {
      const archR = Math.min(w / 2, h * 0.45);
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + archR);
      ctx.arc(x + w / 2, y + archR, w / 2, Math.PI, 0, false);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      return;
    }
    const rad = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function renderCollageToContext(ctx, W, H, interactive = false) {
    const c = cs.collage;
    const layout = getCollageLayout();
    const tpl = COLLAGE_TEMPLATES.find(t => t.id === c.templateId) || COLLAGE_TEMPLATES[0];

    // 1. Background
    ctx.save();
    if (c.bgType === 'gradient') {
      const gObj = BG_GRADIENTS.find(g => g.css === c.bgValue) || BG_GRADIENTS[0];
      const grad = ctx.createLinearGradient(0, 0, W, H);
      gObj.stops.forEach((col, i) => grad.addColorStop(i / Math.max(1, gObj.stops.length - 1), col));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    } else if (c.bgType === 'blur' && cs.baseImg) {
      ctx.filter = `blur(${Math.round(Math.max(W, H) * 0.035)}px) brightness(0.75)`;
      const s = Math.max(W / cs.baseImg.naturalWidth, H / cs.baseImg.naturalHeight) * 1.15;
      const bw = cs.baseImg.naturalWidth * s, bh = cs.baseImg.naturalHeight * s;
      ctx.drawImage(cs.baseImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
      ctx.filter = 'none';
    } else if (c.bgType === 'pattern') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      const step = Math.max(14, Math.round(Math.min(W, H) * 0.035));
      for (let y = step / 2; y < H; y += step) {
        for (let x = step / 2; x < W; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, step * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      ctx.fillStyle = c.bgValue || '#0f172a';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    const scaleUnit = Math.min(W, H) / 600;
    const marginPx = Math.round(c.margin * scaleUnit);
    const gapPx = Math.round(c.spacing * scaleUnit);
    const radiusPx = Math.round(c.radius * scaleUnit);
    const footerH = (tpl.badge || layout.footer) ? Math.round(44 * scaleUnit) : 0;

    // 35mm Film sprocket holes
    if (tpl.filmHoles) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      const holeW = Math.max(6, Math.round(10 * scaleUnit));
      const holeH = Math.max(10, Math.round(16 * scaleUnit));
      const step = Math.round(28 * scaleUnit);
      for (let y = marginPx; y < H - marginPx; y += step) {
        drawRoundedRectPath(ctx, marginPx * 0.25, y, holeW, holeH, 3 * scaleUnit); ctx.fill();
        drawRoundedRectPath(ctx, W - marginPx * 0.25 - holeW, y, holeW, holeH, 3 * scaleUnit); ctx.fill();
      }
      ctx.restore();
    }

    const innerX = marginPx;
    const innerY = marginPx;
    const innerW = Math.max(20, W - marginPx * 2);
    const innerH = Math.max(20, H - marginPx * 2 - footerH);

    // Draw non-popOut cells first, then popOut cells on top so they break out cleanly!
    const order = layout.cells.map((rect, idx) => ({ rect, idx, pop: !!c.cells[idx]?.popOut }));
    order.sort((a, b) => (a.pop === b.pop ? a.idx - b.idx : (a.pop ? 1 : -1)));

    const cellRects = [];
    for (const item of order) {
      const [rx, ry, rw, rh] = item.rect;
      const halfG = gapPx / 2;
      const x = innerX + rx * innerW + (rx > 0.001 ? halfG : 0);
      const y = innerY + ry * innerH + (ry > 0.001 ? halfG : 0);
      const cw = rw * innerW - (rx > 0.001 ? halfG : 0) - (rx + rw < 0.999 ? halfG : 0);
      const ch = rh * innerH - (ry > 0.001 ? halfG : 0) - (ry + rh < 0.999 ? halfG : 0);
      cellRects[item.idx] = { x, y, w: cw, h: ch };

      const cell = c.cells[item.idx] || makeCell();
      const popGrow = item.pop ? Math.round(12 * scaleUnit) : 0;
      const dx = x - popGrow, dy = y - popGrow, dw = cw + popGrow * 2, dh = ch + popGrow * 2;

      ctx.save();
      if (item.pop) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 24 * scaleUnit;
        ctx.shadowOffsetY = 10 * scaleUnit;
      }

      drawRoundedRectPath(ctx, dx, dy, dw, dh, radiusPx, layout.shape);
      if (item.pop) {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowColor = 'transparent';
      }
      ctx.clip();

      if (cell.img && cell.img.naturalWidth > 0) {
        const iw = cell.img.naturalWidth;
        const ih = cell.img.naturalHeight;
        const rotRad = ((cell.rotation || 0) * Math.PI) / 180;
        const swapped = (Math.abs(cell.rotation || 0) % 180) === 90;
        const effW = swapped ? ih : iw;
        const effH = swapped ? iw : ih;
        const baseScale = Math.max(dw / effW, dh / effH) * (cell.zoom || 1);

        ctx.save();
        ctx.translate(dx + dw / 2 + (cell.panX || 0) * dw, dy + dh / 2 + (cell.panY || 0) * dh);
        if (cell.flipH) ctx.scale(-1, 1);
        if (rotRad) ctx.rotate(rotRad);
        ctx.drawImage(cell.img, -(iw * baseScale) / 2, -(ih * baseScale) / 2, iw * baseScale, ih * baseScale);
        ctx.restore();
      } else if (interactive) {
        // Clean interactive empty slot (never burned into saved export)
        ctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.fillRect(dx, dy, dw, dh);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = Math.max(1.5, 2 * scaleUnit);
        ctx.setLineDash([6 * scaleUnit, 5 * scaleUnit]);
        ctx.strokeRect(dx + 4, dy + 4, Math.max(4, dw - 8), Math.max(4, dh - 8));
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.font = `700 ${Math.max(18, Math.round(28 * scaleUnit))}px -apple-system,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', dx + dw / 2, dy + dh / 2);
      } else {
        // Clean subtle mat fill for unfilled slots on saved export (no + icons)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(dx, dy, dw, dh);
      }
      ctx.restore();

      // Pop-out crisp frame border / 24K Gold border
      if (item.pop || tpl.goldFrame) {
        ctx.save();
        drawRoundedRectPath(ctx, dx, dy, dw, dh, radiusPx, layout.shape);
        ctx.strokeStyle = item.pop ? '#ffffff' : 'rgba(251, 191, 36, 0.72)';
        ctx.lineWidth = Math.max(2, (item.pop ? 4 : 2.5) * scaleUnit);
        ctx.stroke();
        ctx.restore();
      }

      // Interactive selection highlight
      if (interactive && (item.idx === c.selectedCell || item.idx === c.swapSourceCell)) {
        ctx.save();
        drawRoundedRectPath(ctx, dx, dy, dw, dh, radiusPx, layout.shape);
        ctx.strokeStyle = item.idx === c.swapSourceCell ? '#38bdf8' : '#ec4899';
        ctx.lineWidth = Math.max(2.5, 3.5 * scaleUnit);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Template badge caption in footer
    if (footerH > 0) {
      const label = tpl.badge || 'PICSHELF STUDIO';
      const isLightBg = c.bgType === 'color' && (c.bgValue === '#ffffff' || c.bgValue === '#fafaf9' || c.bgValue === '#f1f5f9' || c.bgValue === '#fdf2f8' || c.bgValue === '#fef3c7');
      ctx.save();
      ctx.fillStyle = tpl.goldFrame ? '#fbbf24' : (isLightBg ? '#1e293b' : 'rgba(255,255,255,0.88)');
      ctx.font = `700 ${Math.max(11, Math.round(16 * scaleUnit))}px Georgia,serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, W / 2, H - marginPx - footerH / 2 + 4 * scaleUnit);
      ctx.restore();
    }

    cs.collage._cellRects = cellRects;
  }

  function renderDrawStrokes(ctx, W, H, strokes) {
    if (!strokes || !strokes.length) return;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    const unit = Math.min(W, H) / 600;

    for (const s of strokes) {
      if (!s.points || s.points.length < 1) continue;
      octx.save();
      const lw = Math.max(2, s.size * unit);
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.globalAlpha = (s.opacity != null ? s.opacity : 100) / 100;

      if (s.tool === 'eraser') {
        octx.globalCompositeOperation = 'destination-out';
        octx.strokeStyle = '#000';
        octx.lineWidth = lw * 1.8;
      } else if (s.tool === 'neon') {
        octx.strokeStyle = s.color;
        octx.shadowColor = s.color;
        octx.shadowBlur = lw * 2.2;
        octx.lineWidth = lw * 1.1;
      } else if (s.tool === 'marker') {
        octx.globalAlpha *= 0.45;
        octx.strokeStyle = s.color;
        octx.lineWidth = lw * 2.1;
      } else if (s.tool === 'dashed') {
        octx.strokeStyle = s.color;
        octx.lineWidth = lw;
        octx.setLineDash([lw * 1.8, lw * 1.6]);
      } else if (s.tool === 'sparkle') {
        const stamps = ['✨', '⭐', '💖', '💫'];
        octx.font = `${Math.max(14, Math.round(lw * 2.2))}px -apple-system,sans-serif`;
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        let lastX = -9999, lastY = -9999;
        const minGap = Math.max(18, lw * 2.1);
        for (let i = 0; i < s.points.length; i++) {
          const px = s.points[i][0] * W, py = s.points[i][1] * H;
          if (Math.hypot(px - lastX, py - lastY) >= minGap) {
            octx.fillText(stamps[i % stamps.length], px, py);
            lastX = px; lastY = py;
          }
        }
        octx.restore();
        continue;
      } else {
        octx.strokeStyle = s.color;
        octx.lineWidth = lw;
      }

      octx.beginPath();
      const p0 = s.points[0];
      octx.moveTo(p0[0] * W, p0[1] * H);
      if (s.points.length === 1) {
        octx.lineTo(p0[0] * W + 0.5, p0[1] * H + 0.5);
      } else {
        for (let i = 1; i < s.points.length; i++) {
          const prev = s.points[i - 1], cur = s.points[i];
          const mx = ((prev[0] + cur[0]) * 0.5) * W;
          const my = ((prev[1] + cur[1]) * 0.5) * H;
          octx.quadraticCurveTo(prev[0] * W, prev[1] * H, mx, my);
        }
        const last = s.points[s.points.length - 1];
        octx.lineTo(last[0] * W, last[1] * H);
      }
      octx.stroke();

      // Inner bright core for neon brush
      if (s.tool === 'neon') {
        octx.shadowBlur = 0;
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = Math.max(1.2, lw * 0.36);
        octx.stroke();
      }
      octx.restore();
    }
    ctx.drawImage(off, 0, 0);
  }

  function renderLayers(ctx, W, H, interactive = false) {
    if (!cs.layers.length) return;
    const unit = Math.min(W, H) / 600;

    for (const layer of cs.layers) {
      const cx = layer.x * W;
      const cy = layer.y * H;
      const sc = (layer.scale || 1) * unit;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(((layer.rotation || 0) * Math.PI) / 180);
      if (layer.flipH) ctx.scale(-1, 1);
      ctx.globalAlpha = (layer.opacity != null ? layer.opacity : 100) / 100;

      let boxW = 120 * sc, boxH = 60 * sc;

      if (layer.type === 'text') {
        const st = FONT_STYLES.find(f => f.id === layer.styleId) || FONT_STYLES[0];
        const rawText = st.uppercase ? String(layer.text || '').toUpperCase() : String(layer.text || '');
        const lines = rawText.split('\n');
        ctx.font = st.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Scale typography cleanly
        ctx.save();
        ctx.scale(sc, sc);
        const lineH = 64;
        const maxLineW = Math.max(60, ...lines.map(l => ctx.measureText(l).width));
        const totalH = lines.length * lineH;
        const padX = 24, padY = 14;
        boxW = (maxLineW + padX * 2) * sc;
        boxH = (totalH + padY * 2) * sc;

        // Background pill if requested
        if (st.pill || layer.bgMode === 'solid' || layer.bgMode === 'frosted') {
          drawRoundedRectPath(ctx, -maxLineW / 2 - padX, -totalH / 2 - padY, maxLineW + padX * 2, totalH + padY * 2, 18);
          ctx.fillStyle = layer.bgMode === 'frosted'
            ? 'rgba(15, 23, 42, 0.56)'
            : (st.pill ? (layer.color === '#ffffff' ? '#0f172a' : layer.color) : 'rgba(15, 23, 42, 0.85)');
          ctx.fill();
        }

        const fillCol = st.pill
          ? (layer.color === '#ffffff' ? '#ffffff' : '#ffffff')
          : (layer.color || '#ffffff');

        lines.forEach((line, idx) => {
          const ly = (idx - (lines.length - 1) / 2) * lineH;
          if (st.glow) {
            ctx.shadowColor = fillCol;
            ctx.shadowBlur = 22;
          } else if (st.shadow || layer.bgMode === 'none') {
            ctx.shadowColor = 'rgba(0,0,0,0.65)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetY = 4;
          }

          if (st.hollow) {
            ctx.lineWidth = 4;
            ctx.strokeStyle = fillCol;
            ctx.strokeText(line, 0, ly);
          } else {
            if (st.stroke) {
              ctx.lineWidth = 6;
              ctx.strokeStyle = '#0f172a';
              ctx.strokeText(line, 0, ly);
            }
            if (st.gold) {
              const g = ctx.createLinearGradient(0, ly - 30, 0, ly + 30);
              g.addColorStop(0, '#fef08a');
              g.addColorStop(0.5, '#f59e0b');
              g.addColorStop(1, '#b45309');
              ctx.fillStyle = g;
            } else {
              ctx.fillStyle = fillCol;
            }
            ctx.fillText(line, 0, ly);
          }
        });
        ctx.restore();
      } else if (layer.type === 'sticker') {
        if (layer.kind === 'decor') {
          ctx.save();
          ctx.scale(sc, sc);
          const id = layer.value;
          boxW = 140 * sc; boxH = 80 * sc;
          if (id === 'washi_pink' || id === 'washi_gold') {
            boxW = 180 * sc; boxH = 44 * sc;
            ctx.fillStyle = id === 'washi_gold' ? 'rgba(251, 191, 36, 0.72)' : 'rgba(244, 114, 182, 0.72)';
            ctx.fillRect(-90, -22, 180, 44);
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 6]);
            ctx.strokeRect(-86, -18, 172, 36);
            ctx.setLineDash([]);
          } else if (id === 'star_burst' || id === 'sunburst') {
            boxW = 120 * sc; boxH = 120 * sc;
            const rays = id === 'sunburst' ? 16 : 8;
            ctx.beginPath();
            for (let k = 0; k < rays * 2; k++) {
              const r = (k % 2 === 0) ? 56 : (id === 'sunburst' ? 30 : 22);
              const a = (k * Math.PI) / rays;
              if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
              else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
            }
            ctx.closePath();
            ctx.fillStyle = layer.color || '#facc15';
            ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 10;
            ctx.fill();
          } else if (id === 'heart_ring') {
            boxW = 124 * sc; boxH = 116 * sc;
            ctx.beginPath();
            ctx.moveTo(0, 40);
            ctx.bezierCurveTo(-65, -2, -56, -54, 0, -22);
            ctx.bezierCurveTo(56, -54, 65, -2, 0, 40);
            ctx.strokeStyle = layer.color || '#ec4899';
            ctx.lineWidth = 8;
            ctx.shadowColor = layer.color || '#ec4899'; ctx.shadowBlur = 14;
            ctx.stroke();
          } else if (id === 'sparkle_halo') {
            boxW = 140 * sc; boxH = 56 * sc;
            ctx.beginPath();
            ctx.ellipse(0, 0, 62, 20, 0, 0, Math.PI * 2);
            ctx.strokeStyle = '#fef08a';
            ctx.lineWidth = 6;
            ctx.shadowColor = '#facc15'; ctx.shadowBlur = 18;
            ctx.stroke();
          } else if (id === 'speech_bubble') {
            boxW = 156 * sc; boxH = 96 * sc;
            drawRoundedRectPath(ctx, -74, -44, 148, 72, 24);
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 10;
            ctx.fill();
            ctx.beginPath(); ctx.moveTo(-18, 28); ctx.lineTo(-34, 48); ctx.lineTo(4, 28); ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#0f172a'; ctx.font = '800 22px -apple-system,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('SO GOOD!', 0, -8);
          } else if (id === 'laurel') {
            boxW = 150 * sc; boxH = 110 * sc;
            ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.arc(0, 0, 46, Math.PI * 0.7, Math.PI * 1.35); ctx.stroke();
            ctx.beginPath(); ctx.arc(0, 0, 46, -Math.PI * 0.35, Math.PI * 0.3); ctx.stroke();
            ctx.fillStyle = '#fbbf24'; ctx.font = '800 22px Georgia,serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('★ TOP ★', 0, 0);
          } else if (id === 'crown_vec') {
            boxW = 136 * sc; boxH = 96 * sc;
            ctx.beginPath();
            ctx.moveTo(-54, 32); ctx.lineTo(-60, -24); ctx.lineTo(-24, 6);
            ctx.lineTo(0, -38); ctx.lineTo(24, 6); ctx.lineTo(60, -24);
            ctx.lineTo(54, 32); ctx.closePath();
            const g = ctx.createLinearGradient(0, -38, 0, 32);
            g.addColorStop(0, '#fef08a'); g.addColorStop(1, '#d97706');
            ctx.fillStyle = g; ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10;
            ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
          } else if (id === 'neon_arrow') {
            boxW = 150 * sc; boxH = 60 * sc;
            ctx.strokeStyle = layer.color || '#38bdf8'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.shadowColor = layer.color || '#38bdf8'; ctx.shadowBlur = 16;
            ctx.beginPath(); ctx.moveTo(-64, 0); ctx.lineTo(52, 0); ctx.moveTo(26, -22); ctx.lineTo(56, 0); ctx.lineTo(26, 22); ctx.stroke();
          } else if (id === 'ribbon') {
            boxW = 180 * sc; boxH = 54 * sc;
            ctx.fillStyle = layer.color || '#f43f5e';
            ctx.beginPath();
            ctx.moveTo(-88, -22); ctx.lineTo(88, -22); ctx.lineTo(74, 0); ctx.lineTo(88, 22);
            ctx.lineTo(-88, 22); ctx.lineTo(-74, 0); ctx.closePath();
            ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10; ctx.fill();
            ctx.shadowBlur = 0; ctx.fillStyle = '#ffffff'; ctx.font = '800 20px Georgia,serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('FEATURED', 0, 1);
          } else { // film_frame
            boxW = 168 * sc; boxH = 122 * sc;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
            ctx.strokeRect(-78, -55, 156, 110);
            ctx.fillStyle = '#ffffff';
            for (let fx = -66; fx <= 56; fx += 24) {
              ctx.fillRect(fx, -49, 10, 7); ctx.fillRect(fx, 42, 10, 7);
            }
          }
          ctx.restore();
        } else if (layer.kind === 'badge') {
          ctx.save();
          ctx.scale(sc, sc);
          ctx.font = '900 34px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
          const tw = Math.max(88, ctx.measureText(layer.value).width);
          const bw = tw + 36, bh = 58;
          boxW = bw * sc; boxH = bh * sc;
          drawRoundedRectPath(ctx, -bw / 2, -bh / 2, bw, bh, 14);
          ctx.fillStyle = layer.color || '#ec4899';
          ctx.shadowColor = 'rgba(0,0,0,0.45)';
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(layer.value, 0, 2);
          ctx.restore();
        } else {
          const sz = Math.round(92 * sc);
          boxW = sz * 1.15; boxH = sz * 1.15;
          ctx.font = `${sz}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.35)';
          ctx.shadowBlur = 8 * unit;
          ctx.fillText(layer.value, 0, 0);
        }
      }

      layer._box = { w: boxW, h: boxH };

      // Selection bounding box & corner resize handle (only in interactive preview)
      if (interactive && layer.id === cs.selectedLayerId && (cs.activeTool === 'text' || cs.activeTool === 'stickers')) {
        if (layer.flipH) ctx.scale(-1, 1); // keep handle upright
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = layer.locked ? '#f59e0b' : '#38bdf8';
        ctx.lineWidth = Math.max(1.8, 2.2 * unit);
        ctx.setLineDash([6 * unit, 4 * unit]);
        ctx.strokeRect(-boxW / 2, -boxH / 2, boxW, boxH);
        ctx.setLineDash([]);

        if (!layer.locked) {
          const hr = Math.max(9, 11 * unit);
          ctx.beginPath();
          ctx.arc(boxW / 2, boxH / 2, hr, 0, Math.PI * 2);
          ctx.fillStyle = '#38bdf8';
          ctx.fill();
          ctx.lineWidth = 2 * unit;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
      }

      ctx.restore();
    }
  }

  // ==========================================================================
  // Main Live Preview Render Loop (60 FPS via rAF)
  // ==========================================================================
  function scheduleRender() {
    if (cs.rafId) return;
    cs.rafId = requestAnimationFrame(() => {
      cs.rafId = 0;
      renderStageNow();
    });
  }

  function renderStageNow() {
    if (!cs.activeTool || !cs.stageCanvas) return;
    layoutStageCanvas();
    const canvas = cs.stageCanvas;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    if (cs.activeTool === 'collage') {
      renderCollageToContext(ctx, W, H, true);
      renderLayers(ctx, W, H, false);
      return;
    }

    if (!cs.workCanvas) return;

    // Enhance Before/After Split Curtain
    if (cs.activeTool === 'enhance') {
      const enhanced = ensureEnhancedPreview();
      const splitX = Math.round(W * cs.enhance.splitPos);
      // Left: Original (Before)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, H);
      ctx.clip();
      ctx.drawImage(cs.workCanvas, 0, 0, W, H);
      ctx.restore();
      // Right: Enhanced (After)
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, W - splitX, H);
      ctx.clip();
      ctx.drawImage(enhanced || cs.workCanvas, 0, 0, W, H);
      ctx.restore();
      renderDrawStrokes(ctx, W, H, cs.draw.strokes);
      renderLayers(ctx, W, H, false);
      updateSplitOverlayPosition();
      return;
    }

    // Standard creative preview (Text, Stickers, Draw, Remove)
    const base = hasEnhanceAdjustments() ? ensureEnhancedPreview() : cs.workCanvas;
    const cssFilter = (typeof window.computeCssFilterString === 'function') ? window.computeCssFilterString() : 'none';
    ctx.save();
    if (cssFilter && cssFilter !== 'none') ctx.filter = cssFilter;
    ctx.drawImage(base || cs.workCanvas, 0, 0, W, H);
    ctx.restore();

    // Draw doodle strokes + active stroke
    const allStrokes = cs.draw.activeStroke ? [...cs.draw.strokes, cs.draw.activeStroke] : cs.draw.strokes;
    renderDrawStrokes(ctx, W, H, allStrokes);

    // Draw Text & Sticker layers
    renderLayers(ctx, W, H, true);

    // Draw translucent red Remove mask overlay
    if (cs.activeTool === 'remove' && cs.remove.maskCanvas && cs.remove.hasMask) {
      ctx.save();
      ctx.globalAlpha = 0.58;
      ctx.drawImage(cs.remove.maskCanvas, 0, 0, W, H);
      ctx.restore();
    }
  }

  function updateSplitOverlayPosition() {
    const line = document.getElementById('creativeSplitLine');
    if (line) line.style.left = `${(cs.enhance.splitPos * 100).toFixed(2)}%`;
  }

  // ==========================================================================
  // Direct Touch / Pointer Interactions on Stage Canvas
  // ==========================================================================
  function getCanvasNormPoint(clientX, clientY) {
    const rect = cs.stageCanvas.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), px: (clientX - rect.left) * cs.dpr, py: (clientY - rect.top) * cs.dpr, rect };
  }

  function hitTestLayer(px, py) {
    const W = cs.stageCanvas.width, H = cs.stageCanvas.height;
    for (let i = cs.layers.length - 1; i >= 0; i--) {
      const l = cs.layers[i];
      if (!l._box) continue;
      const dx = px - l.x * W;
      const dy = py - l.y * H;
      const rad = -((l.rotation || 0) * Math.PI) / 180;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      const hw = l._box.w / 2, hh = l._box.h / 2;
      // Check resize/rotate corner handle first
      if (l.id === cs.selectedLayerId && !l.locked && Math.hypot(lx - hw, ly - hh) <= 28 * cs.dpr) {
        return { layer: l, handle: 'transform' };
      }
      if (Math.abs(lx) <= hw + 10 * cs.dpr && Math.abs(ly) <= hh + 10 * cs.dpr) {
        return { layer: l, handle: 'body' };
      }
    }
    return null;
  }

  function hitTestCollageCell(px, py) {
    const rects = cs.collage._cellRects || [];
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return i;
      }
    }
    return -1;
  }

  function paintRemoveDot(nx, ny, prevPt) {
    if (!cs.remove.maskCanvas) return;
    const mc = cs.remove.maskCanvas;
    const mctx = mc.getContext('2d');
    const unit = Math.min(mc.width, mc.height) / 600;
    const r = Math.max(5, cs.remove.brushSize * unit);
    mctx.save();
    mctx.strokeStyle = '#ef4444';
    mctx.fillStyle = '#ef4444';
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.lineWidth = r * 2;
    mctx.beginPath();
    if (prevPt) {
      mctx.moveTo(prevPt.x * mc.width, prevPt.y * mc.height);
      mctx.lineTo(nx * mc.width, ny * mc.height);
      mctx.stroke();
    } else {
      mctx.arc(nx * mc.width, ny * mc.height, r, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.restore();
    cs.remove.hasMask = true;
  }

  function bindCanvasPointers() {
    const canvas = cs.stageCanvas;
    if (!canvas || canvas._csBound) return;
    canvas._csBound = true;

    const onDown = (e) => {
      if (!cs.activeTool) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const p = getCanvasNormPoint(pt.clientX, pt.clientY);
      cs.pointer.active = true;
      cs.pointer.startX = p.x;
      cs.pointer.startY = p.y;
      cs.pointer.moved = false;

      if (cs.activeTool === 'draw') {
        cs.pointer.mode = 'draw';
        cs.draw.activeStroke = {
          tool: cs.draw.brush,
          color: cs.draw.color,
          size: cs.draw.size,
          opacity: cs.draw.opacity,
          points: [[p.x, p.y]]
        };
        scheduleRender();
      } else if (cs.activeTool === 'remove') {
        cs.pointer.mode = 'remove';
        cs.remove.painting = true;
        cs.remove.lastPt = { x: p.x, y: p.y };
        paintRemoveDot(p.x, p.y, null);
        scheduleRender();
      } else if (cs.activeTool === 'enhance') {
        cs.pointer.mode = 'split';
        cs.enhance.splitPos = clamp(p.x, 0.04, 0.96);
        scheduleRender();
      } else if (cs.activeTool === 'collage') {
        const hitIdx = hitTestCollageCell(p.px, p.py);
        if (hitIdx >= 0) {
          if (cs.collage.swapSourceCell >= 0 && cs.collage.swapSourceCell !== hitIdx) {
            const tmp = cs.collage.cells[cs.collage.swapSourceCell];
            cs.collage.cells[cs.collage.swapSourceCell] = cs.collage.cells[hitIdx];
            cs.collage.cells[hitIdx] = tmp;
            cs.collage.swapSourceCell = -1;
            cs.collage.selectedCell = hitIdx;
            updateFloatingControls();
            scheduleRender();
            window.showToast?.('⇄ Swapped collage photos!');
            cs.pointer.active = false;
            return;
          }
          cs.collage.selectedCell = hitIdx;
          const cell = cs.collage.cells[hitIdx];
          cs.pointer.mode = 'pan-cell';
          cs.pointer.origX = cell?.panX || 0;
          cs.pointer.origY = cell?.panY || 0;
          updateFloatingControls();
          scheduleRender();
        }
      } else if (cs.activeTool === 'text' || cs.activeTool === 'stickers') {
        const hit = hitTestLayer(p.px, p.py);
        if (hit) {
          cs.selectedLayerId = hit.layer.id;
          if (!hit.layer.locked) {
            const W = canvas.width, H = canvas.height;
            if (hit.handle === 'transform') {
              cs.pointer.mode = 'transform-layer';
              cs.pointer.origScale = hit.layer.scale || 1;
              cs.pointer.origRot = hit.layer.rotation || 0;
              cs.pointer.startDist = Math.max(10, Math.hypot(p.px - hit.layer.x * W, p.py - hit.layer.y * H));
              cs.pointer.startAngle = Math.atan2(p.py - hit.layer.y * H, p.px - hit.layer.x * W);
            } else {
              cs.pointer.mode = 'drag-layer';
              cs.pointer.origX = hit.layer.x;
              cs.pointer.origY = hit.layer.y;
            }
          } else {
            cs.pointer.mode = null;
          }
          syncSelectedLayerUI();
          updateFloatingControls();
          scheduleRender();
        } else {
          cs.selectedLayerId = null;
          cs.pointer.mode = null;
          updateFloatingControls();
          scheduleRender();
        }
      }
    };

    const onMove = (e) => {
      if (!cs.pointer.active || !cs.activeTool) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const p = getCanvasNormPoint(pt.clientX, pt.clientY);
      const dx = p.x - cs.pointer.startX;
      const dy = p.y - cs.pointer.startY;
      if (Math.hypot(dx, dy) > 0.025) cs.pointer.moved = true;

      if (cs.pointer.mode === 'draw' && cs.draw.activeStroke) {
        cs.draw.activeStroke.points.push([p.x, p.y]);
        scheduleRender();
      } else if (cs.pointer.mode === 'remove' && cs.remove.painting) {
        paintRemoveDot(p.x, p.y, cs.remove.lastPt);
        cs.remove.lastPt = { x: p.x, y: p.y };
        scheduleRender();
      } else if (cs.pointer.mode === 'split') {
        cs.enhance.splitPos = clamp(p.x, 0.04, 0.96);
        scheduleRender();
      } else if (cs.pointer.mode === 'pan-cell') {
        const cell = cs.collage.cells[cs.collage.selectedCell];
        if (cell && cell.img) {
          cell.panX = clamp(cs.pointer.origX + dx * 1.4, -0.6, 0.6);
          cell.panY = clamp(cs.pointer.origY + dy * 1.4, -0.6, 0.6);
          scheduleRender();
        }
      } else if (cs.pointer.mode === 'drag-layer') {
        const l = cs.layers.find(x => x.id === cs.selectedLayerId);
        if (l && !l.locked) {
          l.x = clamp(cs.pointer.origX + dx, 0.04, 0.96);
          l.y = clamp(cs.pointer.origY + dy, 0.04, 0.96);
          scheduleRender();
        }
      } else if (cs.pointer.mode === 'transform-layer') {
        const l = cs.layers.find(x => x.id === cs.selectedLayerId);
        if (l && !l.locked) {
          const W = canvas.width, H = canvas.height;
          const dist = Math.max(10, Math.hypot(p.px - l.x * W, p.py - l.y * H));
          const angle = Math.atan2(p.py - l.y * H, p.px - l.x * W);
          l.scale = clamp(cs.pointer.origScale * (dist / cs.pointer.startDist), 0.35, 3.2);
          l.rotation = Math.round(cs.pointer.origRot + ((angle - cs.pointer.startAngle) * 180) / Math.PI);
          syncSelectedLayerUI();
          scheduleRender();
        }
      }
    };

    const onUp = (e) => {
      if (!cs.pointer.active) return;
      e.stopPropagation();
      const mode = cs.pointer.mode;
      const moved = cs.pointer.moved;
      cs.pointer.active = false;
      cs.pointer.mode = null;

      if (mode === 'draw' && cs.draw.activeStroke) {
        cs.draw.strokes.push(cs.draw.activeStroke);
        cs.draw.activeStroke = null;
        cs.draw.redo = [];
        scheduleRender();
      } else if (mode === 'remove' && cs.remove.painting) {
        cs.remove.painting = false;
        cs.remove.lastPt = null;
        if (cs.remove.autoApply && cs.remove.hasMask) {
          triggerObjectRemove();
        }
      } else if (mode === 'pan-cell' && !moved) {
        const cell = cs.collage.cells[cs.collage.selectedCell];
        if (cell && !cell.img) {
          openCollagePhotoPicker();
        }
      }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp);
    canvas.addEventListener('touchcancel', onUp);

    // Draggable Before/After Split Curtain Handle
    const splitLine = document.getElementById('creativeSplitLine');
    if (splitLine) {
      const startSplit = (e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        cs.pointer.active = true;
        cs.pointer.mode = 'split';
      };
      splitLine.addEventListener('mousedown', startSplit);
      splitLine.addEventListener('touchstart', startSplit, { passive: false });
    }
  }

  // ==========================================================================
  // Collage 1M+ Virtualized Photo Picker Rail (reuses PicShelfBackdropGallery!)
  // ==========================================================================
  function openCollagePhotoPicker() {
    const wrap = document.getElementById('collagePickerWrap');
    const rail = document.getElementById('collagePickerRail');
    const title = document.getElementById('collagePickerTitle');
    if (!wrap || !rail) return;
    cs.collage.pickerOpen = true;
    wrap.classList.add('open');
    if (title) title.textContent = `Pick photo for Slot ${cs.collage.selectedCell + 1}`;
    if (window.PicShelfBackdropGallery?.render && window.state) {
      window.PicShelfBackdropGallery.render({
        container: rail,
        state: window.state,
        activePhotoId: null,
        includePending: true,
        onSelect: async (url, photo) => {
          try {
            const img = await loadImageFromUrl(url);
            const idx = clamp(cs.collage.selectedCell, 0, cs.collage.cells.length - 1);
            cs.collage.cells[idx] = makeCell(photo, img, url);
            // Automatically advance selection to next empty slot if one exists!
            const nextEmpty = cs.collage.cells.findIndex(c => !c.img);
            if (nextEmpty >= 0) {
              cs.collage.selectedCell = nextEmpty;
              if (title) title.textContent = `Pick photo for Slot ${nextEmpty + 1}`;
            } else {
              closeCollagePhotoPicker();
            }
            updateFloatingControls();
            scheduleRender();
          } catch (_) {
            window.showToast?.('Could not load selected photo');
          }
        }
      });
    }
  }

  function closeCollagePhotoPicker() {
    cs.collage.pickerOpen = false;
    const wrap = document.getElementById('collagePickerWrap');
    const rail = document.getElementById('collagePickerRail');
    if (wrap) wrap.classList.remove('open');
    if (rail && window.PicShelfBackdropGallery?.dispose) {
      window.PicShelfBackdropGallery.dispose(rail);
    }
  }

  // ==========================================================================
  // Floating Stage Controls (Selected Collage Cell / Selected Layer)
  // ==========================================================================
  function updateFloatingControls() {
    const bar = document.getElementById('creativeFloatingBar');
    if (!bar) return;

    if (cs.activeTool === 'collage') {
      const cell = cs.collage.cells[cs.collage.selectedCell];
      const hasImg = !!(cell && cell.img);
      bar.style.display = 'flex';
      bar.innerHTML = `
        <button type="button" class="creative-float-btn" data-act="pick"><i class="fa-solid fa-images"></i> ${hasImg ? 'Replace' : 'Add Photo'}</button>
        ${cs.collage.cells.length > 1 ? `<button type="button" class="creative-float-btn ${cs.collage.swapSourceCell >= 0 ? 'active' : ''}" data-act="swap"><i class="fa-solid fa-right-left"></i> ${cs.collage.swapSourceCell >= 0 ? 'Tap target' : 'Swap'}</button>` : ''}
        ${hasImg ? `<button type="button" class="creative-float-btn ${cell.popOut ? 'active' : ''}" data-act="popout"><i class="fa-solid fa-cube"></i> Pop Out</button>` : ''}
        ${hasImg ? `<button type="button" class="creative-float-btn" data-act="zoom"><i class="fa-solid fa-magnifying-glass-plus"></i> ${Math.round((cell.zoom || 1) * 100)}%</button>` : ''}
        ${hasImg ? `<button type="button" class="creative-float-btn" data-act="rotate"><i class="fa-solid fa-rotate-right"></i></button>` : ''}
        ${hasImg ? `<button type="button" class="creative-float-btn" data-act="flip"><i class="fa-solid fa-arrows-left-right"></i></button>` : ''}
      `;
      return;
    }

    if ((cs.activeTool === 'text' || cs.activeTool === 'stickers') && cs.selectedLayerId) {
      const layer = cs.layers.find(l => l.id === cs.selectedLayerId);
      if (layer) {
        bar.style.display = 'flex';
        bar.innerHTML = `
          <button type="button" class="creative-float-btn" data-act="layer-up" title="Bring Forward"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="creative-float-btn" data-act="layer-down" title="Send Backward"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="creative-float-btn ${layer.locked ? 'active' : ''}" data-act="layer-lock" title="Lock Layer"><i class="fa-solid ${layer.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
          <button type="button" class="creative-float-btn" data-act="layer-flip" title="Flip"><i class="fa-solid fa-arrows-left-right"></i></button>
          <button type="button" class="creative-float-btn" data-act="layer-dup" title="Duplicate"><i class="fa-regular fa-copy"></i></button>
          <button type="button" class="creative-float-btn danger" data-act="layer-del" title="Delete"><i class="fa-solid fa-trash"></i></button>
        `;
        return;
      }
    }

    bar.style.display = 'none';
  }

  function handleFloatingAction(act) {
    if (cs.activeTool === 'collage') {
      const idx = cs.collage.selectedCell;
      const cell = cs.collage.cells[idx];
      if (act === 'pick') {
        openCollagePhotoPicker();
      } else if (act === 'swap') {
        cs.collage.swapSourceCell = (cs.collage.swapSourceCell === idx) ? -1 : idx;
        updateFloatingControls();
        scheduleRender();
      } else if (act === 'popout' && cell) {
        cell.popOut = !cell.popOut;
        updateFloatingControls();
        scheduleRender();
      } else if (act === 'zoom' && cell) {
        const steps = [1, 1.25, 1.5, 1.85, 2.25];
        const next = steps.find(s => s > (cell.zoom || 1) + 0.05) || 1;
        cell.zoom = next;
        updateFloatingControls();
        scheduleRender();
      } else if (act === 'rotate' && cell) {
        cell.rotation = ((cell.rotation || 0) + 90) % 360;
        scheduleRender();
      } else if (act === 'flip' && cell) {
        cell.flipH = !cell.flipH;
        scheduleRender();
      }
      return;
    }

    const idx = cs.layers.findIndex(l => l.id === cs.selectedLayerId);
    if (idx < 0) return;
    const layer = cs.layers[idx];
    if (act === 'layer-up' && idx < cs.layers.length - 1) {
      [cs.layers[idx], cs.layers[idx + 1]] = [cs.layers[idx + 1], cs.layers[idx]];
    } else if (act === 'layer-down' && idx > 0) {
      [cs.layers[idx], cs.layers[idx - 1]] = [cs.layers[idx - 1], cs.layers[idx]];
    } else if (act === 'layer-lock') {
      layer.locked = !layer.locked;
    } else if (act === 'layer-flip') {
      layer.flipH = !layer.flipH;
    } else if (act === 'layer-dup') {
      const copy = { ...layer, id: uid(layer.type), x: clamp(layer.x + 0.06, 0.1, 0.9), y: clamp(layer.y + 0.06, 0.1, 0.9), locked: false };
      cs.layers.push(copy);
      cs.selectedLayerId = copy.id;
    } else if (act === 'layer-del') {
      cs.layers.splice(idx, 1);
      cs.selectedLayerId = cs.layers.length ? cs.layers[cs.layers.length - 1].id : null;
    }
    syncSelectedLayerUI();
    updateFloatingControls();
    scheduleRender();
  }

  // ==========================================================================
  // UI Builders & Panel Bindings
  // ==========================================================================
  function layoutSvg(layout) {
    const rects = layout.cells.map(([x, y, w, h]) => {
      const pad = 1.5;
      const rx = (x * 32 + pad).toFixed(1), ry = (y * 32 + pad).toFixed(1);
      const rw = Math.max(2, w * 32 - pad * 2).toFixed(1), rh = Math.max(2, h * 32 - pad * 2).toFixed(1);
      return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${layout.shape === 'arch' ? 10 : 2.5}" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="1.3"/>`;
    }).join('');
    return `<svg class="collage-layout-svg" viewBox="0 0 32 32" aria-hidden="true">${rects}</svg>`;
  }

  function buildPanelContents() {
    // 1. Collage Layout Rail
    const layoutRail = document.getElementById('collageLayoutsRail');
    if (layoutRail && !layoutRail.children.length) {
      layoutRail.innerHTML = COLLAGE_LAYOUTS.map(l => `
        <button type="button" class="collage-layout-card ${l.id === cs.collage.layoutId ? 'active' : ''}" data-layout="${l.id}" title="${l.name}">
          ${layoutSvg(l)}
          <span class="collage-layout-name">${l.name}</span>
        </button>
      `).join('');
      layoutRail.addEventListener('click', (e) => {
        const btn = e.target.closest('.collage-layout-card');
        if (!btn) return;
        cs.collage.layoutId = btn.dataset.layout;
        layoutRail.querySelectorAll('.collage-layout-card').forEach(b => b.classList.toggle('active', b === btn));
        initCollageCells(false);
        updateFloatingControls();
        scheduleRender();
      });
    }

    // 2. Collage Templates Rail
    const tplRail = document.getElementById('collageTemplatesRail');
    if (tplRail && !tplRail.children.length) {
      tplRail.innerHTML = COLLAGE_TEMPLATES.map(t => `
        <button type="button" class="creative-pill-btn ${t.id === cs.collage.templateId ? 'active' : ''}" data-tpl="${t.id}">${t.name}</button>
      `).join('');
      tplRail.addEventListener('click', (e) => {
        const btn = e.target.closest('.creative-pill-btn');
        if (!btn) return;
        const tpl = COLLAGE_TEMPLATES.find(t => t.id === btn.dataset.tpl);
        if (!tpl) return;
        cs.collage.templateId = tpl.id;
        cs.collage.bgType = tpl.bgType;
        cs.collage.bgValue = tpl.bgValue;
        cs.collage.spacing = tpl.spacing;
        cs.collage.margin = tpl.margin;
        cs.collage.radius = tpl.radius;
        syncCollageSliders();
        tplRail.querySelectorAll('.creative-pill-btn').forEach(b => b.classList.toggle('active', b === btn));
        scheduleRender();
      });
    }

    // 3. Collage Ratios Rail
    const ratioRail = document.getElementById('collageRatioRail');
    if (ratioRail && !ratioRail.children.length) {
      ratioRail.innerHTML = COLLAGE_RATIOS.map(r => `
        <button type="button" class="creative-pill-btn ${r.id === cs.collage.ratio ? 'active' : ''}" data-ratio="${r.id}">${r.label}</button>
      `).join('');
      ratioRail.addEventListener('click', (e) => {
        const btn = e.target.closest('.creative-pill-btn');
        if (!btn) return;
        cs.collage.ratio = btn.dataset.ratio;
        ratioRail.querySelectorAll('.creative-pill-btn').forEach(b => b.classList.toggle('active', b === btn));
        scheduleRender();
      });
    }

    // 4. Collage Background Rail (Palette Studio + Blur + Dots + Gradients + Solid + Saved Custom Colors)
    const renderCollageBgRail = () => {
      const bgRail = document.getElementById('collageBgRail');
      if (!bgRail) return;
      const customCols = getSavedCustomColors();
      bgRail.innerHTML = `
        <button type="button" class="creative-palette-btn" id="collagePaletteStudioBtn" title="Open Palette Studio"><span class="creative-palette-ring"></span> Palette</button>
        <button type="button" class="creative-pill-btn ${cs.collage.bgType === 'blur' ? 'active' : ''}" data-bg-type="blur"><i class="fa-solid fa-water"></i> Blur</button>
        <button type="button" class="creative-pill-btn ${cs.collage.bgType === 'pattern' ? 'active' : ''}" data-bg-type="pattern"><i class="fa-solid fa-braille"></i> Dots</button>
        ${customCols.map(col => `<button type="button" class="creative-swatch ${cs.collage.bgType === 'color' && cs.collage.bgValue.toLowerCase() === col ? 'active' : ''}" data-bg-type="color" data-bg-val="${col}" style="background:${col};" title="Custom ${col.toUpperCase()}"></button>`).join('')}
        ${BG_GRADIENTS.map(g => `<button type="button" class="creative-swatch ${cs.collage.bgType === 'gradient' && cs.collage.bgValue === g.css ? 'active' : ''}" data-bg-type="gradient" data-bg-val="${g.css}" style="background:${g.css};"></button>`).join('')}
        ${BG_COLORS.map(col => `<button type="button" class="creative-swatch ${cs.collage.bgType === 'color' && cs.collage.bgValue.toLowerCase() === col ? 'active' : ''}" data-bg-type="color" data-bg-val="${col}" style="background:${col};"></button>`).join('')}
      `;
    };
    const bgRail = document.getElementById('collageBgRail');
    if (bgRail && !bgRail._csBound) {
      bgRail._csBound = true;
      renderCollageBgRail();
      bgRail.addEventListener('click', (e) => {
        if (e.target.closest('#collagePaletteStudioBtn')) {
          openPaletteStudioFor(cs.collage.bgType === 'color' ? cs.collage.bgValue : '#f43f5e', (hex) => {
            cs.collage.bgType = 'color';
            cs.collage.bgValue = hex;
            rememberCustomColor(hex);
            renderCollageBgRail();
            scheduleRender();
          });
          return;
        }
        const btn = e.target.closest('[data-bg-type]');
        if (!btn) return;
        cs.collage.bgType = btn.dataset.bgType;
        if (btn.dataset.bgVal) cs.collage.bgValue = btn.dataset.bgVal;
        bgRail.querySelectorAll('[data-bg-type]').forEach(b => b.classList.toggle('active', b === btn));
        scheduleRender();
      });
    }

    // 5. Text Fonts & Colors (with PicShelf Palette Studio!)
    const fontRail = document.getElementById('creativeTextFontsRail');
    if (fontRail && !fontRail.children.length) {
      fontRail.innerHTML = FONT_STYLES.map(f => `
        <button type="button" class="creative-pill-btn ${f.id === cs.textStyleId ? 'active' : ''}" data-font-id="${f.id}">${f.name}</button>
      `).join('');
      fontRail.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-font-id]');
        if (!btn) return;
        cs.textStyleId = btn.dataset.fontId;
        fontRail.querySelectorAll('[data-font-id]').forEach(b => b.classList.toggle('active', b === btn));
        const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
        if (sel) sel.styleId = cs.textStyleId;
        scheduleRender();
      });
    }

    const renderTextColorRail = () => {
      const textColorRail = document.getElementById('creativeTextColorsRail');
      if (!textColorRail) return;
      const customCols = getSavedCustomColors();
      textColorRail.innerHTML = `
        <button type="button" class="creative-palette-btn" id="creativeTextPaletteBtn" title="Open Palette Studio"><span class="creative-palette-ring"></span> Palette</button>
        <button type="button" class="creative-pill-btn ${cs.textBgMode !== 'none' ? 'active' : ''}" id="creativeTextBgToggle"><i class="fa-solid fa-highlighter"></i> Pill</button>
        ${customCols.map(c => `<button type="button" class="creative-swatch ${c === cs.textColor.toLowerCase() ? 'active' : ''}" data-tcol="${c}" style="background:${c};" title="Custom ${c.toUpperCase()}"></button>`).join('')}
        ${PALETTE_COLORS.map(c => `<button type="button" class="creative-swatch ${c === cs.textColor.toLowerCase() ? 'active' : ''}" data-tcol="${c}" style="background:${c};"></button>`).join('')}
      `;
    };
    const textColorRail = document.getElementById('creativeTextColorsRail');
    if (textColorRail && !textColorRail._csBound) {
      textColorRail._csBound = true;
      renderTextColorRail();
      textColorRail.addEventListener('click', (e) => {
        if (e.target.closest('#creativeTextPaletteBtn')) {
          openPaletteStudioFor(cs.textColor || '#ffffff', (hex) => {
            cs.textColor = hex;
            rememberCustomColor(hex);
            const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
            if (sel) sel.color = hex;
            renderTextColorRail();
            scheduleRender();
          });
          return;
        }
        if (e.target.closest('#creativeTextBgToggle')) {
          const modes = ['none', 'frosted', 'solid'];
          const next = modes[(modes.indexOf(cs.textBgMode) + 1) % modes.length];
          cs.textBgMode = next;
          const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
          if (sel) sel.bgMode = next;
          renderTextColorRail();
          scheduleRender();
          return;
        }
        const sw = e.target.closest('[data-tcol]');
        if (sw) {
          cs.textColor = sw.dataset.tcol;
          textColorRail.querySelectorAll('[data-tcol]').forEach(b => b.classList.toggle('active', b === sw));
          const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
          if (sel) sel.color = cs.textColor;
          scheduleRender();
        }
      });
    }

    // 6. Stickers Packs (10 Rich Categories · 175+ Stickers)
    const stTabs = document.getElementById('creativeStickerPacks');
    const stRail = document.getElementById('creativeStickersRail');
    if (stTabs && stRail && !stTabs.children.length) {
      stTabs.innerHTML = Object.entries(STICKER_PACKS).map(([k, p]) => `
        <button type="button" class="studio-subnav-btn ${k === cs.stickerPack ? 'active' : ''}" data-pack="${k}">${p.label}</button>
      `).join('');
      const renderPack = (packKey) => {
        const pack = STICKER_PACKS[packKey] || STICKER_PACKS.trending;
        const kind = pack.kind || 'emoji';
        stRail.innerHTML = pack.items.map(item => {
          if (kind === 'decor') {
            return `<button type="button" class="creative-sticker-btn badge-sticker" data-sticker="${item.id}" data-kind="decor">${item.label}</button>`;
          }
          return `<button type="button" class="creative-sticker-btn ${kind === 'badge' ? 'badge-sticker' : ''}" data-sticker="${item}" data-kind="${kind}">${item}</button>`;
        }).join('');
      };
      renderPack(cs.stickerPack);
      stTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pack]');
        if (!btn) return;
        cs.stickerPack = btn.dataset.pack;
        stTabs.querySelectorAll('[data-pack]').forEach(b => b.classList.toggle('active', b === btn));
        renderPack(cs.stickerPack);
      });
      stRail.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-sticker]');
        if (!btn) return;
        const offset = (cs.layers.length % 5) * 0.04;
        const layer = {
          id: uid('stk'),
          type: 'sticker',
          kind: btn.dataset.kind || 'emoji',
          value: btn.dataset.sticker,
          color: PALETTE_COLORS[(cs.layers.length + 2) % PALETTE_COLORS.length],
          x: 0.5 + (offset - 0.08),
          y: 0.48 + (offset - 0.08),
          scale: 1.0,
          rotation: 0,
          opacity: 100,
          flipH: false,
          locked: false
        };
        cs.layers.push(layer);
        cs.selectedLayerId = layer.id;
        syncSelectedLayerUI();
        updateFloatingControls();
        scheduleRender();
      });
    }

    // 7. Draw Colors Rail (with PicShelf Palette Studio!)
    const renderDrawColorRail = () => {
      const drawColors = document.getElementById('creativeDrawColorsRail');
      if (!drawColors) return;
      const customCols = getSavedCustomColors();
      drawColors.innerHTML = `
        <button type="button" class="creative-palette-btn" id="creativeDrawPaletteBtn" title="Open Palette Studio"><span class="creative-palette-ring"></span> Palette</button>
        ${customCols.map(c => `<button type="button" class="creative-swatch ${c === cs.draw.color.toLowerCase() ? 'active' : ''}" data-dcol="${c}" style="background:${c};" title="Custom ${c.toUpperCase()}"></button>`).join('')}
        ${PALETTE_COLORS.map(c => `<button type="button" class="creative-swatch ${c === cs.draw.color.toLowerCase() ? 'active' : ''}" data-dcol="${c}" style="background:${c};"></button>`).join('')}
      `;
    };
    const drawColors = document.getElementById('creativeDrawColorsRail');
    if (drawColors && !drawColors._csBound) {
      drawColors._csBound = true;
      renderDrawColorRail();
      drawColors.addEventListener('click', (e) => {
        if (e.target.closest('#creativeDrawPaletteBtn')) {
          openPaletteStudioFor(cs.draw.color || '#f43f5e', (hex) => {
            cs.draw.color = hex;
            if (cs.draw.brush === 'eraser') setDrawBrush('pen');
            rememberCustomColor(hex);
            renderDrawColorRail();
          });
          return;
        }
        const sw = e.target.closest('[data-dcol]');
        if (!sw) return;
        cs.draw.color = sw.dataset.dcol;
        if (cs.draw.brush === 'eraser') setDrawBrush('pen');
        drawColors.querySelectorAll('[data-dcol]').forEach(b => b.classList.toggle('active', b === sw));
      });
    }

    // 8. Enhance Makeup Shade Rail (Cheek Glow & Lip Tint + PicShelf Palette Studio!)
    const makeupRail = document.getElementById('creativeMakeupColorsRail');
    if (makeupRail && !makeupRail._csBound) {
      makeupRail._csBound = true;
      renderMakeupColorRail();
      makeupRail.addEventListener('click', (e) => {
        const tgtBtn = e.target.closest('[data-mtarget]');
        if (tgtBtn) {
          cs.enhance.makeupTarget = tgtBtn.dataset.mtarget;
          renderMakeupColorRail();
          return;
        }
        if (e.target.closest('#creativeMakeupPaletteBtn')) {
          const isCheek = cs.enhance.makeupTarget === 'cheek';
          const curHex = isCheek ? cs.enhance.cheekColor : cs.enhance.lipColor;
          openPaletteStudioFor(curHex, (hex) => {
            rememberCustomColor(hex);
            if (isCheek) {
              cs.enhance.cheekColor = hex;
              if (cs.enhance.cheekBlush === 0) cs.enhance.cheekBlush = 35;
            } else {
              cs.enhance.lipColor = hex;
              if (cs.enhance.lipTint === 0) cs.enhance.lipTint = 35;
            }
            cs.enhance._autoPreset = false;
            cs.enhance.dirty = true;
            syncEnhanceUI();
            scheduleRender();
          });
          return;
        }
        const sw = e.target.closest('[data-mcol]');
        if (!sw) return;
        const hex = sw.dataset.mcol;
        if (cs.enhance.makeupTarget === 'cheek') {
          cs.enhance.cheekColor = hex;
          if (cs.enhance.cheekBlush === 0) cs.enhance.cheekBlush = 35;
        } else {
          cs.enhance.lipColor = hex;
          if (cs.enhance.lipTint === 0) cs.enhance.lipTint = 35;
        }
        cs.enhance._autoPreset = false;
        cs.enhance.dirty = true;
        syncEnhanceUI();
        scheduleRender();
      });
    }
  }

  function renderMakeupColorRail() {
    const rail = document.getElementById('creativeMakeupColorsRail');
    if (!rail) return;
    const isCheek = cs.enhance.makeupTarget === 'cheek';
    const activeHex = (isCheek ? cs.enhance.cheekColor : cs.enhance.lipColor || '').toLowerCase();
    const baseShades = isCheek ? CHEEK_SHADES : LIP_SHADES;
    const customCols = getSavedCustomColors().filter(c => !baseShades.includes(c));
    rail.innerHTML = `
      <button type="button" class="creative-pill-btn ${isCheek ? 'active' : ''}" data-mtarget="cheek">Cheeks</button>
      <button type="button" class="creative-pill-btn ${!isCheek ? 'active' : ''}" data-mtarget="lip">Lips</button>
      <button type="button" class="creative-palette-btn" id="creativeMakeupPaletteBtn" title="Open Palette Studio"><span class="creative-palette-ring"></span> Palette</button>
      ${baseShades.map(c => `<button type="button" class="creative-swatch ${c === activeHex ? 'active' : ''}" data-mcol="${c}" style="background:${c};"></button>`).join('')}
      ${customCols.map(c => `<button type="button" class="creative-swatch ${c === activeHex ? 'active' : ''}" data-mcol="${c}" style="background:${c};" title="Custom ${c.toUpperCase()}"></button>`).join('')}
    `;
  }

  function openPaletteStudioFor(initialHex, onApply) {
    if (typeof window.openCustomColorPickerModal === 'function') {
      window.openCustomColorPickerModal({
        initialColor: initialHex || '#f43f5e',
        onApply: (pickedHex) => {
          if (pickedHex) onApply(pickedHex);
        }
      });
    } else {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = initialHex || '#f43f5e';
      inp.oninput = () => onApply(inp.value);
      inp.click();
    }
  }

  function setDrawBrush(brush) {
    cs.draw.brush = brush;
    document.querySelectorAll('#creativeDrawBrushSubnav .studio-subnav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.brush === brush);
    });
  }

  function syncCollageSliders() {
    const map = [
      ['collageSpacingSlider', 'collageSpacingVal', cs.collage.spacing, 'px'],
      ['collageMarginSlider', 'collageMarginVal', cs.collage.margin, 'px'],
      ['collageRadiusSlider', 'collageRadiusVal', cs.collage.radius, 'px']
    ];
    for (const [sid, vid, val, suffix] of map) {
      const s = document.getElementById(sid), v = document.getElementById(vid);
      if (s) s.value = val;
      if (v) v.textContent = `${val}${suffix}`;
    }
  }

  function syncSelectedLayerUI() {
    const layer = cs.layers.find(l => l.id === cs.selectedLayerId);
    const input = document.getElementById('creativeTextInput');
    if (layer && layer.type === 'text' && input && document.activeElement !== input) {
      input.value = layer.text || '';
    }
    const sizeSlider = document.getElementById(cs.activeTool === 'stickers' ? 'creativeStickerSizeSlider' : 'creativeTextSizeSlider');
    const sizeVal = document.getElementById(cs.activeTool === 'stickers' ? 'creativeStickerSizeVal' : 'creativeTextSizeVal');
    const rotSlider = document.getElementById(cs.activeTool === 'stickers' ? 'creativeStickerRotSlider' : 'creativeTextRotSlider');
    const rotVal = document.getElementById(cs.activeTool === 'stickers' ? 'creativeStickerRotVal' : 'creativeTextRotVal');
    if (layer) {
      const pct = Math.round((layer.scale || 1) * 100);
      if (sizeSlider) sizeSlider.value = pct;
      if (sizeVal) sizeVal.textContent = `${pct}%`;
      if (rotSlider) rotSlider.value = layer.rotation || 0;
      if (rotVal) rotVal.textContent = `${layer.rotation || 0}°`;
    }
  }

  function syncEnhanceUI() {
    document.querySelectorAll('#creativeEnhancePresets .creative-pill-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === cs.enhance.preset);
    });
    const sliders = [
      ['creativeEnhanceClaritySlider',  'creativeEnhanceClarityVal',  cs.enhance.clarity,    '%'],
      ['creativeEnhanceSmoothSlider',   'creativeEnhanceSmoothVal',   cs.enhance.smooth,     '%'],
      ['creativeEnhanceBlemishSlider',  'creativeEnhanceBlemishVal',  cs.enhance.blemish,    '%'],
      ['creativeEnhanceWrinkleSlider',  'creativeEnhanceWrinkleVal',  cs.enhance.wrinkle,    '%'],
      ['creativeEnhanceTextureSlider',  'creativeEnhanceTextureVal',  cs.enhance.texture,    'signed'],
      ['creativeEnhanceUnderEyeSlider', 'creativeEnhanceUnderEyeVal', cs.enhance.underEye,   '%'],
      ['creativeEnhanceEyesSlider',     'creativeEnhanceEyesVal',     cs.enhance.eyes,       '%'],
      ['creativeEnhanceTeethSlider',    'creativeEnhanceTeethVal',    cs.enhance.teeth,      '%'],
      ['creativeEnhanceBrightenSlider', 'creativeEnhanceBrightenVal', cs.enhance.brighten,   '%'],
      ['creativeEnhanceGlowSlider',     'creativeEnhanceGlowVal',     cs.enhance.glow,       '%'],
      ['creativeEnhanceCheekSlider',    'creativeEnhanceCheekVal',    cs.enhance.cheekBlush, '%'],
      ['creativeEnhanceLipSlider',      'creativeEnhanceLipVal',      cs.enhance.lipTint,    '%']
    ];
    for (const [sid, vid, val, fmt] of sliders) {
      const s = document.getElementById(sid), v = document.getElementById(vid);
      if (s) s.value = val;
      if (v) v.textContent = fmt === 'signed' ? (val > 0 ? `+${val}` : `${val}`) : `${val}${fmt}`;
    }
    renderMakeupColorRail();
    updateFaceStatusHint();
  }

  function bindPanelEvents() {
    // Floating Stage Bar delegation
    document.getElementById('creativeFloatingBar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) handleFloatingAction(btn.dataset.act);
    });

    // Collage Subnav Tabs
    document.getElementById('studioCollageSubnav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.studio-subnav-btn');
      if (!btn) return;
      const sub = btn.dataset.sub;
      cs.collage.sub = sub;
      document.querySelectorAll('#studioCollageSubnav .studio-subnav-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('#studioPanelCollage .creative-subpanel').forEach(p => {
        p.classList.toggle('active', p.dataset.subpanel === sub);
      });
    });

    document.getElementById('collageAutoFillBtn')?.addEventListener('click', () => autoFillEmptyCollageCells());
    document.getElementById('collagePickPhotoBtn')?.addEventListener('click', () => {
      if (cs.collage.pickerOpen) closeCollagePhotoPicker();
      else openCollagePhotoPicker();
    });
    document.getElementById('collagePickerCloseBtn')?.addEventListener('click', () => closeCollagePhotoPicker());
    document.getElementById('collageDevicePickBtn')?.addEventListener('click', () => {
      document.getElementById('collageDeviceFileInput')?.click();
    });
    document.getElementById('collageDeviceFileInput')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      let slotIdx = clamp(cs.collage.selectedCell, 0, cs.collage.cells.length - 1);
      for (const file of files) {
        if (slotIdx >= cs.collage.cells.length) break;
        const url = URL.createObjectURL(file);
        try {
          const img = await loadImageFromUrl(url);
          cs.collage.cells[slotIdx] = makeCell(null, img, url);
          const nextEmpty = cs.collage.cells.findIndex(c => !c.img);
          slotIdx = nextEmpty >= 0 ? nextEmpty : slotIdx + 1;
        } catch (_) {
          URL.revokeObjectURL(url);
        }
      }
      if (cs.collage.cells.every(c => !!c.img)) closeCollagePhotoPicker();
      else cs.collage.selectedCell = Math.max(0, cs.collage.cells.findIndex(c => !c.img));
      updateFloatingControls();
      scheduleRender();
    });

    // Collage Border Sliders + Output Quality Chips
    document.getElementById('collageSpacingSlider')?.addEventListener('input', (e) => {
      cs.collage.spacing = parseInt(e.target.value, 10) || 0;
      const v = document.getElementById('collageSpacingVal'); if (v) v.textContent = `${cs.collage.spacing}px`;
      scheduleRender();
    });
    document.getElementById('collageMarginSlider')?.addEventListener('input', (e) => {
      cs.collage.margin = parseInt(e.target.value, 10) || 0;
      const v = document.getElementById('collageMarginVal'); if (v) v.textContent = `${cs.collage.margin}px`;
      scheduleRender();
    });
    document.getElementById('collageRadiusSlider')?.addEventListener('input', (e) => {
      cs.collage.radius = parseInt(e.target.value, 10) || 0;
      const v = document.getElementById('collageRadiusVal'); if (v) v.textContent = `${cs.collage.radius}px`;
      scheduleRender();
    });
    document.getElementById('collageQualityRow')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-qdim]');
      if (!btn) return;
      cs.collage.outputMaxDim = parseInt(btn.dataset.qdim, 10) || 2400;
      document.querySelectorAll('#collageQualityRow [data-qdim]').forEach(b => b.classList.toggle('active', b === btn));
    });

    // Text Add & Live Edit
    const textInput = document.getElementById('creativeTextInput');
    const addTextLayer = () => {
      const val = (textInput?.value || '').trim() || 'PicShelf';
      const offset = (cs.layers.length % 5) * 0.05;
      const layer = {
        id: uid('txt'),
        type: 'text',
        text: val,
        styleId: cs.textStyleId,
        color: cs.textColor,
        bgMode: cs.textBgMode,
        x: 0.5,
        y: clamp(0.45 + offset - 0.1, 0.15, 0.85),
        scale: 1.0,
        rotation: 0,
        opacity: 100,
        flipH: false,
        locked: false
      };
      cs.layers.push(layer);
      cs.selectedLayerId = layer.id;
      syncSelectedLayerUI();
      updateFloatingControls();
      scheduleRender();
    };
    document.getElementById('creativeTextAddBtn')?.addEventListener('click', addTextLayer);
    textInput?.addEventListener('input', (e) => {
      const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
      if (sel) {
        sel.text = e.target.value;
        scheduleRender();
      }
    });
    textInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const sel = cs.layers.find(l => l.id === cs.selectedLayerId && l.type === 'text');
        if (!sel) addTextLayer();
        textInput.blur();
      }
    });

    // Text & Sticker Size/Rotation sliders
    const bindLayerSliders = (sizeId, sizeValId, rotId, rotValId) => {
      document.getElementById(sizeId)?.addEventListener('input', (e) => {
        const pct = parseInt(e.target.value, 10) || 100;
        const v = document.getElementById(sizeValId); if (v) v.textContent = `${pct}%`;
        const sel = cs.layers.find(l => l.id === cs.selectedLayerId);
        if (sel && !sel.locked) { sel.scale = pct / 100; scheduleRender(); }
      });
      document.getElementById(rotId)?.addEventListener('input', (e) => {
        const deg = parseInt(e.target.value, 10) || 0;
        const v = document.getElementById(rotValId); if (v) v.textContent = `${deg}°`;
        const sel = cs.layers.find(l => l.id === cs.selectedLayerId);
        if (sel && !sel.locked) { sel.rotation = deg; scheduleRender(); }
      });
    };
    bindLayerSliders('creativeTextSizeSlider', 'creativeTextSizeVal', 'creativeTextRotSlider', 'creativeTextRotVal');
    bindLayerSliders('creativeStickerSizeSlider', 'creativeStickerSizeVal', 'creativeStickerRotSlider', 'creativeStickerRotVal');

    // Draw / Doodle Controls
    document.getElementById('creativeDrawBrushSubnav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-brush]');
      if (btn) setDrawBrush(btn.dataset.brush);
    });
    document.getElementById('creativeDrawSizeSlider')?.addEventListener('input', (e) => {
      cs.draw.size = parseInt(e.target.value, 10) || 10;
      const v = document.getElementById('creativeDrawSizeVal'); if (v) v.textContent = `${cs.draw.size}px`;
    });
    document.getElementById('creativeDrawOpacitySlider')?.addEventListener('input', (e) => {
      cs.draw.opacity = parseInt(e.target.value, 10) || 100;
      const v = document.getElementById('creativeDrawOpacityVal'); if (v) v.textContent = `${cs.draw.opacity}%`;
    });
    document.getElementById('creativeDrawUndoBtn')?.addEventListener('click', () => {
      if (cs.draw.strokes.length) {
        cs.draw.redo.push(cs.draw.strokes.pop());
        scheduleRender();
      }
    });
    document.getElementById('creativeDrawRedoBtn')?.addEventListener('click', () => {
      if (cs.draw.redo.length) {
        cs.draw.strokes.push(cs.draw.redo.pop());
        scheduleRender();
      }
    });
    document.getElementById('creativeDrawClearBtn')?.addEventListener('click', () => {
      cs.draw.strokes = [];
      cs.draw.redo = [];
      scheduleRender();
    });

    // Enhance & Retouch Controls
    document.getElementById('studioEnhanceSubnav')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.studio-subnav-btn');
      if (!btn) return;
      const sub = btn.dataset.sub;
      cs.enhance.sub = sub;
      document.querySelectorAll('#studioEnhanceSubnav .studio-subnav-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('#studioPanelEnhance .creative-subpanel').forEach(p => p.classList.toggle('active', p.dataset.subpanel === sub));
    });
    document.getElementById('creativeEnhancePresets')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;
      cs.enhance._autoPreset = false;
      cs.enhance.preset = btn.dataset.preset;
      if (cs.enhance.preset === 'original') {
        cs.enhance.clarity = 0; cs.enhance.smooth = 0; cs.enhance.blemish = 0;
        cs.enhance.wrinkle = 0; cs.enhance.texture = 0; cs.enhance.underEye = 0;
        cs.enhance.eyes = 0; cs.enhance.teeth = 0; cs.enhance.brighten = 0;
        cs.enhance.glow = 0; cs.enhance.cheekBlush = 0; cs.enhance.lipTint = 0;
      } else {
        requestFaceLandmarksIfNeeded();
      }
      cs.enhance.dirty = true;
      syncEnhanceUI();
      scheduleRender();
    });
    const bindEnh = (sid, vid, key, fmt = '%', makeupFocus = null) => {
      document.getElementById(sid)?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10) || 0;
        cs.enhance[key] = val;
        cs.enhance._autoPreset = false;
        const v = document.getElementById(vid);
        if (v) v.textContent = fmt === 'signed' ? (val > 0 ? `+${val}` : `${val}`) : `${val}${fmt}`;
        if (makeupFocus && cs.enhance.makeupTarget !== makeupFocus) {
          cs.enhance.makeupTarget = makeupFocus;
          renderMakeupColorRail();
        }
        cs.enhance.dirty = true;
        scheduleRender();
      });
    };
    bindEnh('creativeEnhanceClaritySlider',  'creativeEnhanceClarityVal',  'clarity');
    bindEnh('creativeEnhanceSmoothSlider',   'creativeEnhanceSmoothVal',   'smooth');
    bindEnh('creativeEnhanceBlemishSlider',  'creativeEnhanceBlemishVal',  'blemish');
    bindEnh('creativeEnhanceWrinkleSlider',  'creativeEnhanceWrinkleVal',  'wrinkle');
    bindEnh('creativeEnhanceTextureSlider',  'creativeEnhanceTextureVal',  'texture', 'signed');
    bindEnh('creativeEnhanceUnderEyeSlider', 'creativeEnhanceUnderEyeVal', 'underEye');
    bindEnh('creativeEnhanceEyesSlider',     'creativeEnhanceEyesVal',     'eyes');
    bindEnh('creativeEnhanceTeethSlider',    'creativeEnhanceTeethVal',    'teeth');
    bindEnh('creativeEnhanceBrightenSlider', 'creativeEnhanceBrightenVal', 'brighten');
    bindEnh('creativeEnhanceGlowSlider',     'creativeEnhanceGlowVal',     'glow');
    bindEnh('creativeEnhanceCheekSlider',    'creativeEnhanceCheekVal',    'cheekBlush', '%', 'cheek');
    bindEnh('creativeEnhanceLipSlider',      'creativeEnhanceLipVal',      'lipTint',    '%', 'lip');

    // Smart Remove Controls (Picsart MI-GAN AI + Working Clear & Undo)
    document.getElementById('creativeRemoveSizeSlider')?.addEventListener('input', (e) => {
      cs.remove.brushSize = parseInt(e.target.value, 10) || 30;
      const v = document.getElementById('creativeRemoveSizeVal'); if (v) v.textContent = `${cs.remove.brushSize}px`;
    });
    document.getElementById('creativeRemoveDownloadBtn')?.addEventListener('click', () => {
      if (!hasNativeObjectRemove()) return;
      if (cs.remove.modelStatus?.state === 'downloading') {
        cs.remove.pendingRunAfterDownload = false;
        window.AndroidApp.objectRemoveStopDownload?.();
      } else {
        window.AndroidApp.objectRemoveDownload?.();
      }
      refreshRemoveModelStatus();
    });
    document.getElementById('creativeRemoveApplyBtn')?.addEventListener('click', () => {
      triggerObjectRemove();
    });
    document.getElementById('creativeRemoveUndoBtn')?.addEventListener('click', () => {
      if (cs.remove.hasMask && cs.remove.maskCanvas) {
        cs.remove.maskCanvas.getContext('2d').clearRect(0, 0, cs.remove.maskCanvas.width, cs.remove.maskCanvas.height);
        cs.remove.hasMask = false;
        scheduleRender();
        return;
      }
      if (cs.remove.undoStack.length && cs.workCanvas) {
        const prev = cs.remove.undoStack.pop();
        const ctx = cs.workCanvas.getContext('2d');
        ctx.clearRect(0, 0, cs.workCanvas.width, cs.workCanvas.height);
        ctx.drawImage(prev, 0, 0);
        cs.enhance.dirty = true;
        scheduleRender();
        window.showToast?.('↶ Undid last removal');
      }
    });
    document.getElementById('creativeRemoveClearBtn')?.addEventListener('click', () => {
      let didClear = false;
      if (cs.remove.hasMask && cs.remove.maskCanvas) {
        cs.remove.maskCanvas.getContext('2d').clearRect(0, 0, cs.remove.maskCanvas.width, cs.remove.maskCanvas.height);
        cs.remove.hasMask = false;
        didClear = true;
      }
      if (!didClear && cs.remove.undoStack.length && cs.workCanvas) {
        const orig = cs.remove.undoStack[0];
        const ctx = cs.workCanvas.getContext('2d');
        ctx.clearRect(0, 0, cs.workCanvas.width, cs.workCanvas.height);
        ctx.drawImage(orig, 0, 0);
        cs.remove.undoStack = [];
        cs.enhance.dirty = true;
        didClear = true;
        window.showToast?.('↺ Restored original photo');
      } else if (didClear) {
        window.showToast?.('Cleared brush selection');
      }
      scheduleRender();
    });
  }

  // ==========================================================================
  // Export / Save Integration (100% Native PicShelf Pipeline!)
  // ==========================================================================
  function hasAnyNonCollageEdits() {
    return (
      cs.layers.length > 0 ||
      cs.draw.strokes.length > 0 ||
      hasEnhanceAdjustments() ||
      cs.remove.undoStack.length > 0
    );
  }

  function saveCollageAsNewPhoto() {
    if (typeof window.checkCanSavePhotosToGallery === 'function' && !window.checkCanSavePhotosToGallery(1)) {
      return true;
    }
    const ratio = getCollageRatioObj();
    const maxDim = cs.collage.outputMaxDim || 2400;
    let outW, outH;
    if (ratio.w >= ratio.h) {
      outW = maxDim;
      outH = Math.round((maxDim * ratio.h) / ratio.w);
    } else {
      outH = maxDim;
      outW = Math.round((maxDim * ratio.w) / ratio.h);
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const ctx = outCanvas.getContext('2d');
    renderCollageToContext(ctx, outW, outH, false);
    renderLayers(ctx, outW, outH, false);

    const dataUrl = outCanvas.toDataURL('image/jpeg', 0.94);
    const active = getActivePhoto();
    const baseName = (active?.displayName || 'Photo').replace(/\.[^/.]+$/, '').slice(0, 32);
    const newPhoto = {
      id: `collage_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      displayName: `Collage_${baseName}_${Math.floor(Date.now() / 1000) % 10000}.jpg`,
      category: active?.category || 'Loading Dock',
      tags: Array.isArray(active?.tags) ? [...active.tags] : [],
      dataUrl,
      thumbUrl: dataUrl,
      mediaType: 'image',
      isPending: active ? !!active.isPending : false,
      isFavorite: false,
      deletedAt: null,
      createdAt: Date.now(),
      location: active?.location || null
    };

    if (window.state && Array.isArray(window.state.photos)) {
      window.state.photos.unshift(newPhoto);
      if (Array.isArray(window.state.detailPhotoList)) {
        window.state.detailPhotoList.unshift(newPhoto);
      }
      window.LibraryViews?.invalidate?.();
      window.saveState?.(true);
      window.renderAll?.();
    }

    resetAllCreativeState();
    window.closeStudioDrawer?.(true);
    window.showToast?.('✨ Collage saved to your library!');

    // Open the freshly created collage right in Detail View!
    setTimeout(() => {
      if (typeof window.openPhotoDetail === 'function') {
        window.openPhotoDetail(newPhoto.id);
      }
    }, 120);
    return true;
  }

  // Draws Enhance + Remove + Draw + Text + Stickers onto an export canvas (called from applyAndSaveStudioEdits)
  function compositeCreativeOntoCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // If user applied Smart Remove, copy the cleaned workCanvas onto the export canvas first
    if (cs.remove.undoStack.length > 0 && cs.workCanvas) {
      const cssFilter = (typeof window.computeCssFilterString === 'function') ? window.computeCssFilterString() : 'none';
      ctx.save();
      if (cssFilter && cssFilter !== 'none') ctx.filter = cssFilter;
      ctx.drawImage(cs.workCanvas, 0, 0, W, H);
      ctx.restore();
    }

    // Apply Enhance & Retouch cleanly at export resolution (capped to 2400px internally for mobile speed & RAM safety)
    if (hasEnhanceAdjustments()) {
      const maxProc = 2048;
      const scale = Math.min(1, maxProc / Math.max(W, H));
      const pw = Math.max(64, Math.round(W * scale));
      const ph = Math.max(64, Math.round(H * scale));
      const tmp = document.createElement('canvas');
      tmp.width = pw; tmp.height = ph;
      tmp.getContext('2d').drawImage(canvas, 0, 0, pw, ph);
      const enhanced = renderEnhancedToCanvas(tmp);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(enhanced, 0, 0, W, H);
    }

    // Apply Doodle strokes + Text & Sticker layers crisply at full export resolution
    renderDrawStrokes(ctx, W, H, cs.draw.strokes);
    renderLayers(ctx, W, H, false);
  }

  // ==========================================================================
  // Lifecycle Hooks Called Cleanly from app.js
  // ==========================================================================
  function resetCurrentTool() {
    if (cs.activeTool === 'collage') {
      cs.collage.layoutId = '2-v';
      cs.collage.templateId = 'none';
      cs.collage.ratio = '1:1';
      cs.collage.spacing = 10;
      cs.collage.margin = 14;
      cs.collage.radius = 12;
      cs.collage.bgType = 'color';
      cs.collage.bgValue = '#0f172a';
      initCollageCells(true);
      syncCollageSliders();
      updateFloatingControls();
      scheduleRender();
    } else if (cs.activeTool === 'text') {
      cs.layers = cs.layers.filter(l => l.type !== 'text');
      cs.selectedLayerId = null;
      updateFloatingControls();
      scheduleRender();
    } else if (cs.activeTool === 'stickers') {
      cs.layers = cs.layers.filter(l => l.type !== 'sticker');
      cs.selectedLayerId = null;
      updateFloatingControls();
      scheduleRender();
    } else if (cs.activeTool === 'draw') {
      cs.draw.strokes = [];
      cs.draw.redo = [];
      scheduleRender();
    } else if (cs.activeTool === 'enhance') {
      cs.enhance.preset = 'original';
      cs.enhance.clarity = 0;
      cs.enhance.smooth = 0;
      cs.enhance.blemish = 0;
      cs.enhance.wrinkle = 0;
      cs.enhance.texture = 0;
      cs.enhance.underEye = 0;
      cs.enhance.eyes = 0;
      cs.enhance.teeth = 0;
      cs.enhance.brighten = 0;
      cs.enhance.glow = 0;
      cs.enhance.cheekBlush = 0;
      cs.enhance.lipTint = 0;
      cs.enhance._autoPreset = false;
      cs.enhance.splitPos = 0.5;
      cs.enhance.dirty = true;
      syncEnhanceUI();
      scheduleRender();
    } else if (cs.activeTool === 'remove') {
      if (cs.remove.undoStack.length && cs.workCanvas) {
        const orig = cs.remove.undoStack[0];
        const ctx = cs.workCanvas.getContext('2d');
        ctx.clearRect(0, 0, cs.workCanvas.width, cs.workCanvas.height);
        ctx.drawImage(orig, 0, 0);
        cs.remove.undoStack = [];
      }
      if (cs.remove.maskCanvas) {
        cs.remove.maskCanvas.getContext('2d').clearRect(0, 0, cs.remove.maskCanvas.width, cs.remove.maskCanvas.height);
        cs.remove.hasMask = false;
      }
      cs.enhance.dirty = true;
      scheduleRender();
    }
  }

  function resetAllCreativeState() {
    closeCollagePhotoPicker();
    cs.activeTool = null;
    cs.photoId = null;
    cs.baseImg = null;
    cs.workCanvas = null;
    cs.enhancedCanvas = null;
    cs.collage.cells = [];
    cs.collage.swapSourceCell = -1;
    cs.layers = [];
    cs.selectedLayerId = null;
    cs.draw.strokes = [];
    cs.draw.redo = [];
    cs.draw.activeStroke = null;
    cs.enhance.preset = 'original';
    cs.enhance.clarity = 0;
    cs.enhance.smooth = 0;
    cs.enhance.blemish = 0;
    cs.enhance.wrinkle = 0;
    cs.enhance.texture = 0;
    cs.enhance.underEye = 0;
    cs.enhance.eyes = 0;
    cs.enhance.teeth = 0;
    cs.enhance.brighten = 0;
    cs.enhance.glow = 0;
    cs.enhance.cheekBlush = 0;
    cs.enhance.lipTint = 0;
    cs.enhance._autoPreset = false;
    cs.enhance.faces = null;
    cs.enhance.faceReqId = null;
    cs.enhance.splitPos = 0.5;
    cs.enhance.dirty = true;
    cs.remove.undoStack = [];
    cs.remove.hasMask = false;
    hideStageOverlays();
  }

  function hideStageOverlays() {
    const c = document.getElementById('detailCreativeCanvas');
    const s = document.getElementById('creativeSplitOverlay');
    const f = document.getElementById('creativeFloatingBar');
    if (c) c.style.display = 'none';
    if (s) s.style.display = 'none';
    if (f) f.style.display = 'none';
  }

  window.PicShelfCreativeStudio = {
    isCreativeTool(toolName) {
      return CREATIVE_TOOLS.has(toolName);
    },

    init() {
      if (cs.initialized) return;
      cs.initialized = true;
      cs.stageCanvas = document.getElementById('detailCreativeCanvas');
      buildPanelContents();
      bindPanelEvents();
      bindCanvasPointers();
      window.addEventListener('resize', () => {
        if (cs.activeTool) scheduleRender();
      });
    },

    onPhotoChanged() {
      resetAllCreativeState();
    },

    onToolOpened(toolName) {
      this.init();
      cs.activeTool = toolName;
      closeCollagePhotoPicker();

      const detailImg = document.getElementById('detailImage');
      const canvas = cs.stageCanvas || document.getElementById('detailCreativeCanvas');
      cs.stageCanvas = canvas;
      const splitEl = document.getElementById('creativeSplitOverlay');

      if (detailImg) detailImg.style.display = 'none';
      if (canvas) canvas.style.display = 'block';
      if (splitEl) splitEl.style.display = (toolName === 'enhance') ? 'block' : 'none';

      // Scroll active tool button cleanly into view on the swipeable edit bar
      const btn = document.querySelector(`#detailPhotoEditBar .detail-edit-tool-btn[data-tool="${toolName}"]`);
      if (btn && typeof btn.scrollIntoView === 'function') {
        btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      }

      ensureBaseImageLoaded().then((ok) => {
        if (!ok || cs.activeTool !== toolName) return;
        if (toolName === 'collage') {
          if (!cs.collage.cells.length) initCollageCells(true);
          syncCollageSliders();
        } else if (toolName === 'enhance') {
          // Give immediate crisp HD preview (auto-upgraded to Perfect Selfie if face landmarks are detected!)
          if (cs.enhance.preset === 'original' && !hasEnhanceAdjustments()) {
            cs.enhance.preset = (Array.isArray(cs.enhance.faces) && cs.enhance.faces.length > 0) ? 'selfie' : 'hd';
            cs.enhance._autoPreset = true;
            cs.enhance.dirty = true;
          }
          syncEnhanceUI();
          requestFaceLandmarksIfNeeded();
        } else if (toolName === 'text' || toolName === 'stickers') {
          syncSelectedLayerUI();
        } else if (toolName === 'remove') {
          refreshRemoveModelStatus();
        }
        updateFloatingControls();
        scheduleRender();
        setTimeout(() => { if (cs.activeTool === toolName) scheduleRender(); }, 80);
        setTimeout(() => { if (cs.activeTool === toolName) scheduleRender(); }, 280);
      });
    },

    onToolLeft() {
      closeCollagePhotoPicker();
      cs.activeTool = null;
      hideStageOverlays();
    },

    onDrawerClosed(saved) {
      closeCollagePhotoPicker();
      cs.activeTool = null;
      hideStageOverlays();
      if (!saved) {
        resetAllCreativeState();
      }
    },

    onCompare(isComparing) {
      if (!cs.activeTool) return false;
      const detailImg = document.getElementById('detailImage');
      const canvas = cs.stageCanvas;
      const splitEl = document.getElementById('creativeSplitOverlay');
      if (isComparing) {
        if (canvas) canvas.style.display = 'none';
        if (splitEl) splitEl.style.display = 'none';
        if (detailImg) {
          detailImg.style.display = 'block';
          detailImg.style.filter = 'none';
        }
      } else {
        if (detailImg) detailImg.style.display = 'none';
        if (canvas) canvas.style.display = 'block';
        if (splitEl && cs.activeTool === 'enhance') splitEl.style.display = 'block';
        scheduleRender();
      }
      return true;
    },

    onResetCurrent() {
      if (!cs.activeTool) return false;
      resetCurrentTool();
      return true;
    },

    onResetAll() {
      resetAllCreativeState();
    },

    hasEdits() {
      return cs.activeTool === 'collage' || hasAnyNonCollageEdits();
    },

    handleSave() {
      if (cs.activeTool === 'collage') {
        return saveCollageAsNewPhoto();
      }
      return false; // Let app.js run unified applyAndSaveStudioEdits() + compositeOntoCanvas()
    },

    compositeOntoCanvas(canvas) {
      if (!hasAnyNonCollageEdits()) return;
      compositeCreativeOntoCanvas(canvas);
    },

    onFaceLandmarks(payload) {
      if (!payload || payload.id !== cs.enhance.faceReqId) return;
      const faces = Array.isArray(payload.faces) ? payload.faces : [];
      cs.enhance.faces = faces;
      if (faces.length > 0 && cs.enhance._autoPreset && cs.enhance.preset === 'hd') {
        cs.enhance.preset = 'selfie';
      }
      cs.enhance.dirty = true;
      syncEnhanceUI();
      if (cs.activeTool === 'enhance') scheduleRender();
    },

    onRemoveModelStatus(status) {
      if (status && typeof status === 'object') {
        cs.remove.modelStatus = status;
        updateRemoveAiBar();
        if (status.state === 'ready' && cs.remove.pendingRunAfterDownload) {
          cs.remove.pendingRunAfterDownload = false;
          if (cs.activeTool === 'remove' && cs.remove.hasMask && !cs.remove.busy) {
            runNativeMiganRemove();
          }
        } else if (status.state === 'error' && cs.remove.pendingRunAfterDownload) {
          cs.remove.pendingRunAfterDownload = false;
          window.showToast?.('AI download failed — using quick offline removal');
          if (cs.activeTool === 'remove' && cs.remove.hasMask) applyExemplarFallbackRemove();
        }
      }
    },

    onRemoveResult(payload) {
      if (!payload || payload.id !== cs.remove.activeReqId) return;
      cs.remove.activeReqId = null;
      cs.remove.busy = false;
      const pendingSnap = cs.remove._pendingSnap;
      cs.remove._pendingSnap = null;
      updateRemoveAiBar();

      if (payload.error || !payload.dataUrl) {
        window.showToast?.(payload.error || 'AI removal failed — using fallback');
        applyExemplarFallbackRemove();
        return;
      }

      loadImageFromUrl(payload.dataUrl).then((img) => {
        if (!cs.workCanvas) return;
        if (pendingSnap) {
          cs.remove.undoStack.push(pendingSnap);
          if (cs.remove.undoStack.length > 6) cs.remove.undoStack.shift();
        }
        const ctx = cs.workCanvas.getContext('2d');
        ctx.clearRect(0, 0, cs.workCanvas.width, cs.workCanvas.height);
        ctx.drawImage(img, 0, 0, cs.workCanvas.width, cs.workCanvas.height);
        if (cs.remove.maskCanvas) {
          cs.remove.maskCanvas.getContext('2d').clearRect(0, 0, cs.remove.maskCanvas.width, cs.remove.maskCanvas.height);
        }
        cs.remove.hasMask = false;
        cs.enhance.dirty = true;
        scheduleRender();
        const ms = payload.timing?.inferenceMs;
        window.showToast?.(ms ? `✨ Object removed with AI (${(ms / 1000).toFixed(1)}s)` : '✨ Object removed cleanly with AI!');
      }).catch(() => {
        window.showToast?.('Could not apply AI removal result');
      });
    }
  };
})();
