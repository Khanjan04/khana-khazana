// @ts-check
// Importer: legacy v13 backup JSON -> SQLite (Day 7).
// Hash PINs (scrypt), extract base64 images to data/images/<sha1>.jpg, continue counters,
// import legacy KOTs as 'accepted', record legacy_import with the file hash. Re-running is a no-op.
//
// The v13 field names below are the documented assumption (docs/V13_FORMAT.md). On Day 7,
// check them against a REAL backup and adjust the mapping here — never the golden fixtures.
//
// CLI: node server/import/v13.js <backup.json> [--data <dataDir>]
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openDb, tx, get, run } from '../db.js';
import { seedRoles } from '../rights.js';
import { hashPin, validPin } from '../auth.js';
import { putSetting, financialYear, newId, SETTING_DEFAULTS } from '../model.js';
import { calcTotals, totalsToPaise, toPaise } from '../domain/totals.js';

const LID = (/** @type {any} */ id) => 'L-' + String(id);
const ROLE_MAP = /** @type {Record<string, string>} */ ({ owner: 'owner', admin: 'owner', manager: 'manager', biller: 'biller', cashier: 'biller', captain: 'captain', waiter: 'captain', kitchen: 'kitchen', chef: 'kitchen', accountant: 'accountant', delivery: 'delivery' });
const STATUS_MAP = /** @type {Record<string, string>} */ ({ open: 'open', running: 'open', billed: 'billed', printed: 'billed', settled: 'closed', paid: 'closed', closed: 'closed', cancelled: 'cancelled', void: 'cancelled' });

/**
 * @param {any} db
 * @param {any} backup parsed v13 JSON
 * @param {{ imagesDir: string, fileHash: string, now?: number }} o
 */
export function importV13(db, backup, o) {
  const now = o.now ?? Date.now();
  const prior = get(db, 'SELECT report FROM legacy_import WHERE file_hash=?', o.fileHash);
  if (prior) return { skipped: true, ...JSON.parse(prior.report) };
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.orders)) throw new Error('Not a v13 backup: missing orders[]');
  mkdirSync(o.imagesDir, { recursive: true });

  const src = {
    groups: (backup.groups ?? []).length,
    subgroups: (backup.groups ?? []).reduce((/** @type {number} */ a, /** @type {any} */ g) => a + (g.subgroups ?? []).length, 0),
    items: (backup.items ?? []).length,
    sections: (backup.sections ?? []).length,
    tables: (backup.sections ?? []).reduce((/** @type {number} */ a, /** @type {any} */ s) => a + (s.tables ?? []).length, 0),
    users: (backup.users ?? []).length,
    notes: (backup.notes ?? []).length,
    orders: backup.orders.length,
    lines: backup.orders.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + (x.lines ?? []).length, 0),
    bills: backup.orders.filter((/** @type {any} */ x) => x.billNo).length,
    payments: backup.orders.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + (x.payments ?? []).length, 0),
  };
  /** @type {Record<string, number>} */
  const got = { groups: 0, subgroups: 0, items: 0, sections: 0, tables: 0, users: 0, notes: 0, orders: 0, lines: 0, bills: 0, payments: 0, kots: 0, images: 0, customers: 0 };
  /** @type {string[]} */
  const warnings = [];

  const report = tx(db, () => {
    seedRoles(db);
    // settings
    const s = backup.settings ?? {};
    const defs = /** @type {Record<string, any>} */ (SETTING_DEFAULTS);
    for (const [k, v] of Object.entries(s)) if (k in defs && typeof v === typeof defs[k] && k !== 'printers') putSetting(db, k, v);

    // menu
    for (const [gi, g] of (backup.groups ?? []).entries()) {
      run(db, 'INSERT INTO menu_groups(id,name,sort) VALUES (?,?,?)', LID(g.id), String(g.name), gi);
      got.groups++;
      for (const [si, sg] of (g.subgroups ?? []).entries()) {
        run(db, 'INSERT INTO menu_subgroups(id,group_id,name,sort) VALUES (?,?,?,?)', LID(sg.id), LID(g.id), String(sg.name), si);
        got.subgroups++;
      }
    }
    for (const [ii, it] of (backup.items ?? []).entries()) {
      let image = '';
      const m = typeof it.img === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(it.img);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
        image = createHash('sha1').update(buf).digest('hex') + '.' + ext;
        const f = join(o.imagesDir, image);
        if (!existsSync(f)) writeFileSync(f, buf);
        got.images++;
      }
      run(db, 'INSERT INTO items(id,group_id,subgroup_id,name,code,price_paise,diet,station,favourite,image,active,sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        LID(it.id), LID(it.groupId), it.subgroupId ? LID(it.subgroupId) : null, String(it.name), String(it.code ?? ''), toPaise(Number(it.price) || 0),
        ['veg', 'nonveg', 'egg'].includes(it.diet) ? it.diet : 'veg', String(it.station || 'kitchen'), !!it.fav, image, it.active !== false, ii);
      for (const [vi, v] of (it.variants ?? []).entries()) run(db, 'INSERT INTO variants(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), LID(it.id), String(v.name), toPaise(Number(v.price) || 0), vi);
      for (const [xi, x] of (it.extras ?? []).entries()) run(db, 'INSERT INTO extras(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), LID(it.id), String(x.name), toPaise(Number(x.price) || 0), xi);
      got.items++;
    }
    for (const [ni, n] of (backup.notes ?? []).entries()) {
      run(db, 'INSERT INTO kitchen_notes(id,text,sort) VALUES (?,?,?)', newId(), String(n), ni);
      got.notes++;
    }

    // layout
    for (const [si, sec] of (backup.sections ?? []).entries()) {
      run(db, 'INSERT INTO sections(id,name,sort) VALUES (?,?,?)', LID(sec.id), String(sec.name), si);
      got.sections++;
      for (const [ti, t] of (sec.tables ?? []).entries()) {
        run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,sort) VALUES (?,?,?,?,?)', LID(t.id), LID(sec.id), String(t.name), Number(t.seats) || 4, ti);
        got.tables++;
      }
    }

    // users (PINs hashed; plaintext never stored)
    for (const u of backup.users ?? []) {
      const role = ROLE_MAP[String(u.role ?? '').toLowerCase()] ?? 'captain';
      let pin = String(u.pin ?? '');
      if (!validPin(pin)) { warnings.push(`user ${u.name}: invalid PIN replaced with random; reset it in Admin → Users`); pin = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)); }
      const { hash, salt } = hashPin(pin);
      run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', LID(u.id), String(u.name), role, hash, salt, now);
      got.users++;
    }

    // orders, lines, legacy KOTs, bills, payments
    /** @type {Map<string, string>} */
    const customers = new Map();
    for (const lo of backup.orders) {
      const orderId = LID(lo.id);
      const date = String(lo.date);
      const ts = Number(lo.time) || Date.parse(date + 'T12:00:00') || now;
      let customerId = null;
      const phone = lo.customer?.phone ? String(lo.customer.phone).replace(/[^\d+]/g, '') : '';
      if (phone) {
        customerId = customers.get(phone) ?? get(db, 'SELECT id FROM customers WHERE phone=?', phone)?.id ?? null;
        if (!customerId) {
          customerId = newId();
          run(db, 'INSERT INTO customers(id,name,phone,address,due_paise,created_at) VALUES (?,?,?,?,?,?)', customerId, String(lo.customer.name ?? ''), phone, String(lo.customer.address ?? ''), 0, ts);
          got.customers++;
        }
        customers.set(phone, customerId);
      }
      const type = ['dine', 'takeaway', 'delivery'].includes(lo.type) ? lo.type : lo.tableId ? 'dine' : 'takeaway';
      const status = STATUS_MAP[String(lo.status ?? 'closed')] ?? 'closed';
      run(db, `INSERT INTO orders(id,no,business_date,type,table_id,status,persons,comment,held,opened_by,opened_at,updated_at,customer_id,platform,platform_ref,legacy_id)
        VALUES (?,?,?,?,?,?,?,?,0,NULL,?,?,?,?,?,?)`, orderId, Number(lo.no) || 0, date, type, type === 'dine' && lo.tableId ? LID(lo.tableId) : null, status,
        Number(lo.persons) || 0, String(lo.comment ?? ''), ts, ts, customerId, String(lo.platform ?? ''), String(lo.platformRef ?? ''), String(lo.id));
      got.orders++;

      /** @type {Map<string, string>} legacy KOT no -> kot id */
      const kotIds = new Map();
      for (const l of lo.lines ?? []) {
        let kotId = null;
        if (l.kot !== undefined && l.kot !== null) {
          const k = String(l.kot);
          kotId = kotIds.get(k) ?? null;
          if (!kotId) {
            kotId = newId();
            run(db, 'INSERT INTO kots(id,no,business_date,order_id,station,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', kotId, Number(l.kot) || 0, date, orderId, 'kitchen', 'accepted', ts, ts);
            run(db, 'INSERT INTO kot_status_log(kot_id,from_status,to_status,reason,ts) VALUES (?,?,?,?,?)', kotId, null, 'accepted', 'legacy import', ts);
            kotIds.set(k, kotId);
            got.kots++;
          }
        }
        const extras = (l.extras ?? []).map((/** @type {any} */ e) => ({ name: String(e.name), pricePaise: toPaise(Number(e.price) || 0) }));
        run(db, 'INSERT INTO order_lines(id,order_id,item_id,name,qty,unit_paise,variant,extras,note,kot_id,voided,void_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          newId(), orderId, l.itemId ? LID(l.itemId) : null, String(l.name), Math.max(1, Number(l.qty) || 1), toPaise(Number(l.price) || 0),
          String(l.variant ?? ''), JSON.stringify(extras), String(l.note ?? ''), kotId, !!l.void, String(l.voidReason ?? ''), ts);
        got.lines++;
      }

      if (lo.billNo !== undefined && lo.billNo !== null && lo.billNo !== '') {
        const t = totalsToPaise(calcTotals(lo, s));
        const fy = financialYear(date);
        const no = String(lo.billNo).slice(0, 16);
        const seq = Number(String(lo.billNo).replace(/\D/g, '').slice(-9)) || 0;
        const billId = newId();
        const settled = status === 'closed';
        run(db, `INSERT INTO bills(id,no,fy,seq,order_id,business_date,status,subtotal_paise,discount_paise,taxable_paise,cgst_paise,sgst_paise,service_paise,roundoff_paise,total_paise,
          discount_type,discount_value,discount_reason,complimentary,service_on,composition,snapshot,created_at,updated_at,settled_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          billId, no, fy, seq, orderId, date, settled ? 'settled' : status === 'cancelled' ? 'void' : 'open',
          t.subtotal, t.discount, t.taxable, t.cgst, t.sgst, t.serviceCharge, t.roundOff, t.total,
          lo.complimentary ? 'comp' : lo.discount?.type ?? '', Number(lo.discount?.value) || 0, String(lo.discount?.reason ?? ''),
          !!lo.complimentary, !!lo.serviceCharge, !!s.compositionScheme,
          JSON.stringify({ legacy: true, billNo: no, title: s.compositionScheme ? 'Bill of Supply' : 'Tax Invoice', name: s.name ?? '', totals: t, lines: [], businessDate: date, orderNo: Number(lo.no) || 0, type }),
          ts, ts, settled ? ts : null);
        got.bills++;
        for (const p of lo.payments ?? []) {
          const mode = ['cash', 'card', 'upi', 'due', 'other'].includes(p.mode) ? p.mode : 'other';
          const amount = toPaise(Number(p.amount) || 0);
          run(db, 'INSERT INTO bill_payments(id,bill_id,mode,amount_paise,customer_id,ts) VALUES (?,?,?,?,?,?)', newId(), billId, mode, amount, mode === 'due' ? customerId : null, ts);
          if (mode === 'due' && customerId) run(db, 'UPDATE customers SET due_paise=due_paise+? WHERE id=?', amount, customerId);
          got.payments++;
        }
      }
    }

    // counters continue from the legacy app
    const c = backup.counters ?? {};
    const today = String(c.kotDate ?? backup.orders.at(-1)?.date ?? '');
    if (c.kot) run(db, 'INSERT INTO counters(name,value,period) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, period=excluded.period', 'kot', Number(c.kot), today);
    if (c.order) run(db, 'INSERT INTO counters(name,value,period) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, period=excluded.period', 'order', Number(c.order), today);
    if (c.bill && today) run(db, 'INSERT INTO counters(name,value,period) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, period=excluded.period', 'bill', Number(c.bill), financialYear(today));

    const equal = Object.entries(src).every(([k, v]) => got[k] === v);
    const rep = { source: src, imported: got, equal, warnings };
    run(db, 'INSERT INTO legacy_import(file_hash,imported_at,report) VALUES (?,?,?)', o.fileHash, now, JSON.stringify(rep));
    putSetting(db, '_epoch', randomBytes(8).toString('hex')); // clients take a fresh snapshot
    return rep;
  });
  return { skipped: false, ...report };
}

/** @param {string} file @param {string} dataDir */
export function importFile(file, dataDir) {
  const raw = readFileSync(file);
  const fileHash = createHash('sha256').update(raw).digest('hex');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'pos.sqlite'));
  try {
    return importV13(db, JSON.parse(raw.toString('utf8')), { imagesDir: join(dataDir, 'images'), fileHash });
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const di = args.indexOf('--data');
  const dataDir = resolve(di >= 0 ? args[di + 1] : join(fileURLToPath(new URL('../..', import.meta.url)), 'data'));
  if (!file) {
    console.error('usage: node server/import/v13.js <backup_v13.json> [--data <dataDir>]   (stop the server first)');
    process.exit(2);
  }
  const r = importFile(file, dataDir);
  console.log(JSON.stringify(r, null, 2));
  if (!r.skipped && !r.equal) { console.error('COUNTS DIFFER from source — review before going live'); process.exit(1); }
}
