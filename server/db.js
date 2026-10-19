// @ts-check
// node:sqlite adapter (GUIDE §5.1). The ONLY module that touches node:sqlite.
import * as sqlite from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

// Node 26.11 renamed DatabaseSync -> Database; support both.
const Db = /** @type {any} */ (sqlite).Database ?? sqlite.DatabaseSync;

/** @typedef {any} DB */

/** @param {string} path @returns {DB} */
export function openDb(path) {
  const db = new Db(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

const depth = new WeakMap();

/**
 * Run fn inside one IMMEDIATE transaction. Nested calls join the outer one.
 * node:sqlite has no transaction helper.
 * @template T @param {DB} db @param {() => T} fn @returns {T}
 */
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

/** @param {DB} db */
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  const cur = db.prepare('SELECT MAX(v) AS v FROM schema_version').get()?.v ?? 0;
  const dir = new URL('./migrations/', import.meta.url);
  // FKs off while migrating so a migration may rebuild a table (SQLite's 12-step ALTER);
  // foreign_key_check afterwards proves nothing was orphaned.
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      const v = parseInt(f, 10);
      if (!(v > cur)) continue;
      tx(db, () => {
        db.exec(readFileSync(new URL(f, dir), 'utf8'));
        const bad = db.prepare('PRAGMA foreign_key_check').all();
        if (bad.length) throw new Error(`migration ${f} broke foreign keys: ${JSON.stringify(bad.slice(0, 3))}`);
        db.prepare('INSERT INTO schema_version(v) VALUES (?)').run(v);
      });
    }
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

// ---- small query helpers (statement cache + safe binding) ----

const caches = new WeakMap();
/** @param {DB} db @param {string} sql */
function stmt(db, sql) {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = new Map()));
  let s = c.get(sql);
  if (!s) c.set(sql, (s = db.prepare(sql)));
  return s;
}
/** node:sqlite cannot bind booleans or undefined. @param {any[]} p */
const bind = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

/** @param {DB} db @param {string} sql @param {...any} p @returns {any} */
export const get = (db, sql, ...p) => {
  const r = stmt(db, sql).get(...bind(p));
  return r ? { ...r } : undefined;
};
/** @param {DB} db @param {string} sql @param {...any} p @returns {any[]} */
export const all = (db, sql, ...p) => stmt(db, sql).all(...bind(p)).map((/** @type {any} */ r) => ({ ...r }));
/** @param {DB} db @param {string} sql @param {...any} p */
export const run = (db, sql, ...p) => stmt(db, sql).run(...bind(p));
