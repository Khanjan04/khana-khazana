// @ts-check
// App shell: boot flow, hash router, live connection, alerts.
import { h } from './h.js';
import { connect, api, knownHosts, saveHosts, probe, outbox, disconnect } from './net.js';
import { store, subscribe, loadSnapshot, applyChanges, hydrate, clearCache, byId } from './store.js';
import { device, session, setDevice, setSession, me, can, authHeaders } from './session.js';
import { toast } from './ui.js';
import { beep, vibrate } from './sound.js';

import * as setup from './screens/setup.js';
import * as pair from './screens/pair.js';
import * as login from './screens/login.js';
import * as tables from './screens/tables.js';
import * as order from './screens/order.js';
import * as kds from './screens/kds.js';
import * as bills from './screens/bills.js';
import * as bill from './screens/bill.js';
import * as reports from './screens/reports.js';
import * as admin from './screens/admin.js';
import * as whoami from './screens/whoami.js';
import * as join from './screens/join.js';
import * as adopt from './screens/adopt.js';

/** @typedef {{ name: string, args: string[], query: URLSearchParams }} Route */
/** @type {Record<string, {render: (r: Route) => Node, title?: string, bare?: boolean}>} */
const screens = { setup, pair, login, tables, order, kds, bills, bill, reports, admin, whoami, join, adopt };
const PUBLIC = new Set(['setup', 'pair', 'login', 'whoami', 'join', 'adopt']);

export const live = { status: /** @type {'connecting'|'online'|'offline'} */ ('offline'), started: false, unreachable: false };

/** @returns {Route} */
export function parseRoute() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, ...args] = path.split('/');
  return { name: name || '', args, query: new URLSearchParams(qs ?? '') };
}

/** @param {string} path e.g. 'order/abc' */
export function go(path) {
  if (location.hash !== '#/' + path) location.hash = '#/' + path;
  else render();
}

export function home() {
  if (me.device?.kind === 'kds' || (can('kitchen') && !can('order'))) return go('kds');
  if (can('order')) return go('tables');
  if (can('bill') || can('delivery')) return go('bills');
  if (can('reports')) return go('reports');
  go('whoami');
}

let raf = 0;
export function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

export function render() {
  const r = parseRoute();
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  if (!r.name) {
    if (me.user) home();
    else if (live.started) root.replaceChildren(h('div.panel.narrow', 'Connecting to host…'));
    else boot();
    return;
  }
  const s = screens[r.name];
  if (!s) return go('');
  if (!PUBLIC.has(r.name) && !live.started) { boot(); return; }
  // keep focus + caret across re-renders
  const act = /** @type {HTMLInputElement | null} */ (document.activeElement);
  const focusId = act && act.id && root.contains(act) ? act.id : null;
  const caret = focusId && 'selectionStart' in act ? act.selectionStart : null;
  const scroll = [...root.querySelectorAll('[data-keep-scroll]')].map((e) => [e.getAttribute('data-keep-scroll'), e.scrollTop]);
  let view;
  try {
    view = s.render(r);
  } catch (e) {
    console.error(e);
    view = h('div.panel', h('h3', 'Something went wrong'), h('pre', String(/** @type {Error} */ (e).stack ?? e)));
  }
  root.replaceChildren(s.bare || PUBLIC.has(r.name) ? h('div') : topbar(r), view);
  if (live.unreachable) root.appendChild(unreachableBanner());
  if (focusId) {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(focusId));
    if (el) { el.focus(); if (caret !== null) try { el.setSelectionRange(caret, caret); } catch { /* not text */ } }
  }
  for (const [k, top] of scroll) {
    const el = root.querySelector(`[data-keep-scroll="${k}"]`);
    if (el) el.scrollTop = Number(top);
  }
}

/** @param {Route} r */
function topbar(r) {
  /** @param {string} name @param {string} label @param {boolean} show */
  const link = (name, label, show) => (show ? h('a' + (r.name === name ? '.on' : ''), { href: '#/' + name }, label) : null);
  return h('header.top',
    h('span.dot.' + live.status, { title: live.status }),
    h('b.brand', store.settings.name || 'POS'),
    h('nav',
      link('tables', 'Tables', can('order')),
      link('kds', 'Kitchen', can('kitchen')),
      link('bills', 'Bills', can('bill') || can('history') || can('delivery')),
      link('reports', 'Reports', can('reports')),
      link('admin', 'Admin', ['menu', 'layout', 'users', 'settings', 'device.manage'].some(can))),
    h('span.grow'),
    h('span.user', me.user?.name ?? ''),
    h('button.ghost.small', { onclick: logout }, 'Logout'));
}

function unreachableBanner() {
  return h('div.banner',
    h('b', 'Host not reachable. '),
    'Retrying… If the host phone restarted its hotspot, open its Join page and ',
    h('a', { href: '#/join' }, 'scan the host QR'),
    '.');
}

export async function logout() {
  try { await api('/api/logout', { method: 'POST', auth: authHeaders() }); } catch { /* offline: drop locally */ }
  setSession(null);
  disconnect();
  live.started = false;
  location.hash = '#/login';
  location.reload();
}

/** Start the live replica once device + session exist. */
export function startLive() {
  if (live.started) return;
  live.started = true;
  me.user = session()?.user ?? null; // cosmetic until the host's welcome arrives
  hydrate();
  /** @type {Map<string, string>} */
  const kotStatus = new Map();
  subscribe((changes) => {
    for (const c of changes ?? []) {
      if (c.entity !== 'kots' || !c.value) continue;
      const prev = kotStatus.get(c.id);
      kotStatus.set(c.id, c.value.status);
      if (c.value.status === 'ready' && prev && prev !== 'ready' && can('order') && me.device?.kind !== 'kds') {
        const o = byId('orders', c.value.orderId);
        const t = byId('dining_tables', o?.tableId);
        toast(`KOT ${c.value.no} READY — ${t ? 'Table ' + t.name : o?.type ?? ''}`, 'ok', 8000);
        vibrate([200, 100, 200]);
      }
    }
    if (!changes) for (const k of store.data.kots?.values() ?? []) kotStatus.set(k.id, k.status);
    scheduleRender();
  });
  connect({
    hello: () => ({ deviceToken: device()?.deviceToken, sessionToken: session()?.sessionToken }),
    onStatus: (s) => { live.status = s; if (s === 'online') live.unreachable = false; scheduleRender(); },
    onMsg: (m) => {
      if (m.t === 'snapshot') loadSnapshot(m);
      else if (m.t === 'evt') applyChanges(m.data.changes);
      else if (m.t === 'welcome') {
        me.user = m.user;
        me.device = m.device;
        store.businessDate = m.businessDate;
        api('/api/info').then((i) => saveHosts([location.origin, ...i.ips.map((/** @type {string} */ ip) => `http://${ip}:${i.port}`), ...(store.settings.fallbackHosts ?? []), ...knownHosts()])).catch(() => {});
        if (!parseRoute().name) home();
        scheduleRender();
      } else if (m.t === 'alert') onAlert(m);
    },
    onClose: (code) => {
      if (code === 4001) { setDevice(null); setSession(null); clearCache(); toast('This phone was unpaired', 'err'); location.hash = '#/pair'; location.reload(); }
      else if (code === 4003) { setSession(null); location.hash = '#/login'; location.reload(); }
      else if (code === 4010) toast('Host restored a backup — resyncing…', 'info', 6000);
    },
    onUnreachable: async () => {
      for (const origin of knownHosts()) {
        if (origin === location.origin) continue;
        if (await probe(origin)) {
          const d = encodeURIComponent(JSON.stringify({ device: device(), session: session(), outbox: outbox() }));
          location.href = `${origin}/#/adopt?d=${d}`;
          return;
        }
      }
      live.unreachable = true;
      scheduleRender();
    },
  });
  setInterval(scheduleRender, 15_000); // age timers
}

/** @param {any} m */
function onAlert(m) {
  if (m.kind === 'kot_unack') {
    toast(`KOT ${m.no} not accepted for ${m.ageMin} min — check the kitchen screen`, 'err', 10000);
    beep(660, 200, 2);
  } else if (m.kind === 'print') {
    if (!m.ok) toast(`Print failed: ${m.label} — ${m.error}`, 'err', 8000);
  }
}

async function boot() {
  const r = parseRoute();
  if (PUBLIC.has(r.name) && r.name !== 'login') return render();
  /** @type {any} */
  let info = null;
  try { info = await api('/api/info'); } catch { /* offline: carry on with cached replica */ }
  if (info?.needsSetup) return go('setup');
  if (!device()) return go('pair');
  if (!session()) return r.name === 'login' ? render() : go('login');
  startLive();
  render();
}

// path routes from QR codes (/join, /pair?code=…, /whoami) -> hash routes on the same origin
const p = location.pathname;
if (p !== '/' && p !== '/index.html') {
  history.replaceState(null, '', '/#' + p + location.search);
}
window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator && window.isSecureContext) {
  // Optional (Day 20): only on localhost or chrome://flags-treated origins.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
