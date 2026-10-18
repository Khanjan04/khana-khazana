// test/totals.golden.test.js (PROTECTED). totals.js exports r2 = Math.round((n+Number.EPSILON)*100)/100.
// Compares every bill field of the port against expected_totals.json produced by the LEGACY
// calcTotals (scripts/make-golden.js). Must report 0 differences. Fix the port, never the fixture.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs'; import { calcTotals } from '../server/domain/totals.js';
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const backup = load('./golden/backup_v13.json'), expected = load('./golden/expected_totals.json');
test('golden parity: every legacy bill', () => {
  const diffs = backup.orders.map(o => ({ id: o.id, got: calcTotals(o, backup.settings), exp: expected[o.id] }))
    .filter(d => JSON.stringify(d.got) !== JSON.stringify(d.exp));
  assert.equal(diffs.length, 0, JSON.stringify(diffs.slice(0, 5), null, 1));
});
test('golden fixture covers every order', () => {
  assert.ok(backup.orders.length > 0);
  assert.equal(Object.keys(expected).length, backup.orders.length);
});
