// @ts-check
// Day 10: pair.create, pair.claim -> device token, login -> session, scrypt + timingSafeEqual,
// lockout, logout, device.revoke; tests for each path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import * as auth from '../server/auth.js';
import { openDb, get } from '../server/db.js';

const NOW = new Date('2026-10-18T12:00:00').getTime();

test('setup creates owner + host device + session once; recovery code resets PIN', () => {
  const db = openDb(':memory:');
  assert.equal(auth.needsSetup(db), true);
  assert.throws(() => auth.setup(db, { ownerName: 'Papa', pin: '12' }, NOW), { code: 'BAD_PIN' });
  const r = auth.setup(db, { ownerName: 'Papa', pin: '1234', restaurantName: 'KK' }, NOW);
  assert.ok(r.deviceToken.length >= 43 && r.sessionToken.length >= 43); // 256-bit base64url
  assert.equal(auth.needsSetup(db), false);
  assert.throws(() => auth.setup(db, { ownerName: 'X', pin: '1234' }, NOW), { code: 'ALREADY_SETUP' });
  const a = auth.authenticate(db, r.deviceToken, r.sessionToken, NOW);
  assert.equal(a?.user.roleId, 'owner');
  // tokens are stored hashed, never in clear
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM devices WHERE token_hash=?', r.deviceToken).n, 0);
  assert.throws(() => auth.recover(db, 'WRONG', '9999'), { code: 'BAD_CODE' });
  auth.recover(db, r.recoveryCode.toLowerCase(), '9999');
  assert.ok(auth.login(db, { deviceToken: r.deviceToken, userId: r.userId, pin: '9999' }, NOW).sessionToken);
});

test('pairing: one-time code, 5-minute TTL, 5 attempts', () => {
  const t = setup({ now: NOW });
  const c = auth.createPairCode(t.db, { kind: 'kds' }, NOW);
  assert.match(c.code, /^\d{6}$/);
  const d = auth.claimPairCode(t.db, { code: c.code, name: 'Kitchen' }, NOW + 1000);
  assert.equal(d.kind, 'kds');
  assert.throws(() => auth.claimPairCode(t.db, { code: c.code }, NOW + 2000), { code: 'BAD_CODE' }); // one use

  const late = auth.createPairCode(t.db, {}, NOW);
  assert.throws(() => auth.claimPairCode(t.db, { code: late.code }, NOW + auth.PAIR_TTL_MS + 1), { code: 'BAD_CODE' });

  const brute = auth.createPairCode(t.db, {}, NOW);
  const wrong = brute.code === '000000' ? '000001' : '000000';
  for (let i = 0; i < auth.PAIR_MAX_ATTEMPTS; i++) assert.throws(() => auth.claimPairCode(t.db, { code: wrong }, NOW), { code: 'BAD_CODE' });
  assert.throws(() => auth.claimPairCode(t.db, { code: brute.code }, NOW), { code: 'BAD_CODE' }); // burned
});

test('pair.create is an owner (device.manage) command', () => {
  const t = setup({ now: NOW });
  t.code('FORBIDDEN', () => t.cmd('manager', 'pair.create', { kind: 'staff' }));
  assert.match(t.cmd('owner', 'pair.create', { kind: 'staff' }).code, /^\d{6}$/);
});

test('login, wrong PIN, lockout after 5 failures for 15 minutes', () => {
  const t = setup({ now: NOW });
  const c = auth.createPairCode(t.db, {}, NOW);
  const d = auth.claimPairCode(t.db, { code: c.code }, NOW);
  assert.throws(() => auth.login(t.db, { deviceToken: 'bogus', userId: t.users.biller, pin: '1234' }, NOW), { code: 'BAD_DEVICE' });
  const ok = auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.biller, pin: '1234' }, NOW);
  assert.deepEqual(ok.user.roleId, 'biller');
  for (let i = 0; i < 4; i++) assert.throws(() => auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.biller, pin: '0000' }, NOW), { code: 'BAD_LOGIN' });
  assert.throws(() => auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.biller, pin: '0000' }, NOW), { code: 'LOCKED' });
  assert.throws(() => auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.biller, pin: '1234' }, NOW + 60_000), { code: 'LOCKED' });
  assert.ok(auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.biller, pin: '1234' }, NOW + auth.LOCK_MS + 1).sessionToken);
});

test('session: 12 h expiry, logout, device revoke', () => {
  const t = setup({ now: NOW });
  const c = auth.createPairCode(t.db, {}, NOW);
  const d = auth.claimPairCode(t.db, { code: c.code }, NOW);
  const s = auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.captain, pin: '1234' }, NOW);
  const a = auth.authenticate(t.db, d.deviceToken, s.sessionToken, NOW);
  assert.ok(a && auth.sessionAlive(t.db, a.sessionHash, NOW));
  assert.equal(auth.authenticate(t.db, d.deviceToken, s.sessionToken, NOW + auth.SESSION_TTL_MS + 1), null);
  assert.equal(auth.sessionAlive(t.db, a.sessionHash, NOW + auth.SESSION_TTL_MS + 1), false);

  auth.logout(t.db, s.sessionToken);
  assert.equal(auth.authenticate(t.db, d.deviceToken, s.sessionToken, NOW), null);

  const s2 = auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.captain, pin: '1234' }, NOW);
  t.cmd('owner', 'device.revoke', { deviceId: d.deviceId });
  assert.equal(auth.authenticate(t.db, d.deviceToken, s2.sessionToken, NOW), null);
  assert.equal(auth.deviceFromToken(t.db, d.deviceToken), null);
  assert.throws(() => auth.login(t.db, { deviceToken: d.deviceToken, userId: t.users.captain, pin: '1234' }, NOW), { code: 'BAD_DEVICE' });
});

test('session token from another device is rejected', () => {
  const t = setup({ now: NOW });
  const d1 = auth.claimPairCode(t.db, { code: auth.createPairCode(t.db, {}, NOW).code }, NOW);
  const d2 = auth.claimPairCode(t.db, { code: auth.createPairCode(t.db, {}, NOW).code }, NOW);
  const s = auth.login(t.db, { deviceToken: d1.deviceToken, userId: t.users.captain, pin: '1234' }, NOW);
  assert.equal(auth.authenticate(t.db, d2.deviceToken, s.sessionToken, NOW), null);
});

test('PIN hashing: scrypt with per-user salt', () => {
  const a = auth.hashPin('1234'), b = auth.hashPin('1234');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.ok(auth.checkPin('1234', a.salt, a.hash));
  assert.ok(!auth.checkPin('1235', a.salt, a.hash));
  assert.ok(auth.validPin('12345678') && !auth.validPin('123') && !auth.validPin('123456789') && !auth.validPin('12a4'));
});
