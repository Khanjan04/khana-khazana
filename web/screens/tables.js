// @ts-check
// Table View (legacy): sections, rows of table tiles with seat pips / standing tables, minutes running,
// amount, state colours (blank / running / KOT / bill printed / on hold) and quick icons.
import { h } from '../h.js';
import { list, store, activeOrderForTable, kotsOf, linesOf, orderTotals } from '../store.js';
import { can } from '../session.js';
import { money, ago, modal, tryRun, toast } from '../ui.js';
import { go, scheduleRender } from '../app.js';
import { printKot } from '../print.js';
import { kotsModal } from './order.js';

/** legacy tableState + our kitchen progress: blank | running | kot | ready | printed | hold. @param {any} o */
export function orderState(o) {
  if (!o || !linesOf(o.id).some((l) => !l.voided)) return 'blank';
  if (o.held) return 'hold';
  if (o.status === 'billed') return 'printed';
  const ks = kotsOf(o.id).map((k) => k.status);
  if (ks.includes('ready')) return 'ready';
  return ks.length ? 'kot' : 'running';
}

export function render() {
  const sections = list('sections').filter((s) => s.enabled !== 0).sort((a, b) => a.sort - b.sort);
  const now = Date.now();
  /** @param {any} t */
  const tile = (t) => {
    const o = activeOrderForTable(t.id);
    const st = orderState(o);
    const icons = [];
    if (o && st === 'printed' && can('bill')) icons.push(h('button', { title: 'Settle bill', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); go('bill/' + o.id); } }, '💾'));
    if (o && kotsOf(o.id).length) {
      if (can('kot.reprint')) icons.push(h('button', { title: 'Print KOT', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); for (const k of kotsOf(o.id)) printKot(k.id); } }, '🖨'));
      icons.push(h('button', { title: 'See all KOTs', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); kotsModal(o); } }, '👁'));
    }
    const seats = t.standing ? 'Standing' : `${t.seats} seats`;
    const body = st === 'blank'
      ? [h('div.tn', t.name), h('div.ts', seats), t.standing ? null : h('div.pips', Array.from({ length: Math.min(t.seats, 8) }, () => h('i')))]
      : [h('div.tm', ago(now - (o?.openedAt ?? now))), h('div.tn', t.name), h('div.ta', money(orderTotals(o).total)), st === 'hold' ? h('div.ts', 'On hold') : null, o?.persons ? h('div.ts', `${o.persons} guests`) : null];
    return h('div.tbl.' + st, { role: 'button', tabindex: 0, onclick: () => go(o ? 'order/' + o.id : 'order/new?table=' + t.id) },
      body, icons.length ? h('div.ico', icons) : null);
  };
  const others = list('orders').filter((o) => o.type !== 'dine' && (o.status === 'open' || o.status === 'billed')).length;
  return h('main.tables',
    h('div.tvh',
      h('h2', 'Table View'),
      h('div.legend', [['blank', 'Blank Table'], ['running', 'Running Table'], ['printed', 'Printed Table'], ['kot', 'Running KOT Table'], ['ready', 'Food ready'], ['hold', 'On hold']]
        .map(([k, l]) => h('span', h('i.' + k), l))),
      h('span.grow'),
      h('button', { onclick: () => scheduleRender(), title: 'Refresh' }, '↻'),
      h('button.rbtn', { onclick: () => go('orders/delivery') }, 'Delivery'),
      h('button.rbtn', { onclick: () => go('orders/takeaway') }, 'Pick Up'),
      can('layout') ? h('button.rbtn', { onclick: addTableModal }, '+ Add Table') : null),
    others ? h('p.small.muted', `${others} pickup/delivery order(s) running — see Delivery / Pick Up.`) : null,
    sections.length ? sections.map((sec) => {
      const tabs = list('dining_tables').filter((t) => t.sectionId === sec.id);
      if (!tabs.length) return null;
      /** @type {Map<number, any[]>} */
      const rows = new Map();
      for (const t of tabs.sort((a, b) => a.rowNo - b.rowNo || a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }))) rows.set(t.rowNo, [...(rows.get(t.rowNo) ?? []), t]);
      return h('section.sec', h('h3', sec.name), [...rows.values()].map((r) => h('div.trow', r.map(tile))));
    }) : h('p.muted.c', 'No tables yet. The Owner can build the layout in Admin › Layout.'),
    h('p.small.muted', `Business date ${store.businessDate}`));
}

function addTableModal() {
  const secs = list('sections').filter((s) => s.enabled !== 0);
  if (!secs.length) return toast('Switch a section on in Admin › Layout first.', 'err');
  const f = { sectionId: secs[0].id, name: '', seats: '4' };
  modal('Add table', (close) => [
    h('label', 'Section', h('select', { onchange: (/** @type {any} */ e) => { f.sectionId = e.target.value; } }, secs.map((s) => h('option', { value: s.id }, s.name)))),
    h('label', 'Table name', h('input', { oninput: (/** @type {any} */ e) => { f.name = e.target.value; } })),
    h('label', 'Seats', h('input', { type: 'number', min: 1, max: 30, value: f.seats, oninput: (/** @type {any} */ e) => { f.seats = e.target.value; } })),
    h('div.row.end', h('button.ghost', { onclick: close }, 'Cancel'),
      h('button.primary', { onclick: async () => { if (await tryRun('layout.table.save', { sectionId: f.sectionId, name: f.name, seats: Math.max(1, parseInt(f.seats, 10) || 4) }, 'Table added')) close(); } }, 'Add table')),
  ]);
}
