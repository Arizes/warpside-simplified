import { DurableObject } from 'cloudflare:workers';
import { createApi } from './api.js';
import { createLookups } from './census.js';
import { SERVERS, loadConfig, worldsByEnv } from './config.js';
import { applyRecord } from './ingest.js';
import { createState, packState, prune, unpackState } from './store.js';
import { parseMessage, streamUrl, subscribeMessage } from './stream.js';

const TICK_MS = 30_000; // keep-alive, watchdog and reconnect cadence
const SAVE_EVERY = 2; // ticks between snapshots
const LOOKUP_MS = 3000; // minimum gap between Census lookup batches
const STALE_MS = 90_000; // heartbeats arrive every ~30 s; silence means the socket is dead
const RESUBSCRIBE_MS = 10 * 60_000;
const SNAP_KEY = 'snap:';

/**
 * The single collector. It holds both stream connections, the rolling event log and the
 * API, and snapshots its state to Durable Object storage so a restart loses about a minute.
 * One object serves both servers because duration is billed per object, not per socket.
 */
export class Tracker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.config = loadConfig(env);
    this.byEnv = worldsByEnv();
    this.state = createState();
    this.status = {}; // env -> 'connected' | 'reconnecting'
    this.feed = {}; // world -> Daybreak event server up?
    this.sockets = {};
    this.connecting = {};
    this.lastMsg = {};
    this.lastSub = {};
    this.ticks = 0;
    this.dirty = false;
    this.savedChunks = 0;
    this.alarmSet = false;
    this.lookups = createLookups({ serviceId: this.config.serviceId, state: this.state });
    this.api = createApi({ state: this.state, config: this.config, status: this.status, feed: this.feed });
    this.lastFlush = 0;
    this.flushing = false;
    ctx.blockConcurrencyWhile(() => this.restore());
  }

  async restore() {
    const count = await this.ctx.storage.get(`${SNAP_KEY}count`);
    if (!count) return;
    const stored = await this.ctx.storage.get(Array.from({ length: count }, (_, i) => `${SNAP_KEY}${i}`));
    const restored = await unpackState([...stored.values()]);
    if (!restored) return console.warn('snapshot unreadable, starting empty');
    Object.assign(this.state, restored); // in place: the API and lookups hold this object
    prune(this.state, Date.now(), this.config.retainMs);
    this.savedChunks = count;
    console.log(`restored ${this.state.events.length} events`);
  }

  async persist() {
    if (!this.dirty) return;
    this.dirty = false;
    prune(this.state, Date.now(), this.config.retainMs);
    const chunks = await packState(this.state);
    const entries = { [`${SNAP_KEY}count`]: chunks.length };
    chunks.forEach((c, i) => (entries[`${SNAP_KEY}${i}`] = c));
    await this.ctx.storage.put(entries);
    const stale = [];
    for (let i = chunks.length; i < this.savedChunks; i++) stale.push(`${SNAP_KEY}${i}`);
    if (stale.length) await this.ctx.storage.delete(stale);
    this.savedChunks = chunks.length;
  }

  subscribe(env) {
    this.sockets[env]?.send(JSON.stringify(subscribeMessage(this.byEnv[env])));
    this.lastSub[env] = Date.now();
  }

  async connect(env) {
    if (this.sockets[env] || this.connecting[env]) return;
    this.connecting[env] = true;
    try {
      const res = await fetch(streamUrl(env, this.config.serviceId), { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`no websocket (HTTP ${res.status})`);
      ws.accept();
      this.sockets[env] = ws;
      this.lastMsg[env] = Date.now();
      this.status[env] = 'connected';
      ws.addEventListener('message', (ev) => this.onMessage(env, ev.data));
      const drop = () => {
        if (this.sockets[env] !== ws) return;
        delete this.sockets[env];
        this.status[env] = 'reconnecting';
      };
      ws.addEventListener('close', drop);
      ws.addEventListener('error', drop);
      this.subscribe(env);
    } catch (err) {
      this.status[env] = 'reconnecting'; // message only: the URL carries the service ID
      console.warn('stream connect failed:', err.message);
    } finally {
      this.connecting[env] = false;
    }
  }

  onMessage(env, data) {
    this.lastMsg[env] = Date.now();
    let record = null;
    try {
      record = parseMessage(JSON.parse(String(data)), SERVERS);
    } catch {
      return; // malformed frame: ignore, never crash the collector
    }
    if (record && applyRecord(this.state, this.lookups, this.feed, record)) this.dirty = true;
    this.maybeFlush();
  }

  /**
   * Resolves queued names and weapons. Driven by incoming events, not a timer: a timer
   * callback has no I/O context in a Durable Object, and events arrive constantly anyway.
   */
  maybeFlush() {
    if (this.flushing || Date.now() - this.lastFlush < LOOKUP_MS) return;
    this.flushing = true;
    this.lastFlush = Date.now();
    this.ctx.waitUntil(
      this.lookups.flush().finally(() => {
        this.flushing = false;
        this.dirty = true;
      }),
    );
  }

  async connectAll() {
    await Promise.all(Object.keys(this.byEnv).map((env) => this.connect(env)));
  }

  /** Idempotent: opens any missing connection and makes sure the keep-alive alarm is set. */
  async ensure() {
    await this.connectAll();
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    this.ticks++;
    const now = Date.now();
    for (const [env, ws] of Object.entries(this.sockets)) {
      if (now - this.lastMsg[env] > STALE_MS) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        delete this.sockets[env];
        this.status[env] = 'reconnecting';
      } else if (now - this.lastSub[env] > RESUBSCRIBE_MS) {
        this.subscribe(env); // periodic resubscribe keeps the feed alive
      }
    }
    try {
      await this.connectAll();
      if (this.ticks % SAVE_EVERY === 0) await this.persist();
    } catch (err) {
      console.error('tick failed:', err.message);
    }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(request) {
    if (!this.alarmSet) {
      await this.ensure();
      this.alarmSet = true;
    }
    return this.api(request);
  }
}
