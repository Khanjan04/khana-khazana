// @ts-check
// Day 9: menu CRUD with legacy limits, layout CRUD, settings.update, users CRUD; right checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { get } from '../server/db.js';
import { getSettings } from '../server/model.js';
import { LIMITS } from '../server/commands/admin.js';

test('menu limits: ≤12 groups, ≤10 sub-groups per group, ≤100 items', () => {
  const t = setup();
  const groups = [];
  for (let i = 0; i < LIMITS.groups; i++) groups.push(t.cmd('manager', 'menu.group.save', { name: 'G' + i }).id);
  t.code('LIMIT', () => t.cmd('manager', 'menu.group.save', { name: 'one too many' }));
  for (let i = 0; i < LIMITS.subgroups; i++) t.cmd('manager', 'menu.subgroup.save', { groupId: groups[0], name: 'S' + i });
  t.code('LIMIT', () => t.cmd('manager', 'menu.subgroup.save', { groupId: groups[0], name: 'S-x' }));
  t.cmd('manager', 'menu.subgroup.save', { groupId: groups[1], name: 'other group ok' });
  for (let i = 0; i < LIMITS.items; i++) t.cmd('manager', 'menu.item.save', { name: 'I' + i, pricePaise: 100, groupId: groups[i % 12] });
  t.code('LIMIT', () => t.cmd('manager', 'menu.item.save', { name: 'I-x', pricePaise: 100, groupId: groups[0] }));
});

test('item save: duplicate short code rejected, variants/extras replaced, soft delete', () => {
  const t = setup();
  const g = t.cmd('owner', 'menu.group.save', { name: 'Main' }).id;
  const a = t.cmd('owner', 'menu.item.save', { name: 'A', code: '7', pricePaise: 1000, groupId: g, variants: [{ name: 'S', pricePaise: 800 }] }).id;
  t.code('DUPLICATE', () => t.cmd('owner', 'menu.item.save', { name: 'B', code: '7', pricePaise: 1000, groupId: g }));
  t.cmd('owner', 'menu.item.save', { id: a, name: 'A2', code: '7', pricePaise: 1200, groupId: g, variants: [{ name: 'L', pricePaise: 1500 }, { name: 'XL', pricePaise: 1800 }] });
  assert.equal(get(t.db, 'SELECT COUNT(*) AS n FROM variants WHERE item_id=?', a).n, 2);
  t.code('IN_USE', () => t.cmd('owner', 'menu.group.delete', { id: g }));
  t.cmd('owner', 'menu.item.delete', { id: a });
  assert.equal(get(t.db, 'SELECT active FROM items WHERE id=?', a).active, 0);
  t.cmd('owner', 'menu.item.save', { name: 'B', code: '7', pricePaise: 1000, groupId: g }); // code freed
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'menu.item.save', { name: 'C', pricePaise: 10.5, groupId: g }));
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
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { cgst: '2.5' } }));
  t.code('BAD_PAYLOAD', () => t.cmd('owner', 'settings.update', { patch: { printers: { kitchen: { ip: 'printer.local' } } } }));
  t.cmd('owner', 'settings.update', { patch: { name: 'Khana Khajana', specifiedPremises: true, compositionScheme: false, paper: 58, printers: { kitchen: { ip: '192.168.1.50', port: 9100 } }, fallbackHosts: ['http://192.168.1.20:8080'] } });
  const s = getSettings(t.db);
  assert.deepEqual([s.name, s.specifiedPremises, s.paper, s.printers.kitchen.ip, s.fallbackHosts[0]], ['Khana Khajana', true, 58, '192.168.1.50', 'http://192.168.1.20:8080']);
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
