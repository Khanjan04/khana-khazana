// @ts-check
// Admin commands (Day 9 / Day 10): menu, layout, settings, users, roles, devices, kitchen notes.
// Legacy limits: ≤12 groups, ≤10 sub-groups per group, ≤100 items, ≤10 sections, ≤100 users, PIN 4–8.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { newId, touch, SETTING_DEFAULTS, getSettings, putSetting, str, reqStr, int, paise } from '../model.js';
import { RIGHTS } from '../rights.js';
import { hashPin, validPin, createPairCode, revokeDevice } from '../auth.js';

export const LIMITS = Object.freeze({ groups: 12, subgroups: 10, items: 100, sections: 10, tablesPerSection: 60, users: 100 });

/** @param {any} db @param {string} sql @param {...any} p */
const count = (db, sql, ...p) => Number(get(db, sql, ...p).n);

/** @param {any} db @param {string} table @param {any} id */
const exists = (db, table, id) => typeof id === 'string' && !!get(db, `SELECT id FROM ${table} WHERE id=?`, id);

/** @param {any} v */
const sort = (v) => (v === undefined ? 0 : int(v, 'sort', 0, 9999));

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
  'menu.group.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'menu_groups', p.id), 'NOT_FOUND', 'group');
      need(!count(db, 'SELECT COUNT(*) AS n FROM items WHERE group_id=?', p.id), 'IN_USE', 'Group still has items');
      for (const s of all(db, 'SELECT id FROM menu_subgroups WHERE group_id=?', p.id)) {
        run(db, 'DELETE FROM menu_subgroups WHERE id=?', s.id);
        touch(db, ctx, 'menu_subgroups', s.id);
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
        run(db, 'UPDATE items SET subgroup_id=NULL WHERE id=?', i.id);
        touch(db, ctx, 'items', i.id);
      }
      run(db, 'DELETE FROM menu_subgroups WHERE id=?', p.id);
      touch(db, ctx, 'menu_subgroups', p.id);
    },
  },
  'menu.item.save': {
    right: 'menu',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 60);
      need(exists(db, 'menu_groups', p.groupId), 'NOT_FOUND', 'group');
      const subgroupId = p.subgroupId ? p.subgroupId : null;
      if (subgroupId) need(get(db, 'SELECT id FROM menu_subgroups WHERE id=? AND group_id=?', subgroupId, p.groupId), 'NOT_FOUND', 'subgroup');
      const code = str(p.code, 'code', 10);
      const diet = p.diet ?? 'veg';
      need(['veg', 'nonveg', 'egg'].includes(diet), 'BAD_PAYLOAD', 'diet');
      const price = paise(p.pricePaise, 'pricePaise');
      const station = str(p.station, 'station', 20) || 'kitchen';
      let id = p.id;
      const isNew = !exists(db, 'items', id);
      if (code) need(!get(db, 'SELECT id FROM items WHERE code=? AND id<>? AND active=1', code, id ?? ''), 'DUPLICATE', `short code ${code} in use`);
      let image = isNew ? '' : get(db, 'SELECT image FROM items WHERE id=?', id).image;
      if (typeof p.imageData === 'string' && p.imageData) {
        need(ctx.hooks?.saveImage, 'NO_IMAGES');
        image = ctx.hooks.saveImage(p.imageData);
      } else if (p.imageData === null) image = '';
      if (isNew) {
        need(count(db, 'SELECT COUNT(*) AS n FROM items WHERE active=1') < LIMITS.items, 'LIMIT', `max ${LIMITS.items} items`);
        id = newId();
        run(db, 'INSERT INTO items(id,group_id,subgroup_id,name,code,price_paise,diet,station,favourite,image,active,sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          id, p.groupId, subgroupId, name, code, price, diet, station, !!p.favourite, image, p.active !== false, sort(p.sort));
      } else {
        run(db, 'UPDATE items SET group_id=?, subgroup_id=?, name=?, code=?, price_paise=?, diet=?, station=?, favourite=?, image=?, active=?, sort=? WHERE id=?',
          p.groupId, subgroupId, name, code, price, diet, station, !!p.favourite, image, p.active !== false, sort(p.sort), id);
      }
      if (Array.isArray(p.variants)) {
        need(p.variants.length <= 10, 'LIMIT', 'max 10 variants');
        run(db, 'DELETE FROM variants WHERE item_id=?', id);
        p.variants.forEach((/** @type {any} */ v, /** @type {number} */ i) => run(db, 'INSERT INTO variants(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), id, reqStr(v.name, 'variant.name', 30), paise(v.pricePaise, 'variant.pricePaise'), i));
      }
      if (Array.isArray(p.extras)) {
        need(p.extras.length <= 20, 'LIMIT', 'max 20 extras');
        run(db, 'DELETE FROM extras WHERE item_id=?', id);
        p.extras.forEach((/** @type {any} */ v, /** @type {number} */ i) => run(db, 'INSERT INTO extras(id,item_id,name,price_paise,sort) VALUES (?,?,?,?,?)', newId(), id, reqStr(v.name, 'extra.name', 30), paise(v.pricePaise, 'extra.pricePaise'), i));
      }
      touch(db, ctx, 'items', id);
      return { id };
    },
  },
  'menu.item.delete': {
    right: 'menu',
    run(db, p, ctx) {
      need(exists(db, 'items', p.id), 'NOT_FOUND', 'item');
      // soft delete: order lines keep their own name/price copy
      run(db, "UPDATE items SET active=0, code='' WHERE id=?", p.id);
      touch(db, ctx, 'items', p.id);
    },
  },
  'kitchen_note.save': {
    right: 'menu',
    run(db, p, ctx) {
      const text = reqStr(p.text, 'text', 40);
      let id = p.id;
      if (exists(db, 'kitchen_notes', id)) run(db, 'UPDATE kitchen_notes SET text=?, sort=? WHERE id=?', text, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM kitchen_notes') < 30, 'LIMIT', 'max 30 notes');
        id = newId();
        run(db, 'INSERT INTO kitchen_notes(id,text,sort) VALUES (?,?,?)', id, text, sort(p.sort));
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

  // ---------- layout ----------
  'layout.section.save': {
    right: 'layout',
    run(db, p, ctx) {
      const name = reqStr(p.name, 'name', 30);
      let id = p.id;
      if (exists(db, 'sections', id)) run(db, 'UPDATE sections SET name=?, sort=? WHERE id=?', name, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM sections') < LIMITS.sections, 'LIMIT', `max ${LIMITS.sections} sections`);
        id = newId();
        run(db, 'INSERT INTO sections(id,name,sort) VALUES (?,?,?)', id, name, sort(p.sort));
      }
      touch(db, ctx, 'sections', id);
      return { id };
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
      const seats = p.seats === undefined ? 4 : int(p.seats, 'seats', 1, 50);
      let id = p.id;
      if (exists(db, 'dining_tables', id)) run(db, 'UPDATE dining_tables SET section_id=?, name=?, seats=?, sort=? WHERE id=?', p.sectionId, name, seats, sort(p.sort), id);
      else {
        need(count(db, 'SELECT COUNT(*) AS n FROM dining_tables WHERE section_id=?', p.sectionId) < LIMITS.tablesPerSection, 'LIMIT', 'too many tables');
        id = newId();
        run(db, 'INSERT INTO dining_tables(id,section_id,name,seats,sort) VALUES (?,?,?,?,?)', id, p.sectionId, name, seats, sort(p.sort));
      }
      touch(db, ctx, 'dining_tables', id);
      return { id };
    },
  },
  'layout.table.delete': {
    right: 'layout',
    run(db, p, ctx) {
      need(exists(db, 'dining_tables', p.id), 'NOT_FOUND', 'table');
      need(!get(db, 'SELECT id FROM orders WHERE table_id=? LIMIT 1', p.id), 'IN_USE', 'Table has order history; rename it instead');
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
        if (Array.isArray(defs[k])) {
          need(Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && /^http:\/\/[\w.-]+:\d+$/.test(x)), 'BAD_PAYLOAD', `${k}: list of http://ip:port`);
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
        if (k === 'cgst' || k === 'sgst' || k === 'serviceChargePct') need(v >= 0 && v <= 30, 'BAD_PAYLOAD', `${k} 0..30`);
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
