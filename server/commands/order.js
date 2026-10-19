// @ts-check
// Order commands (Day 11 + legacy parity): open (dine / pickup / delivery with app, ref, customer),
// lines (variants, shared extras with qty, notes), void (approval), remove (reason if reasonAll),
// hold, persons, comment, table transfer, customer details + tag, delivery platform and charge, cancel.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { newId, touch, businessDate, nextCounter, getSettings, str, reqStr, int, paise } from '../model.js';
import { linePaise } from '../domain/totals.js';

/** Delivery apps and their order-number prefixes (legacy: ZM1, SW2, PH3, DL4); pickup orders are PK1, PK2… */
export const PLATFORMS = /** @type {const} */ ([['Zomato', 'ZM'], ['Swiggy', 'SW'], ['Phone call', 'PH'], ['Other', 'DL']]);
export const PLATFORM_NAMES = PLATFORMS.map((p) => p[0]);
export const PICKUP_PREFIX = 'PK';

/** @param {any} db @param {string} id */
export function loadOrder(db, id) {
  const o = typeof id === 'string' ? get(db, 'SELECT * FROM orders WHERE id=?', id) : null;
  need(o, 'NOT_FOUND', 'order');
  return o;
}

/** @param {any} o */
export function needOpen(o) {
  if (o.status === 'billed') throw new CmdError('ORDER_BILLED', 'Bill already printed — void the bill to change the order');
  need(o.status === 'open', 'ORDER_CLOSED', `order is ${o.status}`);
}

/** @param {any} db @param {string} tableId */
export function activeOrderForTable(db, tableId) {
  return get(db, "SELECT * FROM orders WHERE table_id=? AND status IN ('open','billed') ORDER BY opened_at DESC LIMIT 1", tableId);
}

/** Digits only, like the legacy phoneKey. @param {any} p */
export const phoneKey = (p) => String(p ?? '').replace(/\D/g, '');

/** @param {any} c */
function customerFields(c) {
  const x = c && typeof c === 'object' ? c : {};
  const phone = phoneKey(x.phone);
  if (phone) need(phone.length >= 10 && phone.length <= 13, 'BAD_PAYLOAD', 'Mobile number should have 10 digits');
  return { name: str(x.name, 'name', 60), phone, address: str(x.address, 'address', 200), locality: str(x.locality, 'locality', 60), tag: str(x.tag, 'tag', 40) };
}

/**
 * Create an order. Dine-in needs a table; pickup (type 'takeaway') and delivery get a daily ref
 * per prefix (PK1, ZM1, SW1 …) like the legacy app.
 * @param {any} db @param {any} ctx @param {any} p
 */
export function createOrder(db, ctx, p) {
  const type = p.type ?? (p.tableId ? 'dine' : 'takeaway');
  need(['dine', 'takeaway', 'delivery'].includes(type), 'BAD_PAYLOAD', 'type');
  const s = getSettings(db);
  const bd = businessDate(db, ctx.now);
  let tableId = null, ref = '', platform = '';
  if (type === 'dine') {
    const t = typeof p.tableId === 'string' ? get(db, 'SELECT id, name FROM dining_tables WHERE id=?', p.tableId) : null;
    need(t, 'NOT_FOUND', 'table');
    tableId = t.id; ref = t.name;
  } else {
    let prefix = PICKUP_PREFIX;
    if (type === 'delivery') {
      const pf = PLATFORMS.find((x) => x[0] === p.platform) ?? PLATFORMS[3];
      platform = pf[0]; prefix = pf[1];
    }
    ref = prefix + nextCounter(db, 'ref:' + prefix, bd);
  }
  const c = customerFields(p.customer);
  const delivery = type === 'delivery' ? Math.round(Number(s.defaultDelivery || 0) * 100) : 0;
  const id = newId();
  const no = nextCounter(db, 'order', bd);
  run(db, `INSERT INTO orders(id,no,business_date,type,table_id,status,opened_by,opened_at,updated_at,ref,platform,platform_ref,delivery_paise,cust_name,cust_phone,cust_address,cust_locality,cust_tag)
    VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, no, bd, type, tableId, ctx.user.id, ctx.now, ctx.now, ref, platform, str(p.platformRef, 'platformRef', 40), delivery,
  c.name, c.phone, c.address, c.locality, c.tag);
  touch(db, ctx, 'orders', id);
  return get(db, 'SELECT * FROM orders WHERE id=?', id);
}

/** Order for a payload: explicit orderId, the table's active order, or a new one. @param {any} db @param {any} ctx @param {any} p */
export function resolveOrder(db, ctx, p) {
  if (p.orderId) return loadOrder(db, p.orderId);
  if (p.tableId && (p.type ?? 'dine') === 'dine') {
    const cur = activeOrderForTable(db, p.tableId);
    if (cur) return cur;
  }
  return createOrder(db, ctx, p);
}

/** Notes chosen from the list + typed request, joined like the legacy KOT "[Note] a, b, text". @param {any} l */
function noteOf(l) {
  const chosen = Array.isArray(l.notes) ? l.notes.map((/** @type {any} */ n) => str(n, 'note', 40)).filter(Boolean) : [];
  const text = str(l.note ?? l.text, 'note', 120);
  const all = [...chosen, text].filter(Boolean).join(', ');
  need(all.length <= 200, 'BAD_PAYLOAD', 'notes too long');
  return all;
}

/**
 * Price a client line on the host (host-authoritative prices).
 * Client sends {itemId, qty, variant?: id|name, sides?: [{id, qty}], notes?: string[], note?}
 * or an open item {name, pricePaise, qty}.
 * @param {any} db @param {any} l
 */
export function priceLine(db, l) {
  need(l && typeof l === 'object', 'BAD_PAYLOAD', 'line');
  const qty = int(l.qty ?? 1, 'qty', 1, 999);
  const note = noteOf(l);
  if (!l.itemId) {
    need(getSettings(db).allowOpenItem, 'FORBIDDEN', 'Open items are switched off in Settings');
    const unit = paise(l.pricePaise, 'pricePaise');
    need(unit > 0, 'BAD_PAYLOAD', 'Please type the price');
    return { itemId: null, name: reqStr(l.name, 'name', 60), unitPaise: unit, variant: '', extras: [], qty, note, station: str(l.station, 'station', 20) || 'kitchen' };
  }
  const item = get(db, 'SELECT * FROM items WHERE id=? AND active=1', l.itemId);
  need(item, 'NOT_FOUND', 'item');
  need(item.available, 'NOT_AVAILABLE', `${item.name} is not available today`);
  let unit = item.price_paise, variant = '';
  const hasVariants = !!get(db, 'SELECT 1 AS x FROM variants WHERE item_id=?', item.id);
  if (l.variant) {
    const v = get(db, 'SELECT * FROM variants WHERE item_id=? AND (id=? OR name=?)', item.id, l.variant, l.variant);
    need(v, 'NOT_FOUND', 'variant');
    unit = v.price_paise; variant = v.name;
  } else need(!hasVariants, 'VARIANT_REQUIRED', `Choose a variation of ${item.name}`);
  const extras = [];
  const sides = Array.isArray(l.sides) ? l.sides : [];
  if (sides.length) need(item.allow_sides, 'BAD_PAYLOAD', `${item.name} does not take extras`);
  for (const sd of sides) {
    const x = get(db, 'SELECT * FROM sides WHERE id=? OR name=?', sd?.id ?? sd, sd?.id ?? sd);
    need(x, 'NOT_FOUND', 'extra');
    extras.push({ id: x.id, name: x.name, pricePaise: x.price_paise, qty: int(sd?.qty ?? 1, 'extra qty', 1, 20) });
  }
  return { itemId: item.id, name: item.name, unitPaise: unit, variant, extras, qty, note, station: item.station || 'kitchen' };
}

/** @param {any} db @param {any} ctx @param {string} orderId @param {any[]} lines */
export function addLines(db, ctx, orderId, lines) {
  need(Array.isArray(lines) && lines.length > 0 && lines.length <= 100, 'BAD_PAYLOAD', 'lines');
  const ids = [];
  for (const raw of lines) {
    const l = priceLine(db, raw);
    const id = newId();
    run(db, 'INSERT INTO order_lines(id,order_id,item_id,name,qty,unit_paise,variant,extras,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, orderId, l.itemId, l.name, l.qty, l.unitPaise, l.variant, JSON.stringify(l.extras), l.note, ctx.now);
    touch(db, ctx, 'order_lines', id);
    ids.push(id);
  }
  return ids;
}

/** @param {any} db @param {any} ctx @param {string} orderId */
export function bumpOrder(db, ctx, orderId) {
  run(db, 'UPDATE orders SET updated_at=? WHERE id=?', ctx.now, orderId);
  touch(db, ctx, 'orders', orderId);
}

/** @param {any} db @param {any} ctx @param {{entity: string, entityId: string, reason: string, detail?: any}} v */
export function logVoid(db, ctx, v) {
  run(db, 'INSERT INTO void_log(id,entity,entity_id,business_date,reason,detail,user_id,approver_id,ts) VALUES (?,?,?,?,?,?,?,?,?)',
    newId(), v.entity, v.entityId, businessDate(db, ctx.now), v.reason, JSON.stringify(v.detail ?? {}), ctx.user.id, ctx.approver?.id ?? null, ctx.now);
}

/** Void-log detail for a line (legacy deleted-items record). @param {any} db @param {any} l @param {number} qty */
function lineDetail(db, l, qty) {
  const o = get(db, 'SELECT ref, type FROM orders WHERE id=?', l.order_id);
  const k = l.kot_id ? get(db, 'SELECT no FROM kots WHERE id=?', l.kot_id) : null;
  return {
    name: l.name + (l.variant ? ` (${l.variant})` : ''), qty, unitPaise: l.unit_paise, orderId: l.order_id,
    amountPaise: linePaise({ unit_paise: l.unit_paise, qty, extras: qty === l.qty ? l.extras : '[]' }),
    table: o?.ref ?? '', kot: k?.no ?? null, sent: !!l.kot_id,
  };
}

/** @param {any} db @param {any} p */
function loadLine(db, p) {
  const l = typeof p.lineId === 'string' ? get(db, 'SELECT * FROM order_lines WHERE id=?', p.lineId) : null;
  need(l, 'NOT_FOUND', 'line');
  return l;
}

/**
 * Keep the customers book up to date (legacy rememberCustomer): by mobile number.
 * @param {any} db @param {any} ctx @param {{name?: string, phone?: string, address?: string, locality?: string, tag?: string}} c
 * @param {{visit?: boolean, dueAdd?: number}} [o]
 */
export function rememberCustomer(db, ctx, c, o = {}) {
  const phone = phoneKey(c.phone);
  if (!phone) return null;
  let cur = get(db, 'SELECT * FROM customers WHERE phone=?', phone);
  if (!cur) {
    const id = newId();
    run(db, 'INSERT INTO customers(id,name,phone,address,locality,tag,created_at) VALUES (?,?,?,?,?,?,?)', id, c.name ?? '', phone, c.address ?? '', c.locality ?? '', c.tag ?? '', ctx.now);
    cur = get(db, 'SELECT * FROM customers WHERE id=?', id);
  } else {
    run(db, 'UPDATE customers SET name=?, address=?, locality=?, tag=? WHERE id=?',
      c.name || cur.name, c.address || cur.address, c.locality || cur.locality, c.tag ?? cur.tag, cur.id);
  }
  if (o.visit) run(db, 'UPDATE customers SET visits=visits+1, last_visit=? WHERE id=?', ctx.now, cur.id);
  if (o.dueAdd) run(db, 'UPDATE customers SET due_paise=due_paise+? WHERE id=?', o.dueAdd, cur.id);
  touch(db, ctx, 'customers', cur.id);
  return cur.id;
}

/** @type {Record<string, import('../engine.js').Handler>} */
export const orderHandlers = {
  'order.open': {
    right: 'order',
    run(db, p, ctx) {
      const o = p.type === 'dine' || p.tableId ? (activeOrderForTable(db, p.tableId) ?? createOrder(db, ctx, p)) : createOrder(db, ctx, p);
      return { orderId: o.id, no: o.no, ref: o.ref };
    },
  },
  'order.line.add': {
    right: 'order',
    run(db, p, ctx) {
      const o = resolveOrder(db, ctx, p);
      needOpen(o);
      const lineIds = addLines(db, ctx, o.id, p.lines);
      run(db, 'UPDATE orders SET held=0 WHERE id=?', o.id);
      bumpOrder(db, ctx, o.id);
      return { orderId: o.id, lineIds, ref: o.ref };
    },
  },
  'order.line.update': {
    right: 'order',
    run(db, p, ctx) {
      const l = loadLine(db, p);
      needOpen(loadOrder(db, l.order_id));
      need(!l.kot_id, 'LINE_SENT', 'Already sent to the kitchen. To add more, tap the dish again.');
      need(!l.voided, 'LINE_VOID');
      const qty = p.qty === undefined ? l.qty : int(p.qty, 'qty', 1, 999);
      const note = p.note === undefined && p.notes === undefined ? l.note : noteOf(p);
      run(db, 'UPDATE order_lines SET qty=?, note=? WHERE id=?', qty, note, l.id);
      touch(db, ctx, 'order_lines', l.id);
      bumpOrder(db, ctx, l.order_id);
    },
  },
  'order.line.remove': {
    right: 'order',
    run(db, p, ctx) {
      const l = loadLine(db, p);
      needOpen(loadOrder(db, l.order_id));
      need(!l.kot_id, 'LINE_SENT', 'Line already sent to kitchen — void it instead');
      if (getSettings(db).reasonAll) {
        const reason = reqStr(p.reason, 'reason', 120);
        logVoid(db, ctx, { entity: 'order_line', entityId: l.id, reason, detail: lineDetail(db, l, l.qty) });
      }
      run(db, 'DELETE FROM order_lines WHERE id=?', l.id);
      touch(db, ctx, 'order_lines', l.id);
      bumpOrder(db, ctx, l.order_id);
    },
  },
  'order.line.void': {
    base: 'order', right: 'void', approvable: true,
    run(db, p, ctx) {
      const l = loadLine(db, p);
      needOpen(loadOrder(db, l.order_id));
      need(!l.voided, 'LINE_VOID');
      const reason = reqStr(p.reason, 'reason', 120);
      const qty = p.qty === undefined ? l.qty : int(p.qty, 'qty', 1, l.qty);
      let voidId = l.id;
      if (qty < l.qty) {
        // partial void: split the line (extras stay with the remaining units)
        run(db, 'UPDATE order_lines SET qty=? WHERE id=?', l.qty - qty, l.id);
        touch(db, ctx, 'order_lines', l.id);
        voidId = newId();
        run(db, 'INSERT INTO order_lines(id,order_id,item_id,name,qty,unit_paise,variant,extras,note,kot_id,voided,void_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)',
          voidId, l.order_id, l.item_id, l.name, qty, l.unit_paise, l.variant, '[]', l.note, l.kot_id, reason, ctx.now);
      } else {
        run(db, 'UPDATE order_lines SET voided=1, void_reason=? WHERE id=?', reason, l.id);
      }
      touch(db, ctx, 'order_lines', voidId);
      logVoid(db, ctx, { entity: 'order_line', entityId: voidId, reason, detail: lineDetail(db, l, qty) });
      bumpOrder(db, ctx, l.order_id);
      return { lineId: voidId };
    },
  },
  'order.hold': {
    right: 'order',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      run(db, 'UPDATE orders SET held=?, updated_at=? WHERE id=?', p.held ? 1 : 0, ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'order.persons': {
    right: 'order',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      run(db, 'UPDATE orders SET persons=?, updated_at=? WHERE id=?', int(p.persons, 'persons', 0, 200), ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'order.comment': {
    right: 'order',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      run(db, 'UPDATE orders SET comment=?, updated_at=? WHERE id=?', str(p.comment, 'comment', 200), ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'table.transfer': {
    right: 'table.transfer',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      need(o.status === 'open' || o.status === 'billed', 'ORDER_CLOSED');
      need(o.type === 'dine', 'BAD_PAYLOAD', 'only dine-in orders have tables');
      const t = typeof p.toTableId === 'string' ? get(db, 'SELECT id, name FROM dining_tables WHERE id=?', p.toTableId) : null;
      need(t, 'NOT_FOUND', 'table');
      need(t.id !== o.table_id, 'BAD_PAYLOAD', 'same table');
      need(!activeOrderForTable(db, t.id), 'TABLE_BUSY', 'Target table has an open order');
      run(db, 'UPDATE orders SET table_id=?, ref=?, updated_at=? WHERE id=?', t.id, t.name, ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'order.customer': {
    right: 'order',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      const c = customerFields(p.customerId ? get(db, 'SELECT * FROM customers WHERE id=?', p.customerId) ?? {} : p);
      if (c.tag) need((getSettings(db).custTags ?? []).some((/** @type {any} */ t) => t.id === c.tag), 'NOT_FOUND', 'customer tag');
      run(db, 'UPDATE orders SET cust_name=?, cust_phone=?, cust_address=?, cust_locality=?, cust_tag=?, updated_at=? WHERE id=?',
        c.name, c.phone, c.address, c.locality, c.tag, ctx.now, o.id);
      const customerId = c.phone ? rememberCustomer(db, ctx, c) : null;
      if (customerId) run(db, 'UPDATE orders SET customer_id=? WHERE id=?', customerId, o.id);
      touch(db, ctx, 'orders', o.id);
      return { customerId };
    },
  },
  'order.delivery': {
    right: 'delivery',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      need(PLATFORM_NAMES.includes(p.platform), 'BAD_PAYLOAD', 'platform must be one of ' + PLATFORM_NAMES.join('/'));
      run(db, "UPDATE orders SET type='delivery', table_id=NULL, platform=?, platform_ref=?, updated_at=? WHERE id=?", p.platform, str(p.ref, 'ref', 40), ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  // legacy right 'delivery' = "Change delivery charge"
  'order.delivery.charge': {
    right: 'delivery',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      needOpen(o);
      run(db, 'UPDATE orders SET delivery_paise=?, updated_at=? WHERE id=?', paise(p.amountPaise, 'amountPaise'), ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'order.cancel': {
    base: 'order', right: 'void', approvable: true,
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      need(o.status === 'open' || o.status === 'billed', 'ORDER_CLOSED');
      const reason = reqStr(p.reason, 'reason', 120);
      for (const b of all(db, "SELECT id FROM bills WHERE order_id=? AND status='open'", o.id)) {
        run(db, "UPDATE bills SET status='void', updated_at=? WHERE id=?", ctx.now, b.id);
        touch(db, ctx, 'bills', b.id);
      }
      for (const k of all(db, "SELECT id, status FROM kots WHERE order_id=? AND status IN ('new','accepted','preparing','ready')", o.id)) {
        run(db, "UPDATE kots SET status='cancelled', reason=?, updated_at=? WHERE id=?", reason, ctx.now, k.id);
        run(db, 'INSERT INTO kot_status_log(kot_id,from_status,to_status,reason,user_id,approver_id,ts) VALUES (?,?,?,?,?,?,?)', k.id, k.status, 'cancelled', reason, ctx.user.id, ctx.approver?.id ?? null, ctx.now);
        touch(db, ctx, 'kots', k.id);
      }
      for (const l of all(db, 'SELECT * FROM order_lines WHERE order_id=? AND voided=0', o.id)) {
        run(db, 'UPDATE order_lines SET voided=1, void_reason=? WHERE id=?', reason, l.id);
        touch(db, ctx, 'order_lines', l.id);
        if (l.kot_id) logVoid(db, ctx, { entity: 'order_line', entityId: l.id, reason, detail: lineDetail(db, l, l.qty) });
      }
      run(db, "UPDATE orders SET status='cancelled', updated_at=? WHERE id=?", ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
      logVoid(db, ctx, { entity: 'order', entityId: o.id, reason, detail: { no: o.no, table: o.ref } });
    },
  },
};

/** Legacy-compatible alias used by bill settlement. @param {any} db @param {any} ctx @param {any} p */
export function upsertCustomer(db, ctx, p) {
  if (p.customerId) {
    need(get(db, 'SELECT id FROM customers WHERE id=?', p.customerId), 'NOT_FOUND', 'customer');
    return p.customerId;
  }
  const c = customerFields(p);
  need(c.phone, 'BAD_PAYLOAD', 'phone');
  return rememberCustomer(db, ctx, c);
}
