import { SUICIDE, firstIndexSince } from './store.js';

export const ZONES = { 2: 'Indar', 4: 'Hossin', 6: 'Amerish', 8: 'Esamir', 344: 'Oshur' };
export const ZONE_IDS = Object.keys(ZONES).map(Number);

const FIGHT_MS = 10 * 60e3; // a fight is activity at a base within the last 10 minutes
const PRESENCE_MS = 15 * 60e3; // a capture/defend ties a player to a base for 15 minutes
const MAX_CAPTURES = 60;
const W_PLAYER = 1; // a kill near a base, or a player capturing/defending it
const W_FLIP = 4; // the base changed hands

/**
 * Map state: who owns what, where players were last seen fighting, and recent activity.
 * activity rows: [ts, world, zone, facilityId, weight, factionA, factionB]
 */
export function createMapState() {
  return { owners: {}, charFac: {}, activity: [], captures: [] };
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
  ms.activity.push([ts, world, zone, seen.fac, W_PLAYER, flag === SUICIDE ? 0 : at, vt]);
}

/** A player captured or defended a base. `faction` comes from the character cache when known. */
export function noteFacility(ms, r, faction = 0) {
  ms.charFac[r.id] = { world: r.world, zone: r.zone, fac: r.fac, t: r.ts };
  ms.activity.push([r.ts, r.world, r.zone, r.fac, W_PLAYER, faction, 0]);
}

/** FacilityControl: updates ownership straight away (the next poll confirms it) and logs real flips. */
export function noteControl(ms, r, regionId) {
  if (regionId) ((ms.owners[r.world] ||= {})[r.zone] ||= {})[regionId] = r.to;
  if (r.from === r.to) return; // a successful defence also arrives as FacilityControl
  ms.activity.push([r.ts, r.world, r.zone, r.fac, W_FLIP, r.to, r.from]);
  ms.captures.push([r.ts, r.world, r.zone, r.fac, r.from, r.to]);
  if (ms.captures.length > MAX_CAPTURES) ms.captures.splice(0, ms.captures.length - MAX_CAPTURES);
}

export function pruneMap(ms, now) {
  let i = 0;
  while (i < ms.activity.length && ms.activity[i][0] < now - FIGHT_MS) i++;
  if (i) ms.activity.splice(0, i);
  for (const [id, c] of Object.entries(ms.charFac)) if (now - c.t > PRESENCE_MS) delete ms.charFac[id];
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
 * `statics` maps zone -> geometry for whatever has been loaded; `events` is the kill log.
 */
export function computeMap(ms, statics, events, world, zone, now) {
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
  for (const [ts, w, z, fac, weight, fa, fb] of ms.activity) {
    if (w !== world || z !== zone || ts < recent) continue;
    const f = (fights[fac] ||= { fac, heat: 0, kills: 0, flips: 0, factions: { 1: 0, 2: 0, 3: 0 }, last: 0 });
    f.heat += weight * (1 - ((now - ts) / FIGHT_MS) * 0.7); // recent activity counts more
    if (weight === W_FLIP) f.flips++;
    else if (fb) f.kills++;
    for (const x of [fa, fb]) if (x >= 1 && x <= 3) f.factions[x]++;
    f.last = Math.max(f.last, ts);
  }

  return {
    world,
    zone,
    now,
    zones,
    owners: owned[zone] || {},
    fights: Object.values(fights)
      .map((f) => ({ ...f, heat: Number(f.heat.toFixed(2)) }))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 15),
    captures: ms.captures
      .filter((c) => c[1] === world && c[2] === zone && c[0] >= now - 30 * 60e3)
      .slice(-10)
      .reverse()
      .map(([ts, , , fac, from, to]) => ({ ts, fac, from, to })),
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
