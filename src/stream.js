import { KILL, TEAMKILL, SUICIDE } from './store.js';

const EVENTS = ['Death', 'PlayerLogin', 'PlayerLogout'];

/** Workers open outbound WebSockets with fetch, which takes an https URL plus an Upgrade header. */
export function streamUrl(env, serviceId) {
  return `https://push.planetside2.com/streaming?environment=${env}&service-id=s:${serviceId}`;
}

/** Death is character-centric: Census only sends it with characters:["all"]. */
export function subscribeMessage(worlds) {
  return {
    service: 'event',
    action: 'subscribe',
    characters: ['all'],
    worlds: worlds.map(String),
    eventNames: EVENTS,
    logicalAndCharactersWithWorlds: true,
  };
}

/**
 * Turns one raw streaming message into a small normalised record, or null.
 * Pure: no I/O, so it is tested against recorded message shapes.
 */
export function parseMessage(m, servers, nowMs = Date.now()) {
  // Verified live on ps2ps4us: a state change names every endpoint in one string,
  // e.g. "EventServerEndpoint_1000_Genudine_1001_Palos_1002_Crux", so collect all world ids.
  const worldsOf = (key) => [...String(key).matchAll(/_(\d+)_[A-Za-z]+/g)].map((x) => Number(x[1])).filter((w) => servers[w]);
  if (m.type === 'heartbeat' && m.online) {
    const feeds = {};
    for (const k of Object.keys(m.online)) for (const w of worldsOf(k)) feeds[w] = String(m.online[k]) === 'true';
    return { kind: 'feed', feeds };
  }
  if (m.type === 'serviceStateChanged' && m.detail) {
    const up = String(m.online) === 'true';
    const feeds = Object.fromEntries(worldsOf(m.detail).map((w) => [w, up]));
    return Object.keys(feeds).length ? { kind: 'feed', feeds } : null;
  }
  if (m.type !== 'serviceMessage' || !m.payload) return null;

  const p = m.payload;
  const world = Number(p.world_id);
  if (!servers[world]) return null;
  const ts = (Number(p.timestamp) || nowMs / 1000) * 1000;

  if (p.event_name === 'PlayerLogin') return { kind: 'login', world, ts, id: p.character_id };
  if (p.event_name === 'PlayerLogout') return { kind: 'logout', world, ts, id: p.character_id };
  if (p.event_name !== 'Death') return null;

  const attacker = p.attacker_character_id;
  const victim = p.character_id;
  let flag = KILL;
  if (!attacker || attacker === '0' || attacker === victim) flag = SUICIDE;
  else if (p.attacker_team_id && p.attacker_team_id === p.team_id) flag = TEAMKILL;
  return {
    kind: 'death',
    world,
    ts,
    event: [ts, world, attacker || '0', victim, p.attacker_weapon_id || '0', flag, Number(p.attacker_team_id) || 0, Number(p.team_id) || 0],
  };
}
