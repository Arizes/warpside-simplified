// Live continent map in the style of the in-game map: official terrain tiles, Census hex territories, an
// influence cloud, the lattice, base icons, animated battle bubbles and a region card. All text from the API
// is set with textContent.
// Hex geometry adapted from Honu (https://github.com/varunda/honu, MIT, src/map/LedgerModels.ts).
import { bounds, cutOffRegions, intensity, labelLines, layerShift, progress, puffRate } from './map-logic.js';

const NS = 'http://www.w3.org/2000/svg';
const HALF = 4096; // continents are 8,192 m square, centred on the origin
const TILE_PX = 256;
const LODS = [2, 3, 4]; // must match the levels fetched by `npm run assets`
const HEX_W = 200; // hex width in metres (Honu: 50/8 map units, 32 m per unit)
const FNAME = { 0: 'Unowned', 1: 'Vanu Sovereignty', 2: 'New Conglomerate', 3: 'Terran Republic', 4: 'NS Operatives' };
const FTAG = { 0: '—', 1: 'VS', 2: 'NC', 3: 'TR' };
const TYPE = { 1: 'Facility', 2: 'Amp Station', 3: 'Bio Lab', 4: 'Tech Plant', 5: 'Large Outpost', 6: 'Small Outpost', 7: 'Warpgate', 8: 'Interlink Facility', 9: 'Construction Outpost', 10: 'Relic Outpost', 11: 'Containment Site', 12: 'Trident Relay', 13: 'Seapost', 14: 'Large Outpost', 15: 'Small Outpost', 16: 'Amp Station', 17: 'Construction Outpost' };
const MAJOR = new Set([2, 3, 4, 7, 11, 12, 16]);
// Simple original glyphs on a unit badge (not game art): filled unless listed in STROKED.
const GLYPH = {
  2: 'M0.12 -0.62L-0.36 0.08H-0.02L-0.14 0.62L0.36 -0.08H0.02Z', // amp station: bolt
  16: 'M0.12 -0.62L-0.36 0.08H-0.02L-0.14 0.62L0.36 -0.08H0.02Z',
  3: 'M-0.58 0.32A0.58 0.58 0 0 1 0.58 0.32Z', // bio lab: dome
  4: 'M-0.42 -0.42H0.42V0.42H-0.42ZM0 -0.62L0.62 0L0 0.62L-0.62 0Z', // tech plant
  7: 'M0 -0.52A0.52 0.52 0 1 1 -0.01 -0.52M0 -0.24A0.24 0.24 0 1 1 -0.01 -0.24', // warpgate: rings
  5: 'M0 -0.58L0.48 -0.38L0.4 0.14L0 0.6L-0.4 0.14L-0.48 -0.38Z', // large outpost: shield
  14: 'M0 -0.58L0.48 -0.38L0.4 0.14L0 0.6L-0.4 0.14L-0.48 -0.38Z',
  6: 'M-0.26 0A0.26 0.26 0 1 0 0.26 0A0.26 0.26 0 1 0 -0.26 0', // small outpost: dot
  15: 'M-0.26 0A0.26 0.26 0 1 0 0.26 0A0.26 0.26 0 1 0 -0.26 0',
  9: 'M0 -0.5L0.52 0.4H-0.52Z', // construction outpost
  17: 'M0 -0.5L0.52 0.4H-0.52Z',
};
const STROKED = new Set([7]);
const DEFAULT_GLYPH = 'M0 -0.48L0.48 0L0 0.48L-0.48 0Z';
// Names follow the in-game filter panel where there is an equivalent.
const LAYERS = [
  ['terrain', 'Terrain'], ['bases', 'Facilities'], ['lattice', 'Facility connections'], ['owner', 'Territory control'],
  ['battles', 'Hotspots'], ['cloud', 'Influence cloud'], ['grid', 'Grid'], ['outline', 'Region borders'],
  ['names', 'Names'], ['population', 'Players seen'],
];
// Influence cloud colours, close to the territory fills sampled from the in-game map.
const CLOUD = { 1: '#9b2cf0', 2: '#1fa3f2', 3: '#ff1f3a' };
const POLL_MS = 20000;
const DETAIL_K = 0.13; // screen px per metre beyond which every base name is shown
const MAX_PUFFS = 180;

const svgEl = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
};
const minutes = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const easeOut = (t) => 1 - (1 - t) ** 3;
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/** Zoom sounds: decoded once on the first gesture, then played through Web Audio for low latency. */
function createSounds() {
  let ctx = null;
  const buffers = {};
  let muted = load('mapMuted', false) === true;
  let last = 0;
  async function init() {
    if (ctx) return;
    ctx = new AudioContext();
    for (const name of ['in', 'out']) {
      try {
        const r = await fetch(`/audio/map-zoom-${name}.wav`);
        if (r.ok) buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
      } catch { /* sounds are optional */ }
    }
  }
  return {
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      save('mapMuted', muted);
    },
    play(name) {
      if (muted) return;
      const now = performance.now();
      if (now - last < 160) return; // one sound per gesture step, not per wheel event
      last = now;
      init().then(() => {
        if (!buffers[name] || !ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = 0.4;
        src.buffer = buffers[name];
        src.connect(gain).connect(ctx.destination);
        src.start();
      });
    },
  };
}

export function createMap({ $, el, api, emblem, getWorld, onError }) {
  const svg = $('map-svg');
  // Light layers (lattice, base icons, names) live in a second SVG on top, so they can follow every
  // animation frame without forcing the heavy territory layer underneath to be redrawn.
  const top = $('map-top');
  const box = $('map-box');
  const tip = $('map-tip');
  const fxCanvas = $('map-fx');
  const fx = fxCanvas.getContext('2d');
  const layer = {};
  for (const id of ['tiles', 'fog', 'regions', 'cloud', 'grid', 'borders', 'selected']) layer[id] = svgEl('g', { class: `m-${id}` }, svg);
  for (const id of ['lattice', 'bases', 'labels']) layer[id] = svgEl('g', { class: `m-${id}` }, top);
  const flag = (cls, on) => {
    svg.classList.toggle(cls, on);
    top.classList.toggle(cls, on);
  };
  // The cloud glows only beyond the playable hexes, so it never tints the terrain inside the territory.
  const cloudClip = svgEl('path', { 'clip-rule': 'evenodd' }, svgEl('clipPath', { id: 'm-outside' }, svgEl('defs', {}, svg)));
  const cloudImg = svgEl('image', { x: -HALF, y: -HALF, width: 2 * HALF, height: 2 * HALF, preserveAspectRatio: 'none', 'clip-path': 'url(#m-outside)' }, layer.cloud);

  const sounds = createSounds();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const layers = { ...Object.fromEntries(LAYERS.map(([k]) => [k, true])), ...load('mapLayers', {}) };
  const geoCache = {}; // `${world}:${zone}` -> prepared geometry
  const tiles = new Map(); // key -> <image>
  let zone = null;
  let geo = null;
  let live = null;
  let prevOwners = {};
  let cutOff = new Set();
  let selected = null; // region id
  let vb = [-HALF, -HALF, 2 * HALF, 2 * HALF];
  let anim = 0;
  let timer = 0;
  let active = false;
  let tilesMissing = false;
  let dataError = false;
  let marks = []; // [{ g, x, y }] marker groups drawn in screen pixels, re-scaled on every view change
  let cloudKey = '';

  function setStatus() {
    const msg = dataError
      ? 'Map data is not available right now. Retrying.'
      : tilesMissing
        ? 'Terrain images are missing. Run "npm run assets" to download them.'
        : '';
    $('map-status').hidden = !msg;
    $('map-status').textContent = msg;
  }

  /* ---------- geometry ---------- */
  function prepare(raw) {
    // Honu's layout: pointy-top hexes 200 m wide; centre x = 200·hx + 100·hy, y(up) = 173.2·hy + 115.5.
    // Screen x is world z (east) and screen y is minus world x (north is up).
    let w = HEX_W;
    // Guard: if a continent ever uses another hex size, fit the scale to its base positions instead.
    const pts = [];
    for (const [x, y, rid] of raw.hexes) {
      const r = raw.regions[rid];
      if (r?.fac && r.x !== null && r.z !== null) pts.push([x, y, r.z]);
    }
    if (pts.length > 40) {
      const n = pts.length;
      const mx = pts.reduce((a, p) => a + p[0] + p[1] / 2, 0) / n;
      const mz = pts.reduce((a, p) => a + p[2], 0) / n;
      let sxz = 0;
      let sxx = 0;
      for (const p of pts) {
        const dx = p[0] + p[1] / 2 - mx;
        sxz += dx * (p[2] - mz);
        sxx += dx * dx;
      }
      const fitted = sxx ? sxz / sxx : w;
      if (Math.abs(fitted - w) / w > 0.12 && fitted > 50 && fitted < 600) w = fitted;
    }
    const c = w / Math.sqrt(3);
    const centre = (x, y) => [w * x + (w / 2) * y, -(1.5 * c * y + c)];
    const vertex = (cx, cy, i) => {
      const a = ((30 + 60 * i) * Math.PI) / 180; // pointy top
      return [cx + c * Math.cos(a), cy - c * Math.sin(a)];
    };
    const NB = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]; // edges at 0°, 60°, … 300°
    const byRegion = {};
    const occupied = new Map();
    for (const [x, y, rid] of raw.hexes) {
      if (!raw.regions[rid]?.fac) continue; // filler hexes at the map edge have no base
      (byRegion[rid] ||= []).push([x, y]);
      occupied.set(`${x},${y}`, rid);
    }
    const regions = {};
    const centres = [];
    let grid = '';
    const f1 = (v) => v.toFixed(1);
    for (const [rid, hs] of Object.entries(byRegion)) {
      let d = '';
      let border = '';
      let sx = 0;
      let sy = 0;
      for (const [x, y] of hs) {
        const [cx, cy] = centre(x, y);
        centres.push([cx, cy]);
        sx += cx;
        sy += cy;
        const v = [0, 1, 2, 3, 4, 5].map((i) => vertex(cx, cy, i));
        const hex = `M${v.map((p) => `${f1(p[0])} ${f1(p[1])}`).join('L')}Z`;
        d += hex;
        grid += hex;
        NB.forEach(([dx, dy], i) => {
          if (occupied.get(`${x + dx},${y + dy}`) === rid) return;
          // the edge facing neighbour i lies between vertices at -30° and +30° around its direction
          const a = vertex(cx, cy, (i + 5) % 6);
          const b = vertex(cx, cy, i);
          border += `M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}`;
        });
      }
      const r = raw.regions[rid];
      regions[rid] = { ...r, d, border, pos: r.x !== null && r.z !== null ? [r.z, -r.x] : [sx / hs.length, sy / hs.length] };
    }
    const byFac = {};
    for (const [rid, r] of Object.entries(regions)) if (r.fac) byFac[r.fac] = rid;
    return { regions, byFac, links: raw.links, grid, box: bounds(centres, w) || [-HALF, -HALF, HALF, HALF] };
  }

  function buildStatic() {
    for (const g of ['fog', 'regions', 'grid', 'borders', 'selected']) layer[g].replaceChildren();
    // Outside the playable hexes the in-game map sinks into a dark teal haze: a big rectangle minus every hex.
    const outside = `M${-2 * HALF} ${-2 * HALF}H${2 * HALF}V${2 * HALF}H${-2 * HALF}Z${geo.grid}`;
    svgEl('path', { d: outside, 'fill-rule': 'evenodd', class: 'm-fogpath' }, layer.fog);
    cloudClip.setAttribute('d', outside);
    for (const [rid, r] of Object.entries(geo.regions)) {
      const p = svgEl('path', { d: r.d, 'data-rid': rid, class: 'm-region o0' }, layer.regions);
      p.addEventListener('pointermove', (e) => showTip(e, rid));
      p.addEventListener('pointerleave', hideTip);
      svgEl('path', { d: r.border, class: 'm-border' }, layer.borders);
    }
    svgEl('path', { d: geo.grid, class: 'm-gridline' }, layer.grid);
    cloudKey = '';
  }

  /* ---------- view: tiles, zoom, smooth animation ---------- */
  // Box size is cached (updated by a ResizeObserver) so animation frames never force a layout to measure it.
  let size = { w: svg.clientWidth || 1, h: svg.clientHeight || 1 };
  const aspect = () => size.h / Math.max(1, size.w) || 1;
  const scale = () => Math.min(size.w / vb[2], size.h / vb[3]) || 0.1; // screen px per map metre
  function clamp(v) {
    const out = [...v];
    const a = aspect();
    // wide boxes need a wider view box to show the whole continent top to bottom
    out[2] = Math.min(2 * HALF * 1.15 * Math.max(1, 1 / a), Math.max(450, out[2]));
    out[3] = out[2] * a;
    const pad = HALF * 0.15;
    for (const [i, span] of [[0, out[2]], [1, out[3]]]) {
      const lo = -HALF - pad;
      const hi = HALF + pad - span;
      out[i] = hi < lo ? -span / 2 : Math.min(hi, Math.max(lo, out[i]));
    }
    return out;
  }
  /*
   * Profiling showed that changing the heavy SVG's viewBox on every animation frame made the browser
   * re-lay-out, repaint and re-rasterise every hex, the grid, the fog and the terrain at each new scale,
   * blocking frames for 50 to 150 ms. Like Leaflet (PS2Alerts), the heavy layer is now only moved and
   * scaled with a compositor transform while the view is in motion, and its viewBox is committed once the
   * motion settles. The light overlay still gets the exact viewBox every frame.
   */
  const fmt = (v) => v.map((n) => n.toFixed(1)).join(' ');
  let drawn = [...vb]; // the viewBox the heavy layer was last rendered with
  let shift = { s: 1, tx: 0, ty: 0 };
  let settleTimer = 0;
  function applyView() {
    top.setAttribute('viewBox', fmt(vb));
    shift = layerShift(drawn, vb, size.w, size.h);
    const { s, tx, ty } = shift;
    svg.style.transform = Math.abs(s - 1) < 1e-6 && Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01 ? '' : `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(5)})`;
    placeMarkers();
  }
  /** Renders the heavy layer at the current view: one full redraw, done only when the view is at rest. */
  function commitView() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    drawn = [...vb];
    svg.setAttribute('viewBox', fmt(vb));
    applyView();
    drawTiles();
  }
  // a short pause first, so a run of wheel notches or a quick second drag costs one redraw, not several
  const settleSoon = (ms = 140) => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(commitView, ms);
  };
  /** During long drags, refresh the heavy layer before stretched or missing terrain becomes noticeable. */
  const drifted = () => Math.abs(Math.log(shift.s)) > Math.log(1.8) || Math.abs(shift.tx) > size.w * 0.3 || Math.abs(shift.ty) > size.h * 0.3;
  function setView(v, { moving = false } = {}) {
    cancelAnimationFrame(anim);
    anim = 0;
    vb = clamp(v);
    if (!moving || drifted()) commitView();
    else applyView();
  }
  /** Eases the view box to a target, like the in-game map's zoom. */
  function animateTo(goal, ms = 280) {
    cancelAnimationFrame(anim);
    clearTimeout(settleTimer);
    const from = [...vb];
    const to = clamp(goal);
    const start = performance.now();
    const step = (t) => {
      const p = progress(t, start, ms);
      const e = easeOut(p);
      vb = from.map((v, i) => v + (to[i] - v) * e);
      applyView();
      if (p < 1) anim = requestAnimationFrame(step);
      else {
        anim = 0;
        settleSoon();
      }
    };
    anim = requestAnimationFrame(step);
  }
  let target = null; // where wheel zooming is heading, so fast scrolling stays smooth
  function zoomAt(factor, cx, cy, smooth = true) {
    const base = target && anim ? target : vb;
    const nw = clamp([0, 0, base[2] * factor, 0])[2];
    const f = nw / base[2];
    if (Math.abs(f - 1) < 1e-3) return;
    sounds.play(f < 1 ? 'in' : 'out');
    target = [cx - (cx - base[0]) * f, cy - (cy - base[1]) * f, base[2] * f, base[3] * f];
    if (smooth) animateTo(target, 220);
    else setView(target, { moving: true }); // pinch: settles when the fingers lift
  }
  /** The whole continent, filling the box like the in-game overview. */
  function fitBox() {
    // the size cache waits on a ResizeObserver callback, which can arrive after the first data does
    size = { w: svg.clientWidth || size.w, h: svg.clientHeight || size.h };
    const [x0, y0, x1, y1] = geo?.box || [-HALF, -HALF, HALF, HALF];
    const a = aspect();
    const w = Math.max(x1 - x0, (y1 - y0) / a) * 1.16;
    // nudged up a little so the header bar does not cover the northern bases
    return [(x0 + x1) / 2 - w / 2, (y0 + y1) / 2 - w * a * 0.54, w, w * a];
  }
  const fit = (smooth = false) => (smooth ? animateTo(fitBox()) : setView(fitBox()));
  /** Map metres to box pixels, honouring the SVG's centred "meet" letterboxing. */
  function viewport() {
    const k = scale();
    return { k, ox: (size.w - vb[2] * k) / 2, oy: (size.h - vb[3] * k) / 2 };
  }
  const toMap = (clientX, clientY) => {
    // the overlay is never transformed, so its box is the true map box even mid-animation
    const b = top.getBoundingClientRect(); // input events only, so the page offset is always current
    const { k, ox, oy } = viewport();
    return [vb[0] + (clientX - b.left - ox) / k, vb[1] + (clientY - b.top - oy) / k];
  };
  function focus(pos, width = 1600) {
    sounds.play(width < vb[2] ? 'in' : 'out');
    animateTo([pos[0] - width / 2, pos[1] - (width * aspect()) / 2, width, width * aspect()], 420);
  }

  function drawTiles() {
    if (!zone || !layers.terrain) return;
    const k = scale() * (window.devicePixelRatio || 1);
    // smallest level whose resolution covers the screen; level 2 always sits underneath as a base
    const want = LODS.find((l) => (TILE_PX * 2 ** l) / (2 * HALF) >= k * 0.85) ?? LODS.at(-1);
    const keep = new Set();
    for (const lod of [LODS[0], want]) {
      const n = 2 ** lod;
      const size = (2 * HALF) / n;
      const x0 = Math.max(0, Math.floor((vb[0] + HALF) / size));
      const x1 = Math.min(n - 1, Math.floor((vb[0] + vb[2] + HALF) / size));
      const y0 = Math.max(0, Math.floor((vb[1] + HALF) / size));
      const y1 = Math.min(n - 1, Math.floor((vb[1] + vb[3] + HALF) / size));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${zone}/${lod}/${x}_${y}`;
        keep.add(key);
        if (tiles.has(key)) continue;
        // tile_x_y: x is the column from the west edge, y the row from the north edge
        const img = svgEl('image', { href: `/maps/${key}.png`, x: -HALF + x * size, y: -HALF + y * size, width: size + 0.5, height: size + 0.5, preserveAspectRatio: 'none' });
        img.addEventListener('error', () => {
          img.remove(); // hexes still work without terrain
          if (!tilesMissing) {
            tilesMissing = true;
            setStatus();
          }
        });
        if (lod === LODS[0]) layer.tiles.prepend(img);
        else layer.tiles.append(img);
        tiles.set(key, img);
      }
    }
    for (const [key, img] of tiles) if (!keep.has(key)) {
      img.remove();
      tiles.delete(key);
    }
  }
  function clearTiles() {
    for (const img of tiles.values()) img.remove();
    tiles.clear();
  }

  /* ---------- territory and influence cloud ---------- */
  const ownerOf = (rid) => live?.owners?.[rid] ?? 0;
  const fightAt = (fac) => (live?.fights || []).find((f) => f.fac === fac);

  function paintRegions() {
    cutOff = geo ? cutOffRegions(geo.regions, geo.links, live?.owners || {}) : new Set();
    for (const p of layer.regions.children) {
      const rid = p.dataset.rid;
      const o = ownerOf(rid);
      p.setAttribute('class', `m-region o${o >= 1 && o <= 4 ? o : 0}${cutOff.has(rid) ? ' cut' : ''}${rid === selected ? ' sel' : ''}`);
      // a territory change since the last update briefly flashes, like a capture on the in-game map
      if (prevOwners[rid] !== undefined && prevOwners[rid] !== o) {
        p.classList.add('flash');
        setTimeout(() => p.classList.remove('flash'), 2600);
      }
    }
    prevOwners = { ...(live?.owners || {}) };
    paintCloud();
  }

  /**
   * The influence cloud: territory colours blurred into a soft glow that bleeds across faction borders and
   * out past the continent edge. Rendered once per ownership change into a small bitmap, so panning and
   * zooming only scale an image (CSP allows data: images).
   */
  function paintCloud() {
    if (!geo) return;
    const key = Object.keys(geo.regions).map((rid) => `${ownerOf(rid)}${cutOff.has(rid) ? 'c' : ''}`).join('');
    if (key === cloudKey) return;
    cloudKey = key;
    const N = 320;
    const ext = HALF * 1.2; // room for the glow beyond the hexes
    const canvas = (n) => Object.assign(document.createElement('canvas'), { width: n, height: n });
    const src = canvas(N);
    const c = src.getContext('2d');
    c.setTransform(N / (2 * ext), 0, 0, N / (2 * ext), N / 2, N / 2);
    for (const [rid, r] of Object.entries(geo.regions)) {
      const o = ownerOf(rid);
      if (!CLOUD[o]) continue;
      c.globalAlpha = cutOff.has(rid) ? 0.35 : 1;
      c.fillStyle = CLOUD[o];
      c.fill((r.path ||= new Path2D(r.d)));
    }
    const out = canvas(N);
    const o = out.getContext('2d');
    if (typeof o.filter === 'string') {
      o.filter = 'blur(9px)';
      o.drawImage(src, 0, 0);
    } else {
      // no canvas filters (older Safari): averaging down and smoothing back up is a cheap blur
      const small = canvas(40);
      const s = small.getContext('2d');
      s.imageSmoothingQuality = 'high';
      s.drawImage(src, 0, 0, 40, 40);
      o.imageSmoothingQuality = 'high';
      o.drawImage(small, 0, 0, N, N);
    }
    for (const [a, v] of [['x', -ext], ['y', -ext], ['width', 2 * ext], ['height', 2 * ext]]) cloudImg.setAttribute(a, v);
    cloudImg.setAttribute('href', out.toDataURL('image/png'));
  }

  /* ---------- markers: built per data change, re-scaled per frame ---------- */
  function buildMarkers() {
    for (const g of ['lattice', 'bases', 'labels']) layer[g].replaceChildren();
    marks = [];
    if (!geo) return;
    const owned = (o) => o >= 1 && o <= 3;
    for (const [fa, fb] of geo.links) {
      const ra = geo.byFac[fa];
      const rb = geo.byFac[fb];
      if (!ra || !rb) continue;
      const [ax, ay] = geo.regions[ra].pos;
      const [bx, by] = geo.regions[rb].pos;
      const oa = ownerOf(ra);
      const ob = ownerOf(rb);
      // a front line is a link between two different empires; links touching locked or unowned land stay grey
      const cls = owned(oa) && oa === ob ? `l${oa}` : owned(oa) && owned(ob) ? 'front' : 'l0';
      const attrs = { x1: ax.toFixed(1), y1: ay.toFixed(1), x2: bx.toFixed(1), y2: by.toFixed(1) };
      if (cls !== 'front' && cls !== 'l0') svgEl('line', { ...attrs, class: `m-link glow ${cls}` }, layer.lattice);
      svgEl('line', { ...attrs, class: `m-link ${cls}` }, layer.lattice);
    }

    for (const [rid, r] of Object.entries(geo.regions)) {
      if (!r.fac) continue;
      const major = MAJOR.has(r.t);
      const [x, y] = r.pos;
      const o = ownerOf(rid);
      const fight = fightAt(r.fac);
      const s = major ? 10.5 : 7;
      const g = svgEl('g', { class: `m-base o${o}${rid === selected ? ' sel' : ''}${cutOff.has(rid) ? ' cut' : ''}` }, layer.bases);
      if (major) svgEl('circle', { r: s + 3.5, class: 'halo' }, g);
      svgEl('circle', { r: s, class: 'badge' }, g);
      svgEl('path', { d: GLYPH[r.t] || DEFAULT_GLYPH, class: STROKED.has(r.t) ? 'glyph stroked' : 'glyph', transform: `scale(${s * 0.92})` }, g);
      marks.push({ g, x, y });

      const lg = svgEl('g', { class: `m-name${major ? ' major' : ' minor'}${rid === selected ? ' sel' : ''}` }, layer.labels);
      const lines = labelLines(r.n, r.t);
      const size = major ? 13.5 : 11.5;
      lines.forEach((line, i) => {
        const t = svgEl('text', { y: s + 4 + size * (i + 0.85), class: 'm-label', 'font-size': size }, lg);
        t.textContent = line;
      });
      if (fight?.seenTotal) {
        const label = `${fight.seenTotal}+ seen`; // a floor, not a range: the real number is unknown
        const w = label.length * 6.3 + 10;
        const pop = svgEl('g', { class: 'm-popg', transform: `translate(0 ${-(s + 14)})` }, lg);
        svgEl('rect', { x: -w / 2, y: -8, width: w, height: 15, rx: 2, class: 'm-pop' }, pop);
        const t = svgEl('text', { y: 3.5, class: 'm-pop-text', 'font-size': 10.5 }, pop);
        t.textContent = label;
      }
      marks.push({ g: lg, x, y });
    }
    placeMarkers();
  }

  /** Keeps markers a constant size on screen: one transform per marker instead of rebuilding the DOM. */
  function placeMarkers() {
    if (!geo) return;
    const k = scale();
    const u = (1 / k).toFixed(3);
    for (const m of marks) m.g.setAttribute('transform', `translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) scale(${u})`);
    flag('detail', k > DETAIL_K);
    if (!fxRaf) drawFx(performance.now());
  }

  /* ---------- battle bubbles ---------- */
  // Each fight spawns short-lived orange puffs around its base, like the in-game hotspots. The spawn rate
  // follows the server's measured heat at that base; positions inside the bubble are decorative because
  // Daybreak publishes only which continent a kill happened on (fights are placed at bases, see README).
  let puffs = [];
  let emitters = {};
  let fxRaf = 0;
  let fxLast = 0;
  let fxSize = [0, 0, 1];

  function sizeFx() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (fxSize[0] === size.w && fxSize[1] === size.h && fxSize[2] === dpr) return;
    fxSize = [size.w, size.h, dpr];
    fxCanvas.width = Math.round(size.w * dpr);
    fxCanvas.height = Math.round(size.h * dpr);
  }
  const fightsShown = () => (layers.battles && geo && live?.fights?.length ? live.fights.filter((f) => geo.byFac[f.fac]) : []);
  const animating = () => active && !document.hidden && !reduceMotion.matches && fightsShown().length > 0;
  function kickFx() {
    if (fxRaf) return;
    if (animating()) {
      fxLast = performance.now();
      fxRaf = requestAnimationFrame(fxFrame);
    } else {
      drawFx(performance.now());
    }
  }
  function fxFrame(now) {
    fxRaf = 0;
    const dt = Math.min(100, now - fxLast);
    fxLast = now;
    spawn(dt, now);
    drawFx(now);
    if (animating()) fxRaf = requestAnimationFrame(fxFrame);
  }
  function spawn(dt, now) {
    for (const f of fightsShown()) {
      const e = (emitters[f.fac] ||= { acc: Math.random() });
      e.acc += (puffRate(f.heat) * dt) / 1000;
      const v = intensity(f.heat);
      const [bx, by] = geo.regions[geo.byFac[f.fac]].pos;
      const spread = 170 + 170 * v;
      while (e.acc >= 1 && puffs.length < MAX_PUFFS) {
        e.acc -= 1;
        const a = Math.random() * Math.PI * 2;
        const d = spread * Math.sqrt(Math.random());
        puffs.push({ x: bx + Math.cos(a) * d, y: by + Math.sin(a) * d, born: now, life: 650 + Math.random() * 550, size: 110 + Math.random() * 70 + 50 * v });
      }
      if (e.acc >= 1) e.acc = 0; // at the cap: drop the backlog instead of bursting later
    }
  }
  function puffAt(sx, sy, r, alpha) {
    const g = fx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, `rgba(255, 232, 150, ${alpha})`);
    g.addColorStop(0.35, `rgba(255, 170, 50, ${alpha})`);
    g.addColorStop(0.7, `rgba(255, 120, 18, ${alpha * 0.75})`);
    g.addColorStop(1, 'rgba(255, 90, 0, 0)');
    fx.fillStyle = g;
    fx.beginPath();
    fx.arc(sx, sy, r, 0, Math.PI * 2);
    fx.fill();
  }
  function drawFx(now) {
    sizeFx();
    const dpr = fxSize[2];
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    const shown = fightsShown();
    if (!shown.length) {
      puffs = [];
      return;
    }
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { k, ox, oy } = viewport();
    const sx = (x) => (x - vb[0]) * k + ox;
    const sy = (y) => (y - vb[1]) * k + oy;
    // a faint standing haze, so a fight stays visible between puffs and with reduced motion
    for (const f of shown) {
      const v = intensity(f.heat);
      const [x, y] = geo.regions[geo.byFac[f.fac]].pos;
      const r = clampN((280 + 260 * v) * k, 22, 170);
      const g = fx.createRadialGradient(sx(x), sy(y), 0, sx(x), sy(y), r);
      g.addColorStop(0, `rgba(255, 140, 40, ${0.22 + 0.2 * v})`);
      g.addColorStop(1, 'rgba(255, 90, 0, 0)');
      fx.fillStyle = g;
      fx.beginPath();
      fx.arc(sx(x), sy(y), r, 0, Math.PI * 2);
      fx.fill();
      if (reduceMotion.matches) puffAt(sx(x), sy(y), clampN(90 * k, 6, 22), 0.85);
    }
    const alive = [];
    for (const p of puffs) {
      const t = (now - p.born) / p.life;
      if (t >= 1) continue;
      alive.push(p);
      const base = clampN(p.size * k, 7, 30);
      const r = base * (0.45 + 0.55 * easeOut(Math.min(1, t / 0.22)));
      const a = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.45);
      const px = sx(p.x);
      const py = sy(p.y);
      if (a > 0) puffAt(px, py, r, a);
      if (t > 0.3) {
        // the puff collapses into a thin expanding ring as it fades, as in the game
        fx.strokeStyle = `rgba(255, 170, 70, ${(1 - t) * 0.75})`;
        fx.lineWidth = 1.4;
        fx.beginPath();
        fx.arc(px, py, r * (1 + (t - 0.3) * 1.3), 0, Math.PI * 2);
        fx.stroke();
      }
    }
    puffs = alive;
  }

  /* ---------- selection and region card ---------- */
  function select(rid, { fly = false } = {}) {
    selected = rid && geo?.regions[rid] ? rid : null;
    layer.selected.replaceChildren();
    for (const p of layer.regions.children) p.classList.toggle('sel', p.dataset.rid === selected);
    if (!selected) {
      $('map-card').hidden = true;
      buildMarkers();
      return;
    }
    const r = geo.regions[selected];
    svgEl('path', { d: r.d, class: 'm-select-fill' }, layer.selected);
    svgEl('path', { d: r.border, class: 'm-select-glow' }, layer.selected);
    svgEl('path', { d: r.border, class: 'm-select' }, layer.selected);
    if (fly) focus(r.pos, Math.min(vb[2], 2400));
    renderCard();
    buildMarkers();
  }
  function renderCard() {
    const card = $('map-card');
    const r = selected && geo?.regions[selected];
    if (!r || !live) {
      card.hidden = true;
      return;
    }
    const o = ownerOf(selected);
    const fight = fightAt(r.fac);
    const held = live.held?.[r.fac];
    const rows = [];
    rows.push(el('p', { class: 'rc-tab', text: 'Region' }));
    rows.push(el('div', { class: 'rc-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: TYPE[r.t] || 'Facility' }), el('h3', { text: r.n || 'Territory' })),
      el('button', { type: 'button', class: 'close', 'aria-label': 'Close region details', id: 'map-card-close', text: '×' })));
    rows.push(el('div', { class: 'rc-owner' }, o >= 1 && o <= 3 ? emblem(o, 26) : null,
      el('div', {}, el('span', { class: 'rc-label', text: 'Controlled by' }), el('b', { class: `c${o}`, text: o ? FNAME[o] || 'Unknown' : 'Nobody (unowned or locked)' }))));
    if (cutOff.has(selected)) rows.push(el('p', { class: 'rc-line rc-cut', text: 'Cut off: not connected to its empire’s warpgate by the lattice.' }));
    if (held && held.f === o && o) {
      const tag = held.outfit?.tag ? `[${held.outfit.tag}] ` : '';
      const name = held.outfit ? `${tag}${held.outfit.name || 'outfit name loading…'}` : 'no outfit recorded';
      rows.push(el('p', { class: 'rc-line' }, el('span', { class: 'rc-label', text: 'Captured by ' }), el('b', { class: `c${o}`, text: name }), el('span', { class: 'sub', text: ` · held for ${minutes(live.now - held.since)}` })));
    } else {
      rows.push(el('p', { class: 'rc-line sub', text: 'Capturing outfit unknown: not seen changing hands since tracking started.' }));
    }
    if (fight) {
      const seen = fight.seen;
      const bar = el('div', { class: 'tbar big' });
      for (const fac of [1, 2, 3]) {
        if (!seen[fac]) continue;
        const seg = el('div', { class: `t${fac}`, title: `${FTAG[fac]} ${seen[fac]} seen` });
        seg.style.flexGrow = String(seen[fac]);
        bar.append(seg);
      }
      rows.push(el('div', { class: 'rc-fight' },
        el('p', { class: 'rc-alert', text: 'Combat detected' }),
        el('p', { class: 'rc-line' }, el('b', { text: `At least ${fight.seenTotal} player${fight.seenTotal === 1 ? '' : 's'} seen` }), el('span', { class: 'sub', text: ` · ${fight.kills} kills${fight.flips ? ` · ${fight.flips} flip${fight.flips > 1 ? 's' : ''}` : ''} · last ${minutes(live.now - fight.last)} ago` })),
        bar,
        el('p', { class: 'rc-split' }, ...[1, 2, 3].map((fac) => el('span', { class: `c${fac}`, text: `${FTAG[fac]} ${seen[fac]}` }))),
        // Daybreak does not publish base populations; never let the bracket read as the in-game figure
        fight.bracket ? el('p', { class: 'rc-line sub', text: `Not a population count: the in-game bracket would be ${fight.bracket} or higher.` }) : null));
    } else {
      rows.push(el('p', { class: 'rc-line sub', text: 'No combat detected here in the last 10 minutes.' }));
    }
    const caps = (live.captures || []).filter((c) => c.fac === r.fac).slice(0, 5);
    rows.push(el('h4', { text: 'Recent captures' }));
    rows.push(caps.length
      ? el('ul', { class: 'captures' }, ...caps.map((c) => el('li', {},
        el('span', { class: 'ctime', text: new Date(c.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) }),
        el('span', { class: `c${c.to}`, text: FTAG[c.to] || '?' }),
        el('span', { class: 'sub', text: `from ${FTAG[c.from] || '?'}` }),
        c.outfit?.tag ? el('span', { class: `c${c.to}`, text: `[${c.outfit.tag}]` }) : null)))
      : el('p', { class: 'rc-line sub', text: 'None in the last hour.' }));
    rows.push(el('p', { class: 'note small', text: 'Players seen are distinct characters in capture, defend and kill events placed at this base in the last 10 minutes. Players who are only present never appear in Daybreak data, so the real number is usually higher.' }));
    card.replaceChildren(...rows);
    card.hidden = false;
    $('map-card-close').addEventListener('click', () => select(null));
  }

  function showTip(e, rid) {
    if (pointers.size) return;
    const r = geo?.regions[rid];
    if (!r) return;
    const o = ownerOf(rid);
    const fight = fightAt(r.fac);
    const lines = [el('b', { text: r.n || 'Territory' }), el('span', { class: `c${o}`, text: `${TYPE[r.t] || 'Facility'} · ${o ? FTAG[o] : 'Unowned'}${cutOff.has(rid) ? ' · cut off' : ''}` })];
    if (fight) lines.push(el('span', { class: 'm-tip-fight', text: `Combat · ${fight.seenTotal}+ players seen` }));
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const b = box.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - b.left + 14, b.width - 230)}px`;
    tip.style.top = `${e.clientY - b.top + 14}px`;
  }
  function hideTip() {
    tip.hidden = true;
  }

  /* ---------- HUD, side panel and filters ---------- */
  function bar(counts) {
    const total = [1, 2, 3, 0].reduce((a, f) => a + (counts[f] || 0), 0);
    const wrap = el('div', { class: 'tbar', role: 'img', 'aria-label': [1, 2, 3].map((f) => `${FTAG[f]} ${total ? Math.round(((counts[f] || 0) / total) * 100) : 0}%`).join(', ') });
    for (const f of [1, 2, 3, 0]) {
      if (!counts[f]) continue;
      const seg = el('div', { class: `t${f}` });
      seg.style.flexGrow = String(counts[f]);
      wrap.append(seg);
    }
    return wrap;
  }
  function renderHud() {
    const z = live.zones.find((x) => x.id === zone);
    const t = z?.territory || {};
    const total = [0, 1, 2, 3].reduce((a, f) => a + (t[f] || 0), 0);
    const pct = (f) => (total ? Math.round(((t[f] || 0) / total) * 100) : 0);
    // the in-game header: continent name over a territory bar with each empire's share written inside
    const hbar = el('div', { class: 'hud-bar', role: 'img', 'aria-label': [1, 2, 3].map((f) => `${FTAG[f]} ${pct(f)}%`).join(', ') });
    for (const f of [1, 2, 3, 0]) {
      if (!t[f]) continue;
      const seg = el('div', { class: `t${f}` }, f ? el('span', { text: `${pct(f)}%` }) : null);
      seg.style.flexGrow = String(t[f]);
      hbar.append(seg);
    }
    $('map-hud').replaceChildren(el('h2', { text: z?.name || 'Map' }), total ? hbar : el('p', { class: 'rc-label', text: 'Territory unknown' }));
  }
  function renderSide() {
    $('map-zones').replaceChildren(...live.zones.map((z) => {
      const b = el('button', { type: 'button', class: 'zone', 'aria-pressed': String(z.id === zone) },
        el('span', { class: 'zname', text: z.name }),
        el('span', { class: 'zkills', text: z.kills ? `${z.kills} kills / 10 min` : z.known ? 'quiet' : 'no data' }),
        bar(z.territory));
      b.addEventListener('click', () => changeZone(z.id));
      return b;
    }));
    const name = (fac) => {
      const rid = geo?.byFac[fac];
      return rid ? geo.regions[rid].n : `Base ${fac}`;
    };
    $('map-fights').replaceChildren(...(live.fights.length ? live.fights.slice(0, 8).map((f) => {
      const b = el('button', { type: 'button', class: 'fight' },
        el('span', { class: 'fname', text: name(f.fac) }),
        el('span', { class: 'fmeta', text: `${f.seenTotal}+ seen · ${f.kills} kills${f.flips ? ` · ${f.flips} flip${f.flips > 1 ? 's' : ''}` : ''}` }),
        bar(f.factions));
      b.addEventListener('click', () => {
        const rid = geo?.byFac[f.fac];
        if (rid) select(rid, { fly: true });
      });
      return b;
    }) : [el('p', { class: 'empty', text: 'No fights detected on this continent in the last 10 minutes.' })]));
    $('map-captures').replaceChildren(...(live.captures.length ? live.captures.slice(0, 10).map((c) => el('li', {},
      el('span', { class: 'ctime', text: new Date(c.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) }),
      emblem(c.to, 18),
      el('span', { class: `c${c.to}`, text: name(c.fac) }),
      el('span', { class: 'sub', text: `from ${FTAG[c.from] || '?'}${c.outfit?.tag ? ` · [${c.outfit.tag}]` : ''}` }))) : [el('li', { class: 'empty', text: 'No bases have changed hands here in the last hour.' })]));
    const zk = live.zoneKills;
    $('map-title').textContent = live.zones.find((z) => z.id === zone)?.name || 'Map';
    $('map-sub').textContent = zk.total ? `${zk.total} kills in the last 10 minutes · VS ${zk[1]} · NC ${zk[2]} · TR ${zk[3]}` : 'No kills in the last 10 minutes';
  }
  function buildFilters() {
    $('map-filters-list').replaceChildren(...LAYERS.map(([key, label]) => {
      const input = el('input', { type: 'checkbox', id: `layer-${key}` });
      input.checked = layers[key];
      input.addEventListener('change', () => {
        layers[key] = input.checked;
        save('mapLayers', layers);
        applyLayers();
      });
      return el('label', { class: 'filter', for: `layer-${key}` }, input, el('span', { text: label }));
    }));
    const toggle = $('map-filters-toggle');
    // on a phone the open panel would cover most of the map, so it starts folded
    if (window.matchMedia('(max-width: 640px)').matches) {
      toggle.setAttribute('aria-expanded', 'false');
      $('map-filters-list').hidden = true;
    }
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      $('map-filters-list').hidden = !open;
    });
  }
  function applyLayers() {
    for (const [key] of LAYERS) flag(`no-${key}`, !layers[key]);
    if (layers.terrain) drawTiles();
    else clearTiles();
    placeMarkers();
    kickFx();
  }

  /* ---------- data ---------- */
  async function loadGeometry() {
    const key = `${getWorld()}:${zone}`;
    if (!geoCache[key]) geoCache[key] = prepare(await api(`/api/map-static?world=${getWorld()}&zone=${zone}`));
    geo = geoCache[key];
    buildStatic();
  }
  async function poll() {
    try {
      const q = zone === null ? '' : `&zone=${zone}`;
      const data = await api(`/api/map?world=${getWorld()}${q}`);
      const first = zone === null || !geo;
      zone = data.zone;
      live = data;
      if (first) {
        clearTiles();
        prevOwners = {};
        await loadGeometry();
        fit();
      }
      paintRegions();
      buildMarkers();
      renderHud();
      renderSide();
      if (selected) renderCard();
      // emitters for fights that ended are dropped; their last puffs finish on their own
      const ongoing = new Set(live.fights.map((f) => f.fac));
      for (const fac of Object.keys(emitters)) if (!ongoing.has(fac)) delete emitters[fac];
      kickFx();
      dataError = false;
    } catch {
      dataError = true;
      onError?.();
    }
    setStatus();
  }
  async function changeZone(z) {
    if (z === zone) return;
    zone = z;
    geo = null;
    live = null;
    puffs = [];
    emitters = {};
    select(null);
    clearTiles();
    for (const g of ['fog', 'regions', 'grid', 'borders', 'selected', 'lattice', 'bases', 'labels']) layer[g].replaceChildren();
    cloudImg.removeAttribute('href');
    cloudKey = '';
    await poll();
  }

  /* ---------- input ---------- */
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = toMap(e.clientX, e.clientY);
    // trackpads send many small deltas: scale by the delta so a pinch-scroll feels continuous.
    // Firefox reports mouse wheels in lines (deltaMode 1), roughly 33 px each.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const step = clampN(Math.abs(dy) / 100, 0.15, 1.5);
    zoomAt((dy > 0 ? 1.3 : 1 / 1.3) ** step, x, y);
  }, { passive: false });
  const pointers = new Map();
  let pinch = 0;
  let moved = 0;
  let fling = null; // [vx, vy] in metres per ms, for a short glide after a drag
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY, e.timeStamp]);
    moved = 0;
    fling = null;
    cancelAnimationFrame(anim);
    anim = 0;
    target = null;
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY, e.timeStamp]);
    moved += Math.abs(e.clientX - prev[0]) + Math.abs(e.clientY - prev[1]);
    if (moved > 4) svg.classList.add('drag');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) {
        const [x, y] = toMap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        zoomAt(pinch / d, x, y, false);
      }
      pinch = d;
      fling = null;
      return;
    }
    const k = scale();
    hideTip();
    const dt = Math.max(1, e.timeStamp - prev[2]);
    fling = [(e.clientX - prev[0]) / k / dt, (e.clientY - prev[1]) / k / dt];
    setView([vb[0] - (e.clientX - prev[0]) / k, vb[1] - (e.clientY - prev[1]) / k, vb[2], vb[3]], { moving: true });
  });
  /** Returns true when a glide started; it settles the heavy layer itself when it stops. */
  function glide() {
    if (!fling || reduceMotion.matches) return false;
    let [vx, vy] = fling;
    if (Math.hypot(vx, vy) * scale() < 0.25) return false; // under 0.25 px/ms: a deliberate stop, not a flick
    let last = performance.now();
    const step = (now) => {
      const dt = Math.max(0, now - last); // same early-timestamp guard as animateTo
      last = Math.max(last, now);
      const decay = 0.994 ** dt;
      vx *= decay;
      vy *= decay;
      vb = clamp([vb[0] - vx * dt, vb[1] - vy * dt, vb[2], vb[3]]);
      applyView();
      if (drifted()) commitView();
      if (Math.hypot(vx, vy) * scale() > 0.02) anim = requestAnimationFrame(step);
      else {
        anim = 0;
        settleSoon();
      }
    };
    anim = requestAnimationFrame(step);
    return true;
  }
  const release = (e) => {
    const wasClick = pointers.size === 1 && moved <= 4;
    const wasDrag = pointers.size === 1 && moved > 4;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) svg.classList.remove('drag');
    // a drag or pinch moved only the compositor layer: redraw it now unless a glide carries on
    if (!pointers.size && !wasClick && !(wasDrag && e.type === 'pointerup' && glide())) settleSoon(0);
    if (wasClick && e.type === 'pointerup') {
      // the event target is the svg (pointer capture), so find the region under the pointer
      const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.dataset?.rid);
      select(hit ? hit.dataset.rid : null);
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('dblclick', (e) => {
    const [x, y] = toMap(e.clientX, e.clientY);
    zoomAt(0.45, x, y);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') select(null);
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (pan) {
      e.preventDefault();
      animateTo([vb[0] + pan[0] * vb[2] * 0.2, vb[1] + pan[1] * vb[3] * 0.2, vb[2], vb[3]], 200);
    }
    if (e.key === '+' || e.key === '=') zoomAt(0.7, ...centre());
    if (e.key === '-') zoomAt(1 / 0.7, ...centre());
  });
  const centre = () => [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2];
  $('map-in').addEventListener('click', () => zoomAt(0.55, ...centre()));
  $('map-out').addEventListener('click', () => zoomAt(1 / 0.55, ...centre()));
  $('map-fit').addEventListener('click', () => {
    sounds.play('out');
    fit(true);
  });
  const sound = $('map-sound');
  const markSound = () => {
    sound.setAttribute('aria-pressed', String(!sounds.muted));
    sound.title = sounds.muted ? 'Zoom sounds off' : 'Zoom sounds on';
    sound.querySelector('.sr').textContent = sound.title;
  };
  sound.addEventListener('click', () => {
    sounds.toggle();
    markSound();
  });
  markSound();
  buildFilters();
  applyLayers();
  new ResizeObserver(([entry]) => {
    size = { w: entry.contentRect.width || 1, h: entry.contentRect.height || 1 };
    if (geo) setView(vb);
  }).observe(svg);
  document.addEventListener('visibilitychange', kickFx);
  reduceMotion.addEventListener?.('change', kickFx);

  return {
    /** Called when the Map tab opens or closes. Polls and animates only while visible. */
    setActive(on) {
      active = on;
      clearInterval(timer);
      kickFx();
      if (!on) return;
      poll();
      timer = setInterval(() => {
        if (active && !document.hidden) poll();
      }, POLL_MS);
    },
    worldChanged() {
      zone = null;
      geo = null;
      live = null;
      puffs = [];
      emitters = {};
      select(null);
      if (active) poll();
    },
  };
}
