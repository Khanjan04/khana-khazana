// @ts-check
// First-run seed: the father's default menu, table layout, extras, notes and billing settings
// (extracted from legacy defaults() into legacy-defaults.json by scripts/extract-legacy-defaults.js),
// plus default staff logins. Runs inside the setup transaction.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, get } from '../db.js';
import { newId, putSetting, getPrivate } from '../model.js';
import { seatList } from '../domain/codes.js';
import { hashPin } from '../auth.js';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const DIET = /** @type {Record<string, string>} */ ({ v: 'veg', n: 'nonveg', e: 'egg', '': 'none' });

/** Default staff logins created at setup (only the Owner registers). Change the PINs in Admin → Users. */
export const DEFAULT_STAFF = Object.freeze([
  { name: 'Manager', roleId: 'manager', pin: '2222' },
  { name: 'Captain', roleId: 'captain', pin: '1111' },
  { name: 'Kitchen', roleId: 'kitchen', pin: '3333' },
]);

/** @param {any} db @param {number} now */
export function seedStaff(db, now) {
  for (const u of DEFAULT_STAFF) {
    const { hash, salt } = hashPin(u.pin);
    run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', newId(), u.name, u.roleId, hash, salt, now);
  }
  putSetting(db, '_staffSeeded', '1');
  return DEFAULT_STAFF.map((u) => ({ ...u }));
}

/**
 * Hosts set up before default staff existed: once, add Manager / Captain / Kitchen for roles that have
 * no user yet (so phones show them in "Who is working?"). Returns the users added.
 * @param {any} db @param {number} now
 */
export function topUpStaff(db, now) {
  if (getPrivate(db, '_staffSeeded') || !get(db, "SELECT id FROM users WHERE role_id='owner' LIMIT 1")) return [];
  const added = [];
  for (const u of DEFAULT_STAFF) {
    if (get(db, 'SELECT id FROM users WHERE role_id=? LIMIT 1', u.roleId)) continue;
    const { hash, salt } = hashPin(u.pin);
    run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', newId(), u.name, u.roleId, hash, salt, now);
    added.push({ ...u });
  }
  putSetting(db, '_staffSeeded', '1');
  return added;
}

/**
 * Load the legacy defaults. Skips menu/layout if the DB already has some (idempotent).
 * @param {any} db @param {{imagesDir?: string}} [o]
 */
export function seedLegacyDefaults(db, o = {}) {
  const d = JSON.parse(readFileSync(join(DIR, 'legacy-defaults.json'), 'utf8'));
  const counts = { groups: 0, items: 0, sections: 0, tables: 0, extras: 0, notes: 0 };
  for (const [k, v] of Object.entries(d.settings)) {
    if (k === 'defaultDelivery') putSetting(db, k, Number(v) || 0);
    else putSetting(db, k, v);
  }
  if (!get(db, 'SELECT id FROM menu_groups LIMIT 1')) {
    d.menu.forEach((/** @type {any} */ g, /** @type {number} */ gi) => {
      const gid = newId();
      run(db, 'INSERT INTO menu_groups(id,name,sort) VALUES (?,?,?)', gid, g.name, gi);
      counts.groups++;
      g.subs.forEach((/** @type {any} */ sg, /** @type {number} */ si) => {
        const sid = newId();
        run(db, 'INSERT INTO menu_subgroups(id,group_id,name,sort) VALUES (?,?,?,?)', sid, gid, sg.name, si);
        sg.items.forEach((/** @type {any} */ it, /** @type {number} */ ii) => {
          const iid = newId();
          run(db, 'INSERT INTO items(id,group_id,subgroup_id,name,code,num,price_paise,diet,favourite,image,active,available,allow_sides,sort) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
            iid, gid, sid, it.name, it.code, it.num, Math.round(it.price * 100), DIET[it.diet] ?? 'none', !!it.fav, it.img ? image(it.img, o.imagesDir) : '', it.available !== false, !!it.allowSides, ii);
          it.variants.forEach((/** @type {any} */ v, /** @type {number} */ vi) => run(db, 'INSERT INTO variants(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), iid, v.name, Math.round(v.price * 100), vi));
          counts.items++;
        });
      });
    });
  }
  if (!get(db, 'SELECT id FROM sections LIMIT 1')) {
    d.layout.forEach((/** @type {any} */ sec, /** @type {number} */ i) => {
      const sid = newId();
      const c = sec.cfg;
      run(db, 'INSERT INTO sections(id,name,sort,prefix,rows_cfg,cols_cfg,seats_cfg,standing,start_no,enabled) VALUES (?,?,?,?,?,?,?,?,?,?)',
        sid, sec.name, i, c.prefix, c.rows, c.cols, String(c.seats ?? ''), !!c.standing, c.startNo || 1, !!sec.enabled);
      counts.sections++;
      if (!sec.enabled) return;
      const seats = seatList(c.seats);
      let n = c.startNo || 1;
      for (let r = 0; r < c.rows; r++) for (let col = 0; col < c.cols; col++) {
        run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,standing,row_no,sort) VALUES (?,?,?,?,?,?,?)', newId(), sid, c.prefix + (n++),
          c.standing ? 0 : seats.length ? seats[Math.min(r, seats.length - 1)] : 4, !!c.standing, r, col);
        counts.tables++;
      }
    });
  }
  if (!get(db, 'SELECT id FROM sides LIMIT 1')) {
    d.extras.forEach((/** @type {any} */ e, /** @type {number} */ i) => { run(db, 'INSERT INTO sides(id,name,price_paise,sort) VALUES (?,?,?,?)', newId(), e.name, Math.round(e.price * 100), i); counts.extras++; });
  }
  if (!get(db, 'SELECT id FROM kitchen_notes LIMIT 1')) {
    d.notes.forEach((/** @type {string} */ t, /** @type {number} */ i) => { run(db, 'INSERT INTO kitchen_notes(id,text,sort) VALUES (?,?,?)', newId(), t, i); counts.notes++; });
  }
  return counts;
}

/** Copy a bundled combo photo into data/images/<sha1>.jpg. @param {string} key @param {string} [imagesDir] */
function image(key, imagesDir) {
  if (!imagesDir || !/^i\d\d$/.test(key)) return '';
  const src = join(DIR, 'images', key + '.jpg');
  if (!existsSync(src)) return '';
  const buf = readFileSync(src);
  const name = createHash('sha1').update(buf).digest('hex') + '.jpg';
  mkdirSync(imagesDir, { recursive: true });
  const f = join(imagesDir, name);
  if (!existsSync(f)) writeFileSync(f, buf);
  return name;
}
