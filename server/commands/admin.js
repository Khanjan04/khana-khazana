// @ts-check
// Admin commands (Day 9 / Day 10 + legacy parity): menu (short code + number, availability, extras,
// bulk add, reorder), extras & notes, table-layout builder, settings, users, roles, devices.
// Legacy limits: ≤12 groups, ≤10 sub-groups per group, ≤100 dishes per sub-group, ≤10 sections, ≤100 users, PIN 4–8.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { newId, touch, SETTING_DEFAULTS, getSettings, putSetting, str, reqStr, int, paise } from '../model.js';
import { RIGHTS } from '../rights.js';
import { autoCode, nextNum, seatList } from '../domain/codes.js';
import { hashPin, validPin, createPairCode, revokeDevice } from '../auth.js';

export const LIMITS = Object.freeze({ groups: 12, subgroups: 10, items: 100 /* per sub-group */, sections: 10, tablesPerSection: 150, users: 100 });

/** @param {any} db @param {string} sql @param {...any} p */
const count = (db, sql, ...p) => Number(get(db, sql, ...p).n);

/** @param {any} db @param {string} table @param {any} id */
const exists = (db, table, id) => typeof id === 'string' && !!get(db, `SELECT id FROM ${table} WHERE id=?`, id);

/** @param {any} v */
const sort = (v) => (v === undefined ? 0 : int(v, 'sort', 0, 9999));

/**
 * Create or update a dish. Short code (3 letters) and short number are unique; empty = automatic.
 * @param {any} db @param {any} ctx @param {any} p
 */
export function saveItem(db, ctx, p) {
  const name = reqStr(p.name, 'name', 80);
  need(exists(db, 'menu_groups', p.groupId), 'NOT_FOUND', 'group');
  const subgroupId = p.subgroupId ? p.subgroupId : null;
  if (subgroupId) need(get(db, 'SELECT id FROM menu_subgroups WHERE id=? AND group_id=?', subgroupId, p.groupId), 'NOT_FOUND', 'subgroup');
  const diet = p.diet ?? 'none';
  need(['veg', 'nonveg', 'egg', 'none'].includes(diet), 'BAD_PAYLOAD', 'diet');
  const variants = Array.isArray(p.variants) ? p.variants : null;
  const price = paise(p.pricePaise ?? 0, 'pricePaise');
  if (!(variants && variants.length)) need(price > 0, 'BAD_PAYLOAD', 'Please type the price.');
  const station = str(p.station, 'station', 20) || 'kitchen';
  let id = p.id;
  const isNew = !exists(db, 'items', id);
  const others = all(db, 'SELECT code, num FROM items WHERE active=1 AND id<>?', id ?? '');
  let code = str(p.code, 'code', 3).toUpperCase();
  if (code) {
    need(/^[A-Z]{3}$/.test(code), 'BAD_PAYLOAD', 'Short code must be exactly 3 letters (A–Z).');
    need(!others.some((o) => o.code === code), 'DUPLICATE', `Short code ${code} is already used by another dish.`);
  } else code = !isNew && get(db, 'SELECT code FROM items WHERE id=?', id).code || autoCode(name, new Set(others.map((o) => o.code)));
  let num;
  if (p.num !== undefined && p.num !== null && p.num !== '' && p.num !== 0) {
    num = int(Number(p.num), 'Short number', 1, 9999);
    need(!others.some((o) => o.num === num), 'DUPLICATE', `Short number ${num} is already used by another dish.`);
  } else num = !isNew && get(db, 'SELECT num FROM items WHERE id=?', id).num || nextNum(new Set(others.map((o) => o.num)));
  let image = isNew ? '' : get(db, 'SELECT image FROM items WHERE id=?', id).image;
  if (typeof p.imageData === 'string' && p.imageData) {
    need(ctx.hooks?.saveImage, 'NO_IMAGES');
    image = ctx.hooks.saveImage(p.imageData);
  } else if (p.imageData === null) image = '';
  const available = p.available === undefined ? (isNew ? true : !!get(db, 'SELECT available FROM items WHERE id=?', id).available) : !!p.available;
  if (isNew) {
    need(count(db, "SELECT COUNT(*) AS n FROM items WHERE active=1 AND group_id=? AND COALESCE(subgroup_id,'')=COALESCE(?,'')", p.groupId, subgroupId) < LIMITS.items,
      'LIMIT', `Maximum ${LIMITS.items} dishes are allowed in one sub-group.`);
    id = newId();
    const nextSort = get(db, "SELECT COALESCE(MAX(sort),-1)+1 AS s FROM items WHERE group_id=? AND COALESCE(subgroup_id,'')=COALESCE(?,'')", p.groupId, subgroupId).s;
    run(db, 'INSERT INTO items(id,group_id,subgroup_id,name,code,num,price_paise,diet,station,favourite,image,active,available,allow_sides,sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
      id, p.groupId, subgroupId, name, code, num, price, diet, station, !!p.favourite, image, available, !!p.allowSides, p.sort === undefined ? nextSort : sort(p.sort));
  } else {
    const cur = get(db, 'SELECT * FROM items WHERE id=?', id);
    run(db, 'UPDATE items SET group_id=?, subgroup_id=?, name=?, code=?, num=?, price_paise=?, diet=?, station=?, favourite=?, image=?, available=?, allow_sides=?, sort=? WHERE id=?',
      p.groupId, subgroupId, name, code, num, price, diet, station, p.favourite === undefined ? cur.favourite : !!p.favourite, image, available,
      p.allowSides === undefined ? cur.allow_sides : !!p.allowSides, p.sort === undefined ? cur.sort : sort(p.sort), id);
  }
  if (variants) {
    need(variants.length <= 20, 'LIMIT', 'max 20 variations');
    run(db, 'DELETE FROM variants WHERE item_id=?', id);
    variants.forEach((/** @type {any} */ v, /** @type {number} */ i) => {
      const vp = paise(v.pricePaise, 'variant.pricePaise');
      need(vp > 0, 'BAD_PAYLOAD', 'Every variation needs a price.');
      run(db, 'INSERT INTO variants(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), id, reqStr(v.name, 'variant.name', 40), vp, i);
    });
  }
  touch(db, ctx, 'items', id);
  return id;
}

/**
 * Legacy buildRows: rows × cols tables named prefix+n, seats per row from "4,6" (last repeats), standing tables.
 * Existing tables keep their id by position; tables beyond the grid are deleted unless in use.
 * @param {any} db @param {any} ctx @param {string} sectionId
 */
export function buildSection(db, ctx, sectionId) {
  const s = get(db, 'SELECT * FROM sections WHERE id=?', sectionId);
  need(s.prefix, 'BAD_PAYLOAD', 'Type "Name starts with" first');
  const seats = seatList(s.seats_cfg);
  const old = all(db, 'SELECT * FROM dining_tables WHERE section_id=? ORDER BY row_no, sort, rowid', sectionId);
  /** @type {any[][]} */
  const oldRows = [];
  for (const t of old) (oldRows[t.row_no] ??= []).push(t);
  const grid = [];
  let n = s.start_no || 1;
  for (let r = 0; r < s.rows_cfg; r++) for (let c = 0; c < s.cols_cfg; c++) {
    grid.push({ old: oldRows[r]?.[c] ?? null, row: r, col: c, name: s.prefix + (n++),
      seats: s.standing ? 0 : seats.length ? seats[Math.min(r, seats.length - 1)] : 4 });
  }
  const keep = new Set(grid.filter((g) => g.old).map((g) => g.old.id));
  for (const t of old) {
    if (keep.has(t.id)) continue;
    need(!get(db, "SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')", t.id), 'IN_USE', `Table ${t.name} has a running order. Finish it before making the section smaller.`);
  }
  for (const g of grid) {
    const dup = get(db, 'SELECT t.name FROM dining_tables t WHERE lower(t.name)=lower(?) AND t.section_id<>?', g.name, sectionId);
    need(!dup, 'DUPLICATE', `Table name ${g.name} is already used in another section. Change "Name starts with".`);
  }
  for (const t of old) if (!keep.has(t.id)) { run(db, 'DELETE FROM dining_tables WHERE id=?', t.id); touch(db, ctx, 'dining_tables', t.id); }
  // two passes so renames never collide inside the section
  for (const g of grid) if (g.old) run(db, 'UPDATE dining_tables SET name=? WHERE id=?', '~' + g.old.id, g.old.id);
  for (const g of grid) {
    const id = g.old?.id ?? newId();
    if (g.old) run(db, 'UPDATE dining_tables SET name=?, seats=?, standing=?, row_no=?, sort=? WHERE id=?', g.name, g.seats, !!s.standing, g.row, g.col, id);
    else run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,standing,row_no,sort) VALUES (?,?,?,?,?,?,?)', id, sectionId, g.name, g.seats, !!s.standing, g.row, g.col);
    for (const o of all(db, "SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')", id)) { run(db, 'UPDATE orders SET ref=? WHERE id=?', g.name, o.id); touch(db, ctx, 'orders', o.id); }
    touch(db, ctx, 'dining_tables', id);
  }
  return grid.length;
}

/** @type {Record<string, import('../engine.js').Handler>} */
export const adminHandlers = {
  // ---------- menu ----------
  'menu.group.save': {
    right: 'menu',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 40);
      let id = p.id;
      if (exists(db, 'menu_groups', id)) run(db, 'UPDATE menu_groups SET name=?, sort=? WHERE id=?', name, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM menu_groups') < LIMITS.groups, 'LIMIT', `max ${LIMITS.groups} groups`);
        id = newId();
        run(db, 'INSERT INTO menu_groups(id,name,sort) VALUES (?,?,?)', id, name, sort(p.sort));
      }
      touch(db, ctx, 'menu_groups', id);
      return { id };
    },
  },
  // legacy: delete the group with all its dishes (bills keep their own copy of names/prices)
  'menu.group.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'menu_groups', p.id), 'NOT_FOUND', 'group');
      for (const i of all(db, 'SELECT id FROM items WHERE group_id=?', p.id)) {
        run(db, 'DELETE FROM items WHERE id=?', i.id);
        touch(db, ctx, 'items', i.id);
      }
      for (const sg of all(db, 'SELECT id FROM menu_subgroups WHERE group_id=?', p.id)) {
        run(db, 'DELETE FROM menu_subgroups WHERE id=?', sg.id);
        touch(db, ctx, 'menu_subgroups', sg.id);
      }
      run(db, 'DELETE FROM menu_groups WHERE id=?', p.id);
      touch(db, ctx, 'menu_groups', p.id);
    },
  },
  'menu.subgroup.save': {
    right: 'menu',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 40);
      need(exists(db, 'menu_groups', p.groupId), 'NOT_FOUND', 'group');
      let id = p.id;
      if (exists(db, 'menu_subgroups', id)) run(db, 'UPDATE menu_subgroups SET name=?, group_id=?, sort=? WHERE id=?', name, p.groupId, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM menu_subgroups WHERE group_id=?', p.groupId) < LIMITS.subgroups, 'LIMIT', `max ${LIMITS.subgroups} sub-groups per group`);
        id = newId();
        run(db, 'INSERT INTO menu_subgroups(id,group_id,name,sort) VALUES (?,?,?,?)', id, p.groupId, name, sort(p.sort));
      }
      touch(db, ctx, 'menu_subgroups', id);
      return { id };
    },
  },
  'menu.subgroup.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'menu_subgroups', p.id), 'NOT_FOUND', 'subgroup');
      for (const i of all(db, 'SELECT id FROM items WHERE subgroup_id=?', p.id)) {
        run(db, 'DELETE FROM items WHERE id=?', i.id);
        touch(db, ctx, 'items', i.id);
      }
      run(db, 'DELETE FROM menu_subgroups WHERE id=?', p.id);
      touch(db, ctx, 'menu_subgroups', p.id);
    },
  },
  'menu.item.save': {
    right: 'menu',
    run(db, p, ctx) {
      return { id: saveItem(db, ctx, p) };
    },
  },
  // legacy "Add many at once": [{name, pricePaise}] into one sub-group
  'menu.item.bulk': {
    right: 'menu',
    run(db, p, ctx) {
      need(Array.isArray(p.items) && p.items.length >= 1 && p.items.length <= LIMITS.items, 'BAD_PAYLOAD', 'items');
      const ids = p.items.map((/** @type {any} */ it) => saveItem(db, ctx, { name: it.name, pricePaise: it.pricePaise, groupId: p.groupId, subgroupId: p.subgroupId ?? null }));
      return { added: ids.length };
    },
  },
  'menu.item.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'items', p.id), 'NOT_FOUND', 'item');
      // soft delete: order lines keep their own name/price copy
      run(db, "UPDATE items SET active=0, code='', num=0 WHERE id=?", p.id);
      touch(db, ctx, 'items', p.id);
    },
  },
  'menu.item.available': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'items', p.id), 'NOT_FOUND', 'item');
      run(db, 'UPDATE items SET available=? WHERE id=?', p.available !== false, p.id);
      touch(db, ctx, 'items', p.id);
    },
  },
  'menu.item.favourite': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'items', p.id), 'NOT_FOUND', 'item');
      run(db, 'UPDATE items SET favourite=? WHERE id=?', !!p.favourite, p.id);
      touch(db, ctx, 'items', p.id);
    },
  },
  // move a group / sub-group / dish one place up (-1) or down (+1)
  'menu.move': {
    right: 'menu',
    run(db, p, ctx) {
      const kinds = /** @type {Record<string, [string, string | null]>} */ ({ group: ['menu_groups', null], subgroup: ['menu_subgroups', 'group_id'], item: ['items', 'subgroup_id'] });
      const k = kinds[p.kind];
      need(k, 'BAD_PAYLOAD', 'kind');
      const [table, parent] = k;
      const row = exists(db, table, p.id) ? get(db, `SELECT * FROM ${table} WHERE id=?`, p.id) : null;
      need(row, 'NOT_FOUND', p.kind);
      const where = table === 'items' ? `active=1 AND group_id=? AND COALESCE(subgroup_id,'')=COALESCE(?,'')` : parent ? `${parent}=?` : '1=1';
      const args = table === 'items' ? [row.group_id, row.subgroup_id] : parent ? [row[parent]] : [];
      const sibs = all(db, `SELECT id FROM ${table} WHERE ${where} ORDER BY sort, rowid`, ...args).map((r) => r.id);
      const i = sibs.indexOf(p.id), j = i + (p.dir < 0 ? -1 : 1);
      if (j < 0 || j >= sibs.length) return;
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      sibs.forEach((id, n) => { run(db, `UPDATE ${table} SET sort=? WHERE id=?`, n, id); touch(db, ctx, table, id); });
    },
  },
  // global extras ("sides": chutney, ketchup, curd…) — paid add-ons with a quantity
  'side.save': {
    right: 'menu',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 40);
      const price = paise(p.pricePaise, 'pricePaise');
      let id = p.id;
      if (exists(db, 'sides', id)) run(db, 'UPDATE sides SET name=?, price_paise=? WHERE id=?', name, price, id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM sides') < 40, 'LIMIT', 'max 40 extras');
        id = newId();
        run(db, 'INSERT INTO sides(id,name,price_paise,sort) VALUES (?,?,?,?)', id, name, price, count(db, 'SELECT COUNT(*) AS n FROM sides'));
      }
      touch(db, ctx, 'sides', id);
      return { id };
    },
  },
  'side.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'sides', p.id), 'NOT_FOUND', 'extra');
      run(db, 'DELETE FROM sides WHERE id=?', p.id);
      touch(db, ctx, 'sides', p.id);
    },
  },
  'kitchen_note.save': {
    right: 'menu',
    run(db, p, ctx) {
      const text = reqStr(p.text, 'text', 40);
      let id = p.id;
      need(!get(db, 'SELECT id FROM kitchen_notes WHERE lower(text)=lower(?) AND id<>?', text, id ?? ''), 'DUPLICATE', 'This note already exists.');
      if (exists(db, 'kitchen_notes', id)) run(db, 'UPDATE kitchen_notes SET text=?, sort=? WHERE id=?', text, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM kitchen_notes') < 40, 'LIMIT', 'max 40 notes');
        id = newId();
        run(db, 'INSERT INTO kitchen_notes(id,text,sort) VALUES (?,?,?)', id, text, count(db, 'SELECT COUNT(*) AS n FROM kitchen_notes'));
      }
      touch(db, ctx, 'kitchen_notes', id);
      return { id };
    },
  },
  'kitchen_note.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'kitchen_notes', p.id), 'NOT_FOUND', 'note');
      run(db, 'DELETE FROM kitchen_notes WHERE id=?', p.id);
      touch(db, ctx, 'kitchen_notes', p.id);
    },
  },

  // ---------- layout (legacy table-layout builder) ----------
  'layout.section.save': {
    right: 'layout',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 30);
      const cur = exists(db, 'sections', p.id) ? get(db, 'SELECT * FROM sections WHERE id=?', p.id) : null;
      const cfg = {
        prefix: p.prefix === undefined ? cur?.prefix ?? '' : str(p.prefix, 'prefix', 6),
        rows: p.rows === undefined ? cur?.rows_cfg ?? 1 : int(p.rows, 'rows', 1, 10),
        cols: p.cols === undefined ? cur?.cols_cfg ?? 4 : int(p.cols, 'cols', 1, 15),
        seats: p.seats === undefined ? cur?.seats_cfg ?? '4' : str(p.seats, 'seats', 40),
        standing: p.standing === undefined ? !!cur?.standing : !!p.standing,
        startNo: p.startNo === undefined ? cur?.start_no ?? 1 : int(p.startNo, 'startNo', 1, 999),
        enabled: p.enabled === undefined ? cur ? !!cur.enabled : true : !!p.enabled,
      };
      let id = p.id;
      if (cur) {
        if (!cfg.enabled && cur.enabled) {
          const busy = get(db, "SELECT t.name FROM dining_tables t JOIN orders o ON o.table_id=t.id AND o.status IN ('open','billed') WHERE t.section_id=? LIMIT 1", cur.id);
          need(!busy, 'IN_USE', `Table ${busy?.name} has a running order. Finish it before switching this section off.`);
        }
        run(db, 'UPDATE sections SET name=?, sort=?, prefix=?, rows_cfg=?, cols_cfg=?, seats_cfg=?, standing=?, start_no=?, enabled=? WHERE id=?',
          name, p.sort === undefined ? cur.sort : sort(p.sort), cfg.prefix, cfg.rows, cfg.cols, cfg.seats, cfg.standing, cfg.startNo, cfg.enabled, id);
      } else {
        need(count(db, 'SELECT COUNT(*) AS n FROM sections') < LIMITS.sections, 'LIMIT', `max ${LIMITS.sections} sections`);
        id = newId();
        run(db, 'INSERT INTO sections(id,name,sort,prefix,rows_cfg,cols_cfg,seats_cfg,standing,start_no,enabled) VALUES (?,?,?,?,?,?,?,?,?,?)',
          id, name, sort(p.sort ?? count(db, 'SELECT COUNT(*) AS n FROM sections')), cfg.prefix, cfg.rows, cfg.cols, cfg.seats, cfg.standing, cfg.startNo, cfg.enabled);
      }
      // switching a section on with no tables builds them (legacy)
      if (cfg.enabled && cfg.prefix && !count(db, 'SELECT COUNT(*) AS n FROM dining_tables WHERE section_id=?', id)) buildSection(db, ctx, id);
      touch(db, ctx, 'sections', id);
      return { id };
    },
  },
  // "Build tables": rows × cols numbered prefix+startNo…; keeps table ids by position, renumbers
  'layout.section.build': {
    right: 'layout',
    run(db, p, ctx) {
      need(exists(db, 'sections', p.id), 'NOT_FOUND', 'section');
      return { tables: buildSection(db, ctx, p.id) };
    },
  },
  'layout.section.delete': {
    right: 'layout',
    run(db, p, ctx) {
      need(exists(db, 'sections', p.id), 'NOT_FOUND', 'section');
      need(!count(db, 'SELECT COUNT(*) AS n FROM dining_tables WHERE section_id=?', p.id), 'IN_USE', 'Section still has tables');
      run(db, 'DELETE FROM sections WHERE id=?', p.id);
      touch(db, ctx, 'sections', p.id);
    },
  },
  'layout.table.save': {
    right: 'layout',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 12);
      need(exists(db, 'sections', p.sectionId), 'NOT_FOUND', 'section');
      need(!get(db, 'SELECT id FROM dining_tables WHERE lower(name)=lower(?) AND id<>?', name, p.id ?? ''), 'DUPLICATE', 'This table name is already used.');
      const standing = !!p.standing;
      const seats = standing ? 0 : p.seats === undefined ? 4 : int(p.seats, 'seats', 1, 30);
      let id = p.id;
      if (exists(db, 'dining_tables', id)) {
        const cur = get(db, 'SELECT * FROM dining_tables WHERE id=?', id);
        run(db, 'UPDATE dining_tables SET section_id=?, name=?, seats=?, standing=?, sort=?, row_no=? WHERE id=?', p.sectionId, name, seats, standing,
          p.sort === undefined ? cur.sort : sort(p.sort), p.rowNo === undefined ? cur.row_no : int(p.rowNo, 'rowNo', 0, 50), id);
        // running orders show the new name
        for (const o of all(db, "SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')", id)) {
          run(db, 'UPDATE orders SET ref=? WHERE id=?', name, o.id);
          touch(db, ctx, 'orders', o.id);
        }
      } else {
        need(count(db, 'SELECT COUNT(*) AS n FROM dining_tables WHERE section_id=?', p.sectionId) < LIMITS.tablesPerSection, 'LIMIT', 'too many tables');
        id = newId();
        const rowNo = p.rowNo === undefined ? get(db, 'SELECT COALESCE(MAX(row_no),0) AS r FROM dining_tables WHERE section_id=?', p.sectionId).r : int(p.rowNo, 'rowNo', 0, 50);
        const nextSort = get(db, 'SELECT COALESCE(MAX(sort),-1)+1 AS s FROM dining_tables WHERE section_id=?', p.sectionId).s;
        run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,standing,sort,row_no) VALUES (?,?,?,?,?,?,?)', id, p.sectionId, name, seats, standing,
          p.sort === undefined ? nextSort : sort(p.sort), rowNo);
      }
      touch(db, ctx, 'dining_tables', id);
      return { id };
    },
  },
  'layout.table.delete': {
    right: 'layout',
    run(db, p, ctx) {
      need(exists(db, 'dining_tables', p.id), 'NOT_FOUND', 'table');
      need(!get(db, "SELECT id FROM orders WHERE table_id=? AND status IN ('open','billed')", p.id), 'IN_USE', 'This table has a running order.');
      run(db, 'DELETE FROM dining_tables WHERE id=?', p.id);
      touch(db, ctx, 'dining_tables', p.id);
    },
  },

  // ---------- settings ----------
  'settings.update': {
    right: 'settings',
    run(db, p, ctx) {
      need(p.patch && typeof p.patch === 'object', 'BAD_PAYLOAD', 'patch');
      const defs = /** @type {Record<string, any>} */ (SETTING_DEFAULTS);
      for (const [k, v] of Object.entries(p.patch)) {
        need(k in defs, 'BAD_PAYLOAD', `unknown setting ${k}`);
        if (k === 'fallbackHosts') {
          need(Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && /^http:\/\/[\w.-]+:\d+$/.test(x)), 'BAD_PAYLOAD', `${k}: list of http://ip:port`);
        } else if (k === 'taxes') {
          need(Array.isArray(v) && v.length <= 6 && v.every((t) => t && typeof t.name === 'string' && t.name.trim() && t.name.length <= 20 && typeof t.rate === 'number' && t.rate >= 0 && t.rate <= 100),
            'BAD_PAYLOAD', 'taxes: up to 6 of {name, rate 0–100}');
        } else if (k === 'otherTypes') {
          need(Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every((x) => typeof x === 'string' && x.trim() && x.length <= 30), 'BAD_PAYLOAD', 'otherTypes: keep at least one type');
          need(new Set(v.map((x) => x.toLowerCase())).size === v.length, 'BAD_PAYLOAD', 'This type already exists.');
        } else if (k === 'custTags') {
          need(Array.isArray(v) && v.length <= 20 && v.every((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && t.name.trim() && typeof t.disc === 'number' && t.disc >= 0 && t.disc <= 100),
            'BAD_PAYLOAD', 'custTags: {id, name, disc 0–100}');
        } else {
          const want = typeof defs[k];
          need(typeof v === want && (want !== 'object' || (v && !Array.isArray(v))), 'BAD_PAYLOAD', `${k} must be ${want}`);
        }
        if (k === 'printers') {
          for (const [st, pr] of Object.entries(/** @type {Record<string, any>} */ (v))) {
            need(/^[\w-]{1,20}$/.test(st) && pr && typeof pr.ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(pr.ip) && Number.isInteger(pr.port ?? 9100), 'BAD_PAYLOAD', `printer ${st}: needs IPv4 ip and integer port`);
          }
        }
        if (k === 'billPrefix') need(/^[A-Z0-9]{1,3}$/.test(v), 'BAD_PAYLOAD', 'billPrefix: 1–3 chars A–Z/0–9 (bill no ≤16 chars)');
        if (k === 'paper') need(v === 58 || v === 80, 'BAD_PAYLOAD', 'paper 58|80');
        if (k === 'serviceChargePct') need(v >= 0 && v <= 30, 'BAD_PAYLOAD', `${k} 0..30`);
        if (k === 'defaultDelivery') need(v >= 0 && v <= 10000, 'BAD_PAYLOAD', `${k} 0..10000`);
        if (k === 'dayStartHour') need(Number.isInteger(v) && v >= 0 && v <= 8, 'BAD_PAYLOAD', 'dayStartHour 0..8');
        if (k === 'billPrintMode') need(['host-lan', 'rawbt', 'browser'].includes(v), 'BAD_PAYLOAD', 'billPrintMode');
        if (typeof v === 'string') need(v.length <= 300, 'BAD_PAYLOAD', `${k} too long`);
        putSetting(db, k, v);
      }
      ctx.emit('settings', 'settings', getSettings(db));
    },
  },

  // ---------- users & roles ----------
  'user.save': {
    right: 'users',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 40);
      need(typeof p.roleId === 'string' && get(db, 'SELECT id FROM roles WHERE id=?', p.roleId), 'NOT_FOUND', 'role');
      let id = p.id;
      const isNew = !exists(db, 'users', id);
      if (isNew || p.pin !== undefined) need(validPin(p.pin), 'BAD_PIN', 'PIN must be 4–8 digits');
      if (!isNew && p.roleId !== 'owner') {
        const cur = get(db, 'SELECT role_id FROM users WHERE id=?', id);
        if (cur.role_id === 'owner') need(count(db, "SELECT COUNT(*) AS n FROM users WHERE role_id='owner' AND active=1 AND id<>?", id) > 0, 'LAST_OWNER', 'Keep at least one owner');
      }
      if (isNew) {
        need(count(db, 'SELECT COUNT(*) AS n FROM users WHERE active=1') < LIMITS.users, 'LIMIT', `max ${LIMITS.users} users`);
        id = newId();
        const { hash, salt } = hashPin(p.pin);
        run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', id, name, p.roleId, hash, salt, ctx.now);
      } else {
        run(db, 'UPDATE users SET name=?, role_id=?, active=? WHERE id=?', name, p.roleId, p.active !== false, id);
        if (p.pin !== undefined) {
          const { hash, salt } = hashPin(p.pin);
          run(db, 'UPDATE users SET pin_hash=?, pin_salt=?, failed=0, locked_until=0 WHERE id=?', hash, salt, id);
        }
        if (p.active === false || p.pin !== undefined) {
          run(db, 'UPDATE sessions SET revoked=1 WHERE user_id=?', id);
          const uid = id;
          ctx.after(() => ctx.hooks?.closeUser?.(uid));
        }
      }
      touch(db, ctx, 'users', id);
      return { id };
    },
  },
  'user.unlock': {
    right: 'users',
    run(db, p, ctx) {
      need(exists(db, 'users', p.id), 'NOT_FOUND', 'user');
      run(db, 'UPDATE users SET failed=0, locked_until=0 WHERE id=?', p.id);
      touch(db, ctx, 'users', p.id);
    },
  },
  'role.save': {
    right: 'users',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 30);
      need(Array.isArray(p.rights) && p.rights.every((/** @type {any} */ r) => RIGHTS.includes(r)), 'BAD_PAYLOAD', 'rights');
      let id = p.id;
      if (id === 'owner') throw new CmdError('BUILTIN', 'Owner role cannot be changed');
      if (exists(db, 'roles', id)) run(db, 'UPDATE roles SET name=? WHERE id=?', name, id);
      else {
        id = newId();
        run(db, 'INSERT INTO roles(id,name,builtin) VALUES (?,?,0)', id, name);
      }
      run(db, 'DELETE FROM role_rights WHERE role_id=?', id);
      for (const r of new Set(p.rights)) run(db, 'INSERT INTO role_rights(role_id,perm) VALUES (?,?)', id, r);
      // rights are loaded per session: force re-login of affected users
      run(db, 'UPDATE sessions SET revoked=1 WHERE user_id IN (SELECT id FROM users WHERE role_id=?)', id);
      for (const u of all(db, 'SELECT id FROM users WHERE role_id=?', id)) ctx.after(() => ctx.hooks?.closeUser?.(u.id));
      touch(db, ctx, 'roles', id);
      return { id };
    },
  },

  // ---------- devices ----------
  'pair.create': {
    right: 'device.manage',
    run(db, p, ctx) {
      return createPairCode(db, { kind: p.kind, createdBy: ctx.user.id }, ctx.now);
    },
  },
  'device.revoke': {
    right: 'device.manage',
    run(db, p, ctx) {
      need(exists(db, 'devices', p.deviceId), 'NOT_FOUND', 'device');
      need(p.deviceId !== ctx.device.id, 'BAD_PAYLOAD', 'Cannot revoke this device from itself');
      revokeDevice(db, p.deviceId);
      touch(db, ctx, 'devices', p.deviceId);
      ctx.after(() => ctx.hooks?.closeDevice?.(p.deviceId));
    },
  },
  'device.rename': {
    right: 'device.manage',
    run(db, p, ctx) {
      need(exists(db, 'devices', p.deviceId), 'NOT_FOUND', 'device');
      run(db, 'UPDATE devices SET name=? WHERE id=?', reqStr(p.name, 'name', 40), p.deviceId);
      touch(db, ctx, 'devices', p.deviceId);
    },
  },
};
