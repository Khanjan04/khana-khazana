// @ts-check
// Day 6: rights.js has 24 rights and default roles asserting PLAN §8 exactly.
// Day 9: Captain cannot call any admin command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIGHTS, defaultRights } from '../server/rights.js';
import { handlers } from '../server/commands/index.js';
import { setup } from './helpers.js';

// PLAN §8, transcribed row by row. "approval", "reprint only", "dues only" are NOT a direct grant.
const Y = true, _ = false;
//                                 Owner Mgr Biller Captain Kitchen Accountant Delivery
const PLAN8 = /** @type {Record<string, boolean[]>} */ ({
  'order':          [Y, Y, Y, Y, _, _, _],
  'kot':            [Y, Y, Y, Y, _, _, _],
  'serve':          [Y, Y, Y, Y, _, _, _],
  'table.transfer': [Y, Y, Y, Y, _, _, _],
  'kitchen':        [Y, Y, Y, _, Y, _, _],
  'kitchen.status': [Y, Y, _, _, Y, _, _],
  'kot.reprint':    [Y, Y, Y, _, Y, _, _],
  'bill':           [Y, Y, Y, _, _, _, _],
  'bill.reprint':   [Y, Y, Y, _, _, _, _],
  'discount':       [Y, Y, _, _, _, _, _],
  'void':           [Y, Y, _, _, _, _, _],
  'delivery':       [Y, Y, Y, _, _, _, Y],
  'history':        [Y, Y, Y, _, _, Y, _],
  'reports':        [Y, Y, Y, _, _, Y, _],
  'export':         [Y, Y, _, _, _, Y, _],
  'customers.due':  [Y, Y, Y, _, _, Y, _],
  'dayclose':       [Y, Y, _, _, _, _, _],
  'approve':        [Y, Y, _, _, _, _, _],
  'layout':         [Y, Y, _, _, _, _, _],
  'menu':           [Y, Y, _, _, _, _, _],
  'stock':          [Y, Y, _, _, _, _, _],
  'users':          [Y, _, _, _, _, _, _],
  'settings':       [Y, _, _, _, _, _, _],
  'device.manage':  [Y, _, _, _, _, _, _],
});
const ROLES = ['owner', 'manager', 'biller', 'captain', 'kitchen', 'accountant', 'delivery'];

test('exactly 24 rights: the father\'s 13 + 11 new', () => {
  assert.equal(RIGHTS.length, 24);
  assert.equal(new Set(RIGHTS).size, 24);
  assert.deepEqual([...RIGHTS].sort(), Object.keys(PLAN8).sort());
  assert.deepEqual(RIGHTS.slice(0, 13), ['order', 'kot', 'bill', 'discount', 'delivery', 'void', 'history', 'reports', 'kitchen', 'layout', 'menu', 'users', 'settings']);
});

test('default roles match PLAN §8 exactly', () => {
  for (const [right, row] of Object.entries(PLAN8)) {
    ROLES.forEach((role, i) => assert.equal(defaultRights(role).includes(right), row[i], `${role} / ${right}`));
  }
});

test('seeded DB roles equal defaults', () => {
  const t = setup();
  for (const role of ROLES) assert.deepEqual([...t.ctx(role).user.rights].sort(), defaultRights(role).sort(), role);
});

test('every command maps to a known right', () => {
  for (const [type, h] of Object.entries(handlers)) {
    const rights = typeof h.right === 'function' ? [h.right({}), h.right({ to: 'served', discount: 1, waive: 1, complimentary: 1 })] : [h.right];
    for (const r of [...rights, ...(h.base ? [h.base] : [])]) assert.ok(RIGHTS.includes(r), `${type} -> ${r}`);
  }
});

test('captain cannot call any admin command', () => {
  const t = setup();
  const admin = Object.keys(handlers).filter((k) => /^(menu|layout|settings|user|role|pair|device|kitchen_note|dayclose|print\.test)/.test(k));
  assert.ok(admin.length >= 18);
  for (const type of admin) t.code('FORBIDDEN', () => t.cmd('captain', type, { id: 'x', name: 'x', patch: {} }));
});

test('role × command matrix: forbidden exactly when the role lacks the right', () => {
  const t = setup();
  for (const role of ROLES) {
    const rights = new Set(defaultRights(role));
    for (const [type, h] of Object.entries(handlers)) {
      if (typeof h.right === 'function' || typeof h.approvable === 'function' || h.approvable) continue;
      const allowed = rights.has(h.right) && (!h.base || rights.has(h.base));
      let forbidden = false;
      try { t.cmd(role, type, {}); } catch (e) { forbidden = /** @type {any} */ (e).code === 'FORBIDDEN'; }
      assert.equal(forbidden, !allowed, `${role} ${type}`);
    }
  }
});
