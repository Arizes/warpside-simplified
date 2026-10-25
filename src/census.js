import { SERVERS } from './config.js';

const ID = /^\d{1,20}$/; // Census IDs are 64-bit: keep them as strings, never numbers
const BATCH = 100;

/** One Census REST call. Callers build `query` only from validated ids and constants. */
export async function censusGet({ serviceId, fetchImpl = fetch }, ns, coll, query) {
  const url = `https://census.daybreakgames.com/s:${serviceId}/get/${ns}/${coll}?${query}`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Census HTTP ${r.status}`);
  const j = await r.json();
  if (j.error || j.errorCode) throw new Error(`Census ${j.error || j.errorCode}`);
  const list = j[`${coll}_list`];
  return Array.isArray(list) ? list : [];
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Static geometry of one continent: hexes [x, y, regionId], regions by id, and lattice links.
 * Verified live 2026-10-24: Indar has 1,051 hexes and 89 regions, Oshur 2,687 hexes.
 */
export async function fetchZoneStatic(opts, ns, zone) {
  let hexes = [];
  for (let start = 0; start < 20000; start += 1000) {
    const page = await censusGet(opts, ns, 'map_hex', `zone_id=${zone}&c:limit=1000&c:start=${start}&c:show=map_region_id,x,y`);
    hexes = hexes.concat(page.map((h) => [num(h.x), num(h.y), String(h.map_region_id)]).filter((h) => h[0] !== null && h[1] !== null));
    if (page.length < 1000) break;
  }
  const regions = {};
  const list = await censusGet(opts, ns, 'map_region', `zone_id=${zone}&c:limit=1000&c:show=map_region_id,facility_id,facility_name,facility_type_id,location_x,location_z`);
  for (const r of list) {
    if (!ID.test(String(r.map_region_id))) continue;
    regions[r.map_region_id] = {
      fac: ID.test(String(r.facility_id || '')) ? String(r.facility_id) : null,
      n: String(r.facility_name || '').slice(0, 80),
      t: num(r.facility_type_id) || 0,
      x: num(r.location_x),
      z: num(r.location_z),
    };
  }
  const links = (await censusGet(opts, ns, 'facility_link', `zone_id=${zone}&c:limit=1000&c:show=facility_id_a,facility_id_b`))
    .map((l) => [String(l.facility_id_a), String(l.facility_id_b)])
    .filter(([a, b]) => ID.test(a) && ID.test(b));
  if (!hexes.length) throw new Error('no hexes');
  return { hexes, regions, links };
}

/** Current owner of every region on the given continents of one world: { zone: { regionId: faction } }. */
export async function fetchOwnership(opts, ns, world, zones) {
  const out = {};
  for (const m of await censusGet(opts, ns, 'map', `world_id=${world}&zone_ids=${zones.join(',')}`)) {
    const zone = num(m.ZoneId);
    const rows = m.Regions?.Row;
    if (!zones.includes(zone) || !Array.isArray(rows)) continue;
    const z = (out[zone] = {});
    for (const r of rows) {
      const id = String(r?.RowData?.RegionId ?? '');
      if (ID.test(id)) z[id] = num(r.RowData.FactionId) || 0;
    }
  }
  return out;
}

/**
 * Resolves character names/outfits and weapon names/images from the Census REST API.
 * Lookups are queued, batched, cached in `state`, and back off for 30 s after a failure.
 */
export function createLookups({ serviceId, state, fetchImpl = fetch, now = Date.now }) {
  const pendChars = {}; // ns -> Set
  const refreshChars = new Set(); // spawn owners need recent outfit membership, not a day-old cache
  const pendItems = {};
  const pendOutfits = {};
  let backoffUntil = 0;

  const queue = (m, ns, id) => {
    if (typeof id === 'string' && ID.test(id) && id !== '0') (m[ns] ||= new Set()).add(id);
  };

  const census = (ns, coll, query) => censusGet({ serviceId, fetchImpl }, ns, coll, query);

  async function flush() {
    if (now() < backoffUntil) return;
    try {
      for (const ns of Object.keys(pendChars)) {
        const ids = [...pendChars[ns]].filter((id) => !state.chars[id] || refreshChars.has(id)).slice(0, BATCH);
        if (!ids.length) continue;
        const list = await census(
          ns,
          'character',
          `character_id=${ids.join(',')}&c:show=character_id,name.first,faction_id,battle_rank.value,prestige_level` +
            `&c:join=outfit_member_extended^show:outfit_id'alias'name^inject_at:outfit`,
        );
        for (const c of list) {
          state.chars[c.character_id] = {
            n: c.name?.first || '?',
            f: Number(c.faction_id) || 0,
            br: Number(c.battle_rank?.value) || 0,
            p: Number(c.prestige_level) || 0,
            oid: c.outfit?.outfit_id || null,
            tag: c.outfit?.alias || '',
            on: c.outfit?.name || '',
            at: now(),
          };
        }
        // deleted / unknown characters: cache a placeholder so we do not ask again
        for (const id of ids) state.chars[id] ||= { n: `#${id}`, f: 0, br: 0, p: 0, oid: null, tag: '', on: '' };
        for (const id of ids) refreshChars.delete(id);
        ids.forEach((id) => pendChars[ns].delete(id));
      }
      for (const ns of Object.keys(pendItems)) {
        const ids = [...pendItems[ns]].filter((id) => !state.items[id]).slice(0, BATCH);
        ids.forEach((id) => pendItems[ns].delete(id));
        if (!ids.length) continue;
        const list = await census(ns, 'item', `item_id=${ids.join(',')}&c:show=item_id,name.en,image_path`);
        for (const it of list) state.items[it.item_id] = { n: it.name?.en || `Item ${it.item_id}`, img: it.image_path || '' };
        for (const id of ids) state.items[id] ||= { n: `Item ${id}`, img: '' };
      }
      for (const ns of Object.keys(pendOutfits)) {
        const ids = [...pendOutfits[ns]].filter((id) => !state.outfits[id]).slice(0, BATCH);
        ids.forEach((id) => pendOutfits[ns].delete(id));
        if (!ids.length) continue;
        const list = await census(ns, 'outfit', `outfit_id=${ids.join(',')}&c:show=outfit_id,alias,name`);
        for (const o of list) state.outfits[o.outfit_id] = { tag: String(o.alias || '').slice(0, 8), name: String(o.name || '').slice(0, 64) };
        for (const id of ids) state.outfits[id] ||= { tag: '', name: '' };
      }
    } catch (err) {
      console.warn('census lookup failed, backing off 30s:', err.message);
      backoffUntil = now() + 30e3;
    }
  }

  return {
    flush,
    /** Queue everything a death event needs to be displayed. */
    request(world, { attacker, victim, weapon }) {
      const ns = SERVERS[world]?.ns;
      if (!ns) return;
      queue(pendChars, ns, attacker);
      queue(pendChars, ns, victim);
      queue(pendItems, ns, weapon);
    },
    requestCharacter(world, id, freshOutfit = false) {
      const ns = SERVERS[world]?.ns;
      if (!ns || typeof id !== 'string' || !ID.test(id) || id === '0') return;
      const c = state.chars[id];
      const stale = freshOutfit && (!Number.isFinite(c?.at) || now() - c.at >= 5 * 60_000);
      if (stale) refreshChars.add(id);
      if (!c || stale) queue(pendChars, ns, id);
    },
    requestOutfit(world, id) {
      const ns = SERVERS[world]?.ns;
      if (ns) queue(pendOutfits, ns, id);
    },
  };
}
