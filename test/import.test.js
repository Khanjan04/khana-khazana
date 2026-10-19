// @ts-check
// Day 7: importer for the father's real backup format. Every entity mapped; scrypt PINs;
// photos to data/images/<sha1>; counters continue; legacy KOTs 'accepted'; legacy_import hash;
// re-run no-op; counts equal source; every imported bill equals what the legacy app stored.
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
import { dayTally } from '../server/reports.js';

const raw = readFileSync(new URL('./golden/backup_v13.json', import.meta.url), 'utf8');
// 1x1 JPEG
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'kkimp-'));
  const db = openDb(join(dir, 'pos.sqlite'));
  const d = JSON.parse(raw);
  d.menu.groups[0].subs[0].items[0].img = 'data:image/jpeg;base64,' + JPEG;
  const hash = createHash('sha256').update(JSON.stringify(d)).digest('hex');
  const r = importV13(db, d, { imagesDir: join(dir, 'images'), fileHash: hash, now: new Date('2026-10-19T21:00:00').getTime() });
  return { dir, db, d, hash, r, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('imports every entity with counts equal to source; re-run is a no-op', () => {
  const { dir, db, d, hash, r, done } = fresh();
  assert.equal(r.skipped, false);
  assert.equal(r.equal, true, JSON.stringify({ src: r.source, got: r.imported }));
  assert.equal(r.imported.bills, d.bills.length);
  const counts = () => ['orders', 'order_lines', 'kots', 'bills', 'bill_payments', 'items', 'users', 'customers', 'void_log'].map((x) => get(db, `SELECT COUNT(*) AS n FROM ${x}`).n);
  const before = counts();
  const again = importV13(db, d, { imagesDir: join(dir, 'images'), fileHash: hash });
  assert.equal(again.skipped, true);
  assert.deepEqual(counts(), before);
  assert.throws(() => importV13(db, { hello: 1 }, { imagesDir: dir, fileHash: 'x' }), { code: 'BAD_BACKUP' });
  done();
});

test('PINs scrypt-hashed, roles mapped, photos extracted, menu codes/numbers kept, layout rows kept', () => {
  const { dir, db, d, done } = fresh();
  const owner = d.users.find((/** @type {any} */ u) => u.roleId === 'owner');
  const u = get(db, 'SELECT * FROM users WHERE id=?', 'L-' + owner.id);
  assert.notEqual(u.pin_hash, owner.pin);
  assert.ok(checkPin(owner.pin, u.pin_salt, u.pin_hash));
  assert.equal(u.role_id, 'owner');
  const it0 = d.menu.groups[0].subs[0].items[0];
  const it = get(db, 'SELECT * FROM items WHERE id=?', 'L-' + it0.id);
  assert.match(it.image, /^[0-9a-f]{40}\.jpg$/);
  assert.ok(existsSync(join(dir, 'images', it.image)));
  assert.deepEqual([it.code, it.num, it.price_paise], [it0.code, it0.num, toPaise(it0.price)]);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM kots WHERE status<>'accepted'").n, 0);
  const sec = d.layout.find((/** @type {any} */ s) => s.enabled);
  assert.equal(get(db, 'SELECT COUNT(DISTINCT row_no) AS n FROM dining_tables WHERE section_id=?', 'L-' + sec.id).n, sec.rows.length);
  assert.deepEqual(JSON.parse(get(db, "SELECT value FROM settings WHERE key='custTags'").value).map((/** @type {any} */ t) => t.name), d.settings.custTags.map((/** @type {any} */ t) => t.name));
  done();
});

test('every imported bill equals the totals the legacy app stored, to the paisa; payments reconcile', () => {
  const { db, d, done } = fresh();
  for (const b of d.bills) {
    const row = get(db, 'SELECT * FROM bills WHERE no=?', String(b.no));
    const T = b.totals;
    assert.deepEqual(
      [row.subtotal_paise, row.discount_paise, row.delivery_paise, row.tax_paise, row.roundoff_paise, row.total_paise, row.comp_value_paise],
      [toPaise(T.sub), toPaise(T.disc), toPaise(T.delivery), toPaise(T.taxTotal), toPaise(T.roundOff), toPaise(T.total), toPaise(T.compValue ?? 0)], 'bill ' + b.no);
    const paid = get(db, 'SELECT COALESCE(SUM(amount_paise),0) AS s FROM bill_payments WHERE bill_id=?', row.id).s;
    assert.equal(paid, row.total_paise + row.tip_paise - row.waived_paise, 'payments bill ' + b.no);
    assert.equal(all(db, 'SELECT id FROM order_lines WHERE order_id=?', row.order_id).length, b.lines.length);
  }
  // other payment types keep their name (Google Pay …); dues land on the customer
  const other = d.bills.find((/** @type {any} */ b) => b.pay.mode === 'other');
  if (other) assert.equal(get(db, "SELECT p.other_type FROM bill_payments p JOIN bills b ON b.id=p.bill_id WHERE b.no=? AND p.mode='other'", String(other.no)).other_type, other.pay.otherType);
  const dueCust = Object.values(d.customers).find((/** @type {any} */ c) => c.due > 0);
  if (dueCust) assert.equal(get(db, 'SELECT due_paise FROM customers WHERE phone=?', /** @type {any} */ (dueCust).phone).due_paise, toPaise(/** @type {any} */ (dueCust).due));
  done();
});

test('running orders come back open with their KOTs; deleted-items record and cash counted kept', () => {
  const { db, d, done } = fresh();
  const open = Object.values(d.orders);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM orders WHERE status='open'").n, open.length);
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM void_log WHERE entity='order_line'").n, d.voidLog.length);
  const [date, c] = Object.entries(d.dayClose)[0];
  assert.equal(dayTally(db, date).cashCounted?.countedPaise, toPaise(/** @type {any} */ (c).counted));
  done();
});

test('counters continue: bill series, KOT number of the day, pickup/delivery refs', () => {
  const { db, d, done } = fresh();
  db.prepare("INSERT INTO devices(id,name,kind,token_hash,created_at) VALUES ('dev','t','staff','h',0)").run();
  const exec = createEngine(db, () => {});
  const owner = d.users.find((/** @type {any} */ u) => u.roleId === 'owner');
  const now = new Date(d.counters.kot.date + 'T20:00:00').getTime();
  const ctx = { user: { id: 'L-' + owner.id, name: 'Owner', roleId: 'owner', rights: loadRights(db, 'owner') }, device: { id: 'dev' }, now };
  const free = all(db, "SELECT t.id FROM dining_tables t WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status IN ('open','billed'))")[0].id;
  const item = all(db, 'SELECT i.id FROM items i WHERE NOT EXISTS (SELECT 1 FROM variants v WHERE v.item_id=i.id) AND available=1 LIMIT 1')[0].id;
  const k = exec({ opId: 'x1', type: 'kot.create', payload: { tableId: free, lines: [{ itemId: item, qty: 1 }] } }, ctx).result;
  assert.equal(k.kots[0].no, d.counters.kot.n + 1);
  const b = exec({ opId: 'x2', type: 'bill.print', payload: { orderId: k.orderId } }, ctx).result;
  assert.equal(b.no, `KK1/26-27/${String(d.counters.bill + 1).padStart(6, '0')}`);
  const pk = exec({ opId: 'x3', type: 'order.open', payload: { type: 'takeaway' } }, { ...ctx, now: new Date(d.counters.ord.date + 'T20:00:00').getTime() }).result;
  assert.equal(pk.ref, 'PK' + ((d.counters.ord.n.PK ?? 0) + 1));
  done();
});
