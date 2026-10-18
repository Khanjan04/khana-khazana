// @ts-check
// Capability report (Day 4): what this browser allows on this origin.
import { h } from '../h.js';
import { device, me } from '../session.js';

export function render() {
  const n = /** @type {any} */ (navigator);
  const rows = /** @type {[string, boolean | string][]} */ ([
    ['Origin', location.origin],
    ['isSecureContext', window.isSecureContext],
    ['serviceWorker', 'serviceWorker' in navigator],
    ['wakeLock', 'wakeLock' in navigator],
    ['vibrate', 'vibrate' in navigator],
    ['indexedDB', 'indexedDB' in window],
    ['localStorage', (() => { try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); return true; } catch { return false; } })()],
    ['WebSocket', 'WebSocket' in window],
    ['crypto.randomUUID', typeof crypto?.randomUUID === 'function'],
    ['crypto.getRandomValues', typeof crypto?.getRandomValues === 'function'],
    ['serial', 'serial' in navigator],
    ['bluetooth', 'bluetooth' in navigator],
    ['Notification', 'Notification' in window],
    ['clipboard (async)', !!n.clipboard?.writeText],
    ['AudioContext', 'AudioContext' in window || 'webkitAudioContext' in window],
    ['Paired device', device() ? `${device()?.name ?? ''} (${device()?.kind})` : 'no'],
    ['User', me.user ? `${me.user.name} (${me.user.roleId})` : 'not logged in'],
    ['User agent', navigator.userAgent],
  ]);
  return h('div.panel.narrow',
    h('h2', 'Who am I'),
    h('table.kv', rows.map(([k, v]) => h('tr', h('th', k), h('td.' + (v === true ? 'yes' : v === false ? 'no' : 'txt'), v === true ? '✓ yes' : v === false ? '✗ no' : v)))),
    h('p.small', 'Core POS needs only WebSocket + localStorage + getRandomValues. Everything else is optional.'),
    h('a', { href: '#/' }, 'Back'));
}
