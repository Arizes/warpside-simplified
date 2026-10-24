import test from 'node:test';
import assert from 'node:assert/strict';
import { busiestZone, computeMap, createMapState, noteControl, noteDeath, noteFacility, pruneMap } from '../src/map.js';

const NOW = 1_700_000_000_000;
const MIN = 60e3;
const geo = { hexes: [[0, 0, '10'], [1, 0, '10'], [0, 1, '11']], regions: { 10: { fac: 'A' }, 11: { fac: 'B' } }, links: [['A', 'B']] };

function scenario() {
  const ms = createMapState();
  ms.owners[1000] = { 2: { 10: 1, 11: 2 } };
  noteFacility(ms, { world: 1000, zone: 2, fac: 'A', id: 'p1', ts: NOW - 5 * MIN }, 1);
  // [ts, world, attacker, victim, weapon, flag, at, vt, zone]
  noteDeath(ms, [NOW - 4 * MIN, 1000, 'p1', 'p9', '80', 0, 1, 2, 2]); // p1 was seen at A
  noteDeath(ms, [NOW - 3 * MIN, 1000, 'p8', 'p1', '80', 0, 3, 1, 2]); // victim p1 seen at A
  noteDeath(ms, [NOW - 3 * MIN, 1000, 'p7', 'p6', '80', 0, 3, 1, 2]); // nobody seen at a base: unplaced
  noteDeath(ms, [NOW - 3 * MIN, 1000, 'p1', 'p5', '80', 0, 1, 2, 4]); // p1 seen on Indar, kill on Hossin
  return ms;
}

test('kills are placed at a base only when a participant was seen capturing or defending it there', () => {
  const ms = scenario();
  const m = computeMap(ms, { 2: geo }, [], 1000, 2, NOW);
  assert.equal(m.fights.length, 1);
  const [f] = m.fights;
  assert.equal(f.fac, 'A');
  assert.equal(f.kills, 2);
  assert.deepEqual(f.factions, { 1: 3, 2: 1, 3: 1 });
});

test('a base flip updates ownership at once, is logged, and weighs more than a kill', () => {
  const ms = scenario();
  noteControl(ms, { world: 1000, zone: 2, fac: 'B', from: 2, to: 3, ts: NOW - MIN }, '11');
  assert.equal(ms.owners[1000][2][11], 3);
  const m = computeMap(ms, { 2: geo }, [], 1000, 2, NOW);
  assert.equal(m.fights[0].fac, 'B');
  assert.deepEqual(m.captures, [{ ts: NOW - MIN, fac: 'B', from: 2, to: 3 }]);
  noteControl(ms, { world: 1000, zone: 2, fac: 'A', from: 1, to: 1, ts: NOW }, '10'); // a defence is not a flip
  assert.equal(computeMap(ms, { 2: geo }, [], 1000, 2, NOW).captures.length, 1);
});

test('territory is weighted by hex count when geometry is loaded', () => {
  const m = computeMap(scenario(), { 2: geo }, [], 1000, 2, NOW);
  const indar = m.zones.find((z) => z.id === 2);
  assert.deepEqual(indar.territory, { 0: 0, 1: 2, 2: 1, 3: 0 });
  assert.equal(m.zones.find((z) => z.id === 4).known, false);
});

test('old activity and stale presence are pruned', () => {
  const ms = scenario();
  pruneMap(ms, NOW + 20 * MIN);
  assert.equal(ms.activity.length, 0);
  assert.deepEqual(ms.charFac, {});
});

test('the busiest continent is chosen from recent kills', () => {
  const events = [[NOW - MIN, 1000, 'a', 'b', '1', 0, 1, 2, 6], [NOW - MIN, 1000, 'a', 'c', '1', 0, 1, 2, 6], [NOW - MIN, 1000, 'a', 'd', '1', 0, 1, 2, 2]];
  assert.equal(busiestZone(createMapState(), events, 1000, NOW), 6);
  assert.equal(busiestZone(createMapState(), [], 1000, NOW), 2);
});
