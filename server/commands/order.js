// @ts-check
// Order commands (Day 11): open, lines, void (approval), hold, persons, comment,
// table transfer, customer, delivery platform, cancel.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { newId, touch, businessDate, nextCounter, str, reqStr, int, paise } from '../model.js';

export const PLATFORMS = ['Zomato', 'Swiggy', 'Phone', 'Other'];

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

/** Create an order row. @param {any} db @param {any} ctx @param {{type?: string, tableId?: string}} p */
export function createOrder(db, ctx, p) {
  const type = p.type ?? (p.tableId ? 'dine' : 'takeaway');
  need(['dine', 'takeaway', 'delivery'].includes(type), 'BAD_PAYLOAD', 'type');
  let tableId = null;
  if (type === 'dine') {
    need(typeof p.tableId === 'string' && get(db, 'SELECT id FROM dining_tables WHERE id=?', p.tableId), 'NOT_FOUND', 'table');
    tableId = p.tableId;
  }
  const bd = businessDate(db, ctx.now);
  const id = newId();
  const no = nextCounter(db, 'order', bd);
  run(db, 'INSERT INTO orders(id,no,business_date,type,table_id,status,opened_by,opened_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, no, bd, type, tableId, 'open', ctx.user.id, ctx.now, ctx.now);
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

/**
 * Price a client line on the host (host-authoritative prices).
 * Client sends {itemId, qty, variant?, extras?: string[], note?} or open item {name, pricePaise, qty}.
 * @param {any} db @param {any} l
 */
export function priceLine(db, l) {
  need(l && typeof l === 'object', 'BAD_PAYLOAD', 'line');
  const qty = int(l.qty ?? 1, 'qty', 1, 999);
  const note = str(l.note, 'note', 120);
  if (!l.itemId) {
    // open item
    return { itemId: null, name: reqStr(l.name, 'name', 60), unitPaise: paise(l.pricePaise, 'pricePaise'), variant: '', extras: [], qty, note, station: str(l.station, 'station', 20) || 'kitchen' };
  }
  const item = get(db, 'SELECT * FROM items WHERE id=? AND active=1', l.itemId);
  need(item, 'NOT_FOUND', 'item');
  let unit = item.price_paise, variant = '';
  if (l.variant) {
    const v = get(db, 'SELECT * FROM variants WHERE item_id=? AND (id=? OR name=?)', item.id, l.variant, l.variant);
    need(v, 'NOT_FOUND', 'variant');
    unit = v.price_paise; variant = v.name;
  }
  const extras = [];
  for (const e of Array.isArray(l.extras) ? l.extras : []) {
    const x = get(db, 'SELECT * FROM extras WHERE item_id=? AND (id=? OR name=?)', item.id, e, e);
    need(x, 'NOT_FOUND', 'extra');
    extras.push({ name: x.name, pricePaise: x.price_paise });
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

/** @param {any} db @param {any} p */
function loadLine(db, p) {
  const l = typeof p.lineId === 'string' ? get(db, 'SELECT * FROM order_lines WHERE id=?', p.lineId) : null;
  need(l, 'NOT_FOUND', 'line');
  return l;
}

/** @type {Record<string, import('../engine.js').Handler>} */
export const orderHandlers = {
  'order.open': {
    right: 'order',
    run(db, p, ctx) {
      const o = p.type === 'dine' || p.tableId ? (activeOrderForTable(db, p.tableId) ?? createOrder(db, ctx, p)) : createOrder(db, ctx, p);
      return { orderId: o.id, no: o.no };
    },
  },
  'order.line.add': {
    right: 'order',
    run(db, p, ctx) {
      const o = resolveOrder(db, ctx, p);
      needOpen(o);
      const lineIds = addLines(db, ctx, o.id, p.lines);
      bumpOrder(db, ctx, o.id);
      return { orderId: o.id, lineIds };
    },
  },
  'order.line.update': {
    right: 'order',
    run(db, p, ctx) {
      const l = loadLine(db, p);
      needOpen(loadOrder(db, l.order_id));
      need(!l.kot_id, 'LINE_SENT', 'Line already sent to kitchen — void it instead');
      need(!l.voided, 'LINE_VOID');
      const qty = p.qty === undefined ? l.qty : int(p.qty, 'qty', 1, 999);
      const note = p.note === undefined ? l.note : str(p.note, 'note', 120);
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
        // partial void: split the line
        run(db, 'UPDATE order_lines SET qty=? WHERE id=?', l.qty - qty, l.id);
        touch(db, ctx, 'order_lines', l.id);
        voidId = newId();
        run(db, 'INSERT INTO order_lines(id,order_id,item_id,name,qty,unit_paise,variant,extras,note,kot_id,voided,void_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)',
          voidId, l.order_id, l.item_id, l.name, qty, l.unit_paise, l.variant, l.extras, l.note, l.kot_id, reason, ctx.now);
      } else {
        run(db, 'UPDATE order_lines SET voided=1, void_reason=? WHERE id=?', reason, l.id);
      }
      touch(db, ctx, 'order_lines', voidId);
      logVoid(db, ctx, { entity: 'order_line', entityId: voidId, reason, detail: { name: l.name, qty, unitPaise: l.unit_paise, orderId: l.order_id } });
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
      need(typeof p.toTableId === 'string' && get(db, 'SELECT id FROM dining_tables WHERE id=?', p.toTableId), 'NOT_FOUND', 'table');
      need(p.toTableId !== o.table_id, 'BAD_PAYLOAD', 'same table');
      need(!activeOrderForTable(db, p.toTableId), 'TABLE_BUSY', 'Target table has an open order');
      run(db, 'UPDATE orders SET table_id=?, updated_at=? WHERE id=?', p.toTableId, ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
    },
  },
  'order.customer': {
    right: 'order',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      const customerId = upsertCustomer(db, ctx, p);
      run(db, 'UPDATE orders SET customer_id=?, updated_at=? WHERE id=?', customerId, ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
      return { customerId };
    },
  },
  'order.delivery': {
    right: 'delivery',
    run(db, p, ctx) {
      const o = loadOrder(db, p.orderId);
      need(PLATFORMS.includes(p.platform), 'BAD_PAYLOAD', 'platform must be one of ' + PLATFORMS.join('/'));
      run(db, "UPDATE orders SET type='delivery', table_id=NULL, platform=?, platform_ref=?, updated_at=? WHERE id=?", p.platform, str(p.ref, 'ref', 40), ctx.now, o.id);
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
      for (const l of all(db, 'SELECT id FROM order_lines WHERE order_id=? AND voided=0', o.id)) {
        run(db, 'UPDATE order_lines SET voided=1, void_reason=? WHERE id=?', reason, l.id);
        touch(db, ctx, 'order_lines', l.id);
      }
      run(db, "UPDATE orders SET status='cancelled', updated_at=? WHERE id=?", ctx.now, o.id);
      touch(db, ctx, 'orders', o.id);
      logVoid(db, ctx, { entity: 'order', entityId: o.id, reason, detail: { no: o.no } });
    },
  },
};

/** @param {any} db @param {any} ctx @param {{customerId?: string, phone?: string, name?: string, address?: string}} p */
export function upsertCustomer(db, ctx, p) {
  if (p.customerId) {
    need(get(db, 'SELECT id FROM customers WHERE id=?', p.customerId), 'NOT_FOUND', 'customer');
    return p.customerId;
  }
  const phone = reqStr(p.phone, 'phone', 15).replace(/[^\d+]/g, '');
  need(/^\+?\d{6,14}$/.test(phone), 'BAD_PAYLOAD', 'phone');
  const cur = get(db, 'SELECT * FROM customers WHERE phone=?', phone);
  const name = str(p.name, 'name', 60), address = str(p.address, 'address', 200);
  if (cur) {
    if (name || address) {
      run(db, 'UPDATE customers SET name=?, address=? WHERE id=?', name || cur.name, address || cur.address, cur.id);
      touch(db, ctx, 'customers', cur.id);
    }
    return cur.id;
  }
  const id = newId();
  run(db, 'INSERT INTO customers(id,name,phone,address,created_at) VALUES (?,?,?,?,?)', id, name, phone, address, ctx.now);
  touch(db, ctx, 'customers', id);
  return id;
}
