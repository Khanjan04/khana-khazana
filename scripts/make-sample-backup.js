// @ts-check
// Generates a deterministic SYNTHETIC v13-shaped backup for development and CI:
//   node scripts/make-sample-backup.js > test/golden/backup_v13.sample.json
// Day 1 replaces test/golden/backup_v13.json with a REAL backup from the father's app.
// Shape documented in docs/V13_FORMAT.md.

import { calcTotals } from '../server/domain/totals.js';

const settings = { name: 'Khana Khajana', address: 'Main Road, Indore', phone: '9800000000', gstin: '23ABCDE1234F1Z5', fssai: '11223344556677', cgst: 2.5, sgst: 2.5, serviceChargePct: 5, compositionScheme: false, specifiedPremises: false, paper: 80, footer: 'Thank you! Visit again.' };
let seed = 20261018;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (/** @type {any[]} */ a) => a[Math.floor(rnd() * a.length)];

const groups = [
  { id: 1, name: 'Starters', subgroups: [{ id: 11, name: 'Veg' }, { id: 12, name: 'Non-veg' }] },
  { id: 2, name: 'Main course', subgroups: [{ id: 21, name: 'Curries' }, { id: 22, name: 'Rice' }] },
  { id: 3, name: 'Breads', subgroups: [] },
  { id: 4, name: 'Beverages', subgroups: [] },
];
const items = [
  { id: 101, name: 'Paneer Tikka', code: '1', price: 249, groupId: 1, subgroupId: 11, diet: 'veg', fav: true, variants: [{ name: 'Half', price: 149 }, { name: 'Full', price: 249 }], extras: [{ name: 'Extra cheese', price: 40 }] },
  { id: 102, name: 'Chicken 65', code: '2', price: 279.5, groupId: 1, subgroupId: 12, diet: 'nonveg', fav: true, variants: [], extras: [] },
  { id: 103, name: 'Egg Bhurji', code: '3', price: 129, groupId: 1, subgroupId: 12, diet: 'egg', variants: [], extras: [{ name: 'Butter', price: 15.5 }] },
  { id: 201, name: 'Dal Makhani', code: '10', price: 219, groupId: 2, subgroupId: 21, diet: 'veg', fav: true, variants: [], extras: [] },
  { id: 202, name: 'Butter Chicken', code: '11', price: 329, groupId: 2, subgroupId: 21, diet: 'nonveg', variants: [], extras: [] },
  { id: 203, name: 'Veg Biryani', code: '12', price: 199.99, groupId: 2, subgroupId: 22, diet: 'veg', variants: [], extras: [{ name: 'Raita', price: 35 }] },
  { id: 301, name: 'Butter Naan', code: '20', price: 45, groupId: 3, diet: 'veg', variants: [], extras: [] },
  { id: 302, name: 'Tandoori Roti', code: '21', price: 22.5, groupId: 3, diet: 'veg', variants: [], extras: [] },
  { id: 401, name: 'Masala Chaas', code: '30', price: 39, groupId: 4, diet: 'veg', station: 'bar', variants: [], extras: [] },
  { id: 402, name: 'Fresh Lime Soda', code: '31', price: 69, groupId: 4, diet: 'veg', station: 'bar', variants: [], extras: [] },
];
const sections = [
  { id: 1, name: 'AC Hall', tables: Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, name: String(i + 1), seats: 4 })) },
  { id: 2, name: 'Garden', tables: Array.from({ length: 4 }, (_, i) => ({ id: 200 + i, name: 'G' + (i + 1), seats: 6 })) },
];
const users = [
  { id: 1, name: 'Papa', role: 'owner', pin: '1234' },
  { id: 2, name: 'Ravi', role: 'manager', pin: '2345' },
  { id: 3, name: 'Sunita', role: 'biller', pin: '3456' },
  { id: 4, name: 'Amit', role: 'captain', pin: '4567' },
  { id: 5, name: 'Kitchen', role: 'kitchen', pin: '5678' },
];
const orders = [];
let billNo = 1200, kot = 0;
const dates = ['2026-10-15', '2026-10-16', '2026-10-17'];
for (let i = 0; i < 90; i++) {
  const date = dates[Math.floor(i / 30)];
  if (i % 30 === 0) kot = 0;
  const type = pick(['dine', 'dine', 'dine', 'takeaway', 'delivery']);
  const lines = [];
  const n = 1 + Math.floor(rnd() * 5);
  const k1 = ++kot, k2 = rnd() < 0.3 ? ++kot : k1;
  for (let j = 0; j < n; j++) {
    const it = pick(items);
    const v = it.variants.length ? pick(it.variants) : null;
    const ex = it.extras.length && rnd() < 0.4 ? [it.extras[0]] : [];
    lines.push({ itemId: it.id, name: it.name, price: v ? v.price : it.price, qty: 1 + Math.floor(rnd() * 3), variant: v ? v.name : '', extras: ex, note: rnd() < 0.2 ? 'less spicy' : '', void: rnd() < 0.08, voidReason: '', kot: j < n / 2 ? k1 : k2 });
  }
  for (const l of lines) if (l.void) l.voidReason = 'customer changed mind';
  if (rnd() < 0.05) lines.push({ itemId: null, name: 'Open item', price: 57.75, qty: 1, variant: '', extras: [], note: '', void: false, voidReason: '', kot: k2 });
  const r = rnd();
  const discount = r < 0.12 ? { type: 'pct', value: pick([5, 7.5, 10, 12.5, 15]), reason: 'regular' } : r < 0.2 ? { type: 'fixed', value: pick([20, 50, 33.33, 100]), reason: 'promo' } : null;
  const complimentary = r > 0.97;
  const serviceCharge = rnd() < 0.1;
  const o = {
    id: 5000 + i, no: (i % 30) + 1, date, time: Date.parse(date + 'T13:00:00+05:30') + i * 600_000, type,
    tableId: type === 'dine' ? pick(sections.flatMap((s) => s.tables)).id : null, persons: type === 'dine' ? 1 + Math.floor(rnd() * 5) : 0,
    lines, discount, complimentary, serviceCharge, billNo: String(++billNo), status: 'settled',
    platform: type === 'delivery' ? pick(['Zomato', 'Swiggy', 'Phone']) : '',
    customer: type === 'delivery' ? { name: 'Cust ' + i, phone: '98' + String(10000000 + i * 7919).slice(0, 8) } : null,
    payments: /** @type {any[]} */ ([]),
  };
  // payments only make the sample realistic; the golden test never reads them
  const total = calcTotals(/** @type {any} */ (o), settings).total;
  o.payments = total && rnd() < 0.25 ? [{ mode: 'cash', amount: Math.floor(total / 2) }, { mode: 'upi', amount: total - Math.floor(total / 2) }] : [{ mode: pick(['cash', 'upi', 'card']), amount: total }];
  orders.push(o);
}
console.log(JSON.stringify({
  app: 'khanakhajana', version: 13, _sample: 'SYNTHETIC — replace with a real v13 backup on Day 1',
  settings,
  counters: { kot, kotDate: dates.at(-1), bill: billNo, order: 30 },
  groups, items, sections, users, notes: ['Less spicy', 'No onion', 'Jain', 'Extra hot', 'Pack separately'], orders,
}, null, 1));
