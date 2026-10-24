import { noteControl, noteDeath, noteFacility } from './map.js';

/**
 * Applies one parsed stream record to the state and queues the lookups it needs.
 * Kept separate from the Durable Object so it is tested without a runtime.
 * `map` is the map state; `regionOf(world, zone, facilityId)` resolves a base to its map region.
 * Returns true when something worth snapshotting changed.
 */
export function applyRecord(state, lookups, feed, r, map = null, regionOf = () => null) {
  switch (r.kind) {
    case 'feed':
      Object.assign(feed, r.feeds);
      return false;
    case 'login':
      state.online[r.id] = r.ts;
      lookups.requestCharacter(r.world, r.id);
      return true;
    case 'logout':
      delete state.online[r.id];
      return true;
    case 'death': {
      const [, world, attacker, victim, weapon] = r.event;
      state.events.push(r.event);
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
      return false;
    default:
      return false;
  }
}
