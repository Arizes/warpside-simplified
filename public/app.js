// Dashboard client. Every string from the API (character names, outfits) is untrusted,
// so nodes are built with textContent only: no innerHTML anywhere.
import { apiBase } from './api-base.js';
import { createMap } from './map.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const CENSUS = 'https://census.daybreakgames.com'; // images load straight from Census
const EMBLEM = { 1: '94', 2: '12', 3: '18', 4: '93615' };
const TAG = { 1: 'VS', 2: 'NC', 3: 'TR', 4: 'NSO' };
const EMPIRE = { 1: 'Vanu Sovereignty', 2: 'New Conglomerate', 3: 'Terran Republic' };
const TABS = ['live', 'players', 'map'];
const TITLES = { live: 'Live leaderboard', players: 'Top players', map: 'Live map' };
const POLL_MS = 30000; // every poll is a Worker request, and the free plan allows 100k a day

const view = {
  tab: 'live',
  world: Number(safeGet('world')) || 1000,
  win: safeGet('window') || '24h',
  range: safeGet('range') || '2h',
  data: null,
  pop: null,
  players: { empire: 0, q: '', sort: { key: 'k', dir: -1 } },
  outfits: { empire: 0, q: '', sort: { key: 'k', dir: -1 } },
};
let timer;
let map = null;

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable: fine */ }
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}
const num = (n) => Number(n).toLocaleString('en-US');
const kd = (r) => (r.d ? r.k / r.d : r.k);
const kdText = (r) => kd(r).toFixed(2);
const clock = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const emblem = (f, size = 22) => el('img', { src: `${CENSUS}/files/ps2/images/static/${EMBLEM[f] || EMBLEM[4]}.png`, alt: TAG[f] || '', width: size, height: size, loading: 'lazy' });
const weaponCell = (name, img) => el('span', { class: 'wep' }, img ? el('img', { src: CENSUS + img, alt: '', loading: 'lazy' }) : null, el('span', { text: name }));

const API = apiBase(location.hostname, document.querySelector('meta[name="api-base"]')?.content);

async function api(path) {
  const r = await fetch(API + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- generic sortable table ---------- */
function buildTable({ cols, rows, sort, onSort, onRow, empty }) {
  if (!rows.length) return el('p', { class: 'empty', text: empty });
  const head = el('tr', {}, ...cols.map((c) => {
    const th = el('th', { scope: 'col', class: c.n ? 'n' : '' });
    if (c.sort && onSort) {
      th.setAttribute('aria-sort', sort.key === c.sort ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none');
      const b = el('button', { type: 'button', class: 'sortbtn', text: c.label });
      b.addEventListener('click', () => onSort(c.sort));
      th.append(b);
    } else {
      th.textContent = c.label;
    }
    return th;
  }));
  const body = rows.map((r, i) => {
    const tr = el('tr', onRow ? { tabindex: '0' } : {}, ...cols.map((c) => el('td', { class: c.n ? 'n' : c.cls || '' }, c.cell(r, i))));
    if (onRow) {
      tr.addEventListener('click', () => onRow(r));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } });
    }
    return tr;
  });
  return el('table', {}, el('thead', {}, head), el('tbody', {}, ...body));
}

const SORTERS = { k: (r) => r.k, d: (r) => r.d, kd, kpm: (r) => r.kpm, members: (r) => r.members, perMember: (r) => r.k / r.members };
function sorted(rows, sort) {
  const get = SORTERS[sort.key] || SORTERS.k;
  return [...rows].sort((a, b) => (get(b) - get(a)) * -sort.dir);
}
function toggleSort(state, key, rerender) {
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: -1 };
  rerender();
}

const who = (p) => el('span', { class: 'who' }, emblem(p.faction), p.online ? el('span', { class: 'on', title: 'Online' }) : null,
  el('span', { class: `c${p.faction}`, text: p.name }), p.tag ? el('span', { class: 'tag', text: `[${p.tag}]` }) : null);
const outfitCell = (o) => el('span', { class: 'who' }, emblem(o.faction), el('span', { class: `c${o.faction}`, text: o.tag ? `[${o.tag}] ${o.name}` : o.name }));

/* ---------- live tab: three empire columns ---------- */
function miniPlayers(list) {
  return buildTable({
    cols: [
      { label: '#', cls: 'rank', cell: (_, i) => String(i + 1) },
      { label: 'Player', cell: (p) => el('span', { class: 'who' }, p.online ? el('span', { class: 'on', title: 'Online' }) : null, el('span', { class: `c${p.faction}`, text: p.name }), p.tag ? el('span', { class: 'tag', text: `[${p.tag}]` }) : null) },
      { label: 'Kills', n: true, cell: (p) => num(p.k) },
      { label: 'KPM', n: true, cell: (p) => p.kpm.toFixed(2) },
      { label: 'Deaths', n: true, cell: (p) => num(p.d) },
      { label: 'K/D', n: true, cell: kdText },
    ],
    rows: list,
    onRow: (p) => openPlayer(p.id),
    empty: 'No kills recorded for this empire yet.',
  });
}
function renderLive(s = view.data) {
  const total = s.factions.reduce((a, f) => a + f.k, 0);
  $('empires').replaceChildren(...[1, 2, 3].map((f) => {
    const tot = s.factions.find((x) => x.f === f);
    const share = total ? ((tot.k / total) * 100).toFixed(1) : '0.0';
    const top = s.byFaction[f].players.slice(0, 10);
    return el('section', { class: `empire f${f}`, 'aria-label': EMPIRE[f] },
      el('header', { class: 'ehead' }, emblem(f, 30), el('h2', { text: EMPIRE[f] }), el('span', { class: 'share', text: `${share}%` })),
      el('h3', { text: 'Top players' }),
      el('div', { class: 'scroll' }, miniPlayers(top)),
      el('p', { class: 'totals' }, el('span', { text: 'Empire total' }), el('span', { text: `${num(tot.k)} kills` }), el('span', { text: `${num(tot.d)} deaths` }), el('span', { text: `K/D ${kdText(tot)}` })));
  }));
  const bar = el('div', { class: 'fbar' });
  for (const f of s.factions) {
    const pct = total ? (f.k / total) * 100 : 33.3;
    const seg = el('div', { class: `f${f.f}`, text: total ? `${Math.round(pct)}%` : '' });
    seg.style.flexGrow = String(Math.max(pct, 0.5));
    bar.append(seg);
  }
  $('factions').replaceChildren(bar, el('div', { class: 'flegend' }, ...s.factions.map((f) =>
    el('span', {}, emblem(f.f), el('b', { class: `c${f.f}`, text: TAG[f.f] }), `${num(f.k)} kills`))));
  drawPopulation();
}

/* ---------- players tab and the outfit viewer ---------- */
function chips(container, state, rerender) {
  const items = [[0, 'All empires'], [1, 'VS'], [2, 'NC'], [3, 'TR']];
  container.replaceChildren(...items.map(([f, label]) => {
    const b = el('button', { type: 'button', class: `chip${f ? ` f${f}` : ''}`, text: label, 'aria-pressed': String(state.empire === f) });
    b.addEventListener('click', () => { state.empire = f; rerender(); });
    return b;
  }));
}
function renderPlayers() {
  const s = view.data;
  const st = view.players;
  chips($('players-chips'), st, renderPlayers);
  const q = st.q.toLowerCase();
  const base = st.empire ? s.byFaction[st.empire].players : s.players;
  const rows = sorted(base.filter((p) => !q || p.name.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q) || p.outfit.toLowerCase().includes(q)), st.sort);
  $('players-table').replaceChildren(buildTable({
    cols: [
      { label: '#', cls: 'rank', cell: (_, i) => String(i + 1) },
      { label: 'Player', cell: who },
      { label: 'Kills', n: true, sort: 'k', cell: (p) => num(p.k) },
      { label: 'Deaths', n: true, sort: 'd', cell: (p) => num(p.d) },
      { label: 'K/D', n: true, sort: 'kd', cell: kdText },
      { label: 'KPM', n: true, sort: 'kpm', cell: (p) => p.kpm.toFixed(2) },
      { label: 'Top weapon', cell: (p) => weaponCell(p.weapon, p.weaponImg) },
    ],
    rows, sort: st.sort, onSort: (k) => toggleSort(st, k, renderPlayers), onRow: (p) => openPlayer(p.id),
    empty: q ? 'No players match that filter.' : 'No kills recorded yet. The board fills in as the servers play.',
  }));
}
function renderOutfits() {
  const s = view.data;
  const st = view.outfits;
  chips($('outfits-chips'), st, renderOutfits);
  const q = st.q.toLowerCase();
  const base = st.empire ? s.byFaction[st.empire].outfits : s.outfits;
  const rows = sorted(base.filter((o) => !q || o.name.toLowerCase().includes(q) || o.tag.toLowerCase().includes(q)), st.sort);
  $('outfits-table').replaceChildren(buildTable({
    cols: [
      { label: '#', cls: 'rank', cell: (_, i) => String(i + 1) },
      { label: 'Outfit', cell: outfitCell },
      { label: 'Kills', n: true, sort: 'k', cell: (o) => num(o.k) },
      { label: 'Deaths', n: true, sort: 'd', cell: (o) => num(o.d) },
      { label: 'K/D', n: true, sort: 'kd', cell: kdText },
      { label: 'Members', n: true, sort: 'members', cell: (o) => String(o.members) },
      { label: 'Kills / member', n: true, sort: 'perMember', cell: (o) => (o.k / o.members).toFixed(1) },
    ],
    rows, sort: st.sort, onSort: (k) => toggleSort(st, k, renderOutfits),
    empty: q ? 'No outfits match that filter.' : 'Outfits need at least two active members to rank.',
  }));
}
const RENDER = {
  live: () => {
    renderLive();
    renderOutfits();
  },
  players: renderPlayers,
  map: () => {}, // the map polls its own endpoint while visible
};

/* ---------- population chart ---------- */
const LINES = [['vs', 1], ['nc', 2], ['tr', 3], ['ns', 4]];
const RANGES = { '2h': 'last 2 hours', '6h': 'last 6 hours', '24h': 'last 24 hours', '7d': 'last 7 days' };
const sumOf = (p) => p.vs + p.nc + p.tr + p.ns;
// Clock times are shown on a 12-hour clock everywhere, whatever the viewer's locale defaults to.
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
const dayHour = (t) => `${new Date(t).toLocaleDateString([], { weekday: 'short' })} ${hhmm(t)}`;
// The viewer's own zone, named, so a point on the line is never ambiguous.
const stamp = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });

/** Smallest round number at or above `v`, so the grid lands on readable values. */
function niceTop(v) {
  const m = Math.max(4, v);
  const p = 10 ** Math.floor(Math.log10(m));
  return [1, 1.5, 2, 2.5, 5, 10].find((x) => m <= x * p) * p;
}
function svgEl(tag, props) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(props)) n.setAttribute(k, String(v));
  return n;
}
/** The live counts, as buttons: each one opens the list of who is online. */
function popLegend(sample) {
  const chip = (empire, label, value, cls) => {
    const b = el('button', { type: 'button', class: `popchip ${cls}`, title: empire ? `Who is online on ${EMPIRE[empire] || 'Nanite Systems'}` : 'Who is online' },
      el('i', {}), el('b', { text: num(value) }), el('span', { text: label }));
    b.addEventListener('click', () => openOnline(empire));
    return b;
  };
  $('pop-legend').replaceChildren(
    chip(0, 'online', sumOf(sample), 'all'),
    ...LINES.map(([key, f]) => chip(f, TAG[f], sample[key], `pop-${key}`)),
  );
}
function drawPopulation(target = $('chart'), series = view.pop) {
  $('pop-note').textContent = RANGES[view.range];
  if (!series?.length) {
    target.replaceChildren(el('p', { class: 'empty', text: 'No population recorded for this range yet. The line fills in a point a minute.' }));
    popLegend({ vs: 0, nc: 0, tr: 0, ns: 0 });
    return;
  }
  popLegend(series.at(-1));
  const W = Math.max(320, Math.round(target.clientWidth) || 720);
  const H = 190, padL = 36, padR = 6, padT = 10, padB = 20;
  const top = niceTop(Math.max(...series.flatMap((p) => LINES.map(([k]) => p[k]))));
  const x = (i) => padL + ((W - padL - padR) * i) / Math.max(1, series.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  svg.setAttribute('aria-label', `Players online per empire, ${RANGES[view.range]}, peak ${num(top)} on a single empire`);
  for (const v of [0, top / 2, top]) {
    svg.append(svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const label = svgEl('text', { class: 'ylab', x: padL - 7, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = num(Math.round(v));
    svg.append(label);
  }
  const at = series.at(-1).t - series[0].t > 36 * 3600e3 ? dayHour : hhmm;
  const stride = Math.ceil(series.length / 6);
  series.forEach((p, i) => {
    if (i % stride || i > series.length - stride / 2) return;
    // The first label would hang off the left edge if it were centred on its point.
    const t = svgEl('text', { class: 'xlab', x: i ? x(i) : padL, y: H - 5, 'text-anchor': i ? 'middle' : 'start' });
    t.textContent = at(p.t);
    svg.append(t);
  });
  for (const [key, f] of LINES) {
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    const path = svgEl('path', { class: `line pop-${key}`, d, 'vector-effect': 'non-scaling-stroke' });
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `${TAG[f]} · now ${num(series.at(-1)[key])}, peak ${num(Math.max(...series.map((p) => p[key])))}`;
    path.append(title);
    svg.append(path);
  }

  // Hover readout: a guide line, a dot per empire and a tooltip with the full local timestamp.
  const tip = $('pop-tip');
  const guide = svgEl('line', { class: 'guide', x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: 'hidden' });
  const dots = LINES.map(([key]) => svgEl('circle', { class: `dot pop-${key}`, r: 3.2, cx: 0, cy: 0, visibility: 'hidden' }));
  svg.append(guide, ...dots);
  const hide = () => {
    guide.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const i = Math.min(series.length - 1, Math.max(0, Math.round((((ev.clientX - box.left) / box.width) * W - padL) / ((W - padL - padR) / Math.max(1, series.length - 1)))));
    const p = series[i];
    guide.setAttribute('x1', String(x(i)));
    guide.setAttribute('x2', String(x(i)));
    guide.setAttribute('visibility', 'visible');
    dots.forEach((dot, n) => {
      dot.setAttribute('cx', String(x(i)));
      dot.setAttribute('cy', String(y(p[LINES[n][0]])));
      dot.setAttribute('visibility', 'visible');
    });
    tip.replaceChildren(
      el('p', { class: 'when', text: stamp(p.t) }),
      ...LINES.map(([key, f]) => el('p', { class: `row pop-${key}` }, el('i', {}), el('span', { text: TAG[f] }), el('b', { text: num(p[key]) }))),
      el('p', { class: 'row all' }, el('span', { text: 'All' }), el('b', { text: num(sumOf(p)) })),
    );
    tip.hidden = false;
    const wrap = target.parentElement.getBoundingClientRect();
    const left = ev.clientX - wrap.left + 16;
    const top_ = ev.clientY - wrap.top - tip.offsetHeight - 12;
    tip.style.left = `${Math.max(0, Math.min(left, wrap.width - tip.offsetWidth))}px`;
    tip.style.top = `${Math.max(0, top_ < 0 ? ev.clientY - wrap.top + 18 : top_)}px`;
  });
  svg.addEventListener('pointerleave', hide);
  target.replaceChildren(svg);
  hide();
}

/* ---------- chart ---------- */
function drawChart(target, buckets) {
  const W = 720, H = target.classList.contains('small') ? 90 : 150, pad = 18;
  const max = Math.max(1, ...buckets.map((b) => b.kills));
  const bw = W / buckets.length;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Kills per hour, peak ${num(max)}`);
  buckets.forEach((b, i) => {
    const h = (b.kills / max) * (H - pad - 4);
    const r = document.createElementNS(SVG, 'rect');
    r.setAttribute('x', String(i * bw + 1.5));
    r.setAttribute('y', String(H - pad - h));
    r.setAttribute('width', String(Math.max(1, bw - 3)));
    r.setAttribute('height', String(h));
    const t = document.createElementNS(SVG, 'title');
    t.textContent = `${hhmm(b.t)} · ${num(b.kills)} kills`;
    r.append(t);
    svg.append(r);
  });
  const base = document.createElementNS(SVG, 'line');
  for (const [k, v] of Object.entries({ x1: 0, x2: W, y1: H - pad, y2: H - pad })) base.setAttribute(k, String(v));
  svg.append(base);
  const stride = buckets.length > 12 ? 4 : 2;
  buckets.forEach((b, i) => {
    if (i % stride) return;
    const t = document.createElementNS(SVG, 'text');
    t.setAttribute('x', String(i * bw + bw / 2));
    t.setAttribute('y', String(H - 3));
    t.setAttribute('text-anchor', 'middle');
    t.textContent = new Date(b.t).toLocaleTimeString([], { hour: 'numeric', hour12: true });
    svg.append(t);
  });
  target.replaceChildren(svg);
}

/* ---------- shell: data, tabs, controls ---------- */
function renderSummary(s) {
  $('server-line').textContent = `${s.server} · last ${view.win.toUpperCase()}`;
  $('t-kills').textContent = num(s.factions.reduce((a, f) => a + f.k, 0));
  $('t-players').textContent = num(s.activePlayers);
  $('t-since').textContent = clock(s.now - Math.max(s.trackedSince, s.since));
  const live = s.stream === 'connected' && s.feedOnline !== false;
  $('status').className = `pill ${live ? 'live' : 'down'}`;
  $('status').lastElementChild.textContent = live ? 'Live' : s.stream === 'connected' ? 'Daybreak feed offline' : 'Reconnecting';
}
// The chart is drawn at the panel's pixel width, so redraw it once a resize settles.
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (view.tab === 'live' && view.pop) drawPopulation();
  }, 150);
});
function show(tab) {
  view.tab = TABS.includes(tab) ? tab : 'live';
  for (const t of TABS) {
    $(`view-${t}`).hidden = t !== view.tab;
    const b = $(`tab-${t}`);
    b.setAttribute('aria-selected', String(t === view.tab));
    b.tabIndex = t === view.tab ? 0 : -1;
  }
  $('view-title').textContent = TITLES[view.tab];
  document.body.dataset.tab = view.tab;
  map?.setActive(view.tab === 'map');
  if (view.data) RENDER[view.tab]();
}
function setAlert(msg) {
  $('alert').hidden = !msg;
  $('alert').textContent = msg || '';
}
/** The population series for the chosen range. Kept apart from the board so the two ranges differ. */
async function loadPopulation(redraw = true) {
  try {
    const r = await api(`/api/population?world=${view.world}&range=${view.range}`);
    view.pop = r.points;
  } catch {
    return; // the board's own call reports an outage; keep showing the last line
  }
  if (redraw && view.tab === 'live') drawPopulation();
}

async function load() {
  let data;
  try {
    [data] = await Promise.all([api(`/api/stats?world=${view.world}&window=${view.win}`), loadPopulation(false)]);
  } catch {
    $('status').className = 'pill down';
    $('status').lastElementChild.textContent = 'Tracker unreachable';
    setAlert(view.data ? 'Could not refresh. Showing the last data received; retrying every 30 seconds.' : 'Could not reach the tracker. Retrying every 30 seconds.');
    return;
  }
  view.data = data;
  setAlert('');
  document.body.classList.remove('loading');
  try {
    renderSummary(data);
    RENDER[view.tab]();
  } catch (err) {
    console.error('render failed', err); // a bug in this page, not a network problem
    setAlert('Something went wrong showing this data. Reload the page.');
  }
}

async function openPlayer(id) {
  try {
    const p = await api(`/api/player?world=${view.world}&window=${view.win}&id=${encodeURIComponent(id)}`);
    $('p-outfit').textContent = p.outfit ? `${p.tag ? `[${p.tag}] ` : ''}${p.outfit}` : 'No outfit';
    $('p-name').textContent = p.name;
    $('p-name').className = `c${p.faction}`;
    const tile = (k, l) => el('div', { class: 'tile' }, el('dd', { text: k }), el('dt', { text: l }));
    $('p-tiles').replaceChildren(tile(num(p.k), 'Kills'), tile(num(p.d), 'Deaths'), tile(kdText(p), 'K/D'), tile(p.br ? `BR ${p.br}` : '–', p.asp ? `ASP ${p.asp}` : 'Rank'));
    drawChart($('p-chart'), p.hourly);
    $('p-weapons').replaceChildren(...p.weapons.map((w) => el('li', {}, weaponCell(w.name, w.img), el('span', { text: `${num(w.kills)} kills` }))));
    if (!$('player').open) $('player').showModal();
  } catch { /* player left the window between refreshes: ignore */ }
}

async function openOnline(empire) {
  try {
    const r = await api(`/api/online?world=${view.world}&empire=${empire}`);
    $('o-title').textContent = empire ? EMPIRE[empire] || 'Nanite Systems' : 'Everyone online';
    $('o-title').className = empire ? `c${empire}` : '';
    $('o-sub').textContent = `${num(r.total)} online · ${view.data?.server || ''}`;
    $('o-list').replaceChildren(buildTable({
      cols: [
        { label: '#', cls: 'rank', cell: (_, i) => String(i + 1) },
        { label: 'Player', cell: who },
        { label: 'Outfit', cell: (p) => el('span', { text: p.outfit ? `${p.tag ? `[${p.tag}] ` : ''}${p.outfit}` : '–' }) },
        { label: 'BR', n: true, cell: (p) => (p.br ? `${p.br}${p.asp ? `~${p.asp}` : ''}` : '–') },
        { label: 'Seen online', n: true, cell: (p) => clock(r.now - p.since) },
      ],
      rows: r.players.map((p) => ({ ...p, online: true })),
      onRow: (p) => openPlayer(p.id),
      empty: 'Nobody has been seen log in here yet. The list fills in as players come and go.',
    }));
    if (!$('online').open) $('online').showModal();
  } catch {
    setAlert('Could not load who is online. Try again in a moment.');
  }
}

function segment(container, current, onPick) {
  const buttons = [...container.querySelectorAll('button')];
  const mark = (value) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(value))));
  mark(current);
  for (const b of buttons) b.addEventListener('click', () => { mark(b.dataset.v); onPick(b.dataset.v); });
}

async function init() {
  document.body.classList.add('loading');
  try {
    const servers = await api('/api/servers');
    if (!servers.some((s) => s.id === view.world)) view.world = servers[0].id;
    $('world').replaceChildren(...servers.map((s) => el('button', { type: 'button', 'data-v': String(s.id), title: s.region, text: s.name })));
  } catch { /* the stats call below reports the outage */ }
  map = createMap({ $, el, api, emblem, getWorld: () => view.world });
  segment($('world'), view.world, (v) => { view.world = Number(v); safeSet('world', v); view.pop = null; load(); map.worldChanged(); });
  if (!['1h', '6h', '24h'].includes(view.win)) view.win = '24h';
  segment($('window'), view.win, (v) => { view.win = v; safeSet('window', v); load(); });
  if (!Object.hasOwn(RANGES, view.range)) view.range = '2h';
  segment($('pop-range'), view.range, (v) => { view.range = v; safeSet('range', v); loadPopulation(); });

  // Tabs: click or arrow keys; the hash makes a tab linkable and keeps back/forward working.
  const tabs = TABS.map((t) => $(`tab-${t}`));
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => { location.hash = b.dataset.v; });
    b.addEventListener('keydown', (e) => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      tabs[(next + tabs.length) % tabs.length].focus();
      location.hash = TABS[(next + tabs.length) % tabs.length];
    });
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));

  for (const key of ['players', 'outfits']) {
    $(`${key}-q`).addEventListener('input', (e) => { view[key].q = e.target.value.trim(); RENDER[key](); });
  }
  for (const [dlg, close] of [['player', 'p-close'], ['online', 'o-close']]) {
    $(close).addEventListener('click', () => $(dlg).close());
    $(dlg).addEventListener('click', (e) => { if (e.target === $(dlg)) $(dlg).close(); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  await load();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
}
init();
