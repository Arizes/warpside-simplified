import { SUICIDE, firstIndexSince } from './store.js';

export const ZONES = { 2: 'Indar', 4: 'Hossin', 6: 'Amerish', 8: 'Esamir', 344: 'Oshur' };
export const ZONE_IDS = Object.keys(ZONES).map(Number);

const FIGHT_MS = 10 * 60e3; // a fight is activity at a base within the last 10 minutes
const PRESENCE_MS = 15 * 60e3; // a capture/defend ties a player to a base for 15 minutes
const CAPTURE_MS = 60 * 60e3; // capture history kept for the region card
const MAX_CAPTURES = 200;
const W_PLAYER = 1; // a kill near a base, or a player capturing/defending it
const W_FLIP = 4; // the base changed hands
// The in-game population brackets. We only ever report players *seen*, so this is a lower bound.
const BRACKETS = [[96, '96+'], [48, '48–96'], [24, '24–48'], [12, '12–24'], [1, '1–12']];

/** The in-game population bracket for a head count, or '' for none. */
export const bracket = (n) => BRACKETS.find(([min]) => n >= min)?.[1] || '';

/**
 * Map state: who owns what, who captured it, where players were last seen fighting, recent activity.
 * activity rows: [ts, world, zone, facilityId, weight, factionA, factionB, characterA, characterB]
 * held: { world: { facilityId: { f, oid, t } } } for flips seen since tracking started.
 */
export function createMapState() {
  return { owners: {}, held: {}, charFac: {}, activity: [], captures: [] };
}

/** The parts worth keeping across a restart (ownership is re-polled). */
export const mapSnapshot = (ms) => ({ held: ms.held, charFac: ms.charFac, activity: ms.activity, captures: ms.captures });
export function restoreMap(ms, snap) {
  if (!snap || typeof snap !== 'object') return;
  for (const k of ['held', 'charFac']) if (snap[k] && typeof snap[k] === 'object') ms[k] = snap[k];
  for (const k of ['activity', 'captures']) if (Array.isArray(snap[k])) ms[k] = snap[k];
}

/**
 * Daybreak does not publish where a kill happened, only the continent. Captures and defends are the only
 * events that tie a player to a base, so a kill counts towards a base when the attacker or victim was seen
 * capturing or defending it on the same continent in the last 15 minutes.
 */
export function noteDeath(ms, event) {
  const [ts, world, attacker, victim, , flag, at, vt, zone] = event;
  if (!zone) return;
  const seen = [ms.charFac[attacker], ms.charFac[victim]].find((c) => c && c.world === world && c.zone === zone && ts - c.t < PRESENCE_MS);
  if (!seen) return;
  const self = flag === SUICIDE;
  ms.activity.push([ts, world, zone, seen.fac, W_PLAYER, self ? 0 : at, vt, self ? '' : attacker, victim]);
}

/** A player captured or defended a base. `faction` comes from the character cache when known. */
export function noteFacility(ms, r, faction = 0) {
  ms.charFac[r.id] = { world: r.world, zone: r.zone, fac: r.fac, t: r.ts };
  ms.activity.push([r.ts, r.world, r.zone, r.fac, W_PLAYER, faction, 0, r.id, '']);
}

/** FacilityControl: updates ownership straight away (the next poll confirms it) and logs real flips. */
export function noteControl(ms, r, regionId) {
  if (regionId) ((ms.owners[r.world] ||= {})[r.zone] ||= {})[regionId] = r.to;
  if (r.from === r.to) return; // a successful defence also arrives as FacilityControl
  (ms.held[r.world] ||= {})[r.fac] = { f: r.to, oid: r.outfit || null, t: r.ts };
  ms.activity.push([r.ts, r.world, r.zone, r.fac, W_FLIP, r.to, r.from, '', '']);
  ms.captures.push([r.ts, r.world, r.zone, r.fac, r.from, r.to, r.outfit || null]);
  if (ms.captures.length > MAX_CAPTURES) ms.captures.splice(0, ms.captures.length - MAX_CAPTURES);
}

export function pruneMap(ms, now) {
  let i = 0;
  while (i < ms.activity.length && ms.activity[i][0] < now - FIGHT_MS) i++;
  if (i) ms.activity.splice(0, i);
  for (const [id, c] of Object.entries(ms.charFac)) if (now - c.t > PRESENCE_MS) delete ms.charFac[id];
  i = 0;
  while (i < ms.captures.length && ms.captures[i][0] < now - CAPTURE_MS) i++;
  if (i) ms.captures.splice(0, i);
}

/** Hexes per region, so territory share is weighted by area like the in-game bar. */
function territory(owners, stat) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const weight = {};
  if (stat) for (const h of stat.hexes) weight[h[2]] = (weight[h[2]] || 0) + 1;
  for (const [rid, f] of Object.entries(owners || {})) {
    const k = f >= 1 && f <= 3 ? f : 0;
    counts[k] += stat ? weight[rid] || 0 : 1;
  }
  return counts;
}

/**
 * Everything the map view shows for one world and continent.
 * `statics` maps zone -> geometry for whatever has been loaded; `events` is the kill log;
 * `outfitOf(id)` returns { tag, name } once the outfit has been looked up.
 */
export function computeMap(ms, statics, events, world, zone, now, outfitOf = () => null) {
  const recent = now - FIGHT_MS;
  const kills = {};
  for (let i = firstIndexSince(events, recent); i < events.length; i++) {
    const e = events[i];
    if (e[1] !== world || !e[8]) continue;
    const z = (kills[e[8]] ||= { total: 0, 1: 0, 2: 0, 3: 0 });
    z.total++;
    if (e[5] !== SUICIDE && e[6] >= 1 && e[6] <= 3) z[e[6]]++;
  }

  const owned = ms.owners[world] || {};
  const zones = ZONE_IDS.map((id) => ({
    id,
    name: ZONES[id],
    known: Boolean(owned[id]),
    territory: territory(owned[id], statics[id]),
    kills: kills[id]?.total || 0,
  }));

  const fights = {};
  for (const [ts, w, z, fac, weight, fa, fb, ida, idb] of ms.activity) {
    if (w !== world || z !== zone || ts < recent) continue;
    const f = (fights[fac] ||= { fac, heat: 0, kills: 0, flips: 0, factions: { 1: 0, 2: 0, 3: 0 }, people: { 1: new Set(), 2: new Set(), 3: new Set(), 0: new Set() }, last: 0 });
    f.heat += weight * (1 - ((now - ts) / FIGHT_MS) * 0.7); // recent activity counts more
    if (weight === W_FLIP) f.flips++;
    else if (fb) f.kills++;
    for (const [x, id] of [[fa, ida], [fb, idb]]) {
      if (x >= 1 && x <= 3) f.factions[x]++;
      if (id) f.people[x >= 1 && x <= 3 ? x : 0].add(id);
    }
    f.last = Math.max(f.last, ts);
  }

  const outfit = (oid) => (oid ? { id: oid, ...(outfitOf(oid) || { tag: '', name: '' }) } : null);
  const held = {};
  for (const [fac, h] of Object.entries(ms.held[world] || {})) held[fac] = { f: h.f, since: h.t, outfit: outfit(h.oid) };

  return {
    world,
    zone,
    now,
    zones,
    owners: owned[zone] || {},
    held, // only bases seen changing hands since tracking started; others are unknown
    fights: Object.values(fights)
      .map(({ people, ...f }) => {
        const seen = { 1: people[1].size, 2: people[2].size, 3: people[3].size };
        const total = seen[1] + seen[2] + seen[3] + people[0].size;
        return { ...f, heat: Number(f.heat.toFixed(2)), seen, seenTotal: total, bracket: bracket(total) };
      })
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 20),
    captures: ms.captures
      .filter((c) => c[1] === world && c[2] === zone)
      .slice(-30)
      .reverse()
      .map(([ts, , , fac, from, to, oid]) => ({ ts, fac, from, to, outfit: outfit(oid) })),
    zoneKills: kills[zone] || { total: 0, 1: 0, 2: 0, 3: 0 },
  };
}

/** The busiest known continent, so the map opens where the fighting is. */
export function busiestZone(ms, events, world, now) {
  const counts = {};
  for (let i = firstIndexSince(events, now - FIGHT_MS); i < events.length; i++) {
    const e = events[i];
    if (e[1] === world && ZONES[e[8]]) counts[e[8]] = (counts[e[8]] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? Number(best[0]) : 2;
}
