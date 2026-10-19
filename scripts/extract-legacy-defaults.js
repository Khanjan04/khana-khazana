// @ts-check
// Extract the father's default menu / table layout / extras / notes / settings from the legacy app
// (its own defaults() function) into server/seed/legacy-defaults.json. Combo photos are referenced by
// key (server/seed/images/<key>.jpg) instead of base64.  Run: node scripts/extract-legacy-defaults.js
import { writeFileSync } from 'node:fs';
import { loadLegacy } from './legacy-vm.js';

const L = loadLegacy();
const d = JSON.parse(L.run('JSON.stringify(defaults())'));
const imgKey = Object.fromEntries(L.run('COMBO_ROWS').map((/** @type {any[]} */ r) => [r[0], r[2]]));
const out = {
  source: 'legacy/khanakhajana_v13.html defaults() (DB_VER ' + d.v + ')',
  settings: { name: d.settings.name, footer: d.settings.footer, taxes: d.settings.taxes.map((/** @type {any} */ t) => ({ name: t.name, rate: t.rate })),
    taxOnDelivery: d.settings.taxOnDelivery, defaultDelivery: d.settings.defaultDelivery, paper: d.settings.paper,
    askCustomer: d.settings.askCustomer, reasonAll: d.settings.reasonAll, allowOpenItem: d.settings.allowOpenItem,
    otherTypes: d.settings.otherTypes, custTags: d.settings.custTags },
  layout: d.layout.map((/** @type {any} */ s) => ({ name: s.name, enabled: s.enabled, cfg: s.cfg })),
  menu: d.menu.groups.map((/** @type {any} */ g) => ({ name: g.name, subs: g.subs.map((/** @type {any} */ s) => ({ name: s.name, items: s.items.map((/** @type {any} */ i) => ({
    name: i.name, price: i.price, diet: i.diet, available: i.active, allowSides: !!i.extras, fav: !!i.fav, code: i.code, num: i.num,
    variants: i.variants.map((/** @type {any} */ v) => ({ name: v.name, price: v.price })), img: i.img ? imgKey[i.name] ?? '' : '' })) })) })),
  extras: d.extras.map((/** @type {any} */ e) => ({ name: e.name, price: e.price })),
  notes: d.notes,
};
writeFileSync(new URL('../server/seed/legacy-defaults.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('groups', out.menu.length, 'items', out.menu.reduce((a, g) => a + g.subs.reduce((b, s) => b + s.items.length, 0), 0), 'sections', out.layout.length);
