import fs from 'node:fs';
import path from 'node:path';
import { SERVERS, WINDOWS } from './config.js';
import { computePlayer, computeStats } from './stats.js';

const CENSUS = 'https://census.daybreakgames.com';
const FACTION_IMAGE = { 1: '94', 2: '12', 3: '18', 4: '93615' }; // Census image ids
const IMAGE_PATH = /^\/files\/ps2\/images\/static\/\d+\.png$/;
const CHAR_ID = /^\d{1,20}$/;
const MAX_IMAGES = 600;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * Builds the request handler. All dependencies are passed in so tests can run it
 * without a socket, a stream or the network.
 */
export function createHandler({ state, config, status, feed, publicDir, now = Date.now, fetchImpl = fetch }) {
  const images = new Map(); // key -> { type, body } (bounded)

  const send = (res, code, type, body, extra = {}) => {
    res.writeHead(code, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };
  const json = (res, code, obj, cache = 'no-store') => send(res, code, 'application/json', JSON.stringify(obj), { 'cache-control': cache });

  function parseWorld(url) {
    const world = Number(url.searchParams.get('world') || 1000);
    return SERVERS[world] ? world : null;
  }
  function parseSince(url, t) {
    const key = url.searchParams.get('window') || '24h';
    if (!Object.hasOwn(WINDOWS, key)) return null;
    return Math.max(t - WINDOWS[key], t - config.retainMs);
  }

  async function image(res, key, imagePath) {
    let hit = images.get(key);
    if (!hit) {
      try {
        const r = await fetchImpl(CENSUS + imagePath, { signal: AbortSignal.timeout(10000) });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error(`HTTP ${r.status}`);
        hit = { type: 'image/png', body: Buffer.from(await r.arrayBuffer()) };
      } catch {
        return send(res, 404, 'text/plain', 'not found');
      }
      if (images.size >= MAX_IMAGES) images.delete(images.keys().next().value);
      images.set(key, hit);
    }
    return send(res, 200, hit.type, hit.body, { 'cache-control': 'public, max-age=86400' });
  }

  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET, HEAD' });
    const url = new URL(req.url, 'http://localhost');
    const t = now();

    if (url.pathname === '/api/stats') {
      const world = parseWorld(url);
      const since = parseSince(url, t);
      if (world === null || since === null) return json(res, 400, { error: 'invalid world or window' });
      const server = SERVERS[world];
      return json(res, 200, computeStats(state, world, since, t, {
        server: `${server.name} (${server.region})`,
        stream: status[server.env] || 'connecting',
        feedOnline: feed[world] ?? null,
        trackedSince: Math.max(state.events[0]?.[0] ?? t, t - config.retainMs),
      }));
    }
    if (url.pathname === '/api/player') {
      const world = parseWorld(url);
      const since = parseSince(url, t);
      const id = url.searchParams.get('id') || '';
      if (world === null || since === null || !CHAR_ID.test(id)) return json(res, 400, { error: 'invalid world, window or id' });
      const player = computePlayer(state, world, id, since, t);
      return player ? json(res, 200, player) : json(res, 404, { error: 'no activity for this character in the window' });
    }
    if (url.pathname === '/api/servers') {
      return json(res, 200, Object.entries(SERVERS).map(([id, s]) => ({ id: Number(id), name: s.name, region: s.region })), 'public, max-age=3600');
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, streams: status, feed, events: state.events.length });

    const faction = /^\/img\/faction\/([1-4])$/.exec(url.pathname);
    if (faction) return image(res, `f${faction[1]}`, `/files/ps2/images/static/${FACTION_IMAGE[faction[1]]}.png`);
    const item = /^\/img\/item\/(\d{1,12})$/.exec(url.pathname);
    if (item) {
      const imagePath = state.items[item[1]]?.img;
      if (!imagePath || !IMAGE_PATH.test(imagePath)) return send(res, 404, 'text/plain', 'not found');
      return image(res, `i${item[1]}`, imagePath);
    }

    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, 'text/plain', 'not found');
    try {
      return send(res, 200, file[1], fs.readFileSync(path.join(publicDir, file[0])), { 'cache-control': 'no-cache' });
    } catch {
      return send(res, 404, 'text/plain', 'not found');
    }
  };
}
