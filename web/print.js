// @ts-check
// Client print adapters (Day 18): 'host-lan' | 'rawbt' | 'browser', chosen per device.
import { h } from './h.js';
import { api } from './net.js';
import { authHeaders } from './session.js';
import { store, byId, linesOf, list } from './store.js';
import { money, tryRun, toast } from './ui.js';

const KEY = 'pos.printMode';
export const MODES = /** @type {const} */ (['host-lan', 'rawbt', 'browser']);

/** @returns {'host-lan'|'rawbt'|'browser'} */
export function printMode() {
  try { const m = localStorage.getItem(KEY); if (m && /** @type {any} */ (MODES).includes(m)) return /** @type {any} */ (m); } catch { /* ignore */ }
  return store.settings.billPrintMode ?? 'browser';
}
/** @param {string} m */
export function setPrintMode(m) {
  try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
}

/** RawBT: navigate to rawbt:base64,<ESC/POS bytes rendered by the host>. @param {string} kind @param {string} id */
async function rawbt(kind, id) {
  const r = await api(`/api/print/render?kind=${kind}&id=${encodeURIComponent(id)}`, { auth: authHeaders() });
  location.href = 'rawbt:base64,' + r.b64;
}

/** @param {string} billId */
export async function printBill(billId) {
  const mode = printMode();
  try {
    if (mode === 'host-lan') await tryRun('print.bill', { billId }, 'Sent to printer');
    else if (mode === 'rawbt') await rawbt('bill', billId);
    else browserPrint(billHtml(billId));
  } catch (e) { toast('Print failed: ' + /** @type {Error} */ (e).message, 'err'); }
}

/** @param {string} kotId */
export async function printKot(kotId) {
  const mode = printMode();
  try {
    if (mode === 'host-lan') await tryRun('print.kot', { kotId }, 'Sent to printer');
    else if (mode === 'rawbt') await rawbt('kot', kotId);
    else browserPrint(kotHtml(kotId));
  } catch (e) { toast('Print failed: ' + /** @type {Error} */ (e).message, 'err'); }
}

export async function testPrint() {
  const mode = printMode();
  if (mode === 'host-lan') return tryRun('print.test', { station: 'bill' }, 'Test sent');
  if (mode === 'rawbt') return rawbt('test', 'x');
  browserPrint(h('div', h('h2.c', 'TEST PRINT'), h('p.c', new Date().toLocaleString('en-IN')), h('p', '0123456789'.repeat(5))));
}

/** window.print() with 58/80 mm @page CSS (styles in style.css). @param {HTMLElement} node */
export function browserPrint(node) {
  const area = document.getElementById('print-area') ?? document.body.appendChild(h('div#print-area'));
  area.replaceChildren(node);
  document.body.dataset.paper = String(store.settings.paper ?? 80);
  setTimeout(() => window.print(), 50);
}

/** Legacy bill layout: header, Bill No / date / table, cashier, items with extras, totals with every tax, paid-by. @param {string} billId */
export function billHtml(billId) {
  const b = byId('bills', billId);
  const s = b.snapshot, t = s.totals;
  /** @param {string} l @param {string} r @param {string} [cls] */
  const row = (l, r, cls = '') => h('div.pr' + (cls ? '.' + cls : ''), h('span', l), h('span', r));
  const pays = list('bill_payments').filter((p) => p.billId === billId);
  const MODE = /** @type {Record<string, string>} */ ({ cash: 'Cash', card: 'Card', upi: 'UPI', due: 'Due', other: 'Other' });
  const where = s.type === 'dine' ? `Table No: ${s.table}` : s.type === 'delivery' ? `Delivery: ${s.table}${s.platform ? ' (' + s.platform + (s.platformRef ? ' ' + s.platformRef : '') + ')' : ''}` : `Pick Up: ${s.table}`;
  return h('div.receipt',
    h('div.c.big', s.name),
    s.address ? h('div.c', s.address) : null,
    s.phone ? h('div.c', 'Ph: ' + s.phone) : null,
    s.gstin ? h('div.c', 'GSTIN: ' + s.gstin) : null,
    s.fssai ? h('div.c', 'FSSAI: ' + s.fssai) : null,
    h('div.c.b', (b.status === 'open' ? 'BILL (payment pending)' : s.title) + (b.reprints ? ` — DUPLICATE (${b.reprints})` : '') + (b.status === 'void' ? ' — VOID' : '')),
    h('hr'),
    row('Bill No: ' + s.billNo, new Date(b.createdAt).toLocaleString('en-IN', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })),
    row(where, s.persons ? `Guests: ${s.persons}` : ''),
    s.cashier ? h('div', 'Cashier: ' + s.cashier) : null,
    s.customer?.name || s.customer?.phone ? h('div', `Customer: ${s.customer.name || ''} ${s.customer.phone || ''}`) : null,
    s.customer?.address ? h('div.small', [s.customer.address, s.customer.locality].filter(Boolean).join(', ')) : null,
    s.placeOfSupply ? h('div.small', 'Place of supply: ' + s.placeOfSupply) : null,
    !s.composition && s.sac ? h('div.small', 'SAC: ' + s.sac) : null,
    h('hr'),
    h('div.pr.b', h('span', 'Item'), h('span', 'Qty × Rate = Amt')),
    s.lines.map((/** @type {any} */ l) => h('div',
      h('div', `${l.name}${l.variant ? ` (${l.variant})` : ''}`),
      row('', `${l.qty} × ${(l.ratePaise / 100).toFixed(2)} = ${(l.amountPaise / 100).toFixed(2)}`),
      (l.extras || []).map((/** @type {any} */ e) => typeof e === 'string' ? h('div.small', '  + ' + e)
        : row(`  + ${e.name}`, `${e.qty} × ${(e.ratePaise / 100).toFixed(2)} = ${(e.amountPaise / 100).toFixed(2)}`, 'small')))),
    h('hr'),
    row('Sub Total', money(t.subtotal)),
    t.comp ? row('Complimentary', '−' + money(t.compValue)) : null,
    t.discount ? row(s.discountLabel || 'Discount', '−' + money(t.discount)) : null,
    t.delivery ? row('Delivery Charge', money(t.delivery)) : null,
    !s.composition ? (t.taxes ?? []).map((/** @type {any} */ x) => row(`${x.name} @ ${x.rate}%`, money(x.amountPaise))) : null,
    t.serviceCharge ? row(`Service charge @ ${s.serviceChargePct}% (optional)`, money(t.serviceCharge)) : null,
    t.roundOff ? row('Round off', (t.roundOff > 0 ? '+' : '') + (t.roundOff / 100).toFixed(2)) : null,
    row('GRAND TOTAL', money(t.total), 'big'),
    pays.length ? [h('hr'), pays.length > 1 ? h('div.b', 'Paid by (part payment):') : null,
      pays.map((p) => row(pays.length > 1 ? '  ' + (MODE[p.mode] ?? p.mode) + (p.otherType ? ` (${p.otherType})` : '') : 'Paid by: ' + (MODE[p.mode] ?? p.mode) + (p.otherType ? ` (${p.otherType})` : ''), money(p.amountPaise))),
      b.tenderedPaise && b.changePaise ? [row('Cash given', money(b.tenderedPaise)), row('Cash returned', money(b.changePaise))] : null,
      b.tipPaise ? row('Tip', money(b.tipPaise)) : null] : null,
    h('hr'),
    s.compositionLegend ? h('div.c.small', s.compositionLegend) : null,
    h('div.c', s.footer || 'Thank you! Visit again.'));
}

/** Legacy KOT: "KOT - n", Table No / Order No, time, guests, items with Sides and [Note]. @param {string} kotId */
export function kotHtml(kotId) {
  const k = byId('kots', kotId);
  const o = byId('orders', k.orderId);
  const t = byId('dining_tables', o?.tableId);
  return h('div.receipt',
    h('div.c.big', `KOT - ${k.no}`),
    k.station && k.station !== 'kitchen' ? h('div.c', k.station.toUpperCase()) : null,
    h('div.big', o?.type === 'dine' ? `Table No: ${o?.ref || t?.name || ''}` : `Order No: ${o?.ref || o?.no || ''}`),
    h('div', `${o?.type === 'dine' ? 'Dine In' : o?.type === 'delivery' ? 'Delivery' + (o?.platform ? ' - ' + o.platform : '') : 'Pick Up'} · ${new Date(k.createdAt).toLocaleString('en-IN', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`),
    o?.persons ? h('div', `Guests: ${o.persons}`) : null,
    h('hr'),
    h('div.pr.b', h('span', 'Item'), h('span', 'Qty')),
    linesOf(k.orderId).filter((l) => l.kotId === kotId).map((l) => h('div',
      h('div.pr.b', h('span', (l.voided ? 'X ' : '') + l.name + (l.variant ? ` (${l.variant})` : '')), h('span', String(l.qty))),
      (l.extras || []).map((/** @type {any} */ e) => h('div', `  Sides: ${e.name} - ${e.qty ?? 1}`)),
      l.note ? h('div', '  [Note] ' + l.note) : null)),
    h('hr'),
    o?.comment ? h('div.b', 'Order note: ' + o.comment) : null,
    k.note ? h('div', 'Note: ' + k.note) : null);
}
