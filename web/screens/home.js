// @ts-check
// Home (legacy): "Namaste" + Dining / Delivery-App / Pickup with running counts, then shortcuts.
import { h } from '../h.js';
import { list } from '../store.js';
import { can, me } from '../session.js';
import { go } from '../app.js';

export function render() {
  const open = list('orders').filter((o) => o.status === 'open' || o.status === 'billed');
  const cnt = (/** @type {string} */ t) => open.filter((o) => o.type === t).length;
  const held = open.filter((o) => o.held).length;
  const kots = list('kots').filter((k) => ['new', 'accepted', 'preparing', 'ready'].includes(k.status)).length;
  const ok = can('order');
  /** @param {string} cls @param {string} icon @param {string} label @param {string} sub @param {() => void} fn */
  const big = (cls, icon, label, sub, fn) => h('button.bt.' + cls + (ok ? '' : '.locked'), { onclick: ok ? fn : undefined, disabled: !ok },
    h('span.badge', icon), h('div', h('b', label), h('span', sub)));
  /** @param {boolean} show @param {string} icon @param {string} label @param {string} sub @param {string} to */
  const mini = (show, icon, label, sub, to) => (show ? h('button.mini', { onclick: () => go(to) }, h('span.mi', icon), h('div', label, h('small', sub))) : null);
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return h('main.home',
    h('h1', `Namaste, ${me.user?.name ?? ''}`),
    h('p.muted', 'Choose where the order is coming from.'),
    h('div.big3',
      big('dine', '🍽', 'Dining', plural(cnt('dine'), 'table') + ' running', () => go('tables')),
      big('del', '🛵', 'Delivery-App', plural(cnt('delivery'), 'open order'), () => go('orders/delivery')),
      big('pk', '🛍', 'Pickup', plural(cnt('takeaway'), 'open order'), () => go('orders/takeaway'))),
    h('div.row2',
      mini(can('order'), '⏸', 'Held orders', `${held} on hold`, 'orders/held'),
      mini(can('kitchen'), '👨‍🍳', 'Kitchen KOTs', `${kots} running`, 'kds'),
      mini(can('history') || can('bill'), '🧾', 'Bill history', 'Reprint & daily total', 'bills'),
      mini(can('reports'), '📊', 'Reports', 'Day-end tally, guests, tables, items', 'reports'),
      mini(['users', 'layout', 'menu', 'settings', 'device.manage'].some(can), '⚙', 'Admin', 'Users, tables, menu, settings', 'admin')));
}
