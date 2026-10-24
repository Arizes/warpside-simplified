import { SERVERS } from './config.js';

const ID = /^\d{1,20}$/; // Census IDs are 64-bit: keep them as strings, never numbers
const BATCH = 100;

/**
 * Resolves character names/outfits and weapon names/images from the Census REST API.
 * Lookups are queued, batched, cached in `state`, and back off for 30 s after a failure.
 */
export function createLookups({ serviceId, state, fetchImpl = fetch, now = Date.now }) {
  const pendChars = {}; // ns -> Set
  const pendItems = {};
  let backoffUntil = 0;

  const queue = (m, ns, id) => {
    if (typeof id === 'string' && ID.test(id) && id !== '0') (m[ns] ||= new Set()).add(id);
  };

  async function census(ns, coll, query) {
    const url = `https://census.daybreakgames.com/s:${serviceId}/get/${ns}/${coll}?${query}`;
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Census HTTP ${r.status}`);
    const j = await r.json();
    if (j.error || j.errorCode) throw new Error(`Census ${j.error || j.errorCode}`);
    return j[`${coll}_list`] || [];
  }

  async function flush() {
    if (now() < backoffUntil) return;
    try {
      for (const ns of Object.keys(pendChars)) {
        const ids = [...pendChars[ns]].filter((id) => !state.chars[id]).slice(0, BATCH);
        ids.forEach((id) => pendChars[ns].delete(id));
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
          };
        }
        // deleted / unknown characters: cache a placeholder so we do not ask again
        for (const id of ids) state.chars[id] ||= { n: `#${id}`, f: 0, br: 0, p: 0, oid: null, tag: '', on: '' };
      }
      for (const ns of Object.keys(pendItems)) {
        const ids = [...pendItems[ns]].filter((id) => !state.items[id]).slice(0, BATCH);
        ids.forEach((id) => pendItems[ns].delete(id));
        if (!ids.length) continue;
        const list = await census(ns, 'item', `item_id=${ids.join(',')}&c:show=item_id,name.en,image_path`);
        for (const it of list) state.items[it.item_id] = { n: it.name?.en || `Item ${it.item_id}`, img: it.image_path || '' };
        for (const id of ids) state.items[id] ||= { n: `Item ${id}`, img: '' };
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
    requestCharacter(world, id) {
      const ns = SERVERS[world]?.ns;
      if (ns) queue(pendChars, ns, id);
    },
  };
}
