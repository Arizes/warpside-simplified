// ESS spawn-bonus NPCs, as tracked by Honu (MIT). The bonus recipient owns the spawn;
// the recipient's outfit membership does not establish outfit ownership at deployment.
export const SPAWN_TYPES = { 233: 'Sunderer', 1410: 'Router' };
// Verified in the official loadout collection for both PS4 namespaces. Gaps are not factions.
export const LOADOUT_FACTION = Object.fromEntries([
  [1, [15, 17, 18, 19, 20, 21]], [2, [1, 3, 4, 5, 6, 7]],
  [3, [8, 10, 11, 12, 13, 14]], [4, [28, 29, 30, 31, 32, 45]],
].flatMap(([f, ids]) => ids.map((id) => [id, f])));
export const SPAWN_WINDOW_MS = 5 * 60_000;
const MAX_POINTS = 512;
const BUCKET_MS = 1000;

/** Keep only active NPCs and sparse per-second counters, never raw XP events. */
export function pruneSpawns(state, now) {
  const points = (state.spawns ||= {});
  for (const [key, p] of Object.entries(points)) {
    if (now - p.lastSeen >= SPAWN_WINDOW_MS) delete points[key];
    else p.buckets = p.buckets.filter(([t]) => t > now - SPAWN_WINDOW_MS);
  }
}

export function noteSpawn(state, r) {
  const points = (state.spawns ||= {});
  const key = `${r.world}:${r.instance}:${r.npc}`;
  let p = points[key];
  if (p && r.ts < p.lastSeen - SPAWN_WINDOW_MS) return;
  // A changed owner/type or a long silent interval starts a new observed session.
  if (!p || p.owner !== r.owner || p.type !== r.type || r.ts - p.lastSeen >= SPAWN_WINDOW_MS) {
    if (!p && Object.keys(points).length >= MAX_POINTS) {
      pruneSpawns(state, r.ts);
      if (Object.keys(points).length >= MAX_POINTS) {
        const oldest = Object.keys(points).reduce((a, b) => points[a].lastSeen < points[b].lastSeen ? a : b);
        delete points[oldest];
      }
    }
    p = points[key] = { world: r.world, zone: r.zone, owner: r.owner, type: r.type, faction: r.faction,
      firstSeen: r.ts, lastSeen: r.ts, total: 0, buckets: [] };
  }
  p.firstSeen = Math.min(p.firstSeen, r.ts);
  p.lastSeen = Math.max(p.lastSeen, r.ts);
  p.total++;
  const t = Math.floor(r.ts / BUCKET_MS) * BUCKET_MS;
  const bucket = p.buckets.find(([at]) => at === t);
  if (bucket) bucket[1]++;
  else p.buckets.push([t, 1]);
  p.buckets = p.buckets.filter(([at]) => at > p.lastSeen - SPAWN_WINDOW_MS);
}

/** No owner character names/IDs leave this board. Unknown fields stay null, including base ownership. */
export function computeSpawns(state, world, now) {
  const rows = [];
  for (const [id, p] of Object.entries(state.spawns || {})) {
    if (p.world !== world || p.lastSeen > now || now - p.lastSeen >= SPAWN_WINDOW_MS) continue;
    const recent = p.buckets.reduce((n, [t, count]) => n + (t > now - SPAWN_WINDOW_MS && t <= now ? count : 0), 0);
    const c = state.chars[p.owner];
    const outfit = c?.oid && now - c.at < 10 * 60_000 && (c.tag || c.on)
      ? { tag: c.tag || '', name: c.on || '', decal: null } : null;
    rows.push({ id, world, type: SPAWN_TYPES[p.type], faction: p.faction || c?.f || 0, zone: p.zone, facility: null,
      outfit, total: p.total, recent, spm: recent / 5, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
      deployedAt: null, lifespan: null });
  }
  rows.sort((a, b) => b.recent - a.recent || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
  return { world, now, windowMs: SPAWN_WINDOW_MS, rows: rows.slice(0, 25) };
}
