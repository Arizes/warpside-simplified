import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseServers, platformsOf, worldForPlatform } from '../public/servers.js';

const SERVERS = normaliseServers([
  { id: 1, name: 'Osprey', platform: 'pc', platformName: 'PC' },
  { id: 10, name: 'Wainwright', platform: 'pc', platformName: 'PC' },
  { id: 1000, name: 'Genudine', platform: 'ps4', platformName: 'PlayStation' },
  { id: 2000, name: 'Ceres', platform: 'ps4', platformName: 'PlayStation' },
]);

test('platforms are listed once each, in API order', () => {
  assert.deepEqual(platformsOf(SERVERS), [['pc', 'PC'], ['ps4', 'PlayStation']]);
});

test('switching platform returns to the server last picked there', () => {
  assert.equal(worldForPlatform(SERVERS, 'pc', '10'), 10);
  assert.equal(worldForPlatform(SERVERS, 'ps4', '2000'), 2000);
});

test('with nothing saved, or a stale or foreign id, the platform opens on its first server', () => {
  assert.equal(worldForPlatform(SERVERS, 'pc', null), 1);
  assert.equal(worldForPlatform(SERVERS, 'pc', '99'), 1);
  assert.equal(worldForPlatform(SERVERS, 'ps4', '10'), 1000); // a PC id never selects across platforms
  assert.equal(worldForPlatform(SERVERS, 'xbox', '1'), null);
});

test('an API without platform fields is treated as PlayStation only', () => {
  const old = normaliseServers([{ id: 1000, name: 'Genudine' }, { id: 2000, name: 'Ceres' }]);
  assert.deepEqual(platformsOf(old), [['ps4', 'PlayStation']]);
});
