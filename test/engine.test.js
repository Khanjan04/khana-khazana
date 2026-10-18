// @ts-check
// Day 2 exit: duplicate opId -> one event, same result; failing handler rolls back;
// seq strictly increasing; 1,000-op duplicate-opId fuzz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, seedMenu } from './helpers.js';
import { get, all } from '../server/db.js';

test('duplicate opId returns the stored result and appends one event', () => {
  const t = setup();
  const m = seedMenu(t);
  const before = get(t.db, 'SELECT COUNT(*) AS n FROM events').n;
  const opId = randomUUID();
  const cmd = { opId, type: 'kot.create', payload: { tableId: m.tables[0], lines: [{ itemId: m.items.dal, qty: 2 }] } };
  const a = t.exec(cmd, t.ctx('captain'));
  const b = t.exec(cmd, t.ctx('captain'));
  const c = t.exec(cmd, t.ctx('captain'));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM events').n, before + 1);
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM kots').n, 1);
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM order_lines').n, 1);
});

test('failing handler rolls back every write', () => {
  const t = setup();
  const m = seedMenu(t);
  const counts = () => ['orders', 'order_lines', 'kots', 'events', 'ops', 'counters'].map((x) => get(t.db, `SELECT COUNT(*) AS n FROM ${x}`).n);
  const before = counts();
  // second line references a missing item: order + first line were already inserted inside the tx
  t.code('NOT_FOUND', () => t.cmd('captain', 'kot.create', { tableId: m.tables[1], lines: [{ itemId: m.items.dal, qty: 1 }, { itemId: 'nope', qty: 1 }] }));
  assert.deepEqual(counts(), before);
  assert.equal(t.broadcasts.filter((b) => b.data.changes.some((/** @type {any} */ c) => c.entity === 'orders' && c.value?.tableId === m.tables[1])).length, 0);
});

test('seq is strictly increasing and contiguous; broadcast after commit carries the seq', () => {
  const t = setup();
  const m = seedMenu(t);
  for (let i = 0; i < 20; i++) t.cmd('captain', 'kot.create', { tableId: m.tables[i % 4], lines: [{ itemId: m.items.naan, qty: 1 }] });
  const seqs = all(t.db, 'SELECT seq FROM events ORDER BY seq').map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1);
  const bs = t.broadcasts.map((b) => b.seq);
  assert.deepEqual(bs, seqs);
});

test('unknown command and forbidden right are rejected before any write', () => {
  const t = setup();
  t.code('UNKNOWN_CMD', () => t.cmd('owner', 'nope.nope'));
  t.code('FORBIDDEN', () => t.cmd('captain', 'settings.update', { patch: { name: 'x' } }));
  t.code('BAD_OPID', () => t.exec({ opId: '', type: 'order.open', payload: {} }, t.ctx('owner')));
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM ops').n, 0);
});

test('fuzz: 1,000 ops with random duplicates -> exactly one effect per opId', () => {
  const t = setup();
  const m = seedMenu(t);
  const startKots = get(t.db, 'SELECT COUNT(*) AS n FROM kots').n;
  /** @type {any[]} */
  const sent = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  /** @type {Map<string, any>} */
  const first = new Map();
  for (let i = 0; i < 1000; i++) {
    let cmd;
    if (sent.length && rnd() < 0.4) cmd = sent[Math.floor(rnd() * sent.length)];        // resend an old opId
    else {
      cmd = { opId: randomUUID(), type: 'kot.create', payload: { tableId: m.tables[Math.floor(rnd() * 4)], lines: [{ itemId: m.items.naan, qty: 1 + Math.floor(rnd() * 3) }] } };
      sent.push(cmd);
    }
    const r = t.exec(cmd, t.ctx('captain'));
    if (first.has(cmd.opId)) assert.deepEqual(r, first.get(cmd.opId));
    else first.set(cmd.opId, r);
  }
  const unique = new Set(sent.map((c) => c.opId)).size;
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM kots').n - startKots, unique);
  assert.equal(get(t.db, "SELECT COUNT(*) AS n FROM ops WHERE type='kot.create'").n, unique);
  // KOT numbers unique per business day
  const dupNos = get(t.db, 'SELECT COUNT(*) AS n FROM (SELECT business_date, no FROM kots GROUP BY 1,2 HAVING COUNT(*)>1)').n;
  assert.equal(dupNos, 0);
});
