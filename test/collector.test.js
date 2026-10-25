import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCollector } from '../src/collector.js';
import { createNodeStore } from '../src/node-store.js';
import { streamUrl } from '../src/stream.js';

// Never the real Census: every lookup and ownership poll goes to this stub.
const stubFetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });

/** Minimal stand-in for the stream socket: records what was sent, lets a test push frames in. */
function fakeSocket() {
  const listeners = {};
  return {
    sent: [],
    closed: false,
    send(msg) {
      this.sent.push(JSON.parse(msg));
    },
    close() {
      this.closed = true;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    emit(type, ev) {
      for (const fn of listeners[type] || []) fn(ev);
    },
  };
}

const death = (ts, attacker = '5428010618035323201', victim = '5428010618035323202') =>
  JSON.stringify({
    service: 'event',
    type: 'serviceMessage',
    payload: {
      event_name: 'Death',
      world_id: '1000',
      zone_id: '2',
      timestamp: String(Math.floor(ts / 1000)),
      character_id: victim,
      attacker_character_id: attacker,
      attacker_weapon_id: '43',
      attacker_team_id: '1',
      team_id: '2',
    },
  });

function memoryStore() {
  const files = {};
  return {
    files,
    readState: async () => files.state ?? null,
    writeState: async (s) => (files.state = structuredClone(s)),
    readMap: async () => files.map,
    writeMap: async (m) => (files.map = structuredClone(m)),
    readStatic: async (k) => files[`static:${k}`] ?? null,
    writeStatic: async (k, g) => (files[`static:${k}`] = g),
  };
}

/** Builds a collector with one controllable socket per stream environment. */
async function harness(store = memoryStore()) {
  const sockets = {};
  const collector = createCollector({
    env: { CENSUS_SERVICE_ID: 'test' },
    store,
    openSocket: async (streamEnv) => (sockets[streamEnv] = fakeSocket()),
    fetchImpl: stubFetch,
  });
  await collector.restore();
  return { collector, sockets, store };
}

const get = async (collector, path) => (await collector.api(new Request(`http://local${path}`))).json();

test('streamUrl keeps https for Workers and takes wss for Node', () => {
  assert.ok(streamUrl('ps2ps4us', 'abc').startsWith('https://push.planetside2.com/'));
  assert.ok(streamUrl('ps2ps4us', 'abc', 'wss').startsWith('wss://push.planetside2.com/'));
  assert.equal(streamUrl('ps2ps4us', 'abc', 'wss').includes('service-id=s:abc'), true);
});

test('ensure subscribes on the socket it is given', async () => {
  const { collector, sockets } = await harness();
  await collector.ensure();
  assert.equal(sockets.ps2ps4us.sent.length, 3); // character events, world events, filtered spawn bonuses
  assert.deepEqual(sockets.ps2ps4us.sent[0].eventNames.includes('Death'), true);
  assert.deepEqual(sockets.ps2ps4us.sent[1].eventNames, ['FacilityControl']);
  assert.deepEqual(sockets.ps2ps4us.sent[2].eventNames, ['GainExperience_experience_id_233', 'GainExperience_experience_id_1410']);
  assert.equal((await get(collector, '/health')).streams.ps2ps4us, 'connected');
});

test('a death frame reaches the event log and the API', async () => {
  const { collector, sockets } = await harness();
  await collector.ensure();
  sockets.ps2ps4us.emit('message', { data: death(Date.now()) });
  assert.equal(collector.state.events.length, 1);
  assert.equal((await get(collector, '/health')).events, 1);
  const stats = await get(collector, '/api/stats?world=1000&window=24h');
  assert.equal(stats.events, 1);
  assert.equal(stats.players.find((p) => p.id === '5428010618035323201').k, 1);
});

test('ticks record a population sample per world from the characters online', async () => {
  const { collector, sockets } = await harness();
  await collector.ensure();
  sockets.ps2ps4us.emit('message', { data: death(Date.now()) });
  await collector.tick(); // the first tick only arms the cadence
  await collector.tick();
  const samples = collector.state.pop.filter((p) => p[1] === 1000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].slice(2).reduce((a, b) => a + b, 0) >= 0, true);
  const pop = await get(collector, '/api/population?world=1000&range=2h');
  assert.equal(pop.points.length, 2); // the recorded sample, then the live count
  assert.equal(pop.points.at(-1).t >= samples[0][0], true);
  assert.equal((await get(collector, '/api/population?world=1000&range=3h')).error, 'invalid world or range');
  const online = await get(collector, '/api/online?world=1000&empire=0');
  assert.equal(online.total, online.players.length);
  assert.equal((await get(collector, '/api/online?world=1000&empire=9')).error, 'invalid world or empire');
});

test('a malformed frame is ignored rather than fatal', async () => {
  const { collector, sockets } = await harness();
  await collector.ensure();
  sockets.ps2ps4us.emit('message', { data: 'not json' });
  sockets.ps2ps4us.emit('message', { data: '{"type":"serviceMessage"}' });
  assert.equal(collector.state.events.length, 0);
  assert.equal((await get(collector, '/health')).ok, true);
});

test('a dropped socket shows as reconnecting', async () => {
  const { collector, sockets } = await harness();
  await collector.ensure();
  sockets.ps2ps4us.emit('close', {});
  assert.equal((await get(collector, '/health')).streams.ps2ps4us, 'reconnecting');
});

test('shutdown saves the log and a new collector restores it', async () => {
  const store = memoryStore();
  const first = await harness(store);
  await first.collector.ensure();
  first.sockets.ps2ps4us.emit('message', { data: death(Date.now()) });
  await first.collector.shutdown();
  assert.equal(first.sockets.ps2ps4us.closed, true);

  const second = await harness(store);
  assert.equal(second.collector.state.events.length, 1);
  assert.equal((await get(second.collector, '/health')).events, 1);
});

test('the file store round-trips state, map and geometry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'warpside-store-'));
  try {
    const store = createNodeStore(dir);
    assert.equal(await store.readState(), null); // first boot
    assert.equal(await store.readMap(), undefined);

    const state = { events: [[1, 1000, '1', '2', '43', 0, 1, 2, 2]], online: {}, chars: {}, items: {}, outfits: {} };
    await store.writeState(state);
    assert.deepEqual((await store.readState()).events, state.events);

    await store.writeMap({ held: {}, charFac: {}, activity: {}, captures: [] });
    assert.deepEqual(await store.readMap(), { held: {}, charFac: {}, activity: {}, captures: [] });

    await store.writeStatic('ps2ps4us:v2:2', { hexes: [[0, 0, '1']], regions: {}, links: [] });
    assert.deepEqual((await store.readStatic('ps2ps4us:v2:2')).hexes, [[0, 0, '1']]);
    assert.equal(await store.readStatic('ps2ps4eu:v2:2'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
