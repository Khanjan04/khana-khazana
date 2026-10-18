// @ts-check
// Client print adapters (Day 18): 'host-lan' | 'rawbt' | 'browser', chosen per device.
import { h } from './h.js';
import { api } from './net.js';
import { authHeaders } from './session.js';
import { store, byId, linesOf } from './store.js';
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

/** @param {string} billId */
export function billHtml(billId) {
  const b = byId('bills', billId);
  const s = b.snapshot, t = s.totals;
  /** @param {string} l @param {string} r @param {string} [cls] */
  const row = (l, r, cls = '') => h('div.pr' + (cls ? '.' + cls : ''), h('span', l), h('span', r));
  return h('div.receipt',
    h('div.c.big', s.name),
    s.address ? h('div.c', s.address) : null,
    s.phone ? h('div.c', 'Ph: ' + s.phone) : null,
    s.gstin ? h('div.c', 'GSTIN: ' + s.gstin) : null,
    s.fssai ? h('div.c', 'FSSAI: ' + s.fssai) : null,
    h('div.c.b', s.title + (b.reprints ? ` — DUPLICATE (${b.reprints})` : '') + (b.status === 'void' ? ' — VOID' : '')),
    h('hr'),
    row('Bill: ' + s.billNo, new Date(b.createdAt).toLocaleString('en-IN', { hour12: false })),
    row(s.type === 'dine' ? 'Table ' + s.table : s.type === 'delivery' ? `Delivery ${s.platform}` : 'Takeaway', 'Order #' + s.orderNo),
    s.customer?.phone ? h('div', `Cust: ${s.customer.name || ''} ${s.customer.phone}`) : null,
    s.placeOfSupply ? h('div', 'Place of supply: ' + s.placeOfSupply) : null,
    !s.composition && s.sac ? h('div', 'SAC: ' + s.sac) : null,
    h('hr'),
    s.lines.map((/** @type {any} */ l) => h('div',
      row(`${l.name}${l.variant ? ` (${l.variant})` : ''} × ${l.qty}`, money(l.amountPaise)),
      l.extras.length ? h('div.muted', '+ ' + l.extras.join(', ')) : null)),
    h('hr'),
    row('Subtotal', money(t.subtotal)),
    t.discount ? row(s.discountLabel || 'Discount', '−' + money(t.discount)) : null,
    !s.composition ? [row('Taxable value', money(t.taxable)), row(`CGST @ ${t.cgstRate}%`, money(t.cgst)), row(`SGST @ ${t.sgstRate}%`, money(t.sgst))] : null,
    t.serviceCharge ? row(`Service charge @ ${s.serviceChargePct}% (optional)`, money(t.serviceCharge)) : null,
    t.roundOff ? row('Round off', money(t.roundOff)) : null,
    row('TOTAL', money(t.total), 'big'),
    h('hr'),
    s.compositionLegend ? h('div.c.small', s.compositionLegend) : null,
    h('div.c', s.footer || ''),
    h('div.c.small', 'Authorised signatory'));
}

/** @param {string} kotId */
export function kotHtml(kotId) {
  const k = byId('kots', kotId);
  const o = byId('orders', k.orderId);
  const t = byId('dining_tables', o?.tableId);
  return h('div.receipt',
    h('div.c.big', `KOT ${k.no}`),
    h('div.c', k.station.toUpperCase()),
    h('div.big', o?.type === 'dine' ? `Table ${t?.name ?? ''}` : o?.type === 'delivery' ? 'Delivery' : 'Takeaway'),
    h('div', `Order #${o?.no ?? ''} · ${new Date(k.createdAt).toLocaleTimeString('en-IN', { hour12: false })}`),
    h('hr'),
    linesOf(k.orderId).filter((l) => l.kotId === kotId).map((l) => h('div',
      h('div.pr.b', h('span', (l.voided ? 'X ' : '') + l.name + (l.variant ? ` (${l.variant})` : '')), h('span', '× ' + l.qty)),
      (l.extras || []).map((/** @type {any} */ e) => h('div', '  + ' + e.name)),
      l.note ? h('div', '  >> ' + l.note) : null)),
    h('hr'),
    k.note ? h('div', 'Note: ' + k.note) : null);
}
