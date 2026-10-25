import assert from 'node:assert/strict';
import test from 'node:test';
import { apiBase } from '../public/api-base.js';

const META = 'https://api.warpside2.com';

test('a local page keeps same-origin requests whatever the meta tag says', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) {
    assert.equal(apiBase(host, META), '');
  }
});

test('a deployed page uses the configured API origin', () => {
  assert.equal(apiBase('warpside2.com', META), META);
  assert.equal(apiBase('www.warpside2.com', META), META);
  assert.equal(apiBase('warpside2.com', `${META}/`), META); // trailing slash would double up
});

test('no usable meta tag means same origin', () => {
  assert.equal(apiBase('warpside2.com', undefined), '');
  assert.equal(apiBase('warpside2.com', ''), '');
  assert.equal(apiBase('warpside2.com', '   '), '');
});

test('the meta tag is page content, so only a plain https origin is accepted', () => {
  for (const bad of [
    'http://api.warpside2.com', // plaintext
    'javascript:alert(1)',
    'https://api.warpside2.com/api/stats?x=1', // a path could retarget every request
    'https://evil.example.com/../',
    '//api.warpside2.com',
    'https://',
    'https://-bad-.com',
  ]) {
    assert.equal(apiBase('warpside2.com', bad), '', `should reject ${bad}`);
  }
});
