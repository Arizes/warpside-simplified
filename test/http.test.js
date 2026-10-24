import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../src/http.js';
import { createLookups } from '../src/census.js';
import { createState } from '../src/store.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const NOW = 1_700_000_000_000;

function setup(over = {}) {
  const state = createState();
  state.events = [[NOW - 1000, 1000, '1', '2', '80', 0, 1, 2]];
  state.chars = { 1: { n: '<img src=x onerror=alert(1)>', f: 1, br: 1, p: 0, oid: null, tag: '', on: '' }, 2: { n: 'V', f: 2 } };
  state.items = { 80: { n: 'Gauss', img: '/files/ps2/images/static/1.png' }, 81: { n: 'Bad', img: 'https://evil.example/x.png' } };
  const handle = createHandler({ state, config: { retainMs: 24 * 3600e3 }, status: { ps2ps4us: 'connected' }, feed: { 1000: true }, publicDir, now: () => NOW, ...over });
  return { state, handle };
}
async function get(handle, url, method = 'GET') {
  const out = { status: 0, headers: {}, body: '' };
  const res = { writeHead: (c, h) => { out.status = c; out.headers = h; }, end: (b) => { out.body = b?.toString() ?? ''; } };
  await handle({ method, url }, res);
  return out;
}

test('stats are served for a valid world and window', async () => {
  const { handle } = setup();
  const r = await get(handle, '/api/stats?world=1000&window=24h');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.stream, 'connected');
  assert.equal(body.players[0].k, 1);
});

test('unknown world or window is a 400, never a crash', async () => {
  const { handle } = setup();
  for (const q of ['world=1', 'world=abc', 'window=999d', 'world=1000&window=__proto__']) {
    assert.equal((await get(handle, `/api/stats?${q}`)).status, 400, q);
  }
});

test('player endpoint validates the character id', async () => {
  const { handle } = setup();
  assert.equal((await get(handle, "/api/player?world=1000&id=1';DROP")).status, 400);
  assert.equal((await get(handle, '/api/player?world=1000&id=999')).status, 404);
  assert.equal((await get(handle, '/api/player?world=1000&id=1')).status, 200);
});

test('responses carry a strict CSP and nosniff', async () => {
  const { handle } = setup();
  const r = await get(handle, '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('only GET and HEAD are accepted; unknown paths and path tricks are 404', async () => {
  const { handle } = setup();
  assert.equal((await get(handle, '/api/stats', 'POST')).status, 405);
  assert.equal((await get(handle, '/../package.json')).status, 404);
  assert.equal((await get(handle, '/server.js')).status, 404);
});

test('item images are only fetched from Census static image paths', async () => {
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new ArrayBuffer(4) }; };
  const { handle } = setup({ fetchImpl });
  assert.equal((await get(handle, '/img/item/80')).status, 200);
  assert.equal((await get(handle, '/img/item/81')).status, 404); // off-site path in cache
  assert.equal((await get(handle, '/img/item/999')).status, 404);
  assert.deepEqual(calls, ['https://census.daybreakgames.com/files/ps2/images/static/1.png']);
});

test('census lookups ignore malformed ids and cache results', async () => {
  const state = createState();
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return { ok: true, json: async () => ({ character_list: [{ character_id: '5', name: { first: 'Zed' }, faction_id: '2', battle_rank: { value: '40' } }] }) }; };
  const lookups = createLookups({ serviceId: 'sid', state, fetchImpl });
  lookups.request(1000, { attacker: '5', victim: "1 OR 2", weapon: '0' });
  await lookups.flush();
  assert.equal(state.chars['5'].n, 'Zed');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('character_id=5&'));
});

test('a failed lookup backs off instead of hammering Census', async () => {
  const state = createState();
  let calls = 0;
  let t = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503 }; };
  const lookups = createLookups({ serviceId: 'sid', state, fetchImpl, now: () => t });
  lookups.request(1000, { attacker: '5', victim: '6', weapon: '7' });
  await lookups.flush();
  await lookups.flush();
  assert.equal(calls, 1);
  t = 31e3;
  await lookups.flush();
  assert.equal(calls, 2);
});
