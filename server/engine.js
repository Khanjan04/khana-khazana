// @ts-check
// Command engine — opId idempotency + global seq (GUIDE §5.2).
import { tx, get, run } from './db.js';
import { can } from './rights.js';
import { handlers } from './commands/index.js';
import { CmdError } from './errors.js';
import { verifyApproval } from './auth.js';

export { CmdError };

/**
 * @typedef {{ id: string, name: string, roleId: string, rights: Set<string> }} User
 * @typedef {{ user: User, device: { id: string, name?: string, kind?: string }, now?: number, hooks?: Record<string, Function> }} Ctx
 * @typedef {{ right: string | ((p: any) => string), base?: string, approvable?: boolean | ((p: any) => boolean),
 *   run: (db: any, payload: any, ctx: any) => any }} Handler
 */

/**
 * @param {any} db
 * @param {(msg: any) => void} broadcast
 */
export function createEngine(db, broadcast) {
  /**
   * @param {{opId: string, type: string, payload?: any}} cmd
   * @param {Ctx} ctx
   */
  return function exec({ opId, type, payload }, ctx) {
    if (typeof opId !== 'string' || !opId || opId.length > 64) throw new CmdError('BAD_OPID');
    const prior = get(db, 'SELECT result FROM ops WHERE op_id=?', opId);
    if (prior) return JSON.parse(prior.result);                                   // idempotent
    const h = /** @type {Record<string, Handler>} */ (handlers)[type];
    if (!h) throw new CmdError('UNKNOWN_CMD', type);
    const p = payload && typeof payload === 'object' ? payload : {};
    const now = ctx.now ?? Date.now();
    if (h.base && !can(ctx.user, h.base)) throw new CmdError('FORBIDDEN', h.base);
    const right = typeof h.right === 'function' ? h.right(p) : h.right;
    const approvable = typeof h.approvable === 'function' ? h.approvable(p) : !!h.approvable;
    /** @type {User | null} */
    let approver = null;
    if (!can(ctx.user, right)) {                                                   // server-side check
      if (!approvable) throw new CmdError('FORBIDDEN', right);
      if (!p.approval) throw new CmdError('APPROVAL_REQUIRED', right);
      approver = verifyApproval(db, p.approval, right, now);
    } else if (approvable) approver = ctx.user;

    /** @type {{entity: string, id: string, value: any}[]} */
    const changes = [];
    /** @type {(() => void)[]} */
    const after = [];
    let seq = 0;
    const result = tx(db, () => {
      const out = h.run(db, p, {
        ...ctx, now, approver,
        emit: (/** @type {string} */ entity, /** @type {string} */ id, /** @type {any} */ value) => changes.push({ entity, id, value }),
        after: (/** @type {() => void} */ fn) => after.push(fn),
      });
      if (changes.length) {
        seq = Number(get(db, 'INSERT INTO events(op_id,type,user_id,device_id,approver_id,changes,ts) VALUES (?,?,?,?,?,?,?) RETURNING seq',
          opId, type, ctx.user.id, ctx.device.id, approver && approver !== ctx.user ? approver.id : null, JSON.stringify(changes), now).seq);
      }
      const res = { ok: true, result: out ?? null, seq };
      run(db, 'INSERT INTO ops(op_id,type,user_id,device_id,result,ts) VALUES (?,?,?,?,?,?)', opId, type, ctx.user.id, ctx.device.id, JSON.stringify(res), now);
      return res;
    });
    if (changes.length) broadcast({ t: 'evt', seq, data: { changes } });         // after commit
    for (const fn of after) {
      try { fn(); } catch (e) { console.error('after-commit hook failed', e); }
    }
    return result;
  };
}
