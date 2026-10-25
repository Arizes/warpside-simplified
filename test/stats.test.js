import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlayer, computeStats, onlineByFaction, populationSample } from '../src/stats.js';
import { CHUNK_BYTES, createState, firstIndexSince, packState, prune, unpackState } from '../src/store.js';

const HOUR = 3600e3;
const NOW = 1_700_000_000_000;

function fixture() {
  const s = createState();
  s.chars = {
    1: { n: 'Alpha', f: 1, br: 100, p: 0, oid: 'o1', tag: 'AAA', on: 'Alpha Co' },
    2: { n: 'Bravo', f: 2, br: 90, p: 1, oid: 'o1', tag: 'AAA', on: 'Alpha Co' },
    3: { n: 'Charlie', f: 3, br: 50, p: 0, oid: null, tag: '', on: '' },
  };
  s.items = { 80: { n: 'Gauss', img: '' }, 81: { n: 'Cycler', img: '' } };
  // [ts, world, attacker, victim, weapon, flag, at, vt]
  s.events = [
    [NOW - 30 * HOUR, 1000, '1', '3', '80', 0, 1, 3], // outside any window
    [NOW - 3 * HOUR, 1000, '1', '3', '80', 0, 1, 3],
    [NOW - 2 * HOUR, 1000, '1', '3', '80', 0, 1, 3],
    [NOW - 2 * HOUR + 1, 1000, '2', '3', '81', 0, 2, 3],
    [NOW - 1 * HOUR, 1000, '3', '1', '81', 0, 3, 1],
    [NOW - 30 * 60e3, 1000, '1', '2', '80', 1, 1, 1], // teamkill
    [NOW - 20 * 60e3, 1000, '0', '2', '0', 2, 0, 2], // environment death
    [NOW - 10 * 60e3, 2000, '1', '3', '80', 0, 1, 3], // other world
  ];
  return s;
}

test('leaderboard counts kills, deaths, teamkills and suicides per world', () => {
  const r = computeStats(fixture(), 1000, NOW - 24 * HOUR, NOW);
  const alpha = r.players.find((p) => p.id === '1');
  assert.equal(alpha.k, 2);
  assert.equal(alpha.d, 1);
  assert.equal(alpha.tk, 1);
  assert.equal(alpha.weapon, 'Gauss');
  assert.equal(r.players[0].id, '1');
  assert.equal(r.events, 6); // the 30 h old event and the other world are excluded
});

test('outfits need two ranked members and sum their kills', () => {
  const r = computeStats(fixture(), 1000, NOW - 24 * HOUR, NOW);
  assert.equal(r.outfits.length, 1);
  assert.deepEqual([r.outfits[0].tag, r.outfits[0].k, r.outfits[0].members], ['AAA', 3, 2]);
});

test('population counts the characters online per empire, from logins not kills', () => {
  const s = fixture();
  s.online = { 1: NOW - HOUR, 2: NOW - HOUR, 3: NOW - HOUR, 9: NOW - HOUR };
  s.onlineW = { 1: 1000, 2: 1000, 3: 2000, 9: 1000 }; // 3 is on the other world, 9 has no character cached
  assert.deepEqual(onlineByFaction(s, 1000), { vs: 1, nc: 1, tr: 0, ns: 0 });
  assert.deepEqual(onlineByFaction(s, 2000), { vs: 0, nc: 0, tr: 1, ns: 0 });
  assert.deepEqual(populationSample(s, [1000, 2000], NOW), [[NOW, 1000, 1, 1, 0, 0], [NOW, 2000, 0, 0, 1, 0]]);
});

test('the population series replays the recorded samples and ends on the live count', () => {
  const s = fixture();
  s.online = { 1: NOW - HOUR };
  s.onlineW = { 1: 1000 };
  s.pop = [
    [NOW - 30 * HOUR, 1000, 9, 9, 9, 9], // older than the window
    [NOW - 2 * HOUR, 1000, 40, 50, 60, 10],
    [NOW - HOUR, 2000, 1, 1, 1, 1], // the other world
    [NOW - HOUR, 1000, 42, 52, 62, 12],
  ];
  const r = computeStats(s, 1000, NOW - 24 * HOUR, NOW);
  assert.deepEqual(r.population, [
    { t: NOW - 2 * HOUR, vs: 40, nc: 50, tr: 60, ns: 10 },
    { t: NOW - HOUR, vs: 42, nc: 52, tr: 62, ns: 12 },
    { t: NOW, vs: 1, nc: 0, tr: 0, ns: 0 },
  ]);
  assert.equal(r.hourly, undefined); // the live board charts population now, not kills per hour
});

test('shorter windows exclude older kills', () => {
  const r = computeStats(fixture(), 1000, NOW - HOUR - 1000, NOW);
  assert.equal(r.players.find((p) => p.id === '1')?.k ?? 0, 0);
  assert.equal(r.players[0].id, '3');
});

test('player detail lists weapons and returns null without activity', () => {
  const p = computePlayer(fixture(), 1000, '1', NOW - 24 * HOUR, NOW);
  assert.deepEqual(p.weapons, [{ id: '80', name: 'Gauss', img: '', kills: 2 }]);
  assert.equal(computePlayer(fixture(), 1000, '999', NOW - 24 * HOUR, NOW), null);
});

test('prune drops expired events and cache entries nothing uses', () => {
  const s = fixture();
  s.chars[9] = { n: 'Ghost', f: 1 };
  prune(s, NOW, 24 * HOUR);
  assert.equal(s.events.length, 7); // only the 30 h old event goes
  assert.equal(s.chars[9], undefined);
  assert.ok(s.chars[1]);
});

test('firstIndexSince finds the boundary in a sorted log', () => {
  const ev = [[1], [2], [2], [5]];
  assert.equal(firstIndexSince(ev, 2), 1);
  assert.equal(firstIndexSince(ev, 6), 4);
});

test('a packed snapshot round-trips, and corrupt chunks restore as null', async () => {
  const chunks = await packState(fixture());
  assert.ok(chunks.every((c) => c.length <= CHUNK_BYTES));
  const back = await unpackState(chunks);
  assert.equal(back.events.length, 8);
  assert.equal(back.chars[1].n, 'Alpha');
  assert.equal(await unpackState([new Uint8Array([1, 2, 3])]), null);
});

test('a large state is split into chunks that reassemble exactly', async () => {
  const s = createState();
  // random-ish ids so gzip cannot shrink the snapshot below one chunk
  for (let i = 0; i < 120_000; i++) s.events.push([NOW + i, 1000, String(Math.random()).slice(2), String(Math.random()).slice(2), '80', 0, 1, 2]);
  const chunks = await packState(s);
  assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
  assert.equal((await unpackState(chunks)).events.length, 120_000);
});

test('weapon image paths are only passed on when they look like Census static images', () => {
  const s = fixture();
  s.items[80].img = '/files/ps2/images/static/1234.png';
  s.items[81].img = 'https://evil.example/x.png';
  const p = computePlayer(s, 1000, '3', NOW - 24 * HOUR, NOW);
  assert.equal(p.weapons[0].img, '');
  assert.equal(computePlayer(s, 1000, '1', NOW - 24 * HOUR, NOW).weapons[0].img, '/files/ps2/images/static/1234.png');
});

test('per-empire boards rank each faction separately', () => {
  const r = computeStats(fixture(), 1000, NOW - 24 * HOUR, NOW);
  assert.deepEqual(r.byFaction[1].players.map((p) => p.id), ['1']);
  assert.deepEqual(r.byFaction[2].players.map((p) => p.id), ['2']);
  assert.deepEqual(r.byFaction[3].players.map((p) => p.id), ['3']);
  assert.equal(r.byFaction[1].outfits.length, 1); // the shared outfit belongs to its first-ranked member
  assert.equal(r.activePlayers, 3);
});

