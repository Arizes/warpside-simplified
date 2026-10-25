import { POP_RANGES, SERVERS, WINDOWS } from './config.js';
import { ZONES, busiestZone, computeMap, createMapState } from './map.js';
import { computePlayer, computeStats, onlineRoster, populationSeries } from './stats.js';

const CHAR_ID = /^\d{1,20}$/;
const MEMO_MS = 5000; // identical stats requests within this window share one computation

// Live boards are the same for everyone, so the edge may hold them briefly: many viewers polling
// at once then collapse into one origin request per window. `max-age=0` keeps each browser
// revalidating, so a viewer still sees data no more than a few seconds old.
const LIVE_CACHE = 'public, max-age=0, s-maxage=15';

const HEADERS = {
  'content-type': 'application/json',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Builds the JSON API as a (Request) => Response function. Dependencies are passed in
 * so tests run it without a Worker runtime, a stream or the network.
 * `map` is the map state; `statics.loaded(world)` returns the continent geometry already in memory and
 * `statics.get(world, zone)` loads one (from storage or Census).
 */
export function createApi({ state, config, status, feed, map = createMapState(), statics = { loaded: () => ({}), get: async () => null }, requestOutfit = () => {}, now = Date.now }) {
  const memo = new Map(); // `${world}:${window}` -> { at, body }

  const json = (code, obj, cache = 'no-store') =>
    new Response(JSON.stringify(obj), { status: code, headers: { ...HEADERS, 'cache-control': cache } });

  const parseWorld = (url) => {
    const world = Number(url.searchParams.get('world') || 1000);
    return SERVERS[world] ? world : null;
  };
  const parseWindow = (url) => {
    const key = url.searchParams.get('window') || '24h';
    return Object.hasOwn(WINDOWS, key) ? key : null;
  };
  const sinceOf = (key, t) => Math.max(t - WINDOWS[key], t - config.retainMs);
  const EMPIRES = new Set([0, 1, 2, 3, 4]);

  return async function handle(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method not allowed' });
    const url = new URL(request.url);
    const t = now();

    if (url.pathname === '/api/stats') {
      const world = parseWorld(url);
      const win = parseWindow(url);
      if (world === null || win === null) return json(400, { error: 'invalid world or window' });
      const key = `${world}:${win}`;
      const hit = memo.get(key);
      if (hit && t - hit.at < MEMO_MS) return json(200, hit.body, LIVE_CACHE);
      const server = SERVERS[world];
      const body = computeStats(state, world, sinceOf(win, t), t, {
        server: `${server.name} (${server.region})`,
        stream: status[server.env] || 'connecting',
        feedOnline: feed[world] ?? null,
        trackedSince: Math.max(state.events[0]?.[0] ?? t, t - config.retainMs),
      });
      memo.set(key, { at: t, body });
      return json(200, body, LIVE_CACHE);
    }
    if (url.pathname === '/api/population') {
      const world = parseWorld(url);
      const range = url.searchParams.get('range') || '2h';
      if (world === null || !Object.hasOwn(POP_RANGES, range)) return json(400, { error: 'invalid world or range' });
      // Samples outlive the event log, so this window is not clamped to retainMs.
      return json(200, { world, range, now: t, points: populationSeries(state, world, t - POP_RANGES[range], t) }, LIVE_CACHE);
    }
    if (url.pathname === '/api/online') {
      const world = parseWorld(url);
      const empire = Number(url.searchParams.get('empire') || 0);
      if (world === null || !EMPIRES.has(empire)) return json(400, { error: 'invalid world or empire' });
      return json(200, { world, empire, now: t, ...onlineRoster(state, world, empire) }, LIVE_CACHE);
    }
    if (url.pathname === '/api/player') {
      const world = parseWorld(url);
      const win = parseWindow(url);
      const id = url.searchParams.get('id') || '';
      if (world === null || win === null || !CHAR_ID.test(id)) return json(400, { error: 'invalid world, window or id' });
      const player = computePlayer(state, world, id, sinceOf(win, t), t);
      return player ? json(200, player, LIVE_CACHE) : json(404, { error: 'no activity for this character in the window' });
    }
    if (url.pathname === '/api/map' || url.pathname === '/api/map-static') {
      const world = parseWorld(url);
      const z = url.searchParams.get('zone');
      const zone = z === null ? busiestZone(map, state.events, world, t) : Number(z);
      if (world === null || !ZONES[zone]) return json(400, { error: 'invalid world or zone' });
      if (url.pathname === '/api/map') {
        return json(200, computeMap(map, statics.loaded(world), state.events, world, zone, t, (id) => state.outfits?.[id] || (requestOutfit(world, id), null)), LIVE_CACHE);
      }
      try {
        const geo = await statics.get(world, zone);
        // geometry never changes between game updates, so browsers and the edge may keep it for a day
        return geo ? json(200, geo, 'public, max-age=86400') : json(503, { error: 'map data unavailable' });
      } catch {
        return json(503, { error: 'map data unavailable' });
      }
    }
    if (url.pathname === '/api/servers') {
      return json(200, Object.entries(SERVERS).map(([id, s]) => ({ id: Number(id), name: s.name, region: s.region })), 'public, max-age=3600');
    }
    if (url.pathname === '/health') return json(200, { ok: true, streams: status, feed, events: state.events.length });
    return json(404, { error: 'not found' });
  };
}
