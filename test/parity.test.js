// @ts-check
// Legacy-parity extras: setup with the KHANAKHAJANA defaults, "reason for every delete" setting,
// cash counted vs. expected cash in the day-end tally, report date ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, all, run } from '../server/db.js';
import { topUpStaff } from '../server/seed/index.js';
import { setup as hostSetup } from '../server/auth.js';
import { setup, seedMenu } from './helpers.js';
import { report } from '../server/reports.js';

test('setup: only the Owner registers; Manager/Captain/Kitchen + legacy menu, tables, extras, notes are loaded', () => {
  const db = openDb(':memory:');
  const r = hostSetup(db, { ownerName: 'Papa', pin: '1234', restaurantName: 'KHANAKHAJANA', loadDefaults: true }, Date.now());
  assert.deepEqual(r.staff.map((/** @type {any} */ u) => `${u.name}:${u.roleId}:${u.pin}`), ['Manager:manager:2222', 'Captain:captain:1111', 'Kitchen:kitchen:3333']);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM users').n, 4);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM items WHERE active=1').n, 186);
  assert.equal(r.seeded.items, 186);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM dining_tables').n, r.seeded.tables);
  assert.ok(r.seeded.extras > 0 && r.seeded.notes > 0);
  // short codes are unique 3-letter codes, numbers unique
  assert.equal(get(db, 'SELECT COUNT(DISTINCT code) AS n FROM items WHERE active=1').n, 186);
  assert.equal(get(db, 'SELECT COUNT(DISTINCT num) AS n FROM items WHERE active=1').n, 186);
  // without the tick: staff only, empty menu
  const db2 = openDb(':memory:');
  hostSetup(db2, { ownerName: 'Papa', pin: '1234' }, Date.now());
  assert.equal(get(db2, 'SELECT COUNT(*) AS n FROM users').n, 4);
  assert.equal(get(db2, 'SELECT COUNT(*) AS n FROM items').n, 0);
});

test('reasonAll: deleting an unsent item needs a reason and is recorded', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'order.line.add', { tableId: m.tables[0], type: 'dine', lines: [{ itemId: m.items.dal, qty: 1 }, { itemId: m.items.dal, qty: 1, note: 'x' }] }).orderId;
  const [l1, l2] = all(t.db, 'SELECT id FROM order_lines WHERE order_id=? ORDER BY rowid', oid).map((/** @type {any} */ r) => r.id);
  t.cmd('captain', 'order.line.remove', { lineId: l1 }); // default: no reason needed
  t.cmd('owner', 'settings.update', { patch: { reasonAll: true } });
  t.code('BAD_PAYLOAD', () => t.cmd('captain', 'order.line.remove', { lineId: l2 }));
  t.cmd('captain', 'order.line.remove', { lineId: l2, reason: 'Wrong item punched' });
  assert.equal(get(t.db, "SELECT COUNT(*) AS n FROM void_log WHERE reason='Wrong item punched'").n, 1);
});

test('cash counted vs expected cash; report over a date range', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 2 }] }).orderId;
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise }], tendered: b.totalPaise + 5000 });
  const date = get(t.db, 'SELECT business_date FROM bills').business_date;
  t.code('FORBIDDEN', () => t.cmd('captain', 'cash.count', { date, countedPaise: 100 }));
  t.cmd('manager', 'cash.count', { date, countedPaise: b.totalPaise - 1000 });
  const r = report(t.db, date, date);
  assert.equal(r.tally.expectedCashPaise, b.totalPaise);
  assert.equal(r.tally.cashCounted.diffPaise, -1000);
  assert.equal(r.tally.diffPaise, 0); // tally check matches
  assert.equal(get(t.db, 'SELECT change_paise FROM bills').change_paise, 5000);
  const wide = report(t.db, '2000-01-01', '2999-12-31');
  assert.equal(wide.tally.bills, 1);
  assert.equal(wide.tally.cashCounted, null); // drawer count is per single day
  assert.equal(report(t.db, '2000-01-01', '2000-01-02').tally.bills, 0);
});

test('a host set up before default staff existed gets Manager/Captain/Kitchen once (missing roles only)', () => {
  const db = openDb(':memory:');
  hostSetup(db, { ownerName: 'Papa', pin: '1234' }, Date.now());
  // simulate the old setup: only the owner (+ an existing captain), no flag
  run(db, "DELETE FROM users WHERE role_id IN ('manager','kitchen')");
  run(db, "DELETE FROM settings WHERE key='_staffSeeded'");
  assert.deepEqual(topUpStaff(db, Date.now()).map((u) => u.name), ['Manager', 'Kitchen']);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM users').n, 4);
  run(db, "UPDATE users SET active=0 WHERE role_id='kitchen'");
  assert.deepEqual(topUpStaff(db, Date.now()), []); // only once
  const fresh = openDb(':memory:');
  assert.deepEqual(topUpStaff(fresh, Date.now()), []); // not before setup
});
