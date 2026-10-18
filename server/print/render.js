// @ts-check
// Render KOT / bill / test page to ESC/POS bytes. Used by host-lan printing and
// by /api/print/render for the RawBT adapter (rawbt:base64,...).
import { get, all } from '../db.js';
import { getSettings } from '../model.js';
import { EscPos, colsFor } from './escpos.js';
import { rupees } from '../domain/totals.js';

const time = (/** @type {number} */ ts) => new Date(ts).toLocaleString('en-IN', { hour12: false, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** @param {any} db @param {string} kotId @param {{cols?: number, reprint?: boolean}} [o] */
export function renderKot(db, kotId, o = {}) {
  const k = get(db, 'SELECT * FROM kots WHERE id=?', kotId);
  if (!k) throw new Error('kot not found');
  const ord = get(db, 'SELECT * FROM orders WHERE id=?', k.order_id);
  const table = ord.table_id ? get(db, 'SELECT name FROM dining_tables WHERE id=?', ord.table_id)?.name : '';
  const user = get(db, 'SELECT name FROM users WHERE id=?', k.created_by)?.name ?? '';
  const lines = all(db, 'SELECT * FROM order_lines WHERE kot_id=? ORDER BY created_at, rowid', kotId);
  const p = new EscPos(o.cols ?? colsFor(getSettings(db).paper));
  p.align('center').bold(true).double(true).line(`KOT ${k.no}`).double(false);
  if (o.reprint) p.line('** REPRINT **');
  if (k.status === 'cancelled' || k.status === 'rejected') p.line(`** ${k.status.toUpperCase()} **`);
  p.bold(false).line(k.station.toUpperCase());
  p.align('left');
  const where = ord.type === 'dine' ? `Table ${table}` : ord.type === 'delivery' ? `Delivery ${ord.platform}` : 'Takeaway';
  p.bold(true).double(true).line(where).double(false).bold(false);
  p.lr(`Order #${ord.no}`, time(k.created_at));
  if (user) p.line(`By: ${user}`);
  p.hr();
  for (const l of lines) {
    const extras = JSON.parse(l.extras || '[]').map((/** @type {any} */ e) => e.name);
    p.bold(!l.voided).lr(`${l.voided ? 'X ' : ''}${l.name}${l.variant ? ` (${l.variant})` : ''}`, `x ${l.qty}`).bold(false);
    for (const e of extras) p.line(`   + ${e}`);
    if (l.note) p.line(`   >> ${l.note}`);
  }
  p.hr();
  if (k.note) p.line(`Note: ${k.note}`);
  if (ord.comment) p.line(`Order: ${ord.comment}`);
  return p.beep().cut().toBuffer();
}

/** @param {any} db @param {string} billId @param {{cols?: number}} [o] */
export function renderBill(db, billId, o = {}) {
  const b = get(db, 'SELECT * FROM bills WHERE id=?', billId);
  if (!b) throw new Error('bill not found');
  const s = JSON.parse(b.snapshot);
  const t = s.totals;
  const p = new EscPos(o.cols ?? colsFor(getSettings(db).paper));
  const w = p.cols;
  p.align('center').bold(true).double(true).line(s.name).double(false).bold(false);
  if (s.address) for (const ln of String(s.address).split('\n')) p.line(ln);
  if (s.phone) p.line(`Ph: ${s.phone}`);
  if (s.gstin) p.line(`GSTIN: ${s.gstin}`);
  if (s.fssai) p.line(`FSSAI: ${s.fssai}`);
  p.bold(true).line(s.title).bold(false);
  if (b.reprints > 0) p.line(`DUPLICATE (${b.reprints})`);
  if (b.status === 'void') p.line('** VOID **');
  p.align('left').hr();
  p.lr(`Bill: ${s.billNo}`, time(b.created_at));
  const where = s.type === 'dine' ? `Table ${s.table}` : s.type === 'delivery' ? `Delivery ${s.platform} ${s.platformRef || ''}` : 'Takeaway';
  p.lr(where, `Order #${s.orderNo}`);
  if (s.customer?.phone) p.line(`Cust: ${s.customer.name || ''} ${s.customer.phone}`);
  if (s.placeOfSupply) p.line(`Place of supply: ${s.placeOfSupply}`);
  if (!s.composition && s.sac) p.line(`SAC: ${s.sac}`);
  p.hr();
  const qw = 4, aw = 10;
  p.bold(true).line(pad('Item', w - qw - aw) + padL('Qty', qw) + padL('Amount', aw)).bold(false);
  for (const l of s.lines) {
    const name = `${l.name}${l.variant ? ` (${l.variant})` : ''}`;
    const first = name.slice(0, w - qw - aw - 1);
    p.line(pad(first, w - qw - aw) + padL(String(l.qty), qw) + padL(rupees(l.amountPaise), aw));
    for (let rest = name.slice(first.length); rest; rest = rest.slice(w - 2)) p.line('  ' + rest.slice(0, w - 2));
    for (const e of l.extras) p.line(`  + ${e}`);
    if (l.qty > 1) p.line(`  @ ${rupees(l.ratePaise)}`);
  }
  p.hr();
  p.lr('Subtotal', rupees(t.subtotal));
  if (t.discount) p.lr(s.discountLabel || 'Discount', '-' + rupees(t.discount));
  if (!s.composition) {
    p.lr('Taxable value', rupees(t.taxable));
    p.lr(`CGST @ ${t.cgstRate}%`, rupees(t.cgst));
    p.lr(`SGST @ ${t.sgstRate}%`, rupees(t.sgst));
  }
  if (t.serviceCharge) p.lr(`Service charge @ ${s.serviceChargePct}% (optional)`, rupees(t.serviceCharge));
  if (t.roundOff) p.lr('Round off', rupees(t.roundOff));
  p.bold(true).double(true).lr('TOTAL', 'Rs.' + rupees(t.total), Math.floor(w / 2)).double(false).bold(false);
  if (b.tip_paise) p.lr('Tip', rupees(b.tip_paise));
  for (const pay of all(db, 'SELECT mode, amount_paise FROM bill_payments WHERE bill_id=?', b.id)) p.lr(`Paid ${pay.mode.toUpperCase()}`, rupees(pay.amount_paise));
  p.hr();
  if (s.compositionLegend) p.line(s.compositionLegend);
  p.align('center');
  if (s.footer) p.line(s.footer);
  p.line('Authorised signatory');
  return p.cut().toBuffer();
}

/** @param {string} station @param {number} cols */
export function renderTest(station, cols) {
  const p = new EscPos(cols);
  p.align('center').bold(true).double(true).line('TEST PRINT').double(false).bold(false);
  p.line(`Station: ${station}`).line(new Date().toLocaleString('en-IN')).hr('=');
  p.align('left').line('0123456789'.repeat(Math.ceil(cols / 10)).slice(0, cols));
  p.lr('Left', 'Right');
  return p.cut().toBuffer();
}

const pad = (/** @type {string} */ s, /** @type {number} */ n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const padL = (/** @type {string} */ s, /** @type {number} */ n) => (s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s);
