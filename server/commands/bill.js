// @ts-check
// MONEY. Billing + settlement (Days 15–16, legacy parity). All totals come from domain/totals.js.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { billTotals, totalsToPaise, fromPaise } from '../domain/totals.js';
import { newId, touch, businessDate, financialYear, nextCounter, getSettings, reqStr, str, int, paise } from '../model.js';
import { loadOrder, logVoid, rememberCustomer, phoneKey } from './order.js';
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
 * @param {{discount?: {type?: string, mode?: string, value: number} | null, complimentary?: boolean, serviceCharge?: boolean, deliveryPaise?: number}} opts
 */
export function legacyOrder(lines, opts) {
  const d = opts.discount;
  return {
    lines: lines.map((l) => ({
      price: fromPaise(l.unit_paise),
      qty: l.qty,
      extras: JSON.parse(l.extras || '[]').map((/** @type {any} */ e) => ({ price: fromPaise(e.pricePaise), qty: e.qty ?? 1 })),
      void: !!l.voided,
    })),
    discount: d ? { mode: /** @type {'pct'|'fix'} */ (d.mode === 'pct' || d.type === 'pct' ? 'pct' : 'fix'), value: d.value } : null,
    comp: !!opts.complimentary,
    delivery: fromPaise(opts.deliveryPaise ?? 0),
    serviceCharge: !!opts.serviceCharge,
  };
}

/** @param {any} p @param {number} subPaise */
function parseDiscount(p, subPaise) {
  if (!p.discount) return null;
  const d = p.discount;
  const mode = d.mode === 'pct' || d.type === 'pct' ? 'pct' : d.mode === 'fix' || d.type === 'fixed' || d.type === 'fix' ? 'fix' : null;
  need(mode, 'BAD_PAYLOAD', 'discount.type');
  need(typeof d.value === 'number' && d.value > 0, 'BAD_PAYLOAD', 'discount.value');
  if (mode === 'pct') need(d.value <= 100, 'BAD_PAYLOAD', 'Percentage cannot be more than 100.');
  else need(Math.round(d.value * 100) <= subPaise, 'BAD_PAYLOAD', 'Discount cannot be more than the bill amount.');
  return { mode, value: d.value, reason: str(d.reason, 'discount.reason', 120) || 'Discount' };
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
  const sec = o.table_id ? get(db, 'SELECT s.name FROM dining_tables t JOIN sections s ON s.id=t.section_id WHERE t.id=?', o.table_id) : null;
  const cashier = get(db, 'SELECT name FROM users WHERE id=?', ctx.user.id)?.name ?? '';
  return {
    title: s.compositionScheme ? 'Bill of Supply' : s.gstin ? 'Tax Invoice' : 'Bill',
    composition: !!s.compositionScheme,
    compositionLegend: s.compositionScheme ? 'Composition taxable person, not eligible to collect tax on supplies' : '',
    name: s.name, address: s.address, phone: s.phone, gstin: s.gstin, fssai: s.fssai,
    sac: s.sacCode, placeOfSupply: s.placeOfSupply, footer: s.footer,
    billNo, businessDate: o.business_date,
    printedAt: new Date(ctx.now).toISOString(),
    orderNo: o.no, type: o.type, table: o.ref, section: sec?.name ?? '', persons: o.persons,
    platform: o.platform, platformRef: o.platform_ref,
    customer: o.cust_name || o.cust_phone ? { name: o.cust_name, phone: o.cust_phone, address: o.cust_address, locality: o.cust_locality } : null,
    cashier,
    lines: lines.map((l) => {
      const extras = JSON.parse(l.extras || '[]');
      return { name: l.name, variant: l.variant, note: l.note, qty: l.qty, ratePaise: l.unit_paise, amountPaise: l.unit_paise * l.qty,
        extras: extras.map((/** @type {any} */ e) => ({ name: e.name, qty: e.qty ?? 1, ratePaise: e.pricePaise, amountPaise: e.pricePaise * (e.qty ?? 1) })) };
    }),
    totals: t,
    discountLabel: opts.complimentary ? 'Complimentary' : opts.discount ? (opts.discount.mode === 'pct' ? `Discount (${opts.discount.value}%)` : 'Discount') : '',
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
      need(lines.some((l) => !l.voided), 'NO_LINES', 'Add at least one dish first.');
      const s = getSettings(db);
      const complimentary = !!p.complimentary;
      const compReason = complimentary ? reqStr(typeof p.complimentary === 'string' ? p.complimentary : p.complimentaryReason, 'complimentary reason', 120) : '';
      const subPaise = totalsToPaise(billTotals(legacyOrder(lines, {}), s)).subtotal;
      const discount = complimentary ? null : parseDiscount(p, subPaise);
      const serviceCharge = p.serviceCharge === true; // opt-in only, never default (CCPA)
      const opts = { discount, complimentary, serviceCharge, deliveryPaise: o.delivery_paise };
      const t = totalsToPaise(billTotals(legacyOrder(lines, opts), s));
      const existing = get(db, "SELECT * FROM bills WHERE order_id=? AND status='open'", o.id);
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
      run(db, `UPDATE bills SET subtotal_paise=?, discount_paise=?, delivery_paise=?, taxable_paise=?, tax_paise=?, taxes=?, cgst_paise=?, sgst_paise=?, service_paise=?, roundoff_paise=?, total_paise=?,
        comp_value_paise=?, discount_type=?, discount_value=?, discount_reason=?, complimentary=?, service_on=?, composition=?, approver_id=?, snapshot=?, updated_at=? WHERE id=?`,
      t.subtotal, t.discount, t.delivery, t.taxable, t.tax, JSON.stringify(t.taxes), t.cgst, t.sgst, t.serviceCharge, t.roundOff, t.total,
      t.compValue, discount?.mode ?? (complimentary ? 'comp' : ''), discount?.value ?? 0, discount?.reason ?? compReason,
      complimentary, serviceCharge, !!s.compositionScheme,
      discount || complimentary ? ctx.approver?.id ?? ctx.user.id : null, JSON.stringify(snap), ctx.now, billId);
      if (discount || complimentary) {
        logVoid(db, ctx, { entity: 'bill_discount', entityId: billId, reason: discount?.reason ?? compReason, detail: { no, discountPaise: complimentary ? t.compValue : t.discount, complimentary, table: o.ref } });
      }
      run(db, "UPDATE orders SET status='billed', held=0, updated_at=? WHERE id=?", ctx.now, o.id);
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

  /**
   * Settle & Save. payments [{mode, amount, otherType?}] (several = part payment),
   * tip, waive (customer paid less: "Settlement Amount"), tendered = cash given (change is returned).
   */
  'bill.settle': {
    base: 'bill', approvable: true,
    right: (p) => (p.waive > 0 ? 'discount' : 'bill'),
    run(db, p, ctx) {
      const b = loadBill(db, p.billId);
      need(b.status === 'open', 'BILL_NOT_OPEN', `bill is ${b.status}`);
      const o = get(db, 'SELECT * FROM orders WHERE id=?', b.order_id);
      const s = getSettings(db);
      const tip = p.tip === undefined ? 0 : paise(p.tip, 'tip');
      const waive = p.waive === undefined ? 0 : paise(p.waive, 'waive');
      need(waive <= b.total_paise, 'BAD_PAYLOAD', 'Settlement amount must be between ₹0 and the bill total');
      if (waive) reqStr(p.waiveReason, 'waiveReason', 120);
      need(Array.isArray(p.payments) && p.payments.length >= 1 && p.payments.length <= 10, 'BAD_PAYLOAD', 'payments');
      const pays = p.payments.map((/** @type {any} */ x) => {
        need(PAY_MODES.includes(x?.mode), 'BAD_PAYLOAD', 'payment mode');
        const otherType = x.mode === 'other' ? str(x.otherType, 'otherType', 30) || (s.otherTypes?.[0] ?? 'Other') : '';
        return { mode: x.mode, amount: paise(x.amount, 'amount'), otherType };
      });
      const sum = pays.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.amount, 0);
      const due = b.total_paise + tip - waive;
      if (sum !== due) throw new CmdError('AMOUNT_MISMATCH', `payments ${sum} ≠ due ${due} (paise)`);
      const dueAmount = pays.filter((/** @type {any} */ x) => x.mode === 'due').reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.amount, 0);
      const cashAmount = pays.filter((/** @type {any} */ x) => x.mode === 'cash').reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.amount, 0);
      const tendered = p.tendered === undefined ? cashAmount : paise(p.tendered, 'tendered');
      need(tendered >= cashAmount, 'BAD_PAYLOAD', `Customer paid ₹${((cashAmount - tendered) / 100).toFixed(2)} less.`);
      // customer (due needs name + 10-digit mobile, like the legacy app)
      const cust = { name: str(p.customer?.name, 'name', 60) || o.cust_name, phone: phoneKey(p.customer?.phone) || o.cust_phone,
        address: o.cust_address, locality: o.cust_locality, tag: o.cust_tag };
      let customerId = null;
      if (dueAmount) {
        if (!can(ctx.user, 'customers.due')) throw new CmdError('FORBIDDEN', 'customers.due');
        need(!waive, 'BAD_PAYLOAD', 'A due bill cannot have a waived-off amount.');
        need(cust.name && cust.phone.length >= 10 && cust.phone.length <= 13, 'CUSTOMER_REQUIRED', "Type the customer's name and 10-digit mobile number.");
      }
      if (cust.phone) {
        customerId = rememberCustomer(db, ctx, cust, { visit: true, dueAdd: dueAmount });
        run(db, 'UPDATE orders SET customer_id=?, cust_name=?, cust_phone=? WHERE id=?', customerId, cust.name, cust.phone, o.id);
      }
      for (const x of pays) {
        if (x.amount === 0) continue;
        const pid = newId();
        run(db, 'INSERT INTO bill_payments(id,bill_id,mode,amount_paise,customer_id,other_type,user_id,ts) VALUES (?,?,?,?,?,?,?,?)',
          pid, b.id, x.mode, x.amount, x.mode === 'due' ? customerId : null, x.otherType, ctx.user.id, ctx.now);
        touch(db, ctx, 'bill_payments', pid);
      }
      run(db, `UPDATE bills SET status='settled', tip_paise=?, waived_paise=?, tendered_paise=?, change_paise=?, settled_at=?, updated_at=?,
        approver_id=COALESCE(approver_id, ?) WHERE id=?`,
      tip, waive, tendered, tendered - cashAmount, ctx.now, ctx.now, waive ? ctx.approver?.id ?? ctx.user.id : null, b.id);
      if (waive) logVoid(db, ctx, { entity: 'bill_waive', entityId: b.id, reason: String(p.waiveReason), detail: { no: b.no, waivedPaise: waive } });
      run(db, "UPDATE orders SET status='closed', updated_at=? WHERE id=?", ctx.now, b.order_id);
      touch(db, ctx, 'bills', b.id);
      touch(db, ctx, 'orders', b.order_id);
      if (p.print === 'host-lan' && ctx.hooks?.print) ctx.after(() => ctx.hooks.print('bill', b.id));
      return { billId: b.id, paidPaise: sum, changePaise: tendered - cashAmount };
    },
  },

  'bill.split': {
    right: 'bill',
    run(db, p) {
      const b = loadBill(db, p.billId);
      const ways = int(p.ways, 'ways', 2, 20);
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

/** Equal split in paise (legacy: equal shares, the last one takes the remainder). @param {number} total @param {number} ways */
export function splitEqual(total, ways) {
  const each = Math.floor(total / ways / 100) * 100; // whole rupees per share, as in the legacy app
  return Array.from({ length: ways }, (_, i) => (i === ways - 1 ? total - each * (ways - 1) : each));
}
