// @ts-check
// MONEY. Billing + settlement (Days 15–16). All totals come from domain/totals.js.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { calcTotals, totalsToPaise, fromPaise } from '../domain/totals.js';
import { newId, touch, businessDate, financialYear, nextCounter, getSettings, reqStr, int, paise } from '../model.js';
import { loadOrder, logVoid, upsertCustomer } from './order.js';
import { can } from '../rights.js';

export const PAY_MODES = ['cash', 'card', 'upi', 'due', 'other'];
export const MAX_BILL_NO = 16; // GST Rule 46(b)

/** @param {string} prefix @param {string} fy @param {number} seq */
export function formatBillNo(prefix, fy, seq) {
  const no = `${prefix}/${fy}/${String(seq).padStart(6, '0')}`;
  if (no.length > MAX_BILL_NO) throw new CmdError('BILL_NO_TOO_LONG', no);
  return no;
}

/**
 * Build the legacy-shaped order (rupees) that calcTotals expects.
 * @param {any[]} lines DB rows of order_lines
 * @param {{discount?: {type: 'pct'|'fixed', value: number} | null, complimentary?: boolean, serviceCharge?: boolean}} opts
 */
export function legacyOrder(lines, opts) {
  return {
    lines: lines.map((l) => ({
      price: fromPaise(l.unit_paise),
      qty: l.qty,
      extras: JSON.parse(l.extras || '[]').map((/** @type {any} */ e) => ({ price: fromPaise(e.pricePaise) })),
      void: !!l.voided,
    })),
    discount: opts.discount ?? null,
    complimentary: !!opts.complimentary,
    serviceCharge: !!opts.serviceCharge,
  };
}

/** @param {any} p */
function parseDiscount(p) {
  if (!p.discount) return null;
  const d = p.discount;
  need(d.type === 'pct' || d.type === 'fixed', 'BAD_PAYLOAD', 'discount.type');
  need(typeof d.value === 'number' && d.value > 0, 'BAD_PAYLOAD', 'discount.value');
  if (d.type === 'pct') need(d.value <= 100, 'BAD_PAYLOAD', 'discount.value ≤ 100');
  return { type: d.type, value: d.value, reason: reqStr(d.reason, 'discount.reason', 120) };
}

/** @param {any} db @param {string} id */
function loadBill(db, id) {
  const b = typeof id === 'string' ? get(db, 'SELECT * FROM bills WHERE id=?', id) : null;
  need(b, 'NOT_FOUND', 'bill');
  return b;
}

/** @param {any} db @param {any} ctx @param {any} o @param {any} t @param {any} opts @param {string} billNo */
function buildSnapshot(db, ctx, o, t, opts, billNo) {
  const s = getSettings(db);
  const lines = all(db, 'SELECT * FROM order_lines WHERE order_id=? AND voided=0 ORDER BY created_at, rowid', o.id);
  const table = o.table_id ? get(db, 'SELECT name FROM dining_tables WHERE id=?', o.table_id) : null;
  const cust = o.customer_id ? get(db, 'SELECT name, phone, address FROM customers WHERE id=?', o.customer_id) : null;
  const d = new Date(ctx.now);
  return {
    title: s.compositionScheme ? 'Bill of Supply' : 'Tax Invoice',
    composition: !!s.compositionScheme,
    compositionLegend: s.compositionScheme ? 'Composition taxable person, not eligible to collect tax on supplies' : '',
    name: s.name, address: s.address, phone: s.phone, gstin: s.gstin, fssai: s.fssai,
    sac: s.sacCode, placeOfSupply: s.placeOfSupply, footer: s.footer,
    billNo, businessDate: o.business_date,
    printedAt: d.toISOString(),
    orderNo: o.no, type: o.type, table: table?.name ?? '', persons: o.persons,
    platform: o.platform, platformRef: o.platform_ref,
    customer: cust,
    lines: lines.map((l) => {
      const extras = JSON.parse(l.extras || '[]');
      const rate = l.unit_paise + extras.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.pricePaise, 0);
      return { name: l.name, variant: l.variant, extras: extras.map((/** @type {any} */ e) => e.name), qty: l.qty, ratePaise: rate, amountPaise: rate * l.qty };
    }),
    totals: t,
    discountLabel: opts.complimentary ? 'Complimentary' : opts.discount ? (opts.discount.type === 'pct' ? `Discount ${opts.discount.value}%` : 'Discount') : '',
    serviceChargePct: opts.serviceCharge ? s.serviceChargePct : 0,
    specifiedPremises: !!s.specifiedPremises,
  };
}

/** @type {Record<string, import('../engine.js').Handler>} */
export const billHandlers = {
  'bill.print': {
    base: 'bill', approvable: true,
    right: (p) => (p.discount || p.complimentary ? 'discount' : 'bill'),
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      need(o.status === 'open' || o.status === 'billed', 'ORDER_CLOSED', `order is ${o.status}`);
      const lines = all(db, 'SELECT * FROM order_lines WHERE order_id=?', o.id);
      need(lines.some((l) => !l.voided), 'NO_LINES', 'Nothing to bill');
      const discount = p.complimentary ? null : parseDiscount(p);
      const complimentary = !!p.complimentary;
      const compReason = complimentary ? reqStr(typeof p.complimentary === 'string' ? p.complimentary : p.complimentaryReason, 'complimentary reason', 120) : '';
      const serviceCharge = p.serviceCharge === true; // opt-in only, never default (CCPA)
      const s = getSettings(db);
      const t = totalsToPaise(calcTotals(legacyOrder(lines, { discount, complimentary, serviceCharge }), s));
      const existing = get(db, "SELECT * FROM bills WHERE order_id=? AND status='open'", o.id);
      const opts = { discount, complimentary, serviceCharge };
      let billId, no;
      if (existing) {
        billId = existing.id; no = existing.no;
      } else {
        const bd = businessDate(db, ctx.now);
        const fy = financialYear(bd);
        const seq = nextCounter(db, 'bill', fy);
        no = formatBillNo(String(s.billPrefix || 'KK1'), fy, seq);
        billId = newId();
        run(db, `INSERT INTO bills(id,no,fy,seq,order_id,business_date,status,subtotal_paise,discount_paise,taxable_paise,cgst_paise,sgst_paise,service_paise,roundoff_paise,total_paise,snapshot,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'open',0,0,0,0,0,0,0,0,'{}',?,?,?)`, billId, no, fy, seq, o.id, bd, ctx.user.id, ctx.now, ctx.now);
      }
      const snap = buildSnapshot(db, ctx, o, t, opts, no);
      run(db, `UPDATE bills SET subtotal_paise=?, discount_paise=?, taxable_paise=?, cgst_paise=?, sgst_paise=?, service_paise=?, roundoff_paise=?, total_paise=?,
        discount_type=?, discount_value=?, discount_reason=?, complimentary=?, service_on=?, composition=?, approver_id=?, snapshot=?, updated_at=? WHERE id=?`,
        t.subtotal, t.discount, t.taxable, t.cgst, t.sgst, t.serviceCharge, t.roundOff, t.total,
        discount?.type ?? (complimentary ? 'comp' : ''), discount?.value ?? 0, discount?.reason ?? compReason,
        complimentary, serviceCharge, !!s.compositionScheme,
        discount || complimentary ? ctx.approver?.id ?? ctx.user.id : null, JSON.stringify(snap), ctx.now, billId);
      if (discount || complimentary) {
        logVoid(db, ctx, { entity: 'bill_discount', entityId: billId, reason: discount?.reason ?? compReason, detail: { no, discountPaise: t.discount, complimentary } });
      }
      run(db, "UPDATE orders SET status='billed', updated_at=? WHERE id=?", ctx.now, o.id);
      touch(db, ctx, 'bills', billId);
      touch(db, ctx, 'orders', o.id);
      if (p.print === 'host-lan' && ctx.hooks?.print) ctx.after(() => ctx.hooks.print('bill', billId));
      return { billId, no, totalPaise: t.total };
    },
  },

  'bill.reprint': {
    right: 'bill.reprint',
    run(db, p, ctx) {
      const b = loadBill(db, p.billId);
      need(b.status !== 'void', 'BILL_VOID');
      run(db, 'UPDATE bills SET reprints=reprints+1, updated_at=? WHERE id=?', ctx.now, b.id);
      touch(db, ctx, 'bills', b.id);
      if (p.print === 'host-lan' && ctx.hooks?.print) ctx.after(() => ctx.hooks.print('bill', b.id));
      return { billId: b.id, reprints: b.reprints + 1 };
    },
  },

  'bill.void': {
    base: 'bill', right: 'void', approvable: true,
    run(db, p, ctx) {
      const b = loadBill(db, p.billId);
      need(b.status === 'open', 'BILL_NOT_OPEN', 'Only an unsettled bill can be voided');
      const reason = reqStr(p.reason, 'reason', 120);
      run(db, "UPDATE bills SET status='void', updated_at=? WHERE id=?", ctx.now, b.id);
      run(db, "UPDATE orders SET status='open', updated_at=? WHERE id=?", ctx.now, b.order_id);
      logVoid(db, ctx, { entity: 'bill', entityId: b.id, reason, detail: { no: b.no, totalPaise: b.total_paise } });
      touch(db, ctx, 'bills', b.id);
      touch(db, ctx, 'orders', b.order_id);
    },
  },

  'bill.settle': {
    base: 'bill', approvable: true,
    right: (p) => (p.waive > 0 ? 'discount' : 'bill'),
    run(db, p, ctx) {
      const b = loadBill(db, p.billId);
      need(b.status === 'open', 'BILL_NOT_OPEN', `bill is ${b.status}`);
      const tip = p.tip === undefined ? 0 : paise(p.tip, 'tip');
      const waive = p.waive === undefined ? 0 : paise(p.waive, 'waive');
      need(waive <= b.total_paise, 'BAD_PAYLOAD', 'waive exceeds total');
      if (waive) reqStr(p.waiveReason, 'waiveReason', 120);
      need(Array.isArray(p.payments) && p.payments.length >= 1 && p.payments.length <= 10, 'BAD_PAYLOAD', 'payments');
      const pays = p.payments.map((/** @type {any} */ x) => {
        need(PAY_MODES.includes(x?.mode), 'BAD_PAYLOAD', 'payment mode');
        return { mode: x.mode, amount: paise(x.amount, 'amount'), phone: x.phone, customerId: x.customerId, name: x.name };
      });
      const sum = pays.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.amount, 0);
      const due = b.total_paise + tip - waive;
      if (sum !== due) throw new CmdError('AMOUNT_MISMATCH', `payments ${sum} ≠ due ${due} (paise)`);
      if (pays.some((/** @type {any} */ x) => x.mode === 'due') && !can(ctx.user, 'customers.due')) throw new CmdError('FORBIDDEN', 'customers.due');
      for (const x of pays) {
        if (x.amount === 0) continue;
        let customerId = null;
        if (x.mode === 'due') {
          const o = get(db, 'SELECT customer_id FROM orders WHERE id=?', b.order_id);
          customerId = x.customerId || x.phone ? upsertCustomer(db, ctx, x) : o.customer_id;
          need(customerId, 'CUSTOMER_REQUIRED', 'Due needs a customer phone');
          run(db, 'UPDATE customers SET due_paise=due_paise+? WHERE id=?', x.amount, customerId);
          touch(db, ctx, 'customers', customerId);
        }
        const pid = newId();
        run(db, 'INSERT INTO bill_payments(id,bill_id,mode,amount_paise,customer_id,user_id,ts) VALUES (?,?,?,?,?,?,?)', pid, b.id, x.mode, x.amount, customerId, ctx.user.id, ctx.now);
        touch(db, ctx, 'bill_payments', pid);
      }
      run(db, "UPDATE bills SET status='settled', tip_paise=?, waived_paise=?, settled_at=?, updated_at=?, approver_id=COALESCE(approver_id, ?) WHERE id=?",
        tip, waive, ctx.now, ctx.now, waive ? ctx.approver?.id ?? ctx.user.id : null, b.id);
      if (waive) logVoid(db, ctx, { entity: 'bill_waive', entityId: b.id, reason: String(p.waiveReason), detail: { no: b.no, waivedPaise: waive } });
      run(db, "UPDATE orders SET status='closed', updated_at=? WHERE id=?", ctx.now, b.order_id);
      touch(db, ctx, 'bills', b.id);
      touch(db, ctx, 'orders', b.order_id);
      return { billId: b.id, paidPaise: sum };
    },
  },

  'bill.split': {
    right: 'bill',
    run(db, p) {
      const b = loadBill(db, p.billId);
      const ways = int(p.ways, 'ways', 2, 50);
      return { parts: splitEqual(b.total_paise, ways) };
    },
  },

  'due.receive': {
    right: 'customers.due',
    run(db, p, ctx) {
      const c = typeof p.customerId === 'string' ? get(db, 'SELECT * FROM customers WHERE id=?', p.customerId) : null;
      need(c, 'NOT_FOUND', 'customer');
      const amount = paise(p.amount, 'amount');
      need(amount > 0 && amount <= c.due_paise, 'BAD_PAYLOAD', 'amount must be 1..due');
      const mode = PAY_MODES.includes(p.mode) && p.mode !== 'due' ? p.mode : 'cash';
      run(db, 'INSERT INTO due_receipts(id,customer_id,amount_paise,mode,business_date,user_id,ts) VALUES (?,?,?,?,?,?,?)', newId(), c.id, amount, mode, businessDate(db, ctx.now), ctx.user.id, ctx.now);
      run(db, 'UPDATE customers SET due_paise=due_paise-? WHERE id=?', amount, c.id);
      touch(db, ctx, 'customers', c.id);
      return { duePaise: c.due_paise - amount };
    },
  },
};

/** Equal split in paise; remainder goes to the first parts so the sum is exact. @param {number} total @param {number} ways */
export function splitEqual(total, ways) {
  const base = Math.floor(total / ways), rem = total - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < rem ? 1 : 0));
}

