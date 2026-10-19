// @ts-check
// Shared host-side helpers: settings, counters, business date / FY, entity readers.
import { randomUUID } from 'node:crypto';
import { get, all, run } from './db.js';
import { CmdError } from './errors.js';

export const newId = () => randomUUID();

/** Defaults for every setting key. settings.update only accepts these keys. */
export const SETTING_DEFAULTS = Object.freeze({
  name: 'KHANAKHAJANA',
  address: '',
  phone: '',
  gstin: '',
  fssai: '',
  placeOfSupply: '',
  sacCode: '996331',
  footer: 'Thank you! Visit again.',
  // tax list exactly like the legacy app: printed one line each, fixed by the Owner in advance
  taxes: /** @type {{name: string, rate: number}[]} */ ([{ name: 'CGST', rate: 2.5 }, { name: 'SGST', rate: 2.5 }]),
  taxOnDelivery: false,         // charge tax on the delivery charge too
  defaultDelivery: 0,           // ₹ pre-filled on new delivery orders
  specifiedPremises: false,     // 18% with ITC (CGST 9 + SGST 9) — overrides the tax list; off by default
  compositionScheme: false,     // Bill of Supply, no tax lines
  serviceChargePct: 5,          // only ever applied when toggled ON for a bill (CCPA)
  askCustomer: true,            // ask customer name & mobile before printing the bill
  reasonAll: false,             // ask a reason for every deleted item, not only items sent to the kitchen
  allowOpenItem: true,          // biller may type an item name + price
  otherTypes: /** @type {string[]} */ (['Google Pay', 'PhonePe', 'Paytm', 'Amazon Pay', 'Other']),
  custTags: /** @type {{id: string, name: string, disc: number}[]} */ ([]),  // e.g. School 20%
  billPrefix: 'KK1',            // ≤3 chars so KK1/26-27/000123 fits 16 chars
  dayStartHour: 4,              // orders before 04:00 belong to the previous business day
  paper: 80,                    // 58 | 80 mm
  kotAutoPrint: false,
  billPrintMode: 'browser',     // default client adapter: host-lan | rawbt | browser
  printers: /** @type {Record<string, {ip: string, port?: number}>} */ ({}), // { kitchen: {ip, port}, bar, bill }
  fallbackHosts: /** @type {string[]} */ ([]), // other host origins clients may fail over to, e.g. 'http://192.168.1.20:8080'
  supportPhone: '9909008696',   // shown on every screen, as in the legacy app
  supportEmail: 'piyush.varma06@yahoo.com',
});

/** @param {any} db @returns {typeof SETTING_DEFAULTS & Record<string, any>} */
export function getSettings(db) {
  const s = /** @type {any} */ ({ ...SETTING_DEFAULTS });
  for (const r of all(db, 'SELECT key, value FROM settings')) {
    if (r.key.startsWith('_')) continue; // private keys (host id, recovery hash)
    s[r.key] = JSON.parse(r.value);
  }
  return s;
}

/** @param {any} db @param {string} key @param {any} value */
export function putSetting(db, key, value) {
  run(db, 'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

/** @param {any} db @param {string} key */
export function getPrivate(db, key) {
  const r = get(db, 'SELECT value FROM settings WHERE key=?', key);
  return r ? JSON.parse(r.value) : undefined;
}

// ---- dates ----

const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
/** @param {Date} d */
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** @param {string} date */
export const nextDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + 1, 12));
};

/** Calendar business date, shifted by dayStartHour. @param {number} now @param {number} startHour */
export function calendarBusinessDate(now, startHour) {
  return ymd(new Date(now - startHour * 3600_000));
}

/** Current business date: skips dates already closed by day close. @param {any} db @param {number} now */
export function businessDate(db, now) {
  let d = calendarBusinessDate(now, Number(getSettings(db).dayStartHour) || 0);
  while (get(db, 'SELECT 1 AS x FROM day_close WHERE business_date=?', d)) d = nextDay(d);
  return d;
}

/** Indian financial year (Apr–Mar) for a business date: '2026-10-18' -> '26-27'. @param {string} date */
export function financialYear(date) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${pad(start % 100)}-${pad((start + 1) % 100)}`;
}

/** Next value of a counter; resets to 1 when period changes. @param {any} db @param {string} name @param {string} period */
export function nextCounter(db, name, period) {
  const r = get(db, 'SELECT value, period FROM counters WHERE name=?', name);
  const v = !r || r.period !== period ? 1 : r.value + 1;
  run(db, 'INSERT INTO counters(name,value,period) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, period=excluded.period', name, v, period);
  return v;
}

// ---- entity readers (rows sent to clients) ----

const camelKey = (/** @type {string} */ k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const JSON_COLS = new Set(['extras', 'snapshot', 'summary', 'detail', 'taxes']);
const PRIVATE_COLS = new Set(['pin_hash', 'pin_salt', 'failed', 'locked_until', 'token_hash']);

/** @param {Record<string, any>} r */
export function camel(r) {
  /** @type {Record<string, any>} */
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (PRIVATE_COLS.has(k)) continue;
    o[camelKey(k)] = JSON_COLS.has(k) && typeof v === 'string' ? JSON.parse(v) : v;
  }
  return o;
}

/** Tables replicated to clients (entity name = table name). */
export const ENTITIES = Object.freeze([
  'sections', 'dining_tables', 'menu_groups', 'menu_subgroups', 'items', 'sides', 'kitchen_notes',
  'users', 'roles', 'devices', 'customers', 'orders', 'order_lines', 'kots', 'bills', 'bill_payments',
]);

/** @param {any} db @param {string} table @param {string} id */
export function readEntity(db, table, id) {
  if (!ENTITIES.includes(table)) throw new Error('not an entity: ' + table);
  if (table === 'roles') {
    const r = get(db, 'SELECT * FROM roles WHERE id=?', id);
    if (!r) return null;
    return { ...camel(r), rights: all(db, 'SELECT perm FROM role_rights WHERE role_id=? ORDER BY perm', id).map((x) => x.perm) };
  }
  const r = get(db, `SELECT * FROM ${table} WHERE id=?`, id);
  if (!r) return null;
  const o = camel(r);
  if (table === 'items') {
    o.variants = all(db, 'SELECT id, name, price_paise FROM variants WHERE item_id=? ORDER BY sort, rowid', id).map(camel);
  }
  return o;
}

/**
 * Emit the current row (or null when deleted) for an entity.
 * @param {any} db @param {{emit: (entity: string, id: string, value: any) => void}} ctx @param {string} table @param {string} id
 */
export function touch(db, ctx, table, id) {
  ctx.emit(table, id, readEntity(db, table, id));
}

// ---- payload validation ----

/** @param {any} v @param {string} field @param {number} [max] */
export function str(v, field, max = 200) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new CmdError('BAD_PAYLOAD', `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new CmdError('BAD_PAYLOAD', `${field} too long (max ${max})`);
  return s;
}
/** @param {any} v @param {string} field */
export function reqStr(v, field, max = 200) {
  const s = str(v, field, max);
  if (!s) throw new CmdError('BAD_PAYLOAD', `${field} required`);
  return s;
}
/** @param {any} v @param {string} field @param {number} min @param {number} max */
export function int(v, field, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new CmdError('BAD_PAYLOAD', `${field} must be an integer ${min}..${max}`);
  return /** @type {number} */ (v);
}
/** Money in paise: non-negative integer. @param {any} v @param {string} field */
export const paise = (v, field) => int(v, field, 0, 1_00_00_00_000);
