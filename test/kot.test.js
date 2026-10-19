// @ts-check
// Day 2/14: kot.create (order auto-open, KOT no from counters, daily reset), state machine, recall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedMenu } from './helpers.js';
import { get, all } from '../server/db.js';
import { TRANSITIONS } from '../server/commands/kot.js';

test('kot.create auto-opens an order for the table and reuses it', () => {
  const t = setup();
  const m = seedMenu(t);
  const a = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  const b = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.naan, qty: 4 }] });
  assert.equal(a.orderId, b.orderId);
  assert.deepEqual([a.kots[0].no, b.kots[0].no], [1, 2]);
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM orders').n, 1);
  const o = get(t.db, 'SELECT * FROM orders WHERE id=?', a.orderId);
  assert.equal(o.no, 1);
  assert.equal(o.status, 'open');
});

test('host prices lines: variant replaces price, shared extras with their own qty, notes joined', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.tikka, qty: 2, variant: 'Half', sides: [{ id: m.sides.cheese, qty: 3 }], notes: ['Jain', 'Less Spicy'], note: 'no onion', pricePaise: 1 }] });
  const l = get(t.db, 'SELECT * FROM order_lines WHERE order_id=?', r.orderId);
  assert.equal(l.unit_paise, 14900);
  assert.deepEqual(JSON.parse(l.extras), [{ id: m.sides.cheese, name: 'Cheese', pricePaise: 4000, qty: 3 }]);
  assert.equal(l.note, 'Jain, Less Spicy, no onion');
  // dish with variations needs one; extras only where allowed; "not available today" is refused
  t.code('VARIANT_REQUIRED', () => t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.tikka, qty: 1 }] }));
  t.code('BAD_PAYLOAD', () => t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.dal, qty: 1, sides: [{ id: m.sides.cheese, qty: 1 }] }] }));
  t.cmd('manager', 'menu.item.available', { id: m.items.naan, available: false });
  t.code('NOT_AVAILABLE', () => t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.naan, qty: 1 }] }));
});

test('lines split into one KOT per kitchen station', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }, { itemId: m.items.lime, qty: 2 }] });
  assert.deepEqual(r.kots.map((/** @type {any} */ k) => k.station).sort(), ['bar', 'kitchen']);
  assert.notEqual(r.kots[0].no, r.kots[1].no);
});

test('KOT numbers reset on a new business day (dayStartHour 4)', () => {
  const t = setup({ now: new Date('2026-10-18T23:30:00').getTime() });
  const m = seedMenu(t);
  assert.equal(t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0].no, 1);
  t.clock.now = new Date('2026-10-19T02:00:00').getTime(); // still business day 18th
  assert.equal(t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0].no, 2);
  t.clock.now = new Date('2026-10-19T11:00:00').getTime();
  assert.equal(t.cmd('captain', 'kot.create', { tableId: m.tables[2], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0].no, 1);
  assert.deepEqual(all(t.db, 'SELECT DISTINCT business_date AS d FROM kots ORDER BY d').map((r) => r.d), ['2026-10-18', '2026-10-19']);
});

test('state machine: valid path, invalid transition -> BAD_TRANSITION', () => {
  const t = setup();
  const m = seedMenu(t);
  const k = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0];
  t.code('BAD_TRANSITION', () => t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'ready' }));
  for (const to of ['accepted', 'preparing', 'ready']) t.cmd('kitchen', 'kot.status', { kotId: k.id, to });
  t.code('FORBIDDEN', () => t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'served' })); // kitchen has no 'serve'
  t.cmd('captain', 'kot.status', { kotId: k.id, to: 'served' });
  t.code('BAD_TRANSITION', () => t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'accepted' }));
  const log = all(t.db, 'SELECT from_status, to_status FROM kot_status_log WHERE kot_id=? ORDER BY id', k.id);
  assert.deepEqual(log.map((x) => x.to_status), ['new', 'accepted', 'preparing', 'ready', 'served']);
});

test('TRANSITIONS table is exactly PLAN §7', () => {
  assert.deepEqual(TRANSITIONS, {
    new: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing', 'rejected', 'cancelled'],
    preparing: ['ready', 'cancelled'], ready: ['served', 'cancelled'], served: [], rejected: [], cancelled: [],
  });
});

test('reject needs a reason and voids the KOT lines with a void_log entry', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  const k = r.kots[0];
  t.code('BAD_PAYLOAD', () => t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'rejected' }));
  t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'rejected', reason: 'Out of stock' });
  assert.equal(get(t.db, 'SELECT voided FROM order_lines WHERE kot_id=?', k.id).voided, 1);
  assert.equal(get(t.db, "SELECT COUNT(*) AS n FROM void_log WHERE entity='kot'").n, 1);
});

test('cancel needs void right or approval; approver is recorded', () => {
  const t = setup();
  const m = seedMenu(t);
  const k = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0];
  t.code('APPROVAL_REQUIRED', () => t.cmd('captain', 'kot.status', { kotId: k.id, to: 'cancelled', reason: 'left' }));
  t.code('BAD_LOGIN', () => t.cmd('captain', 'kot.status', { kotId: k.id, to: 'cancelled', reason: 'left', approval: { userId: t.users.manager, pin: '0000' } }));
  t.code('APPROVAL_DENIED', () => t.cmd('captain', 'kot.status', { kotId: k.id, to: 'cancelled', reason: 'left', approval: t.approval('biller') }));
  t.cmd('captain', 'kot.status', { kotId: k.id, to: 'cancelled', reason: 'left', approval: t.approval('manager') });
  const v = get(t.db, "SELECT * FROM void_log WHERE entity='kot'");
  assert.equal(v.approver_id, t.users.manager);
  assert.equal(get(t.db, 'SELECT approver_id FROM kot_status_log WHERE kot_id=? ORDER BY id DESC LIMIT 1', k.id).approver_id, t.users.manager);
});

test('recall within 2 minutes reverts the last kitchen status', () => {
  const t = setup();
  const m = seedMenu(t);
  const k = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] }).kots[0];
  t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'accepted' });
  t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'preparing' });
  t.clock.now += 60_000;
  assert.equal(t.cmd('kitchen', 'kot.recall', { kotId: k.id }).status, 'accepted');
  t.cmd('kitchen', 'kot.status', { kotId: k.id, to: 'preparing' });
  t.clock.now += 3 * 60_000;
  t.code('CANNOT_RECALL', () => t.cmd('kitchen', 'kot.recall', { kotId: k.id }));
});

test('nothing new to send -> NO_LINES; billed order refuses new KOTs', () => {
  const t = setup();
  const m = seedMenu(t);
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  t.code('NO_LINES', () => t.cmd('captain', 'kot.create', { orderId: r.orderId }));
  t.cmd('biller', 'bill.print', { orderId: r.orderId });
  t.code('ORDER_BILLED', () => t.cmd('captain', 'kot.create', { orderId: r.orderId, lines: [{ itemId: m.items.dal, qty: 1 }] }));
});

test('kotAutoPrint queues a host print after commit', () => {
  const t = setup();
  const m = seedMenu(t);
  t.cmd('owner', 'settings.update', { patch: { kotAutoPrint: true } });
  const r = t.cmd('captain', 'kot.create', { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 1 }] });
  assert.deepEqual(t.printed, [{ kind: 'kot', id: r.kots[0].id }]);
});
