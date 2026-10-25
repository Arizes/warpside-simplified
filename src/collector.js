import { createApi } from './api.js';
import { createLookups, fetchOwnership, fetchZoneStatic } from './census.js';
import { SERVERS, loadConfig, worldsByEnv } from './config.js';
import { applyRecord } from './ingest.js';
import { ZONE_IDS, createMapState, mapSnapshot, pruneMap, restoreMap } from './map.js';
import { createState, prune } from './store.js';
import { parseMessage, subscribeMessages } from './stream.js';

export const TICK_MS = 30_000; // keep-alive, watchdog and reconnect cadence
const SAVE_EVERY = 2; // ticks between snapshots
const LOOKUP_MS = 3000; // minimum gap between Census lookup batches
const STALE_MS = 90_000; // heartbeats arrive every ~30 s; silence means the socket is dead
const RESUBSCRIBE_MS = 10 * 60_000;
const OWNERSHIP_EVERY = 4; // ticks between map ownership polls (2 minutes; FacilityControl fills the gaps)

/**
 * The collector: both stream connections, the rolling event log, the map and the API.
 * Runtime-neutral so the Durable Object and the Node server share one implementation.
 *
 * `store` persists state (see src/tracker.js and src/node-store.js for the two adapters).
 * `openSocket(env, serviceId)` resolves a ready socket with send/close/addEventListener.
 * `waitUntil(promise)` keeps background work alive where the runtime needs to be told.
 * `fetchImpl` is injected by tests so they never reach the real Census.
 */
export function createCollector({ env = {}, store, openSocket, waitUntil = (p) => p, fetchImpl = fetch }) {
  const config = loadConfig(env);
  const census = { serviceId: config.serviceId, fetchImpl };
  const byEnv = worldsByEnv();
  const state = createState();
  const status = {}; // env -> 'connected' | 'reconnecting'
  const feed = {}; // world -> Daybreak event server up?
  const map = createMapState();
  const sockets = {};
  const connecting = {};
  const lastMsg = {};
  const lastSub = {};
  const statics = {}; // `${ns}:${zone}` -> continent geometry
  const staticLoading = {};
  const facRegion = {}; // `${ns}:${zone}` -> { facilityId: regionId }
  const lookups = createLookups({ serviceId: config.serviceId, state, fetchImpl });

  let ticks = 0;
  let dirty = false;
  let lastFlush = 0;
  let flushing = false;
  let ownershipPolled = false;

  /**
   * Continent geometry, from memory, then the store, then Census (one-off, about 3 to 5 requests
   * per continent). It only changes with game updates; clear the stored copy to refresh.
   */
  function getStatic(ns, zone) {
    const key = `${ns}:${zone}`;
    if (statics[key]) return Promise.resolve(statics[key]);
    return (staticLoading[key] ||= (async () => {
      let geo = await store.readStatic(key);
      if (!geo) {
        geo = await fetchZoneStatic(census, ns, zone);
        await store.writeStatic(key, geo);
      }
      statics[key] = geo;
      const byFac = {};
      for (const [rid, r] of Object.entries(geo.regions)) if (r.fac) byFac[r.fac] = rid;
      facRegion[key] = byFac;
      return geo;
    })().finally(() => delete staticLoading[key]));
  }

  const regionOf = (world, zone, fac) => facRegion[`${SERVERS[world]?.ns}:${zone}`]?.[fac] || null;

  const api = createApi({
    state,
    config,
    status,
    feed,
    map,
    requestOutfit: (world, id) => lookups.requestOutfit(world, id), // names lost in a restart refill on demand
    statics: {
      loaded: (world) => Object.fromEntries(ZONE_IDS.map((z) => [z, statics[`${SERVERS[world].ns}:${z}`]]).filter(([, g]) => g)),
      get: (world, zone) => getStatic(SERVERS[world].ns, zone),
    },
  });

  async function restore() {
    restoreMap(map, await store.readMap());
    pruneMap(map, Date.now());
    const restored = await store.readState();
    if (!restored) return;
    Object.assign(state, restored); // in place: the API and lookups hold this object
    prune(state, Date.now(), config.retainMs);
    console.log(`restored ${state.events.length} events`);
  }

  async function persist() {
    if (!dirty) return;
    await store.writeMap(mapSnapshot(map));
    dirty = false;
    prune(state, Date.now(), config.retainMs);
    await store.writeState(state);
  }

  function subscribe(env_) {
    for (const msg of subscribeMessages(byEnv[env_])) sockets[env_]?.send(JSON.stringify(msg));
    lastSub[env_] = Date.now();
  }

  /**
   * Resolves queued names and weapons. Driven by incoming events, not a timer: a timer callback
   * has no I/O context in a Durable Object, and events arrive constantly anyway.
   */
  function maybeFlush() {
    if (flushing || Date.now() - lastFlush < LOOKUP_MS) return;
    flushing = true;
    lastFlush = Date.now();
    waitUntil(
      lookups.flush().finally(() => {
        flushing = false;
        dirty = true;
      }),
    );
  }

  function onMessage(env_, data) {
    lastMsg[env_] = Date.now();
    let record = null;
    try {
      record = parseMessage(JSON.parse(String(data)), SERVERS);
    } catch {
      return; // malformed frame: ignore, never crash the collector
    }
    if (record && applyRecord(state, lookups, feed, record, map, regionOf)) dirty = true;
    maybeFlush();
  }

  async function connect(env_) {
    if (sockets[env_] || connecting[env_]) return;
    connecting[env_] = true;
    try {
      const ws = await openSocket(env_, config.serviceId);
      sockets[env_] = ws;
      lastMsg[env_] = Date.now();
      status[env_] = 'connected';
      ws.addEventListener('message', (ev) => onMessage(env_, ev.data));
      const drop = () => {
        if (sockets[env_] !== ws) return;
        delete sockets[env_];
        status[env_] = 'reconnecting';
      };
      ws.addEventListener('close', drop);
      ws.addEventListener('error', drop);
      subscribe(env_);
    } catch (err) {
      status[env_] = 'reconnecting'; // message only: the URL carries the service ID
      console.warn('stream connect failed:', err.message);
    } finally {
      connecting[env_] = false;
    }
  }

  const connectAll = () => Promise.all(Object.keys(byEnv).map(connect));

  async function pollOwnership() {
    for (const world of Object.keys(SERVERS).map(Number)) {
      try {
        const owners = await fetchOwnership(census, SERVERS[world].ns, world, ZONE_IDS);
        map.owners[world] = { ...map.owners[world], ...owners };
      } catch (err) {
        console.warn('ownership poll failed:', err.message);
      }
    }
  }

  /** Idempotent: opens any missing connection and does the first ownership poll. */
  async function ensure() {
    await connectAll();
    if (!ownershipPolled) {
      ownershipPolled = true; // first poll right away, so a restart does not show a blank map
      waitUntil(pollOwnership());
    }
  }

  /** One watchdog cycle. Called from the Durable Object alarm or the Node interval. */
  async function tick() {
    ticks++;
    const now = Date.now();
    for (const [env_, ws] of Object.entries(sockets)) {
      if (now - lastMsg[env_] > STALE_MS) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        delete sockets[env_];
        status[env_] = 'reconnecting';
      } else if (now - lastSub[env_] > RESUBSCRIBE_MS) {
        subscribe(env_); // periodic resubscribe keeps the feed alive
      }
    }
    try {
      await connectAll();
      pruneMap(map, now);
      if (ticks % OWNERSHIP_EVERY === 1) await pollOwnership();
      if (ticks % SAVE_EVERY === 0) await persist();
    } catch (err) {
      console.error('tick failed:', err.message);
    }
  }

  /** Last snapshot before the process goes away, so a redeploy loses seconds rather than a minute. */
  async function shutdown() {
    for (const ws of Object.values(sockets)) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    dirty = true; // the log has moved on since the last tick even if no event flagged it
    await persist();
  }

  return { api, config, ensure, tick, persist, shutdown, restore, state, status, feed, map };
}
