// @ts-check
// Day-end tally, history, CSV export, day close (Day 17).
import { h } from '../h.js';
import { api } from '../net.js';
import { store } from '../store.js';
import { authHeaders, can } from '../session.js';
import { money, toast, download, confirmBox, run } from '../ui.js';
import { scheduleRender } from '../app.js';

let date = '';
/** @type {any} */
let tally = null;
/** @type {any[] | null} */
let hist = null;
let loading = '';

async function load() {
  loading = date;
  try {
    tally = await api('/api/reports/day?date=' + date, { auth: authHeaders() });
    hist = can('history') ? (await api('/api/history?date=' + date, { auth: authHeaders() })).bills : null;
  } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); tally = { error: true }; }
  scheduleRender();
}

export function render() {
  if (!date) date = store.businessDate;
  if (loading !== date) { tally = null; load(); }
  /** @param {string} label @param {any} v */
  const kv = (label, v) => h('tr', h('th', label), h('td', v));
  return h('main.panel',
    h('div.toolbar',
      h('input#rep-date', { type: 'date', value: date, onchange: (/** @type {any} */ e) => { date = e.target.value; scheduleRender(); } }),
      h('button', { onclick: () => { loading = ''; scheduleRender(); } }, '↻'),
      h('span.grow'),
      can('export') ? h('button', {
        onclick: async () => {
          const csv = await api('/api/export/csv?date=' + date, { auth: authHeaders() });
          download(new Blob([csv], { type: 'text/csv' }), `bills-${date}.csv`);
        },
      }, 'CSV') : null,
      can('dayclose') ? h('button.danger', { onclick: dayClose }, 'Day close') : null),
    !tally ? h('p', 'Loading…') : tally.error ? h('p', 'Could not load report.') : [
      tally.closed ? h('p.okc', `Day closed at ${new Date(tally.closed).toLocaleString('en-IN')}`) : null,
      tally.openOrders ? h('p.warn', `${tally.openOrders} order(s) still open`) : null,
      h('div.cols2',
        h('table.kv',
          kv('Bills', `${tally.bills} (${tally.settled} settled)`),
          kv('Gross (subtotal)', money(tally.subtotalPaise)),
          kv('Discounts', money(tally.discountPaise)),
          kv('Taxable value', money(tally.taxablePaise)),
          kv('CGST', money(tally.cgstPaise)),
          kv('SGST', money(tally.sgstPaise)),
          kv('Service charge (opt-in)', money(tally.servicePaise)),
          kv('Round off', money(tally.roundOffPaise)),
          kv('TOTAL', h('b', money(tally.totalPaise))),
          kv('Tips', money(tally.tipPaise)),
          kv('Waived', money(tally.waivedPaise))),
        h('table.kv',
          Object.entries(tally.byMode).map(([m, v]) => kv('Paid ' + m.toUpperCase(), money(/** @type {number} */ (v)))),
          Object.entries(tally.duesReceived).map(([m, v]) => kv('Dues received ' + m, money(/** @type {number} */ (v)))),
          kv('Visitors', tally.visitors),
          kv('Avg table time', tally.avgTableMinutes + ' min'),
          tally.byType.map((/** @type {any} */ t) => kv(t.type, `${t.n} · ${money(t.totalPaise)}`)),
          kv('KOTs', Object.entries(tally.kots).map(([k, v]) => `${k} ${v}`).join(', ') || '0'))),
      h('h3', 'Most ordered'),
      h('table.list', tally.mostOrdered.map((/** @type {any} */ m) => h('tr', h('td', m.name), h('td', m.qty), h('td', money(m.amountPaise))))),
      h('h3', 'Deleted / voided / discounts'),
      tally.deleted.length ? h('table.list', h('tr', h('th', 'Time'), h('th', 'What'), h('th', 'Reason'), h('th', 'By'), h('th', 'Approver')),
        tally.deleted.map((/** @type {any} */ d) => h('tr', h('td', new Date(d.ts).toLocaleTimeString('en-IN', { hour12: false })),
          h('td', `${d.entity} ${d.detail.name ?? d.detail.no ?? ''}${d.detail.qty ? ' ×' + d.detail.qty : ''}`), h('td', d.reason), h('td', d.user ?? ''), h('td', d.approver ?? '')))) : h('p.muted', 'None'),
      hist ? [h('h3', 'Bills'), h('table.list', h('tr', h('th', 'No'), h('th', 'Order'), h('th', 'Total'), h('th', 'Paid'), h('th', 'Status')),
        hist.map((b) => h('tr', h('td', b.no), h('td', `#${b.order_no} ${b.table_name ?? b.type}`), h('td', money(b.total_paise)),
          h('td', b.payments.map((/** @type {any} */ p) => `${p.mode} ${money(p.amount_paise)}`).join(', ')), h('td', h('span.tag.' + b.status, b.status)))))] : null,
    ]);
}

async function dayClose() {
  if (!(await confirmBox(`Close business day ${date}? Bills for this date are locked and KOT numbers restart from 1.`))) return;
  try {
    await run('dayclose', { date }, 'Day closed; backup taken');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'OPEN_ORDERS' && (await confirmBox(`${/** @type {Error} */ (e).message}. Close anyway? Open orders stay open.`))) {
      await run('dayclose', { date, force: true }, 'Day closed').catch(() => null);
    }
  }
  loading = '';
  scheduleRender();
}
