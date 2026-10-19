// @ts-check
// Backups (Day 19): nightly + day-close VACUUM INTO data/backups/YYYYMMDD*.sqlite (keep 30),
// owner JSON export, restore validation.
import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { all, get } from './db.js';
import { openDb } from './db.js';

export const KEEP = 30;
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** @param {Date} d */
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/**
 * @param {any} db @param {string} dir
 * @param {{label?: string, now?: number}} [o] label omitted => nightly file YYYYMMDD.sqlite
 */
export function backupNow(db, dir, o = {}) {
  mkdirSync(dir, { recursive: true });
  const d = new Date(o.now ?? Date.now());
  const label = o.label ? '-' + o.label.replace(/[^a-z0-9-]/gi, '').slice(0, 40) : '';
  const name = `${stamp(d)}${label}.sqlite`;
  const file = join(dir, name);
  if (existsSync(file)) rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune(dir);
  return { file: name, size: statSync(file).size, ts: d.getTime() };
}

/** @param {string} dir */
export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{8}[\w-]*\.sqlite$/.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: f, size: st.size, ts: st.mtimeMs };
    })
    .sort((a, b) => b.ts - a.ts || (a.file < b.file ? 1 : -1));
}

/** @param {string} dir */
function prune(dir) {
  for (const b of listBackups(dir).slice(KEEP)) rmSync(join(dir, b.file), { force: true });
}

/** Safe backup file name inside dir, or null. @param {string} dir @param {string} name */
export function backupPath(dir, name) {
  if (typeof name !== 'string' || basename(name) !== name || !/^\d{8}[\w-]*\.sqlite$/.test(name)) return null;
  const f = join(dir, name);
  return existsSync(f) ? f : null;
}

/** Open a backup read-only-ish and check it is one of ours. @param {string} file */
export function validateBackup(file) {
  const db = openDb(file);
  try {
    const v = get(db, 'SELECT MAX(v) AS v FROM schema_version')?.v;
    const orders = get(db, 'SELECT COUNT(*) AS n FROM orders').n;
    return { ok: !!v, schema: v, orders };
  } finally {
    db.close();
  }
}

const SECRET_COLS = new Set(['pin_hash', 'pin_salt', 'token_hash']);
const EXPORT_TABLES = ['settings', 'counters', 'roles', 'role_rights', 'users', 'devices', 'sections', 'dining_tables',
  'menu_groups', 'menu_subgroups', 'items', 'variants', 'sides', 'kitchen_notes', 'customers', 'orders', 'order_lines',
  'kots', 'kot_status_log', 'bills', 'bill_payments', 'due_receipts', 'void_log', 'day_close', 'cash_counts'];

/** Owner JSON export (no secrets). @param {any} db */
export function exportJson(db) {
  /** @type {Record<string, any>} */
  const out = { format: 'khanakhajana-pos-export', version: 1, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of EXPORT_TABLES) {
    out.tables[t] = all(db, `SELECT * FROM ${t}`).map((r) => {
      for (const k of Object.keys(r)) if (SECRET_COLS.has(k)) delete r[k];
      if (t === 'settings' && String(r.key).startsWith('_')) return null;
      return r;
    }).filter(Boolean);
  }
  return out;
}
