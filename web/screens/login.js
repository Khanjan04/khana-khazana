// @ts-check
// PIN login: device token + PIN -> 12 h session.
import { h } from '../h.js';
import { api } from '../net.js';
import { device, setDevice, setSession } from '../session.js';
import { toast, pinPad, confirmBox } from '../ui.js';
import { scheduleRender, startLive, go } from '../app.js';

/** @type {any[] | null} */
let users = null;
/** @type {string | null} */
let picked = null;
let err = '';

export function render() {
  const d = device();
  if (!d) { go('pair'); return h('div'); }
  if (!users && !err) {
    api('/api/users', { auth: { deviceToken: d.deviceToken } })
      .then((r) => { users = r.users; scheduleRender(); })
      .catch((e) => {
        if (e.code === 'BAD_DEVICE') { setDevice(null); go('pair'); return; }
        err = e.message; scheduleRender();
      });
    return h('div.panel.narrow', 'Loading…');
  }
  if (err) return h('div.panel.narrow', h('p', 'Host not reachable: ' + err), h('button', { onclick: () => { err = ''; scheduleRender(); } }, 'Retry'));
  const u = users?.find((x) => x.id === picked);
  return h('div.panel.narrow',
    h('h2', 'Who is working?'),
    h('div.user-grid', (users ?? []).map((x) => h('button' + (x.id === picked ? '.primary' : ''), { onclick: () => { picked = x.id; scheduleRender(); } }, h('b', x.name), h('small', x.role)))),
    u ? pinPad(async (pin) => {
      try {
        const r = await api('/api/login', { body: { userId: u.id, pin }, auth: { deviceToken: d.deviceToken } });
        setSession({ sessionToken: r.sessionToken, expiresAt: r.expiresAt, user: r.user });
        picked = null; users = null;
        startLive();
        go('');
      } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
    }, { label: `PIN for ${u.name}` }) : null,
    h('p.small', h('a', {
      href: '#/login', onclick: async (/** @type {Event} */ e) => {
        e.preventDefault();
        if (await confirmBox('Forget pairing on this phone?')) { setDevice(null); go('pair'); }
      },
    }, 'Unpair this phone')));
}
