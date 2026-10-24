import WebSocket from 'ws';
import { KILL, TEAMKILL, SUICIDE } from './store.js';

const EVENTS = ['Death', 'PlayerLogin', 'PlayerLogout'];

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

/**
 * Keeps one streaming connection per environment alive. Reconnects with capped
 * backoff; a watchdog drops a connection that has gone silent for 90 s.
 */
export function connectStream({ env, worlds, serviceId, servers, onRecord, status }) {
  const url = `wss://push.planetside2.com/streaming?environment=${env}&service-id=s:${serviceId}`;
  let delay = 5000;

  const open = () => {
    const ws = new WebSocket(url);
    let watchdog;
    let resub;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), 90e3);
    };

    ws.on('open', () => {
      status[env] = 'connected';
      delay = 5000;
      kick();
      // Death is character-centric: Census only sends it with characters:["all"].
      const subscribe = () =>
        ws.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ service: 'event', action: 'subscribe', characters: ['all'], worlds: worlds.map(String), eventNames: EVENTS, logicalAndCharactersWithWorlds: true }));
      subscribe();
      resub = setInterval(subscribe, 10 * 60e3); // periodic resubscribe keeps the feed alive
    });
    ws.on('message', (buf) => {
      kick();
      let record = null;
      try {
        record = parseMessage(JSON.parse(buf.toString()), servers);
      } catch {
        return; // malformed frame: ignore, never crash the collector
      }
      if (record) onRecord(record);
    });
    ws.on('close', () => {
      clearInterval(resub);
      clearTimeout(watchdog);
      status[env] = 'reconnecting';
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 60e3);
    });
    ws.on('error', (err) => console.warn('stream error', env, err.message));
  };
  open();
}
