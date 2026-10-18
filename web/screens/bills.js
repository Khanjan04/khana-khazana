// @ts-check
// Bills of the business day, orders awaiting a bill, customer dues.
import { h } from '../h.js';
import { list, byId, store, linesOf, lineTotal } from '../store.js';
import { can } from '../session.js';
import { money, ask, tryRun, toPaise, ago } from '../ui.js';
import { go, scheduleRender } from '../app.js';

let tab = 'open';

export function render() {
  const bd = store.businessDate;
  const orders = list('orders').filter((o) => o.status === 'open' || o.status === 'billed').sort((a, b) => a.openedAt - b.openedAt);
  const bills = list('bills').filter((b) => b.businessDate === bd).sort((a, b) => b.seq - a.seq);
  const dues = list('customers').filter((c) => c.duePaise > 0).sort((a, b) => b.duePaise - a.duePaise);
  const now = Date.now();
  /** @param {string} id @param {string} label */
  const tabBtn = (id, label) => h('button' + (tab === id ? '.on' : ''), { onclick: () => { tab = id; scheduleRender(); } }, label);
  return h('main.panel',
    h('div.tabs', tabBtn('open', `Open orders (${orders.length})`), tabBtn('bills', `Bills today (${bills.length})`), can('customers.due') ? tabBtn('dues', `Dues (${dues.length})`) : null),
    tab === 'open' ? h('table.list', h('tr', h('th', 'Order'), h('th', 'Where'), h('th', 'Age'), h('th', 'Amount'), h('th', 'Status')),
      orders.map((o) => {
        const t = byId('dining_tables', o.tableId);
        return h('tr.click', { onclick: () => go(can('bill') ? 'bill/' + o.id : 'order/' + o.id) },
          h('td', '#' + o.no), h('td', o.type === 'dine' ? 'Table ' + (t?.name ?? '') : o.type + (o.platform ? ' · ' + o.platform : '')),
          h('td', ago(now - o.openedAt)),
          h('td', money(linesOf(o.id).filter((l) => !l.voided).reduce((a, l) => a + lineTotal(l), 0))),
          h('td', h('span.tag.' + o.status, o.status)));
      })) : null,
    tab === 'bills' ? h('table.list', h('tr', h('th', 'Bill no'), h('th', 'Time'), h('th', 'Total'), h('th', 'Status')),
      bills.map((b) => h('tr.click', { onclick: () => go('bill/' + b.orderId) },
        h('td', b.no), h('td', new Date(b.createdAt).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })),
        h('td', money(b.totalPaise)), h('td', h('span.tag.' + b.status, b.status))))) : null,
    tab === 'dues' ? h('table.list', h('tr', h('th', 'Customer'), h('th', 'Phone'), h('th', 'Due'), h('th', '')),
      dues.map((c) => h('tr', h('td', c.name || '—'), h('td', c.phone), h('td', money(c.duePaise)),
        h('td', h('button.small', {
          onclick: async () => {
            const amt = await ask(`Receive from ${c.name || c.phone} (due ${money(c.duePaise)})`, { value: (c.duePaise / 100).toFixed(2), type: 'number' });
            if (!amt) return;
            const mode = await ask('Mode', { chips: ['cash', 'upi', 'card'], value: 'cash' });
            if (mode) tryRun('due.receive', { customerId: c.id, amount: toPaise(amt), mode }, 'Received');
          },
        }, 'Receive'))))) : null);
}
