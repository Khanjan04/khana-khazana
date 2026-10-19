// @ts-check
// Generate a deterministic SAMPLE backup in the father's REAL format by driving his own app
// (legacy/khanakhajana_v13.html) inside node:vm: default menu, orders with variants / extras /
// notes / voids / discounts / delivery charge / complimentary, settled with cash, card, UPI,
// other (GPay…), due, part payment, tips, waive-off and split bills; a few orders left open.
//   node scripts/make-sample-backup.js > test/golden/backup_v13.json
// Replace it with a REAL backup from the restaurant ("Download backup" in his Admin › Settings).
import { loadLegacy } from './legacy-vm.js';

let clock = new Date('2026-10-15T12:00:00+05:30').getTime();
const L = loadLegacy({ seed: 20261019, now: () => clock });
L.ctx.__tick = (/** @type {number} */ ms) => { clock += ms; };

const out = L.run(String.raw`(() => {
  const rnd = Math.random;
  const pick = a => a[Math.floor(rnd() * a.length)];
  db = defaults();
  db.settings.name = 'KHANAKHAJANA'; db.settings.address = 'Main Road'; db.settings.gstin = '24ABCDE1234F1Z5';
  db.settings.taxOnDelivery = true; db.settings.defaultDelivery = 40;
  db.settings.custTags = [{ id: 'tg1', name: 'School', disc: 20 }, { id: 'tg2', name: 'Friends', disc: 12 }];
  const items = allItems().map(x => x.item).filter(i => i.active);
  const tables = allTables();
  for (let n = 0; n < 75; n++) {
    __tick(n % 25 === 0 && n ? 18 * 3600e3 : 9 * 60e3);
    const type = pick(['dine', 'dine', 'dine', 'pickup', 'delivery']);
    let o;
    if (type === 'dine') { const t = pick(tables); o = orderForTable(t.id) || newOrder({ type: 'dine', tableId: t.id, tableName: t.name, section: t.sec, seats: t.seats }); }
    else if (type === 'pickup') o = newOrder({ type, tableName: 'PK' + dayCounter('PK') });
    else { const p = pick(PLATFORMS); o = newOrder({ type, platform: p[0], tableName: p[1] + dayCounter(p[1]), delivery: num(db.settings.defaultDelivery), customer: { name: 'Cust ' + n, phone: '98' + String(76543210 + n * 7), ref: 'APP' + n, address: 'Street ' + n, locality: 'Area', tag: '' } }); }
    const k = 1 + Math.floor(rnd() * 5);
    for (let j = 0; j < k; j++) {
      const it = pick(items);
      const v = it.variants.length ? pick(it.variants) : null;
      const ex = it.extras && rnd() < 0.6 ? { [pick(db.extras).id]: 1 + Math.floor(rnd() * 2) } : {};
      addLine(o, mkLine(it, { variantId: v && v.id, extras: ex, qty: 1 + Math.floor(rnd() * 3), notes: rnd() < 0.2 ? [pick(db.notes)] : [], text: rnd() < 0.1 ? 'no onion' : '' }));
    }
    if (rnd() < 0.08) addLine(o, mkOpenLine('Birthday cake', 450.5, 1));
    touch(o);
    makeKOT(o);
    if (rnd() < 0.15) { const l = pick(activeLines(o)); logVoid(o, l, 'Customer changed mind', curUser()); l.void = true; }
    if (!hasItems(o)) addLine(o, mkLine(items[0], { variantId: items[0].variants[0] && items[0].variants[0].id }));
    if (rnd() < 0.2) o.discount = rnd() < 0.5 ? { mode: 'pct', value: pick([5, 7.5, 10, 12.5, 15, 20]), reason: 'Regular' } : { mode: 'fix', value: pick([20, 33.33, 50, 99.99]), reason: 'Promo' };
    if (type === 'delivery' && rnd() < 0.3) o.delivery = pick([0, 30, 49.5]);
    if (rnd() < 0.04) o.comp = true;
    o.persons = type === 'dine' ? 1 + Math.floor(rnd() * 6) : 0;
    touch(o);
    if (n >= 72) continue;                                    // a few stay open (running tables)
    __tick(25 * 60e3 + Math.floor(rnd() * 40) * 60e3);
    const T = calcTotals(o);
    if (!o.comp && rnd() < 0.08) { settleSplit(o, ['cash', pick(['card', 'upi', 'cash'])]); continue; }
    const r = rnd(), pay = emptyPay();
    if (o.comp) pay.mode = 'comp';
    else if (r < 0.35) { const given = Math.ceil(T.total / 100) * 100; Object.assign(pay, { mode: 'cash', cash: T.total, tendered: given, change: given - T.total }); }
    else if (r < 0.55) Object.assign(pay, { mode: 'upi', upi: T.total });
    else if (r < 0.68) Object.assign(pay, { mode: 'card', card: T.total, tip: rnd() < 0.5 ? 50 : 0 });
    else if (r < 0.78) Object.assign(pay, { mode: 'other', other: T.total, otherType: 'Google Pay', otherBreak: { 'Google Pay': T.total } });
    else if (r < 0.86) { o.customer = Object.assign(o.customer, { name: 'Sharma ' + n, phone: '99' + String(10000000 + n) }); Object.assign(pay, { mode: 'due', due: T.total }); }
    else if (r < 0.94 && T.total > 100) { const half = Math.floor(T.total / 2); Object.assign(pay, { mode: 'part', card: half, cash: T.total - half, tendered: T.total - half, parts: [{ mode: 'card', amount: half, type: '' }] }); }
    else { const settle = Math.max(0, T.total - 3); Object.assign(pay, { mode: 'cash', cash: settle, tendered: settle, waived: r2(T.total - settle) }); }
    settleOrder(o, pay);
  }
  const c = Object.values(db.customers).find(x => x.due > 0);
  if (c) { const amt = Math.min(100, c.due); c.due = r2(c.due - amt); db.dueReceipts.push({ id: uid('dr'), time: Date.now(), phone: c.phone, name: c.name, amount: amt, mode: 'cash', by: 'Owner' }); }
  db.dayClose[dayKey()] = { counted: 1234, by: 'Owner', time: Date.now() };
  /* drop combo photos from the sample to keep it small (the importer handles img data URLs) */
  db.menu.groups.forEach(g => g.subs.forEach(s => s.items.forEach(i => { if (i.img) i.img = ''; })));
  return JSON.stringify(db);
})()`);
const d = JSON.parse(out);
d._sample = 'SYNTHETIC — generated by driving the legacy app in node:vm; replace with a REAL backup';
process.stdout.write(JSON.stringify(d, null, 1) + '\n');
console.error(`bills ${d.bills.length}, open orders ${Object.keys(d.orders).length}, customers ${Object.keys(d.customers).length}, voids ${d.voidLog.length}`);
