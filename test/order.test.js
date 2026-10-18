// @ts-check
// Day 11: order commands; approval {userId,pin} inside cmd; void_log records approver.
// Exit: Biller void without approval fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedMenu } from './helpers.js';
import { get, all } from '../server/db.js';

/** @param {ReturnType<typeof setup>} t @param {any} m */
function sentOrder(t, m) {
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 3 }, { itemId: m.items.naan, qty: 2 }] });
  const lines = all(t.db, 'SELECT * FROM order_lines WHERE order_id=? ORDER BY rowid', r.orderId);
  return { orderId: r.orderId, dal: lines[0], naan: lines[1] };
}

test('biller void without approval fails; with manager approval succeeds and logs approver', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.code('APPROVAL_REQUIRED', () => t.cmd('biller', 'order.line.void', { lineId: o.dal.id, reason: 'wrong' }));
  t.code('BAD_LOGIN', () => t.cmd('biller', 'order.line.void', { lineId: o.dal.id, reason: 'wrong', approval: { userId: t.users.manager, pin: '9999' } }));
  t.code('APPROVAL_DENIED', () => t.cmd('biller', 'order.line.void', { lineId: o.dal.id, reason: 'wrong', approval: t.approval('captain') }));
  t.cmd('biller', 'order.line.void', { lineId: o.dal.id, reason: 'wrong', approval: t.approval('manager') });
  const v = get(t.db, "SELECT * FROM void_log WHERE entity='order_line'");
  assert.equal(v.user_id, t.users.biller);
  assert.equal(v.approver_id, t.users.manager);
  assert.equal(get(t.db, 'SELECT approver_id FROM events ORDER BY seq DESC LIMIT 1').approver_id, t.users.manager);
  // captain lacks void entirely: approval allowed for void, so also APPROVAL_REQUIRED
  t.code('APPROVAL_REQUIRED', () => t.cmd('captain', 'order.line.void', { lineId: o.naan.id, reason: 'x' }));
  // kitchen lacks the base right 'order' -> plain FORBIDDEN even with approval
  t.code('FORBIDDEN', () => t.cmd('kitchen', 'order.line.void', { lineId: o.naan.id, reason: 'x', approval: t.approval() }));
});

test('partial void splits the line', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.cmd('manager', 'order.line.void', { lineId: o.dal.id, reason: 'one returned', qty: 1 });
  const rows = all(t.db, 'SELECT qty, voided FROM order_lines WHERE order_id=? AND item_id=? ORDER BY voided', o.orderId, m.items.dal);
  assert.deepEqual(rows.map((r) => [r.qty, r.voided]), [[2, 0], [1, 1]]);
  t.code('BAD_PAYLOAD', () => t.cmd('manager', 'order.line.void', { lineId: o.naan.id, reason: 'x', qty: 5 }));
  t.code('BAD_PAYLOAD', () => t.cmd('manager', 'order.line.void', { lineId: o.naan.id }));
});

test('unsent lines: add / update / remove; sent lines cannot be edited', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.code('LINE_SENT', () => t.cmd('captain', 'order.line.update', { lineId: o.dal.id, qty: 1 }));
  const add = t.cmd('biller', 'order.line.add', { orderId: o.orderId, lines: [{ name: 'Water bottle', pricePaise: 2000, qty: 2 }] });
  const lid = add.lineIds[0];
  t.cmd('biller', 'order.line.update', { lineId: lid, qty: 3, note: 'cold' });
  assert.deepEqual([get(t.db, 'SELECT qty, note, unit_paise, item_id FROM order_lines WHERE id=?', lid)].map((r) => [r.qty, r.note, r.unit_paise, r.item_id]), [[3, 'cold', 2000, null]]);
  t.cmd('biller', 'order.line.remove', { lineId: lid });
  assert.equal(get(t.db, 'SELECT id FROM order_lines WHERE id=?', lid), undefined);
});

test('hold, persons, comment, customer, delivery platform', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.cmd('captain', 'order.hold', { orderId: o.orderId, held: true });
  t.cmd('captain', 'order.persons', { orderId: o.orderId, persons: 4 });
  t.cmd('captain', 'order.comment', { orderId: o.orderId, comment: 'birthday' });
  const c = t.cmd('captain', 'order.customer', { orderId: o.orderId, phone: '98 1234 5678', name: 'Ramesh' });
  const row = get(t.db, 'SELECT * FROM orders WHERE id=?', o.orderId);
  assert.deepEqual([row.held, row.persons, row.comment, row.customer_id], [1, 4, 'birthday', c.customerId]);
  assert.equal(get(t.db, 'SELECT phone FROM customers').phone, '9812345678');
  // same phone -> same customer
  assert.equal(t.cmd('captain', 'order.customer', { orderId: o.orderId, phone: '9812345678' }).customerId, c.customerId);

  const take = t.cmd('biller', 'order.open', { type: 'takeaway' });
  t.code('FORBIDDEN', () => t.cmd('captain', 'order.delivery', { orderId: take.orderId, platform: 'Zomato' }));
  t.code('BAD_PAYLOAD', () => t.cmd('biller', 'order.delivery', { orderId: take.orderId, platform: 'UberEats' }));
  t.cmd('delivery', 'order.delivery', { orderId: take.orderId, platform: 'Swiggy', ref: 'SW-991' });
  assert.deepEqual([get(t.db, 'SELECT type, platform, platform_ref FROM orders WHERE id=?', take.orderId)].map((r) => [r.type, r.platform, r.platform_ref]), [['delivery', 'Swiggy', 'SW-991']]);
});

test('table transfer only to a free table', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.dal, qty: 1 }] });
  t.code('TABLE_BUSY', () => t.cmd('captain', 'table.transfer', { orderId: o.orderId, toTableId: m.tables[1] }));
  t.cmd('captain', 'table.transfer', { orderId: o.orderId, toTableId: m.tables[2] });
  assert.equal(get(t.db, 'SELECT table_id FROM orders WHERE id=?', o.orderId).table_id, m.tables[2]);
  // the old table is free again: a new KOT there opens a new order
  const n = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  assert.notEqual(n.orderId, o.orderId);
});

test('order.cancel (approval) cancels KOTs, voids lines and frees the table', () => {
  const t = setup();
  const m = seedMenu(t);
  const o = sentOrder(t, m);
  t.code('APPROVAL_REQUIRED', () => t.cmd('captain', 'order.cancel', { orderId: o.orderId, reason: 'left' }));
  t.cmd('captain', 'order.cancel', { orderId: o.orderId, reason: 'left', approval: t.approval('owner') });
  assert.equal(get(t.db, 'SELECT status FROM orders WHERE id=?', o.orderId).status, 'cancelled');
  assert.equal(get(t.db, "SELECT COUNT(*) AS n FROM kots WHERE order_id=? AND status<>'cancelled'", o.orderId).n, 0);
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM order_lines WHERE order_id=? AND voided=0', o.orderId).n, 0);
  assert.equal(get(t.db, "SELECT approver_id FROM void_log WHERE entity='order'").approver_id, t.users.owner);
});
