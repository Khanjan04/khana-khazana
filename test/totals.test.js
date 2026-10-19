// @ts-check
// Hand-computed totals with the father's formula (independent of the golden fixture),
// the GST-mode / service-charge layer on top, and the paise edge conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcTotals, billTotals, r2, toPaise, totalsToPaise, linePaise } from '../server/domain/totals.js';

const S = { taxes: [{ name: 'CGST', rate: 2.5 }, { name: 'SGST', rate: 2.5 }], taxOnDelivery: false };
const L = (/** @type {number} */ price, qty = 1, extras = /** @type {[number, number][]} */ ([]), v = false) => ({ price, qty, extras: extras.map(([p, q]) => ({ price: p, qty: q })), void: v });

test('r2 is the legacy formula', () => {
  assert.equal(r2(7.725), 7.73);
  assert.equal(r2(1.005), 1.01);
  assert.equal(r2(2.675), 2.68);
  assert.equal(r2(-0.455), -0.45);
});

test('5% GST as a CGST + SGST tax list, rounded to the rupee', () => {
  const t = calcTotals({ lines: [L(219), L(45, 2)] }, S);
  assert.deepEqual(t, { sub: 309, disc: 0, delivery: 0, taxable: 309,
    taxes: [{ name: 'CGST', rate: 2.5, amount: 7.73 }, { name: 'SGST', rate: 2.5, amount: 7.73 }], taxTotal: 15.46, roundOff: -0.46, total: 324 });
});

test('discount: percentage (max 100) and fixed (max subtotal)', () => {
  const p = calcTotals({ lines: [L(219), L(45, 2)], discount: { mode: 'pct', value: 10 } }, S);
  assert.deepEqual([p.disc, p.taxable, p.taxes[0].amount, p.total], [30.9, 278.1, 6.95, 292]);
  const f = calcTotals({ lines: [L(100)], discount: { mode: 'fix', value: 500 } }, S);
  assert.deepEqual([f.disc, f.taxable, f.total], [100, 0, 0]);
  const big = calcTotals({ lines: [L(100)], discount: { mode: 'pct', value: 150 } }, S);
  assert.equal(big.disc, 100);
});

test('extras have their own quantity and are NOT multiplied by the dish quantity; voids excluded', () => {
  const t = calcTotals({ lines: [L(100, 2, [[25, 2], [10, 1]]), L(999, 1, [], true)] }, S);
  assert.equal(t.sub, 260); // 100×2 + 25×2 + 10×1
  assert.equal(linePaise({ unitPaise: 10000, qty: 2, extras: [{ pricePaise: 2500, qty: 2 }, { pricePaise: 1000, qty: 1 }] }), 26000);
});

test('delivery charge: added after tax, taxed only when taxOnDelivery', () => {
  const a = calcTotals({ lines: [L(200)], delivery: 40 }, S);
  assert.deepEqual([a.taxable, a.taxTotal, a.total], [200, 10, 250]);
  const b = calcTotals({ lines: [L(200)], delivery: 40 }, { ...S, taxOnDelivery: true });
  assert.deepEqual([b.taxable, b.taxTotal, b.total], [240, 12, 252]);
});

test('complimentary: everything zero, value recorded', () => {
  const t = calcTotals({ lines: [L(500)], comp: true, delivery: 40 }, S);
  assert.deepEqual([t.total, t.comp, t.compValue, t.delivery], [0, true, 500, 0]);
});

test('GST mode on top of the legacy formula: specified premises 18%, composition no tax', () => {
  const sp = billTotals({ lines: [L(1000)] }, { ...S, specifiedPremises: true });
  assert.deepEqual([sp.taxes.map((x) => x.rate), sp.taxTotal, sp.total], [[9, 9], 180, 1180]);
  const comp = billTotals({ lines: [L(99.6)] }, { ...S, compositionScheme: true });
  assert.deepEqual([comp.taxes, comp.taxTotal, comp.total, comp.roundOff], [[], 0, 100, 0.4]);
  // default mode = exactly the legacy result
  assert.deepEqual(billTotals({ lines: [L(219), L(45, 2)] }, S), { ...calcTotals({ lines: [L(219), L(45, 2)] }, S), serviceCharge: 0 });
});

test('service charge only when opted in: separate line on taxable value, not added before GST', () => {
  const off = billTotals({ lines: [L(219), L(45, 2)] }, { ...S, serviceChargePct: 5 });
  assert.equal(off.serviceCharge, 0);
  const on = billTotals({ lines: [L(219), L(45, 2)], serviceCharge: true }, { ...S, serviceChargePct: 5 });
  assert.equal(on.serviceCharge, 15.45);
  assert.equal(on.taxTotal, off.taxTotal); // GST unchanged
  assert.equal(on.total, 340);              // round(309 + 15.46 + 15.45)
});

test('toPaise converts at the edge and normalises -0; tax list carried in paise', () => {
  assert.equal(toPaise(7.73), 773);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.ok(Object.is(toPaise(-0), 0));
  const p = totalsToPaise(billTotals({ lines: [L(219), L(45, 2)], discount: { mode: 'pct', value: 10 } }, S));
  for (const k of ['subtotal', 'discount', 'delivery', 'taxable', 'tax', 'cgst', 'sgst', 'serviceCharge', 'roundOff', 'total']) assert.ok(Number.isInteger(/** @type {any} */ (p)[k]), k);
  assert.deepEqual(p.taxes, [{ name: 'CGST', rate: 2.5, amountPaise: 695 }, { name: 'SGST', rate: 2.5, amountPaise: 695 }]);
  assert.equal(p.taxable + p.tax + p.delivery + p.roundOff, p.total);
});
