// @ts-check
// MONEY. Port of the legacy calcTotals (legacy/khanakhajana_v13.html).
//
// !!! Day 8 rule: paste the father's calcTotals VERBATIM between the markers below,
// replacing only globals with parameters. The body currently in place is a
// faithful-shape stand-in written from PLAN §7 so the pipeline runs end to end.
// Do NOT "improve" rounding or tax logic without an explicit task; the golden
// parity test (test/totals.golden.test.js) is the arbiter.
//
// Legacy works in rupees (floats) with r2 rounding; stored values are integer
// paise, converted only at the edge by toPaise()/fromPaise().

/** Legacy 2-decimal rounding — exact formula, do not change. @param {number} n */
export const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @typedef {{ price: number, qty: number, extras?: {price: number}[], void?: boolean }} LegacyLine
 * @typedef {{ lines: LegacyLine[], discount?: {type: 'pct'|'fixed', value: number} | null,
 *   complimentary?: boolean, serviceCharge?: boolean }} LegacyOrder
 * @typedef {{ cgst?: number, sgst?: number, specifiedPremises?: boolean, compositionScheme?: boolean,
 *   serviceChargePct?: number }} LegacySettings
 * @typedef {{ subtotal: number, discount: number, taxable: number, cgstRate: number, sgstRate: number,
 *   cgst: number, sgst: number, serviceCharge: number, roundOff: number, total: number }} Totals
 */

// ===== BEGIN LEGACY calcTotals (replace with verbatim port on Day 8) =====
/**
 * @param {LegacyOrder} o
 * @param {LegacySettings} s
 * @returns {Totals}
 */
export function calcTotals(o, s) {
  var sub = 0;
  (o.lines || []).forEach(function (l) {
    if (l.void) return;
    var unit = Number(l.price) || 0;
    (l.extras || []).forEach(function (e) { unit += Number(e.price) || 0; });
    sub += unit * (Number(l.qty) || 0);
  });
  sub = r2(sub);
  var disc = 0;
  if (o.complimentary) disc = sub;
  else if (o.discount && o.discount.value > 0) {
    disc = o.discount.type === 'pct' ? r2(sub * o.discount.value / 100) : r2(Math.min(o.discount.value, sub));
  }
  var taxable = r2(sub - disc);
  var comp = !!s.compositionScheme;
  var cgR = comp ? 0 : s.specifiedPremises ? 9 : Number(s.cgst ?? 2.5);
  var sgR = comp ? 0 : s.specifiedPremises ? 9 : Number(s.sgst ?? 2.5);
  var cgst = r2(taxable * cgR / 100);
  var sgst = r2(taxable * sgR / 100);
  // Service charge: opt-in per bill, separate line, NOT added before GST (CCPA).
  var sc = o.serviceCharge ? r2(taxable * Number(s.serviceChargePct || 0) / 100) : 0;
  var raw = taxable + cgst + sgst + sc;
  var total = Math.round(raw);
  var roundOff = r2(total - raw);
  return { subtotal: sub, discount: disc, taxable: taxable, cgstRate: cgR, sgstRate: sgR, cgst: cgst, sgst: sgst, serviceCharge: sc, roundOff: roundOff, total: total };
}
// ===== END LEGACY calcTotals =====

/** Rupees (legacy float) -> integer paise. Edge conversion only; normalises -0 to 0. @param {number} r */
export const toPaise = (r) => Math.round(r * 100) || 0;
/** @param {number} p */
export const fromPaise = (p) => p / 100;

/** @param {Totals} t */
export function totalsToPaise(t) {
  return {
    subtotal: toPaise(t.subtotal), discount: toPaise(t.discount), taxable: toPaise(t.taxable),
    cgst: toPaise(t.cgst), sgst: toPaise(t.sgst), serviceCharge: toPaise(t.serviceCharge),
    roundOff: toPaise(t.roundOff), total: toPaise(t.total), cgstRate: t.cgstRate, sgstRate: t.sgstRate,
  };
}

/** Format paise as ₹ string with 2 decimals. @param {number} p */
export const rupees = (p) => (p / 100).toFixed(2);
