// @ts-check
// Table view with status colours and timers (Day 12) + takeaway/delivery queue.
import { h } from '../h.js';
import { list, store, activeOrderForTable, kotsOf, linesOf, lineTotal } from '../store.js';
import { can } from '../session.js';
import { money, ago, tryRun } from '../ui.js';
import { go, scheduleRender } from '../app.js';

let section = 'all';

/** Table status class for colour coding. @param {any} o */
export function orderState(o) {
  if (!o) return 'free';
  if (o.status === 'billed') return 'billed';
  if (o.held) return 'held';
  const ks = kotsOf(o.id).map((k) => k.status);
  if (ks.includes('ready')) return 'ready';
  if (ks.some((s) => s === 'new' || s === 'accepted' || s === 'preparing')) return 'cooking';
  return ks.length ? 'served' : 'open';
}

/** @param {any} o */
const orderAmount = (o) => linesOf(o.id).filter((l) => !l.voided).reduce((a, l) => a + lineTotal(l), 0);

export function render() {
  const sections = list('sections').sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const tables = list('dining_tables')
    .filter((t) => section === 'all' || t.sectionId === section)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const now = Date.now();
  const others = list('orders').filter((o) => o.type !== 'dine' && (o.status === 'open' || o.status === 'billed')).sort((a, b) => a.openedAt - b.openedAt);
  return h('main.tables',
    h('div.toolbar',
      h('div.tabs',
        h('button' + (section === 'all' ? '.on' : ''), { onclick: () => { section = 'all'; scheduleRender(); } }, 'All'),
        sections.map((s) => h('button' + (section === s.id ? '.on' : ''), { onclick: () => { section = s.id; scheduleRender(); } }, s.name))),
      h('span.grow'),
      h('button', { onclick: async () => { const r = await tryRun('order.open', { type: 'takeaway' }); if (r) go('order/' + r.orderId); } }, '+ Takeaway'),
      can('delivery') ? h('button', { onclick: async () => { const r = await tryRun('order.open', { type: 'delivery' }); if (r) go('order/' + r.orderId); } }, '+ Delivery') : null),
    tables.length ? null : h('p.muted', 'No tables yet. Owner/Manager: Admin → Layout.'),
    h('div.table-grid', tables.map((t) => {
      const o = activeOrderForTable(t.id);
      const st = orderState(o);
      return h('button.table.' + st, { onclick: () => go(o ? 'order/' + o.id : 'order/new?table=' + t.id) },
        h('b', t.name),
        o ? h('small', ago(now - o.openedAt) + (o.persons ? ` · ${o.persons}p` : '')) : h('small', `${t.seats} seats`),
        o ? h('small', money(orderAmount(o))) : null,
        st !== 'free' && st !== 'open' ? h('span.tag', st) : null);
    })),
    others.length ? h('h3', 'Takeaway / delivery') : null,
    h('div.table-grid', others.map((o) => h('button.table.' + orderState(o), { onclick: () => go('order/' + o.id) },
      h('b', `${o.type === 'delivery' ? '🛵' : '🥡'} #${o.no}`),
      h('small', ago(now - o.openedAt) + (o.platform ? ' · ' + o.platform : '')),
      h('small', money(orderAmount(o)))))),
    h('div.legend', ['free', 'open', 'cooking', 'ready', 'served', 'billed', 'held'].map((s) => h('span.table.mini.' + s, s))),
    h('p.small.muted', `Business date ${store.businessDate}`));
}
