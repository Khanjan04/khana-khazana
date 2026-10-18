// @ts-check
// Day 16: bill.settle with payments [{mode, amount}], part payments, tip, waive-off (approval),
// equal split, customer dues, due.receive; sums equal total exactly in paise.
// Exit: 50 random settlements reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedMenu } from './helpers.js';
import { get, all } from '../server/db.js';
import { dayTally } from '../server/reports.js';

test('settle: exact sum required; part payments; closes the order', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).orderId;
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  t.code('AMOUNT_MISMATCH', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise - 1 }] }));
  t.code('BAD_PAYLOAD', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'bitcoin', amount: b.totalPaise }] }));
  t.code('BAD_PAYLOAD', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: 10.5 }] }));
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: 10000 }, { mode: 'upi', amount: b.totalPaise - 10000 }], tip: 1000 - 1000 });
  assert.equal(get(t.db, 'SELECT status FROM orders WHERE id=?', oid).status, 'closed');
  assert.equal(get(t.db, 'SELECT status FROM bills WHERE id=?', b.billId).status, 'settled');
  t.code('BILL_NOT_OPEN', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise }] }));
  // table is free again
  assert.notEqual(t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).orderId, oid);
});

test('tip adds, waive-off needs approval + reason', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).orderId;
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  t.code('APPROVAL_REQUIRED', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise - 3000 }], waive: 3000, waiveReason: 'regular' }));
  t.code('BAD_PAYLOAD', () => t.cmd('manager', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise - 3000 }], waive: 3000 }));
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: b.totalPaise - 3000 + 5000 }], waive: 3000, tip: 5000, waiveReason: 'regular', approval: t.approval() });
  const row = get(t.db, 'SELECT * FROM bills WHERE id=?', b.billId);
  assert.deepEqual([row.tip_paise, row.waived_paise, row.approver_id], [5000, 3000, t.users.manager]);
});

test('due payment needs a customer and customers.due; due.receive reduces the balance', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 2 }] }).orderId;
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  t.code('CUSTOMER_REQUIRED', () => t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'due', amount: b.totalPaise }] }));
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: [{ mode: 'cash', amount: 20000 }, { mode: 'due', amount: b.totalPaise - 20000, phone: '9876543210', name: 'Sharma ji' }] });
  const c = get(t.db, 'SELECT * FROM customers WHERE phone=?', '9876543210');
  assert.equal(c.due_paise, b.totalPaise - 20000);
  t.code('FORBIDDEN', () => t.cmd('captain', 'due.receive', { customerId: c.id, amount: 100 }));
  t.code('BAD_PAYLOAD', () => t.cmd('biller', 'due.receive', { customerId: c.id, amount: c.due_paise + 1 }));
  t.cmd('accountant', 'due.receive', { customerId: c.id, amount: 1000, mode: 'upi' });
  assert.equal(get(t.db, 'SELECT due_paise FROM customers WHERE id=?', c.id).due_paise, c.due_paise - 1000);
});

test('bill.split returns host-computed equal parts', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).orderId;
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  const { parts } = t.cmd('biller', 'bill.split', { billId: b.billId, ways: 3 });
  assert.equal(parts.reduce((/** @type {number} */ a, /** @type {number} */ x) => a + x, 0), b.totalPaise);
  t.cmd('biller', 'bill.settle', { billId: b.billId, payments: parts.map((/** @type {number} */ amount) => ({ mode: 'cash', amount })) });
});

test('50 random settlements reconcile exactly in paise', () => {
  const t = setup();
  const m = seedMenu(t);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const items = Object.values(m.items);
  let expectTotal = 0, expectTip = 0, expectWaive = 0;
  /** @type {Record<string, number>} */
  const byMode = { cash: 0, card: 0, upi: 0, due: 0, other: 0 };
  for (let i = 0; i < 50; i++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ itemId: items[Math.floor(rnd() * items.length)], qty: 1 + Math.floor(rnd() * 3) }));
    const oid = t.cmd('biller', 'order.line.add', { type: 'takeaway', lines }).orderId;
    const disc = rnd() < 0.3 ? { type: rnd() < 0.5 ? 'pct' : 'fixed', value: rnd() < 0.5 ? 7.5 : 33.33, reason: 'r' } : undefined;
    const b = t.cmd('manager', 'bill.print', { orderId: oid, discount: disc, serviceCharge: rnd() < 0.2 });
    const tip = rnd() < 0.3 ? Math.floor(rnd() * 5000) : 0;
    const waive = rnd() < 0.2 ? Math.min(b.totalPaise, Math.floor(rnd() * 1000)) : 0;
    let rest = b.totalPaise + tip - waive;
    const payments = [];
    const modes = ['cash', 'card', 'upi', 'other'];
    while (rest > 0) {
      const amt = payments.length === 2 ? rest : Math.min(rest, 1 + Math.floor(rnd() * rest));
      const mode = modes[Math.floor(rnd() * modes.length)];
      payments.push({ mode, amount: amt });
      byMode[mode] += amt;
      rest -= amt;
    }
    if (!payments.length) payments.push({ mode: 'cash', amount: 0 });
    t.cmd('manager', 'bill.settle', { billId: b.billId, payments, tip, waive, waiveReason: waive ? 'w' : undefined });
    expectTotal += b.totalPaise; expectTip += tip; expectWaive += waive;
  }
  const bills = all(t.db, 'SELECT * FROM bills');
  for (const b of bills) {
    const paid = get(t.db, 'SELECT COALESCE(SUM(amount_paise),0) AS s FROM bill_payments WHERE bill_id=?', b.id).s;
    assert.equal(paid, b.total_paise + b.tip_paise - b.waived_paise, b.no);
    assert.equal(b.taxable_paise + b.cgst_paise + b.sgst_paise + b.service_paise + b.roundoff_paise, b.total_paise, 'components add up ' + b.no);
  }
  const tally = dayTally(t.db, bills[0].business_date);
  assert.equal(tally.settled, 50);
  assert.deepEqual([tally.totalPaise, tally.tipPaise, tally.waivedPaise], [expectTotal, expectTip, expectWaive]);
  assert.deepEqual(tally.byMode, byMode);
  const sumModes = Object.values(tally.byMode).reduce((a, b) => a + b, 0);
  assert.equal(sumModes, expectTotal + expectTip - expectWaive);
});
