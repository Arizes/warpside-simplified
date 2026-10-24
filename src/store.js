// Event tuple: [tsMs, world, attackerId, victimId, weaponId, flag, attackerTeam, victimTeam, zone]
// (zone is missing on events saved before it was recorded; treat that as unknown.)
// flag: 0 kill, 1 teamkill, 2 suicide / environment. IDs are strings (64-bit in Census).
export const KILL = 0;
export const TEAMKILL = 1;
export const SUICIDE = 2;

// Durable Object storage values are limited to 2 MB, so a snapshot is split into chunks.
export const CHUNK_BYTES = 1_500_000;

/** The whole mutable state: a rolling event log plus small lookup caches. */
export function createState() {
  return {
    events: [], // ascending by ts
    online: {}, // characterId -> login ts
    chars: {}, // characterId -> { n, f, br, p, oid, tag, on }
    items: {}, // itemId -> { n, img }
    outfits: {}, // outfitId -> { tag, name } (for base captures on the map)
  };
}

/** Drops events older than the retention window, then caches nothing in the log still uses. */
export function prune(state, now, retainMs) {
  const cut = now - retainMs;
  let i = 0;
  while (i < state.events.length && state.events[i][0] < cut) i++;
  if (i) state.events.splice(0, i);

  const used = new Set(Object.keys(state.online));
  for (const e of state.events) {
    used.add(e[2]);
    used.add(e[3]);
  }
  for (const id of Object.keys(state.chars)) if (!used.has(id)) delete state.chars[id];
  const weapons = new Set(state.events.map((e) => e[4]));
  for (const id of Object.keys(state.items)) if (!weapons.has(id)) delete state.items[id];
  if (Object.keys(state.outfits || {}).length > 3000) state.outfits = {}; // a cache: refilled on demand
}

/** Index of the first event at or after `since` (events are time-ordered). */
export function firstIndexSince(events, since) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] < since) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Serialises and gzips the state, returning chunks small enough for Durable Object storage. */
export async function packState(state) {
  const gz = await pipe(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream('gzip'));
  const chunks = [];
  for (let i = 0; i < gz.length; i += CHUNK_BYTES) chunks.push(gz.slice(i, i + CHUNK_BYTES));
  return chunks;
}

/** Inverse of packState. Returns a plain state object, or null if the chunks are unusable. */
export async function unpackState(chunks) {
  try {
    const gz = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      gz.set(c, at);
      at += c.length;
    }
    const parsed = JSON.parse(new TextDecoder().decode(await pipe(gz, new DecompressionStream('gzip'))));
    return Array.isArray(parsed.events) ? { ...createState(), ...parsed } : null;
  } catch {
    return null; // corrupt snapshot: start empty rather than crash-loop
  }
}
