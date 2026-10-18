// @ts-check
// Day 7: import/v13.js maps every legacy entity; scrypt PINs; images to data/images/<sha1>;
// counters continue; legacy KOTs 'accepted'; legacy_import hash; re-run no-op; counts equal source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, get, all } from '../server/db.js';
import { importV13 } from '../server/import/v13.js';
import { checkPin } from '../server/auth.js';
import { toPaise } from '../server/domain/totals.js';
import { createEngine } from '../server/engine.js';
import { loadRights } from '../server/rights.js';

const raw = readFileSync(new URL('./golden/backup_v13.json', import.meta.url), 'utf8');
const expected = JSON.parse(readFileSync(new URL('./golden/expected_totals.json', import.meta.url), 'utf8'));
// 1x1 JPEG
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'kkimp-'));
  const db = openDb(join(dir, 'pos.sqlite'));
  const backup = JSON.parse(raw);
  backup.items[0].img = 'data:image/jpeg;base64,' + JPEG;
  return { dir, db, backup, hash: createHash('sha256').update(JSON.stringify(backup)).digest('hex') };
}

test('imports every entity with counts equal to source; re-run is a no-op', () => {
  const { dir, db, backup, hash } = fresh();
  const r = importV13(db, backup, { imagesDir: join(dir, 'images'), fileHash: hash });
  assert.equal(r.skipped, false);
  assert.equal(r.equal, true, JSON.stringify({ src: r.source, got: r.imported }));
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM orders').n, backup.orders.length);
  const counts = () => ['orders', 'order_lines', 'kots', 'bills', 'bill_payments', 'items', 'users', 'customers'].map((x) => get(db, `SELECT COUNT(*) AS n FROM ${x}`).n);
  const before = counts();
  const again = importV13(db, backup, { imagesDir: join(dir, 'images'), fileHash: hash });
  assert.equal(again.skipped, true);
  assert.deepEqual(counts(), before);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('PINs are scrypt-hashed (never plaintext); images extracted by sha1; legacy KOTs accepted', () => {
  const { dir, db, backup, hash } = fresh();
  importV13(db, backup, { imagesDir: join(dir, 'images'), fileHash: hash });
  const u = get(db, "SELECT * FROM users WHERE id='L-1'");
  assert.notEqual(u.pin_hash, '1234');
  assert.ok(checkPin('1234', u.pin_salt, u.pin_hash));
  assert.equal(u.role_id, 'owner');
  const img = get(db, "SELECT image FROM items WHERE id='L-101'").image;
  assert.match(img, /^[0-9a-f]{40}\.jpg$/);
  assert.ok(existsSync(join(dir, 'images', img)));
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM kots WHERE status<>'accepted'").n, 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('spot-check 5 orders: bill totals equal the golden legacy totals in paise', () => {
  const { dir, db, backup, hash } = fresh();
  importV13(db, backup, { imagesDir: join(dir, 'images'), fileHash: hash });
  for (const lo of [backup.orders[0], backup.orders[17], backup.orders[33], backup.orders[58], backup.orders.at(-1)]) {
    const b = get(db, 'SELECT * FROM bills WHERE order_id=?', 'L-' + lo.id);
    const e = expected[lo.id];
    assert.deepEqual([b.no, b.subtotal_paise, b.discount_paise, b.cgst_paise, b.total_paise], [lo.billNo, toPaise(e.subtotal), toPaise(e.discount), toPaise(e.cgst), toPaise(e.total)], String(lo.id));
    const paid = get(db, 'SELECT SUM(amount_paise) AS s FROM bill_payments WHERE bill_id=?', b.id).s;
    assert.equal(paid, toPaise(lo.payments.reduce((/** @type {number} */ a, /** @type {any} */ p) => a + p.amount, 0)));
    assert.equal(all(db, 'SELECT * FROM order_lines WHERE order_id=?', 'L-' + lo.id).length, lo.lines.length);
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('counters continue from the legacy app (KOT on the same day, bill series)', () => {
  const { dir, db, backup, hash } = fresh();
  importV13(db, backup, { imagesDir: join(dir, 'images'), fileHash: hash });
  const exec = createEngine(db, () => {});
  const ctx = { user: { id: 'L-4', name: 'Amit', roleId: 'captain', rights: loadRights(db, 'captain') }, device: { id: 'd' }, now: new Date(backup.counters.kotDate + 'T20:00:00').getTime() };
  run(db, ctx, exec, backup);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {any} db @param {any} ctx @param {any} exec @param {any} backup */
function run(db, ctx, exec, backup) {
  db.prepare("INSERT INTO devices(id,name,kind,token_hash,created_at) VALUES ('d','t','staff','h',0)").run();
  const tableId = 'L-' + backup.sections[0].tables[0].id;
  // make sure the table is free in the imported data
  db.prepare("UPDATE orders SET status='closed' WHERE table_id=?").run(tableId);
  const r = exec({ opId: 'x1', type: 'kot.create', payload: { tableId, lines: [{ itemId: 'L-301', qty: 1 }] } }, ctx).result;
  assert.equal(r.kots[0].no, backup.counters.kot + 1);
  assert.equal(r.orderNo, backup.counters.order + 1);
  const biller = { ...ctx, user: { id: 'L-3', name: 'Sunita', roleId: 'biller', rights: loadRights(db, 'biller') } };
  const b = exec({ opId: 'x2', type: 'bill.print', payload: { orderId: r.orderId } }, biller).result;
  assert.equal(b.no, `KK1/26-27/${String(backup.counters.bill + 1).padStart(6, '0')}`);
}
