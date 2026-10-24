import { KILL, TEAMKILL, SUICIDE, firstIndexSince } from './store.js';

const HOUR = 3600e3;
const NSO = 4;
const IMAGE_PATH = /^\/files\/ps2\/images\/static\/\d+\.png$/;

/** Census image path for an item, or '' unless it has the expected shape (the browser loads it directly). */
const imageOf = (items, id) => (IMAGE_PATH.test(items[id]?.img || '') ? items[id].img : '');

function topWeapon(counts, items) {
  let best = null;
  let bestN = 0;
  for (const id of Object.keys(counts)) {
    if (counts[id] > bestN) {
      bestN = counts[id];
      best = id;
    }
  }
  if (!best) return null;
  return { id: best, name: best === '0' ? 'Unknown' : items[best]?.n || `Item ${best}`, img: imageOf(items, best), kills: bestN };
}

const factionOf = (state, id, team) => {
  const f = state.chars[id]?.f;
  return f === NSO ? NSO : f || team || 0;
};

/** Kills per hour for the last `hours` hours, oldest first. `match` filters events. */
function hourly(events, from, now, hours, match) {
  const buckets = Array.from({ length: hours }, (_, i) => ({ t: now - (hours - i) * HOUR, kills: 0 }));
  for (let i = firstIndexSince(events, now - hours * HOUR); i < events.length; i++) {
    const e = events[i];
    if (e[5] !== KILL || !match(e)) continue;
    const slot = hours - 1 - Math.floor((now - e[0]) / HOUR);
    if (slot >= 0 && slot < hours) buckets[slot].kills++;
  }
  return buckets;
}

/** Leaderboards for one world over [since, now]. */
export function computeStats(state, world, since, now, meta = {}) {
  const players = {};
  const get = (id) => (players[id] ||= { id, k: 0, d: 0, tk: 0, s: 0, rk: 0, first: Infinity, last: 0, w: {}, team: 0 });
  const recentCut = now - 10 * 60e3;
  const { events } = state;
  let count = 0;

  for (let i = firstIndexSince(events, since); i < events.length; i++) {
    const [ts, w, a, v, wep, flag, at, vt] = events[i];
    if (w !== world) continue;
    count++;
    const V = get(v);
    if (vt) V.team = vt;
    V.d++;
    V.first = Math.min(V.first, ts);
    V.last = Math.max(V.last, ts);
    if (flag === SUICIDE) {
      V.s++;
      continue;
    }
    const A = get(a);
    if (at) A.team = at;
    A.first = Math.min(A.first, ts);
    A.last = Math.max(A.last, ts);
    if (flag === TEAMKILL) {
      A.tk++;
      continue;
    }
    A.k++;
    A.w[wep] = (A.w[wep] || 0) + 1;
    if (ts >= recentCut) A.rk++;
  }

  const rows = Object.values(players).map((p) => {
    const c = state.chars[p.id] || {};
    const login = state.online[p.id];
    const activeMin = Math.max(1, (Math.max(p.last, login ? now : p.last) - Math.max(since, login || p.first)) / 60e3);
    const wp = topWeapon(p.w, state.items);
    return {
      id: p.id,
      name: c.n || `#${p.id}`,
      faction: factionOf(state, p.id, p.team),
      br: c.br || 0,
      asp: c.p || 0,
      tag: c.tag || '',
      oid: c.oid || null,
      outfit: c.on || '',
      k: p.k,
      d: p.d,
      tk: p.tk,
      s: p.s,
      kpm: Number((p.k / activeMin).toFixed(2)),
      online: Boolean(login),
      weapon: wp?.name || '-',
      weaponImg: wp?.img || '',
      _w: p.w,
    };
  });

  const outfits = {};
  for (const p of rows) {
    if (!p.oid) continue;
    const o = (outfits[p.oid] ||= { tag: p.tag, name: p.outfit, faction: p.faction, k: 0, d: 0, members: 0, w: {} });
    o.k += p.k;
    o.d += p.d;
    o.members++;
    for (const id of Object.keys(p._w)) o.w[id] = (o.w[id] || 0) + p._w[id];
  }

  const allOutfits = Object.values(outfits)
    .filter((o) => o.members >= 2)
    .map((o) => ({ tag: o.tag, name: o.name, faction: o.faction, k: o.k, d: o.d, members: o.members, weapon: topWeapon(o.w, state.items)?.name || '-' }))
    .sort((a, b) => b.k - a.k);

  const ranked = rows.filter((p) => p.k > 0).sort((a, b) => b.k - a.k);
  const byFaction = Object.fromEntries(
    [1, 2, 3].map((f) => [f, { players: ranked.filter((p) => p.faction === f).slice(0, 50), outfits: allOutfits.filter((o) => o.faction === f).slice(0, 25) }]),
  );

  const factions = [1, 2, 3].map((f) => {
    let k = 0;
    let d = 0;
    for (const p of rows) if (p.faction === f) { k += p.k; d += p.d; }
    return { f, k, d };
  });

  for (const p of rows) delete p._w;
  const hours = Math.min(24, Math.max(1, Math.ceil((now - since) / HOUR)));
  return {
    world,
    since,
    now,
    events: count,
    players: ranked.slice(0, 100),
    outfits: allOutfits.slice(0, 50),
    byFaction,
    activePlayers: ranked.length,
    factions,
    hourly: hourly(events, since, now, hours, (e) => e[1] === world),
    ...meta,
  };
}

/** One player's totals, top weapons and hourly kills for the window. */
export function computePlayer(state, world, id, since, now) {
  const w = {};
  let k = 0;
  let d = 0;
  let tk = 0;
  let s = 0;
  const { events } = state;
  for (let i = firstIndexSince(events, since); i < events.length; i++) {
    const [, ew, a, v, wep, flag] = events[i];
    if (ew !== world) continue;
    if (v === id) {
      d++;
      if (flag === SUICIDE) s++;
    }
    if (a === id && flag === KILL) {
      k++;
      w[wep] = (w[wep] || 0) + 1;
    } else if (a === id && flag === TEAMKILL) tk++;
  }
  if (!k && !d && !tk) return null;
  const c = state.chars[id] || {};
  const weapons = Object.keys(w)
    .sort((x, y) => w[y] - w[x])
    .slice(0, 8)
    .map((wid) => ({ id: wid, name: wid === '0' ? 'Unknown' : state.items[wid]?.n || `Item ${wid}`, img: imageOf(state.items, wid), kills: w[wid] }));
  return {
    id,
    name: c.n || `#${id}`,
    faction: c.f || 0,
    br: c.br || 0,
    asp: c.p || 0,
    tag: c.tag || '',
    outfit: c.on || '',
    k,
    d,
    tk,
    s,
    online: Boolean(state.online[id]),
    weapons,
    hourly: hourly(events, since, now, Math.min(24, Math.max(1, Math.ceil((now - since) / HOUR))), (e) => e[1] === world && e[2] === id),
  };
}
