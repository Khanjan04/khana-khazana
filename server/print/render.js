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
  const user = get(db, 'SELECT name FROM users WHERE id=?', k.created_by)?.name ?? '';
  const lines = all(db, 'SELECT * FROM order_lines WHERE kot_id=? ORDER BY created_at, rowid', kotId);
  const p = new EscPos(o.cols ?? colsFor(getSettings(db).paper));
  p.align('center').line(time(k.created_at));
  p.bold(true).double(true).line(`KOT - ${k.no}`).double(false);
  if (o.reprint) p.line('** REPRINT **');
  if (k.status === 'cancelled' || k.status === 'rejected') p.line(`** ${k.status.toUpperCase()} **`);
  p.line(typeLabel(ord)).bold(false);
  p.bold(true).double(true).line((ord.type === 'dine' ? 'Table No: ' : 'Order No: ') + ord.ref).double(false).bold(false);
  if (ord.persons) p.line(`Guests: ${ord.persons}`);
  if (k.station !== 'kitchen') p.line(k.station.toUpperCase());
  p.align('left');
  if (user) p.line(`By: ${user}`);
  p.hr();
  p.bold(true).lr('Item', 'Qty.').bold(false);
  for (const l of lines) {
    const extras = JSON.parse(l.extras || '[]');
    p.bold(!l.voided).lr(`${l.voided ? 'X ' : ''}${l.name}${l.variant ? ` (${l.variant})` : ''}${l.voided ? ' [CANCELLED]' : ''}`, String(l.qty)).bold(false);
    for (const e of extras) p.line(`  Sides: ${e.name} - ${e.qty ?? 1}`);
    if (l.note) p.line(`  [Note] ${l.note}`);
  }
  p.hr();
  if (k.note) p.line(`Note: ${k.note}`);
  if (ord.comment) p.bold(true).line(`[Order note] ${ord.comment}`).bold(false);
  return p.beep().cut().toBuffer();
}

/** @param {any} o */
export const typeLabel = (o) => (o.type === 'dine' ? 'Dine In' : o.type === 'takeaway' ? 'Pickup' : 'Delivery' + (o.platform ? ' - ' + o.platform : ''));
const PAY_NAME = /** @type {Record<string, string>} */ ({ cash: 'Cash', card: 'Card', upi: 'UPI', other: 'Other', due: 'Due' });

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
  p.hr();
  p.bold(true).line(b.status === 'settled' || b.status === 'void' ? s.title.toUpperCase() : 'BILL (payment pending)').bold(false);
  if (b.reprints > 0) p.line(`DUPLICATE (${b.reprints})`);
  if (b.status === 'void') p.line('** VOID **');
  p.align('left');
  p.lr(`Bill No: ${s.billNo}`, time(b.settled_at ?? b.created_at));
  p.line(`${typeLabel(s)}  ${s.type === 'dine' ? 'Table' : 'Order'}: ${s.table}${s.section ? ` (${s.section})` : ''}${s.platformRef ? ` Ref ${s.platformRef}` : ''}`);
  if (s.customer && (s.customer.name || s.customer.phone)) {
    p.line(`Customer: ${[s.customer.name, s.customer.phone].filter(Boolean).join(' / ')}`);
    if (s.customer.address || s.customer.locality) p.line([s.customer.address, s.customer.locality].filter(Boolean).join(', '));
  }
  if (s.cashier) p.line(`Cashier: ${s.cashier}`);
  if (s.placeOfSupply) p.line(`Place of supply: ${s.placeOfSupply}`);
  if (!s.composition && s.sac) p.line(`SAC: ${s.sac}`);
  p.hr();
  const qw = 4, rw = 8, aw = 9, nw = w - qw - rw - aw;
  p.bold(true).line(pad('Item', nw) + padL('Qty', qw) + padL('Rate', rw) + padL('Amt', aw)).bold(false);
  for (const l of s.lines) {
    const name = `${l.name}${l.variant ? ` (${l.variant})` : ''}`;
    const rate = l.ratePaise ?? l.amountPaise / l.qty;
    p.line(pad(name.slice(0, nw - 1), nw) + padL(String(l.qty), qw) + padL(rupees(rate), rw) + padL(rupees(l.amountPaise), aw));
    for (let rest = name.slice(nw - 1); rest; rest = rest.slice(w - 2)) p.line('  ' + rest.slice(0, w - 2));
    for (const e of l.extras ?? []) {
      if (typeof e === 'string') { p.line(`  + ${e}`); continue; }
      p.line(pad(`  + ${e.name} x${e.qty}`.slice(0, nw + qw), nw + qw) + padL(rupees(e.ratePaise), rw) + padL(rupees(e.amountPaise), aw));
    }
    if (l.note) p.line(`  [Note] ${l.note}`);
  }
  p.hr();
  if (t.comp) {
    p.lr('Item value', rupees(t.compValue));
    p.lr('Complimentary', '-' + rupees(t.compValue));
  } else {
    p.lr('Sub Total', rupees(t.subtotal));
    if (t.discount) p.lr(s.discountLabel || 'Discount', '-' + rupees(t.discount));
    if (t.delivery) p.lr('Delivery Charge', rupees(t.delivery));
    for (const x of t.taxes ?? [{ name: 'CGST', rate: t.cgstRate, amountPaise: t.cgst }, { name: 'SGST', rate: t.sgstRate, amountPaise: t.sgst }]) {
      p.lr(`${x.name} @${x.rate}%`, rupees(x.amountPaise));
    }
    if (t.serviceCharge) p.lr(`Service charge @${s.serviceChargePct}% (optional)`, rupees(t.serviceCharge));
    if (t.roundOff) p.lr('Round off', (t.roundOff > 0 ? '+' : '') + rupees(t.roundOff));
  }
  p.bold(true).double(true).lr('TOTAL', 'Rs.' + rupees(t.total), Math.floor(w / 2)).double(false).bold(false);
  const pays = all(db, 'SELECT mode, other_type, amount_paise FROM bill_payments WHERE bill_id=?', b.id);
  if (b.status === 'settled') {
    p.hr();
    if (t.comp) p.bold(true).line('Paid by: Complimentary').bold(false);
    else if (pays.length === 1) p.bold(true).line(`Paid by: ${PAY_NAME[pays[0].mode]}${pays[0].other_type ? ` (${pays[0].other_type})` : ''}`).bold(false);
    else if (pays.length > 1) {
      p.bold(true).line('Paid by: Part payment').bold(false);
      p.line(pays.map((x) => `${PAY_NAME[x.mode]} ${rupees(x.amount_paise)}`).join(' | '));
    }
    if (pays.some((x) => x.mode === 'due')) p.line('Amount added to customer account');
    if (b.waived_paise) p.line(`Waived off ${rupees(b.waived_paise)}`);
    if (b.tip_paise) p.line(`Tip ${rupees(b.tip_paise)}`);
    if (b.change_paise > 0) p.line(`Cash given ${rupees(b.tendered_paise)} | Returned ${rupees(b.change_paise)}`);
  }
  p.hr();
  if (s.compositionLegend) p.line(s.compositionLegend);
  p.align('center');
  if (s.footer) p.line(s.footer);
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
