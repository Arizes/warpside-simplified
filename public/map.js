// Live continent map: official terrain tiles, Census hex territories, lattice, bases and fight markers.
// All text from the API is set with textContent; SVG is built with createElementNS.
const NS = 'http://www.w3.org/2000/svg';
const HALF = 4096; // continents are 8,192 m square, centred on the origin
const TILE_PX = 256;
const LODS = [2, 3, 4]; // must match the levels fetched by `npm run assets`
const S60 = Math.sqrt(3) / 2;
const NEIGHBOURS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]; // at 0°, 60°, … 300°
const FILL = { 0: '#5a5f69', 1: '#8a3ff0', 2: '#2f6fe6', 3: '#d93a30', 4: '#e6e6e6' };
const LINE = { 0: '#d4d8de', 1: '#d7b0ff', 2: '#a9c8ff', 3: '#ffaaa3' };
const FNAME = { 0: 'Unowned', 1: 'VS', 2: 'NC', 3: 'TR', 4: 'NSO' };
const MAJOR = new Set([2, 3, 4, 7]); // amp station, bio lab, tech plant, warpgate
const POLL_MS = 20000;

const svgEl = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
};
const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? 'just now' : `${m} min ago`;
};

/** Zoom sounds: decoded once on the first gesture, then played through Web Audio for low latency. */
function createSounds() {
  let ctx = null;
  const buffers = {};
  let muted = false;
  try { muted = localStorage.getItem('mapMuted') === '1'; } catch { /* storage unavailable */ }
  let last = 0;
  async function load() {
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
      try { localStorage.setItem('mapMuted', muted ? '1' : '0'); } catch { /* fine */ }
      return muted;
    },
    play(name) {
      if (muted) return;
      const now = performance.now();
      if (now - last < 140) return; // a wheel spin fires many events; one sound per gesture step
      last = now;
      load().then(() => {
        if (!buffers[name] || !ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = 0.45;
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
  const layer = {};
  for (const id of ['tiles', 'hexes', 'borders', 'links', 'heat', 'bases', 'labels']) layer[id] = svgEl('g', { class: `m-${id}` }, svg);
  const defs = svgEl('defs', {}, svg);
  svg.prepend(defs);
  const glow = svgEl('radialGradient', { id: 'm-glow' }, defs);
  svgEl('stop', { offset: '0', 'stop-color': '#ffd166', 'stop-opacity': '0.9' }, glow);
  svgEl('stop', { offset: '0.45', 'stop-color': '#ff8a1f', 'stop-opacity': '0.45' }, glow);
  svgEl('stop', { offset: '1', 'stop-color': '#ff5a00', 'stop-opacity': '0' }, glow);

  const sounds = createSounds();
  const geoCache = {}; // `${world}:${zone}` -> geometry
  let zone = null;
  let geo = null; // current geometry plus derived positions
  let live = null; // latest /api/map
  let vb = [-HALF, -HALF, 2 * HALF, 2 * HALF];
  let raf = 0;
  let timer = 0;
  let active = false;
  const tiles = new Map(); // key -> <image>
  let tilesMissing = false;
  let dataError = false;
  // One status line: a data outage wins over missing terrain, which only a developer can fix.
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
  // Hex (x, y) to map coordinates. The lattice step is fitted against real base positions because
  // continents use different hex sizes (Oshur's are smaller); screen x = world z, screen y = -world x.
  function prepare(raw) {
    const byRegion = {};
    const occupied = new Map();
    for (const [x, y, rid] of raw.hexes) {
      if (!raw.regions[rid]?.fac) continue; // filler hexes at the map edge have no base
      (byRegion[rid] ||= []).push([x, y]);
      occupied.set(`${x},${y}`, rid);
    }
    const rows = [];
    for (const [rid, hs] of Object.entries(byRegion)) {
      const r = raw.regions[rid];
      if (r.x === null || r.z === null) continue;
      rows.push([hs.reduce((a, h) => a + h[0], 0) / hs.length, hs.reduce((a, h) => a + h[1], 0) / hs.length, r.z, r.x]);
    }
    // least squares: screen = a*hx + b*hy + c, for both axes
    const solve = (k) => {
      const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const v = [0, 0, 0];
      for (const r of rows) {
        const f = [r[0], r[1], 1];
        for (let i = 0; i < 3; i++) {
          v[i] += f[i] * r[k];
          for (let j = 0; j < 3; j++) S[i][j] += f[i] * f[j];
        }
      }
      const m = S.map((row, i) => [...row, v[i]]);
      for (let i = 0; i < 3; i++) {
        const p = m[i][i] || 1e-9;
        for (let j = i; j < 4; j++) m[i][j] /= p;
        for (let q = 0; q < 3; q++) if (q !== i) {
          const f = m[q][i];
          for (let j = i; j < 4; j++) m[q][j] -= f * m[i][j];
        }
      }
      return m.map((r) => r[3]);
    };
    // Only the scale is taken from the fit: the grid is a perfect 60° lattice centred on the origin,
    // because base positions sit anywhere inside their hexes and would only add noise to an offset.
    let step = 197.2; // Indar's spacing, used when a continent has too few positioned bases
    if (rows.length >= 8) {
      const s = Math.hypot(solve(2)[0], solve(3)[0]);
      if (s > 20 && s < 2000) step = s;
    }
    const centre = (x, y) => [step * x + (step / 2) * y, -(step * S60 * y)];
    const R = step / Math.sqrt(3);
    const vertex = (cx, cy, deg) => {
      const a = (deg * Math.PI) / 180;
      return [cx + R * Math.cos(a), cy - R * Math.sin(a)];
    };
    const regions = {};
    for (const [rid, hs] of Object.entries(byRegion)) {
      let d = '';
      let border = '';
      let cxs = 0;
      let cys = 0;
      for (const [x, y] of hs) {
        const [cx, cy] = centre(x, y);
        cxs += cx;
        cys += cy;
        const pts = [0, 1, 2, 3, 4, 5].map((i) => vertex(cx, cy, 30 + 60 * i));
        d += `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`;
        NEIGHBOURS.forEach(([dx, dy], i) => {
          if (occupied.get(`${x + dx},${y + dy}`) === rid) return;
          const a = vertex(cx, cy, 60 * i - 30);
          const b = vertex(cx, cy, 60 * i + 30);
          border += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
        });
      }
      const r = raw.regions[rid];
      regions[rid] = { ...r, d, border, pos: r.x !== null && r.z !== null ? [r.z, -r.x] : [cxs / hs.length, cys / hs.length] };
    }
    const byFac = {};
    for (const [rid, r] of Object.entries(regions)) if (r.fac) byFac[r.fac] = rid;
    return { regions, byFac, links: raw.links };
  }

  function buildStatic() {
    for (const g of ['hexes', 'borders']) layer[g].replaceChildren();
    for (const [rid, r] of Object.entries(geo.regions)) {
      const p = svgEl('path', { d: r.d, 'data-rid': rid, class: 'm-region' }, layer.hexes);
      p.addEventListener('pointermove', (e) => showTip(e, rid));
      p.addEventListener('pointerleave', hideTip);
      svgEl('path', { d: r.border, class: 'm-border' }, layer.borders);
    }
  }

  /* ---------- view box, tiles, zoom ---------- */
  const scale = () => {
    const b = svg.getBoundingClientRect();
    return Math.min(b.width / vb[2], b.height / vb[3]) || 0.1; // screen px per map metre
  };
  function clampView() {
    const minW = 500;
    const maxW = 2 * HALF * 1.15;
    vb[2] = Math.min(maxW, Math.max(minW, vb[2]));
    vb[3] = vb[2] * (svg.clientHeight / Math.max(1, svg.clientWidth) || 1);
    const pad = HALF * 0.15;
    vb[0] = Math.min(HALF + pad - vb[2], Math.max(-HALF - pad, vb[0]));
    vb[1] = Math.min(HALF + pad - vb[3], Math.max(-HALF - pad, vb[1]));
  }
  function applyView() {
    clampView();
    svg.setAttribute('viewBox', vb.map((v) => v.toFixed(1)).join(' '));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      drawTiles();
      drawOverlays();
    });
  }
  function fit() {
    vb = [-HALF, -HALF, 2 * HALF, 2 * HALF];
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    const nw = Math.min(2 * HALF * 1.15, Math.max(500, vb[2] * factor));
    const f = nw / vb[2];
    if (f === 1) return;
    sounds.play(f < 1 ? 'in' : 'out');
    vb = [cx - (cx - vb[0]) * f, cy - (cy - vb[1]) * f, vb[2] * f, vb[3] * f];
    applyView();
  }
  const toMap = (clientX, clientY) => {
    const b = svg.getBoundingClientRect();
    const k = scale();
    const ox = (b.width - vb[2] * k) / 2;
    const oy = (b.height - vb[3] * k) / 2;
    return [vb[0] + (clientX - b.left - ox) / k, vb[1] + (clientY - b.top - oy) / k];
  };
  function focus(pos, width = 1800) {
    sounds.play(width < vb[2] ? 'in' : 'out');
    vb = [pos[0] - width / 2, pos[1] - width / 2, width, width];
    applyView();
  }

  function drawTiles() {
    if (!zone) return;
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
        const img = svgEl('image', { href: `/maps/${key}.png`, x: -HALF + x * size, y: -HALF + y * size, width: size + 0.5, height: size + 0.5, class: lod === LODS[0] ? 'm-tile base' : 'm-tile', preserveAspectRatio: 'none' });
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

  /* ---------- live overlays ---------- */
  const ownerOf = (rid) => live?.owners?.[rid] ?? 0;

  function paintRegions() {
    for (const p of layer.hexes.children) p.setAttribute('fill', FILL[ownerOf(p.dataset.rid)] || FILL[0]);
  }

  function drawOverlays() {
    if (!geo) return;
    const k = scale();
    const px = (n) => n / k; // screen pixels to map metres, so markers keep their size while zooming
    const zoomed = k > 0.16;
    for (const g of ['links', 'heat', 'bases', 'labels']) layer[g].replaceChildren();

    for (const [fa, fb] of geo.links) {
      const ra = geo.byFac[fa];
      const rb = geo.byFac[fb];
      if (!ra || !rb) continue;
      const a = geo.regions[ra].pos;
      const b = geo.regions[rb].pos;
      const oa = ownerOf(ra);
      const same = oa && oa === ownerOf(rb);
      svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: same ? 'm-link' : 'm-link contested', stroke: same ? LINE[oa] : LINE[0] }, layer.links);
    }

    const fights = live?.fights || [];
    const maxHeat = Math.max(1, ...fights.map((f) => f.heat));
    for (const f of fights) {
      const rid = geo.byFac[f.fac];
      if (!rid) continue;
      const [x, y] = geo.regions[rid].pos;
      const v = Math.sqrt(f.heat / maxHeat);
      const g = svgEl('g', { class: 'm-fight', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, layer.heat);
      svgEl('circle', { r: 180 + 420 * v, fill: 'url(#m-glow)', opacity: (0.35 + 0.6 * v).toFixed(2) }, g);
      // two expanding pulses, sized in screen pixels
      for (const cls of ['m-pulse', 'm-pulse late']) svgEl('circle', { r: px(14 + 10 * v), class: cls }, g);
      // faction ring: arcs proportional to who is involved
      const total = (f.factions[1] || 0) + (f.factions[2] || 0) + (f.factions[3] || 0);
      const rr = px(11 + 6 * v);
      const circ = 2 * Math.PI * rr;
      let offset = 0;
      for (const fac of [1, 2, 3]) {
        const share = total ? (f.factions[fac] || 0) / total : fac === 1 ? 1 : 0;
        if (!share) continue;
        svgEl('circle', { r: rr, class: 'm-ring', stroke: FILL[fac], 'stroke-width': px(4), 'stroke-dasharray': `${(share * circ).toFixed(2)} ${circ.toFixed(2)}`, 'stroke-dashoffset': (-offset).toFixed(2), transform: 'rotate(-90)' }, g);
        offset += share * circ;
      }
    }

    for (const [rid, r] of Object.entries(geo.regions)) {
      if (!r.fac) continue;
      const major = MAJOR.has(r.t);
      const f = ownerOf(rid);
      const [x, y] = r.pos;
      if (major) {
        const s = px(8);
        svgEl('path', { d: `M${x} ${y - s}L${x + s} ${y}L${x} ${y + s}L${x - s} ${y}Z`, class: 'm-base major', fill: FILL[f], 'stroke-width': px(1.6) }, layer.bases);
      } else {
        svgEl('circle', { cx: x, cy: y, r: px(4.5), class: 'm-base', fill: FILL[f], 'stroke-width': px(1.2) }, layer.bases);
      }
      if (!(major || zoomed)) continue;
      const t = svgEl('text', { x, y: y + px(major ? 22 : 17), class: major ? 'm-label major' : 'm-label', 'font-size': px(major ? 13 : 11), 'stroke-width': px(3) }, layer.labels);
      t.textContent = zoomed ? r.n : r.n.replace(/ (Amp Station|Tech Plant|Bio Lab)$/, '');
    }
  }

  function showTip(e, rid) {
    const r = geo?.regions[rid];
    if (!r) return;
    const f = ownerOf(rid);
    const fight = (live?.fights || []).find((x) => x.fac === r.fac);
    const lines = [el('b', { text: r.n || 'Territory' }), el('span', { class: `c${f}`, text: FNAME[f] })];
    if (fight) lines.push(el('span', { class: 'm-tip-fight', text: `Active fight · ${fight.kills} kills${fight.flips ? ' · base flipped' : ''} · ${ago(Date.now() - fight.last)}` }));
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const b = box.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - b.left + 14, b.width - 240)}px`;
    tip.style.top = `${e.clientY - b.top + 14}px`;
  }
  function hideTip() {
    tip.hidden = true;
  }

  /* ---------- side panel ---------- */
  function bar(counts) {
    const total = [1, 2, 3, 0].reduce((a, f) => a + (counts[f] || 0), 0);
    const wrap = el('div', { class: 'tbar', role: 'img', 'aria-label': [1, 2, 3].map((f) => `${FNAME[f]} ${total ? Math.round(((counts[f] || 0) / total) * 100) : 0}%`).join(', ') });
    for (const f of [1, 2, 3, 0]) {
      if (!counts[f]) continue;
      const seg = el('div', { class: `t${f}` });
      seg.style.flexGrow = String(counts[f]);
      wrap.append(seg);
    }
    return wrap;
  }
  function renderSide() {
    if (!live) return;
    $('map-zones').replaceChildren(...live.zones.map((z) => {
      const b = el('button', { type: 'button', class: 'zone', 'aria-pressed': String(z.id === zone) },
        el('span', { class: 'zname', text: z.name }),
        el('span', { class: 'zkills', text: z.kills ? `${z.kills} kills / 10 min` : z.known ? 'quiet' : 'no data' }),
        bar(z.territory));
      b.addEventListener('click', () => select(z.id));
      return b;
    }));
    const name = (fac) => {
      const rid = geo?.byFac[fac];
      return rid ? geo.regions[rid].n : `Base ${fac}`;
    };
    $('map-fights').replaceChildren(...(live.fights.length ? live.fights.slice(0, 8).map((f) => {
      const b = el('button', { type: 'button', class: 'fight' },
        el('span', { class: 'fname', text: name(f.fac) }),
        el('span', { class: 'fmeta', text: `${f.kills} kills${f.flips ? ` · ${f.flips} flip${f.flips > 1 ? 's' : ''}` : ''} · ${ago(live.now - f.last)}` }),
        bar(f.factions));
      b.addEventListener('click', () => {
        const rid = geo?.byFac[f.fac];
        if (rid) focus(geo.regions[rid].pos);
      });
      return b;
    }) : [el('p', { class: 'empty', text: 'No fights detected on this continent in the last 10 minutes.' })]));
    $('map-captures').replaceChildren(...(live.captures.length ? live.captures.map((c) => el('li', {},
      el('span', { class: 'ctime', text: new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
      emblem(c.to, 18),
      el('span', { class: `c${c.to}`, text: name(c.fac) }),
      el('span', { class: 'sub', text: `from ${FNAME[c.from]}` }))) : [el('li', { class: 'empty', text: 'No bases have changed hands here in the last 30 minutes.' })]));
    const zk = live.zoneKills;
    $('map-title').textContent = `${live.zones.find((z) => z.id === zone)?.name || 'Map'}`;
    $('map-sub').textContent = zk.total ? `${zk.total} kills in the last 10 minutes · VS ${zk[1]} · NC ${zk[2]} · TR ${zk[3]}` : 'No kills in the last 10 minutes';
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
      const first = zone === null;
      zone = data.zone;
      live = data;
      if (first || !geo) {
        for (const img of tiles.values()) img.remove();
        tiles.clear();
        await loadGeometry();
        fit();
      }
      paintRegions();
      drawOverlays();
      renderSide();
      dataError = false;
      setStatus();
    } catch {
      dataError = true;
      setStatus();
      onError?.();
    }
  }
  async function select(z) {
    if (z === zone) return;
    zone = z;
    geo = null;
    live = null;
    for (const img of tiles.values()) img.remove();
    tiles.clear();
    for (const g of ['hexes', 'borders', 'links', 'heat', 'bases', 'labels']) layer[g].replaceChildren();
    await poll();
  }

  /* ---------- input ---------- */
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = toMap(e.clientX, e.clientY);
    zoomAt(e.deltaY > 0 ? 1.25 : 0.8, x, y);
  }, { passive: false });
  const pointers = new Map();
  let pinch = 0;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    svg.classList.add('drag');
  });
  svg.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) {
        const [x, y] = toMap((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        zoomAt(pinch / d, x, y);
      }
      pinch = d;
      return;
    }
    const k = scale();
    vb[0] -= (e.clientX - prev[0]) / k;
    vb[1] -= (e.clientY - prev[1]) / k;
    hideTip();
    applyView();
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (!pointers.size) svg.classList.remove('drag');
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  svg.addEventListener('dblclick', (e) => {
    const [x, y] = toMap(e.clientX, e.clientY);
    zoomAt(0.5, x, y);
  });
  const centre = () => [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2];
  $('map-in').addEventListener('click', () => zoomAt(0.6, ...centre()));
  $('map-out').addEventListener('click', () => zoomAt(1 / 0.6, ...centre()));
  $('map-fit').addEventListener('click', () => {
    sounds.play('out');
    fit();
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
  new ResizeObserver(() => geo && applyView()).observe(svg);

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
      if (active) poll();
    },
  };
}
