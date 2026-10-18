// @ts-check
// KOT commands (Day 2 / Day 14): create (order auto-open, daily KOT numbers), status machine, recall.
import { get, all, run } from '../db.js';
import { CmdError, need } from '../errors.js';
import { newId, touch, businessDate, nextCounter, getSettings, str, reqStr } from '../model.js';
import { resolveOrder, needOpen, addLines, bumpOrder, logVoid } from './order.js';

/** PLAN §7: new → accepted → preparing → ready → served; new|accepted → rejected; not served → cancelled. */
export const TRANSITIONS = Object.freeze({
  new: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'rejected', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'cancelled'],
  served: [],
  rejected: [],
  cancelled: [],
});
export const RECALL_MS = 2 * 60_000;

/** @param {string} to */
export function rightForStatus(to) {
  if (to === 'served') return 'serve';
  if (to === 'cancelled') return 'void';
  return 'kitchen.status';
}

/** @param {any} db @param {string} id */
function loadKot(db, id) {
  const k = typeof id === 'string' ? get(db, 'SELECT * FROM kots WHERE id=?', id) : null;
  need(k, 'NOT_FOUND', 'kot');
  return k;
}

/** @param {any} db @param {any} ctx @param {any} k @param {string} to @param {string} reason */
function setStatus(db, ctx, k, to, reason) {
  run(db, 'UPDATE kots SET status=?, reason=?, updated_at=? WHERE id=?', to, reason, ctx.now, k.id);
  run(db, 'INSERT INTO kot_status_log(kot_id,from_status,to_status,reason,user_id,approver_id,ts) VALUES (?,?,?,?,?,?,?)',
    k.id, k.status, to, reason, ctx.user.id, ctx.approver && ctx.approver.id !== ctx.user.id ? ctx.approver.id : null, ctx.now);
  touch(db, ctx, 'kots', k.id);
}

/** @type {Record<string, import('../engine.js').Handler>} */
export const kotHandlers = {
  'kot.create': {
    right: 'kot',
    run(db, p, ctx) {
      const o = resolveOrder(db, ctx, p);
      needOpen(o);
      if (Array.isArray(p.lines) && p.lines.length) addLines(db, ctx, o.id, p.lines);
      const pending = all(db, 'SELECT l.id, COALESCE(i.station, ?) AS station FROM order_lines l LEFT JOIN items i ON i.id=l.item_id WHERE l.order_id=? AND l.kot_id IS NULL AND l.voided=0 ORDER BY l.created_at, l.rowid', 'kitchen', o.id);
      need(pending.length, 'NO_LINES', 'Nothing new to send');
      const bd = businessDate(db, ctx.now);
      const note = str(p.note, 'note', 200);
      /** @type {Map<string, string[]>} */
      const byStation = new Map();
      for (const l of pending) byStation.set(l.station, [...(byStation.get(l.station) ?? []), l.id]);
      const kots = [];
      for (const [station, lineIds] of byStation) {
        const id = newId();
        const no = nextCounter(db, 'kot', bd);
        run(db, 'INSERT INTO kots(id,no,business_date,order_id,station,status,note,created_by,device_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          id, no, bd, o.id, station, 'new', note, ctx.user.id, ctx.device.id, ctx.now, ctx.now);
        run(db, 'INSERT INTO kot_status_log(kot_id,from_status,to_status,user_id,ts) VALUES (?,?,?,?,?)', id, null, 'new', ctx.user.id, ctx.now);
        for (const lid of lineIds) {
          run(db, 'UPDATE order_lines SET kot_id=? WHERE id=?', id, lid);
          touch(db, ctx, 'order_lines', lid);
        }
        touch(db, ctx, 'kots', id);
        kots.push({ id, no, station });
      }
      bumpOrder(db, ctx, o.id);
      if (getSettings(db).kotAutoPrint && ctx.hooks?.print) {
        for (const k of kots) ctx.after(() => ctx.hooks.print('kot', k.id));
      }
      return { orderId: o.id, orderNo: o.no, kots };
    },
  },

  'kot.status': {
    right: (p) => rightForStatus(p.to), approvable: (p) => p.to === 'cancelled',
    run(db, p, ctx) {
      const k = loadKot(db, p.kotId);
      const to = p.to;
      const allowed = /** @type {Record<string, string[]>} */ (TRANSITIONS)[k.status] ?? [];
      if (!allowed.includes(to)) throw new CmdError('BAD_TRANSITION', `${k.status} → ${to}`);
      let reason = '';
      if (to === 'rejected' || to === 'cancelled') {
        reason = reqStr(p.reason, 'reason', 120);
        for (const l of all(db, 'SELECT id FROM order_lines WHERE kot_id=? AND voided=0', k.id)) {
          run(db, 'UPDATE order_lines SET voided=1, void_reason=? WHERE id=?', `${to}: ${reason}`, l.id);
          touch(db, ctx, 'order_lines', l.id);
        }
        logVoid(db, ctx, { entity: 'kot', entityId: k.id, reason: `${to}: ${reason}`, detail: { no: k.no, orderId: k.order_id } });
        bumpOrder(db, ctx, k.order_id);
      }
      setStatus(db, ctx, k, to, reason);
      return { kotId: k.id, status: to };
    },
  },

  'kot.recall': {
    right: 'kitchen.status',
    run(db, p, ctx) {
      const k = loadKot(db, p.kotId);
      const last = get(db, 'SELECT * FROM kot_status_log WHERE kot_id=? ORDER BY id DESC LIMIT 1', k.id);
      need(last && ['accepted', 'preparing', 'ready'].includes(last.to_status) && last.from_status, 'CANNOT_RECALL', 'Nothing to recall');
      need(ctx.now - last.ts <= RECALL_MS, 'CANNOT_RECALL', 'Recall window (2 min) passed');
      setStatus(db, ctx, k, last.from_status, 'recall');
      return { kotId: k.id, status: last.from_status };
    },
  },
};
