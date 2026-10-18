// @ts-check
// Vendored QR encoder: module matrices match a reference implementation (node-qrcode 1.5.4,
// byte mode, fixed mask) — fingerprints recorded when the encoder was vendored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { qr, qrTerminal } from '../web/vendor/qr.js';

const fp = (/** @type {boolean[][]} */ m) => createHash('sha1').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('|')).digest('hex');

test('matches reference matrices', () => {
  const a = qr('http://192.168.1.5:8080/join', { ecl: 'M', mask: 2 });
  assert.deepEqual([a.size, fp(a.modules)], [29, '7edb4ca1916f0993824fe0a584cb1999224ce9c6']);
  const b = qr('http://192.168.43.1:8080/pair?code=123456', { ecl: 'L', mask: 5 });
  assert.deepEqual([b.size, fp(b.modules)], [29, 'b44a66517c0aaec03db8cd59d9444cff7c94181a']);
});

test('auto mask, larger versions, terminal render', () => {
  const r = qr('x'.repeat(300));
  assert.ok(r.version >= 10 && r.mask >= 0 && r.mask < 8);
  assert.equal(r.modules.length, r.size);
  assert.ok(qrTerminal('http://10.0.0.2:8080/').split('\n').length > 10);
  assert.throws(() => qr('x'.repeat(5000)), /too long/);
});
