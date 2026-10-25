import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSpawns, noteSpawn, pruneSpawns, SPAWN_WINDOW_MS } from '../src/spawns.js';
import { parseMessage, subscribeMessages } from '../src/stream.js';
import { createState, packState, unpackState, prune } from '../src/store.js';
import { SERVERS } from '../src/config.js';
import { applyRecord } from '../src/ingest.js';
import { createApi } from '../src/api.js';
import { createLookups } from '../src/census.js';

const NOW = 1_700_000_000_000;
const frame = (over = {}) => ({ type: 'serviceMessage', payload: {
  event_name: 'GainExperience', world_id: '1000', zone_id: '2', timestamp: String(NOW / 1000),
  experience_id: '233', character_id: '5428000000000000001', other_id: '18446744073709551615',
  amount: '5', loadout_id: '1', ...over,
} });
const record = (over = {}) => ({ ...parseMessage(frame(), SERVERS, NOW), ...over });

test('observed PS4 spawn shape needs no team field and keeps NPC and owner IDs as strings', () => {
  const r = parseMessage(frame(), SERVERS, NOW);
  assert.equal(r.npc, '18446744073709551615');
  assert.equal(r.owner, '5428000000000000001');
  assert.equal(r.kind, 'spawn');
  assert.equal(r.faction, 2);
  assert.equal(parseMessage(frame({ loadout_id: '9' }), SERVERS, NOW).faction, 0);
  assert.equal(parseMessage(frame({ loadout_id: '28' }), SERVERS, NOW).faction, 4);
  assert.equal(parseMessage(frame({ experience_id: '1410' }), SERVERS, NOW).type, 1410);
  const instanced = parseMessage(frame({ zone_id: String((3 << 16) | 2) }), SERVERS, NOW);
  assert.equal(instanced.zone, 2);
  assert.equal(instanced.instance, (3 << 16) | 2);
});

test('unrelated XP, malformed NPCs, invalid timestamps and invalid zones cannot enter the board', () => {
  for (const over of [{ experience_id: '56' }, { experience_id: '355' }, { other_id: '0' },
    { other_id: 'bad' }, { character_id: 5428 }, { zone_id: '-1' }, { zone_id: '2.1' },
    { timestamp: 'Infinity' }, { timestamp: '0' }, { timestamp: String(NOW / 1000 + 61) }]) {
    assert.equal(parseMessage(frame(over), SERVERS, NOW), null, JSON.stringify(over));
  }
  const subscriptions = subscribeMessages([1000, 2000]);
  assert.equal(subscriptions.some((s) => s.eventNames.includes('GainExperience')), false);
  assert.deepEqual(subscriptions[2].worlds, ['1000', '2000']);
});

test('counts spawn events rather than XP amount and separates NPCs, worlds and zone instances', () => {
  const s = createState();
  const queue = [];
  const lookups = { requestCharacter: (...args) => queue.push(args) };
  applyRecord(s, lookups, {}, record());
  applyRecord(s, lookups, {}, record({ ts: NOW - 1000 }));
  for (const over of [{ npc: '22' }, { world: 2000 }, { instance: 65538 }]) noteSpawn(s, record(over));
  const rows = computeSpawns(s, 1000, NOW).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].spm, 2 / 5);
  assert.equal(computeSpawns(s, 2000, NOW).rows.length, 1);
  assert.deepEqual(queue[0], [1000, '5428000000000000001', true]);
});

test('recent activity decides rank, lifetime observed totals do not', () => {
  const s = createState();
  for (let i = 0; i < 20; i++) noteSpawn(s, record({ ts: NOW - SPAWN_WINDOW_MS - 1000 }));
  noteSpawn(s, record({ ts: NOW - SPAWN_WINDOW_MS + 1000 }));
  noteSpawn(s, record());
  noteSpawn(s, record({ npc: '22', ts: NOW - 1000 }));
  noteSpawn(s, record({ npc: '22', ts: NOW - 2000 }));
  noteSpawn(s, record({ npc: '22', ts: NOW - 3000 }));
  const rows = computeSpawns(s, 1000, NOW).rows;
  assert.equal(rows[0].id.endsWith(':22'), true);
  assert.equal(rows[1].total, 22);
  assert.equal(rows[1].recent, 2);
});

test('inactivity expires a point and its next observation starts a new session', () => {
  const s = createState();
  noteSpawn(s, record({ ts: NOW - SPAWN_WINDOW_MS }));
  assert.equal(computeSpawns(s, 1000, NOW).rows.length, 0);
  noteSpawn(s, record());
  assert.equal(computeSpawns(s, 1000, NOW).rows[0].total, 1);
  pruneSpawns(s, NOW + SPAWN_WINDOW_MS);
  assert.deepEqual(s.spawns, {});
});

test('only recent Census membership identifies the owner outfit, never territorial ownership', () => {
  const s = createState();
  noteSpawn(s, record());
  s.chars[record().owner] = { n: 'Never expose this player', f: 2, oid: '9', on: 'Outfit', tag: 'TAG', at: NOW };
  const [row] = computeSpawns(s, 1000, NOW).rows;
  assert.equal(row.faction, 2);
  assert.deepEqual(row.outfit, { name: 'Outfit', tag: 'TAG', decal: null });
  for (const key of ['facility', 'deployedAt', 'lifespan']) assert.equal(row[key], null);
  assert.equal(JSON.stringify(row).includes('Never expose'), false);
  assert.equal(JSON.stringify(row).includes(record().owner), false);
  s.chars[record().owner].at = NOW - 11 * 60_000;
  assert.equal(computeSpawns(s, 1000, NOW).rows[0].outfit, null);
});

test('active spawn owners survive cache pruning and counters survive a snapshot', async () => {
  const s = createState();
  noteSpawn(s, record());
  s.chars[record().owner] = { f: 2 };
  prune(s, NOW, 3600_000);
  assert.ok(s.chars[record().owner]);
  const restored = await unpackState(await packState(s));
  assert.deepEqual(computeSpawns(restored, 1000, NOW), computeSpawns(s, 1000, NOW));
});

test('the board bounds NPC count and returns only the top 25', () => {
  const s = createState();
  for (let i = 1; i <= 600; i++) noteSpawn(s, record({ npc: String(i) }));
  assert.equal(Object.keys(s.spawns).length, 512);
  assert.equal(computeSpawns(s, 1000, NOW).rows.length, 25);
});

test('spawn board shares existing stats request caching without adding per-viewer Census calls', async () => {
  const s = createState();
  noteSpawn(s, record());
  const api = createApi({ state: s, config: { retainMs: 3600_000 }, status: {}, feed: {}, now: () => NOW });
  const r = await api(new Request('https://test/api/stats?world=1000'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=15');
  assert.equal((await r.json()).spawns.rows[0].total, 1);
});

test('spawn owner membership refreshes in existing batches, cached for five minutes', async () => {
  const s = createState();
  const id = record().owner;
  s.chars[id] = { n: 'Old name', oid: '1', on: 'Old outfit' };
  let calls = 0;
  const lookup = createLookups({ serviceId: 'test', state: s, now: () => NOW, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ character_list: [{ character_id: id, name: { first: 'Current' },
      faction_id: '2', outfit: { outfit_id: '9', alias: 'NEW', name: 'New outfit' } }] }));
  } });
  lookup.requestCharacter(1000, id, true);
  await lookup.flush();
  assert.equal(s.chars[id].on, 'New outfit');
  assert.equal(s.chars[id].at, NOW);
  lookup.requestCharacter(1000, id, true);
  await lookup.flush();
  assert.equal(calls, 1);
});
