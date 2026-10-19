// @ts-check
// Reports (Day 17, legacy parity): date-range day-end tally (billing amount, money collected,
// tally check, cash in the drawer, other money, customers with due), visitors, time used by
// table, most ordered items, deleted items; bill history; CSV. Read-only queries.
import { all, get } from './db.js';
import { rupees, linePaise } from './domain/totals.js';

const MODES = ['cash', 'card', 'upi', 'other', 'due'];

/**
 * Everything the Reports screen shows for business dates from..to (inclusive).
 * @param {any} db @param {string} from YYYY-MM-DD @param {string} [to]
 */
export function report(db, from, to = from) {
  if (to < from) [from, to] = [to, from];
  const bills = all(db, "SELECT * FROM bills WHERE business_date BETWEEN ? AND ? AND status<>'void'", from, to);
  const settled = bills.filter((b) => b.status === 'settled');
  /** @param {string} k */
  const sum = (k) => settled.reduce((a, b) => a + b[k], 0);
  /** @type {Record<string, number>} */
  const byMode = { cash: 0, card: 0, upi: 0, due: 0, other: 0 };
  /** @type {Record<string, number>} */
  const otherBreak = {};
  for (const r of all(db, `SELECT p.mode, p.other_type, SUM(p.amount_paise) AS amt FROM bill_payments p JOIN bills b ON b.id=p.bill_id
    WHERE b.business_date BETWEEN ? AND ? AND b.status='settled' GROUP BY p.mode, p.other_type`, from, to)) {
    byMode[r.mode] = (byMode[r.mode] ?? 0) + r.amt;
    if (r.mode === 'other') otherBreak[r.other_type || 'Other'] = (otherBreak[r.other_type || 'Other'] ?? 0) + r.amt;
  }
  /** @type {Record<string, number>} */
  const duesReceived = { cash: 0, card: 0, upi: 0, other: 0 };
  for (const r of all(db, 'SELECT mode, SUM(amount_paise) AS amt FROM due_receipts WHERE business_date BETWEEN ? AND ? GROUP BY mode', from, to)) duesReceived[r.mode] = r.amt;
  const tips = sum('tip_paise'), waived = sum('waived_paise'), net = sum('total_paise');
  // payments include the tip, so money collected for bills = non-due payments − tips
  const nonDue = MODES.filter((m) => m !== 'due').reduce((a, m) => a + byMode[m], 0);
  const collected = nonDue - tips;
  const toCollect = net - waived;
  const single = from === to;
  const count = single ? get(db, 'SELECT c.*, u.name AS by_name FROM cash_counts c LEFT JOIN users u ON u.id=c.user_id WHERE business_date=?', from) : null;
  const expectedCash = byMode.cash + duesReceived.cash;
  const tally = {
    from, to,
    bills: bills.length,
    settled: settled.length,
    openBills: bills.length - settled.length,
    openOrders: get(db, "SELECT COUNT(*) AS n FROM orders WHERE business_date BETWEEN ? AND ? AND status IN ('open','billed')", from, to).n,
    subtotalPaise: sum('subtotal_paise'),
    discountPaise: sum('discount_paise'),
    deliveryPaise: sum('delivery_paise'),
    taxPaise: sum('tax_paise'),
    cgstPaise: sum('cgst_paise'),
    sgstPaise: sum('sgst_paise'),
    servicePaise: sum('service_paise'),
    roundOffPaise: sum('roundoff_paise'),
    totalPaise: net,
    tipPaise: tips,
    waivedPaise: waived,
    compPaise: sum('comp_value_paise'),
    toCollectPaise: toCollect,
    collectedPaise: collected,
    duePaise: byMode.due,
    diffPaise: toCollect - collected - byMode.due,
    byMode,
    otherBreak,
    duesReceived,
    duesReceivedPaise: Object.values(duesReceived).reduce((a, b) => a + b, 0),
    expectedCashPaise: expectedCash,
    cashCounted: count ? { countedPaise: count.counted_paise, by: count.by_name ?? '', ts: count.ts, diffPaise: count.counted_paise - expectedCash } : null,
    byType: all(db, `SELECT o.type, COUNT(*) AS n, SUM(b.total_paise) AS totalPaise FROM bills b JOIN orders o ON o.id=b.order_id
      WHERE b.business_date BETWEEN ? AND ? AND b.status='settled' GROUP BY o.type`, from, to),
    /** @type {Record<string, number>} */
    kots: Object.fromEntries(all(db, 'SELECT status, COUNT(*) AS n FROM kots WHERE business_date BETWEEN ? AND ? GROUP BY status', from, to).map((r) => [r.status, r.n])),
  };

  // visitors (cover size) per day
  const visitors = all(db, `SELECT b.business_date AS date, COUNT(*) AS bills, COALESCE(SUM(o.persons),0) AS guests, SUM(CASE WHEN o.persons=0 THEN 1 ELSE 0 END) AS none
    FROM bills b JOIN orders o ON o.id=b.order_id WHERE b.business_date BETWEEN ? AND ? AND b.status='settled' GROUP BY b.business_date ORDER BY b.business_date DESC`, from, to);

  // time used by each table (first order -> bill settled)
  /** @type {Map<string, any>} */
  const tmap = new Map();
  for (const r of all(db, `SELECT o.ref AS tbl, s.name AS section, o.persons, (b.settled_at - o.opened_at) AS ms FROM bills b JOIN orders o ON o.id=b.order_id
    LEFT JOIN dining_tables t ON t.id=o.table_id LEFT JOIN sections s ON s.id=t.section_id
    WHERE b.business_date BETWEEN ? AND ? AND b.status='settled' AND o.type='dine'`, from, to)) {
    const min = Math.max(0, Math.round(r.ms / 60000));
    const m = tmap.get(r.tbl) ?? { table: r.tbl, section: r.section ?? '', times: 0, totalMin: 0, maxMin: 0, guests: 0 };
    m.times++; m.totalMin += min; m.maxMin = Math.max(m.maxMin, min); m.guests += r.persons;
    tmap.set(r.tbl, m);
  }
  const tables = [...tmap.values()].map((m) => ({ ...m, avgMin: Math.round(m.totalMin / m.times) })).sort((a, b) => b.totalMin - a.totalMin);

  // most ordered items (quantity first, then amount; extras count towards the dish amount)
  /** @type {Map<string, {name: string, qty: number, amountPaise: number}>} */
  const imap = new Map();
  for (const l of all(db, `SELECT l.item_id, l.name, l.qty, l.unit_paise, l.extras FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN bills b ON b.order_id=o.id AND b.status='settled'
    WHERE b.business_date BETWEEN ? AND ? AND l.voided=0`, from, to)) {
    const k = l.item_id ?? 'open:' + l.name;
    const m = imap.get(k) ?? { name: l.item_id ? l.name : l.name + ' (open item)', qty: 0, amountPaise: 0 };
    m.qty += l.qty; m.amountPaise += linePaise(l);
    imap.set(k, m);
  }
  const items = [...imap.values()].sort((a, b) => b.qty - a.qty || b.amountPaise - a.amountPaise);

  const voids = all(db, `SELECT v.entity, v.reason, v.detail, v.ts, v.business_date AS date, u.name AS user, a.name AS approver FROM void_log v
    LEFT JOIN users u ON u.id=v.user_id LEFT JOIN users a ON a.id=v.approver_id WHERE v.business_date BETWEEN ? AND ? ORDER BY v.ts DESC`, from, to)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail), approver: r.approver ?? r.user }));

  const dues = all(db, 'SELECT id, name, phone, due_paise FROM customers WHERE due_paise>0 ORDER BY due_paise DESC');
  return { tally, visitors, tables, items, voids, dues };
}

/** Single business day, flattened (used by day close and the tests). @param {any} db @param {string} date */
export function dayTally(db, date) {
  const r = report(db, date, date);
  const tt = r.tables.reduce((a, t) => ({ n: a.n + t.times, m: a.m + t.totalMin }), { n: 0, m: 0 });
  return {
    date,
    ...r.tally,
    visitors: r.visitors.reduce((a, v) => a + v.guests, 0),
    avgTableMinutes: tt.n ? Math.round(tt.m / tt.n) : 0,
    mostOrdered: r.items.slice(0, 15),
    deleted: r.voids.slice().reverse(),
    closed: get(db, 'SELECT closed_at FROM day_close WHERE business_date=?', date)?.closed_at ?? null,
  };
}

/** @param {any} db @param {string} from @param {string} [to] */
export function history(db, from, to = from) {
  return all(db, `SELECT b.*, o.no AS order_no, o.type, o.ref AS table_name FROM bills b JOIN orders o ON o.id=b.order_id
    WHERE b.business_date BETWEEN ? AND ? ORDER BY b.fy, b.seq`, from, to)
    .map((b) => ({ ...b, snapshot: JSON.parse(b.snapshot), taxes: JSON.parse(b.taxes || '[]'), payments: all(db, 'SELECT mode, other_type, amount_paise FROM bill_payments WHERE bill_id=?', b.id) }));
}

/** @param {any} v */
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {any} db @param {string} from @param {string} [to] */
export function billsCsv(db, from, to = from) {
  const head = ['bill_no', 'business_date', 'time', 'order_no', 'type', 'table_or_ref', 'status', 'subtotal', 'discount', 'delivery', 'taxable', 'tax', 'cgst', 'sgst',
    'service_charge', 'round_off', 'total', 'complimentary_value', 'tip', 'waived', 'payments'];
  const rows = history(db, from, to).map((b) => [
    b.no, b.business_date, new Date(b.created_at).toLocaleTimeString('en-IN', { hour12: false }), b.order_no, b.type, b.table_name ?? '', b.status,
    rupees(b.subtotal_paise), rupees(b.discount_paise), rupees(b.delivery_paise), rupees(b.taxable_paise), rupees(b.tax_paise), rupees(b.cgst_paise), rupees(b.sgst_paise),
    rupees(b.service_paise), rupees(b.roundoff_paise), rupees(b.total_paise), rupees(b.comp_value_paise), rupees(b.tip_paise), rupees(b.waived_paise),
    b.payments.map((/** @type {any} */ p) => `${p.mode}${p.other_type ? '(' + p.other_type + ')' : ''}:${rupees(p.amount_paise)}`).join(' '),
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
