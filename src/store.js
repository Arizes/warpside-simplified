import fs from 'node:fs';
import path from 'node:path';

// Event tuple: [tsMs, world, attackerId, victimId, weaponId, flag, attackerTeam, victimTeam]
// flag: 0 kill, 1 teamkill, 2 suicide / environment. IDs are strings (64-bit in Census).
export const KILL = 0;
export const TEAMKILL = 1;
export const SUICIDE = 2;

/** The whole mutable state: a rolling event log plus small lookup caches. */
export function createState() {
  return {
    events: [], // ascending by ts
    online: {}, // characterId -> login ts
    chars: {}, // characterId -> { n, f, br, p, oid, tag, on }
    items: {}, // itemId -> { n, img }
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

export function loadState(file) {
  const state = createState();
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('state file unreadable, starting empty:', err.message);
  }
  return state;
}

/** Atomic write: temp file then rename, so a crash never leaves a half-written file. */
export async function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state));
  await fs.promises.rename(tmp, file);
}
