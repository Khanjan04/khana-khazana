// @ts-check
// Kitchen display (Days 3/14): columns New/Accepted/Preparing/Ready, age colours (5/10 min),
// beep on new KOT and every 30 s while any card is New, reject with reason, recall within 2 min.
// Rule: the KDS is the foreground tab on a dedicated, charging, "Stay awake" phone.
import { h } from '../h.js';
import { list, byId, linesOf, store } from '../store.js';
import { can } from '../session.js';
import { ago, ask, tryRun } from '../ui.js';
import { unlockAudio, audioReady, beep } from '../sound.js';
import { printKot } from '../print.js';
import { scheduleRender } from '../app.js';
import { KOT_COLUMNS } from './shared.js';

const RECALL_MS = 2 * 60_000;
const LABEL = /** @type {Record<string, string>} */ ({ new: 'New', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready' });
const NEXT = /** @type {Record<string, [string, string]>} */ ({ new: ['accepted', 'Accept'], accepted: ['preparing', 'Preparing'], preparing: ['ready', 'Ready'] });

/** @type {Set<string> | null} */
let seen = null;
let started = false;
let station = (() => { try { return localStorage.getItem('pos.kdsStation') || 'all'; } catch { return 'all'; } })();
/** @type {WakeLockSentinel | null} */
let wake = null;

// repeat beep every 30 s while any KOT is New (only when this screen is active)
setInterval(() => {
  if (!started || !location.hash.startsWith('#/kds')) return;
  if (activeKots().some((k) => k.status === 'new')) beep(1200, 200, 2);
}, 30_000);

function activeKots() {
  return list('kots')
    .filter((k) => KOT_COLUMNS.includes(k.status) && (station === 'all' || k.station === station))
    .sort((a, b) => a.createdAt - b.createdAt);
}

async function startShift() {
  unlockAudio();
  started = true;
  // Screen Wake Lock only exists on secure contexts (127.0.0.1 or flagged origin); otherwise rely on "Stay awake".
  try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch { wake = null; }
  scheduleRender();
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && started && wake === null && 'wakeLock' in navigator) {
    try { wake = await navigator.wakeLock.request('screen'); } catch { /* insecure origin */ }
  }
});

export function render() {
  const kots = activeKots();
  // beep for KOTs we have not seen yet
  const ids = new Set(kots.map((k) => k.id));
  if (seen && started) {
    const fresh = kots.filter((k) => k.status === 'new' && !seen?.has(k.id));
    if (fresh.length) beep(1400, 250, 3);
  }
  seen = new Set([...(seen ?? []), ...ids]);

  if (!started || !audioReady()) {
    return h('main.kds',
      h('div.start-shift',
        h('h2', 'Kitchen screen'),
        h('p', 'Tap to start the shift. This enables the beep for new orders.'),
        h('p.small', 'Keep this phone on the charger with Developer options → “Stay awake” ON, and keep this tab in front.'),
        h('button.primary.huge', { onclick: startShift }, 'Start shift')));
  }
  const stations = [...new Set(list('items').map((i) => i.station || 'kitchen'))];
  const now = Date.now();
  return h('main.kds',
    h('div.toolbar',
      h('b', `${kots.filter((k) => k.status === 'new').length} new`),
      stations.length > 1 ? h('div.tabs', ['all', ...stations].map((s) => h('button' + (station === s ? '.on' : ''), {
        onclick: () => { station = s; try { localStorage.setItem('pos.kdsStation', s); } catch { /* ignore */ } scheduleRender(); },
      }, s))) : null,
      h('span.grow'),
      h('small.muted', store.businessDate)),
    h('div.kds-cols', KOT_COLUMNS.map((col) => h('section.kds-col.' + col,
      h('h3', LABEL[col], ' ', h('span.count', kots.filter((k) => k.status === col).length)),
      h('div.cards', { 'data-keep-scroll': 'kds-' + col }, kots.filter((k) => k.status === col).map((k) => card(k, now)))))));
}

/** @param {any} k @param {number} now */
function card(k, now) {
  const o = byId('orders', k.orderId);
  const t = byId('dining_tables', o?.tableId);
  const age = now - k.createdAt;
  const ageCls = age > 10 * 60_000 ? '.late' : age > 5 * 60_000 ? '.warn' : '';
  const lines = linesOf(k.orderId).filter((l) => l.kotId === k.id);
  const recallable = k.status !== 'new' && now - k.updatedAt <= RECALL_MS && can('kitchen.status');
  const next = NEXT[k.status];
  return h('div.kot-card' + ageCls,
    h('div.kot-top',
      h('b.no', `#${k.no}`),
      h('b', o?.type === 'dine' ? `T ${t?.name ?? ''}` : o?.type === 'delivery' ? `🛵 ${o?.platform || 'Delivery'}` : '🥡 Takeaway'),
      h('span.age', ago(age))),
    h('ul', lines.map((l) => h('li' + (l.voided ? '.void' : ''),
      h('b', `${l.qty} × `), l.name, l.variant ? ` (${l.variant})` : '',
      (l.extras || []).length ? h('div.small', '+ ' + l.extras.map((/** @type {any} */ e) => e.name).join(', ')) : null,
      l.note ? h('div.note', '» ' + l.note) : null))),
    k.note ? h('div.note', 'Note: ' + k.note) : null,
    o?.comment ? h('div.note', 'Order: ' + o.comment) : null,
    h('div.kot-actions',
      next && can('kitchen.status') ? h('button.primary', { onclick: () => tryRun('kot.status', { kotId: k.id, to: next[0] }) }, next[1]) : null,
      (k.status === 'new' || k.status === 'accepted') && can('kitchen.status') ? h('button.danger', {
        onclick: async () => {
          const reason = await ask(`Reject KOT ${k.no}?`, { chips: ['Out of stock', 'Kitchen closed', 'Duplicate'], placeholder: 'Reason' });
          if (reason) tryRun('kot.status', { kotId: k.id, to: 'rejected', reason });
        },
      }, 'Reject') : null,
      k.status === 'ready' && can('serve') ? h('button', { onclick: () => tryRun('kot.status', { kotId: k.id, to: 'served' }) }, 'Served') : null,
      recallable ? h('button.ghost', { onclick: () => tryRun('kot.recall', { kotId: k.id }) }, '↶ Recall') : null,
      can('kot.reprint') ? h('button.ghost', { onclick: () => printKot(k.id) }, '🖨') : null));
}
