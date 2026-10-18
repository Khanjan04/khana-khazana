// @ts-check
// Day-end tally, history and CSV (Day 17). Read-only queries.
import { all, get } from './db.js';
import { rupees } from './domain/totals.js';

/** @param {any} db @param {string} date YYYY-MM-DD business date */
export function dayTally(db, date) {
  const bills = all(db, "SELECT * FROM bills WHERE business_date=? AND status<>'void'", date);
  /** @param {string} k */
  const sum = (k) => bills.reduce((a, b) => a + b[k], 0);
  /** @type {Record<string, number>} */
  const byMode = { cash: 0, card: 0, upi: 0, due: 0, other: 0 };
  for (const r of all(db, "SELECT p.mode, SUM(p.amount_paise) AS amt FROM bill_payments p JOIN bills b ON b.id=p.bill_id WHERE b.business_date=? AND b.status='settled' GROUP BY p.mode", date)) byMode[r.mode] = r.amt;
  /** @type {Record<string, number>} */
  const duesReceived = {};
  for (const r of all(db, 'SELECT mode, SUM(amount_paise) AS amt FROM due_receipts WHERE business_date=? GROUP BY mode', date)) duesReceived[r.mode] = r.amt;
  const visitors = get(db, "SELECT COALESCE(SUM(persons),0) AS n FROM orders WHERE business_date=? AND status IN ('billed','closed')", date).n;
  const tt = get(db, `SELECT AVG(b.settled_at - o.opened_at) AS ms, COUNT(*) AS n FROM bills b JOIN orders o ON o.id=b.order_id
    WHERE b.business_date=? AND b.status='settled' AND o.type='dine'`, date);
  const mostOrdered = all(db, `SELECT l.name, SUM(l.qty) AS qty, SUM(l.qty * l.unit_paise) AS amountPaise FROM order_lines l JOIN orders o ON o.id=l.order_id
    WHERE o.business_date=? AND l.voided=0 AND o.status IN ('billed','closed') GROUP BY l.name ORDER BY qty DESC, l.name LIMIT 15`, date);
  const deleted = all(db, `SELECT v.entity, v.reason, v.detail, v.ts, u.name AS user, a.name AS approver FROM void_log v
    LEFT JOIN users u ON u.id=v.user_id LEFT JOIN users a ON a.id=v.approver_id WHERE v.business_date=? ORDER BY v.ts`, date)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  /** @type {Record<string, number>} */
  const kots = {};
  for (const r of all(db, 'SELECT status, COUNT(*) AS n FROM kots WHERE business_date=? GROUP BY status', date)) kots[r.status] = r.n;
  const byType = all(db, `SELECT o.type, COUNT(*) AS n, SUM(b.total_paise) AS totalPaise FROM bills b JOIN orders o ON o.id=b.order_id
    WHERE b.business_date=? AND b.status<>'void' GROUP BY o.type`, date);
  const openOrders = get(db, "SELECT COUNT(*) AS n FROM orders WHERE business_date=? AND status IN ('open','billed')", date).n;
  return {
    date,
    bills: bills.length,
    settled: bills.filter((b) => b.status === 'settled').length,
    openOrders,
    subtotalPaise: sum('subtotal_paise'),
    discountPaise: sum('discount_paise'),
    taxablePaise: sum('taxable_paise'),
    cgstPaise: sum('cgst_paise'),
    sgstPaise: sum('sgst_paise'),
    servicePaise: sum('service_paise'),
    roundOffPaise: sum('roundoff_paise'),
    totalPaise: sum('total_paise'),
    tipPaise: sum('tip_paise'),
    waivedPaise: sum('waived_paise'),
    byMode,
    duesReceived,
    byType,
    visitors,
    avgTableMinutes: tt.n ? Math.round(tt.ms / 60000) : 0,
    mostOrdered,
    deleted,
    kots,
    closed: get(db, 'SELECT closed_at FROM day_close WHERE business_date=?', date)?.closed_at ?? null,
  };
}

/** @param {any} db @param {string} date */
export function history(db, date) {
  return all(db, `SELECT b.*, o.no AS order_no, o.type, t.name AS table_name FROM bills b JOIN orders o ON o.id=b.order_id
    LEFT JOIN dining_tables t ON t.id=o.table_id WHERE b.business_date=? ORDER BY b.seq`, date)
    .map((b) => ({ ...b, snapshot: JSON.parse(b.snapshot), payments: all(db, 'SELECT mode, amount_paise FROM bill_payments WHERE bill_id=?', b.id) }));
}

/** @param {any} v */
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {any} db @param {string} date */
export function billsCsv(db, date) {
  const head = ['bill_no', 'business_date', 'time', 'order_no', 'type', 'table', 'status', 'subtotal', 'discount', 'taxable', 'cgst', 'sgst', 'service_charge', 'round_off', 'total', 'tip', 'waived', 'payments'];
  const rows = history(db, date).map((b) => [
    b.no, b.business_date, new Date(b.created_at).toLocaleTimeString('en-IN', { hour12: false }), b.order_no, b.type, b.table_name ?? '', b.status,
    rupees(b.subtotal_paise), rupees(b.discount_paise), rupees(b.taxable_paise), rupees(b.cgst_paise), rupees(b.sgst_paise),
    rupees(b.service_paise), rupees(b.roundoff_paise), rupees(b.total_paise), rupees(b.tip_paise), rupees(b.waived_paise),
    b.payments.map((/** @type {any} */ p) => `${p.mode}:${rupees(p.amount_paise)}`).join(' '),
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
