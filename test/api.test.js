import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { createLookups } from '../src/census.js';
import { applyRecord } from '../src/ingest.js';
import { createState } from '../src/store.js';

const NOW = 1_700_000_000_000;

function setup() {
  const state = createState();
  state.events = [[NOW - 1000, 1000, '1', '2', '80', 0, 1, 2]];
  state.chars = { 1: { n: '<img src=x onerror=alert(1)>', f: 1, br: 1, p: 0, oid: null, tag: '', on: '' }, 2: { n: 'V', f: 2 } };
  state.items = { 80: { n: 'Gauss', img: '/files/ps2/images/static/1.png' } };
  const api = createApi({ state, config: { retainMs: 24 * 3600e3 }, status: { ps2ps4us: 'connected' }, feed: { 1000: true }, now: () => NOW });
  return { state, api };
}
const get = (api, path, method = 'GET') => api(new Request(`https://x.test${path}`, { method }));

test('stats are served for a valid world and window', async () => {
  const { api } = setup();
  const r = await get(api, '/api/stats?world=1000&window=24h');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=15');
  const body = await r.json();
  assert.equal(body.stream, 'connected');
  assert.equal(body.players[0].k, 1);
  assert.equal(body.players[0].weaponImg, '/files/ps2/images/static/1.png');
});

test('all live endpoints agree on online sessions regardless of leaderboard window', async () => {
  const { state, api } = setup();
  state.online = { 2: NOW - 1000, 9: NOW - 1000, 10: NOW - 1000 };
  state.onlineW = { 2: 1000, 9: 1000, 10: 2000 };
  const roster = await (await get(api, '/api/online?world=1000')).json();
  const pop = await (await get(api, '/api/population?world=1000')).json();
  assert.equal(roster.total, 2); // includes a character with no faction lookup, excludes the other world
  assert.equal(pop.points.at(-1).total, roster.total);
  for (const window of ['1h', '6h', '24h']) {
    const stats = await (await get(api, `/api/stats?world=1000&window=${window}`)).json();
    assert.equal(stats.onlinePlayers, roster.total);
    assert.equal(stats.activePlayers, roster.total);
    assert.equal(stats.windowPlayers, 1); // the killer has logged off, but remains on the board
  }
});

test('unknown world or window is a 400, never a crash', async () => {
  const { api } = setup();
  for (const q of ['world=1', 'world=abc', 'window=999d', 'world=1000&window=__proto__']) {
    assert.equal((await get(api, `/api/stats?${q}`)).status, 400, q);
  }
});

test('player endpoint validates the character id', async () => {
  const { api } = setup();
  assert.equal((await get(api, "/api/player?world=1000&id=1';DROP")).status, 400);
  assert.equal((await get(api, '/api/player?world=1000&id=999')).status, 404);
  assert.equal((await get(api, '/api/player?world=1000&id=1')).status, 200);
});

test('only GET and HEAD are accepted and unknown paths are 404', async () => {
  const { api } = setup();
  assert.equal((await get(api, '/api/stats', 'POST')).status, 405);
  assert.equal((await get(api, '/api/other')).status, 404);
  assert.equal((await get(api, '/server.js')).status, 404);
});

test('identical stats requests inside the memo window share one computation', async () => {
  const { api, state } = setup();
  const first = await (await get(api, '/api/stats?world=1000&window=24h')).json();
  state.events.push([NOW - 500, 1000, '1', '2', '80', 0, 1, 2]);
  const second = await (await get(api, '/api/stats?world=1000&window=24h')).json();
  assert.equal(second.players[0].k, first.players[0].k);
});

test('death, login and logout records update the state; feed records do not mark it dirty', () => {
  const state = createState();
  const queued = [];
  const lookups = { request: (w, x) => queued.push(['r', w, x]), requestCharacter: (w, id) => queued.push(['c', w, id]) };
  const feed = {};
  assert.equal(applyRecord(state, lookups, feed, { kind: 'login', world: 1000, ts: 5, id: '9' }), true);
  assert.equal(state.online['9'], 5);
  assert.equal(state.onlineW['9'], 1000);
  assert.equal(applyRecord(state, lookups, feed, { kind: 'death', world: 1000, event: [6, 1000, '9', '8', '80', 0, 1, 2] }), true);
  assert.equal(state.events.length, 1);
  assert.equal(state.online['8'], 6); // the victim was online even though its login was never seen
  assert.equal(state.online['9'], 5); // and a login already recorded is not overwritten
  assert.deepEqual(queued[1], ['r', 1000, { attacker: '9', victim: '8', weapon: '80' }]);
  assert.equal(applyRecord(state, lookups, feed, { kind: 'logout', world: 1000, ts: 7, id: '9' }), true);
  assert.equal(state.online['9'], undefined);
  assert.equal(state.onlineW['9'], undefined);
  assert.equal(applyRecord(state, lookups, feed, { kind: 'feed', feeds: { 1000: true } }), false);
  assert.deepEqual(feed, { 1000: true });
});

test('census lookups ignore malformed ids and cache results', async () => {
  const state = createState();
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    return { ok: true, json: async () => ({ character_list: [{ character_id: '5', name: { first: 'Zed' }, faction_id: '2', battle_rank: { value: '40' } }] }) };
  };
  const lookups = createLookups({ serviceId: 'sid', state, fetchImpl });
  lookups.request(1000, { attacker: '5', victim: '1 OR 2', weapon: '0' });
  await lookups.flush();
  assert.equal(state.chars['5'].n, 'Zed');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('character_id=5&'));
});

test('a failed lookup backs off instead of hammering Census', async () => {
  const state = createState();
  let calls = 0;
  let t = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 503 };
  };
  const lookups = createLookups({ serviceId: 'sid', state, fetchImpl, now: () => t });
  lookups.request(1000, { attacker: '5', victim: '6', weapon: '7' });
  await lookups.flush();
  await lookups.flush();
  assert.equal(calls, 1);
  t = 31e3;
  await lookups.flush();
  assert.equal(calls, 2);
});

test('map endpoints validate the zone, cache geometry for a day and ask for unknown outfit names', async () => {
  const { state } = setup();
  const asked = [];
  const map = { owners: { 1000: { 2: { 10: 1 } } }, held: { 1000: { A: { f: 1, oid: '42', t: NOW - 1000 } } }, charFac: {}, activity: [], captures: [] };
  const geo = { hexes: [[0, 0, '10']], regions: { 10: { fac: 'A' } }, links: [] };
  const api = createApi({ state, config: { retainMs: 24 * 3600e3 }, status: {}, feed: {}, map, statics: { loaded: () => ({ 2: geo }), get: async (w, z) => (z === 2 ? geo : null) }, requestOutfit: (w, id) => asked.push([w, id]), now: () => NOW });
  assert.equal((await get(api, '/api/map?world=1000&zone=99')).status, 400);
  assert.equal((await get(api, '/api/map?world=1000&zone=abc')).status, 400);
  const m = await (await get(api, '/api/map?world=1000&zone=2')).json();
  assert.equal(m.owners[10], 1);
  assert.deepEqual(m.held.A.outfit, { id: '42', tag: '', name: '' });
  assert.deepEqual(asked, [[1000, '42']]);
  const s = await get(api, '/api/map-static?world=1000&zone=2');
  assert.equal(s.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal((await get(api, '/api/map-static?world=1000&zone=4')).status, 503);
});

test('live endpoints are edge-cacheable for seconds; health never is', async () => {
  const { api } = setup();
  const LIVE = 'public, max-age=0, s-maxage=15';
  for (const path of ['/api/stats?world=1000&window=24h', '/api/player?world=1000&id=1']) {
    assert.equal((await get(api, path)).headers.get('cache-control'), LIVE, path);
  }
  // served from the memo rather than recomputed, and still carries the same policy
  assert.equal((await get(api, '/api/stats?world=1000&window=24h')).headers.get('cache-control'), LIVE);

  // the platform health check must always reach the origin, and errors must not be cached
  assert.equal((await get(api, '/health')).headers.get('cache-control'), 'no-store');
  assert.equal((await get(api, '/api/stats?world=1')).headers.get('cache-control'), 'no-store');
  assert.equal((await get(api, '/api/player?world=1000&id=999')).headers.get('cache-control'), 'no-store');
});
