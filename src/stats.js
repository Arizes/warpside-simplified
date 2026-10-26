import { KILL, TEAMKILL, SUICIDE, firstIndexSince } from './store.js';

const HOUR = 3600e3;
const NSO = 4;
const POP_POINTS = 180; // most points sent for the population line
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

/**
 * Characters online per empire on one world, right now. Built from the PlayerLogin and PlayerLogout
 * events Daybreak publishes, plus anyone seen fighting; characters already online when the tracker
 * started are missing until a login or activity is observed. Missed logouts can overcount.
 */
export function onlineByFaction(state, world) {
  const sample = { vs: 0, nc: 0, tr: 0, ns: 0 };
  const worlds = state.onlineW || {};
  for (const id of Object.keys(state.online)) {
    if (worlds[id] !== world) continue;
    const f = state.chars[id]?.f;
    if (f === 1) sample.vs++;
    else if (f === 2) sample.nc++;
    else if (f === 3) sample.tr++;
    else if (f === NSO) sample.ns++;
  }
  return sample;
}

/** Count sessions on this world, including characters whose faction lookup is still pending. */
export function onlineCount(state, world) {
  return Object.keys(state.online).filter((id) => state.onlineW?.[id] === world).length;
}

/** One recorded sample per world, for the collector to append to `state.pop`. */
export function populationSample(state, worlds, now) {
  return worlds.map((world) => {
    const { vs, nc, tr, ns } = onlineByFaction(state, world);
    return [now, world, vs, nc, tr, ns];
  });
}

/**
 * The recorded population history for one world, oldest first. Longer ranges are averaged into at
 * most `max` buckets so the payload stays small, and the live count is always the last point.
 */
export function populationSeries(state, world, since, now, max = POP_POINTS) {
  const rows = (state.pop || []).filter((r) => r[1] === world && r[0] >= since && r[0] <= now);
  const step = Math.max(1, Math.ceil(rows.length / max));
  const out = [];
  for (let i = 0; i < rows.length; i += step) {
    const bucket = rows.slice(i, i + step);
    const mean = (n) => Math.round(bucket.reduce((a, r) => a + r[n], 0) / bucket.length);
    out.push({ t: bucket.at(-1)[0], vs: mean(2), nc: mean(3), tr: mean(4), ns: mean(5) });
  }
  out.push({ t: now, ...onlineByFaction(state, world), total: onlineCount(state, world) });
  return out;
}

/**
 * Who the tracker has seen log in on one world, longest session first. `empire` filters by faction
 * (0 for all). `since` is the login, or the first sighting for a character already playing.
 */
export function onlineRoster(state, world, empire = 0, limit = 500) {
  const worlds = state.onlineW || {};
  const rows = [];
  for (const [id, since] of Object.entries(state.online)) {
    if (worlds[id] !== world) continue;
    const c = state.chars[id] || {};
    const faction = c.f || 0;
    if (empire && faction !== empire) continue;
    rows.push({ id, name: c.n || `#${id}`, faction, br: c.br || 0, asp: c.p || 0, tag: c.tag || '', outfit: c.on || '', since });
  }
  rows.sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  return { total: rows.length, players: rows.slice(0, limit) };
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
    // Playtime is only what the tracker watched: this session's start, clamped to the window, and
    // unknown for anyone not online now. Where the start is a first sighting rather than a login we
    // saw, the session really began earlier, so the figure is a floor and never the whole truth.
    const start = login === undefined ? null : Math.max(login, since);
    const ptFloor = start !== null && login > since && Boolean(state.onlineSeen?.[p.id]);
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
      pt: start === null ? null : now - start, // ms seen online in the window, null when unknown
      ptFloor, // true when the real session started before the tracker noticed them
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
    [1, 2, 3, NSO].map((f) => [f, { players: ranked.filter((p) => p.faction === f).slice(0, 50), outfits: allOutfits.filter((o) => o.faction === f).slice(0, 25) }]),
  );

  const factions = [1, 2, 3, NSO].map((f) => {
    let k = 0;
    let d = 0;
    for (const p of rows) if (p.faction === f) { k += p.k; d += p.d; }
    return { f, k, d };
  });

  for (const p of rows) delete p._w;
  return {
    world,
    since,
    now,
    events: count,
    players: ranked.slice(0, 100),
    outfits: allOutfits.slice(0, 50),
    byFaction,
    activePlayers: onlineCount(state, world),
    onlinePlayers: onlineCount(state, world),
    windowPlayers: ranked.length, // distinct players with a kill in the selected leaderboard window
    factions,
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
