// @ts-check
// Billing (Day 15) + settlement (Day 16). Totals are computed ONLY on the host
// (server/domain/totals.js); this screen just sends options and shows the snapshot.
import { h } from '../h.js';
import { byId, linesOf, lineTotal, list } from '../store.js';
import { can } from '../session.js';
import { money, toPaise, run, tryRun, toast, ask, modal } from '../ui.js';
import { printBill, billHtml, printMode } from '../print.js';
import { go, scheduleRender } from '../app.js';
import { PAY_MODES } from './shared.js';

/** per-order form state */
const forms = new Map();

/** @param {string} orderId */
function form(orderId) {
  if (!forms.has(orderId)) forms.set(orderId, { discType: '', discValue: '', discReason: '', comp: false, compReason: '', service: false, pays: [{ mode: 'cash', amount: '' }], tip: '', waive: '', waiveReason: '', phone: '', edit: false });
  return forms.get(orderId);
}

/** @param {import('../app.js').Route} r */
export function render(r) {
  const o = byId('orders', r.args[0]);
  if (!o) return h('div.panel', 'Order not found.', h('a', { href: '#/bills' }, ' Back'));
  const bills = list('bills').filter((b) => b.orderId === o.id).sort((a, b) => b.createdAt - a.createdAt);
  const bill = bills.find((b) => b.status === 'open') ?? bills.find((b) => b.status === 'settled');
  const f = form(o.id);
  const t = byId('dining_tables', o.tableId);
  const lines = linesOf(o.id).filter((l) => !l.voided);
  const where = o.type === 'dine' ? `Table ${t?.name ?? ''}` : o.type === 'delivery' ? `Delivery #${o.no}` : `Takeaway #${o.no}`;

  const head = h('div.order-head', h('h2', where), h('span.tag.' + o.status, o.status), h('span.grow'),
    o.status === 'open' ? h('button.small', { onclick: () => go('order/' + o.id) }, 'Edit order') : null);

  if (!bill || o.status === 'open' || (f.edit && bill.status === 'open')) {
    // ---- bill options ----
    const doPrint = async () => {
      /** @type {any} */
      const payload = { orderId: o.id, serviceCharge: f.service === true, print: printMode() };
      if (f.comp) payload.complimentary = f.compReason || 'Complimentary';
      else if (f.discType && parseFloat(f.discValue) > 0) {
        // legacy calcTotals takes rupees; fixed discounts are normalised to whole paise
        const value = f.discType === 'pct' ? parseFloat(f.discValue) : toPaise(f.discValue) / 100;
        payload.discount = { type: f.discType, value, reason: f.discReason || 'Discount' };
      }
      const res = await run('bill.print', payload).catch(() => null);
      if (!res) return;
      f.edit = false;
      toast(`Bill ${res.no}: ${money(res.totalPaise)}`, 'ok');
      if (printMode() !== 'host-lan') setTimeout(() => printBill(res.billId), 300);
    };
    return h('main.panel.narrow',
      head,
      h('div.lines', lines.map((l) => h('div.line', h('span.qty', h('b', l.qty)), h('span.lname', l.name, l.variant ? ` (${l.variant})` : ''), h('span.amt', money(lineTotal(l)))))),
      h('div.total', h('span', 'Subtotal (before tax)'), h('b', money(lines.reduce((a, l) => a + lineTotal(l), 0)))),
      h('fieldset',
        h('legend', 'Discount'),
        h('div.row',
          h('select', { onchange: (/** @type {any} */ e) => { f.discType = e.target.value; scheduleRender(); } },
            h('option', { value: '', selected: !f.discType }, 'None'), h('option', { value: 'pct', selected: f.discType === 'pct' }, '%'), h('option', { value: 'fixed', selected: f.discType === 'fixed' }, '₹ fixed')),
          f.discType ? h('input#disc-val', { inputmode: 'decimal', placeholder: f.discType === 'pct' ? '%' : '₹', value: f.discValue, oninput: (/** @type {any} */ e) => { f.discValue = e.target.value; } }) : null,
          f.discType ? h('input#disc-reason', { placeholder: 'Reason', value: f.discReason, oninput: (/** @type {any} */ e) => { f.discReason = e.target.value; } }) : null),
        h('label.radio', h('input', { type: 'checkbox', checked: f.comp, onchange: (/** @type {any} */ e) => { f.comp = e.target.checked; scheduleRender(); } }), 'Complimentary (whole bill)'),
        f.comp ? h('input#comp-reason', { placeholder: 'Reason', value: f.compReason, oninput: (/** @type {any} */ e) => { f.compReason = e.target.value; } }) : null,
        !can('discount') && (f.discType || f.comp) ? h('p.small.warn', 'Needs manager approval (PIN) when you print.') : null),
      h('fieldset',
        h('legend', 'Service charge'),
        h('label.radio', h('input', { type: 'checkbox', checked: f.service, onchange: (/** @type {any} */ e) => { f.service = e.target.checked; } }),
          'Add optional service charge — only if the customer agrees'),
        h('p.small.muted', 'Off by default. Shown as a separate line, not added before GST (CCPA guidelines).')),
      can('bill') ? h('button.primary.big', { onclick: doPrint }, o.status === 'billed' ? 'Re-calculate & print' : 'Print bill') : h('p.muted', 'No billing right.'));
  }

  // ---- bill printed: preview, reprint, void, settle ----
  const due = bill.totalPaise;
  const tip = toPaise(f.tip), waive = toPaise(f.waive);
  const sum = f.pays.reduce((/** @type {number} */ a, /** @type {any} */ p) => a + toPaise(p.amount), 0);
  const need = due + tip - waive;
  const settle = async () => {
    const payments = f.pays.filter((/** @type {any} */ p) => toPaise(p.amount) > 0).map((/** @type {any} */ p) => ({ mode: p.mode, amount: toPaise(p.amount), ...(p.mode === 'due' ? { phone: f.phone || undefined } : {}) }));
    if (sum !== need) return toast(`Payments ${money(sum)} ≠ to collect ${money(need)}`, 'err');
    const res = await run('bill.settle', { billId: bill.id, payments, tip, waive, waiveReason: f.waiveReason || undefined }, 'Settled').catch(() => null);
    if (res) { forms.delete(o.id); go(o.type === 'dine' ? 'tables' : 'bills'); }
  };
  return h('main.bill-screen',
    h('section.panel', head,
      h('div.preview', billHtml(bill.id)),
      h('div.row',
        can('bill.reprint') ? h('button', { onclick: async () => { const r2 = await tryRun('bill.reprint', { billId: bill.id, print: printMode() }); if (r2 && printMode() !== 'host-lan') printBill(bill.id); } }, '🖨 Reprint') : null,
        bill.status === 'open' && can('bill') ? h('button', { onclick: () => { f.edit = true; scheduleRender(); } }, 'Change discount / service') : null,
        bill.status === 'open' && can('bill') ? h('button.danger', {
          onclick: async () => {
            const reason = await ask(`Void bill ${bill.no}? The order re-opens for changes.`, { chips: ['Wrong items', 'Customer added items', 'Wrong discount'] });
            if (reason) tryRun('bill.void', { billId: bill.id, reason }, 'Bill voided');
          },
        }, 'Void bill') : null)),
    bill.status === 'open' ? h('section.panel',
      h('h3', 'Settle'),
      h('div.total', h('span', 'Bill total'), h('b', money(due))),
      f.pays.map((/** @type {any} */ p, /** @type {number} */ i) => h('div.row',
        h('select', { onchange: (/** @type {any} */ e) => { p.mode = e.target.value; scheduleRender(); } }, PAY_MODES.map((m) => h('option', { value: m, selected: p.mode === m }, m.toUpperCase()))),
        h('input', { id: 'pay-' + i, inputmode: 'decimal', placeholder: '₹', value: p.amount, oninput: (/** @type {any} */ e) => { p.amount = e.target.value; scheduleRender(); } }),
        f.pays.length > 1 ? h('button.small.ghost', { onclick: () => { f.pays.splice(i, 1); scheduleRender(); } }, '✕') : null)),
      f.pays.some((/** @type {any} */ p) => p.mode === 'due') ? h('input#due-phone', { placeholder: 'Customer phone for due', inputmode: 'tel', value: f.phone, oninput: (/** @type {any} */ e) => { f.phone = e.target.value; } }) : null,
      h('div.row',
        h('button.small', { onclick: () => { f.pays.push({ mode: 'upi', amount: '' }); scheduleRender(); } }, '+ Split payment'),
        h('button.small', { onclick: () => { const rest = need - f.pays.slice(0, -1).reduce((/** @type {number} */ a, /** @type {any} */ p) => a + toPaise(p.amount), 0); f.pays[f.pays.length - 1].amount = (rest / 100).toFixed(2); scheduleRender(); } }, 'Fill rest'),
        h('button.small', { onclick: () => splitModal(bill, f) }, 'Equal split')),
      h('div.row',
        h('label', 'Tip ₹', h('input#tip', { inputmode: 'decimal', value: f.tip, oninput: (/** @type {any} */ e) => { f.tip = e.target.value; scheduleRender(); } })),
        h('label', 'Waive-off ₹', h('input#waive', { inputmode: 'decimal', value: f.waive, oninput: (/** @type {any} */ e) => { f.waive = e.target.value; scheduleRender(); } }))),
      waive ? h('input#waive-reason', { placeholder: 'Waive-off reason', value: f.waiveReason, oninput: (/** @type {any} */ e) => { f.waiveReason = e.target.value; } }) : null,
      h('div.total' + (sum === need ? '.okc' : '.bad'), h('span', `Collect ${money(need)}`), h('b', `Entered ${money(sum)}`)),
      h('button.primary.big', { onclick: settle, disabled: sum !== need }, 'Settle')) : h('section.panel', h('p.okc', `Settled ${bill.settledAt ? new Date(bill.settledAt).toLocaleTimeString('en-IN', { hour12: false }) : ''}`),
      list('bill_payments').filter((p) => p.billId === bill.id).map((p) => h('div.pr', h('span', p.mode.toUpperCase()), h('span', money(p.amountPaise))))));
}

/** @param {any} bill @param {any} f */
async function splitModal(bill, f) {
  const n = await ask('Split equally between how many?', { value: '2', type: 'number' });
  const ways = parseInt(n ?? '', 10);
  if (!(ways >= 2)) return;
  const res = await tryRun('bill.split', { billId: bill.id, ways });
  if (!res) return;
  f.pays = res.parts.map((/** @type {number} */ p) => ({ mode: 'cash', amount: (p / 100).toFixed(2) }));
  modal('Equal split', () => h('div', res.parts.map((/** @type {number} */ p, /** @type {number} */ i) => h('div.pr', h('span', `Person ${i + 1}`), h('b', money(p))))));
  scheduleRender();
}
