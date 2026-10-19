// @ts-check
// Day 15: bill.print via domain/totals.js; host FY bill series ≤16 chars; totals snapshot;
// reprint; discount + reason (approval for biller); complimentary; service charge opt-in;
// composition -> Bill of Supply. Exit: bill numbers consecutive under 2 concurrent billers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedMenu } from './helpers.js';
import { get, all } from '../server/db.js';
import { calcTotals, totalsToPaise } from '../server/domain/totals.js';
import { legacyOrder, formatBillNo, splitEqual } from '../server/commands/bill.js';
import { getSettings } from '../server/model.js';

/** @param {ReturnType<typeof setup>} t @param {any} m @param {number} table */
const order = (t, m, table = 0) => t.cmd('captain', 'kot.create', { tableId: m.tables[table], lines: [{ itemId: m.items.dal, qty: 1 }, { itemId: m.items.naan, qty: 2 }] }).orderId;

test('bill no: PREFIX/FY/seq, 16 chars, consecutive, FY rollover on 1 April', () => {
  assert.equal(formatBillNo('KK1', '26-27', 123), 'KK1/26-27/000123');
  assert.equal(formatBillNo('KK1', '26-27', 123).length, 16);
  assert.throws(() => formatBillNo('KKKK', '26-27', 1), { code: 'BILL_NO_TOO_LONG' });
  const t = setup({ now: new Date('2027-03-31T20:00:00').getTime() });
  const m = seedMenu(t);
  const a = t.cmd('biller', 'bill.print', { orderId: order(t, m, 0) });
  const b = t.cmd('biller', 'bill.print', { orderId: order(t, m, 1) });
  t.clock.now = new Date('2027-04-01T12:00:00').getTime();
  const c = t.cmd('biller', 'bill.print', { orderId: order(t, m, 2) });
  assert.deepEqual([a.no, b.no, c.no], ['KK1/26-27/000001', 'KK1/26-27/000002', 'KK1/27-28/000001']);
});

test('bill totals equal the legacy port in paise; snapshot frozen on the bill', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = order(t, m);
  const r = t.cmd('biller', 'bill.print', { orderId: oid });
  const b = get(t.db, 'SELECT * FROM bills WHERE id=?', r.billId);
  const exp = totalsToPaise(calcTotals(legacyOrder(all(t.db, 'SELECT * FROM order_lines WHERE order_id=?', oid), {}), getSettings(t.db)));
  assert.deepEqual([b.subtotal_paise, b.cgst_paise, b.sgst_paise, b.roundoff_paise, b.total_paise], [exp.subtotal, exp.cgst, exp.sgst, exp.roundOff, exp.total]);
  assert.equal(b.subtotal_paise, 21900 + 2 * 4500);
  const snap = JSON.parse(b.snapshot);
  assert.equal(snap.title, 'Bill'); // legacy: "TAX INVOICE" only when a GSTIN is set
  assert.deepEqual(JSON.parse(b.taxes).map((/** @type {any} */ x) => x.name), ['CGST', 'SGST']);
  assert.equal(snap.sac, '996331');
  assert.equal(snap.lines.length, 2);
  assert.equal(get(t.db, 'SELECT status FROM orders WHERE id=?', oid).status, 'billed');
});

test('re-print keeps the number; reprint counter increments', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = order(t, m);
  const a = t.cmd('biller', 'bill.print', { orderId: oid });
  const b = t.cmd('biller', 'bill.print', { orderId: oid, discount: { type: 'pct', value: 10, reason: 'regular' }, approval: t.approval() });
  assert.equal(a.no, b.no);
  assert.ok(b.totalPaise < a.totalPaise);
  t.cmd('biller', 'bill.reprint', { billId: a.billId });
  t.cmd('biller', 'bill.reprint', { billId: a.billId });
  assert.equal(get(t.db, 'SELECT reprints FROM bills WHERE id=?', a.billId).reprints, 2);
});

test('discount: biller needs approval, approver recorded, limits as in the legacy app', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = order(t, m);
  t.code('APPROVAL_REQUIRED', () => t.cmd('biller', 'bill.print', { orderId: oid, discount: { type: 'fixed', value: 20, reason: 'x' } }));
  t.code('BAD_PAYLOAD', () => t.cmd('manager', 'bill.print', { orderId: oid, discount: { type: 'pct', value: 101 } }));
  t.code('BAD_PAYLOAD', () => t.cmd('manager', 'bill.print', { orderId: oid, discount: { type: 'fixed', value: 99999 } }));
  const r = t.cmd('biller', 'bill.print', { orderId: oid, discount: { type: 'fixed', value: 20, reason: 'friend' }, approval: t.approval('owner') });
  const b = get(t.db, 'SELECT * FROM bills WHERE id=?', r.billId);
  assert.deepEqual([b.discount_paise, b.discount_reason, b.approver_id], [2000, 'friend', t.users.owner]);
  assert.equal(get(t.db, "SELECT COUNT(*) AS n FROM void_log WHERE entity='bill_discount'").n, 1);
});

test('complimentary bill totals zero', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('manager', 'bill.print', { orderId: order(t, m), complimentary: 'Owner guest' });
  assert.equal(r.totalPaise, 0);
});

test('service charge is never applied by default; only when toggled for that bill', () => {
  const t = setup();
  const m = seedMenu(t);
  const a = t.cmd('biller', 'bill.print', { orderId: order(t, m, 0) });
  const b = t.cmd('biller', 'bill.print', { orderId: order(t, m, 1), serviceCharge: 'yes' }); // truthy but not true -> off
  const c = t.cmd('biller', 'bill.print', { orderId: order(t, m, 2), serviceCharge: true });
  const sc = (/** @type {string} */ id) => get(t.db, 'SELECT service_paise FROM bills WHERE id=?', id).service_paise;
  assert.deepEqual([sc(a.billId), sc(b.billId)], [0, 0]);
  assert.equal(sc(c.billId), Math.round((21900 + 9000) * 0.05));
  // separate line, GST computed on the same taxable value
  const ga = get(t.db, 'SELECT cgst_paise FROM bills WHERE id=?', a.billId).cgst_paise;
  const gc = get(t.db, 'SELECT cgst_paise FROM bills WHERE id=?', c.billId).cgst_paise;
  assert.equal(ga, gc);
});

test('composition scheme -> Bill of Supply without tax lines', () => {
  const t = setup();
  const m = seedMenu(t);
  t.cmd('owner', 'settings.update', { patch: { compositionScheme: true } });
  const r = t.cmd('biller', 'bill.print', { orderId: order(t, m) });
  const b = get(t.db, 'SELECT * FROM bills WHERE id=?', r.billId);
  const snap = JSON.parse(b.snapshot);
  assert.deepEqual([snap.title, b.cgst_paise, b.sgst_paise, b.composition], ['Bill of Supply', 0, 0, 1]);
  assert.match(snap.compositionLegend, /Composition/);
});

test('void bill reopens the order; voided number stays in the series', () => {
  const t = setup();
  const m = seedMenu(t);
  const oid = order(t, m);
  const a = t.cmd('biller', 'bill.print', { orderId: oid });
  t.code('APPROVAL_REQUIRED', () => t.cmd('biller', 'bill.void', { billId: a.billId, reason: 'x' }));
  t.cmd('biller', 'bill.void', { billId: a.billId, reason: 'added items', approval: t.approval() });
  assert.equal(get(t.db, 'SELECT status FROM orders WHERE id=?', oid).status, 'open');
  t.cmd('captain', 'kot.create', { orderId: oid, lines: [{ itemId: m.items.naan, qty: 1 }] });
  const b = t.cmd('biller', 'bill.print', { orderId: oid });
  assert.equal(b.no, 'KK1/26-27/000002');
  assert.equal(get(t.db, 'SELECT status FROM bills WHERE id=?', a.billId).status, 'void');
});

test('two billers interleaved on many tables -> consecutive, unique bill numbers', () => {
  const t = setup();
  const g = t.cmd('owner', 'menu.group.save', { name: 'G' }).id;
  const s = t.cmd('owner', 'layout.section.save', { name: 'S' }).id;
  const item = t.cmd('owner', 'menu.item.save', { name: 'Thali', pricePaise: 19999, groupId: g }).id;
  const orders = [];
  for (let i = 0; i < 40; i++) {
    const tid = t.cmd('owner', 'layout.table.save', { sectionId: s, name: 'T' + i }).id;
    orders.push(t.cmd(i % 2 ? 'captain' : 'manager', 'kot.create', { tableId: tid, lines: [{ itemId: item, qty: 1 + (i % 3) }] }).orderId);
  }
  const nos = orders.map((oid, i) => t.cmd(i % 2 ? 'biller' : 'manager', 'bill.print', { orderId: oid }).no);
  const seqs = nos.map((n) => Number(n.split('/')[2]));
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.ok(nos.every((n) => n.length <= 16));
});

test('equal split: whole-rupee shares, the last share takes the rest (legacy), exact sum', () => {
  for (const [total, ways] of [[100000, 3], [99900, 7], [0, 2], [50000, 4]]) {
    const parts = splitEqual(total, ways);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    assert.ok(parts.slice(0, -1).every((p) => p % 100 === 0 && p === parts[0]));
  }
  assert.deepEqual(splitEqual(100000, 3), [33300, 33300, 33400]);
});

test('delivery charge (right: delivery) and tax list from settings on the bill', () => {
  const t = setup();
  const m = seedMenu(t);
  t.cmd('owner', 'settings.update', { patch: { taxes: [{ name: 'CGST', rate: 2.5 }, { name: 'SGST', rate: 2.5 }, { name: 'Cess', rate: 1 }], taxOnDelivery: true, defaultDelivery: 40, gstin: '24ABCDE1234F1Z5' } });
  const o = t.cmd('biller', 'order.open', { type: 'delivery', platform: 'Swiggy', customer: { name: 'Asha', phone: '9876543210' } });
  assert.match(o.ref, /^SW\d+$/);
  t.cmd('biller', 'order.line.add', { orderId: o.orderId, lines: [{ itemId: m.items.dal, qty: 1 }] });
  t.code('FORBIDDEN', () => t.cmd('captain', 'order.delivery.charge', { orderId: o.orderId, amountPaise: 3000 }));
  t.cmd('biller', 'order.delivery.charge', { orderId: o.orderId, amountPaise: 3000 });
  const b = t.cmd('biller', 'bill.print', { orderId: o.orderId });
  const row = get(t.db, 'SELECT * FROM bills WHERE id=?', b.billId);
  // 219 + 30 delivery taxed: taxable 249 -> 6.23 + 6.23 + 2.49 = 14.95; raw 263.95 -> 264
  assert.deepEqual([row.delivery_paise, row.taxable_paise, row.tax_paise, row.total_paise], [3000, 24900, 1495, 26400]);
  assert.equal(JSON.parse(row.snapshot).title, 'Tax Invoice');
  const p = t.cmd('biller', 'order.open', { type: 'takeaway' });
  assert.match(p.ref, /^PK\d+$/);
});
