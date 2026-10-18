// @ts-check
// Full client state, sent on first connect or when the event gap is too large.
import { all, get } from './db.js';
import { readEntity, getSettings, businessDate, ENTITIES } from './model.js';

const STATIC = ['sections', 'dining_tables', 'menu_groups', 'menu_subgroups', 'items', 'kitchen_notes', 'users', 'roles', 'devices', 'customers'];

/** @param {any} db @param {{epoch: string, now?: number}} o */
export function buildSnapshot(db, o) {
  const now = o.now ?? Date.now();
  const bd = businessDate(db, now);
  /** @type {Record<string, any[]>} */
  const entities = {};
  for (const t of STATIC) entities[t] = all(db, `SELECT id FROM ${t}`).map((r) => readEntity(db, t, r.id));
  // Active orders + everything from the last two business days.
  const orders = all(db, "SELECT id FROM orders WHERE status IN ('open','billed') OR business_date >= date(?, '-1 day')", bd).map((r) => r.id);
  const ids = new Set(orders);
  entities.orders = orders.map((id) => readEntity(db, 'orders', id));
  /** @param {string} t */
  const byOrder = (t) => all(db, `SELECT id, order_id FROM ${t}`).filter((r) => ids.has(r.order_id)).map((r) => readEntity(db, t, r.id));
  entities.order_lines = byOrder('order_lines');
  entities.kots = byOrder('kots');
  entities.bills = byOrder('bills');
  const billIds = new Set(entities.bills.map((b) => b.id));
  entities.bill_payments = all(db, 'SELECT id, bill_id FROM bill_payments').filter((r) => billIds.has(r.bill_id)).map((r) => readEntity(db, 'bill_payments', r.id));
  for (const t of ENTITIES) entities[t] ??= [];
  const seq = Number(get(db, 'SELECT COALESCE(MAX(seq),0) AS s FROM events').s);
  return { t: 'snapshot', seq, epoch: o.epoch, data: { entities, settings: getSettings(db), businessDate: bd } };
}
