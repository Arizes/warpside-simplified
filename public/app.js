// Dashboard client. Every string from the API (character names, outfits) is untrusted,
// so nodes are built with textContent only: no innerHTML anywhere.
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const FACTION = { 1: 'VS', 2: 'NC', 3: 'TR', 4: 'NSO' };
const POLL_MS = 15000;

let world = Number(safeGet('world')) || 1000;
let win = safeGet('window') || '24h';
let rows = [];
let timer;

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
const kdr = (k, d) => (d ? (k / d).toFixed(2) : k.toFixed(2));
const clock = (ms) => {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const faction = (f) => el('img', { src: `/img/faction/${f >= 1 && f <= 4 ? f : 4}`, alt: FACTION[f] || '', width: 22, height: 22, loading: 'lazy' });
function weapon(name, id) {
  return el('span', { class: 'wep' }, id && id !== '0' ? el('img', { src: `/img/item/${encodeURIComponent(id)}`, alt: '', loading: 'lazy' }) : null, el('span', { text: name }));
}

async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Bar chart of kills per hour as inline SVG. */
function drawChart(target, buckets) {
  const W = 720, H = 150, pad = 18;
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

function renderFactions(list) {
  const total = list.reduce((s, f) => s + f.k, 0);
  const bar = el('div', { class: 'fbar' });
  for (const f of list) {
    const pct = total ? (f.k / total) * 100 : 33.3;
    const seg = el('div', { class: `f${f.f}`, text: total ? `${Math.round(pct)}%` : '' });
    seg.style.flexGrow = String(Math.max(pct, 0.5));
    bar.append(seg);
  }
  const legend = el('div', { class: 'flegend' }, ...list.map((f) =>
    el('span', {}, faction(f.f), el('b', { class: `c${f.f}`, text: FACTION[f.f] }), `${num(f.k)} kills · ${num(f.d)} deaths`)));
  $('factions').replaceChildren(bar, legend);
}

function renderPlayers() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = rows.filter((p) => !q || p.name.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q) || p.outfit.toLowerCase().includes(q));
  $('players').replaceChildren(...shown.map((p) => {
    const tr = el('tr', { tabindex: '0', 'aria-label': `Open ${p.name}` },
      el('td', { class: 'rank', text: String(rows.indexOf(p) + 1) }),
      el('td', {}, el('span', { class: 'who' }, faction(p.faction), p.online ? el('span', { class: 'on', title: 'Online' }) : null,
        el('span', { class: `c${p.faction}`, text: p.name }), p.tag ? el('span', { class: 'tag', text: `[${p.tag}]` }) : null)),
      el('td', { class: 'n', text: num(p.k) }), el('td', { class: 'n', text: num(p.d) }),
      el('td', { class: 'n', text: kdr(p.k, p.d) }), el('td', { class: 'n', text: p.kpm.toFixed(2) }),
      el('td', {}, weapon(p.weapon, p.weaponId)));
    const open = () => openPlayer(p.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return tr;
  }));
  $('players-empty').hidden = shown.length > 0;
}

function render(s) {
  rows = s.players;
  $('server-line').textContent = `${s.server} · last ${win.toUpperCase()}`;
  $('t-kills').textContent = num(s.factions.reduce((a, f) => a + f.k, 0));
  $('t-players').textContent = num(s.players.length);
  $('t-since').textContent = clock(s.now - Math.max(s.trackedSince, s.since));
  $('hourly-note').textContent = `last ${s.hourly.length} h`;
  renderFactions(s.factions);
  drawChart($('chart'), s.hourly);
  renderPlayers();
  $('outfits').replaceChildren(...s.outfits.map((o, i) => el('tr', {},
    el('td', { class: 'rank', text: String(i + 1) }),
    el('td', {}, el('span', { class: 'who' }, faction(o.faction), el('span', { class: `c${o.faction}`, text: o.tag ? `[${o.tag}] ${o.name}` : o.name }))),
    el('td', { class: 'n', text: num(o.k) }), el('td', { class: 'n', text: num(o.d) }),
    el('td', { class: 'n', text: kdr(o.k, o.d) }), el('td', { class: 'n', text: String(o.members) }),
    el('td', {}, weapon(o.weapon, null)))));
  $('outfits-empty').hidden = s.outfits.length > 0;

  const pill = $('status');
  const live = s.stream === 'connected' && s.feedOnline !== false;
  pill.className = `pill ${live ? 'live' : 'down'}`;
  pill.lastElementChild.textContent = live ? 'Live' : s.stream === 'connected' ? 'Daybreak feed offline' : 'Reconnecting…';
}

async function load() {
  try {
    render(await api(`/api/stats?world=${world}&window=${win}`));
  } catch {
    const pill = $('status');
    pill.className = 'pill down';
    pill.lastElementChild.textContent = 'Tracker unreachable';
  }
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
}

async function openPlayer(id) {
  try {
    const p = await api(`/api/player?world=${world}&window=${win}&id=${encodeURIComponent(id)}`);
    $('p-outfit').textContent = p.outfit ? `${p.tag ? `[${p.tag}] ` : ''}${p.outfit}` : 'No outfit';
    $('p-name').textContent = p.name;
    $('p-name').className = `c${p.faction}`;
    const tile = (k, l) => el('div', { class: 'tile' }, el('span', { class: 'k', text: k }), el('span', { class: 'l', text: l }));
    $('p-tiles').replaceChildren(tile(num(p.k), 'Kills'), tile(num(p.d), 'Deaths'), tile(kdr(p.k, p.d), 'KDR'), tile(p.br ? `BR ${p.br}` : '–', p.asp ? `ASP ${p.asp}` : 'Rank'));
    drawChart($('p-chart'), p.hourly);
    $('p-weapons').replaceChildren(...p.weapons.map((w) => el('li', {}, weapon(w.name, w.id), el('span', { text: `${num(w.kills)} kills` }))));
    if (!$('player').open) $('player').showModal();
  } catch { /* player left the window between refreshes: ignore */ }
}

function tabs(container, current, onPick) {
  const buttons = [...container.querySelectorAll('button')];
  for (const b of buttons) {
    b.setAttribute('aria-selected', String(b.dataset.v === String(current)));
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      onPick(b.dataset.v);
    });
  }
}

async function init() {
  try {
    const servers = await api('/api/servers');
    if (!servers.some((s) => s.id === world)) world = servers[0].id;
    $('world').replaceChildren(...servers.map((s) => el('button', { role: 'tab', 'data-v': String(s.id), title: s.region, text: s.name })));
  } catch { /* the stats call below reports the outage */ }
  tabs($('world'), world, (v) => { world = Number(v); safeSet('world', v); load(); });
  if (!['1h', '6h', '24h'].includes(win)) win = '24h';
  tabs($('window'), win, (v) => { win = v; safeSet('window', v); load(); });
  $('filter').addEventListener('input', renderPlayers);
  $('p-close').addEventListener('click', () => $('player').close());
  $('player').addEventListener('click', (e) => { if (e.target === $('player')) $('player').close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  await load();
  schedule();
}
init();
