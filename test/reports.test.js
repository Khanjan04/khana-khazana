// @ts-check
// Day 17: day-end tally, CSV export; dayclose locks the date and resets the daily KOT counter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedMenu } from './helpers.js';
import { dayTally, billsCsv } from '../server/reports.js';
import { businessDate } from '../server/model.js';

test('tally: visitors, most ordered, deleted items, pay modes; CSV rows', () => {
  const t = setup();
  const m = seedMenu(t);
  const a = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }, { itemId: m.items.naan, qty: 4 }] });
  t.cmd('captain', 'order.persons', { orderId: a.orderId, persons: 3 });
  const naan = t.db.prepare('SELECT id FROM order_lines WHERE order_id=? AND item_id=?').get(a.orderId, m.items.naan).id;
  t.cmd('manager', 'order.line.void', { lineId: naan, reason: 'burnt', qty: 1 });
  const b = t.cmd('biller', 'bill.print', { orderId: a.orderId });
  t.clock.now += 45 * 60_000;
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'upi', amount: b.totalPaise }] });
  const d = businessDate(t.db, t.clock.now);
  const r = dayTally(t.db, d);
  assert.equal(r.visitors, 3);
  assert.equal(r.byMode.upi, b.totalPaise);
  assert.equal(r.mostOrdered[0].name, 'Naan');
  assert.equal(r.mostOrdered[0].qty, 3);
  assert.equal(r.deleted.length, 1);
  assert.equal(r.deleted[0].approver, 'Manager');
  assert.equal(r.avgTableMinutes, 45);
  const csv = billsCsv(t.db, d).trim().split('\r\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /^KK1\/26-27\/000001,/);
});

test('dayclose: refuses with open orders unless forced, locks the date, KOT counter restarts', () => {
  const t = setup();
  const m = seedMenu(t);
  const d0 = businessDate(t.db, t.clock.now);
  const o = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.dal, qty: 1 }] });
  t.code('FORBIDDEN', () => t.cmd('biller', 'dayclose', {}));
  t.code('OPEN_ORDERS', () => t.cmd('manager', 'dayclose', {}));
  const b = t.cmd('biller', 'bill.print', { orderId: o.orderId });
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise }] });
  const r = t.cmd('manager', 'dayclose', { force: true });
  assert.equal(r.date, d0);
  t.code('ALREADY_CLOSED', () => t.cmd('manager', 'dayclose', { date: d0 }));
  // same calendar day, but the business date has moved on: KOT numbers restart at 1
  assert.notEqual(businessDate(t.db, t.clock.now), d0);
  const k = t.cmd('captain', 'kot.create', { tableId: m.tables[2], lines: [{ itemId: m.items.dal, qty: 1 }] });
  assert.equal(k.kots[0].no, 1);
  assert.equal(dayTally(t.db, d0).closed !== null, true);
});
