import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, subscribeMessages } from '../src/stream.js';
import { SERVERS } from '../src/config.js';

const death = (over = {}) => ({
  type: 'serviceMessage',
  payload: { event_name: 'Death', world_id: '1000', timestamp: '1700000000', attacker_character_id: '5429', character_id: '5430', attacker_weapon_id: '80', attacker_team_id: '2', team_id: '3', ...over },
});

test('a normal Death becomes a kill tuple', () => {
  const r = parseMessage(death(), SERVERS);
  assert.deepEqual(r.event, [1700000000000, 1000, '5429', '5430', '80', 0, 2, 3, 0]);
  assert.equal(parseMessage(death({ zone_id: '2' }), SERVERS).event[8], 2);
  assert.equal(parseMessage(death({ zone_id: String((7 << 16) | 344) }), SERVERS).event[8], 344); // instance bits stripped
});

test('same-team Death is a teamkill, self or unowned Death is a suicide', () => {
  assert.equal(parseMessage(death({ team_id: '2' }), SERVERS).event[5], 1);
  assert.equal(parseMessage(death({ attacker_character_id: '5430' }), SERVERS).event[5], 2);
  assert.equal(parseMessage(death({ attacker_character_id: '0' }), SERVERS).event[5], 2);
});

test('events for worlds we do not track are ignored', () => {
  assert.equal(parseMessage(death({ world_id: '17' }), SERVERS), null);
});

test('login and logout carry the character id as a string', () => {
  const login = parseMessage({ type: 'serviceMessage', payload: { event_name: 'PlayerLogin', world_id: '2000', character_id: '5428000000000000001', timestamp: '1700000000' } }, SERVERS);
  assert.deepEqual([login.kind, login.id], ['login', '5428000000000000001']);
});

test('heartbeat and state-change messages report feed health per world', () => {
  const hb = parseMessage({ type: 'heartbeat', online: { EventServerEndpoint_1000_Genudine: 'true', EventServerEndpoint_2000_Ceres: 'false', EventServerEndpoint_19_Jaeger: 'true' } }, SERVERS);
  assert.deepEqual(hb.feeds, { 1000: true, 2000: false });
  // recorded from ps2ps4us: one message names several endpoints
  const sc = parseMessage({ type: 'serviceStateChanged', detail: 'EventServerEndpoint_1000_Genudine_1001_Palos_1002_Crux_1003_Searhus_1004_Xelas', online: 'true' }, SERVERS);
  assert.deepEqual(sc.feeds, { 1000: true });
});

test('unknown or malformed messages return null', () => {
  assert.equal(parseMessage({ type: 'connectionStateChanged' }, SERVERS), null);
  assert.equal(parseMessage({ type: 'serviceMessage' }, SERVERS), null);
  assert.equal(parseMessage({ type: 'serviceMessage', payload: { event_name: 'GainExperience', world_id: '1000' } }, SERVERS), null);
});

test('capture, defend and FacilityControl become facility and control records', () => {
  const base = { world_id: '1000', timestamp: '1700000000', zone_id: '2', facility_id: '6200' };
  const cap = parseMessage({ type: 'serviceMessage', payload: { ...base, event_name: 'PlayerFacilityDefend', character_id: '77' } }, SERVERS);
  assert.deepEqual(cap, { kind: 'facility', world: 1000, ts: 1700000000000, zone: 2, fac: '6200', id: '77' });
  const ctl = parseMessage({ type: 'serviceMessage', payload: { ...base, event_name: 'FacilityControl', old_faction_id: '2', new_faction_id: '1', outfit_id: '9' } }, SERVERS);
  assert.deepEqual(ctl, { kind: 'control', world: 1000, ts: 1700000000000, zone: 2, fac: '6200', from: 2, to: 1 });
  assert.equal(parseMessage({ type: 'serviceMessage', payload: { ...base, event_name: 'FacilityControl', facility_id: '1;x' } }, SERVERS), null);
});

test('two subscriptions: character events with characters all, FacilityControl per world', () => {
  const [chars, worlds] = subscribeMessages([1000]);
  assert.deepEqual(chars.characters, ['all']);
  assert.ok(chars.eventNames.includes('PlayerFacilityCapture'));
  assert.equal(worlds.characters, undefined);
  assert.deepEqual(worlds.eventNames, ['FacilityControl']);
});
