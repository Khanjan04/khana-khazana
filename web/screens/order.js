// @ts-check
// Order booking screen (Day 13, legacy parity): menu groups (+ Favorite Items), search across dish /
// group / sub-group / variation names, Short Code box (3 letters or number, suggestions), dish tiles
// (photo, price range, code · number, diet colour, "Not available"), item popup (variation, extras with
// quantity, kitchen notes, typed request, quantity, total), notes for only some units, open item,
// customer / guests / order note / delivery charge, Save · KOT · KOT & Print · Hold · Bill.
// New lines are a draft on this phone until Save or KOT; the host prices and numbers everything.
import { h } from '../h.js';
import { send, isOnline } from '../net.js';
import { list, byId, store, linesOf, kotsOf, lineTotal, activeOrderForTable, orderTotals, itemsOf, orderRef, typeLabel } from '../store.js';
import { can } from '../session.js';
import { money, toast, modal, ask, tryRun, toPaise, confirmBox } from '../ui.js';
import { go, scheduleRender } from '../app.js';
import { printKot } from '../print.js';
import { PLATFORMS, VOID_REASONS } from './shared.js';

let group = 'fav';
let subgroup = '';
let search = '';
let shortCode = '';
let custOpen = false;
let lastKey = '';

/** @typedef {{ key: string, itemId: string | null, name: string, qty: number, variantId: string, variant: string,
 *   extras: {id: string, name: string, pricePaise: number, qty: number}[], notes: string[], text: string, unitPaise: number, pricePaise?: number }} Draft */

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
/** legacy lineSig: identical unsent lines merge. @param {Draft} d */
const sig = (d) => [d.itemId, d.name, d.unitPaise, d.variant, d.extras.map((e) => e.id + ':' + e.qty).join(','), d.notes.join('|'), d.text].join('#');
/** @param {string} k @param {Draft} line */
function addDraft(k, line) {
  const d = loadDraft(k);
  const same = d.find((x) => sig(x) === sig(line));
  if (same) same.qty += line.qty; else d.push(line);
  saveDraft(k, d);
}
const rid = () => Math.random().toString(36).slice(2);
/** replaceChildren without the "null" text nodes for skipped parts. @param {Element} el @param {...any} kids */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(9).filter((k) => k != null && k !== false && k !== ''));

/** @param {any} i */
export function priceRange(i) {
  if (!i.variants?.length) return money(i.pricePaise);
  const ps = i.variants.map((/** @type {any} */ v) => v.pricePaise);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`;
}

/** Add a dish: variations → popup; otherwise straight into the draft. @param {string} k @param {any} item */
function tapItem(k, item) {
  if (!item.available) return toast(`${item.name} is not available today`, 'err');
  if (item.variants.length) return itemModal(k, item);
  addDraft(k, { key: rid(), itemId: item.id, name: item.name, qty: 1, variantId: '', variant: '', extras: [], notes: [], text: '', unitPaise: item.pricePaise });
  if (window.innerWidth <= 900) toast('Added: ' + item.name, 'ok', 1200);
}

/** Item popup (variation, extras with qty, notes, typed request, qty). @param {string} k @param {any} item @param {Draft} [edit] */
function itemModal(k, item, edit) {
  const m = {
    variantId: edit?.variantId ?? '', qty: edit?.qty ?? 1, text: edit?.text ?? '', notes: [...(edit?.notes ?? [])],
    /** @type {Record<string, number>} */ extras: Object.fromEntries((edit?.extras ?? []).map((e) => [e.id, e.qty])),
  };
  const sides = item.allowSides ? list('sides').sort((a, b) => a.sort - b.sort) : [];
  modal(item.name, (close) => {
    const box = h('div');
    const totalEl = h('b.big');
    const draw = () => {
      const v = item.variants.find((/** @type {any} */ x) => x.id === m.variantId);
      const unit = v ? v.pricePaise : item.pricePaise;
      const ex = sides.reduce((a, s) => a + s.pricePaise * (m.extras[s.id] || 0), 0);
      totalEl.textContent = money(unit * m.qty + ex);
      const needV = item.variants.length && !v;
      fill(box,
        item.variants.length ? h('div.opts', h('h4', 'Variation', needV ? h('span.bad', ' – please choose one') : null),
          h('div.optgrid', item.variants.map((/** @type {any} */ x) => h('button.opt' + (x.id === m.variantId ? '.on' : ''), { onclick: () => { m.variantId = x.id; draw(); } }, x.name, h('small', money(x.pricePaise)))))) : null,
        sides.length ? h('div.opts', h('h4', 'Extra (sides)'), sides.map((s) => h('div.xtra' + ((m.extras[s.id] || 0) ? '.on' : ''),
          h('div', h('b', s.name), h('small.muted', ' ' + money(s.pricePaise))),
          h('span.stp',
            h('button.small', { onclick: () => { m.extras[s.id] = Math.max(0, (m.extras[s.id] || 0) - 1); draw(); } }, '−'),
            h('b', String(m.extras[s.id] || 0)),
            h('button.small', { onclick: () => { m.extras[s.id] = Math.min(20, (m.extras[s.id] || 0) + 1); draw(); } }, '+'))))) : null,
        notePicker(m, draw),
        h('label', 'Other request (type)', h('input', { placeholder: 'e.g. less spicy, no onion', value: m.text, oninput: (/** @type {any} */ e) => { m.text = e.target.value; } })),
        h('h4', 'Quantity'),
        h('span.stp', h('button', { onclick: () => { m.qty = Math.max(1, m.qty - 1); draw(); } }, '−'), h('b.big', String(m.qty)), h('button', { onclick: () => { m.qty = Math.min(99, m.qty + 1); draw(); } }, '+')),
        h('div.row.end', totalEl, h('span.grow'), h('button.ghost', { onclick: close }, 'Cancel'), h('button.primary', {
          disabled: !!needV,
          onclick: () => {
            const vv = item.variants.find((/** @type {any} */ x) => x.id === m.variantId);
            const line = /** @type {Draft} */ ({
              key: edit?.key ?? rid(), itemId: item.id, name: item.name, qty: m.qty, variantId: vv?.id ?? '', variant: vv?.name ?? '',
              extras: sides.filter((s) => m.extras[s.id] > 0).map((s) => ({ id: s.id, name: s.name, pricePaise: s.pricePaise, qty: m.extras[s.id] })),
              notes: m.notes, text: m.text.trim(), unitPaise: vv ? vv.pricePaise : item.pricePaise,
            });
            if (edit) saveDraft(k, loadDraft(k).map((x) => (x.key === edit.key ? line : x)));
            else addDraft(k, line);
            close();
          },
        }, 'Save')));
    };
    draw();
    return box;
  });
}

/** Drop-down of kitchen notes (choose one or more; chosen notes show as green tags). @param {{notes: string[]}} m @param {() => void} redraw */
function notePicker(m, redraw) {
  const left = list('kitchen_notes').sort((a, b) => a.sort - b.sort).map((n) => n.text).filter((t) => !m.notes.includes(t));
  return h('div',
    h('label', 'Special notes for the kitchen',
      h('select', { onchange: (/** @type {any} */ e) => { if (e.target.value) { m.notes.push(e.target.value); redraw(); } } },
        h('option', { value: '' }, '▼ Choose a note…'), left.map((t) => h('option', { value: t }, t)))),
    h('div.ntags', m.notes.length ? m.notes.map((n, i) => h('span.ntag', n, h('button', { 'aria-label': 'Remove ' + n, onclick: () => { m.notes.splice(i, 1); redraw(); } }, '✕')))
      : h('span.muted.small', 'No note chosen yet. You can choose more than one.')));
}

/** Notes for only some units of a draft line (e.g. 2 Pav Bhaji: 1 less spicy). @param {string} k @param {Draft} d */
function lineNoteModal(k, d) {
  const m = { n: d.qty, notes: [...d.notes], text: d.text };
  modal(`Notes – ${d.name}${d.variant ? ` (${d.variant})` : ''}`, (close) => {
    const box = h('div');
    const draw = () => fill(box,
      d.qty > 1 ? h('div', h('label', `Give these notes to how many of the ${d.qty}?`),
        h('div.chips', Array.from({ length: Math.min(d.qty, 10) }, (_, i) => i + 1).map((n) => h('button.chip' + (m.n === n ? '.on' : ''), { onclick: () => { m.n = n; draw(); } }, String(n)))),
        h('p.small.muted', 'Example: 2 Pav Bhaji – choose 1 and pick “Less Spicy”. The other 1 stays without a note.')) : null,
      notePicker(m, draw),
      h('label', 'Other request (type)', h('input', { value: m.text, placeholder: 'e.g. no onion', oninput: (/** @type {any} */ e) => { m.text = e.target.value; } })),
      h('div.row.end', h('button.ghost', { onclick: close }, 'Cancel'), h('button.primary', {
        onclick: () => {
          const all = loadDraft(k);
          const cur = all.find((x) => x.key === d.key);
          if (!cur) return close();
          const n = Math.max(1, Math.min(m.n, cur.qty));
          if (n >= cur.qty) { cur.notes = m.notes; cur.text = m.text.trim(); }
          else {
            cur.qty -= n;
            all.splice(all.indexOf(cur) + 1, 0, { ...cur, key: rid(), qty: n, notes: m.notes, text: m.text.trim(), extras: [] });
          }
          // merge identical lines again
          /** @type {Draft[]} */
          const merged = [];
          for (const x of all) { const s = merged.find((y) => sig(y) === sig(x)); if (s) s.qty += x.qty; else merged.push(x); }
          saveDraft(k, merged);
          close();
          toast('Notes saved', 'ok');
        },
      }, 'Save notes')));
    draw();
    return box;
  });
}

function openItemModal(/** @type {string} */ k) {
  if (!store.settings.allowOpenItem) return toast('Open items are switched off in Settings', 'err');
  modal('Open item', (close) => {
    const f = { name: '', price: '', qty: '1' };
    return [
      h('p.muted', 'For a dish, cake, decoration or bottle that is not in the menu.'),
      h('label', 'Item name', h('input', { oninput: (/** @type {any} */ e) => { f.name = e.target.value; } })),
      h('div.row',
        h('label', 'Price (₹)', h('input', { inputmode: 'decimal', oninput: (/** @type {any} */ e) => { f.price = e.target.value; } })),
        h('label', 'Quantity', h('input', { inputmode: 'numeric', value: '1', oninput: (/** @type {any} */ e) => { f.qty = e.target.value; } }))),
      h('div.row.end', h('button.ghost', { onclick: close }, 'Cancel'), h('button.primary', {
        onclick: () => {
          const pricePaise = toPaise(f.price), qty = Math.max(1, parseInt(f.qty, 10) || 1);
          if (!f.name.trim()) return toast('Please type the item name.', 'err');
          if (pricePaise <= 0) return toast('Please type the price.', 'err');
          addDraft(k, { key: rid(), itemId: null, name: f.name.trim(), qty, variantId: '', variant: '', extras: [], notes: [], text: '', unitPaise: pricePaise, pricePaise });
          close();
        },
      }, 'Add to order')),
    ];
  });
}

/** Short code: 3 letters or a number; exact match first, then prefix matches (max 6). @param {string} q */
export function scMatches(q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  const all = list('items').filter((i) => i.active && i.available);
  let ex, pre;
  if (/^\d+$/.test(q)) { const n = Number(q); ex = all.filter((i) => i.num === n); pre = all.filter((i) => i.num !== n && String(i.num).startsWith(q)); }
  else { ex = all.filter((i) => i.code === q); pre = all.filter((i) => i.code !== q && i.code.startsWith(q)); }
  return [...ex, ...pre].slice(0, 6);
}

/** Search like the legacy app: every word must appear in dish / group / sub-group / variation names. @param {string} q */
function searchItems(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list('items').filter((i) => {
    if (!i.active) return false;
    const hay = [i.name, byId('menu_groups', i.groupId)?.name, byId('menu_subgroups', i.subgroupId)?.name, ...i.variants.map((/** @type {any} */ v) => v.name)].join(' ').toLowerCase();
    return toks.every((t) => hay.includes(t));
  });
}

const DIET = /** @type {Record<string, string>} */ ({ veg: 'veg', nonveg: 'nonveg', egg: 'egg', none: 'none' });

/** All KOTs of an order (legacy "eye" button). @param {any} o */
export function kotsModal(o) {
  modal(`All KOTs – ${orderRef(o)}`, () => h('div.kots', kotsOf(o.id).map((k) => h('div.kcard',
    h('header', h('span', `KOT - ${k.no}`), h('span', new Date(k.createdAt).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })), h('span.tag.' + k.status, k.status)),
    h('div.kb', linesOf(o.id).filter((l) => l.kotId === k.id).map((l) => h('div' + (l.voided ? '.void' : ''),
      h('b', `${l.qty} × `), l.name, l.variant ? ` (${l.variant})` : '', l.voided ? ' (cancelled)' : '',
      (l.extras || []).map((/** @type {any} */ e) => h('div.small', `Sides: ${e.name} - ${e.qty ?? 1}`)),
      l.note ? h('div.small', '[Note] ' + l.note) : null))),
    can('kot.reprint') ? h('button.small', { onclick: () => printKot(k.id) }, '🖨 Print this KOT') : null))), { wide: true });
}

/** @param {import('../app.js').Route} r */
export function render(r) {
  const isNew = r.args[0] === 'new';
  const tableId = isNew ? r.query.get('table') : null;
  if (isNew && tableId) {
    const existing = activeOrderForTable(tableId);
    if (existing) { go('order/' + existing.id); return h('div'); }
  }
  const o = isNew ? null : byId('orders', r.args[0]);
  if (!isNew && !o) return h('div.panel', h('p', 'Order not found (it may still be syncing, or it was closed).'), h('a', { href: '#/tables' }, 'Back to tables'));
  const key = o ? o.id : 'table:' + tableId;
  const prevKey = lastKey;
  lastKey = key;
  // a different table / order starts with a clean search (a new table's first Save keeps it: same table)
  if (prevKey !== key && !(o && prevKey === 'table:' + o.tableId)) { search = ''; shortCode = ''; custOpen = false; }
  const table = byId('dining_tables', o ? o.tableId : tableId);
  const draft = loadDraft(key);
  const editable = !o || o.status === 'open';
  const sent = o ? linesOf(o.id) : [];
  const kots = o ? kotsOf(o.id) : [];
  const unsent = sent.filter((l) => !l.kotId && !l.voided);

  /** Draft -> command line payload. @param {Draft} d */
  const toLine = (d) => (d.itemId
    ? { itemId: d.itemId, qty: d.qty, variant: d.variantId || undefined, sides: d.extras.map((e) => ({ id: e.id, qty: e.qty })), notes: d.notes, note: d.text }
    : { name: d.name, pricePaise: d.pricePaise, qty: d.qty, note: [...d.notes, d.text].filter(Boolean).join(', ') });

  /** Save / KOT / KOT & Print. @param {'save'|'kot'|'kotprint'} mode */
  const submit = async (mode) => {
    if (mode === 'save' ? !draft.length : !draft.length && !unsent.length) return toast('Add at least one dish first.', 'err');
    const lines = draft.map(toLine);
    const where = o ? { orderId: o.id } : { type: 'dine', tableId };
    saveDraft(key, []); // the command is in the outbox now; never send the same draft twice
    if (!isOnline()) toast('Host offline — saved on this phone, will be sent automatically', 'info', 6000);
    try {
      if (mode === 'save') {
        const res = await send('order.line.add', { ...where, lines });
        toast('Order saved', 'ok');
        if (!o) go('order/' + res.orderId);
      } else {
        const res = await send('kot.create', { ...where, lines: lines.length ? lines : undefined });
        toast(`KOT ${res.kots.map((/** @type {any} */ k) => k.no).join(', ')} sent to kitchen`, 'ok');
        if (mode === 'kotprint') for (const k of res.kots) setTimeout(() => printKot(k.id), 400);
        go(o && o.type !== 'dine' ? 'orders/' + o.type : 'tables');
      }
    } catch (e) {
      saveDraft(key, [...draft, ...loadDraft(key)]); // put lines back
      toast(`${/** @type {any} */ (e).code}: ${/** @type {Error} */ (e).message}`, 'err');
    }
  };

  // ---- menu (left: groups, middle: search + short code + dishes) ----
  const groups = list('menu_groups').sort((a, b) => a.sort - b.sort);
  const qtyMap = /** @type {Record<string, number>} */ ({});
  for (const l of sent) if (!l.voided && l.itemId) qtyMap[l.itemId] = (qtyMap[l.itemId] ?? 0) + l.qty;
  for (const d of draft) if (d.itemId) qtyMap[d.itemId] = (qtyMap[d.itemId] ?? 0) + d.qty;
  const q = search.trim();
  const subs = list('menu_subgroups').filter((s) => s.groupId === group).sort((a, b) => a.sort - b.sort);
  /** @type {[string, any[]][]} sections of tiles */
  let sections;
  if (q) sections = [['', searchItems(q)]];
  else if (group === 'fav') sections = [['', list('items').filter((i) => i.active && i.favourite).sort((a, b) => a.name.localeCompare(b.name))]];
  else if (subgroup) sections = [['', itemsOf(group, subgroup)]];
  else sections = [...(itemsOf(group, null).length ? [/** @type {[string, any[]]} */ (['', itemsOf(group, null)])] : []), ...subs.map((s) => /** @type {[string, any[]]} */ ([subs.length > 1 ? s.name : '', itemsOf(group, s.id)]))];
  const tile = (/** @type {any} */ i) => h('button.item.' + (DIET[i.diet] ?? 'none') + (i.available ? '' : '.off') + (i.image ? '.hasimg' : ''), { disabled: !editable, onclick: () => tapItem(key, i) },
    i.image ? h('img', { src: '/img/' + i.image, alt: '', loading: 'lazy' }) : null,
    h('span.name', i.name),
    h('span.pr', i.available ? priceRange(i) : 'Not available'),
    q && !i.favourite ? h('span.lb', byId('menu_groups', i.groupId)?.name ?? '') : null,
    h('span.cd', `${i.code} · ${i.num}`),
    qtyMap[i.id] ? h('span.qb', String(qtyMap[i.id])) : null);
  const scList = scMatches(shortCode);
  const menuTitle = q ? 'Search results' : group === 'fav' ? 'Favorite Items' : byId('menu_groups', group)?.name ?? '';

  const menu = h('section.menu',
    h('div.mtop',
      h('input#order-search', { type: 'search', placeholder: '🔍 Search item', value: search, autocomplete: 'off', oninput: (/** @type {any} */ e) => { search = e.target.value; scheduleRender(); } }),
      h('div.scbox',
        h('input#order-sc', {
          placeholder: 'Short Code', value: shortCode, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Short code (3 letters or number)',
          oninput: (/** @type {any} */ e) => { shortCode = e.target.value; scheduleRender(); },
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key !== 'Enter' || !shortCode.trim()) return;
            const m = scMatches(shortCode);
            if (!m.length) { toast(`No dish has the short code “${shortCode.toUpperCase()}”.`, 'err'); return; }
            shortCode = ''; tapItem(key, m[0]);
          },
        }),
        scList.length ? h('div.scl', scList.map((i, n) => h('button' + (n === 0 ? '.on' : ''), { onclick: () => { shortCode = ''; tapItem(key, i); } }, h('span', i.name), h('small', `${i.code} · ${i.num}`)))) : null)),
    h('div.glist',
      h('button.g' + (group === 'fav' && !q ? '.on' : ''), { onclick: () => { group = 'fav'; subgroup = ''; search = ''; scheduleRender(); } }, '★ Favorite Items'),
      groups.map((g) => h('button.g' + (group === g.id && !q ? '.on' : ''), { onclick: () => { group = g.id; subgroup = ''; search = ''; scheduleRender(); } }, g.name))),
    subs.length > 1 && !q && group !== 'fav' ? h('div.chips', h('button.chip' + (!subgroup ? '.on' : ''), { onclick: () => { subgroup = ''; scheduleRender(); } }, 'All'),
      subs.map((s) => h('button.chip' + (subgroup === s.id ? '.on' : ''), { onclick: () => { subgroup = s.id; scheduleRender(); } }, s.name))) : null,
    h('div.mtitle', menuTitle),
    h('div.items', { 'data-keep-scroll': 'items' },
      sections.map(([title, its]) => [title && its.length ? h('div.sh', title) : null, its.map(tile)]),
      !sections.some(([, its]) => its.length) ? h('p.muted', q ? `No dish found for “${q}”.` : group === 'fav' ? 'No favourite dishes yet. The Owner can star dishes in Admin › Menu.' : 'No dishes here yet.') : null,
      editable && store.settings.allowOpenItem && !q ? h('button.item.open', { onclick: () => openItemModal(key) }, h('span.name', 'Open Item'), h('span.pr', 'Type name & price')) : null));

  // ---- cart (right) ----
  const T = orderTotals(o, draft.map((d) => ({ unitPaise: d.unitPaise, qty: d.qty, extras: d.extras })));
  const title = o ? (o.type === 'dine' ? `Table ${orderRef(o)}` : orderRef(o)) : `Table ${table?.name ?? '?'}`;
  const draftQty = draft.reduce((a, d) => a + d.qty, 0);

  const cart = h('section.order',
    h('div.ctabs', ['dine', 'delivery', 'takeaway'].map((t) => h('span' + ((o?.type ?? 'dine') === t ? '.on' : ''), t === 'dine' ? 'Dine In' : t === 'delivery' ? 'Delivery' : 'Pick Up'))),
    h('div.order-head',
      h('h2', title),
      o?.platform ? h('span.tag', o.platform + (o.platformRef ? ' · ' + o.platformRef : '')) : null,
      o ? h('span.tag.' + o.status, o.status === 'billed' ? 'bill printed' : o.held ? 'on hold' : o.status) : h('span.tag', 'new'),
      h('span.grow'),
      o && kots.length ? h('button.small', { onclick: () => kotsModal(o), title: 'See all KOTs' }, '👁') : null),
    o ? actions(o) : h('p.small.muted', 'Customer, guests and notes can be added after the first Save or KOT.'),
    o && custOpen ? customerPanel(o) : null,
    o?.comment ? h('div.cnote', h('b', 'Order note: '), o.comment) : null,
    h('div.lines', { 'data-keep-scroll': 'lines' },
      kots.map((k) => {
        const ls = sent.filter((l) => l.kotId === k.id);
        return ls.length ? h('div.kot-group',
          h('div.kot-head', h('b', `KOT - ${k.no}`), h('small', new Date(k.createdAt).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit' })), h('span.tag.' + k.status, k.status),
            k.reason ? h('small', k.reason) : null, h('span.grow'),
            k.status === 'ready' && can('serve') ? h('button.small.primary', { onclick: () => tryRun('kot.status', { kotId: k.id, to: 'served' }) }, 'Served') : null),
          ls.map((l) => lineRow(l, editable))) : null;
      }),
      unsent.length ? h('div.kot-group.saved', h('div.kot-head', h('b', 'Saved, not sent to kitchen')), unsent.map((l) => lineRow(l, editable))) : null,
      draft.length ? h('div.kot-group.draft', h('div.kot-head', h('b', 'NEW KOT'), h('small', `${draft.length} item${draft.length > 1 ? 's' : ''}`)),
        draft.map((d) => h('div.line',
          h('span.qty',
            h('button.small', { 'aria-label': 'Less', onclick: () => { const x = loadDraft(key); const it = x.find((y) => y.key === d.key); if (it && it.qty > 1) { it.qty--; saveDraft(key, x); } } }, '−'),
            h('b', d.qty),
            h('button.small', { 'aria-label': 'More', onclick: () => { const x = loadDraft(key); const it = x.find((y) => y.key === d.key); if (it) { it.qty++; saveDraft(key, x); } } }, '+')),
          h('span.lname', { onclick: () => { const it = d.itemId && byId('items', d.itemId); if (it && it.variants.length + (it.allowSides ? 1 : 0)) itemModal(key, it, d); } },
            h('u', d.name + (d.variant ? ` (${d.variant})` : '')),
            d.extras.length ? h('small', ' ' + d.extras.map((e) => `+ ${e.name} × ${e.qty}`).join(' ')) : null,
            d.notes.length || d.text ? h('small.note', ' ' + [...d.notes, d.text ? `“${d.text}”` : ''].filter(Boolean).join(', ')) : null),
          h('span.amt', money(d.unitPaise * d.qty + d.extras.reduce((a, e) => a + e.pricePaise * e.qty, 0))),
          h('button.small' + (d.notes.length || d.text ? '.on' : '.ghost'), { title: 'Notes', onclick: () => lineNoteModal(key, d) }, '📝'),
          h('button.small.ghost', { 'aria-label': 'Delete ' + d.name, onclick: () => saveDraft(key, loadDraft(key).filter((y) => y.key !== d.key)) }, '✕')))) : null,
      !sent.length && !draft.length ? h('div.cempty', h('p', 'No Item Selected', h('br'), h('small', 'Tap a dish to add it to this order.'))) : null),
    h('div.order-foot',
      h('div.sumd',
        h('div.pr', h('span', 'Sub Total'), h('span', money(T.subtotal))),
        T.delivery ? h('div.pr', h('span', 'Delivery Charge'), h('span', money(T.delivery))) : null,
        h('div.pr', h('button.linklike', { onclick: () => taxModal(T) }, 'Tax'), h('span', money(T.tax))),
        T.roundOff ? h('div.pr.small', h('span', 'Round off'), h('span', (T.roundOff > 0 ? '+' : '') + (T.roundOff / 100).toFixed(2))) : null),
      h('div.total', h('span', 'Total'), h('b', money(T.total))),
      editable ? h('div.brow',
        can('order') ? h('button.ab.a1', { onclick: () => submit('save'), disabled: !draft.length }, 'Save') : null,
        can('kot') ? h('button.ab.kt', { onclick: () => submit('kot'), disabled: !draft.length && !unsent.length }, `KOT${draftQty ? ` (${draftQty})` : ''}`) : null,
        can('kot') ? h('button.ab.kt', { onclick: () => submit('kotprint'), disabled: !draft.length && !unsent.length }, 'KOT & Print') : null,
        o && can('order') ? h('button.ab.hd', { onclick: async () => { if (draft.length) await submit('save'); if (await tryRun('order.hold', { orderId: o.id, held: true }, 'Order put on hold')) go(o.type === 'dine' ? 'tables' : 'orders/' + o.type); } }, 'Hold') : null) : null,
      o && can('bill') ? h('button.big.primary.wide', { onclick: () => go('bill/' + o.id) }, o.status === 'billed' ? 'Bill / Settle' : 'Bill & Payment') : null));

  return h('main.order-screen', editable ? menu : null, cart);
}

/** @param {any} T */
function taxModal(T) {
  modal('Applied Tax', () => [
    h('table.list', T.taxes.length ? T.taxes.map((/** @type {any} */ t) => h('tr', h('td', t.name, h('small.muted', ` on ${money(T.taxable)}`)), h('td', t.rate + '%'), h('td', money(t.amountPaise)))) : h('tr', h('td.muted', 'No tax is set.')),
      h('tr', h('th', 'Total tax'), h('td'), h('th', money(T.tax)))),
    h('p.small.muted', 'Tax rates are set by the Owner in Admin › Settings.'),
  ]);
}

/** A line that is already on the host (sent to kitchen, or saved). @param {any} l @param {boolean} editable */
function lineRow(l, editable) {
  return h('div.line' + (l.voided ? '.void' : ''),
    h('span.qty', h('b', l.qty)),
    h('span.lname', l.name, l.variant ? ` (${l.variant})` : '',
      (l.extras || []).length ? h('small', ' ' + l.extras.map((/** @type {any} */ e) => `+ ${e.name} × ${e.qty ?? 1}`).join(' ')) : null,
      l.note ? h('small.note', ' ' + l.note) : null, l.voided ? h('small.note', ' — ' + l.voidReason) : null),
    h('span.amt', l.voided ? '' : money(lineTotal(l))),
    editable && !l.voided ? h('button.small.ghost', {
      title: 'Delete',
      onclick: async () => {
        if (!l.kotId) {
          const payload = /** @type {any} */ ({ lineId: l.id });
          if (store.settings.reasonAll) {
            const reason = await ask(`Delete ${l.name}`, { chips: VOID_REASONS, placeholder: 'Why is this item deleted?' });
            if (!reason) return;
            payload.reason = reason;
          }
          return tryRun('order.line.remove', payload, store.settings.reasonAll ? 'Item deleted and recorded' : undefined);
        }
        const reason = await ask(`Delete ${l.name} (already sent to the kitchen — please tell the kitchen)`, { chips: VOID_REASONS, placeholder: 'Reason' });
        if (!reason) return;
        let qty = l.qty;
        if (l.qty > 1) {
          const q = await ask(`How many of ${l.qty} to delete?`, { value: String(l.qty), type: 'number' });
          if (!q) return;
          qty = Math.min(l.qty, Math.max(1, parseInt(q, 10) || l.qty));
        }
        tryRun('order.line.void', { lineId: l.id, reason, qty }, 'Item deleted and recorded');
      },
    }, '✕') : null);
}

/** @param {any} o */
function actions(o) {
  const editable = o.status === 'open';
  const hasCust = !!(o.custPhone || o.custName);
  return h('div.cicons',
    h('button' + (custOpen || hasCust ? '.on' : ''), { title: 'Customer name & mobile', onclick: () => { custOpen = !custOpen; scheduleRender(); } }, '👤', hasCust ? h('span.bd', '✓') : null),
    h('button', {
      title: 'How many guests',
      onclick: async () => {
        const n = await ask(`How many guests at ${orderRef(o)}?`, { value: String(o.persons || ''), type: 'number', chips: ['1', '2', '3', '4', '5', '6', '8', '10'] });
        if (n !== null) tryRun('order.persons', { orderId: o.id, persons: Math.max(0, Math.min(200, parseInt(n, 10) || 0)) });
      },
    }, '👥', o.persons ? h('span.bd', String(o.persons)) : null),
    h('button' + (o.comment ? '.on' : ''), {
      title: 'Comment for the whole order (printed on the KOT)',
      onclick: async () => { const c = await ask('Order Wise Comments', { value: o.comment }); if (c !== null) tryRun('order.comment', { orderId: o.id, comment: c }); },
    }, '📝'),
    o.type !== 'dine' && can('delivery') ? h('button', {
      title: 'Delivery charge',
      onclick: async () => {
        const v = await ask('Delivery charge (₹)', { value: o.deliveryPaise ? String(o.deliveryPaise / 100) : '', type: 'number', chips: ['0', '30', '40', '50', '80'] });
        if (v !== null) tryRun('order.delivery.charge', { orderId: o.id, amountPaise: toPaise(v) });
      },
    }, '🛵', o.deliveryPaise ? h('span.bd', '₹' + o.deliveryPaise / 100) : null) : null,
    o.type === 'delivery' && can('delivery') ? h('button', { title: 'Delivery app', onclick: () => deliveryModal(o) }, o.platform ? o.platform.slice(0, 6) : 'App') : null,
    o.type === 'dine' && can('table.transfer') ? h('button', { title: 'Move to another table', onclick: () => transferModal(o) }, '⇄') : null,
    editable && can('order') && o.held ? h('button', { onclick: () => tryRun('order.hold', { orderId: o.id, held: false }) }, 'Unhold') : null,
    h('span.grow'),
    h('span.sect', typeLabel(o)),
    h('button.danger', {
      title: 'Cancel the whole order',
      onclick: async () => {
        if (!(await confirmBox('Cancel the whole order? Kitchen tickets will be cancelled.'))) return;
        const reason = await ask('Reason for cancelling', { chips: ['Customer left', 'Duplicate order', 'Test'] });
        if (reason && (await tryRun('order.cancel', { orderId: o.id, reason }, 'Order cancelled'))) go(o.type === 'dine' ? 'tables' : 'orders/' + o.type);
      },
    }, '🗑'));
}

/** Inline customer panel (legacy): mobile lookup fills name/address/locality/tag and shows dues. @param {any} o */
function customerPanel(o) {
  const tags = /** @type {any[]} */ (store.settings.custTags ?? []);
  const f = { phone: o.custPhone ?? '', name: o.custName ?? '', address: o.custAddress ?? '', locality: o.custLocality ?? '', tag: o.custTag ?? '' };
  const nameIn = /** @type {HTMLInputElement} */ (h('input#cust-name', { placeholder: 'Customer name', value: f.name, oninput: (/** @type {any} */ e) => { f.name = e.target.value; } }));
  const addIn = /** @type {HTMLInputElement} */ (h('input#cust-add', { placeholder: 'Address', value: f.address, oninput: (/** @type {any} */ e) => { f.address = e.target.value; } }));
  const locIn = /** @type {HTMLInputElement} */ (h('input#cust-loc', { placeholder: 'Locality', value: f.locality, oninput: (/** @type {any} */ e) => { f.locality = e.target.value; } }));
  const tagSel = /** @type {HTMLSelectElement} */ (h('select', { onchange: (/** @type {any} */ e) => { f.tag = e.target.value; } }, h('option', { value: '' }, 'No tag'),
    tags.map((t) => h('option', { value: t.id, selected: t.id === f.tag }, `${t.name}${t.disc ? ` (${t.disc}%)` : ''}`))));
  return h('div.cust',
    h('input#cust-phone', {
      placeholder: 'Mobile number', inputmode: 'tel', value: f.phone,
      oninput: (/** @type {any} */ e) => {
        f.phone = e.target.value;
        const k = f.phone.replace(/\D/g, '');
        const c = k.length >= 10 ? list('customers').find((x) => x.phone === k) : null;
        if (!c) return;
        if (!f.name) { f.name = c.name; nameIn.value = c.name; }
        if (!f.address) { f.address = c.address; addIn.value = c.address; }
        if (!f.locality) { f.locality = c.locality; locIn.value = c.locality; }
        if (!f.tag && c.tag) { f.tag = c.tag; tagSel.value = c.tag; }
        toast(`Customer found: ${c.name || k}${c.duePaise > 0 ? ' – due ' + money(c.duePaise) : ''}`, 'ok');
      },
    }),
    nameIn, addIn, locIn, tags.length ? tagSel : null,
    h('div.row.end',
      h('button.small.ghost', { onclick: () => { tryRun('order.customer', { orderId: o.id, phone: '', name: '', address: '', locality: '', tag: '' }, 'Customer details removed'); } }, 'Clear'),
      h('button.small.primary', { onclick: async () => { if (await tryRun('order.customer', { orderId: o.id, ...f }, 'Saved')) { custOpen = false; scheduleRender(); } } }, 'Save customer')));
}

/** @param {any} o */
function transferModal(o) {
  modal('Move to table', (close) => h('div.table-grid',
    list('dining_tables').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((t) => {
        const busy = !!activeOrderForTable(t.id);
        return h('button.table.' + (busy ? 'printed' : 'blank'), { disabled: busy || t.id === o.tableId, onclick: async () => { close(); await tryRun('table.transfer', { orderId: o.id, toTableId: t.id }, `Moved to ${t.name}`); } }, h('b', t.name));
      })));
}

/** @param {any} o */
function deliveryModal(o) {
  let ref = o.platformRef || '';
  modal('Delivery app (manual entry)', (close) => [
    h('input', { placeholder: 'Order number on the app', value: ref, oninput: (/** @type {any} */ e) => { ref = e.target.value; } }),
    h('div.chips', PLATFORMS.map((p) => h('button.chip' + (o.platform === p ? '.on' : ''), { onclick: async () => { close(); await tryRun('order.delivery', { orderId: o.id, platform: p, ref }); } }, p))),
  ]);
}
