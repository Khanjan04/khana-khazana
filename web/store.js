// @ts-check
// Client replica: snapshot + events. Read-only view of host state; never the source of truth.
import { billTotals, totalsToPaise, linePaise } from '../server/domain/totals.js';

const CACHE = 'pos.cache';

export const store = {
  /** @type {Record<string, Map<string, any>>} */
  data: {},
  /** @type {Record<string, any>} */
  settings: {},
  businessDate: '',
  /** @type {Set<string>} */
  closedDays: new Set(),
};

/** @type {Set<(changes: any[] | null) => void>} */
const listeners = new Set();
/** @param {(changes: any[] | null) => void} fn */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** @param {any[] | null} changes */
function notify(changes) {
  for (const fn of listeners) fn(changes);
  persistSoon();
}

/** @param {string} entity */
export function table(entity) {
  return (store.data[entity] ??= new Map());
}
/** @param {string} entity @returns {any[]} */
export const list = (entity) => [...table(entity).values()];
/** @param {string} entity @param {string | null | undefined} id */
export const byId = (entity, id) => (id ? table(entity).get(id) : undefined);

/** @param {{seq: number, data: {entities: Record<string, any[]>, settings: any, businessDate: string}}} snap */
export function loadSnapshot(snap) {
  store.data = {};
  for (const [t, rows] of Object.entries(snap.data.entities)) {
    const m = table(t);
    for (const r of rows) if (r) m.set(r.id, r);
  }
  store.settings = snap.data.settings;
  store.businessDate = snap.data.businessDate;
  notify(null);
}

/** @param {{entity: string, id: string, value: any}[]} changes */
export function applyChanges(changes) {
  for (const c of changes) {
    if (c.entity === 'settings') store.settings = c.value;
    else if (c.entity === 'meta' && c.id === 'businessDate') store.businessDate = c.value.value;
    else if (c.entity === 'day_close') store.closedDays.add(c.id);
    else if (c.value === null) table(c.entity).delete(c.id);
    else table(c.entity).set(c.id, c.value);
  }
  notify(changes);
}

let timer = 0;
function persistSoon() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      /** @type {Record<string, any[]>} */
      const data = {};
      for (const [k, m] of Object.entries(store.data)) data[k] = [...m.values()];
      localStorage.setItem(CACHE, JSON.stringify({ data, settings: store.settings, businessDate: store.businessDate, seq: Number(localStorage.getItem('pos.lastSeq') || 0) }));
    } catch { /* quota: next snapshot will repopulate */ }
  }, 800);
}

/** Restore the cached replica so reloads only need the event tail. Returns false when no cache. */
export function hydrate() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (!c) { localStorage.setItem('pos.lastSeq', '0'); return false; } // empty replica -> ask for a snapshot
    for (const [t, rows] of Object.entries(c.data)) {
      const m = table(t);
      for (const r of /** @type {any[]} */ (rows)) m.set(r.id, r);
    }
    store.settings = c.settings;
    store.businessDate = c.businessDate;
    // the cache may lag lastSeq by < 1 s: rewind so the host replays the gap
    localStorage.setItem('pos.lastSeq', JSON.stringify(c.seq || 0));
    return true;
  } catch {
    try { localStorage.setItem('pos.lastSeq', '0'); } catch { /* storage blocked */ }
    return false;
  }
}

export function clearCache() {
  try { localStorage.removeItem(CACHE); localStorage.setItem('pos.lastSeq', '0'); } catch { /* ignore */ }
}

// ---- selectors ----

/** @param {string} tableId */
export const activeOrderForTable = (tableId) =>
  list('orders').find((o) => o.tableId === tableId && (o.status === 'open' || o.status === 'billed'));
/** @param {string} orderId */
export const linesOf = (orderId) => list('order_lines').filter((l) => l.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt);
/** @param {string} orderId */
export const kotsOf = (orderId) => list('kots').filter((k) => k.orderId === orderId).sort((a, b) => a.createdAt - b.createdAt);
/** @param {string} orderId */
export const openBillOf = (orderId) => list('bills').find((b) => b.orderId === orderId && b.status !== 'void' && b.status !== 'settled')
  ?? list('bills').filter((b) => b.orderId === orderId && b.status === 'settled').sort((a, b) => b.createdAt - a.createdAt)[0];
/** Legacy line total in paise: unit × qty + Σ(extra × its own qty). @param {any} l */
export const lineTotal = (l) => linePaise(l);

/**
 * Preview totals of an order (+ optional draft lines) with the SAME code the host bills with.
 * Draft lines: {unitPaise, qty, extras:[{pricePaise, qty}]}.
 * @param {any} o order row (may be null for a new table) @param {any[]} [draft]
 */
export function orderTotals(o, draft = []) {
  const lines = [...(o ? linesOf(o.id) : []), ...draft];
  const legacy = {
    lines: lines.map((l) => ({ price: l.unitPaise / 100, qty: l.qty, void: !!l.voided, extras: (l.extras || []).map((/** @type {any} */ e) => ({ price: e.pricePaise / 100, qty: e.qty ?? 1 })) })),
    delivery: (o?.deliveryPaise ?? 0) / 100,
  };
  return totalsToPaise(billTotals(legacy, /** @type {any} */ ({ taxes: [], ...store.settings })));
}

/** Items of a menu group/sub-group in display order (active only). @param {string} groupId @param {string | null} [subId] */
export const itemsOf = (groupId, subId) => list('items')
  .filter((i) => i.active && i.groupId === groupId && (subId === undefined || (i.subgroupId ?? null) === subId))
  .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

/** Display name of where an order is: table / PK1 / ZM2. @param {any} o */
export const orderRef = (o) => o?.ref || (o?.type === 'dine' ? byId('dining_tables', o?.tableId)?.name ?? '' : `#${o?.no ?? ''}`);
/** @param {any} o */
export const typeLabel = (o) => (o?.type === 'dine' ? 'Dine In' : o?.type === 'takeaway' ? 'Pick Up' : 'Delivery' + (o?.platform ? ' - ' + o.platform : ''));
