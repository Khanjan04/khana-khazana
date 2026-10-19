// @ts-check
// Importer: the father's backup ("Download backup" in his Admin › Settings, DB_VER 1–13) -> SQLite.
// Users (PINs scrypt-hashed), roles, table layout, menu (codes, numbers, photos -> data/images/<sha1>),
// extras, notes, customers + dues, every settled bill (totals kept exactly as the legacy app stored
// them), running orders with their KOTs ('accepted'), deleted-items record, due receipts, cash counted,
// counters (bill / KOT / order refs continue). Records legacy_import with the file hash: re-running is a no-op.
//
// CLI: node server/import/v13.js <backup.json> [--data <dataDir>]   (stop the server first)
// Admin UI: Admin › Backups › "Import from old billing app".
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openDb, tx, get, run } from '../db.js';
import { seedRoles, RIGHTS } from '../rights.js';
import { hashPin, validPin } from '../auth.js';
import { putSetting, financialYear, newId, SETTING_DEFAULTS, ymd } from '../model.js';
import { toPaise } from '../domain/totals.js';

const LID = (/** @type {any} */ id) => 'L-' + String(id);
const ROLE_MAP = /** @type {Record<string, string>} */ ({ owner: 'owner', biller: 'biller', captain: 'captain', kitchen: 'kitchen' });
const DIET = /** @type {Record<string, string>} */ ({ v: 'veg', n: 'nonveg', e: 'egg', '': 'none' });
const TYPE = /** @type {Record<string, string>} */ ({ dine: 'dine', pickup: 'takeaway', delivery: 'delivery' });
const PLATFORM = /** @type {Record<string, string>} */ ({ Zomato: 'Zomato', Swiggy: 'Swiggy', 'Phone call': 'Phone call', Other: 'Other' });

/** @param {number} t */
const dayKey = (t) => ymd(new Date(t));
/** @param {any} p */
const phoneKey = (p) => String(p ?? '').replace(/\D/g, '');

/**
 * @param {any} db
 * @param {any} d parsed legacy backup
 * @param {{ imagesDir: string, fileHash: string, now?: number }} o
 */
export function importV13(db, d, o) {
  const now = o.now ?? Date.now();
  const prior = get(db, 'SELECT report FROM legacy_import WHERE file_hash=?', o.fileHash);
  if (prior) return { skipped: true, ...JSON.parse(prior.report) };
  if (!(d && Number.isInteger(d.v) && d.v >= 1 && d.v <= 13 && d.menu && d.layout && d.users && d.settings)) {
    throw Object.assign(new Error('This is not a valid backup file from the old billing app.'), { code: 'BAD_BACKUP' });
  }
  mkdirSync(o.imagesDir, { recursive: true });
  const groups = d.menu.groups ?? [];
  const bills = d.bills ?? [];
  const openOrders = Object.values(d.orders ?? {}).filter((/** @type {any} */ x) => (x.lines ?? []).some((/** @type {any} */ l) => !l.void));
  const src = {
    users: d.users.length,
    roles: (d.roles ?? []).filter((/** @type {any} */ r) => !r.sys).length,
    sections: d.layout.length,
    tables: d.layout.reduce((/** @type {number} */ a, /** @type {any} */ s) => a + (s.rows ?? []).flat().length, 0),
    groups: groups.length,
    subgroups: groups.reduce((/** @type {number} */ a, /** @type {any} */ g) => a + g.subs.length, 0),
    items: groups.reduce((/** @type {number} */ a, /** @type {any} */ g) => a + g.subs.reduce((/** @type {number} */ b, /** @type {any} */ s) => b + s.items.length, 0), 0),
    extras: (d.extras ?? []).length,
    notes: (d.notes ?? []).length,
    customers: Object.keys(d.customers ?? {}).length,
    bills: bills.length,
    openOrders: openOrders.length,
    voids: (d.voidLog ?? []).length,
    dueReceipts: (d.dueReceipts ?? []).length,
  };
  /** @type {Record<string, number>} */
  const got = Object.fromEntries(Object.keys(src).map((k) => [k, 0]));
  got.images = 0;
  /** @type {string[]} */
  const warnings = [];

  const report = tx(db, () => {
    seedRoles(db);
    // ---- settings ----
    const s = d.settings;
    const defs = /** @type {Record<string, any>} */ (SETTING_DEFAULTS);
    for (const k of ['name', 'address', 'phone', 'gstin', 'fssai', 'footer', 'taxOnDelivery', 'defaultDelivery', 'paper', 'askCustomer', 'reasonAll', 'allowOpenItem', 'otherTypes', 'custTags']) {
      if (s[k] !== undefined && (typeof s[k] === typeof defs[k] || (Array.isArray(defs[k]) && Array.isArray(s[k])))) putSetting(db, k, k === 'paper' ? (s[k] === 58 ? 58 : 80) : s[k]);
    }
    if (Array.isArray(s.taxes)) putSetting(db, 'taxes', s.taxes.map((/** @type {any} */ t) => ({ name: String(t.name), rate: Number(t.rate) || 0 })));

    // ---- roles & users ----
    for (const r of d.roles ?? []) {
      if (r.sys || ROLE_MAP[r.id]) continue;
      run(db, 'INSERT INTO roles(id,name,builtin) VALUES (?,?,0)', LID(r.id), String(r.name));
      for (const right of new Set((r.rights ?? []).filter((/** @type {string} */ x) => RIGHTS.includes(x)))) run(db, 'INSERT INTO role_rights(role_id,perm) VALUES (?,?)', LID(r.id), right);
      got.roles++;
    }
    /** @type {Map<string, string>} name -> our user id (void log / day close) */
    const userByName = new Map();
    for (const u of d.users) {
      const role = ROLE_MAP[u.roleId] ?? (get(db, 'SELECT id FROM roles WHERE id=?', LID(u.roleId)) ? LID(u.roleId) : 'captain');
      let pin = String(u.pin ?? '');
      if (!validPin(pin)) { warnings.push(`user ${u.name}: PIN was not 4–8 digits; set a new one in Admin › Users`); pin = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)); }
      const { hash, salt } = hashPin(pin);
      run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,active,created_at) VALUES (?,?,?,?,?,?,?)', LID(u.id), String(u.name), role, hash, salt, u.active !== false, now);
      userByName.set(String(u.name), LID(u.id));
      got.users++;
    }

    // ---- layout ----
    /** @type {Map<string, {id: string, name: string, section: string}>} */
    const tableById = new Map();
    d.layout.forEach((/** @type {any} */ sec, /** @type {number} */ si) => {
      const c = sec.cfg ?? {};
      run(db, 'INSERT INTO sections(id,name,sort,prefix,rows_cfg,cols_cfg,seats_cfg,standing,start_no,enabled) VALUES (?,?,?,?,?,?,?,?,?,?)',
        LID(sec.id), String(sec.name), si, String(c.prefix ?? ''), Number(c.rows) || 1, Number(c.cols) || 1, String(c.seats ?? ''), !!c.standing, Number(c.startNo) || 1, !!sec.enabled);
      got.sections++;
      (sec.rows ?? []).forEach((/** @type {any[]} */ row, /** @type {number} */ ri) => row.forEach((t, ci) => {
        run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,standing,row_no,sort) VALUES (?,?,?,?,?,?,?)', LID(t.id), LID(sec.id), String(t.name), Number(t.seats) || 0, !!t.standing, ri, ci);
        tableById.set(String(t.id), { id: LID(t.id), name: String(t.name), section: String(sec.name) });
        got.tables++;
      }));
    });

    // ---- menu ----
    groups.forEach((/** @type {any} */ g, /** @type {number} */ gi) => {
      run(db, 'INSERT INTO menu_groups(id,name,sort) VALUES (?,?,?)', LID(g.id), String(g.name), gi);
      got.groups++;
      g.subs.forEach((/** @type {any} */ sg, /** @type {number} */ si) => {
        run(db, 'INSERT INTO menu_subgroups(id,group_id,name,sort) VALUES (?,?,?,?)', LID(sg.id), LID(g.id), String(sg.name), si);
        got.subgroups++;
        sg.items.forEach((/** @type {any} */ it, /** @type {number} */ ii) => {
          let image = '';
          const m = typeof it.img === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(it.img);
          if (m) {
            const buf = Buffer.from(m[2], 'base64');
            image = createHash('sha1').update(buf).digest('hex') + '.' + (m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg');
            const f = join(o.imagesDir, image);
            if (!existsSync(f)) writeFileSync(f, buf);
            got.images++;
          }
          run(db, 'INSERT INTO items(id,group_id,subgroup_id,name,code,num,price_paise,diet,favourite,image,active,available,allow_sides,sort) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
            LID(it.id), LID(g.id), LID(sg.id), String(it.name), String(it.code ?? ''), Number(it.num) || 0, toPaise(Number(it.price) || 0),
            DIET[it.diet ?? ''] ?? 'none', !!it.fav, image, it.active !== false, !!it.extras, ii);
          (it.variants ?? []).forEach((/** @type {any} */ v, /** @type {number} */ vi) => run(db, 'INSERT INTO variants(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', LID(it.id) + ':' + vi, LID(it.id), String(v.name), toPaise(Number(v.price) || 0), vi));
          got.items++;
        });
      });
    });
    (d.extras ?? []).forEach((/** @type {any} */ e, /** @type {number} */ i) => { run(db, 'INSERT INTO sides(id,name,price_paise,sort) VALUES (?,?,?,?)', LID(e.id), String(e.name), toPaise(Number(e.price) || 0), i); got.extras++; });
    (d.notes ?? []).forEach((/** @type {string} */ t, /** @type {number} */ i) => {
      if (get(db, 'SELECT id FROM kitchen_notes WHERE lower(text)=lower(?)', String(t))) { got.notes++; return; }
      run(db, 'INSERT INTO kitchen_notes(id,text,sort) VALUES (?,?,?)', newId(), String(t), i); got.notes++;
    });

    // ---- customers ----
    /** @type {Map<string, string>} phone -> customer id */
    const custByPhone = new Map();
    for (const c of Object.values(d.customers ?? {})) {
      const cc = /** @type {any} */ (c);
      const phone = phoneKey(cc.phone);
      if (!phone) continue;
      const cur = get(db, 'SELECT id FROM customers WHERE phone=?', phone);
      const id = cur?.id ?? newId();
      if (cur) run(db, 'UPDATE customers SET name=?, address=?, locality=?, tag=?, due_paise=due_paise+?, visits=visits+?, last_visit=? WHERE id=?',
        String(cc.name ?? ''), String(cc.address ?? ''), String(cc.locality ?? ''), String(cc.tag ?? ''), toPaise(Number(cc.due) || 0), Number(cc.visits) || 0, cc.last || null, id);
      else run(db, 'INSERT INTO customers(id,name,phone,address,locality,tag,due_paise,visits,last_visit,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, String(cc.name ?? ''), phone, String(cc.address ?? ''), String(cc.locality ?? ''), String(cc.tag ?? ''), toPaise(Number(cc.due) || 0), Number(cc.visits) || 0, cc.last || null, now);
      custByPhone.set(phone, id);
      got.customers++;
    }

    /** Insert an order + its lines (+ legacy KOTs as 'accepted'). @param {any} lo @param {string} status @param {number} closedAt */
    const insertOrder = (lo, status, closedAt) => {
      const orderId = newId();
      const opened = Number(lo.startedAt) || closedAt;
      const bd = dayKey(opened);
      const t = lo.tableId ? tableById.get(String(lo.tableId)) : null;
      const c = lo.customer ?? {};
      const phone = phoneKey(c.phone);
      run(db, `INSERT INTO orders(id,no,business_date,type,table_id,status,persons,comment,held,opened_by,opened_at,updated_at,customer_id,platform,platform_ref,legacy_id,ref,delivery_paise,cust_name,cust_phone,cust_address,cust_locality,cust_tag)
        VALUES (?,0,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderId, bd, TYPE[lo.type] ?? 'dine', lo.type === 'dine' && t ? t.id : null, status, Number(lo.persons) || 0, String(lo.comment ?? ''), !!lo.hold,
      opened, closedAt, custByPhone.get(phone) ?? null, PLATFORM[lo.platform] ?? '', String(c.ref ?? ''), String(lo.id ?? ''), String(lo.tableName ?? ''),
      toPaise(Number(lo.delivery) || 0), String(c.name ?? ''), phone, String(c.address ?? ''), String(c.locality ?? ''), String(c.tag ?? ''));
      /** @type {Map<string, string>} */
      const kotIds = new Map();
      for (const k of lo.kots ?? []) {
        const kid = newId();
        run(db, "INSERT INTO kots(id,no,business_date,order_id,station,status,created_at,updated_at) VALUES (?,?,?,?,'kitchen','accepted',?,?)", kid, Number(k.no) || 0, dayKey(Number(k.time) || opened), orderId, Number(k.time) || opened, Number(k.time) || opened);
        run(db, "INSERT INTO kot_status_log(kot_id,from_status,to_status,reason,ts) VALUES (?,NULL,'accepted','legacy import',?)", kid, Number(k.time) || opened);
        kotIds.set(String(k.id), kid);
      }
      for (const l of lo.lines ?? []) {
        const extras = (l.extras ?? []).map((/** @type {any} */ e) => ({ id: e.id ? LID(e.id) : undefined, name: String(e.name), pricePaise: toPaise(Number(e.price) || 0), qty: Number(e.qty) || 1 }));
        const note = [...(l.notes ?? []), l.text].filter(Boolean).join(', ');
        run(db, 'INSERT INTO order_lines(id,order_id,item_id,name,qty,unit_paise,variant,extras,note,kot_id,voided,void_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          newId(), orderId, l.itemId && l.itemId !== 'open' ? LID(l.itemId) : null, String(l.name), Math.max(1, Number(l.qty) || 1), toPaise(Number(l.price) || 0),
          String(l.variant ?? ''), JSON.stringify(extras), note, l.kotId ? kotIds.get(String(l.kotId)) ?? null : null, !!l.void, l.void ? 'legacy' : '', opened);
      }
      return { orderId, bd };
    };

    // ---- settled bills: totals kept exactly as the legacy app computed them ----
    for (const b of bills) {
      const closedAt = Number(b.closedAt) || now;
      const { orderId, bd } = insertOrder(b, 'closed', closedAt);
      const T = b.totals ?? {};
      const p = b.pay ?? {};
      const taxes = (T.taxes ?? []).map((/** @type {any} */ x) => ({ name: String(x.name), rate: Number(x.rate) || 0, amountPaise: toPaise(Number(x.amount) || 0) }));
      const byName = (/** @type {string} */ n) => taxes.find((/** @type {any} */ x) => x.name.toUpperCase() === n)?.amountPaise ?? 0;
      const fy = financialYear(bd);
      const billId = newId();
      const no = String(b.no ?? '').slice(0, 16);
      const snapshot = { legacy: true, title: d.settings.gstin ? 'Tax Invoice' : 'Bill', name: d.settings.name ?? '', billNo: no, businessDate: bd, orderNo: 0,
        type: TYPE[b.type] ?? 'dine', table: b.tableName ?? '', section: b.section ?? '', persons: b.persons ?? 0, platform: b.platform ?? '', cashier: b.by ?? '',
        customer: b.customer && (b.customer.name || b.customer.phone) ? { name: b.customer.name ?? '', phone: b.customer.phone ?? '', address: b.customer.address ?? '', locality: b.customer.locality ?? '' } : null,
        split: b.splitNo ? { no: b.splitNo, of: b.splitOf, totalPaise: toPaise(Number(b.splitTotal) || 0) } : null,
        lines: (b.lines ?? []).map((/** @type {any} */ l) => ({ name: l.name, variant: l.variant ?? '', note: [...(l.notes ?? []), l.text].filter(Boolean).join(', '), qty: l.qty,
          ratePaise: toPaise(l.price), amountPaise: toPaise(l.price * l.qty), extras: (l.extras ?? []).map((/** @type {any} */ e) => ({ name: e.name, qty: e.qty, ratePaise: toPaise(e.price), amountPaise: toPaise(e.price * e.qty) })) })),
        totals: { subtotal: toPaise(T.sub ?? 0), discount: toPaise(T.disc ?? 0), delivery: toPaise(T.delivery ?? 0), taxable: toPaise(T.taxable ?? 0), taxes, tax: toPaise(T.taxTotal ?? 0),
          cgst: byName('CGST'), sgst: byName('SGST'), serviceCharge: 0, roundOff: toPaise(T.roundOff ?? 0), total: toPaise(T.total ?? 0), comp: !!T.comp, compValue: toPaise(T.compValue ?? 0) },
        discountLabel: T.comp ? 'Complimentary' : b.discount ? (b.discount.mode === 'pct' ? `Discount (${b.discount.value}%)` : 'Discount') : '', footer: d.settings.footer ?? '' };
      const tip = toPaise(Number(p.tip) || 0), waived = toPaise(Number(p.waived) || 0);
      run(db, `INSERT INTO bills(id,no,fy,seq,order_id,business_date,status,subtotal_paise,discount_paise,delivery_paise,taxable_paise,tax_paise,taxes,cgst_paise,sgst_paise,service_paise,roundoff_paise,total_paise,
        comp_value_paise,tip_paise,waived_paise,tendered_paise,change_paise,discount_type,discount_value,discount_reason,complimentary,snapshot,created_by,created_at,updated_at,settled_at)
        VALUES (?,?,?,?,?,?,'settled',?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      billId, no, fy, Number(b.no) || 0, orderId, bd, snapshot.totals.subtotal, snapshot.totals.discount, snapshot.totals.delivery, snapshot.totals.taxable, snapshot.totals.tax,
      JSON.stringify(taxes), snapshot.totals.cgst, snapshot.totals.sgst, snapshot.totals.roundOff, snapshot.totals.total, snapshot.totals.compValue, tip, waived,
      toPaise(Number(p.tendered) || 0), toPaise(Number(p.change) || 0), T.comp ? 'comp' : b.discount?.mode ?? '', Number(b.discount?.value) || 0, String(b.discount?.reason ?? ''),
      !!T.comp, JSON.stringify(snapshot), closedAt, closedAt, closedAt);
      // payments: legacy amounts exclude the tip; ours include it (Σ payments = total + tip − waived)
      const phone = phoneKey(b.customer?.phone);
      /** @type {{mode: string, amount: number, otherType: string}[]} */
      const pays = [];
      for (const m of ['cash', 'card', 'upi', 'due']) if (Number(p[m]) > 0) pays.push({ mode: m, amount: toPaise(Number(p[m])), otherType: '' });
      const ob = Object.entries(p.otherBreak ?? {}).filter(([, v]) => Number(v) > 0);
      if (ob.length) for (const [k, v] of ob) pays.push({ mode: 'other', amount: toPaise(Number(v)), otherType: k });
      else if (Number(p.other) > 0) pays.push({ mode: 'other', amount: toPaise(Number(p.other)), otherType: String(p.otherType ?? 'Other') });
      if (tip) {
        const target = pays.find((x) => x.mode === 'cash') ?? pays.find((x) => x.mode !== 'due');
        if (target) target.amount += tip; else pays.push({ mode: 'cash', amount: tip, otherType: '' });
      }
      for (const x of pays) {
        run(db, 'INSERT INTO bill_payments(id,bill_id,mode,amount_paise,customer_id,other_type,ts) VALUES (?,?,?,?,?,?,?)',
          newId(), billId, x.mode, x.amount, x.mode === 'due' ? custByPhone.get(phone) ?? null : null, x.otherType, closedAt);
      }
      got.bills++;
    }

    // ---- running orders ----
    for (const lo of openOrders) {
      insertOrder(lo, lo.billPrinted ? 'open' : 'open', now);
      got.openOrders++;
    }

    // ---- deleted items, due receipts, cash counted ----
    for (const v of d.voidLog ?? []) {
      run(db, 'INSERT INTO void_log(id,entity,entity_id,business_date,reason,detail,user_id,approver_id,ts) VALUES (?,?,?,?,?,?,?,?,?)',
        newId(), 'order_line', String(v.orderId ?? ''), dayKey(Number(v.time) || now), String(v.reason ?? ''),
        JSON.stringify({ name: v.item, qty: v.qty, amountPaise: toPaise(Number(v.amount) || 0), table: v.table, kot: v.kot || null, sent: !!v.sent, by: v.by, approvedBy: v.approvedBy }),
        userByName.get(String(v.by)) ?? null, userByName.get(String(v.approvedBy)) ?? null, Number(v.time) || now);
      got.voids++;
    }
    for (const r of d.dueReceipts ?? []) {
      const cid = custByPhone.get(phoneKey(r.phone));
      if (!cid) { warnings.push(`due receipt for unknown customer ${r.phone} skipped`); continue; }
      run(db, 'INSERT INTO due_receipts(id,customer_id,amount_paise,mode,business_date,user_id,ts) VALUES (?,?,?,?,?,?,?)',
        newId(), cid, toPaise(Number(r.amount) || 0), ['cash', 'card', 'upi', 'other'].includes(r.mode) ? r.mode : 'cash', dayKey(Number(r.time) || now), userByName.get(String(r.by)) ?? null, Number(r.time) || now);
      got.dueReceipts++;
    }
    for (const [date, c] of Object.entries(d.dayClose ?? {})) {
      const cc = /** @type {any} */ (c);
      run(db, 'INSERT INTO cash_counts(business_date,counted_paise,user_id,ts) VALUES (?,?,?,?) ON CONFLICT(business_date) DO NOTHING', date, toPaise(Number(cc.counted) || 0), userByName.get(String(cc.by)) ?? null, Number(cc.time) || now);
    }

    // ---- counters continue ----
    const c = d.counters ?? {};
    const today = dayKey(now);
    /** @param {string} name @param {number} value @param {string} period */
    const setCounter = (name, value, period) => run(db, 'INSERT INTO counters(name,value,period) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value, excluded.value), period=excluded.period', name, value, period);
    if (Number(c.bill) > 0) setCounter('bill', Number(c.bill), financialYear(today));
    if (c.kot?.date && Number(c.kot.n) > 0) setCounter('kot', Number(c.kot.n), c.kot.date);
    for (const [prefix, n] of Object.entries(c.ord?.n ?? {})) if (c.ord?.date) setCounter('ref:' + prefix, Number(n) || 0, c.ord.date);

    const equal = Object.entries(src).every(([k, v]) => got[k] === v);
    const rep = { source: src, imported: got, equal, warnings };
    run(db, 'INSERT INTO legacy_import(file_hash,imported_at,report) VALUES (?,?,?)', o.fileHash, now, JSON.stringify(rep));
    putSetting(db, '_epoch', randomBytes(8).toString('hex')); // clients take a fresh snapshot
    return rep;
  });
  return { skipped: false, ...report };
}

/** @param {Buffer | string} raw @param {any} db @param {string} imagesDir */
export function importBuffer(raw, db, imagesDir) {
  const fileHash = createHash('sha256').update(raw).digest('hex');
  let d;
  try { d = JSON.parse(String(raw)); } catch { throw Object.assign(new Error('This is not a valid backup file from the old billing app.'), { code: 'BAD_BACKUP' }); }
  return importV13(db, d, { imagesDir, fileHash });
}

/** @param {string} file @param {string} dataDir */
export function importFile(file, dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'pos.sqlite'));
  try {
    return importBuffer(readFileSync(file), db, join(dataDir, 'images'));
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
    console.error('usage: node server/import/v13.js <khanakhajana-backup.json> [--data <dataDir>]   (stop the server first)');
    process.exit(2);
  }
  const r = importFile(file, dataDir);
  console.log(JSON.stringify(r, null, 2));
  if (!r.skipped && !r.equal) { console.error('COUNTS DIFFER from source — review before going live'); process.exit(1); }
}
