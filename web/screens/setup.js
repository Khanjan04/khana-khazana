// @ts-check
// First run on the host phone (http://127.0.0.1:8080): owner account + recovery code.
import { h } from '../h.js';
import { api } from '../net.js';
import { setDevice, setSession } from '../session.js';
import { toast } from '../ui.js';
import { startLive, go, scheduleRender } from '../app.js';

/** @type {any} */
let info = null;
let recovery = '';
let loading = false;

export function render() {
  if (!info && !loading) {
    loading = true;
    api('/api/info').then((i) => { info = i; scheduleRender(); }).catch(() => { info = { error: true }; scheduleRender(); });
  }
  if (recovery) {
    return h('div.panel.narrow',
      h('h2', 'Owner recovery code'),
      h('p', 'Write this down and keep it safe. It resets the owner PIN on the host phone if it is forgotten.'),
      h('div.code-big', recovery),
      h('button.primary', { onclick: () => { recovery = ''; startLive(); go('admin'); } }, 'I wrote it down — continue'));
  }
  if (!info) return h('div.panel.narrow', 'Checking host…');
  if (!info.needsSetup) return h('div.panel.narrow', h('p', 'Already set up.'), h('a', { href: '#/login' }, 'Go to login'));
  if (!info.loopback) {
    return h('div.panel.narrow', h('h2', 'First-time setup'),
      h('p', 'Setup must be done on the host phone itself. Open Chrome on the host and go to'),
      h('div.code-big', 'http://127.0.0.1:8080'));
  }
  const f = { restaurantName: info.name || '', ownerName: '', pin: '', pin2: '' };
  /** @param {keyof typeof f} k @param {string} label @param {string} [type] */
  const field = (k, label, type = 'text') => h('label', label, h('input', { id: 'setup-' + k, type, inputmode: type === 'password' ? 'numeric' : undefined, value: f[k], oninput: (/** @type {any} */ e) => { f[k] = e.target.value; } }));
  return h('div.panel.narrow',
    h('h2', 'Welcome — set up this host'),
    field('restaurantName', 'Restaurant name'),
    field('ownerName', 'Owner name'),
    field('pin', 'Owner PIN (4–8 digits)', 'password'),
    field('pin2', 'Repeat PIN', 'password'),
    h('button.primary', {
      onclick: async () => {
        if (f.pin !== f.pin2) return toast('PINs do not match', 'err');
        try {
          const r = await api('/api/setup', { body: { restaurantName: f.restaurantName, ownerName: f.ownerName, pin: f.pin } });
          setDevice({ deviceId: r.deviceId, deviceToken: r.deviceToken, kind: r.kind, name: 'Host phone' });
          setSession({ sessionToken: r.sessionToken, expiresAt: r.expiresAt });
          recovery = r.recoveryCode;
          scheduleRender();
        } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
      },
    }, 'Create owner'));
}
