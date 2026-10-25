import test from 'node:test';
import assert from 'node:assert/strict';
import { bounds, cutOffRegions, intensity, labelLines, layerShift, progress, puffRate } from '../public/map-logic.js';

// A small lattice: warpgate G1 (TR) - A - B - C, and warpgate G2 (NC) - D. t 7 is a warpgate.
const regions = {
  g1: { fac: 'G1', t: 7 },
  a: { fac: 'A', t: 6 },
  b: { fac: 'B', t: 6 },
  c: { fac: 'C', t: 6 },
  g2: { fac: 'G2', t: 7 },
  d: { fac: 'D', t: 6 },
  filler: { fac: null, t: 0 },
};
const links = [['G1', 'A'], ['A', 'B'], ['B', 'C'], ['G2', 'D'], ['D', 'C'], ['X', 'A']];

test('territory connected to its warpgate through its own lattice is not cut off', () => {
  const owners = { g1: 3, a: 3, b: 3, c: 3, g2: 2, d: 2 };
  assert.deepEqual([...cutOffRegions(regions, links, owners)], []);
});

test('territory behind an enemy base is cut off', () => {
  // NC took B: TR's C is stranded, and B itself is not linked to NC's gate through NC land either
  const owners = { g1: 3, a: 3, b: 2, c: 3, g2: 2, d: 2 };
  assert.deepEqual([...cutOffRegions(regions, links, owners)].sort(), ['b', 'c']);
  // once NC also holds C, B and C join D and the gate
  assert.deepEqual([...cutOffRegions(regions, links, { ...owners, c: 2 })], []);
});

test('an empire with no warpgate on the continent is never marked cut off', () => {
  const owners = { g1: 3, a: 3, b: 3, c: 1, g2: 2, d: 2 }; // VS holds C but has no gate here
  assert.deepEqual([...cutOffRegions(regions, links, owners)], []);
});

test('unowned regions and unknown facilities in links are ignored', () => {
  const owners = { g1: 3, a: 0, b: 3, c: 3, g2: 2, d: 2 };
  assert.deepEqual([...cutOffRegions(regions, links, owners)].sort(), ['b', 'c']);
  assert.deepEqual([...cutOffRegions(regions, links, {})], []); // ownership not loaded yet
});

test('fight intensity and puff rate rise with heat and stay bounded', () => {
  assert.equal(intensity(0), 0);
  assert.equal(intensity(64), 1);
  assert.equal(intensity(1000), 1);
  assert.equal(intensity('junk'), 0);
  assert.ok(puffRate(0) > 0); // a detected fight always shows some activity
  assert.ok(puffRate(4) < puffRate(25));
  assert.equal(puffRate(1e6), 6);
});

test('base labels gain their type and wrap onto two balanced lines like the in-game map', () => {
  assert.deepEqual(labelLines('Naum', 2), ['Naum Amp', 'Station']);
  assert.deepEqual(labelLines('Acan', 3), ['Acan Bio Lab']);
  assert.deepEqual(labelLines('Hossin Western Warpgate', 7), ['Hossin Western', 'Warpgate']);
  assert.deepEqual(labelLines('Ixtab Amp Station', 2), ['Ixtab Amp', 'Station']); // no duplicated suffix
  assert.deepEqual(labelLines('Bunker J993', 6), ['Bunker J993']);
  assert.deepEqual(labelLines('Supercalifragilistic', 6), ['Supercalifragilistic']);
  assert.deepEqual(labelLines('', 2), ['']);
});

test('bounds pads the box and handles no points', () => {
  assert.deepEqual(bounds([[0, 0], [10, -5]], 1), [-1, -6, 11, 1]);
  assert.equal(bounds([]), null);
});

// Where a map point lands on screen for a given viewBox in a w x h SVG (centred "meet" fit).
const toScreen = (view, w, h, [x, y]) => {
  const k = Math.min(w / view[2], h / view[3]);
  return [(x - view[0]) * k + (w - view[2] * k) / 2, (y - view[1]) * k + (h - view[3] * k) / 2];
};

test('the heavy layer transform lines a stale render up with the current view', () => {
  const w = 900;
  const h = 600;
  const drawn = [-4000, -3000, 9000, 6000];
  assert.deepEqual(layerShift(drawn, drawn, w, h), { s: 1, tx: 0, ty: 0 }); // at rest: no transform
  // zoomed 1.3x towards a point and panned: every map point must land where the live view puts it
  const view = [-2500, -2200, 9000 / 1.3, 6000 / 1.3];
  const { s, tx, ty } = layerShift(drawn, view, w, h);
  assert.ok(Math.abs(s - 1.3) < 1e-9);
  for (const p of [[0, 0], [-3000, 1500], [2500, -2000]]) {
    const [ax, ay] = toScreen(drawn, w, h, p);
    const [bx, by] = toScreen(view, w, h, p);
    assert.ok(Math.abs(ax * s + tx - bx) < 1e-6 && Math.abs(ay * s + ty - by) < 1e-6);
  }
});

test('the heavy layer transform also holds when the box aspect letterboxes the view', () => {
  const drawn = [-4096, -4096, 8192, 8192]; // square view in a wide box: centred with side margins
  const view = [-3000, -3500, 5000, 5000];
  const { s, tx, ty } = layerShift(drawn, view, 1200, 700);
  const [ax, ay] = toScreen(drawn, 1200, 700, [1000, -200]);
  const [bx, by] = toScreen(view, 1200, 700, [1000, -200]);
  assert.ok(Math.abs(ax * s + tx - bx) < 1e-6 && Math.abs(ay * s + ty - by) < 1e-6);
});

test('animation progress never runs backwards on an early first frame', () => {
  assert.equal(progress(990, 1000, 220), 0); // frame stamped before the animation began
  assert.equal(progress(1110, 1000, 220), 0.5);
  assert.equal(progress(5000, 1000, 220), 1);
});
