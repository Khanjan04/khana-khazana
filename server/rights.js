// @ts-check
// Rights and default roles — PLAN §8. All checks run on the host; UI hiding is cosmetic.
import { all, run, get } from './db.js';

/** The father's 13 rights + 11 new ones = 24. */
export const RIGHTS = Object.freeze([
  'order', 'kot', 'bill', 'discount', 'delivery', 'void', 'history', 'reports',
  'kitchen', 'layout', 'menu', 'users', 'settings',
  'kitchen.status', 'serve', 'kot.reprint', 'table.transfer', 'bill.reprint',
  'dayclose', 'approve', 'stock', 'customers.due', 'device.manage', 'export',
]);

const O = 'owner', M = 'manager', B = 'biller', C = 'captain', K = 'kitchen', A = 'accountant', D = 'delivery';

/** right -> roles that hold it by default (PLAN §8 matrix, row by row). */
export const MATRIX = Object.freeze({
  'order': [O, M, B, C], 'kot': [O, M, B, C], 'serve': [O, M, B, C], 'table.transfer': [O, M, B, C],
  'kitchen': [O, M, B, K],
  'kitchen.status': [O, M, K], 'kot.reprint': [O, M, B, K],          // biller: reprint only
  'bill': [O, M, B], 'bill.reprint': [O, M, B],
  'discount': [O, M], 'void': [O, M],                                 // biller: via approval
  'delivery': [O, M, B, D],
  'history': [O, M, B, A], 'reports': [O, M, B, A],
  'export': [O, M, A], 'customers.due': [O, M, B, A],                // biller: dues only
  'dayclose': [O, M], 'approve': [O, M],
  'layout': [O, M], 'menu': [O, M], 'stock': [O, M],
  'users': [O], 'settings': [O], 'device.manage': [O],
});

export const DEFAULT_ROLES = Object.freeze({
  owner: 'Owner', manager: 'Manager', biller: 'Biller', captain: 'Captain',
  kitchen: 'Kitchen', accountant: 'Accountant', delivery: 'Delivery',
});

/** @param {string} role @returns {string[]} */
export function defaultRights(role) {
  return RIGHTS.filter((r) => /** @type {Record<string,string[]>} */ (MATRIX)[r].includes(role));
}

/** Insert built-in roles if missing (idempotent). @param {any} db */
export function seedRoles(db) {
  for (const [id, name] of Object.entries(DEFAULT_ROLES)) {
    if (get(db, 'SELECT id FROM roles WHERE id=?', id)) continue;
    run(db, 'INSERT INTO roles(id,name,builtin) VALUES (?,?,1)', id, name);
    for (const r of defaultRights(id)) run(db, 'INSERT INTO role_rights(role_id,perm) VALUES (?,?)', id, r);
  }
}

/** @param {any} db @param {string} roleId @returns {Set<string>} */
export function loadRights(db, roleId) {
  return new Set(all(db, 'SELECT perm FROM role_rights WHERE role_id=?', roleId).map((r) => r.perm));
}

/** @param {{rights?: Set<string>} | null | undefined} user @param {string} right */
export function can(user, right) {
  return !!user && !!user.rights && user.rights.has(right);
}
