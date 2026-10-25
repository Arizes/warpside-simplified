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
  data: null,
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
  drawChart($('chart'), s.hourly);
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
    t.textContent = `${new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${num(b.kills)} kills`;
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
    t.textContent = new Date(b.t).toLocaleTimeString([], { hour: 'numeric' });
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
  $('hourly-note').textContent = `last ${s.hourly.length} h`;
  const live = s.stream === 'connected' && s.feedOnline !== false;
  $('status').className = `pill ${live ? 'live' : 'down'}`;
  $('status').lastElementChild.textContent = live ? 'Live' : s.stream === 'connected' ? 'Daybreak feed offline' : 'Reconnecting';
}
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
async function load() {
  let data;
  try {
    data = await api(`/api/stats?world=${view.world}&window=${view.win}`);
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
  segment($('world'), view.world, (v) => { view.world = Number(v); safeSet('world', v); load(); map.worldChanged(); });
  if (!['1h', '6h', '24h'].includes(view.win)) view.win = '24h';
  segment($('window'), view.win, (v) => { view.win = v; safeSet('window', v); load(); });

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
  $('p-close').addEventListener('click', () => $('player').close());
  $('player').addEventListener('click', (e) => { if (e.target === $('player')) $('player').close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  await load();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
}
init();
