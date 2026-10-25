import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { TICK_MS, createCollector } from './collector.js';
import { createNodeStore } from './node-store.js';
import { streamUrl } from './stream.js';

// Phase 1 of docs/ARCHITECTURE.md: the collector as a plain Node process, ready for Railway.
// Static files are served here for local use and as a fallback; in production Cloudflare serves
// them from its edge and only /api/* and /health reach this process.

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || './data';
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || './public');
const ORIGIN_SECRET = process.env.ORIGIN_SECRET || ''; // set once Cloudflare fronts the API (phase 4)
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || ''; // e.g. https://warpside2.com, for CORS
const SHUTDOWN_MS = 10_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

// Mirrors public/_headers, which Cloudflare applies to the same files.
const csp = () =>
  [
    "default-src 'self'",
    'img-src \'self\' https://census.daybreakgames.com data:',
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "script-src 'self'",
    `connect-src 'self'${process.env.API_ORIGIN ? ` ${process.env.API_ORIGIN}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

const SECURITY = {
  'content-security-policy': csp(),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Constant-time compare that tolerates different lengths. */
function secretOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ORIGIN_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolves a URL path inside PUBLIC_DIR, or null if it escapes or is not a plain file path. */
function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // invalid percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const rel = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^[/\\]+/, '');
  const full = join(PUBLIC_DIR, rel);
  return full === PUBLIC_DIR || full.startsWith(PUBLIC_DIR + sep) ? full : null;
}

function cacheFor(path) {
  if (path.endsWith('.html')) return 'no-cache';
  // Tiles and sounds are content-addressed by the pinned asset commit and never change in place.
  if (path.includes(`${sep}maps${sep}`) || path.includes(`${sep}audio${sep}`)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

async function serveStatic(req, res, pathname) {
  const path = resolveStatic(pathname);
  if (!path) return send(res, 404, 'not found');
  let info;
  try {
    info = await stat(path);
  } catch {
    return send(res, 404, 'not found');
  }
  if (!info.isFile()) return send(res, 404, 'not found');
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, {
    ...SECURITY,
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cacheFor(path),
  });
  if (req.method === 'HEAD') return res.end();
  try {
    await pipeline(createReadStream(path), res);
  } catch {
    res.destroy(); // client went away mid-transfer
  }
}

function send(res, code, text) {
  const body = Buffer.from(`${text}\n`);
  res.writeHead(code, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function main() {
  const collector = createCollector({
    env: process.env,
    store: createNodeStore(DATA_DIR),
    openSocket: (streamEnv, serviceId) =>
      new Promise((ok, fail) => {
        const ws = new WebSocket(streamUrl(streamEnv, serviceId, 'wss'));
        const onOpen = () => {
          ws.removeEventListener('error', onError);
          ok(ws);
        };
        // the URL carries the service ID, so never include the event or the URL in the error
        const onError = () => {
          ws.removeEventListener('open', onOpen);
          fail(new Error('websocket failed to open'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
      }),
    // No I/O context to keep alive in Node: just make sure a rejection is never silent.
    waitUntil: (p) => Promise.resolve(p).catch((err) => console.warn('background task failed:', err.message)),
  });

  await collector.restore();

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url || '/', 'http://local'); // fixed base: the Host header is untrusted
    if (pathname.startsWith('/api/') || pathname === '/health') {
      // /health stays open so the platform health check and `docker compose` can reach it
      if (ORIGIN_SECRET && pathname !== '/health' && !secretOk(req.headers['x-origin-secret'])) {
        return send(res, 403, 'forbidden');
      }
      return collector
        .api(new Request(`http://local${req.url}`, { method: req.method }))
        .then(async (response) => {
          const headers = Object.fromEntries(response.headers);
          if (PUBLIC_ORIGIN) {
            headers['access-control-allow-origin'] = PUBLIC_ORIGIN;
            headers.vary = 'origin';
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.writeHead(response.status, { ...headers, 'content-length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
        })
        .catch((err) => {
          console.error('request failed:', err.message);
          if (!res.headersSent) send(res, 500, 'internal error');
        });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, pathname);
  });

  // Without this an EADDRINUSE arrives as an unhandled 'error' event and the stack names the port twice.
  server.on('error', (err) => {
    console.error(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, () => console.log(`listening on ${PORT}`));

  await collector.ensure();
  const timer = setInterval(() => collector.tick().catch((err) => console.error('tick failed:', err.message)), TICK_MS);

  let closing = false;
  const stop = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
    clearInterval(timer);
    server.close();
    try {
      await collector.shutdown();
    } catch (err) {
      console.error('shutdown save failed:', err.message);
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error('failed to start:', err.message);
  process.exit(1);
});
