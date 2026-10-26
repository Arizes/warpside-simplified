import assert from 'node:assert/strict';
import test from 'node:test';
import { brLabel } from '../public/br.js';

test('a rank reads as the game writes it', () => {
  assert.equal(brLabel({ br: 87, asp: 0 }), 'BR 87');
  assert.equal(brLabel({ br: 100, asp: 2 }), 'BR 100~2');
});

test('an unknown rank shows nothing rather than BR 0', () => {
  assert.equal(brLabel({ br: 0, asp: 0 }), '');
  assert.equal(brLabel({}), '');
  assert.equal(brLabel(undefined), '');
});
