// @ts-check
// Hand-computed totals (independent of the golden fixture) + paise edge conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcTotals, r2, toPaise, totalsToPaise } from '../server/domain/totals.js';

const S = { cgst: 2.5, sgst: 2.5, serviceChargePct: 5 };
const L = (/** @type {number} */ price, qty = 1, extras = /** @type {number[]} */ ([]), v = false) => ({ price, qty, extras: extras.map((p) => ({ price: p })), void: v });

test('r2 is the legacy formula', () => {
  assert.equal(r2(7.725), 7.73);
  assert.equal(r2(1.005), 1.01);
  assert.equal(r2(2.675), 2.68);
  assert.equal(r2(-0.455), -0.45);
});

test('5% GST (CGST 2.5 + SGST 2.5), round to rupee with round-off line', () => {
  const t = calcTotals({ lines: [L(219), L(45, 2)] }, S);
  assert.deepEqual(t, { subtotal: 309, discount: 0, taxable: 309, cgstRate: 2.5, sgstRate: 2.5, cgst: 7.73, sgst: 7.73, serviceCharge: 0, roundOff: -0.46, total: 324 });
});

test('percentage and fixed discounts; fixed is capped at subtotal', () => {
  const p = calcTotals({ lines: [L(219), L(45, 2)], discount: { type: 'pct', value: 10 } }, S);
  assert.deepEqual([p.discount, p.taxable, p.cgst, p.total], [30.9, 278.1, 6.95, 292]);
  const f = calcTotals({ lines: [L(100)], discount: { type: 'fixed', value: 500 } }, S);
  assert.deepEqual([f.discount, f.taxable, f.total], [100, 0, 0]);
});

test('voided lines excluded, extras added per unit', () => {
  const t = calcTotals({ lines: [L(100, 2, [10, 5.5]), L(999, 1, [], true)] }, S);
  assert.equal(t.subtotal, 231);
});

test('specified premises = 18% (9 + 9); composition = no tax lines', () => {
  const sp = calcTotals({ lines: [L(1000)] }, { ...S, specifiedPremises: true });
  assert.deepEqual([sp.cgstRate, sp.cgst, sp.sgst, sp.total], [9, 90, 90, 1180]);
  const comp = calcTotals({ lines: [L(99.6)] }, { ...S, compositionScheme: true });
  assert.deepEqual([comp.cgst, comp.sgst, comp.total, comp.roundOff], [0, 0, 100, 0.4]);
});

test('complimentary zeroes the bill', () => {
  const t = calcTotals({ lines: [L(500)], complimentary: true }, S);
  assert.deepEqual([t.discount, t.total], [500, 0]);
});

test('service charge only when opted in; separate line on taxable value, not added before GST', () => {
  const off = calcTotals({ lines: [L(219), L(45, 2)] }, S);
  assert.equal(off.serviceCharge, 0);
  const on = calcTotals({ lines: [L(219), L(45, 2)], serviceCharge: true }, S);
  assert.equal(on.serviceCharge, 15.45);
  assert.equal(on.cgst, off.cgst); // GST unchanged by service charge
  assert.equal(on.total, 340);
});

test('toPaise converts at the edge and normalises -0', () => {
  assert.equal(toPaise(7.73), 773);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.ok(Object.is(toPaise(-0), 0));
  const p = totalsToPaise(calcTotals({ lines: [L(219), L(45, 2)], discount: { type: 'pct', value: 10 } }, S));
  assert.ok(Object.is(p.roundOff, 0) || Number.isInteger(p.roundOff));
  for (const k of ['subtotal', 'discount', 'taxable', 'cgst', 'sgst', 'serviceCharge', 'roundOff', 'total']) assert.ok(Number.isInteger(/** @type {any} */ (p)[k]), k);
});
