// @ts-check
// Admin screens (Day 19, legacy parity): menu (order, favourite, available, short codes, bulk add), extras & notes,
// table-layout builder, users & roles, settings (taxes, other types, customer tags…), devices, backups (+ import from
// the old billing app), printing.
import { h } from '../h.js';
import { api } from '../net.js';
import { list, store, byId } from '../store.js';
import { authHeaders, can, me } from '../session.js';
import { money, toPaise, modal, tryRun, toast, confirmBox, ask, download, copyText } from '../ui.js';
import { printMode, setPrintMode, testPrint, MODES } from '../print.js';
import { scheduleRender } from '../app.js';
import { qrSvg } from './join.js';
import { priceRange } from './order.js';
import { DIET_LABEL } from './shared.js';
import { parseBulk } from '../../server/domain/codes.js';

const RIGHTS = ['order', 'kot', 'bill', 'discount', 'delivery', 'void', 'history', 'reports', 'kitchen', 'layout', 'menu', 'users', 'settings',
  'kitchen.status', 'serve', 'kot.reprint', 'table.transfer', 'bill.reprint', 'dayclose', 'approve', 'stock', 'customers.due', 'device.manage', 'export'];

const TABS = /** @type {[string, string, () => boolean][]} */ ([
  ['menu', 'Menu', () => can('menu')],
  ['extras', 'Extras & notes', () => can('menu')],
  ['layout', 'Layout', () => can('layout')],
  ['users', 'Users', () => can('users')],
  ['settings', 'Settings', () => can('settings')],
  ['devices', 'Devices', () => can('device.manage')],
  ['backups', 'Backups', () => can('settings') || can('export')],
  ['printing', 'Printing', () => true],
]);
let tab = '';

/** @param {any} a @param {any} b */
const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
/** @param {Record<string, any>} f @param {string} k @param {string} label @param {Record<string, any>} [attrs] */
const inp = (f, k, label, attrs = {}) => h('label', label, h('input', { value: f[k] ?? '', oninput: (/** @type {any} */ e) => { f[k] = attrs.type === 'checkbox' ? e.target.checked : e.target.value; }, ...attrs, checked: attrs.type === 'checkbox' ? !!f[k] : undefined }));

export function render() {
  const avail = TABS.filter(([, , ok]) => ok());
  // don't overwrite `tab`: rights may still be arriving with the host's welcome
  const cur = avail.find(([id]) => id === tab) ? tab : avail[0]?.[0] ?? 'printing';
  const body = { menu, extras, layout, users, settings, devices, backups, printing }[cur]?.() ?? h('div');
  return h('main.panel',
    h('div.tabs', avail.map(([id, label]) => h('button' + (cur === id ? '.on' : ''), { onclick: () => { tab = id; scheduleRender(); } }, label))),
    body);
}

// ---------------- menu ----------------
let bulkOpen = false;
function menu() {
  const groups = list('menu_groups').sort(bySort);
  const items = list('items').filter((i) => i.active);
  /** @param {string} kind @param {string} id @param {number} dir */
  const mv = (kind, id, dir) => (/** @type {Event} */ e) => { e.preventDefault(); e.stopPropagation(); tryRun('menu.move', { kind, id, dir }); };
  /** @param {string} kind @param {string} id */
  const arrows = (kind, id) => [h('button.small.ghost', { title: 'Move up', onclick: mv(kind, id, -1) }, '▲'), h('button.small.ghost', { title: 'Move down', onclick: mv(kind, id, 1) }, '▼')];
  /** @param {any} i */
  const row = (i) => h('tr' + (i.available ? '' : '.off'),
    h('td', h('span.diet.' + i.diet)),
    h('td.small', `${i.code} · ${i.num}`),
    h('td.click', { onclick: () => itemModal(i) }, i.name, i.variants.length ? h('small.muted', ' ' + i.variants.map((/** @type {any} */ v) => v.name).join(' / ')) : null, i.allowSides ? h('small.muted', ' +extras') : null),
    h('td', i.variants.length ? priceRange(i) : money(i.pricePaise)),
    h('td', h('button.small' + (i.favourite ? '.on' : '.ghost'), { title: 'Favourite', onclick: () => tryRun('menu.item.favourite', { id: i.id, favourite: !i.favourite }) }, i.favourite ? '★' : '☆')),
    h('td', h('label.switch', { title: 'Available today' }, h('input', { type: 'checkbox', checked: !!i.available, onchange: (/** @type {any} */ e) => tryRun('menu.item.available', { id: i.id, available: e.target.checked }) }), h('span', i.available ? 'Available' : 'Not available'))),
    h('td', arrows('item', i.id)));
  return h('div',
    h('div.toolbar', h('h3', `Groups (${groups.length}/12)`), h('span.grow'),
      h('button', { onclick: () => { bulkOpen = !bulkOpen; scheduleRender(); } }, 'Bulk add dishes'),
      h('button', { onclick: () => groupModal() }, '+ Group')),
    bulkOpen ? bulkBox(groups) : null,
    groups.map((g) => {
      const subs = list('menu_subgroups').filter((s) => s.groupId === g.id).sort(bySort);
      const its = items.filter((i) => i.groupId === g.id);
      const loose = its.filter((i) => !i.subgroupId).sort(bySort);
      return h('details.group', { open: groups.length < 4 },
        h('summary', h('b', g.name), ` · ${its.length} dishes `, arrows('group', g.id),
          h('button.small', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); groupModal(g); } }, 'Edit'),
          h('button.small', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); subgroupModal(g.id); } }, '+ Sub-group'),
          h('button.small.primary', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); itemModal({ groupId: g.id }); } }, '+ Dish')),
        loose.length ? h('table.list', loose.map(row)) : null,
        subs.map((s) => {
          const sits = its.filter((i) => i.subgroupId === s.id).sort(bySort);
          return h('div.sub', h('div.toolbar', h('b', s.name), h('small.muted', ` ${sits.length}/100`), arrows('subgroup', s.id),
            h('button.small', { onclick: () => subgroupModal(g.id, s) }, 'Edit'),
            h('button.small', { onclick: () => itemModal({ groupId: g.id, subgroupId: s.id }) }, '+ Dish')),
          sits.length ? h('table.list', sits.map(row)) : h('p.small.muted', 'No dishes yet.'));
        }));
    }),
    h('p.small.muted', `${items.length} dishes. Short code = 3 letters + number (shown as “DAL · 12”). Tap ☆ to show a dish in Favorite Items. Switch “Available” off when a dish is finished for the day.`));
}

/** Legacy "Add Items (Bulk)": paste "Name 120" lines. @param {any[]} groups */
function bulkBox(groups) {
  const f = { groupId: groups[0]?.id ?? '', subgroupId: '', text: '' };
  const prev = h('div.small');
  const subSel = h('select', { onchange: (/** @type {any} */ e) => { f.subgroupId = e.target.value; } });
  const fillSubs = () => subSel.replaceChildren(h('option', { value: '' }, '— none —'), ...list('menu_subgroups').filter((s) => s.groupId === f.groupId).sort(bySort).map((s) => h('option', { value: s.id }, s.name)));
  fillSubs();
  const show = () => {
    const rows = parseBulk(f.text);
    const bad = rows.filter((r) => 'bad' in r);
    prev.replaceChildren(rows.length ? `${rows.length - bad.length} dish(es) ready` : '', bad.length ? h('span.bad', ` · ${bad.length} line(s) not understood: ${bad.map((b) => /** @type {any} */ (b).line).join(' | ')}`) : '');
  };
  return h('div.panel.bulk',
    h('div.row',
      h('label', 'Group', h('select', { onchange: (/** @type {any} */ e) => { f.groupId = e.target.value; f.subgroupId = ''; fillSubs(); } }, groups.map((g) => h('option', { value: g.id }, g.name)))),
      h('label', 'Sub-group', subSel)),
    h('label', 'One dish per line: name and price', h('textarea', { rows: 6, placeholder: 'Paneer Tikka 220\nVeg Biryani - 180\nMasala Papad ₹40', oninput: (/** @type {any} */ e) => { f.text = e.target.value; show(); } })),
    prev,
    h('div.row.end', h('button.ghost', { onclick: () => { bulkOpen = false; scheduleRender(); } }, 'Close'),
      h('button.primary', {
        onclick: async () => {
          const ok = parseBulk(f.text).filter((r) => !('bad' in r)).map((r) => ({ name: /** @type {any} */ (r).name, pricePaise: Math.round(/** @type {any} */ (r).price * 100) }));
          if (!ok.length) return toast('Type at least one line like “Paneer Tikka 220”.', 'err');
          const res = await tryRun('menu.item.bulk', { groupId: f.groupId, subgroupId: f.subgroupId || null, items: ok });
          if (res) { toast(`${res.added} dishes added`, 'ok'); bulkOpen = false; scheduleRender(); }
        },
      }, 'Add all')));
}

/** @param {any} [g] */
function groupModal(g) {
  const f = { name: g?.name ?? '' };
  modal(g ? 'Edit group' : 'New group', (close) => [
    inp(f, 'name', 'Name'),
    h('div.row', g ? h('button.danger', { onclick: async () => { if (await confirmBox(`Delete group “${g.name}” and all its dishes?`)) { close(); tryRun('menu.group.delete', { id: g.id }); } } }, 'Delete') : null, h('span.grow'),
      h('button.primary', { onclick: async () => { if (await tryRun('menu.group.save', { id: g?.id, name: f.name, sort: g?.sort }, 'Saved')) close(); } }, 'Save')),
  ]);
}

/** @param {string} groupId @param {any} [s] */
function subgroupModal(groupId, s) {
  const f = { name: s?.name ?? '' };
  modal(s ? 'Edit sub-group' : 'New sub-group', (close) => [
    inp(f, 'name', 'Name'),
    h('div.row', s ? h('button.danger', { onclick: async () => { if (await confirmBox(`Delete sub-group “${s.name}” and its dishes?`)) { close(); tryRun('menu.subgroup.delete', { id: s.id }); } } }, 'Delete') : null, h('span.grow'),
      h('button.primary', { onclick: async () => { if (await tryRun('menu.subgroup.save', { id: s?.id, groupId, name: f.name, sort: s?.sort }, 'Saved')) close(); } }, 'Save')),
  ]);
}

/** Downscale an image file to a ≤512 px JPEG data URL. @param {File} file @returns {Promise<string>} */
function shrink(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(r.error);
    r.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('bad image'));
      img.onload = () => {
        const k = Math.min(1, 512 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.src = String(r.result);
    };
    r.readAsDataURL(file);
  });
}

/** @param {any} it */
function itemModal(it) {
  const f = {
    id: it.id, name: it.name ?? '', code: it.code ?? '', num: it.num ? String(it.num) : '', price: it.pricePaise !== undefined ? (it.pricePaise / 100).toFixed(2) : '',
    groupId: it.groupId, subgroupId: it.subgroupId ?? '', diet: it.diet ?? 'veg', station: it.station ?? 'kitchen', favourite: !!it.favourite,
    available: it.available ?? true, allowSides: !!it.allowSides,
    variants: (it.variants ?? []).map((/** @type {any} */ v) => ({ name: v.name, price: (v.pricePaise / 100).toFixed(2) })),
    /** @type {string | null | undefined} */ imageData: undefined,
  };
  modal(it.id ? 'Edit dish' : 'New dish', (close) => {
    const vbox = h('div');
    const drawV = () => vbox.replaceChildren(...f.variants.map((/** @type {any} */ v, /** @type {number} */ i) => h('div.row',
      h('input', { placeholder: 'e.g. Half / Full / Regular', value: v.name, oninput: (/** @type {any} */ e) => { v.name = e.target.value; } }),
      h('input', { placeholder: '₹', inputmode: 'decimal', value: v.price, oninput: (/** @type {any} */ e) => { v.price = e.target.value; } }),
      h('button.small.ghost', { onclick: () => { f.variants.splice(i, 1); drawV(); } }, '✕'))),
    h('button.small', { onclick: () => { f.variants.push({ name: '', price: '' }); drawV(); } }, '+ Variation (each has its own price)'));
    drawV();
    const subs = list('menu_subgroups').filter((s) => s.groupId === f.groupId).sort(bySort);
    return [
      inp(f, 'name', 'Dish name'),
      h('div.row', inp(f, 'code', 'Short code (3 letters, auto if empty)', { maxlength: 3 }), inp(f, 'num', 'Number (auto if empty)', { inputmode: 'numeric' }), inp(f, 'price', 'Price ₹', { inputmode: 'decimal' })),
      h('div.row',
        h('label', 'Group', h('select', { onchange: (/** @type {any} */ e) => { f.groupId = e.target.value; } }, list('menu_groups').sort(bySort).map((g) => h('option', { value: g.id, selected: g.id === f.groupId }, g.name)))),
        h('label', 'Sub-group', h('select', { onchange: (/** @type {any} */ e) => { f.subgroupId = e.target.value; } }, h('option', { value: '' }, '—'), subs.map((s) => h('option', { value: s.id, selected: s.id === f.subgroupId }, s.name))))),
      h('div.row',
        h('label', 'Mark', h('select', { onchange: (/** @type {any} */ e) => { f.diet = e.target.value; } }, Object.entries(DIET_LABEL).map(([d, l]) => h('option', { value: d, selected: d === f.diet }, l)))),
        inp(f, 'station', 'Kitchen station')),
      h('label.radio', h('input', { type: 'checkbox', checked: f.favourite, onchange: (/** @type {any} */ e) => { f.favourite = e.target.checked; } }), 'Favourite ★ (shows in Favorite Items)'),
      h('label.radio', h('input', { type: 'checkbox', checked: f.available, onchange: (/** @type {any} */ e) => { f.available = e.target.checked; } }), 'Available'),
      h('label.radio', h('input', { type: 'checkbox', checked: f.allowSides, onchange: (/** @type {any} */ e) => { f.allowSides = e.target.checked; } }), 'Allow extras (sides) with this dish'),
      h('h4', 'Variations'), vbox,
      h('label', 'Photo', h('input', { type: 'file', accept: 'image/*', onchange: async (/** @type {any} */ e) => { const file = e.target.files?.[0]; if (file) f.imageData = await shrink(file); } })),
      it.image ? h('label.radio', h('input', { type: 'checkbox', onchange: (/** @type {any} */ e) => { f.imageData = e.target.checked ? null : undefined; } }), 'Remove photo') : null,
      h('div.row',
        it.id ? h('button.danger', { onclick: async () => { if (await confirmBox(`Delete ${it.name}?`)) { close(); tryRun('menu.item.delete', { id: it.id }); } } }, 'Delete') : null,
        h('span.grow'),
        h('button.primary', {
          onclick: async () => {
            const r = await tryRun('menu.item.save', {
              id: f.id, name: f.name, code: f.code.trim().toUpperCase(), num: f.num ? parseInt(f.num, 10) : undefined, pricePaise: toPaise(f.price), groupId: f.groupId, subgroupId: f.subgroupId || null,
              diet: f.diet, station: f.station, favourite: f.favourite, available: f.available, allowSides: f.allowSides, sort: it.sort,
              variants: f.variants.filter((/** @type {any} */ v) => v.name.trim()).map((/** @type {any} */ v) => ({ name: v.name, pricePaise: toPaise(v.price) })),
              imageData: f.imageData,
            }, 'Saved');
            if (r) close();
          },
        }, 'Save')),
    ];
  }, { wide: true });
}

// ---------------- extras (sides) & kitchen notes ----------------
function extras() {
  const sides = list('sides').sort(bySort);
  const notes = list('kitchen_notes').sort(bySort);
  /** @param {any} [s] */
  const sideModal = (s) => {
    const f = { name: s?.name ?? '', price: s ? (s.pricePaise / 100).toFixed(2) : '' };
    modal(s ? 'Edit extra' : 'New extra', (close) => [
      inp(f, 'name', 'Extra name (e.g. Cheese, Butter, Curd)'), inp(f, 'price', 'Price ₹', { inputmode: 'decimal' }),
      h('div.row', s ? h('button.danger', { onclick: async () => { close(); tryRun('side.delete', { id: s.id }); } }, 'Delete') : null, h('span.grow'),
        h('button.primary', { onclick: async () => { if (await tryRun('side.save', { id: s?.id, name: f.name, pricePaise: toPaise(f.price) }, 'Saved')) close(); } }, 'Save')),
    ]);
  };
  return h('div',
    h('div.toolbar', h('h3', `Extras / sides (${sides.length})`), h('span.grow'), h('button', { onclick: () => sideModal() }, '+ Extra')),
    h('p.small.muted', 'Extras are offered with dishes that have “Allow extras” switched on. Each extra has its own quantity.'),
    h('table.list', sides.map((s) => h('tr.click', { onclick: () => sideModal(s) }, h('td', s.name), h('td', money(s.pricePaise))))),
    h('div.toolbar', h('h3', `Kitchen notes (${notes.length})`), h('span.grow'),
      h('button', { onclick: async () => { const t = await ask('New kitchen note', { placeholder: 'e.g. Less Spicy' }); if (t) tryRun('kitchen_note.save', { text: t }); } }, '+ Note')),
    h('div.chips', notes.map((n) => h('span.chip', n.text, ' ',
      h('button.small.ghost', { onclick: async () => { const t = await ask('Edit note', { value: n.text }); if (t) tryRun('kitchen_note.save', { id: n.id, text: t, sort: n.sort }); } }, '✎'),
      h('button.small.ghost', { onclick: async () => { if (await confirmBox(`Delete note “${n.text}”?`)) tryRun('kitchen_note.delete', { id: n.id }); } }, '✕')))));
}

// ---------------- layout (legacy table-layout builder) ----------------
/** @type {Record<string, any>} per-section form state */
const lf = {};
function layout() {
  const sections = list('sections').sort(bySort);
  return h('div',
    h('div.toolbar', h('h3', `Sections (${sections.length}/10)`), h('span.grow'),
      sections.length < 10 ? h('button', { onclick: async () => { const n = await ask('Section name', { placeholder: 'e.g. AC Hall, Garden' }); if (n) tryRun('layout.section.save', { name: n, enabled: false }); } }, '+ Section') : null),
    h('p.small.muted', 'Switch a section on, set rows × tables per row, seats per row (e.g. “4,6” — the last value repeats), then tap Build tables. Tap a table to rename it, change seats or make it a standing table.'),
    sections.map((s) => {
      const tables = list('dining_tables').filter((t) => t.sectionId === s.id).sort((a, b) => a.rowNo - b.rowNo || a.sort - b.sort);
      const f = (lf[s.id] ??= { name: s.name, prefix: s.prefix ?? '', rows: String(s.rowsCfg ?? 1), cols: String(s.colsCfg ?? 4), seats: s.seatsCfg ?? '4', standing: !!s.standing, startNo: String(s.startNo ?? 1) });
      const cfg = () => ({ id: s.id, name: f.name, sort: s.sort, prefix: f.prefix, rows: parseInt(f.rows, 10) || 1, cols: parseInt(f.cols, 10) || 1, seats: f.seats, standing: !!f.standing, startNo: parseInt(f.startNo, 10) || 1 });
      /** @type {Map<number, any[]>} */
      const rows = new Map();
      for (const t of tables) rows.set(t.rowNo, [...(rows.get(t.rowNo) ?? []), t]);
      const lastRow = Math.max(0, ...rows.keys());
      return h('div.group.sec-ed' + (s.enabled ? '' : '.off'),
        h('div.toolbar',
          h('label.switch', h('input', { type: 'checkbox', checked: !!s.enabled, onchange: (/** @type {any} */ e) => tryRun('layout.section.save', { ...cfg(), enabled: e.target.checked }) }), h('span', s.enabled ? 'On' : 'Off')),
          h('b', s.name), h('small.muted', ` ${tables.length} tables`), h('span.grow'),
          tables.length ? null : h('button.small.danger', { onclick: () => tryRun('layout.section.delete', { id: s.id }) }, 'Delete section')),
        h('div.row.wrap',
          inp(f, 'name', 'Name'), inp(f, 'prefix', 'Table prefix', { maxlength: 6, placeholder: 'e.g. G' }),
          inp(f, 'rows', 'Rows', { inputmode: 'numeric' }), inp(f, 'cols', 'Tables per row', { inputmode: 'numeric' }),
          inp(f, 'seats', 'Seats per row', { placeholder: '4,6' }), inp(f, 'startNo', 'Start number', { inputmode: 'numeric' }),
          h('label.radio', h('input', { type: 'checkbox', checked: f.standing, onchange: (/** @type {any} */ e) => { f.standing = e.target.checked; } }), 'Standing tables')),
        h('div.row',
          h('button.small', { onclick: () => tryRun('layout.section.save', { ...cfg(), enabled: !!s.enabled }, 'Saved') }, 'Save'),
          h('button.small.primary', {
            onclick: async () => {
              if (tables.length && !(await confirmBox(`Rebuild the tables of ${s.name}? Names are numbered again from ${f.prefix}${f.startNo}.`))) return;
              if (await tryRun('layout.section.save', { ...cfg(), enabled: !!s.enabled })) tryRun('layout.section.build', { id: s.id }, 'Tables built');
            },
          }, 'Build tables')),
        [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([rn, ts]) => h('div.trow.ed',
          h('small.muted', `Row ${rn + 1}`),
          ts.map((t) => h('button.tbl.blank.small', { onclick: () => tableModal(s, t) }, h('div.tn', t.name), h('div.ts', t.standing ? 'Standing' : `${t.seats} seats`))),
          h('button.small.ghost', { onclick: () => tableModal(s, null, rn) }, '+ Table'))),
        h('button.small.ghost', { onclick: () => tableModal(s, null, tables.length ? lastRow + 1 : 0) }, '+ Row'));
    }));
}

/** @param {any} s section @param {any} t table or null (new) @param {number} [rowNo] */
function tableModal(s, t, rowNo) {
  const f = { name: t?.name ?? '', seats: String(t?.seats || 4), standing: !!t?.standing };
  modal(t ? `Table ${t.name}` : `New table in ${s.name}`, (close) => [
    inp(f, 'name', 'Table name'),
    inp(f, 'seats', 'Seats', { inputmode: 'numeric' }),
    h('label.radio', h('input', { type: 'checkbox', checked: f.standing, onchange: (/** @type {any} */ e) => { f.standing = e.target.checked; } }), 'Standing table (no seats)'),
    h('div.row',
      t ? h('button.danger', { onclick: async () => { if (await confirmBox(`Delete table ${t.name}?`)) { close(); tryRun('layout.table.delete', { id: t.id }, 'Deleted'); } } }, 'Delete') : null,
      h('span.grow'),
      h('button.primary', {
        onclick: async () => {
          const r = await tryRun('layout.table.save', { id: t?.id, sectionId: s.id, name: f.name.trim(), seats: Math.max(1, parseInt(f.seats, 10) || 4), standing: f.standing, rowNo: t ? t.rowNo : rowNo }, 'Saved');
          if (r) close();
        },
      }, 'Save')),
  ]);
}

// ---------------- users & roles ----------------
function users() {
  const roles = list('roles').sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  return h('div',
    h('div.toolbar', h('h3', 'Users'), h('span.grow'), h('button', { onclick: () => userModal() }, '+ User')),
    h('table.list', list('users').sort((a, b) => a.name.localeCompare(b.name)).map((u) => h('tr.click', { onclick: () => userModal(u) },
      h('td', u.name), h('td', byId('roles', u.roleId)?.name ?? u.roleId), h('td', u.active ? '' : 'inactive')))),
    h('div.toolbar', h('h3', 'Roles & rights'), h('span.grow'), h('button', { onclick: () => roleModal() }, '+ Custom role')),
    h('table.list', roles.map((r) => h('tr' + (r.id === 'owner' ? '' : '.click'), { onclick: () => r.id !== 'owner' && roleModal(r) },
      h('td', h('b', r.name), r.builtin ? h('small', ' built-in') : null), h('td.small', (r.rights ?? []).join(', '))))));
}

/** @param {any} [u] */
function userModal(u) {
  const f = { name: u?.name ?? '', roleId: u?.roleId ?? 'captain', pin: '', active: u ? !!u.active : true };
  modal(u ? 'Edit user' : 'New user', (close) => [
    inp(f, 'name', 'Name'),
    h('label', 'Role', h('select', { onchange: (/** @type {any} */ e) => { f.roleId = e.target.value; } }, list('roles').map((r) => h('option', { value: r.id, selected: r.id === f.roleId }, r.name)))),
    inp(f, 'pin', u ? 'New PIN (leave empty to keep)' : 'PIN (4–8 digits)', { type: 'password', inputmode: 'numeric' }),
    u ? h('label.radio', h('input', { type: 'checkbox', checked: f.active, onchange: (/** @type {any} */ e) => { f.active = e.target.checked; } }), 'Active') : null,
    h('div.row',
      u ? h('button', { onclick: () => tryRun('user.unlock', { id: u.id }, 'Unlocked') }, 'Unlock') : null,
      h('span.grow'),
      h('button.primary', {
        onclick: async () => {
          const r = await tryRun('user.save', { id: u?.id, name: f.name, roleId: f.roleId, active: f.active, ...(f.pin ? { pin: f.pin } : {}) }, 'Saved');
          if (r) close();
        },
      }, 'Save')),
  ]);
}

/** @param {any} [r] */
function roleModal(r) {
  const f = { name: r?.name ?? '', rights: new Set(r?.rights ?? []) };
  modal(r ? `Role: ${r.name}` : 'New role', (close) => [
    inp(f, 'name', 'Name'),
    h('div.rights', RIGHTS.map((x) => h('label.radio', h('input', { type: 'checkbox', checked: f.rights.has(x), onchange: (/** @type {any} */ e) => { e.target.checked ? f.rights.add(x) : f.rights.delete(x); } }), x))),
    h('p.small.muted', 'Saving logs out users with this role so new rights apply.'),
    h('button.primary', { onclick: async () => { if (await tryRun('role.save', { id: r?.id, name: f.name, rights: [...f.rights] }, 'Saved')) close(); } }, 'Save'),
  ], { wide: true });
}

// ---------------- settings ----------------
/** @type {Record<string, any> | null} form state survives live re-renders */
let sf = null;
function settings() {
  const s = store.settings;
  const f = (sf ??= {
    ...s, printers: JSON.parse(JSON.stringify(s.printers ?? {})), fallbackHosts: (s.fallbackHosts ?? []).join(', '),
    taxes: (s.taxes ?? []).map((/** @type {any} */ t) => ({ name: t.name, rate: String(t.rate) })),
    otherTypes: [...(s.otherTypes ?? [])], custTags: (s.custTags ?? []).map((/** @type {any} */ t) => ({ ...t, disc: String(t.disc) })),
    defaultDelivery: String((s.defaultDelivery ?? 0)),
  });
  const text = /** @type {[string, string][]} */ ([['name', 'Restaurant name'], ['address', 'Address'], ['phone', 'Phone'], ['gstin', 'GSTIN'], ['fssai', 'FSSAI'], ['placeOfSupply', 'Place of supply (state)'], ['sacCode', 'SAC'], ['footer', 'Bill footer'], ['billPrefix', 'Bill prefix (≤3, e.g. KK1)'], ['supportPhone', 'Support phone'], ['supportEmail', 'Support e-mail']]);
  const nums = /** @type {[string, string][]} */ ([['serviceChargePct', 'Service charge % (opt-in per bill, 0 = hide)'], ['dayStartHour', 'Business day starts at (hour)']]);
  const flags = /** @type {[string, string][]} */ ([
    ['taxOnDelivery', 'Charge tax on the delivery charge too'],
    ['askCustomer', 'Ask customer name & mobile before printing the bill'],
    ['reasonAll', 'Ask a reason when deleting any item (also items not yet sent to the kitchen)'],
    ['allowOpenItem', 'Allow “Open Item” (dish not in the menu, type name & price)'],
    ['specifiedPremises', 'Specified premises (18% GST) — only if your CA confirms'],
    ['compositionScheme', 'Composition scheme (Bill of Supply, no tax lines)'],
    ['kotAutoPrint', 'Auto-print KOTs on the LAN kitchen printer'],
  ]);
  const stations = [...new Set(['kitchen', 'bill', ...list('items').map((i) => i.station || 'kitchen'), ...Object.keys(f.printers)])];
  const save = async () => {
    /** @type {Record<string, any>} */
    const patch = {};
    for (const [k] of text) if ((f[k] ?? '') !== (s[k] ?? '')) patch[k] = String(f[k] ?? '');
    for (const [k] of nums) if (Number(f[k]) !== s[k]) patch[k] = Number(f[k]);
    for (const [k] of flags) if (!!f[k] !== !!s[k]) patch[k] = !!f[k];
    if (Number(f.paper) !== s.paper) patch.paper = Number(f.paper);
    if (f.billPrintMode !== s.billPrintMode) patch.billPrintMode = f.billPrintMode;
    const dd = Number(f.defaultDelivery) || 0;
    if (dd !== s.defaultDelivery) patch.defaultDelivery = dd;
    const taxes = f.taxes.filter((/** @type {any} */ t) => t.name.trim()).map((/** @type {any} */ t) => ({ name: t.name.trim(), rate: Number(t.rate) || 0 }));
    if (JSON.stringify(taxes) !== JSON.stringify(s.taxes ?? [])) patch.taxes = taxes;
    const ot = f.otherTypes.map((/** @type {string} */ x) => x.trim()).filter(Boolean);
    if (JSON.stringify(ot) !== JSON.stringify(s.otherTypes ?? [])) patch.otherTypes = ot;
    const tags = f.custTags.filter((/** @type {any} */ t) => t.name.trim()).map((/** @type {any} */ t) => ({ id: t.id, name: t.name.trim(), disc: Number(t.disc) || 0 }));
    if (JSON.stringify(tags) !== JSON.stringify(s.custTags ?? [])) patch.custTags = tags;
    /** @type {Record<string, any>} */
    const printers = {};
    for (const [k, v] of Object.entries(f.printers)) if (/** @type {any} */ (v).ip) printers[k] = { ip: String(/** @type {any} */ (v).ip).trim(), port: Number(/** @type {any} */ (v).port) || 9100 };
    if (JSON.stringify(printers) !== JSON.stringify(s.printers ?? {})) patch.printers = printers;
    const fh = String(f.fallbackHosts).split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
    if (JSON.stringify(fh) !== JSON.stringify(s.fallbackHosts ?? [])) patch.fallbackHosts = fh;
    if (!Object.keys(patch).length) return toast('No changes');
    if (await tryRun('settings.update', { patch }, 'Settings saved') !== null) { sf = null; scheduleRender(); }
  };
  /** @param {string} k @param {string} label */
  const check = (k, label) => h('label.radio', h('input', { type: 'checkbox', checked: !!f[k], onchange: (/** @type {any} */ e) => { f[k] = e.target.checked; } }), label);
  return h('div.form',
    text.map(([k, label]) => inp(f, k, label)),
    h('h4', 'Taxes'),
    h('table.list', f.taxes.map((/** @type {any} */ t, /** @type {number} */ i) => h('tr',
      h('td', h('input', { value: t.name, placeholder: 'e.g. CGST', oninput: (/** @type {any} */ e) => { t.name = e.target.value; } })),
      h('td', h('input.w8', { value: t.rate, inputmode: 'decimal', placeholder: '%', oninput: (/** @type {any} */ e) => { t.rate = e.target.value; } })), h('td', '%'),
      h('td', h('button.small.ghost', { onclick: () => { f.taxes.splice(i, 1); scheduleRender(); } }, '✕'))))),
    f.taxes.length < 6 ? h('button.small', { onclick: () => { f.taxes.push({ name: '', rate: '' }); scheduleRender(); } }, '+ Tax') : null,
    h('div.row', inp(f, 'defaultDelivery', 'Default delivery charge ₹', { inputmode: 'decimal' }), nums.map(([k, label]) => inp(f, k, label, { inputmode: 'decimal' }))),
    flags.map(([k, label]) => check(k, label)),
    h('h4', 'Payment “Other” types'),
    h('div.chips', f.otherTypes.map((/** @type {string} */ t, /** @type {number} */ i) => h('span.chip', t, ' ', f.otherTypes.length > 1 ? h('button.small.ghost', { onclick: () => { f.otherTypes.splice(i, 1); scheduleRender(); } }, '✕') : null)),
      h('button.chip', { onclick: async () => { const t = await ask('New payment type', { placeholder: 'e.g. Paytm, Sodexo' }); if (t) { f.otherTypes.push(t); scheduleRender(); } } }, '+ Type')),
    h('h4', 'Customer tags (with discount %)'),
    h('table.list', f.custTags.map((/** @type {any} */ t, /** @type {number} */ i) => h('tr',
      h('td', h('input', { value: t.name, placeholder: 'e.g. Staff, Regular', oninput: (/** @type {any} */ e) => { t.name = e.target.value; } })),
      h('td', h('input.w8', { value: t.disc, inputmode: 'decimal', oninput: (/** @type {any} */ e) => { t.disc = e.target.value; } })), h('td', '%'),
      h('td', h('button.small.ghost', { onclick: () => { f.custTags.splice(i, 1); scheduleRender(); } }, '✕'))))),
    h('button.small', { onclick: () => { f.custTags.push({ id: 't' + Date.now().toString(36), name: '', disc: '0' }); scheduleRender(); } }, '+ Tag'),
    h('h4', 'Printing'),
    h('div.row',
      h('label', 'Paper', h('select', { onchange: (/** @type {any} */ e) => { f.paper = e.target.value; } }, [58, 80].map((p) => h('option', { value: p, selected: Number(f.paper) === p }, p + ' mm')))),
      h('label', 'Default print mode', h('select', { onchange: (/** @type {any} */ e) => { f.billPrintMode = e.target.value; } }, MODES.map((m) => h('option', { value: m, selected: f.billPrintMode === m }, m))))),
    h('h4', 'LAN printers (ESC/POS, port 9100)'),
    stations.map((st) => {
      f.printers[st] ??= { ip: '', port: 9100 };
      const p = f.printers[st];
      return h('div.row', h('b.w8', st),
        h('input', { placeholder: 'IP e.g. 192.168.1.50', value: p.ip, oninput: (/** @type {any} */ e) => { p.ip = e.target.value; } }),
        h('input.w8', { placeholder: '9100', inputmode: 'numeric', value: p.port, oninput: (/** @type {any} */ e) => { p.port = e.target.value; } }));
    }),
    inp(f, 'fallbackHosts', 'Fallback host URLs (comma separated, e.g. http://192.168.1.20:8080)'),
    h('div.row', h('button.primary', { onclick: save }, 'Save settings'), h('button.ghost', { onclick: () => { sf = null; scheduleRender(); } }, 'Discard changes')),
    h('p.small.muted', 'GST/compliance notes are not tax advice — your CA confirms the GST treatment.'));
}

// ---------------- devices ----------------
/** @type {any} */
let hostInfo = null;
function devices() {
  if (!hostInfo) api('/api/info').then((i) => { hostInfo = i; scheduleRender(); }).catch(() => {});
  const addDevice = async (/** @type {string} */ kind) => {
    const r = await tryRun('pair.create', { kind });
    if (!r) return;
    const ip = hostInfo?.ips?.[0];
    const base = ip ? `http://${ip}:${hostInfo.port}` : location.origin;
    const url = `${base}/pair?code=${r.code}${kind === 'kds' ? '&kind=kds' : ''}`;
    modal('Pair a new phone', () => h('div.c',
      h('p', 'On the new phone open Chrome and scan, or type the code on its pair page.'),
      qrSvg(url, 260),
      h('div.code-big', r.code),
      h('p.small', url, ' ', h('button.small.ghost', { onclick: () => copyText(url) }, 'Copy')),
      h('p.small.muted', `Expires ${new Date(r.expiresAt).toLocaleTimeString('en-IN', { hour12: false })} (5 min, one use)`)));
  };
  return h('div',
    h('div.toolbar', h('h3', 'Paired phones'), h('span.grow'),
      h('button', { onclick: () => addDevice('staff') }, '+ Staff phone'),
      h('button', { onclick: () => addDevice('kds') }, '+ Kitchen screen')),
    h('table.list', list('devices').sort((a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name)).map((d) => h('tr' + (d.revoked ? '.void' : ''),
      h('td', d.name, d.id === me.device?.id ? h('small', ' (this phone)') : null), h('td', d.kind),
      h('td.small', d.lastSeen ? new Date(d.lastSeen).toLocaleString('en-IN', { hour12: false }) : '—'),
      h('td', d.revoked ? 'revoked' : [
        h('button.small', { onclick: async () => { const n = await ask('Rename', { value: d.name }); if (n) tryRun('device.rename', { deviceId: d.id, name: n }); } }, '✎'),
        d.id !== me.device?.id ? h('button.small.danger', { onclick: async () => { if (await confirmBox(`Revoke ${d.name}? It is disconnected immediately.`)) tryRun('device.revoke', { deviceId: d.id }, 'Revoked'); } }, 'Revoke') : null,
      ])))),
    hostInfo ? h('p.small', 'Host addresses: ', hostInfo.ips.map((/** @type {string} */ ip) => `http://${ip}:${hostInfo.port}`).join(' · ') || location.origin, ' — ', h('a', { href: '#/join' }, 'Join QR')) : null);
}

// ---------------- backups ----------------
/** @type {any} */
let bk = null;
function backups() {
  if (!bk && can('settings')) api('/api/backups', { auth: authHeaders() }).then((r) => { bk = r; scheduleRender(); }).catch((e) => toast(e.message, 'err'));
  return h('div',
    h('div.toolbar', h('h3', 'Backups'), h('span.grow'),
      can('settings') ? h('button', { onclick: async () => { try { await api('/api/backups', { method: 'POST', auth: authHeaders() }); toast('Backup done', 'ok'); bk = null; scheduleRender(); } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); } } }, 'Backup now') : null,
      can('export') ? h('button', {
        onclick: async () => {
          const r = await fetch('/api/export/json', { headers: { 'x-device-token': authHeaders().deviceToken ?? '', 'x-session-token': authHeaders().sessionToken ?? '' } });
          download(await r.blob(), `khanakhajana-export-${store.businessDate}.json`);
        },
      }, 'Export JSON') : null),
    h('p.small.muted', 'Nightly backup after 03:00 and at every day close; last 30 kept in data/backups/. Copy them off the phone regularly.'),
    can('settings') ? h('div.group',
      h('h4', 'Import from the old billing app (KHANAKHAJANA_Billing .html)'),
      h('p.small.muted', 'In the old app use Backup › Download backup (.json), then choose that file here. Menu, tables, staff, customers, dues and all old bills are copied. A backup of this host is taken first.'),
      h('input#legacy-file', {
        type: 'file', accept: '.json,application/json',
        onchange: async (/** @type {any} */ e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (!(await confirmBox(`Import “${file.name}”? Menu, tables and settings are replaced by the old app's; all phones reload.`))) { e.target.value = ''; return; }
          try {
            const a = authHeaders();
            const r = await fetch('/api/import/legacy', { method: 'POST', body: await file.arrayBuffer(), headers: { 'Content-Type': 'application/json', 'x-device-token': a.deviceToken ?? '', 'x-session-token': a.sessionToken ?? '' } });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) throw new Error(data?.error?.msg || r.statusText);
            const c = data.imported ?? {};
            toast(data.skipped ? 'This backup was already imported.' : `Imported: ${c.items ?? 0} dishes, ${c.bills ?? 0} bills, ${c.users ?? 0} staff, ${c.customers ?? 0} customers`, 'ok', 8000);
            setTimeout(() => location.reload(), 2500);
          } catch (err) { toast('Import failed: ' + /** @type {Error} */ (err).message, 'err', 8000); }
        },
      })) : null,
    bk ? h('table.list', bk.backups.map((/** @type {any} */ b) => h('tr',
      h('td', b.file), h('td.small', (b.size / 1024).toFixed(0) + ' KB'), h('td.small', new Date(b.ts).toLocaleString('en-IN', { hour12: false })),
      h('td',
        h('button.small', {
          onclick: async () => {
            const r = await fetch('/api/backups/download?file=' + encodeURIComponent(b.file), { headers: { 'x-device-token': authHeaders().deviceToken ?? '', 'x-session-token': authHeaders().sessionToken ?? '' } });
            download(await r.blob(), b.file);
          },
        }, '⬇'),
        h('button.small.danger', {
          onclick: async () => {
            const typed = await ask(`Restore ${b.file}? Everything after it is replaced (a pre-restore backup is taken first). Type RESTORE`);
            if (typed !== 'RESTORE') return;
            try { await api('/api/restore', { body: { file: b.file, confirm: 'RESTORE' }, auth: authHeaders() }); toast('Restored — all phones resync', 'ok', 6000); bk = null; } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
          },
        }, 'Restore'))))) : null);
}

// ---------------- printing ----------------
/** @type {any[] | null} */
let jobs = null;
function printing() {
  if (jobs === null && (can('settings') || can('bill'))) api('/api/print/jobs', { auth: authHeaders() }).then((r) => { jobs = r.jobs; scheduleRender(); }).catch(() => { jobs = []; });
  return h('div',
    h('h3', 'This phone prints via'),
    h('div.chips', MODES.map((m) => h('button.chip' + (printMode() === m ? '.on' : ''), { onclick: () => { setPrintMode(m); scheduleRender(); } }, m))),
    h('ul.small',
      h('li', h('b', 'host-lan'), ': the host sends ESC/POS to a Wi-Fi/LAN printer on port 9100 (recommended).'),
      h('li', h('b', 'rawbt'), ': this phone hands ESC/POS bytes to the RawBT app (Bluetooth/USB printers).'),
      h('li', h('b', 'browser'), ': Chrome print dialog with 58/80 mm layout (universal fallback).')),
    h('button', { onclick: () => testPrint() }, 'Test print'),
    jobs?.length ? [h('h3', 'Recent host print jobs'), h('table.list', jobs.slice().reverse().map((j) => h('tr',
      h('td', j.label), h('td', `${j.ip}:${j.port}`), h('td', h('span.tag.' + j.status, j.status)), h('td.small', j.error ?? ''),
      h('td', j.status === 'failed' ? h('button.small', { onclick: async () => { await api('/api/print/retry', { body: { id: j.id }, auth: authHeaders() }); jobs = null; scheduleRender(); } }, 'Retry') : null))))] : null,
    h('button.ghost.small', { onclick: () => { jobs = null; scheduleRender(); } }, 'Refresh jobs'));
}

