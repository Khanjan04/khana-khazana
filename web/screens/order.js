// @ts-check
// Order screen (Day 13): groups/sub-groups, search, short codes, favourites, diet icons,
// variants/extras/notes modal, kitchen-note chips, open item. Draft lines live on this
// phone until "Send KOT"; the host prices and numbers everything.
import { h } from '../h.js';
import { send, isOnline } from '../net.js';
import { list, byId, linesOf, kotsOf, lineTotal, activeOrderForTable } from '../store.js';
import { can } from '../session.js';
import { money, toast, modal, ask, tryRun, toPaise, confirmBox } from '../ui.js';
import { go, scheduleRender } from '../app.js';
import { PLATFORMS } from './shared.js';

let group = 'fav';
let subgroup = '';
let search = '';

/** @typedef {{ key: string, itemId: string | null, name: string, qty: number, variant: string, extras: string[], note: string, unitPaise: number, pricePaise?: number }} Draft */

/** @param {string} k */
const draftKey = (k) => 'pos.draft.' + k;
/** @param {string} k @returns {Draft[]} */
function loadDraft(k) {
  try { return JSON.parse(localStorage.getItem(draftKey(k)) || '[]'); } catch { return []; }
}
/** @param {string} k @param {Draft[]} d */
function saveDraft(k, d) {
  try { d.length ? localStorage.setItem(draftKey(k), JSON.stringify(d)) : localStorage.removeItem(draftKey(k)); } catch { /* ignore */ }
  scheduleRender();
}

/** @param {any} item @param {string} variant @param {string[]} extras */
function unitOf(item, variant, extras) {
  const v = item.variants.find((/** @type {any} */ x) => x.name === variant);
  return (v ? v.pricePaise : item.pricePaise) + item.extras.filter((/** @type {any} */ e) => extras.includes(e.name)).reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.pricePaise, 0);
}

/** @param {string} k @param {any} item @param {Partial<Draft>} [o] */
function addItem(k, item, o = {}) {
  const d = loadDraft(k);
  const variant = o.variant ?? '', extras = o.extras ?? [], note = o.note ?? '';
  const same = d.find((x) => x.itemId === item.id && x.variant === variant && x.note === note && x.extras.join() === extras.join());
  if (same) same.qty += o.qty ?? 1;
  else d.push({ key: Math.random().toString(36).slice(2), itemId: item.id, name: item.name, qty: o.qty ?? 1, variant, extras, note, unitPaise: unitOf(item, variant, extras) });
  saveDraft(k, d);
}

/** @param {string} k @param {any} item */
function itemModal(k, item) {
  let variant = item.variants[0]?.name ?? '';
  /** @type {string[]} */
  let extras = [];
  let note = '', qty = 1;
  const notes = list('kitchen_notes').sort((a, b) => a.sort - b.sort);
  modal(item.name, (close) => {
    const noteInp = /** @type {HTMLInputElement} */ (h('input', { placeholder: 'Note for kitchen', oninput: (/** @type {any} */ e) => { note = e.target.value; } }));
    const qtyEl = h('b', '1');
    return [
      item.variants.length ? h('div.opts', h('h4', 'Variant'), item.variants.map((/** @type {any} */ v) => h('label.radio',
        h('input', { type: 'radio', name: 'variant', checked: v.name === variant, onchange: () => { variant = v.name; } }), `${v.name} — ${money(v.pricePaise)}`))) : null,
      item.extras.length ? h('div.opts', h('h4', 'Extras'), item.extras.map((/** @type {any} */ x) => h('label.radio',
        h('input', { type: 'checkbox', onchange: (/** @type {any} */ e) => { extras = e.target.checked ? [...extras, x.name] : extras.filter((n) => n !== x.name); } }), `${x.name} + ${money(x.pricePaise)}`))) : null,
      notes.length ? h('div.chips', notes.map((n) => h('button.chip', { onclick: () => { noteInp.value = noteInp.value ? noteInp.value + ', ' + n.text : n.text; note = noteInp.value; } }, n.text))) : null,
      noteInp,
      h('div.row',
        h('button', { onclick: () => { qty = Math.max(1, qty - 1); qtyEl.textContent = String(qty); } }, '−'), qtyEl,
        h('button', { onclick: () => { qty++; qtyEl.textContent = String(qty); } }, '+'),
        h('span.grow'),
        h('button.primary', { onclick: () => { addItem(k, item, { variant, extras, note: note.trim(), qty }); close(); } }, 'Add')),
    ];
  });
}

function openItemModal(/** @type {string} */ k) {
  modal('Open item', (close) => {
    const f = { name: '', price: '', qty: '1' };
    return [
      h('input', { placeholder: 'Item name', oninput: (/** @type {any} */ e) => { f.name = e.target.value; } }),
      h('input', { placeholder: 'Price ₹', inputmode: 'decimal', oninput: (/** @type {any} */ e) => { f.price = e.target.value; } }),
      h('input', { placeholder: 'Qty', inputmode: 'numeric', value: '1', oninput: (/** @type {any} */ e) => { f.qty = e.target.value; } }),
      h('button.primary', {
        onclick: () => {
          const pricePaise = toPaise(f.price), qty = parseInt(f.qty, 10) || 1;
          if (!f.name.trim()) return toast('Name required', 'err');
          const d = loadDraft(k);
          d.push({ key: Math.random().toString(36).slice(2), itemId: null, name: f.name.trim(), qty, variant: '', extras: [], note: '', unitPaise: pricePaise, pricePaise });
          saveDraft(k, d);
          close();
        },
      }, 'Add'),
    ];
  });
}

/** Short-code entry: "12" adds item code 12; "3*12" adds 3 of it. @param {string} k @param {string} text */
function quickAdd(k, text) {
  const m = /^(?:(\d+)\s*[*x]\s*)?(\S+)$/i.exec(text.trim());
  if (!m) return false;
  const item = list('items').find((i) => i.active && i.code && i.code.toLowerCase() === m[2].toLowerCase());
  if (!item) return false;
  if (item.variants.length || item.extras.length) itemModal(k, item);
  else addItem(k, item, { qty: m[1] ? parseInt(m[1], 10) : 1 });
  return true;
}

const DIET = /** @type {Record<string, string>} */ ({ veg: 'veg', nonveg: 'nonveg', egg: 'egg' });

/** @param {import('../app.js').Route} r */
export function render(r) {
  const isNew = r.args[0] === 'new';
  const tableId = isNew ? r.query.get('table') : null;
  if (isNew && tableId) {
    const existing = activeOrderForTable(tableId);
    if (existing) { go('order/' + existing.id); return h('div'); }
  }
  const o = isNew ? null : byId('orders', r.args[0]);
  if (!isNew && !o) return h('div.panel', h('p', 'Order not found (it may still be syncing).'), h('a', { href: '#/tables' }, 'Back to tables'));
  const key = o ? o.id : 'table:' + tableId;
  const table = byId('dining_tables', o ? o.tableId : tableId);
  const draft = loadDraft(key);
  const editable = !o || o.status === 'open';
  const sent = o ? linesOf(o.id) : [];
  const kots = o ? kotsOf(o.id) : [];

  const sendKot = async () => {
    if (!draft.length) return toast('Add items first', 'info');
    const lines = draft.map((d) => (d.itemId ? { itemId: d.itemId, qty: d.qty, variant: d.variant || undefined, extras: d.extras, note: d.note } : { name: d.name, pricePaise: d.pricePaise, qty: d.qty, note: d.note }));
    const payload = o ? { orderId: o.id, lines } : { type: 'dine', tableId, lines };
    saveDraft(key, []); // the command is in the outbox now; never send the same draft twice
    if (!isOnline()) toast('Host offline — KOT queued and will be sent automatically', 'info', 6000);
    try {
      const res = await send('kot.create', payload);
      toast(`KOT ${res.kots.map((/** @type {any} */ k) => k.no).join(', ')} sent`, 'ok');
      if (!o) go('order/' + res.orderId);
    } catch (e) {
      saveDraft(key, [...draft, ...loadDraft(key)]); // put lines back
      toast(`${/** @type {any} */ (e).code}: ${/** @type {Error} */ (e).message}`, 'err');
    }
  };

  // ---- menu panel ----
  const groups = list('menu_groups').sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const items = list('items').filter((i) => i.active);
  const q = search.trim().toLowerCase();
  const shown = items.filter((i) => {
    if (q) return i.name.toLowerCase().includes(q) || (i.code && i.code.toLowerCase() === q);
    if (group === 'fav') return i.favourite;
    return i.groupId === group && (!subgroup || i.subgroupId === subgroup);
  }).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const subs = list('menu_subgroups').filter((s) => s.groupId === group).sort((a, b) => a.sort - b.sort);

  const menu = h('section.menu',
    h('input#order-search', {
      placeholder: 'Search or short code (3*12 = 3 × code 12)', value: search, autocomplete: 'off',
      oninput: (/** @type {any} */ e) => { search = e.target.value; scheduleRender(); },
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key !== 'Enter' || !editable) return;
        if (quickAdd(key, search)) { search = ''; scheduleRender(); }
        else if (shown.length === 1) { const it = shown[0]; it.variants.length || it.extras.length ? itemModal(key, it) : addItem(key, it); search = ''; }
        else toast('No item with that code', 'info');
      },
    }),
    h('div.tabs.scroll',
      h('button' + (group === 'fav' ? '.on' : ''), { onclick: () => { group = 'fav'; subgroup = ''; scheduleRender(); } }, '★'),
      groups.map((g) => h('button' + (group === g.id ? '.on' : ''), { onclick: () => { group = g.id; subgroup = ''; search = ''; scheduleRender(); } }, g.name))),
    subs.length && !q ? h('div.chips', h('button.chip' + (!subgroup ? '.on' : ''), { onclick: () => { subgroup = ''; scheduleRender(); } }, 'All'),
      subs.map((s) => h('button.chip' + (subgroup === s.id ? '.on' : ''), { onclick: () => { subgroup = s.id; scheduleRender(); } }, s.name))) : null,
    h('div.items', { 'data-keep-scroll': 'items' },
      shown.map((i) => h('button.item', {
        disabled: !editable,
        onclick: () => (i.variants.length || i.extras.length ? itemModal(key, i) : addItem(key, i)),
      },
      i.image ? h('img', { src: '/img/' + i.image, alt: '', loading: 'lazy' }) : null,
      h('span.diet.' + (DIET[i.diet] ?? 'veg')),
      h('span.name', i.name),
      h('span.meta', (i.code ? `#${i.code} · ` : '') + money(i.pricePaise)))),
      !shown.length ? h('p.muted', group === 'fav' && !q ? 'No favourites yet — pick a group above.' : 'No items.') : null),
    editable ? h('button.ghost', { onclick: () => openItemModal(key) }, '+ Open item') : null);

  // ---- order panel ----
  const live = sent.filter((l) => !l.voided);
  const subtotal = live.reduce((a, l) => a + lineTotal(l), 0) + draft.reduce((a, d) => a + d.unitPaise * d.qty, 0);
  const title = o
    ? (o.type === 'dine' ? `Table ${table?.name ?? '?'}` : o.type === 'delivery' ? `Delivery #${o.no}` : `Takeaway #${o.no}`)
    : `Table ${table?.name ?? '?'} (new)`;

  const orderPanel = h('section.order',
    h('div.order-head',
      h('h2', title),
      o ? h('span.tag', o.status + (o.held ? ' · held' : '')) : null,
      o && o.platform ? h('span.tag', o.platform + (o.platformRef ? ' ' + o.platformRef : '')) : null),
    o ? actions(o) : null,
    h('div.lines', { 'data-keep-scroll': 'lines' },
      kots.map((k) => h('div.kot-group',
        h('div.kot-head', h('b', `KOT ${k.no}`), h('span.tag.' + k.status, k.status), k.reason ? h('small', k.reason) : null,
          k.status === 'ready' && can('serve') ? h('button.small.primary', { onclick: () => tryRun('kot.status', { kotId: k.id, to: 'served' }) }, 'Served') : null),
        sent.filter((l) => l.kotId === k.id).map((l) => lineRow(l, editable)))),
      sent.filter((l) => !l.kotId).map((l) => lineRow(l, editable)),
      draft.length ? h('div.kot-group.draft', h('div.kot-head', h('b', 'Not sent yet')),
        draft.map((d) => h('div.line',
          h('span.qty',
            h('button.small', { onclick: () => { const x = loadDraft(key); const it = x.find((y) => y.key === d.key); if (it) { it.qty--; saveDraft(key, x.filter((y) => y.qty > 0)); } } }, '−'),
            h('b', d.qty),
            h('button.small', { onclick: () => { const x = loadDraft(key); const it = x.find((y) => y.key === d.key); if (it) { it.qty++; saveDraft(key, x); } } }, '+')),
          h('span.lname', d.name, d.variant ? ` (${d.variant})` : '', d.extras.length ? h('small', ' + ' + d.extras.join(', ')) : null, d.note ? h('small.note', ' » ' + d.note) : null),
          h('span.amt', money(d.unitPaise * d.qty)),
          h('button.small.ghost', {
            onclick: async () => {
              const n = await ask('Kitchen note', { value: d.note, chips: list('kitchen_notes').map((x) => x.text) });
              if (n === null) return;
              const x = loadDraft(key); const it = x.find((y) => y.key === d.key); if (it) { it.note = n; saveDraft(key, x); }
            },
          }, '✎')))) : null,
      !sent.length && !draft.length ? h('p.muted', 'Tap items to add them.') : null),
    h('div.order-foot',
      h('div.total', h('span', 'Approx. subtotal'), h('b', money(subtotal))),
      h('div.row',
        editable ? h('button.primary.big', { onclick: sendKot, disabled: !draft.length }, `Send KOT${draft.length ? ` (${draft.reduce((a, d) => a + d.qty, 0)})` : ''}`) : null,
        o && can('bill') ? h('button.big', { onclick: () => go('bill/' + o.id) }, o.status === 'billed' ? 'Bill / Settle' : 'Bill') : null)));

  return h('main.order-screen', orderPanel, editable ? menu : null);
}

/** @param {any} l @param {boolean} editable */
function lineRow(l, editable) {
  return h('div.line' + (l.voided ? '.void' : ''),
    h('span.qty', h('b', l.qty)),
    h('span.lname', l.name, l.variant ? ` (${l.variant})` : '', (l.extras || []).length ? h('small', ' + ' + l.extras.map((/** @type {any} */ e) => e.name).join(', ')) : null,
      l.note ? h('small.note', ' » ' + l.note) : null, l.voided ? h('small.note', ' — ' + l.voidReason) : null),
    h('span.amt', money(lineTotal(l))),
    editable && !l.voided ? h('button.small.ghost', {
      title: 'Void',
      onclick: async () => {
        if (!l.kotId) return tryRun('order.line.remove', { lineId: l.id });
        const reason = await ask(`Void ${l.name}?`, { chips: ['Customer changed mind', 'Wrong item', 'Out of stock', 'Delay'], placeholder: 'Reason' });
        if (!reason) return;
        let qty = l.qty;
        if (l.qty > 1) {
          const q = await ask(`How many of ${l.qty} to void?`, { value: String(l.qty), type: 'number' });
          if (!q) return;
          qty = Math.min(l.qty, Math.max(1, parseInt(q, 10) || l.qty));
        }
        tryRun('order.line.void', { lineId: l.id, reason, qty }, 'Voided');
      },
    }, '✕') : null);
}

/** @param {any} o */
function actions(o) {
  const editable = o.status === 'open';
  return h('div.actions',
    h('button.small', {
      onclick: async () => {
        const n = await ask('Persons', { value: String(o.persons || ''), type: 'number' });
        if (n !== null) tryRun('order.persons', { orderId: o.id, persons: parseInt(n, 10) || 0 });
      },
    }, `👥 ${o.persons || '–'}`),
    editable ? h('button.small', { onclick: () => tryRun('order.hold', { orderId: o.id, held: !o.held }) }, o.held ? 'Unhold' : 'Hold') : null,
    h('button.small', {
      onclick: async () => {
        const c = await ask('Order comment', { value: o.comment });
        if (c !== null) tryRun('order.comment', { orderId: o.id, comment: c });
      },
    }, o.comment ? '💬 ' + o.comment.slice(0, 14) : '💬'),
    o.type === 'dine' && can('table.transfer') ? h('button.small', { onclick: () => transferModal(o) }, 'Transfer') : null,
    h('button.small', { onclick: () => customerModal(o) }, o.customerId ? '👤 ' + (byId('customers', o.customerId)?.phone ?? '') : '👤'),
    can('delivery') && o.type !== 'dine' ? h('button.small', { onclick: () => deliveryModal(o) }, '🛵 ' + (o.platform || 'Platform')) : null,
    h('button.small.danger', {
      onclick: async () => {
        if (!(await confirmBox('Cancel the whole order? Kitchen tickets will be cancelled.'))) return;
        const reason = await ask('Reason for cancelling', { chips: ['Customer left', 'Duplicate order', 'Test'] });
        if (reason) { const r = await tryRun('order.cancel', { orderId: o.id, reason }, 'Order cancelled'); if (r !== null) go('tables'); }
      },
    }, 'Cancel'));
}

/** @param {any} o */
function transferModal(o) {
  modal('Move to table', (close) => h('div.table-grid',
    list('dining_tables').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((t) => {
        const busy = !!activeOrderForTable(t.id);
        return h('button.table.' + (busy ? 'billed' : 'free'), { disabled: busy || t.id === o.tableId, onclick: async () => { close(); await tryRun('table.transfer', { orderId: o.id, toTableId: t.id }, `Moved to ${t.name}`); } }, h('b', t.name));
      })));
}

/** @param {any} o */
function customerModal(o) {
  const c = byId('customers', o.customerId);
  const f = { phone: c?.phone ?? '', name: c?.name ?? '', address: c?.address ?? '' };
  modal('Customer', (close) => [
    h('input', { placeholder: 'Phone', inputmode: 'tel', value: f.phone, oninput: (/** @type {any} */ e) => { f.phone = e.target.value; } }),
    h('input', { placeholder: 'Name', value: f.name, oninput: (/** @type {any} */ e) => { f.name = e.target.value; } }),
    h('textarea', { placeholder: 'Address (delivery)', oninput: (/** @type {any} */ e) => { f.address = e.target.value; } }, f.address),
    c?.duePaise ? h('p.warn', `Pending due ${money(c.duePaise)}`) : null,
    h('button.primary', { onclick: async () => { close(); await tryRun('order.customer', { orderId: o.id, ...f }, 'Saved'); } }, 'Save'),
  ]);
}

/** @param {any} o */
function deliveryModal(o) {
  let ref = o.platformRef || '';
  modal('Delivery platform (manual entry)', (close) => [
    h('input', { placeholder: 'Platform order ref', value: ref, oninput: (/** @type {any} */ e) => { ref = e.target.value; } }),
    h('div.chips', PLATFORMS.map((p) => h('button.chip' + (o.platform === p ? '.on' : ''), { onclick: async () => { close(); await tryRun('order.delivery', { orderId: o.id, platform: p, ref }); } }, p))),
  ]);
}
