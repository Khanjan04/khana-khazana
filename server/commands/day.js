// @ts-check
// Day close (Day 17) and print commands (Day 18).
import { get, run } from '../db.js';
import { need } from '../errors.js';
import { businessDate, nextDay } from '../model.js';
import { dayTally } from '../reports.js';

/** @type {Record<string, import('../engine.js').Handler>} */
export const dayHandlers = {
  'dayclose': {
    right: 'dayclose',
    run(db, p, ctx) {
      const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : businessDate(db, ctx.now);
      need(!get(db, 'SELECT 1 AS x FROM day_close WHERE business_date=?', date), 'ALREADY_CLOSED', date);
      const summary = dayTally(db, date);
      need(summary.openOrders === 0 || p.force === true, 'OPEN_ORDERS', `${summary.openOrders} order(s) still open on ${date}`);
      run(db, 'INSERT INTO day_close(business_date,closed_at,closed_by,summary) VALUES (?,?,?,?)', date, ctx.now, ctx.user.id, JSON.stringify(summary));
      // Locking the date makes businessDate() move on, and KOT/order counters are keyed by
      // business date, so they restart at 1 automatically.
      ctx.emit('day_close', date, { businessDate: date, closedAt: ctx.now });
      ctx.emit('meta', 'businessDate', { value: businessDate(db, ctx.now) });
      if (ctx.hooks?.backup) ctx.after(() => ctx.hooks.backup('dayclose-' + date));
      return { date, next: nextDay(date), summary };
    },
  },

  'print.kot': {
    right: 'kot.reprint',
    run(db, p, ctx) {
      need(typeof p.kotId === 'string' && get(db, 'SELECT id FROM kots WHERE id=?', p.kotId), 'NOT_FOUND', 'kot');
      need(ctx.hooks?.print, 'NO_PRINTER');
      ctx.after(() => ctx.hooks.print('kot', p.kotId, { reprint: true }));
      return { queued: true };
    },
  },
  'print.bill': {
    right: 'bill',
    run(db, p, ctx) {
      need(typeof p.billId === 'string' && get(db, 'SELECT id FROM bills WHERE id=?', p.billId), 'NOT_FOUND', 'bill');
      need(ctx.hooks?.print, 'NO_PRINTER');
      ctx.after(() => ctx.hooks.print('bill', p.billId));
      return { queued: true };
    },
  },
  'print.test': {
    right: 'settings',
    run(db, p, ctx) {
      need(ctx.hooks?.print, 'NO_PRINTER');
      ctx.after(() => ctx.hooks.print('test', String(p.station || 'kitchen')));
      return { queued: true };
    },
  },
};
