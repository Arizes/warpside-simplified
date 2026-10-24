// Live continent map in the style of the in-game map: official terrain tiles, Census hex territories,
// lattice, base icons, combat clouds and a region card. All text from the API is set with textContent.
// Hex geometry adapted from Honu (https://github.com/varunda/honu, MIT, src/map/LedgerModels.ts).
const NS = 'http://www.w3.org/2000/svg';
const HALF = 4096; // continents are 8,192 m square, centred on the origin
const TILE_PX = 256;
const LODS = [2, 3, 4]; // must match the levels fetched by `npm run assets`
const HEX_W = 200; // hex width in metres (Honu: 50/8 map units, 32 m per unit)
const HEX_C = HEX_W / Math.sqrt(3); // centre to corner
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
const LAYERS = [
  ['terrain', 'Terrain'], ['owner', 'Territory'], ['outline', 'Region borders'], ['grid', 'Hex grid'],
  ['lattice', 'Lattice'], ['bases', 'Bases'], ['names', 'Names'], ['battles', 'Battles'], ['population', 'Players seen'],
];
const POLL_MS = 20000;

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
  const box = $('map-box');
  const tip = $('map-tip');
  const defs = svgEl('defs', {}, svg);
  const cloud = svgEl('radialGradient', { id: 'm-cloud' }, defs);
  svgEl('stop', { offset: '0', 'stop-color': '#ffe08a', 'stop-opacity': '0.95' }, cloud);
  svgEl('stop', { offset: '0.35', 'stop-color': '#ff9a2e', 'stop-opacity': '0.7' }, cloud);
  svgEl('stop', { offset: '0.7', 'stop-color': '#ff5a0a', 'stop-opacity': '0.25' }, cloud);
  svgEl('stop', { offset: '1', 'stop-color': '#ff3d00', 'stop-opacity': '0' }, cloud);
  const layer = {};
  for (const id of ['tiles', 'regions', 'grid', 'borders', 'selected', 'lattice', 'clouds', 'bases', 'labels']) layer[id] = svgEl('g', { class: `m-${id}` }, svg);

  const sounds = createSounds();
  const layers = { ...Object.fromEntries(LAYERS.map(([k]) => [k, k !== 'grid'])), ...load('mapLayers', {}) };
  const geoCache = {}; // `${world}:${zone}` -> prepared geometry
  const tiles = new Map(); // key -> <image>
  let zone = null;
  let geo = null;
  let live = null;
  let prevOwners = {};
  let selected = null; // region id
  let vb = [-HALF, -HALF, 2 * HALF, 2 * HALF];
  let anim = 0;
  let raf = 0;
  let timer = 0;
  let active = false;
  let tilesMissing = false;
  let dataError = false;

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
    let grid = '';
    const f1 = (v) => v.toFixed(1);
    for (const [rid, hs] of Object.entries(byRegion)) {
      let d = '';
      let border = '';
      let sx = 0;
      let sy = 0;
      for (const [x, y] of hs) {
        const [cx, cy] = centre(x, y);
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
    return { regions, byFac, links: raw.links, grid };
  }

  function buildStatic() {
    for (const g of ['regions', 'grid', 'borders', 'selected']) layer[g].replaceChildren();
    for (const [rid, r] of Object.entries(geo.regions)) {
      const p = svgEl('path', { d: r.d, 'data-rid': rid, class: 'm-region o0' }, layer.regions);
      p.addEventListener('pointermove', (e) => showTip(e, rid));
      p.addEventListener('pointerleave', hideTip);
      svgEl('path', { d: r.border, class: 'm-border' }, layer.borders);
    }
    svgEl('path', { d: geo.grid, class: 'm-gridline' }, layer.grid);
  }

  /* ---------- view: tiles, zoom, smooth animation ---------- */
  const scale = () => {
    const b = svg.getBoundingClientRect();
    return Math.min(b.width / vb[2], b.height / vb[3]) || 0.1; // screen px per map metre
  };
  function clamp(v) {
    const out = [...v];
    out[2] = Math.min(2 * HALF * 1.15, Math.max(450, out[2]));
    out[3] = out[2] * (svg.clientHeight / Math.max(1, svg.clientWidth) || 1);
    const pad = HALF * 0.15;
    out[0] = Math.min(HALF + pad - out[2], Math.max(-HALF - pad, out[0]));
    out[1] = Math.min(HALF + pad - out[3], Math.max(-HALF - pad, out[1]));
    return out;
  }
  function render() {
    svg.setAttribute('viewBox', vb.map((v) => v.toFixed(1)).join(' '));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      drawTiles();
      drawOverlays();
    });
  }
  function setView(v) {
    cancelAnimationFrame(anim);
    vb = clamp(v);
    render();
  }
  /** Eases the view box to a target, like the in-game map's zoom. */
  function animateTo(target, ms = 280) {
    cancelAnimationFrame(anim);
    const from = [...vb];
    const to = clamp(target);
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / ms);
      const e = easeOut(p);
      vb = from.map((v, i) => v + (to[i] - v) * e);
      svg.setAttribute('viewBox', vb.map((v) => v.toFixed(1)).join(' '));
      drawOverlays();
      if (p < 1) anim = requestAnimationFrame(step);
      else render();
    };
    anim = requestAnimationFrame(step);
  }
  let target = null; // where wheel zooming is heading, so fast scrolling stays smooth
  function zoomAt(factor, cx, cy, smooth = true) {
    const base = target && anim ? target : vb;
    const nw = Math.min(2 * HALF * 1.15, Math.max(450, base[2] * factor));
    const f = nw / base[2];
    if (Math.abs(f - 1) < 1e-3) return;
    sounds.play(f < 1 ? 'in' : 'out');
    target = [cx - (cx - base[0]) * f, cy - (cy - base[1]) * f, base[2] * f, base[3] * f];
    if (smooth) animateTo(target, 220);
    else setView(target);
  }
  const fit = (smooth = false) => (smooth ? animateTo([-HALF, -HALF, 2 * HALF, 2 * HALF]) : setView([-HALF, -HALF, 2 * HALF, 2 * HALF]));
  const toMap = (clientX, clientY) => {
    const b = svg.getBoundingClientRect();
    const k = scale();
    const ox = (b.width - vb[2] * k) / 2;
    const oy = (b.height - vb[3] * k) / 2;
    return [vb[0] + (clientX - b.left - ox) / k, vb[1] + (clientY - b.top - oy) / k];
  };
  function focus(pos, width = 1600) {
    sounds.play(width < vb[2] ? 'in' : 'out');
    animateTo([pos[0] - width / 2, pos[1] - width / 2, width, width], 420);
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

  /* ---------- live overlays ---------- */
  const ownerOf = (rid) => live?.owners?.[rid] ?? 0;
  const fightAt = (fac) => (live?.fights || []).find((f) => f.fac === fac);

  function paintRegions() {
    for (const p of layer.regions.children) {
      const rid = p.dataset.rid;
      const o = ownerOf(rid);
      p.setAttribute('class', `m-region o${o >= 1 && o <= 4 ? o : 0}`);
      // a territory change since the last update briefly flashes, like a capture on the in-game map
      if (prevOwners[rid] !== undefined && prevOwners[rid] !== o) {
        p.classList.add('flash');
        setTimeout(() => p.classList.remove('flash'), 2600);
      }
    }
    prevOwners = { ...(live?.owners || {}) };
  }

  function drawOverlays() {
    if (!geo) return;
    const k = scale();
    const px = (n) => n / k; // screen pixels to metres, so markers keep their size while zooming
    const detail = k > 0.13; // zoomed in far enough for every base name
    for (const g of ['lattice', 'clouds', 'bases', 'labels']) layer[g].replaceChildren();

    if (layers.lattice) {
      for (const [fa, fb] of geo.links) {
        const ra = geo.byFac[fa];
        const rb = geo.byFac[fb];
        if (!ra || !rb) continue;
        const a = geo.regions[ra].pos;
        const b = geo.regions[rb].pos;
        const oa = ownerOf(ra);
        const ob = ownerOf(rb);
        const owned = (o) => o >= 1 && o <= 3;
        // a front line is a link between two different empires; links touching locked or unowned land stay grey
        const cls = owned(oa) && oa === ob ? `l${oa}` : owned(oa) && owned(ob) ? 'front' : 'l0';
        svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: `m-link ${cls}` }, layer.lattice);
      }
    }

    const fights = live?.fights || [];
    if (layers.battles) {
      const maxHeat = Math.max(1, ...fights.map((f) => f.heat));
      for (const f of fights) {
        const rid = geo.byFac[f.fac];
        if (!rid) continue;
        const [x, y] = geo.regions[rid].pos;
        const v = Math.sqrt(f.heat / maxHeat);
        const g = svgEl('g', { class: 'm-fight', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, layer.clouds);
        // a combat cloud sized in metres, so it reads as an area on the map like the in-game hotspots
        svgEl('circle', { r: 160 + 340 * v, fill: 'url(#m-cloud)', class: 'm-cloud' }, g);
        svgEl('circle', { r: 90 + 180 * v, fill: 'url(#m-cloud)', class: 'm-cloud core', cx: 40 * v, cy: -30 * v }, g);
        for (const cls of ['m-pulse', 'm-pulse late']) svgEl('circle', { r: px(16 + 8 * v), class: cls }, g);
      }
    }

    for (const [rid, r] of Object.entries(geo.regions)) {
      if (!r.fac) continue;
      const major = MAJOR.has(r.t);
      const [x, y] = r.pos;
      const o = ownerOf(rid);
      const fight = layers.battles ? fightAt(r.fac) : null;
      if (layers.bases) {
        const s = px(major ? 11 : 7.5) * (detail ? 1.1 : 1);
        const g = svgEl('g', { class: `m-base o${o}${fight ? ' hot' : ''}${rid === selected ? ' sel' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, layer.bases);
        svgEl('circle', { r: s, class: 'badge' }, g);
        const glyph = GLYPH[r.t] || DEFAULT_GLYPH;
        svgEl('path', { d: glyph, class: STROKED.has(r.t) ? 'glyph stroked' : 'glyph', transform: `scale(${s.toFixed(2)})` }, g);
        if (fight) {
          // ring split by how much each empire is involved
          const total = f3(fight.factions);
          const rr = s + px(4);
          const circ = 2 * Math.PI * rr;
          let offset = 0;
          for (const fac of [1, 2, 3]) {
            const share = total ? (fight.factions[fac] || 0) / total : 0;
            if (!share) continue;
            svgEl('circle', { r: rr, class: `m-ring l${fac}`, 'stroke-width': px(3), 'stroke-dasharray': `${(share * circ).toFixed(2)} ${circ.toFixed(2)}`, 'stroke-dashoffset': (-offset).toFixed(2), transform: 'rotate(-90)' }, g);
            offset += share * circ;
          }
        }
      }
      const showName = layers.names && (major || detail || rid === selected);
      if (showName) {
        const t = svgEl('text', { x, y: y + px(major ? 25 : 19), class: major ? 'm-label major' : 'm-label', 'font-size': px(major ? 13 : 11.5), 'stroke-width': px(3.2) }, layer.labels);
        t.textContent = r.n;
      }
      if (layers.population && fight?.seenTotal) {
        const ty = y - px(major ? 22 : 17);
        const label = `${fight.seenTotal}+ seen`; // a floor, not a range: the real number is unknown
        const w = px(label.length * 6.3 + 10);
        svgEl('rect', { x: x - w / 2, y: ty - px(9), width: w, height: px(15), rx: px(2), class: 'm-pop' }, layer.labels);
        const t = svgEl('text', { x, y: ty + px(2.5), class: 'm-pop-text', 'font-size': px(10.5) }, layer.labels);
        t.textContent = label;
      }
    }
  }
  const f3 = (f) => (f[1] || 0) + (f[2] || 0) + (f[3] || 0);

  /* ---------- selection and region card ---------- */
  function select(rid, { fly = false } = {}) {
    selected = rid;
    layer.selected.replaceChildren();
    if (!rid || !geo?.regions[rid]) {
      selected = null;
      $('map-card').hidden = true;
      drawOverlays();
      return;
    }
    const r = geo.regions[rid];
    svgEl('path', { d: r.border, class: 'm-select-glow' }, layer.selected);
    svgEl('path', { d: r.border, class: 'm-select' }, layer.selected);
    if (fly) focus(r.pos, Math.min(vb[2], 2400));
    renderCard();
    drawOverlays();
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
    rows.push(el('div', { class: 'rc-head' },
      el('div', {}, el('p', { class: 'eyebrow', text: TYPE[r.t] || 'Facility' }), el('h3', { text: r.n || 'Territory' })),
      el('button', { type: 'button', class: 'close', 'aria-label': 'Close region details', id: 'map-card-close', text: '×' })));
    rows.push(el('div', { class: 'rc-owner' }, o >= 1 && o <= 3 ? emblem(o, 26) : null,
      el('div', {}, el('span', { class: 'rc-label', text: 'Controlled by' }), el('b', { class: `c${o}`, text: o ? FNAME[o] || 'Unknown' : 'Nobody (unowned or locked)' }))));
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
        el('span', { class: 'ctime', text: new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
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
    const lines = [el('b', { text: r.n || 'Territory' }), el('span', { class: `c${o}`, text: `${TYPE[r.t] || 'Facility'} · ${o ? FTAG[o] : 'Unowned'}` })];
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
    $('map-hud').replaceChildren(
      el('h2', { text: z?.name || 'Map' }),
      el('div', { class: 'hud-terr' }, el('span', { class: 'rc-label', text: 'Territory' }),
        ...[1, 2, 3].map((f) => el('span', { class: 'hud-f' }, emblem(f, 18), el('b', { class: `c${f}`, text: total ? `${Math.round(((t[f] || 0) / total) * 100)}%` : '–' })))));
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
      el('span', { class: 'ctime', text: new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
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
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      $('map-filters-list').hidden = !open;
    });
  }
  function applyLayers() {
    for (const [key] of LAYERS) svg.classList.toggle(`no-${key}`, !layers[key]);
    if (layers.terrain) drawTiles();
    else clearTiles();
    drawOverlays();
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
      drawOverlays();
      renderHud();
      renderSide();
      if (selected) renderCard();
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
    select(null);
    clearTiles();
    for (const g of ['regions', 'grid', 'borders', 'selected', 'lattice', 'clouds', 'bases', 'labels']) layer[g].replaceChildren();
    await poll();
  }

  /* ---------- input ---------- */
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = toMap(e.clientX, e.clientY);
    zoomAt(e.deltaY > 0 ? 1.3 : 1 / 1.3, x, y);
  }, { passive: false });
  const pointers = new Map();
  let pinch = 0;
  let moved = 0;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    cancelAnimationFrame(anim);
    target = null;
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
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
      return;
    }
    const k = scale();
    hideTip();
    setView([vb[0] - (e.clientX - prev[0]) / k, vb[1] - (e.clientY - prev[1]) / k, vb[2], vb[3]]);
  });
  const release = (e) => {
    const wasClick = pointers.size === 1 && moved <= 4;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) svg.classList.remove('drag');
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
  new ResizeObserver(() => geo && setView(vb)).observe(svg);

  return {
    /** Called when the Map tab opens or closes. Polls only while visible. */
    setActive(on) {
      active = on;
      clearInterval(timer);
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
      select(null);
      if (active) poll();
    },
  };
}
