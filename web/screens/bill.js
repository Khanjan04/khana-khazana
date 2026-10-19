// @ts-check
// Billing (Day 15) + settlement (Day 16), legacy parity: discount % / ₹ with quick chips and the customer
// tag discount, complimentary, opt-in service charge, tax breakdown, "ask customer details" before print,
// unsent-items warning, then Settle: Cash (customer paid / return), Card, UPI, Due (name + mobile),
// Other (type), Part payment, tip, settlement amount (waive-off), equal split.
// Totals shown before printing are a preview made with the same module the host bills with.
import { h } from '../h.js';
import { byId, linesOf, lineTotal, list, store, orderTotals, orderRef, typeLabel } from '../store.js';
import { can } from '../session.js';
import { money, toPaise, run, tryRun, toast, ask, modal } from '../ui.js';
import { printBill, billHtml, printMode } from '../print.js';
import { go, scheduleRender } from '../app.js';
import { billTotals, totalsToPaise } from '../../server/domain/totals.js';

const MODE_LABEL = /** @type {Record<string, string>} */ ({ cash: 'Cash', card: 'Card', upi: 'UPI', due: 'Due', other: 'Other', part: 'Part' });

/** per-order form state */
const forms = new Map();

/** @param {any} o */
function form(o) {
  if (!forms.has(o.id)) {
    const tag = (store.settings.custTags ?? []).find((/** @type {any} */ t) => t.id === o.custTag && t.disc > 0);
    forms.set(o.id, {
      discType: tag ? 'pct' : '', discValue: tag ? String(tag.disc) : '', discReason: tag ? `${tag.name} discount` : '', comp: false, compReason: '', service: false,
      mode: 'cash', paid: '', otherType: '', pays: [{ mode: 'cash', amount: '' }, { mode: 'upi', amount: '' }],
      tip: '', settleAmt: '', waiveReason: '', name: o.custName ?? '', phone: o.custPhone ?? '', edit: false, asked: false,
    });
  }
  return forms.get(o.id);
}

/** Preview of the bill with the chosen options (same calcTotals as the host). @param {any} o @param {any} f */
function preview(o, f) {
  const lines = linesOf(o.id);
  const legacy = {
    lines: lines.map((l) => ({ price: l.unitPaise / 100, qty: l.qty, void: !!l.voided, extras: (l.extras || []).map((/** @type {any} */ e) => ({ price: e.pricePaise / 100, qty: e.qty ?? 1 })) })),
    delivery: (o.deliveryPaise ?? 0) / 100,
    comp: !!f.comp,
    discount: f.discType && parseFloat(f.discValue) > 0 ? { mode: /** @type {'pct'|'fix'} */ (f.discType === 'pct' ? 'pct' : 'fix'), value: f.discType === 'pct' ? parseFloat(f.discValue) : toPaise(f.discValue) / 100 } : null,
  };
  return totalsToPaise(billTotals(legacy, /** @type {any} */ ({ taxes: [], ...store.settings, serviceChargePct: f.service ? store.settings.serviceChargePct : 0 })));
}

/** @param {import('../app.js').Route} r */
export function render(r) {
  const o = byId('orders', r.args[0]);
  if (!o) return h('div.panel', 'Order not found.', h('a', { href: '#/bills' }, ' Back'));
  const bills = list('bills').filter((b) => b.orderId === o.id).sort((a, b) => b.createdAt - a.createdAt);
  const bill = bills.find((b) => b.status === 'open') ?? bills.find((b) => b.status === 'settled');
  const f = form(o);
  const lines = linesOf(o.id).filter((l) => !l.voided);
  const unsent = lines.filter((l) => !l.kotId);

  const head = h('div.order-head', h('h2', (o.type === 'dine' ? 'Table ' : '') + orderRef(o)), h('span.tag', typeLabel(o)), h('span.tag.' + o.status, o.status === 'billed' ? 'bill printed' : o.status), h('span.grow'),
    o.status !== 'closed' && o.status !== 'cancelled' ? h('button.small', { onclick: () => go('order/' + o.id) }, '← Order') : null);

  if (!bill || o.status === 'open' || (f.edit && bill.status === 'open')) {
    const T = preview(o, f);
    const doPrint = async () => {
      if (unsent.length && can('kot')) {
        const choice = await ask(`${unsent.length} item(s) are saved but not sent to the kitchen.`, { chips: ['Send KOT & finish', 'Print bill anyway'] });
        if (!choice) return;
        if (choice === 'Send KOT & finish' && !(await tryRun('kot.create', { orderId: o.id }, 'KOT sent'))) return;
      }
      if (store.settings.askCustomer && !o.custPhone && !o.custName && !f.asked) {
        f.asked = true;
        const ok = await customerPrompt(o);
        if (ok === null) return;
      }
      /** @type {any} */
      const payload = { orderId: o.id, serviceCharge: f.service === true, print: printMode() };
      if (f.comp) { payload.complimentary = true; payload.complimentaryReason = f.compReason || 'Complimentary'; }
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
    /** @param {string} t @param {string} v */
    const setDisc = (t, v) => { f.discType = t; f.discValue = v; f.comp = false; scheduleRender(); };
    return h('main.panel.narrow',
      head,
      o.custName || o.custPhone ? h('p.small', '👤 ', o.custName || '', ' ', o.custPhone || '') : null,
      h('div.lines', lines.map((l) => h('div.line', h('span.qty', h('b', l.qty)),
        h('span.lname', l.name, l.variant ? ` (${l.variant})` : '', (l.extras || []).length ? h('small', ' ' + l.extras.map((/** @type {any} */ e) => `+ ${e.name} × ${e.qty ?? 1}`).join(' ')) : null, l.kotId ? null : h('small.warn', ' (not sent)')),
        h('span.amt', money(lineTotal(l)))))),
      h('fieldset',
        h('legend', 'Discount'),
        h('div.chips',
          h('button.chip' + (!f.discType && !f.comp ? '.on' : ''), { onclick: () => setDisc('', '') }, 'None'),
          ['5', '10', '15', '20'].map((v) => h('button.chip' + (f.discType === 'pct' && f.discValue === v ? '.on' : ''), { onclick: () => setDisc('pct', v) }, v + '%')),
          (store.settings.custTags ?? []).filter((/** @type {any} */ t) => t.disc > 0).map((/** @type {any} */ t) => h('button.chip', { onclick: () => { f.discReason = `${t.name} discount`; setDisc('pct', String(t.disc)); } }, `${t.name} ${t.disc}%`))),
        h('div.row',
          h('select', { onchange: (/** @type {any} */ e) => { f.discType = e.target.value; scheduleRender(); } },
            h('option', { value: '', selected: !f.discType }, 'No discount'), h('option', { value: 'pct', selected: f.discType === 'pct' }, 'Percent %'), h('option', { value: 'fixed', selected: f.discType === 'fixed' }, 'Amount ₹')),
          f.discType ? h('input#disc-val', { inputmode: 'decimal', placeholder: f.discType === 'pct' ? '%' : '₹', value: f.discValue, oninput: (/** @type {any} */ e) => { f.discValue = e.target.value; scheduleRender(); } }) : null,
          f.discType ? h('input#disc-reason', { placeholder: 'Reason (optional)', value: f.discReason, oninput: (/** @type {any} */ e) => { f.discReason = e.target.value; } }) : null),
        h('label.radio', h('input', { type: 'checkbox', checked: f.comp, onchange: (/** @type {any} */ e) => { f.comp = e.target.checked; if (f.comp) f.discType = ''; scheduleRender(); } }), 'Complimentary (whole bill free)'),
        f.comp ? h('input#comp-reason', { placeholder: 'Reason', value: f.compReason, oninput: (/** @type {any} */ e) => { f.compReason = e.target.value; } }) : null,
        !can('discount') && (f.discType || f.comp) ? h('p.small.warn', 'Needs Manager / Owner approval (PIN) when you print.') : null),
      store.settings.serviceChargePct > 0 ? h('fieldset',
        h('legend', 'Service charge'),
        h('label.radio', h('input', { type: 'checkbox', checked: f.service, onchange: (/** @type {any} */ e) => { f.service = e.target.checked; scheduleRender(); } }),
          `Add ${store.settings.serviceChargePct}% service charge — only if the customer agrees`),
        h('p.small.muted', 'Off by default (CCPA guidelines). Shown as a separate line.')) : null,
      totalsBox(T),
      can('bill') ? h('button.primary.big.wide', { onclick: doPrint }, o.status === 'billed' ? 'Re-calculate & print bill' : 'Print Bill') : h('p.muted', 'No billing right.'));
  }

  // ---- bill printed: preview, reprint, void, settle ----
  const settled = bill.status === 'settled';
  return h('main.bill-screen',
    h('section.panel', head,
      h('div.preview', billHtml(bill.id)),
      h('div.row',
        can('bill.reprint') ? h('button', { onclick: async () => { const r2 = await tryRun('bill.reprint', { billId: bill.id, print: printMode() }); if (r2 && printMode() !== 'host-lan') printBill(bill.id); } }, '🖨 Reprint') : null,
        !settled && can('bill') ? h('button', { onclick: () => { f.edit = true; scheduleRender(); } }, 'Change discount') : null,
        !settled && can('bill') ? h('button.danger', {
          onclick: async () => {
            const reason = await ask(`Void bill ${bill.no}? The order opens again for changes.`, { chips: ['Wrong items', 'Customer added items', 'Wrong discount'] });
            if (reason) tryRun('bill.void', { billId: bill.id, reason }, 'Bill voided');
          },
        }, 'Void bill') : null)),
    settled ? h('section.panel', h('p.okc', `Settled ${bill.settledAt ? new Date(bill.settledAt).toLocaleTimeString('en-IN', { hour12: false }) : ''}`),
      list('bill_payments').filter((p) => p.billId === bill.id).map((p) => h('div.pr', h('span', (MODE_LABEL[p.mode] ?? p.mode) + (p.otherType ? ` (${p.otherType})` : '')), h('span', money(p.amountPaise)))),
      bill.changePaise ? h('div.pr', h('span', 'Cash returned'), h('span', money(bill.changePaise))) : null,
      h('button.wide', { onclick: () => go(o.type === 'dine' ? 'tables' : 'orders/' + o.type) }, 'Done'))
      : can('bill') ? settlePanel(o, bill, f) : null);
}

/** @param {any} T */
function totalsBox(T) {
  /** @param {string} l @param {string} v @param {string} [cls] */
  const row = (l, v, cls = '') => h('div.pr' + cls, h('span', l), h('span', v));
  return h('div.sumd',
    row('Sub Total', money(T.subtotal)),
    T.comp ? row('Complimentary', '−' + money(T.compValue)) : null,
    T.discount ? row('Discount', '−' + money(T.discount)) : null,
    T.delivery ? row('Delivery Charge', money(T.delivery)) : null,
    T.taxes.map((/** @type {any} */ t) => row(`${t.name} @ ${t.rate}%`, money(t.amountPaise))),
    T.serviceCharge ? row('Service charge (optional)', money(T.serviceCharge)) : null,
    T.roundOff ? row('Round off', (T.roundOff > 0 ? '+' : '') + (T.roundOff / 100).toFixed(2), '.small') : null,
    h('div.total', h('span', 'Grand Total'), h('b', money(T.total))));
}

/** Legacy "customer details" popup before printing. Resolves null on cancel. @param {any} o */
function customerPrompt(o) {
  return new Promise((resolve) => {
    const f = { phone: '', name: '' };
    let done = false;
    const finish = (/** @type {any} */ v) => { if (!done) { done = true; resolve(v); } };
    modal('Customer details', (close) => [
      h('p.small.muted', 'Type the customer name and mobile, or tap Skip.'),
      h('input', {
        placeholder: 'Mobile number', inputmode: 'tel',
        oninput: (/** @type {any} */ e) => {
          f.phone = e.target.value;
          const k = f.phone.replace(/\D/g, '');
          const c = k.length >= 10 ? list('customers').find((x) => x.phone === k) : null;
          if (c && !f.name) { f.name = c.name; const n = /** @type {HTMLInputElement} */ (document.getElementById('cp-name')); if (n) n.value = c.name; }
        },
      }),
      h('input#cp-name', { placeholder: 'Customer name', oninput: (/** @type {any} */ e) => { f.name = e.target.value; } }),
      h('div.row.end',
        h('button.ghost', { onclick: () => { finish(false); close(); } }, 'Skip'),
        h('button.primary', { onclick: async () => { if (await tryRun('order.customer', { orderId: o.id, name: f.name, phone: f.phone })) { finish(true); close(); } } }, 'Save & print')),
    ], { onClose: () => finish(null) });
  });
}

/** @param {any} o @param {any} bill @param {any} f */
function settlePanel(o, bill, f) {
  const total = bill.totalPaise;
  const tip = toPaise(f.tip);
  const settleAmt = f.settleAmt === '' ? total : toPaise(f.settleAmt);
  const waive = Math.max(0, total - settleAmt);
  const need = total + tip - waive;
  const paid = toPaise(f.paid);
  const others = /** @type {string[]} */ (store.settings.otherTypes ?? []);

  /** @returns {{mode: string, amount: number, otherType?: string}[]} */
  const payments = () => (f.mode === 'part'
    ? f.pays.filter((/** @type {any} */ p) => toPaise(p.amount) > 0).map((/** @type {any} */ p) => ({ mode: p.mode, amount: toPaise(p.amount), ...(p.mode === 'other' ? { otherType: p.otherType || others[0] } : {}) }))
    : [{ mode: f.mode, amount: need, ...(f.mode === 'other' ? { otherType: f.otherType || others[0] } : {}) }]);
  const sum = payments().reduce((a, p) => a + p.amount, 0);
  const cashPart = payments().filter((p) => p.mode === 'cash').reduce((a, p) => a + p.amount, 0);
  const anyDue = payments().some((p) => p.mode === 'due');

  /** @param {boolean} print */
  const settle = async (print) => {
    if (sum !== need) return toast(`Payments ${money(sum)} are not equal to ${money(need)}`, 'err');
    /** @type {any} */
    const payload = { billId: bill.id, payments: payments(), tip, waive };
    if (waive) payload.waiveReason = f.waiveReason || 'Settlement amount';
    if (f.paid !== '' && cashPart) {
      if (paid < cashPart) return toast(`Customer paid ${money(cashPart - paid)} less.`, 'err');
      payload.tendered = paid;
    }
    if (anyDue) {
      const ph = f.phone.replace(/\D/g, '');
      if (!f.name.trim() || ph.length < 10) return toast("For Due, type the customer's name and 10-digit mobile number.", 'err');
      payload.customer = { name: f.name.trim(), phone: f.phone };
    }
    const res = await run('bill.settle', payload).catch(() => null);
    if (!res) return;
    toast(res.changePaise ? `Settled. Return ${money(res.changePaise)} to the customer.` : 'Settled', 'ok', res.changePaise ? 8000 : 3000);
    if (print) printBill(bill.id);
    forms.delete(o.id);
    go(o.type === 'dine' ? 'tables' : 'orders/' + o.type);
  };

  return h('section.panel.settle',
    h('h3', 'Settle bill ', bill.no),
    h('div.total', h('span', 'Bill total'), h('b', money(total))),
    h('div.chips.modes', ['cash', 'card', 'upi', 'due', 'other', 'part'].filter((m) => m !== 'due' || can('customers.due'))
      .map((m) => h('button.chip' + (f.mode === m ? '.on' : ''), { onclick: () => { f.mode = m; scheduleRender(); } }, MODE_LABEL[m]))),
    f.mode === 'cash' ? h('div',
      h('label', 'Customer paid ₹', h('input#paid', { inputmode: 'decimal', value: f.paid, placeholder: (need / 100).toFixed(0), oninput: (/** @type {any} */ e) => { f.paid = e.target.value; scheduleRender(); } })),
      h('div.chips', [...new Set([Math.ceil(need / 10000) * 100, Math.ceil(need / 50000) * 500, Math.ceil(need / 100000) * 1000, 2000])].filter((v) => v * 100 >= need).slice(0, 4)
        .map((v) => h('button.chip', { onclick: () => { f.paid = String(v); scheduleRender(); } }, '₹' + v))),
      f.paid !== '' ? h('div.pr' + (paid >= need ? '.okc' : '.bad'), h('span', paid >= need ? 'Return to customer' : 'Customer paid less by'), h('b', money(Math.abs(paid - need)))) : null) : null,
    f.mode === 'other' && others.length ? h('label', 'Other type', h('select', { onchange: (/** @type {any} */ e) => { f.otherType = e.target.value; } }, others.map((t) => h('option', { selected: t === f.otherType }, t)))) : null,
    f.mode === 'part' ? h('div',
      f.pays.map((/** @type {any} */ p, /** @type {number} */ i) => h('div.row',
        h('select', { onchange: (/** @type {any} */ e) => { p.mode = e.target.value; scheduleRender(); } }, ['cash', 'card', 'upi', 'due', 'other'].map((m) => h('option', { value: m, selected: p.mode === m }, MODE_LABEL[m]))),
        p.mode === 'other' && others.length ? h('select', { onchange: (/** @type {any} */ e) => { p.otherType = e.target.value; } }, others.map((t) => h('option', { selected: t === p.otherType }, t))) : null,
        h('input', { id: 'pay-' + i, inputmode: 'decimal', placeholder: '₹', value: p.amount, oninput: (/** @type {any} */ e) => { p.amount = e.target.value; scheduleRender(); } }),
        f.pays.length > 1 ? h('button.small.ghost', { onclick: () => { f.pays.splice(i, 1); scheduleRender(); } }, '✕') : null)),
      h('div.row',
        h('button.small', { onclick: () => { f.pays.push({ mode: 'cash', amount: '' }); scheduleRender(); } }, '+ Add payment'),
        h('button.small', { onclick: () => { const rest = need - f.pays.slice(0, -1).reduce((/** @type {number} */ a, /** @type {any} */ p) => a + toPaise(p.amount), 0); f.pays[f.pays.length - 1].amount = (Math.max(0, rest) / 100).toFixed(2); scheduleRender(); } }, 'Fill rest'),
        h('button.small', { onclick: () => splitModal(bill, f) }, 'Split equally'))) : null,
    anyDue ? h('div.due',
      h('p.small', 'Due: the amount is written in the customer’s account.'),
      h('input#due-name', { placeholder: 'Customer name', value: f.name, oninput: (/** @type {any} */ e) => { f.name = e.target.value; } }),
      h('input#due-phone', { placeholder: 'Mobile number (10 digits)', inputmode: 'tel', value: f.phone, oninput: (/** @type {any} */ e) => { f.phone = e.target.value; } })) : null,
    h('details', h('summary', 'Tip / settlement amount'),
      h('div.row',
        h('label', 'Tip ₹', h('input#tip', { inputmode: 'decimal', value: f.tip, oninput: (/** @type {any} */ e) => { f.tip = e.target.value; scheduleRender(); } })),
        !anyDue ? h('label', 'Settlement amount ₹', h('input#settle-amt', { inputmode: 'decimal', placeholder: (total / 100).toFixed(2), value: f.settleAmt, oninput: (/** @type {any} */ e) => { f.settleAmt = e.target.value; scheduleRender(); } })) : null),
      waive ? h('div', h('p.small.warn', `Customer pays ${money(waive)} less (waive-off). Needs Manager / Owner approval.`),
        h('input#waive-reason', { placeholder: 'Reason', value: f.waiveReason, oninput: (/** @type {any} */ e) => { f.waiveReason = e.target.value; } })) : null),
    h('div.total' + (sum === need ? '.okc' : '.bad'), h('span', `To collect ${money(need)}`), h('b', f.mode === 'part' ? `Entered ${money(sum)}` : '')),
    h('div.row',
      h('button.primary.big.grow', { onclick: () => settle(false), disabled: sum !== need }, 'Settle & Save'),
      h('button.big.grow', { onclick: () => settle(true), disabled: sum !== need }, 'Settle & Print')));
}

/** @param {any} bill @param {any} f */
async function splitModal(bill, f) {
  const n = await ask('Split equally between how many people?', { value: '2', type: 'number', chips: ['2', '3', '4', '5', '6'] });
  const ways = parseInt(n ?? '', 10);
  if (!(ways >= 2)) return;
  const res = await tryRun('bill.split', { billId: bill.id, ways });
  if (!res) return;
  f.mode = 'part';
  f.pays = res.parts.map((/** @type {number} */ p) => ({ mode: 'cash', amount: (p / 100).toFixed(2) }));
  modal('Split equally', () => h('div', res.parts.map((/** @type {number} */ p, /** @type {number} */ i) => h('div.pr', h('span', `Person ${i + 1}`), h('b', money(p)))),
    h('p.small.muted', 'Each share is filled in below; change the payment mode for each person.')));
  scheduleRender();
}
