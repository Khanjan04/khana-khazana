// @ts-check
// Admin screens (Day 19): menu, layout, users & roles, settings, devices, backups, printing.
import { h } from '../h.js';
import { api } from '../net.js';
import { list, store, byId } from '../store.js';
import { authHeaders, can, me } from '../session.js';
import { money, toPaise, modal, tryRun, toast, confirmBox, ask, download, copyText } from '../ui.js';
import { printMode, setPrintMode, testPrint, MODES } from '../print.js';
import { scheduleRender } from '../app.js';
import { qrSvg } from './join.js';

const RIGHTS = ['order', 'kot', 'bill', 'discount', 'delivery', 'void', 'history', 'reports', 'kitchen', 'layout', 'menu', 'users', 'settings',
  'kitchen.status', 'serve', 'kot.reprint', 'table.transfer', 'bill.reprint', 'dayclose', 'approve', 'stock', 'customers.due', 'device.manage', 'export'];

const TABS = /** @type {[string, string, () => boolean][]} */ ([
  ['menu', 'Menu', () => can('menu')],
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
  const body = { menu, layout, users, settings, devices, backups, printing }[cur]?.() ?? h('div');
  return h('main.panel',
    h('div.tabs', avail.map(([id, label]) => h('button' + (cur === id ? '.on' : ''), { onclick: () => { tab = id; scheduleRender(); } }, label))),
    body);
}

// ---------------- menu ----------------
function menu() {
  const groups = list('menu_groups').sort(bySort);
  const items = list('items').filter((i) => i.active);
  return h('div',
    h('div.toolbar', h('h3', `Groups (${groups.length}/12)`), h('span.grow'), h('button', { onclick: () => groupModal() }, '+ Group')),
    groups.map((g) => {
      const subs = list('menu_subgroups').filter((s) => s.groupId === g.id).sort(bySort);
      const its = items.filter((i) => i.groupId === g.id).sort(bySort);
      return h('details.group', { open: true },
        h('summary', h('b', g.name), ` · ${its.length} items`, ' ',
          h('button.small', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); groupModal(g); } }, 'Edit'),
          h('button.small', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); subgroupModal(g.id); } }, '+ Sub-group'),
          h('button.small.primary', { onclick: (/** @type {Event} */ e) => { e.preventDefault(); itemModal({ groupId: g.id }); } }, '+ Item')),
        subs.length ? h('div.chips', subs.map((s) => h('button.chip', { onclick: () => subgroupModal(g.id, s) }, s.name + ' ✎'))) : null,
        h('table.list', its.map((i) => h('tr.click', { onclick: () => itemModal(i) },
          h('td', h('span.diet.' + i.diet)), h('td', i.code ? '#' + i.code : ''), h('td', i.name, i.favourite ? ' ★' : ''),
          h('td', i.subgroupId ? byId('menu_subgroups', i.subgroupId)?.name ?? '' : ''), h('td', i.station), h('td', money(i.pricePaise))))));
    }),
    h('p.small', `${items.length}/100 items`),
    h('div.toolbar', h('h3', 'Kitchen note chips'), h('span.grow'), h('button', { onclick: async () => { const t = await ask('Note text'); if (t) tryRun('kitchen_note.save', { text: t }); } }, '+ Note')),
    h('div.chips', list('kitchen_notes').sort(bySort).map((n) => h('button.chip', { onclick: async () => { if (await confirmBox(`Delete note "${n.text}"?`)) tryRun('kitchen_note.delete', { id: n.id }); } }, n.text + ' ✕'))));
}

/** @param {any} [g] */
function groupModal(g) {
  const f = { name: g?.name ?? '', sort: String(g?.sort ?? 0) };
  modal(g ? 'Edit group' : 'New group', (close) => [
    inp(f, 'name', 'Name'), inp(f, 'sort', 'Sort', { inputmode: 'numeric' }),
    h('div.row', g ? h('button.danger', { onclick: async () => { if (await confirmBox('Delete group?')) { close(); tryRun('menu.group.delete', { id: g.id }); } } }, 'Delete') : null, h('span.grow'),
      h('button.primary', { onclick: async () => { if (await tryRun('menu.group.save', { id: g?.id, name: f.name, sort: parseInt(f.sort, 10) || 0 }, 'Saved')) close(); } }, 'Save')),
  ]);
}

/** @param {string} groupId @param {any} [s] */
function subgroupModal(groupId, s) {
  const f = { name: s?.name ?? '', sort: String(s?.sort ?? 0) };
  modal(s ? 'Edit sub-group' : 'New sub-group', (close) => [
    inp(f, 'name', 'Name'), inp(f, 'sort', 'Sort', { inputmode: 'numeric' }),
    h('div.row', s ? h('button.danger', { onclick: async () => { close(); tryRun('menu.subgroup.delete', { id: s.id }); } }, 'Delete') : null, h('span.grow'),
      h('button.primary', { onclick: async () => { if (await tryRun('menu.subgroup.save', { id: s?.id, groupId, name: f.name, sort: parseInt(f.sort, 10) || 0 }, 'Saved')) close(); } }, 'Save')),
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
    id: it.id, name: it.name ?? '', code: it.code ?? '', price: it.pricePaise !== undefined ? (it.pricePaise / 100).toFixed(2) : '',
    groupId: it.groupId, subgroupId: it.subgroupId ?? '', diet: it.diet ?? 'veg', station: it.station ?? 'kitchen', favourite: !!it.favourite, sort: String(it.sort ?? 0),
    variants: (it.variants ?? []).map((/** @type {any} */ v) => ({ name: v.name, price: (v.pricePaise / 100).toFixed(2) })),
    extras: (it.extras ?? []).map((/** @type {any} */ v) => ({ name: v.name, price: (v.pricePaise / 100).toFixed(2) })),
    /** @type {string | null | undefined} */ imageData: undefined,
  };
  modal(it.id ? 'Edit item' : 'New item', (close) => {
    /** @param {'variants'|'extras'} key */
    const rows = (key) => {
      const box = h('div');
      const draw = () => box.replaceChildren(...f[key].map((/** @type {any} */ v, /** @type {number} */ i) => h('div.row',
        h('input', { placeholder: 'Name', value: v.name, oninput: (/** @type {any} */ e) => { v.name = e.target.value; } }),
        h('input', { placeholder: '₹', inputmode: 'decimal', value: v.price, oninput: (/** @type {any} */ e) => { v.price = e.target.value; } }),
        h('button.small.ghost', { onclick: () => { f[key].splice(i, 1); draw(); } }, '✕'))),
        h('button.small', { onclick: () => { f[key].push({ name: '', price: '' }); draw(); } }, key === 'variants' ? '+ Variant (replaces price)' : '+ Extra (adds to price)'));
      draw();
      return box;
    };
    const subs = list('menu_subgroups').filter((s) => s.groupId === f.groupId).sort(bySort);
    return [
      inp(f, 'name', 'Name'),
      h('div.row', inp(f, 'code', 'Short code'), inp(f, 'price', 'Price ₹', { inputmode: 'decimal' })),
      h('div.row',
        h('label', 'Group', h('select', { onchange: (/** @type {any} */ e) => { f.groupId = e.target.value; } }, list('menu_groups').sort(bySort).map((g) => h('option', { value: g.id, selected: g.id === f.groupId }, g.name)))),
        h('label', 'Sub-group', h('select', { onchange: (/** @type {any} */ e) => { f.subgroupId = e.target.value; } }, h('option', { value: '' }, '—'), subs.map((s) => h('option', { value: s.id, selected: s.id === f.subgroupId }, s.name))))),
      h('div.row',
        h('label', 'Diet', h('select', { onchange: (/** @type {any} */ e) => { f.diet = e.target.value; } }, ['veg', 'nonveg', 'egg'].map((d) => h('option', { value: d, selected: d === f.diet }, d)))),
        inp(f, 'station', 'Kitchen station'),
        inp(f, 'sort', 'Sort', { inputmode: 'numeric' })),
      h('label.radio', h('input', { type: 'checkbox', checked: f.favourite, onchange: (/** @type {any} */ e) => { f.favourite = e.target.checked; } }), 'Favourite ★'),
      h('h4', 'Variants'), rows('variants'),
      h('h4', 'Extras'), rows('extras'),
      h('label', 'Photo', h('input', { type: 'file', accept: 'image/*', onchange: async (/** @type {any} */ e) => { const file = e.target.files?.[0]; if (file) f.imageData = await shrink(file); } })),
      it.image ? h('label.radio', h('input', { type: 'checkbox', onchange: (/** @type {any} */ e) => { f.imageData = e.target.checked ? null : undefined; } }), 'Remove photo') : null,
      h('div.row',
        it.id ? h('button.danger', { onclick: async () => { if (await confirmBox(`Delete ${it.name}?`)) { close(); tryRun('menu.item.delete', { id: it.id }); } } }, 'Delete') : null,
        h('span.grow'),
        h('button.primary', {
          onclick: async () => {
            const r = await tryRun('menu.item.save', {
              id: f.id, name: f.name, code: f.code, pricePaise: toPaise(f.price), groupId: f.groupId, subgroupId: f.subgroupId || null,
              diet: f.diet, station: f.station, favourite: f.favourite, sort: parseInt(f.sort, 10) || 0,
              variants: f.variants.filter((/** @type {any} */ v) => v.name.trim()).map((/** @type {any} */ v) => ({ name: v.name, pricePaise: toPaise(v.price) })),
              extras: f.extras.filter((/** @type {any} */ v) => v.name.trim()).map((/** @type {any} */ v) => ({ name: v.name, pricePaise: toPaise(v.price) })),
              imageData: f.imageData,
            }, 'Saved');
            if (r) close();
          },
        }, 'Save')),
    ];
  }, { wide: true });
}

// ---------------- layout ----------------
function layout() {
  const sections = list('sections').sort(bySort);
  return h('div',
    h('div.toolbar', h('h3', `Sections (${sections.length}/10)`), h('span.grow'),
      h('button', { onclick: async () => { const n = await ask('Section name', { placeholder: 'e.g. AC Hall, Garden' }); if (n) tryRun('layout.section.save', { name: n }); } }, '+ Section')),
    sections.map((s) => {
      const tables = list('dining_tables').filter((t) => t.sectionId === s.id).sort(bySort);
      return h('div.group',
        h('div.toolbar', h('b', s.name),
          h('button.small', { onclick: async () => { const n = await ask('Rename section', { value: s.name }); if (n) tryRun('layout.section.save', { id: s.id, name: n, sort: s.sort }); } }, '✎'),
          tables.length ? null : h('button.small.danger', { onclick: () => tryRun('layout.section.delete', { id: s.id }) }, 'Delete'),
          h('span.grow'),
          h('button.small', {
            onclick: async () => {
              const n = await ask('Table names (comma separated, or a range like 1-10)', { placeholder: '1-10' });
              if (!n) return;
              const m = /^(\d+)\s*-\s*(\d+)$/.exec(n.trim());
              const names = m ? Array.from({ length: Math.min(60, +m[2] - +m[1] + 1) }, (_, i) => String(+m[1] + i)) : n.split(',').map((x) => x.trim()).filter(Boolean);
              for (const [i, name] of names.entries()) await tryRun('layout.table.save', { sectionId: s.id, name, sort: tables.length + i });
            },
          }, '+ Tables')),
        h('div.chips', tables.map((t) => h('button.chip', {
          onclick: async () => {
            const n = await ask(`Table ${t.name}: new name (or DELETE)`, { value: t.name });
            if (n === 'DELETE') tryRun('layout.table.delete', { id: t.id });
            else if (n) tryRun('layout.table.save', { id: t.id, sectionId: s.id, name: n, seats: t.seats, sort: t.sort });
          },
        }, t.name))));
    }));
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
  const f = (sf ??= { ...s, printers: JSON.parse(JSON.stringify(s.printers ?? {})), fallbackHosts: (s.fallbackHosts ?? []).join(', ') });
  const text = /** @type {[string, string][]} */ ([['name', 'Restaurant name'], ['address', 'Address'], ['phone', 'Phone'], ['gstin', 'GSTIN'], ['fssai', 'FSSAI'], ['placeOfSupply', 'Place of supply (state)'], ['sacCode', 'SAC'], ['footer', 'Bill footer'], ['billPrefix', 'Bill prefix (≤3, e.g. KK1)']]);
  const nums = /** @type {[string, string][]} */ ([['cgst', 'CGST %'], ['sgst', 'SGST %'], ['serviceChargePct', 'Service charge % (opt-in per bill)'], ['dayStartHour', 'Business day starts at (hour)']]);
  const stations = [...new Set(['kitchen', 'bill', ...list('items').map((i) => i.station || 'kitchen'), ...Object.keys(f.printers)])];
  const save = async () => {
    /** @type {Record<string, any>} */
    const patch = {};
    for (const [k] of text) if (f[k] !== s[k]) patch[k] = String(f[k] ?? '');
    for (const [k] of nums) if (Number(f[k]) !== s[k]) patch[k] = Number(f[k]);
    for (const k of ['specifiedPremises', 'compositionScheme', 'kotAutoPrint']) if (!!f[k] !== !!s[k]) patch[k] = !!f[k];
    if (Number(f.paper) !== s.paper) patch.paper = Number(f.paper);
    if (f.billPrintMode !== s.billPrintMode) patch.billPrintMode = f.billPrintMode;
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
    h('div.row', nums.map(([k, label]) => inp(f, k, label, { inputmode: 'decimal' }))),
    check('specifiedPremises', 'Specified premises (18% GST with ITC) — only if your CA confirms'),
    check('compositionScheme', 'Composition scheme (Bill of Supply, no tax lines)'),
    check('kotAutoPrint', 'Auto-print KOTs on the LAN kitchen printer'),
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
    h('p.small.muted', 'GST/compliance notes are not tax advice — the customer\'s CA confirms GST treatment.'));
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

