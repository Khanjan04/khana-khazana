// @ts-check
// Hand-off from another host origin (known-hosts fallback): carries device/session tokens + outbox.
import { h } from '../h.js';
import { setDevice, setSession } from '../session.js';

/** @param {import('../app.js').Route} r */
export function render(r) {
  try {
    const d = JSON.parse(r.query.get('d') ?? 'null');
    if (d?.device) setDevice(d.device);
    if (d?.session) setSession(d.session);
    if (Array.isArray(d?.outbox) && d.outbox.length) {
      const cur = JSON.parse(localStorage.getItem('pos.outbox') || '[]');
      const ids = new Set(cur.map((/** @type {any} */ c) => c.opId));
      localStorage.setItem('pos.outbox', JSON.stringify([...cur, ...d.outbox.filter((/** @type {any} */ c) => !ids.has(c.opId))]));
    }
  } catch { /* bad hand-off: fall through to pairing */ }
  history.replaceState(null, '', '/#/');
  setTimeout(() => location.reload(), 0);
  return h('div.panel.narrow', 'Switching host…');
}
