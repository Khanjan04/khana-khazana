// test/totals.golden.test.js (PROTECTED). server/domain/totals.js must reproduce the father's
// calcTotals exactly. expected_totals.json is produced by the LEGACY function itself
// (scripts/make-golden.js runs legacy/khanakhajana_v13.html in node:vm). Must report 0 differences.
// Fix the port, never the fixture.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs'; import { calcTotals } from '../server/domain/totals.js';
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const backup = load('./golden/backup_v13.json'), expected = load('./golden/expected_totals.json');
const goldenOrder = (b) => ({ lines: b.lines, discount: b.discount, comp: !!b.totals.comp, delivery: b.totals.delivery });
test('golden parity: every legacy bill', () => {
  const diffs = backup.bills.filter(b => !b.splitNo).map(b => ({ id: b.id, got: calcTotals(goldenOrder(b), backup.settings), exp: expected[b.id] }))
    .filter(d => JSON.stringify(d.got) !== JSON.stringify(d.exp));
  assert.equal(diffs.length, 0, JSON.stringify(diffs.slice(0, 5), null, 1));
});
test('golden parity: every running (open) order', () => {
  const diffs = Object.values(backup.orders || {}).map(o => ({ id: o.id, got: calcTotals(o, backup.settings), exp: expected['open:' + o.id] }))
    .filter(d => JSON.stringify(d.got) !== JSON.stringify(d.exp));
  assert.equal(diffs.length, 0, JSON.stringify(diffs.slice(0, 5), null, 1));
});
test('golden fixture covers every bill', () => {
  assert.ok(backup.bills.length > 0);
  assert.equal(Object.keys(expected).length, backup.bills.filter(b => !b.splitNo).length + Object.keys(backup.orders || {}).length);
});
