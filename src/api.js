import { SERVERS, WINDOWS } from './config.js';
import { computePlayer, computeStats } from './stats.js';

const CHAR_ID = /^\d{1,20}$/;
const MEMO_MS = 5000; // identical stats requests within this window share one computation

const HEADERS = {
  'content-type': 'application/json',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Builds the JSON API as a (Request) => Response function. Dependencies are passed in
 * so tests run it without a Worker runtime, a stream or the network.
 */
export function createApi({ state, config, status, feed, now = Date.now }) {
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
      if (hit && t - hit.at < MEMO_MS) return json(200, hit.body);
      const server = SERVERS[world];
      const body = computeStats(state, world, sinceOf(win, t), t, {
        server: `${server.name} (${server.region})`,
        stream: status[server.env] || 'connecting',
        feedOnline: feed[world] ?? null,
        trackedSince: Math.max(state.events[0]?.[0] ?? t, t - config.retainMs),
      });
      memo.set(key, { at: t, body });
      return json(200, body);
    }
    if (url.pathname === '/api/player') {
      const world = parseWorld(url);
      const win = parseWindow(url);
      const id = url.searchParams.get('id') || '';
      if (world === null || win === null || !CHAR_ID.test(id)) return json(400, { error: 'invalid world, window or id' });
      const player = computePlayer(state, world, id, sinceOf(win, t), t);
      return player ? json(200, player) : json(404, { error: 'no activity for this character in the window' });
    }
    if (url.pathname === '/api/servers') {
      return json(200, Object.entries(SERVERS).map(([id, s]) => ({ id: Number(id), name: s.name, region: s.region })), 'public, max-age=3600');
    }
    if (url.pathname === '/health') return json(200, { ok: true, streams: status, feed, events: state.events.length });
    return json(404, { error: 'not found' });
  };
}
