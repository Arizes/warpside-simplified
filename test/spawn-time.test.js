import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnDuration, spawnNow } from '../public/spawn-time.js';

test('observed spawn timers show seconds, minutes and hours without rounding up', () => {
  assert.equal(spawnDuration(0), '0s');
  assert.equal(spawnDuration(59_999), '59s');
  assert.equal(spawnDuration(61_500), '1m 1s');
  assert.equal(spawnDuration(3_661_000), '1h 1m 1s');
  assert.equal(spawnDuration(-1000), '0s');
  assert.equal(spawnDuration(NaN), '—');
});

test('lifespan and last spawn advance between polls using the server clock', () => {
  const clock = { serverNow: 1_700_000_000_000, receivedAt: 500 };
  const first = clock.serverNow - 120_000;
  const last = clock.serverNow - 10_000;
  const now = spawnNow(clock, 3500);
  assert.equal(spawnDuration(now - first), '2m 3s');
  assert.equal(spawnDuration(now - last), '13s');
  // A new response reanchors the clock, including after a tab was suspended.
  assert.equal(spawnNow({ serverNow: now + 60_000, receivedAt: 7000 }, 8000), now + 61_000);
  assert.equal(spawnNow(clock, 0), clock.serverNow);
});
