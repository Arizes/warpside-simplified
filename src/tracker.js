import { DurableObject } from 'cloudflare:workers';
import { TICK_MS, createCollector } from './collector.js';
import { packState, unpackState } from './store.js';
import { streamUrl } from './stream.js';

const SNAP_KEY = 'snap:';
const STATIC_KEY = 'static:';
const MAP_KEY = 'map';

/** Durable Object storage as a collector store. Values are capped at 2 MB, so the snapshot is chunked. */
function doStore(storage) {
  let savedChunks = 0;
  return {
    async readState() {
      const count = await storage.get(`${SNAP_KEY}count`);
      if (!count) return null;
      const stored = await storage.get(Array.from({ length: count }, (_, i) => `${SNAP_KEY}${i}`));
      const restored = await unpackState([...stored.values()]);
      if (!restored) {
        console.warn('snapshot unreadable, starting empty');
        return null;
      }
      savedChunks = count;
      return restored;
    },
    async writeState(state) {
      const chunks = await packState(state);
      const entries = { [`${SNAP_KEY}count`]: chunks.length };
      chunks.forEach((c, i) => (entries[`${SNAP_KEY}${i}`] = c));
      await storage.put(entries);
      const stale = [];
      for (let i = chunks.length; i < savedChunks; i++) stale.push(`${SNAP_KEY}${i}`);
      if (stale.length) await storage.delete(stale);
      savedChunks = chunks.length;
    },
    // small (minutes of activity, a few hundred captures): one more row written per snapshot
    readMap: () => storage.get(MAP_KEY),
    writeMap: (snap) => storage.put(MAP_KEY, snap),
    readStatic: (key) => storage.get(STATIC_KEY + key),
    writeStatic: (key, geo) => storage.put(STATIC_KEY + key, geo),
  };
}

/**
 * The Cloudflare runtime wrapper: Durable Object storage, outbound WebSockets over fetch and the
 * keep-alive alarm. One object serves both servers because duration is billed per object, not per
 * socket. Retired in migration phase 4 (docs/ARCHITECTURE.md); the collector itself moves to Node.
 */
export class Tracker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.alarmSet = false;
    this.collector = createCollector({
      env,
      store: doStore(ctx.storage),
      openSocket: async (streamEnv, serviceId) => {
        const res = await fetch(streamUrl(streamEnv, serviceId), { headers: { Upgrade: 'websocket' } });
        const ws = res.webSocket;
        if (!ws) throw new Error(`no websocket (HTTP ${res.status})`);
        ws.accept();
        return ws;
      },
      waitUntil: (p) => ctx.waitUntil(p),
    });
    ctx.blockConcurrencyWhile(() => this.collector.restore());
  }

  async ensure() {
    await this.collector.ensure();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    await this.collector.tick();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(request) {
    if (!this.alarmSet) {
      await this.ensure();
      this.alarmSet = true;
    }
    return this.collector.api(request);
  }
}
