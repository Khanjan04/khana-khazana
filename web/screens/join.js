// @ts-check
// Host join page: QR of http://<ip>:8080 for staff phones (show on the host after each hotspot start).
import { h, svg } from '../h.js';
import { api } from '../net.js';
import { qr } from '../vendor/qr.js';
import { scheduleRender } from '../app.js';

/** @type {any} */
let info = null;

/** @param {string} text @param {number} [px] */
export function qrSvg(text, px = 240) {
  const { size, modules } = qr(text, { ecl: 'M' });
  const q = 4, n = size + q * 2;
  let d = '';
  modules.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + q},${y + q}h1v1h-1z`; }));
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, width: px, height: px, class: 'qr', 'shape-rendering': 'crispEdges' },
    svg('rect', { width: n, height: n, fill: '#fff' }),
    svg('path', { d, fill: '#000' }));
}

export function render() {
  if (!info) {
    api('/api/info').then((i) => { info = i; scheduleRender(); }).catch(() => { info = { ips: [], port: location.port }; scheduleRender(); });
    return h('div.panel.narrow', 'Loading…');
  }
  const urls = info.ips.length ? info.ips.map((/** @type {string} */ ip) => `http://${ip}:${info.port}/`) : [location.origin + '/'];
  return h('div.panel.narrow.c',
    h('h2', `Join ${info.name}`),
    h('p.muted', 'Scan with Chrome on the staff phone. Same Wi-Fi / hotspot as this phone.'),
    urls.map((/** @type {string} */ u) => h('div.join', qrSvg(u), h('div.code-big', u))),
    h('p.small', 'Hotspot IP changes every time the hotspot is turned on: show this page again after restarting it.'),
    h('a', { href: '#/' }, 'Back'));
}
