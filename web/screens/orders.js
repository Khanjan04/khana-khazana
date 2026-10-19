// @ts-check
// Delivery-App / Pickup / Held order lists (legacy SCREENS.list) + "New delivery / pickup order".
import { h } from '../h.js';
import { list, orderTotals, linesOf, typeLabel, orderRef } from '../store.js';
import { can } from '../session.js';
import { money, ago, modal, tryRun } from '../ui.js';
import { go } from '../app.js';
import { PLATFORMS } from './shared.js';

/** @param {import('../app.js').Route} r */
export function render(r) {
  const type = r.args[0] === 'delivery' || r.args[0] === 'held' ? r.args[0] : 'takeaway';
  const now = Date.now();
  const os = list('orders')
    .filter((o) => (o.status === 'open' || o.status === 'billed') && (type === 'held' ? o.held : o.type === type))
    .sort((a, b) => b.openedAt - a.openedAt);
  const title = type === 'delivery' ? 'Delivery-App' : type === 'takeaway' ? 'Pickup' : 'Held orders';
  return h('main.panel',
    h('div.toolbar', h('h2', title), h('span.grow'),
      type !== 'held' && can('order') ? h('button.primary.big', { onclick: () => newOrderModal(type) }, `+ New ${type === 'delivery' ? 'delivery' : 'pickup'} order`) : null),
    h('h3', type === 'held' ? 'Orders on hold' : 'Running orders'),
    os.length ? h('div.cards', os.map((o) => {
      const st = o.held ? ['On hold', 'o'] : o.status === 'billed' ? ['Bill printed', 'g'] : linesOf(o.id).some((l) => l.kotId) ? ['KOT sent', 'y'] : ['Saved', ''];
      const who = [o.custName, o.custPhone].filter(Boolean).join(' · ');
      return h('button.ocard', { onclick: () => go('order/' + o.id) },
        h('div.h', h('span', orderRef(o)), h('span', money(orderTotals(o).total))),
        h('div.muted', typeLabel(o), o.platformRef ? ' · Ref ' + o.platformRef : ''),
        who ? h('div', who) : null,
        h('div.row.spread', h('span.muted', `${linesOf(o.id).filter((l) => !l.voided).length} item(s) · ${ago(now - o.openedAt)}`), h('span.tag.' + (st[1] || 'x'), st[0])));
    })) : h('p.muted', type === 'held' ? 'No order is on hold.' : 'No running orders. Tap the button above to start one.'));
}

/** @param {string} type 'delivery' | 'takeaway' */
export function newOrderModal(type) {
  const f = { platform: PLATFORMS[0], ref: '', name: '', phone: '', address: '' };
  modal(type === 'delivery' ? 'New delivery order' : 'New pickup order', (close) => {
    const plat = h('div.chips');
    const drawPlat = () => plat.replaceChildren(...PLATFORMS.map((p) => h('button.chip' + (f.platform === p ? '.on' : ''), { onclick: () => { f.platform = p; drawPlat(); } }, p)));
    drawPlat();
    /** @param {keyof typeof f} k @param {string} label @param {Record<string, any>} [a] */
    const inp = (k, label, a = {}) => h('label', label, h('input', { value: f[k], oninput: (/** @type {any} */ e) => { f[k] = e.target.value; }, ...a }));
    return [
      type === 'delivery' ? [h('label', 'Order from'), plat, inp('ref', 'Order number on the app (optional)')] : null,
      inp('name', 'Customer name (optional)'),
      inp('phone', 'Mobile number (optional)', { inputmode: 'tel' }),
      type === 'delivery' ? inp('address', 'Address (optional)') : null,
      h('div.row.end', h('button.ghost', { onclick: close }, 'Cancel'), h('button.primary', {
        onclick: async () => {
          const r = await tryRun('order.open', { type, platform: type === 'delivery' ? f.platform : undefined, platformRef: f.ref,
            customer: { name: f.name, phone: f.phone, address: f.address } });
          if (r) { close(); go('order/' + r.orderId); }
        },
      }, 'Start taking order')),
    ];
  });
}
