// @ts-check
// Bills (legacy "Bill History"): running orders awaiting a bill, bills for any date range from the host
// (with totals by payment mode, view / reprint), Bill No finder, customer dues with "Receive".
import { h } from '../h.js';
import { api } from '../net.js';
import { list, store, orderTotals, orderRef, typeLabel } from '../store.js';
import { authHeaders, can } from '../session.js';
import { money, ask, tryRun, toPaise, ago, toast, modal } from '../ui.js';
import { go, scheduleRender } from '../app.js';

const MODE_LABEL = /** @type {Record<string, string>} */ ({ cash: 'Cash', card: 'Card', upi: 'UPI', due: 'Due', other: 'Other' });

let tab = 'open';
let from = '', to = '';
/** @type {any[] | null} */
let hist = null;
let loaded = '';

async function loadHist() {
  loaded = from + '|' + to;
  hist = null;
  try { hist = (await api(`/api/history?from=${from}&to=${to}`, { auth: authHeaders() })).bills; } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); hist = []; }
  scheduleRender();
}

export function render() {
  if (!from) from = to = store.businessDate;
  const orders = list('orders').filter((o) => o.status === 'open' || o.status === 'billed').sort((a, b) => a.openedAt - b.openedAt);
  const dues = list('customers').filter((c) => c.duePaise > 0).sort((a, b) => b.duePaise - a.duePaise);
  const now = Date.now();
  if (tab === 'bills' && loaded !== from + '|' + to) loadHist();
  /** @param {string} id @param {string} label */
  const tabBtn = (id, label) => h('button' + (tab === id ? '.on' : ''), { onclick: () => { tab = id; scheduleRender(); } }, label);
  /** @type {Record<string, number>} */
  const byMode = {};
  let total = 0;
  for (const b of hist ?? []) {
    if (b.status === 'void') continue;
    total += b.total_paise;
    for (const p of b.payments) byMode[p.mode] = (byMode[p.mode] ?? 0) + p.amount_paise;
  }
  return h('main.panel',
    h('div.tabs', tabBtn('open', `Running orders (${orders.length})`), can('history') || can('bill') ? tabBtn('bills', 'Bill History') : null, can('customers.due') ? tabBtn('dues', `Dues (${dues.length})`) : null),
    tab === 'open' ? h('table.list', h('tr', h('th', 'Order'), h('th', 'Type'), h('th', 'Time'), h('th', 'Amount'), h('th', 'Status')),
      orders.map((o) => h('tr.click', { onclick: () => go(can('bill') ? 'bill/' + o.id : 'order/' + o.id) },
        h('td', orderRef(o)), h('td', typeLabel(o)), h('td', ago(now - o.openedAt)),
        h('td', money(orderTotals(o).total)), h('td', h('span.tag.' + o.status, o.status === 'billed' ? 'bill printed' : o.held ? 'on hold' : o.status)))),
      !orders.length ? h('tr', h('td.muted', { colspan: 5 }, 'No running orders.')) : null) : null,
    tab === 'bills' ? [
      h('div.toolbar',
        h('label', 'From', h('input#hist-from', { type: 'date', value: from, onchange: (/** @type {any} */ e) => { from = e.target.value; scheduleRender(); } })),
        h('label', 'To', h('input#hist-to', { type: 'date', value: to, onchange: (/** @type {any} */ e) => { to = e.target.value; scheduleRender(); } })),
        h('button', { onclick: () => { from = to = store.businessDate; scheduleRender(); } }, 'Today'),
        h('button', { onclick: () => loadHist() }, '↻')),
      hist === null ? h('p', 'Loading…') : [
        h('div.chips', h('span.chip.on', `${hist.filter((b) => b.status !== 'void').length} bills · ${money(total)}`),
          Object.entries(byMode).map(([m, v]) => h('span.chip', `${MODE_LABEL[m] ?? m} ${money(v)}`))),
        h('table.list', h('tr', h('th', 'Bill No'), h('th', 'Date'), h('th', 'Order'), h('th', 'Total'), h('th', 'Paid by'), h('th', 'Status')),
          hist.slice().reverse().map((b) => h('tr.click', { onclick: () => viewBill(b) },
            h('td', b.no), h('td', `${b.business_date} ${new Date(b.created_at).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`),
            h('td', `${b.table_name || '#' + b.order_no} · ${b.type === 'dine' ? 'Dine In' : b.type === 'takeaway' ? 'Pick Up' : 'Delivery'}`),
            h('td', money(b.total_paise)),
            h('td', b.payments.map((/** @type {any} */ p) => `${MODE_LABEL[p.mode] ?? p.mode}${p.other_type ? ' (' + p.other_type + ')' : ''} ${money(p.amount_paise)}`).join(', ')),
            h('td', h('span.tag.' + b.status, b.status)))),
          !hist.length ? h('tr', h('td.muted', { colspan: 6 }, 'No bills in these dates.')) : null)]] : null,
    tab === 'dues' ? h('table.list', h('tr', h('th', 'Customer'), h('th', 'Mobile'), h('th', 'Due'), h('th', '')),
      dues.map((c) => h('tr', h('td', c.name || '—'), h('td', c.phone), h('td', money(c.duePaise)),
        h('td', h('button.small', { onclick: () => receiveDue(c) }, 'Receive')))),
      !dues.length ? h('tr', h('td.muted', { colspan: 4 }, 'No customer has a due.')) : null) : null);
}

/** @param {any} c */
export async function receiveDue(c) {
  const amt = await ask(`Receive from ${c.name || c.phone} (due ${money(c.duePaise ?? c.due_paise)})`, { value: ((c.duePaise ?? c.due_paise) / 100).toFixed(2), type: 'number' });
  if (!amt) return false;
  const mode = await ask('Paid by', { chips: ['cash', 'upi', 'card', 'other'] });
  if (!mode) return false;
  return !!(await tryRun('due.receive', { customerId: c.id, amount: toPaise(amt), mode }, 'Received'));
}

/** Bill from history (snapshot rendered like the printed bill). @param {any} b */
function viewBill(b) {
  const live = list('bills').find((x) => x.id === b.id);
  if (live) return go('bill/' + live.orderId);
  const s = b.snapshot, t = s.totals;
  /** @param {string} l @param {string} v */
  const row = (l, v) => h('div.pr', h('span', l), h('span', v));
  modal(`Bill ${b.no}`, () => h('div.receipt',
    h('div.c.big', s.name), h('div.c.b', s.title),
    row('Bill No: ' + b.no, new Date(b.created_at).toLocaleString('en-IN', { hour12: false })),
    row(s.type === 'dine' ? 'Table ' + s.table : s.table || s.type, s.cashier ? 'Cashier: ' + s.cashier : ''),
    h('hr'),
    s.lines.map((/** @type {any} */ l) => h('div', row(`${l.qty} × ${l.name}${l.variant ? ` (${l.variant})` : ''}`, money(l.amountPaise)),
      (l.extras || []).map((/** @type {any} */ e) => row(`   + ${e.name ?? e} × ${e.qty ?? 1}`, e.amountPaise ? money(e.amountPaise) : '')))),
    h('hr'),
    row('Sub Total', money(t.subtotal)),
    t.comp ? row('Complimentary', '−' + money(t.compValue)) : null,
    t.discount ? row('Discount', '−' + money(t.discount)) : null,
    t.delivery ? row('Delivery Charge', money(t.delivery)) : null,
    (t.taxes ?? []).map((/** @type {any} */ x) => row(`${x.name} @ ${x.rate}%`, money(x.amountPaise))),
    t.roundOff ? row('Round off', (t.roundOff / 100).toFixed(2)) : null,
    row('TOTAL', money(t.total)),
    b.payments.map((/** @type {any} */ p) => row('Paid by ' + (MODE_LABEL[p.mode] ?? p.mode), money(p.amount_paise)))));
}

/** Bill No finder (top bar). @param {string} no */
export async function findAndOpen(no) {
  const n = no.trim().toUpperCase();
  const live = list('bills').find((b) => String(b.no).toUpperCase() === n || String(b.no).toUpperCase().endsWith('/' + n) || String(b.seq) === n);
  if (live) return go('bill/' + live.orderId);
  try {
    const bills = (await api(`/api/history?from=2000-01-01&to=2999-12-31`, { auth: authHeaders() })).bills;
    const b = bills.find((/** @type {any} */ x) => String(x.no).toUpperCase() === n || String(x.no).toUpperCase().endsWith('/' + n) || String(x.seq) === n);
    if (b) viewBill(b); else toast(`Bill ${no} not found`, 'err');
  } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
}
