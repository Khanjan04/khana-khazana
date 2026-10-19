// @ts-check
// First run on the host phone (http://127.0.0.1:8080): owner account + recovery code. Only the Owner
// registers; Manager / Captain / Kitchen logins are created with default PINs (change them in Admin › Users),
// and the KHANAKHAJANA menu, tables, extras and notes can be loaded in one tap.
import { h } from '../h.js';
import { api } from '../net.js';
import { setDevice, setSession } from '../session.js';
import { toast } from '../ui.js';
import { startLive, go, scheduleRender } from '../app.js';

/** @type {any} */
let info = null;
let recovery = '';
/** @type {any[]} */
let staff = [];
/** @type {any} */
let seeded = null;
let loading = false;
let loadDefaults = true;

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
      staff.length ? [h('h3', 'Staff logins created for you'),
        h('table.list', h('tr', h('th', 'User'), h('th', 'Role'), h('th', 'PIN')), staff.map((u) => h('tr', h('td', u.name), h('td', u.roleId), h('td', h('b', u.pin))))),
        h('p.small.muted', 'They pick their name on the phone and type this PIN. Change the PINs in Admin › Users.')] : null,
      seeded ? h('p.okc', `Loaded ${seeded.items ?? 0} dishes and ${seeded.tables ?? 0} tables.`) : null,
      h('button.primary', { onclick: () => { recovery = ''; startLive(); go('admin'); } }, 'I wrote it down — continue'));
  }
  if (!info) return h('div.panel.narrow', 'Checking host…');
  if (!info.needsSetup) return h('div.panel.narrow', h('p', 'Already set up.'), h('a', { href: '#/login' }, 'Go to login'));
  if (!info.loopback) {
    return h('div.panel.narrow', h('h2', 'First-time setup'),
      h('p', 'Setup must be done on the host phone itself. Open Chrome on the host and go to'),
      h('div.code-big', 'http://127.0.0.1:8080'));
  }
  const f = { restaurantName: info.name || 'KHANAKHAJANA', ownerName: '', pin: '', pin2: '' };
  /** @param {keyof typeof f} k @param {string} label @param {string} [type] */
  const field = (k, label, type = 'text') => h('label', label, h('input', { id: 'setup-' + k, type, inputmode: type === 'password' ? 'numeric' : undefined, value: f[k], oninput: (/** @type {any} */ e) => { f[k] = e.target.value; } }));
  return h('div.panel.narrow',
    h('h2', 'Welcome — set up this host'),
    field('restaurantName', 'Restaurant name'),
    field('ownerName', 'Owner name'),
    field('pin', 'Owner PIN (4–8 digits)', 'password'),
    field('pin2', 'Repeat PIN', 'password'),
    h('label.radio', h('input#setup-defaults', { type: 'checkbox', checked: loadDefaults, onchange: (/** @type {any} */ e) => { loadDefaults = e.target.checked; } }),
      'Load the KHANAKHAJANA menu, tables, extras & notes (you can change them later)'),
    h('p.small.muted', 'Manager (PIN 2222), Captain (PIN 1111) and Kitchen (PIN 3333) logins are created automatically.'),
    h('button.primary', {
      onclick: async () => {
        if (f.pin !== f.pin2) return toast('PINs do not match', 'err');
        try {
          const r = await api('/api/setup', { body: { restaurantName: f.restaurantName, ownerName: f.ownerName, pin: f.pin, loadDefaults } });
          setDevice({ deviceId: r.deviceId, deviceToken: r.deviceToken, kind: r.kind, name: 'Host phone' });
          setSession({ sessionToken: r.sessionToken, expiresAt: r.expiresAt });
          recovery = r.recoveryCode;
          staff = r.staff ?? [];
          seeded = r.seeded;
          scheduleRender();
        } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
      },
    }, 'Create owner'));
}
