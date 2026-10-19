// @ts-check
// MONEY. Exact port of the legacy calcTotals from legacy/khanakhajana_v13.html (DB_VER 13).
// The block between the markers is the father's code VERBATIM; only the global
// `db.settings` became the parameter `s`, and its helpers (activeLines, lineTotal, num)
// are copied verbatim above it. Do NOT "improve" rounding or tax logic.
// test/totals.golden.test.js runs the legacy function itself (via node:vm) as the arbiter.
//
// Legacy works in rupees (floats); stored values are integer paise, converted only at the
// edge by toPaise()/totalsToPaise().

/** Legacy 2-decimal rounding — exact formula, do not change. @param {number} n */
export const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @typedef {{ price: number, qty: number, extras?: {price: number, qty: number}[], void?: boolean }} LegacyLine
 * @typedef {{ lines: LegacyLine[], discount?: {mode: 'pct'|'fix', value: number} | null, comp?: boolean, delivery?: number }} LegacyOrder
 * @typedef {{ taxes: {name: string, rate: number}[], taxOnDelivery?: boolean }} LegacySettings
 * @typedef {{ sub: number, disc: number, delivery: number, taxable: number, taxes: {name: string, rate: number, amount: number}[],
 *   taxTotal: number, roundOff: number, total: number, comp?: boolean, compValue?: number }} Totals
 */

// ===== BEGIN LEGACY calcTotals (verbatim; db.settings -> s) =====
/* eslint-disable */
const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const activeLines = o => o.lines.filter(l => !l.void);
const lineTotal = l => l.price * l.qty + (l.extras || []).reduce((s, e) => s + e.price * e.qty, 0);

/** @param {LegacyOrder} o @param {LegacySettings} s @returns {Totals} */
export function calcTotals(o, s) {
  const sub0 = r2(activeLines(o).reduce((t, l) => t + lineTotal(l), 0));
  if (o.comp) {
    return { sub: 0, disc: 0, delivery: 0, taxable: 0, taxes: s.taxes.map(t => ({ name: t.name, rate: t.rate, amount: 0 })), taxTotal: 0, roundOff: 0, total: 0, comp: true, compValue: sub0 };
  }
  const sub = sub0;
  let disc = 0;
  if (o.discount && o.discount.value > 0) {
    disc = o.discount.mode === 'pct' ? sub * Math.min(100, o.discount.value) / 100 : Math.min(o.discount.value, sub);
    disc = r2(disc);
  }
  const delivery = r2(num(o.delivery));
  const taxable = r2(sub - disc + (s.taxOnDelivery ? delivery : 0));
  const taxes = s.taxes.map(t => ({ name: t.name, rate: t.rate, amount: r2(taxable * t.rate / 100) }));
  const taxTotal = r2(taxes.reduce((t, x) => t + x.amount, 0));
  const raw = r2(sub - disc + delivery + taxTotal);
  const total = Math.round(raw);
  return { sub, disc, delivery, taxable, taxes, taxTotal, roundOff: r2(total - raw), total };
}
/* eslint-enable */
// ===== END LEGACY calcTotals =====

/**
 * Totals for a bill = legacy calcTotals + the two things the new product adds on top,
 * neither of which changes the legacy arithmetic when unused:
 *  - GST mode: composition => no tax lines; specified premises => CGST 9 + SGST 9.
 *  - Optional service charge (CCPA): only when opted in, a separate line on the taxable value,
 *    NOT added before GST; the rupee rounding is then redone on the new raw total.
 * @param {LegacyOrder & {serviceCharge?: boolean}} o
 * @param {LegacySettings & {compositionScheme?: boolean, specifiedPremises?: boolean, serviceChargePct?: number}} s
 */
export function billTotals(o, s) {
  const taxes = s.compositionScheme ? [] : s.specifiedPremises ? [{ name: 'CGST', rate: 9 }, { name: 'SGST', rate: 9 }] : s.taxes;
  const T = calcTotals(o, { taxes, taxOnDelivery: !!s.taxOnDelivery });
  let serviceCharge = 0, roundOff = T.roundOff, total = T.total;
  if (o.serviceCharge && !T.comp && Number(s.serviceChargePct) > 0) {
    serviceCharge = r2(T.taxable * Number(s.serviceChargePct) / 100);
    const raw = r2(T.total - T.roundOff + serviceCharge);
    total = Math.round(raw);
    roundOff = r2(total - raw);
  }
  return { ...T, serviceCharge, roundOff, total };
}

/** Rupees (legacy float) -> integer paise. Edge conversion only; normalises -0 to 0. @param {number} r */
export const toPaise = (r) => Math.round(r * 100) || 0;
/** @param {number} p */
export const fromPaise = (p) => p / 100;

/** @param {Totals & {serviceCharge?: number}} t */
export function totalsToPaise(t) {
  const taxes = t.taxes.map((x) => ({ name: x.name, rate: x.rate, amountPaise: toPaise(x.amount) }));
  const find = (/** @type {string} */ n) => taxes.find((x) => x.name.toUpperCase() === n)?.amountPaise ?? 0;
  return {
    subtotal: toPaise(t.sub), discount: toPaise(t.disc), delivery: toPaise(t.delivery), taxable: toPaise(t.taxable),
    taxes, tax: toPaise(t.taxTotal), cgst: find('CGST'), sgst: find('SGST'), serviceCharge: toPaise(t.serviceCharge ?? 0),
    roundOff: toPaise(t.roundOff), total: toPaise(t.total), comp: !!t.comp, compValue: toPaise(t.compValue ?? 0),
  };
}

/** Format paise as rupees with 2 decimals. @param {number} p */
export const rupees = (p) => (p / 100).toFixed(2);

/** Legacy line total in paise: unit × qty + Σ(extra price × extra qty) — extras are NOT multiplied by qty. @param {{unit_paise?: number, unitPaise?: number, qty: number, extras?: any}} l */
export function linePaise(l) {
  const unit = l.unitPaise ?? l.unit_paise ?? 0;
  const ex = typeof l.extras === 'string' ? JSON.parse(l.extras || '[]') : l.extras || [];
  return unit * l.qty + ex.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.pricePaise * (e.qty ?? 1), 0);
}
