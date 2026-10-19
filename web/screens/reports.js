// @ts-check
// Reports (Day 17, legacy parity): date range (Today / Last 7 days / This month / custom) and tabs
// Day-end tally · Visitors · Table time · Most ordered · Deleted items. Each tab downloads as CSV
// (Excel) or prints. Tally check, cash counted in the drawer, customer dues, day close.
import { h } from '../h.js';
import { api } from '../net.js';
import { store } from '../store.js';
import { authHeaders, can } from '../session.js';
import { money, toast, download, confirmBox, run, ask, toPaise, tryRun } from '../ui.js';
import { scheduleRender } from '../app.js';
import { browserPrint } from '../print.js';
import { receiveDue } from './bills.js';

const MODE_LABEL = /** @type {Record<string, string>} */ ({ cash: 'Cash', card: 'Card', upi: 'UPI', due: 'Due', other: 'Other' });
const TABS = [['tally', 'Day-end tally'], ['visitors', 'Visitors'], ['tables', 'Table time'], ['items', 'Most ordered'], ['voids', 'Deleted items']];

let from = '', to = '';
let tab = 'tally';
/** @type {any} */
let rep = null;
let loaded = '';

async function load() {
  loaded = from + '|' + to;
  rep = null;
  try { rep = await api(`/api/reports?from=${from}&to=${to}`, { auth: authHeaders() }); } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); rep = { error: true }; }
  scheduleRender();
}

/** @param {Date} d */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** @param {string} a @param {string} b */
const setRange = (a, b) => { from = a; to = b; scheduleRender(); };

/** @param {number} m minutes */
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
/** @param {number} p */
const rs = (p) => (p / 100).toFixed(2);

/** Rows (header first) for the current tab — used for both the table and the CSV. @returns {any[][]} */
function rows() {
  if (!rep || rep.error) return [];
  if (tab === 'visitors') return [['Date', 'Bills', 'Guests', 'Bills without guests'], ...rep.visitors.map((/** @type {any} */ v) => [v.date, v.bills, v.guests, v.none])];
  if (tab === 'tables') return [['Table', 'Section', 'Times used', 'Total time', 'Average', 'Longest', 'Guests'], ...rep.tables.map((/** @type {any} */ t) => [t.table, t.section, t.times, mins(t.totalMin), mins(t.avgMin), mins(t.maxMin), t.guests])];
  if (tab === 'items') return [['#', 'Item', 'Quantity', 'Amount ₹'], ...rep.items.map((/** @type {any} */ i, /** @type {number} */ n) => [n + 1, i.name, i.qty, rs(i.amountPaise)])];
  if (tab === 'voids') return [['Date', 'Time', 'What', 'Qty', 'Amount ₹', 'Table / order', 'Reason', 'By', 'Approved by'], ...rep.voids.map((/** @type {any} */ v) => [
    v.date, new Date(v.ts).toLocaleTimeString('en-IN', { hour12: false }), voidWhat(v), v.detail.qty ?? '', v.detail.amountPaise != null ? rs(v.detail.amountPaise) : v.detail.discountPaise != null ? rs(v.detail.discountPaise) : v.detail.totalPaise != null ? rs(v.detail.totalPaise) : '',
    v.detail.table ?? '', v.reason, v.user ?? '', v.approver ?? ''])];
  const t = rep.tally;
  return [['Item', 'Amount ₹'],
    ['Bills', t.bills], ['Settled bills', t.settled], ['Sub total', rs(t.subtotalPaise)], ['Discount', rs(t.discountPaise)], ['Complimentary value', rs(t.compPaise)],
    ['Delivery charge', rs(t.deliveryPaise)], ['Tax', rs(t.taxPaise)], ['Service charge', rs(t.servicePaise)], ['Round off', rs(t.roundOffPaise)], ['Total billing amount', rs(t.totalPaise)],
    ['Settlement (waived)', rs(t.waivedPaise)], ['Amount to collect', rs(t.toCollectPaise)],
    ...Object.entries(t.byMode).map(([m, v]) => ['Paid by ' + (MODE_LABEL[m] ?? m), rs(/** @type {number} */ (v))]),
    ...Object.entries(t.otherBreak).map(([m, v]) => ['  Other: ' + m, rs(/** @type {number} */ (v))]),
    ['Tips', rs(t.tipPaise)], ['Money collected (without tips)', rs(t.collectedPaise)], ['Customers with due', rs(t.duePaise)], ['Difference', rs(t.diffPaise)],
    ['Dues received', rs(t.duesReceivedPaise)], ['Cash expected in drawer', rs(t.expectedCashPaise)]];
}

/** @param {any} v */
function voidWhat(v) {
  if (v.entity === 'bill_discount') return v.detail.complimentary ? `Complimentary bill ${v.detail.no ?? ''}` : `Discount on bill ${v.detail.no ?? ''}`;
  if (v.entity === 'bill') return `Bill voided ${v.detail.no ?? ''}`;
  if (v.entity === 'order') return 'Order cancelled';
  return v.detail.name ?? v.entity;
}

function csv() {
  const cell = (/** @type {any} */ c) => { const s = String(c ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = '﻿' + rows().map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  download(new Blob([text], { type: 'text/csv' }), `${tab}-${from}${to !== from ? '_to_' + to : ''}.csv`);
}

function printTab() {
  const rs2 = rows();
  browserPrint(h('div.receipt', h('div.c.b', store.settings.name), h('div.c', `${TABS.find((t) => t[0] === tab)?.[1]} · ${from}${to !== from ? ' to ' + to : ''}`), h('hr'),
    h('table', rs2.map((r, i) => h('tr', r.map((c) => h(i ? 'td' : 'th', String(c))))))));
}

export function render() {
  if (!from) from = to = store.businessDate;
  if (loaded !== from + '|' + to) load();
  const today = new Date(store.businessDate + 'T00:00:00');
  const single = from === to;
  const r = rows();
  return h('main.panel',
    h('div.toolbar',
      h('label', 'From', h('input#rep-from', { type: 'date', value: from, onchange: (/** @type {any} */ e) => setRange(e.target.value, to < e.target.value ? e.target.value : to) })),
      h('label', 'To', h('input#rep-to', { type: 'date', value: to, onchange: (/** @type {any} */ e) => setRange(from, e.target.value) })),
      h('button', { onclick: () => setRange(store.businessDate, store.businessDate) }, 'Today'),
      h('button', { onclick: () => { const d = new Date(today); d.setDate(d.getDate() - 6); setRange(iso(d), store.businessDate); } }, 'Last 7 days'),
      h('button', { onclick: () => setRange(store.businessDate.slice(0, 8) + '01', store.businessDate) }, 'This month'),
      h('button', { onclick: () => { loaded = ''; scheduleRender(); }, title: 'Refresh' }, '↻'),
      h('span.grow'),
      can('export') ? h('button', { onclick: csv }, '⬇ Excel (CSV)') : null,
      can('export') ? h('button', { onclick: billsCsv }, '⬇ All bills CSV') : null,
      h('button', { onclick: printTab }, '🖨 Print'),
      can('dayclose') && single ? h('button.danger', { onclick: dayClose }, 'Day close') : null),
    h('div.tabs', TABS.map(([id, label]) => h('button' + (tab === id ? '.on' : ''), { onclick: () => { tab = id; scheduleRender(); } }, label))),
    !rep ? h('p', 'Loading…') : rep.error ? h('p', 'Could not load the report.') : tab === 'tally' ? tallyView(rep, single) :
      h('table.list', r.map((row, i) => h('tr', row.map((c) => h(i ? 'td' : 'th', String(c))))), r.length < 2 ? h('tr', h('td.muted', { colspan: 9 }, 'Nothing in these dates.')) : null));
}

async function billsCsv() {
  try {
    const text = await api(`/api/export/csv?from=${from}&to=${to}`, { auth: authHeaders() });
    download(new Blob([text], { type: 'text/csv' }), `bills-${from}${to !== from ? '_to_' + to : ''}.csv`);
  } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
}

/** @param {any} rep @param {boolean} single */
function tallyView(rep, single) {
  const t = rep.tally;
  /** @param {string} l @param {any} v @param {string} [cls] */
  const kv = (l, v, cls = '') => h('tr' + cls, h('th', l), h('td', v));
  const ok = t.diffPaise === 0;
  return [
    t.openOrders ? h('p.warn', `${t.openOrders} order(s) are still running — they are not in this tally.`) : null,
    h('div.cols2',
      h('div', h('h3', 'Billing amount'), h('table.kv',
        kv('Bills', `${t.bills} (${t.settled} settled${t.openBills ? `, ${t.openBills} not settled` : ''})`),
        kv('Sub total', money(t.subtotalPaise)),
        t.discountPaise ? kv('Discount', '−' + money(t.discountPaise)) : null,
        t.compPaise ? kv('Complimentary (value)', money(t.compPaise)) : null,
        t.deliveryPaise ? kv('Delivery charge', money(t.deliveryPaise)) : null,
        kv('Tax', money(t.taxPaise)),
        t.servicePaise ? kv('Service charge (optional)', money(t.servicePaise)) : null,
        kv('Round off', money(t.roundOffPaise)),
        kv('Total billing amount', h('b', money(t.totalPaise))),
        t.waivedPaise ? kv('Settlement (customer paid less)', '−' + money(t.waivedPaise)) : null,
        kv('Amount to collect', h('b', money(t.toCollectPaise))))),
      h('div', h('h3', 'Money collected'), h('table.kv',
        Object.entries(t.byMode).filter(([m]) => m !== 'due').map(([m, v]) => kv(MODE_LABEL[m] ?? m, money(/** @type {number} */ (v)))),
        Object.entries(t.otherBreak).map(([m, v]) => kv('  · ' + m, money(/** @type {number} */ (v)), '.small')),
        t.tipPaise ? kv('of which tips', money(t.tipPaise)) : null,
        kv('Collected (without tips)', h('b', money(t.collectedPaise))),
        kv('Customers with due', money(t.duePaise)),
        kv('Tally check', h('b' + (ok ? '.okc' : '.bad'), ok ? '✓ Matches' : `Difference ${money(t.diffPaise)}`)),
        t.duesReceivedPaise ? kv('Old dues received', money(t.duesReceivedPaise)) : null))),
    h('h3', 'Cash in the drawer'),
    h('table.kv',
      kv('Cash expected (cash bills + cash dues received)', money(t.expectedCashPaise)),
      single && t.cashCounted ? [kv('Cash counted', `${money(t.cashCounted.countedPaise)} by ${t.cashCounted.by}`),
        kv('Difference', h('b' + (t.cashCounted.diffPaise === 0 ? '.okc' : '.bad'), money(t.cashCounted.diffPaise)))] : null),
    single && can('reports') ? h('button', {
      onclick: async () => {
        const v = await ask('Cash counted in the drawer (₹)', { type: 'number', value: t.cashCounted ? String(t.cashCounted.countedPaise / 100) : '' });
        if (v !== null && (await tryRun('cash.count', { date: from, countedPaise: toPaise(v) }, 'Cash count saved'))) { loaded = ''; scheduleRender(); }
      },
    }, 'Enter cash counted') : null,
    t.byType.length ? [h('h3', 'By order type'), h('table.kv', t.byType.map((/** @type {any} */ x) => kv(x.type === 'dine' ? 'Dine In' : x.type === 'takeaway' ? 'Pick Up' : 'Delivery', `${x.n} bills · ${money(x.totalPaise)}`)))] : null,
    h('h3', 'Customers with due (all dates)'),
    rep.dues.length ? h('table.list', h('tr', h('th', 'Customer'), h('th', 'Mobile'), h('th', 'Due'), h('th', '')),
      rep.dues.map((/** @type {any} */ c) => h('tr', h('td', c.name || '—'), h('td', c.phone), h('td', money(c.due_paise)),
        h('td', can('customers.due') ? h('button.small', { onclick: async () => { if (await receiveDue(c)) { loaded = ''; scheduleRender(); } } }, 'Receive') : null)))) : h('p.muted', 'None'),
  ];
}

async function dayClose() {
  if (!(await confirmBox(`Close business day ${from}? Bills for this date are locked and KOT numbers restart from 1.`))) return;
  try {
    await run('dayclose', { date: from }, 'Day closed; backup taken');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'OPEN_ORDERS' && (await confirmBox(`${/** @type {Error} */ (e).message}. Close anyway? Open orders stay open.`))) {
      await run('dayclose', { date: from, force: true }, 'Day closed').catch(() => null);
    }
  }
  loaded = '';
  scheduleRender();
}
