// @ts-check
// Day 9: menu CRUD with legacy limits, layout CRUD, settings.update, users CRUD; right checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { get } from '../server/db.js';
import { getSettings } from '../server/model.js';
import { LIMITS } from '../server/commands/admin.js';
import { buildSnapshot } from '../server/snapshot.js';

test('menu limits: ≤12 groups, ≤10 sub-groups per group, ≤100 dishes per sub-group', () => {
  const t = setup();
  const groups = [];
  for (let i = 0; i < LIMITS.groups; i++) groups.push(t.cmd('manager', 'menu.group.save', { name: 'G' + i }).id);
  t.code('LIMIT', () => t.cmd('manager', 'menu.group.save', { name: 'one too many' }));
  for (let i = 0; i < LIMITS.subgroups; i++) t.cmd('manager', 'menu.subgroup.save', { groupId: groups[0], name: 'S' + i });
  t.code('LIMIT', () => t.cmd('manager', 'menu.subgroup.save', { groupId: groups[0], name: 'S-x' }));
  t.cmd('manager', 'menu.subgroup.save', { groupId: groups[1], name: 'other group ok' });
  const sg = t.cmd('manager', 'menu.subgroup.save', { groupId: groups[2], name: 'Full' }).id;
  t.cmd('manager', 'menu.item.bulk', { groupId: groups[2], subgroupId: sg, items: Array.from({ length: LIMITS.items }, (_, i) => ({ name: 'Dish ' + i, pricePaise: 100 })) });
  t.code('LIMIT', () => t.cmd('manager', 'menu.item.save', { name: 'I-x', pricePaise: 100, groupId: groups[2], subgroupId: sg }));
  t.cmd('manager', 'menu.item.save', { name: 'Other sub-group is fine', pricePaise: 100, groupId: groups[2] });
  // every dish got a unique 3-letter code and number
  const codes = t.db.prepare('SELECT code, num FROM items WHERE active=1').all();
  assert.equal(new Set(codes.map((/** @type {any} */ c) => c.code)).size, codes.length);
  assert.equal(new Set(codes.map((/** @type {any} */ c) => c.num)).size, codes.length);
  assert.ok(codes.every((/** @type {any} */ c) => /^[A-Z]{3}$/.test(c.code) && c.num >= 1));
});

test('dish save: 3-letter code + number (auto or typed, unique), variants replaced, delete, reorder', () => {
  const t = setup();
  const g = t.cmd('owner', 'menu.group.save', { name: 'Main' }).id;
  const a = t.cmd('owner', 'menu.item.save', { name: 'Paneer Butter Masala', pricePaise: 0, groupId: g, variants: [{ name: 'S', pricePaise: 800 }] }).id;
  const ra = get(t.db, 'SELECT code, num FROM items WHERE id=?', a);
  assert.deepEqual([ra.code, ra.num], ['PBM', 1]);
  const b = t.cmd('owner', 'menu.item.save', { name: 'Pav Bhaji Masala', pricePaise: 15000, groupId: g }).id;
  assert.notEqual(get(t.db, 'SELECT code FROM items WHERE id=?', b).code, 'PBM'); // auto code avoids clashes
  t.code('DUPLICATE', () => t.cmd('owner', 'menu.item.save', { name: 'X', code: 'PBM', pricePaise: 1000, groupId: g }));
  t.code('DUPLICATE', () => t.cmd('owner', 'menu.item.save', { name: 'X', num: 1, pricePaise: 1000, groupId: g }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'menu.item.save', { name: 'X', code: 'P1', pricePaise: 1000, groupId: g }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'menu.item.save', { name: 'X', pricePaise: 0, groupId: g }));
  t.cmd('owner', 'menu.item.save', { id: a, name: 'A2', pricePaise: 1200, groupId: g, variants: [{ name: 'L', pricePaise: 1500 }, { name: 'XL', pricePaise: 1800 }] });
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM variants WHERE item_id=?', a).n, 2);
  assert.equal(get(t.db, 'SELECT code FROM items WHERE id=?', a).code, 'PBM'); // code kept on rename
  t.cmd('owner', 'menu.move', { kind: 'item', id: b, dir: -1 });
  assert.deepEqual(t.db.prepare('SELECT id FROM items ORDER BY sort').all().map((/** @type {any} */ r) => r.id), [b, a]);
  t.cmd('owner', 'menu.item.delete', { id: a });
  assert.equal(get(t.db, 'SELECT active FROM items WHERE id=?', a).active, 0);
  t.cmd('owner', 'menu.item.save', { name: 'Again', code: 'PBM', pricePaise: 1000, groupId: g }); // code freed
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'menu.item.save', { name: 'C', pricePaise: 10.5, groupId: g }));
  t.cmd('owner', 'menu.group.delete', { id: g }); // legacy: deletes the group with its dishes
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM items').n, 0);
});

test('extras (sides) and notes; table-layout builder like the legacy app', () => {
  const t = setup();
  const x = t.cmd('manager', 'side.save', { name: 'Curd', pricePaise: 2500 }).id;
  t.cmd('manager', 'side.save', { id: x, name: 'Curd', pricePaise: 3000 });
  assert.equal(get(t.db, 'SELECT price_paise FROM sides WHERE id=?', x).price_paise, 3000);
  t.cmd('manager', 'kitchen_note.save', { text: 'Jain' });
  t.code('DUPLICATE', () => t.cmd('manager', 'kitchen_note.save', { text: 'jain' }));
  const s = t.cmd('manager', 'layout.section.save', { name: 'AC', prefix: 'AC', rows: 2, cols: 4, seats: '4,6' }).id;
  const tabs = () => t.db.prepare('SELECT name, seats, row_no FROM dining_tables WHERE section_id=? ORDER BY row_no, sort').all(s).map((/** @type {any} */ r) => `${r.name}:${r.seats}:${r.row_no}`);
  assert.deepEqual(tabs(), ['AC1:4:0', 'AC2:4:0', 'AC3:4:0', 'AC4:4:0', 'AC5:6:1', 'AC6:6:1', 'AC7:6:1', 'AC8:6:1']);
  const t1 = t.db.prepare("SELECT id FROM dining_tables WHERE name='AC1'").get().id;
  t.cmd('manager', 'layout.section.save', { id: s, name: 'AC', prefix: 'A', rows: 1, cols: 3, seats: '2' });
  t.cmd('manager', 'layout.section.build', { id: s });
  assert.deepEqual(tabs(), ['A1:2:0', 'A2:2:0', 'A3:2:0']);
  assert.ok(t.db.prepare("SELECT id FROM dining_tables WHERE name='A1'").get().id === t1); // id kept by position
  t.code('DUPLICATE', () => t.cmd('manager', 'layout.table.save', { sectionId: s, name: 'a2' }));
  const st = t.cmd('manager', 'layout.section.save', { name: 'Terrace', prefix: 'T', rows: 1, cols: 2, standing: true }).id;
  assert.deepEqual(t.db.prepare('SELECT standing, seats FROM dining_tables WHERE section_id=?').all(st).map((/** @type {any} */ r) => [r.standing, r.seats]), [[1, 0], [1, 0]]);
});

test('layout: ≤10 sections; section with tables cannot be deleted', () => {
  const t = setup();
  const s = [];
  for (let i = 0; i < LIMITS.sections; i++) s.push(t.cmd('manager', 'layout.section.save', { name: 'S' + i }).id);
  t.code('LIMIT', () => t.cmd('manager', 'layout.section.save', { name: 'x' }));
  t.cmd('manager', 'layout.table.save', { sectionId: s[0], name: 'T1' });
  t.code('IN_USE', () => t.cmd('manager', 'layout.section.delete', { id: s[0] }));
  t.cmd('manager', 'layout.section.delete', { id: s[1] });
});

test('settings.update: owner only, validated keys, service charge never applied by default', () => {
  const t = setup();
  assert.equal(getSettings(t.db).serviceChargePct > 0, true);
  t.code('FORBIDDEN', () => t.cmd('manager', 'settings.update', { patch: { name: 'X' } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { hack: 1 } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { billPrefix: 'TOOLONG' } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { paper: 72 } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { taxes: [{ name: 'CGST', rate: '2.5' }] } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { otherTypes: [] } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { custTags: [{ id: 'a', name: 'School', disc: 120 }] } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { printers: { kitchen: { ip: 'printer.local' } } } }));
  t.cmd('owner', 'settings.update', { patch: { name: 'Khana Khajana', specifiedPremises: true, compositionScheme: false, paper: 58, printers: { kitchen: { ip: '192.168.1.50', port: 9100 } }, fallbackHosts: ['http://192.168.1.20:8080'],
    taxes: [{ name: 'CGST', rate: 2.5 }], otherTypes: ['Google Pay', 'BharatPe'], custTags: [{ id: 'tg1', name: 'School', disc: 20 }], askCustomer: false, reasonAll: true } });
  const s = getSettings(t.db);
  assert.deepEqual([s.name, s.specifiedPremises, s.paper, s.printers.kitchen.ip, s.fallbackHosts[0], s.taxes.length, s.otherTypes[1], s.custTags[0].disc, s.reasonAll],
    ['Khana Khajana', true, 58, '192.168.1.50', 'http://192.168.1.20:8080', 1, 'BharatPe', 20, true]);
});

test('users: ≤100, PIN 4–8 digits, keep at least one owner, deactivate revokes sessions', () => {
  const t = setup();
  t.code('BAD_PIN', () => t.cmd('owner', 'user.save', { name: 'X', roleId: 'captain', pin: '12' }));
  t.code('BAD_PIN', () => t.cmd('owner', 'user.save', { name: 'X', roleId: 'captain', pin: '123456789' }));
  t.code('NOT_FOUND', () => t.cmd('owner', 'user.save', { name: 'X', roleId: 'nope', pin: '1234' }));
  t.code('FORBIDDEN', () => t.cmd('manager', 'user.save', { name: 'X', roleId: 'captain', pin: '1234' }));
  t.code('LAST_OWNER', () => t.cmd('owner', 'user.save', { id: t.users.owner, name: 'Owner', roleId: 'manager' }));
  const active = get(t.db, 'SELECT COUNT(*) AS n FROM users WHERE active=1').n;
  for (let i = active; i < LIMITS.users; i++) t.cmd('owner', 'user.save', { name: 'U' + i, roleId: 'captain', pin: '1234' });
  t.code('LIMIT', () => t.cmd('owner', 'user.save', { name: 'U-x', roleId: 'captain', pin: '1234' }));
  t.cmd('owner', 'user.save', { id: t.users.captain, name: 'Captain', roleId: 'captain', active: false });
  assert.equal(get(t.db, 'SELECT active FROM users WHERE id=?', t.users.captain).active, 0);
});

test('custom role: rights validated; owner role is immutable', () => {
  const t = setup();
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'role.save', { name: 'Hacker', rights: ['root'] }));
  t.code('BUILTIN', () => t.cmd('owner', 'role.save', { id: 'owner', name: 'Owner', rights: [] }));
  const r = t.cmd('owner', 'role.save', { name: 'Head waiter', rights: ['order', 'kot', 'serve', 'table.transfer', 'approve', 'void'] });
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM role_rights WHERE role_id=?', r.id).n, 6);
});

test('snapshot carries every static entity the phones need (extras, notes, menu, layout)', () => {
  const t = setup();
  t.cmd('manager', 'side.save', { name: 'Curd', pricePaise: 2500 });
  t.cmd('manager', 'kitchen_note.save', { text: 'Jain' });
  const snap = buildSnapshot(t.db, { epoch: 'x' });
  assert.deepEqual(snap.data.entities.sides.map((/** @type {any} */ s) => [s.name, s.pricePaise]), [['Curd', 2500]]);
  assert.deepEqual(snap.data.entities.kitchen_notes.map((/** @type {any} */ n) => n.text), ['Jain']);
});
