import { noteControl, noteDeath, noteFacility } from './map.js';
import { noteSpawn } from './spawns.js';

/**
 * A character in a kill event is online whether or not we saw its login (the stream only starts
 * when the tracker does). Their real logout still removes them.
 */
function markOnline(state, world, id, ts) {
  if (!id || id === '0' || Object.hasOwn(state.online, id)) return;
  state.online[id] = ts;
  (state.onlineW ||= {})[id] = world;
  (state.onlineSeen ||= {})[id] = 1; // they were already playing, so playtime from here is a floor
}

/**
 * Applies one parsed stream record to the state and queues the lookups it needs.
 * Kept separate from the Durable Object so it is tested without a runtime.
 * `map` is the map state; `regionOf(world, zone, facilityId)` resolves a base to its map region.
 * Returns true when something worth snapshotting changed.
 */
export function applyRecord(state, lookups, feed, r, map = null, regionOf = () => null) {
  switch (r.kind) {
    case 'spawn':
      noteSpawn(state, r);
      lookups.requestCharacter(r.world, r.owner, true);
      return true;
    case 'feed':
      Object.assign(feed, r.feeds);
      return false;
    case 'login':
      state.online[r.id] = r.ts;
      (state.onlineW ||= {})[r.id] = r.world;
      delete state.onlineSeen?.[r.id]; // we watched this session start, so its length is exact
      lookups.requestCharacter(r.world, r.id);
      return true;
    case 'logout':
      delete state.online[r.id];
      delete state.onlineW?.[r.id];
      delete state.onlineSeen?.[r.id];
      return true;
    case 'death': {
      const [, world, attacker, victim, weapon] = r.event;
      state.events.push(r.event);
      markOnline(state, world, attacker, r.event[0]);
      markOnline(state, world, victim, r.event[0]);
      lookups.request(world, { attacker, victim, weapon });
      if (map) noteDeath(map, r.event);
      return true;
    }
    case 'facility':
      if (map) noteFacility(map, r, state.chars[r.id]?.f || 0);
      lookups.requestCharacter(r.world, r.id);
      return false;
    case 'control':
      if (map) noteControl(map, r, regionOf(r.world, r.zone, r.fac));
      if (r.outfit && r.from !== r.to) lookups.requestOutfit?.(r.world, r.outfit);
      return false;
    default:
      return false;
  }
}
