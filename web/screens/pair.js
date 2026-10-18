// @ts-check
// Pair a new phone with the 6-digit code from Admin → Devices → Add device.
import { h } from '../h.js';
import { api } from '../net.js';
import { setDevice, device } from '../session.js';
import { toast } from '../ui.js';
import { go } from '../app.js';
import { clearCache } from '../store.js';

/** @param {import('../app.js').Route} r */
export function render(r) {
  if (device()) return h('div.panel.narrow', h('p', 'This phone is paired.'), h('a', { href: '#/login' }, 'Go to login'));
  const f = { code: r.query.get('code') ?? '', kind: r.query.get('kind') === 'kds' ? 'kds' : 'staff', name: '' };
  return h('div.panel.narrow',
    h('h2', 'Pair this phone'),
    h('p.muted', 'Ask the owner for a code: Admin → Devices → Add device. Codes last 5 minutes.'),
    h('label', 'Pairing code', h('input#pair-code', { inputmode: 'numeric', maxlength: 6, value: f.code, oninput: (/** @type {any} */ e) => { f.code = e.target.value; } })),
    h('label', 'Phone name', h('input#pair-name', { placeholder: 'e.g. Captain 1, Kitchen', oninput: (/** @type {any} */ e) => { f.name = e.target.value; } })),
    h('div.row',
      h('label.radio', h('input', { type: 'radio', name: 'kind', checked: f.kind === 'staff', onchange: () => { f.kind = 'staff'; } }), 'Staff phone'),
      h('label.radio', h('input', { type: 'radio', name: 'kind', checked: f.kind === 'kds', onchange: () => { f.kind = 'kds'; } }), 'Kitchen screen (KDS)')),
    h('button.primary', {
      onclick: async () => {
        try {
          const d = await api('/api/pair/claim', { body: f });
          clearCache();
          setDevice({ ...d, name: f.name });
          toast('Paired', 'ok');
          go('login');
        } catch (e) { toast(/** @type {Error} */ (e).message, 'err'); }
      },
    }, 'Pair'),
    h('p.small', h('a', { href: '#/whoami' }, 'Browser capabilities')));
}
