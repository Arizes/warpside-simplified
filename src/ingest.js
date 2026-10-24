/**
 * Applies one parsed stream record to the state and queues the lookups it needs.
 * Kept separate from the Durable Object so it is tested without a runtime.
 */
export function applyRecord(state, lookups, feed, r) {
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
      return true;
    }
    default:
      return false;
  }
}
