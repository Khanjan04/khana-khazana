// @ts-check
// Test fixtures: in-memory DB, one user per role, a device, an engine with a fake clock.
import { openDb, run } from '../server/db.js';
import { createEngine } from '../server/engine.js';
import { seedRoles, loadRights, DEFAULT_ROLES } from '../server/rights.js';
import { hashPin } from '../server/auth.js';
import { randomUUID } from 'node:crypto';

export const PIN = '1234';
const PIN_HASH = hashPin(PIN); // scrypt once per process

/** @param {{now?: number, path?: string}} [o] */
export function setup(o = {}) {
  const db = openDb(o.path ?? ':memory:');
  seedRoles(db);
  const clock = { now: o.now ?? new Date('2026-10-18T13:00:00').getTime() };
  /** @type {Record<string, string>} role -> user id */
  const users = {};
  for (const role of Object.keys(DEFAULT_ROLES)) {
    const id = 'u-' + role;
    run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', id, role[0].toUpperCase() + role.slice(1), role, PIN_HASH.hash, PIN_HASH.salt, clock.now);
    users[role] = id;
  }
  run(db, "INSERT INTO devices(id,name,kind,token_hash,created_at) VALUES ('dev-1','Test','staff','x',0)");
  /** @type {any[]} */
  const broadcasts = [];
  /** @type {any[]} */
  const printed = [];
  const exec = createEngine(db, (m) => broadcasts.push(m));
  const hooks = { print: (/** @type {string} */ kind, /** @type {string} */ id) => printed.push({ kind, id }), backup: () => {}, closeDevice: () => {}, closeUser: () => {} };

  /** @param {string} role */
  const ctx = (role) => ({ user: { id: users[role], name: role, roleId: role, rights: loadRights(db, role) }, device: { id: 'dev-1' }, now: clock.now, hooks });
  /** Execute a command as a role; returns the result payload. @param {string} role @param {string} type @param {any} [payload] @param {string} [opId] */
  const cmd = (role, type, payload = {}, opId = randomUUID()) => exec({ opId, type, payload }, ctx(role)).result;
  /** Expect a CmdError code. @param {string} code @param {() => any} fn */
  const code = (code, fn) => {
    try { fn(); } catch (e) { if (/** @type {any} */ (e).code === code) return true; throw e; }
    throw new Error(`expected ${code}, got success`);
  };
  return { db, exec, users, ctx, cmd, code, clock, broadcasts, printed, approval: (/** @type {string} */ role = 'manager') => ({ userId: users[role], pin: PIN }) };
}

/** Seed a small menu + layout through real commands. @param {ReturnType<typeof setup>} t */
export function seedMenu(t) {
  const g = t.cmd('owner', 'menu.group.save', { name: 'Main' }).id;
  const s = t.cmd('owner', 'layout.section.save', { name: 'Hall' }).id;
  const tables = ['1', '2', '3', '4'].map((name) => t.cmd('owner', 'layout.table.save', { sectionId: s, name }).id);
  const dal = t.cmd('owner', 'menu.item.save', { name: 'Dal', code: '1', pricePaise: 21900, groupId: g }).id;
  const naan = t.cmd('owner', 'menu.item.save', { name: 'Naan', code: '2', pricePaise: 4500, groupId: g }).id;
  const tikka = t.cmd('owner', 'menu.item.save', {
    name: 'Paneer Tikka', code: '3', pricePaise: 24900, groupId: g,
    variants: [{ name: 'Half', pricePaise: 14900 }, { name: 'Full', pricePaise: 24900 }], extras: [{ name: 'Cheese', pricePaise: 4000 }],
  }).id;
  const lime = t.cmd('owner', 'menu.item.save', { name: 'Lime soda', code: '9', pricePaise: 6900, groupId: g, station: 'bar' }).id;
  return { group: g, section: s, tables, items: { dal, naan, tikka, lime } };
}
