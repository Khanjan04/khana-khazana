// @ts-check
// Shared UI bits: money format, toast, modal, PIN pad, reason prompt, approval flow.
import { h } from './h.js';
import { send, isOnline } from './net.js';
import { list } from './store.js';

/** @param {number} p paise */
export const money = (p) => (p < 0 ? '−₹' : '₹') + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** @param {string} s rupees text -> paise (integer) */
export const toPaise = (s) => Math.round(parseFloat(String(s).replace(/[^\d.]/g, '') || '0') * 100);
/** @param {number} ms */
export const ago = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

/** @param {string} msg @param {'ok'|'err'|'info'} [kind] @param {number} [ms] */
export function toast(msg, kind = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) document.body.appendChild((box = h('div#toasts')));
  const t = h('div.toast.' + kind, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/**
 * @param {string} title @param {(close: () => void) => any} body
 * @param {{wide?: boolean, onClose?: () => void}} [o]
 */
export function modal(title, body, o = {}) {
  const close = () => { back.remove(); o.onClose?.(); };
  const back = h('div.modal-back', { onclick: (/** @type {MouseEvent} */ e) => { if (e.target === back) close(); } },
    h('div.modal' + (o.wide ? '.wide' : ''),
      h('div.modal-head', h('b', title), h('button.ghost', { onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div.modal-body', body(close))));
  document.body.appendChild(back);
  const first = /** @type {HTMLElement | null} */ (back.querySelector('input,select,textarea'));
  first?.focus();
  return close;
}

/** @param {string} msg @returns {Promise<boolean>} */
export function confirmBox(msg) {
  return new Promise((res) => {
    let done = false;
    const close = modal('Confirm', (c) => [
      h('p', msg),
      h('div.row.end',
        h('button.ghost', { onclick: () => { done = true; c(); res(false); } }, 'Cancel'),
        h('button.primary', { onclick: () => { done = true; c(); res(true); } }, 'Yes')),
    ], { onClose: () => { if (!done) res(false); } });
    void close;
  });
}

/** @param {string} title @param {{chips?: string[], placeholder?: string, value?: string, type?: string}} [o] @returns {Promise<string | null>} */
export function ask(title, o = {}) {
  return new Promise((res) => {
    let done = false;
    modal(title, (c) => {
      const inp = /** @type {HTMLInputElement} */ (h('input', { placeholder: o.placeholder ?? '', value: o.value ?? '', type: o.type ?? 'text', inputmode: o.type === 'number' ? 'decimal' : undefined }));
      const ok = () => { if (!inp.value.trim()) return; done = true; c(); res(inp.value.trim()); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      return [
        o.chips?.length ? h('div.chips', o.chips.map((t) => h('button.chip', { onclick: () => { inp.value = t; ok(); } }, t))) : null,
        inp,
        h('div.row.end', h('button.primary', { onclick: ok }, 'OK')),
      ];
    }, { onClose: () => { if (!done) res(null); } });
  });
}

/** Numeric PIN pad. @param {(pin: string) => void} onSubmit @param {{label?: string}} [o] */
export function pinPad(onSubmit, o = {}) {
  let pin = '';
  const dots = h('div.pin-dots');
  const show = () => { dots.textContent = pin ? '●'.repeat(pin.length) : o.label ?? 'Enter PIN'; };
  show();
  /** @param {string} k */
  const press = (k) => {
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (k === 'OK') { if (pin.length >= 4) { const p = pin; pin = ''; show(); onSubmit(p); } return; }
    else if (pin.length < 8) pin += k;
    show();
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
  const pad = h('div.pinpad', dots, h('div.keys', keys.map((k) => h('button' + (k === 'OK' ? '.primary' : ''), { onclick: () => press(k) }, k))));
  pad.tabIndex = 0;
  pad.addEventListener('keydown', (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') press('OK');
  });
  setTimeout(() => pad.focus(), 0);
  return pad;
}

/** Pick an approver (user with `approve`) and take their PIN. @param {string} right @returns {Promise<{userId: string, pin: string} | null>} */
export function getApproval(right) {
  return new Promise((res) => {
    let done = false;
    const approvers = list('users').filter((u) => u.active && list('roles').find((r) => r.id === u.roleId)?.rights?.includes('approve'));
    let userId = approvers[0]?.id;
    modal(`Approval needed: ${right}`, (c) => {
      const sel = h('select', { onchange: (/** @type {any} */ e) => { userId = e.target.value; } }, approvers.map((u) => h('option', { value: u.id }, u.name)));
      return [
        h('p.muted', 'A manager/owner enters their PIN on this phone.'),
        sel,
        pinPad((pin) => { done = true; c(); res({ userId, pin }); }, { label: 'Approver PIN' }),
      ];
    }, { onClose: () => { if (!done) res(null); } });
  });
}

/**
 * Send a command; on APPROVAL_REQUIRED (approvable rights) ask for an approver and retry.
 * @param {string} type @param {any} payload @param {string} [okMsg]
 */
export async function run(type, payload = {}, okMsg) {
  try {
    if (!isOnline()) toast('Host offline — saved, will send on reconnect', 'info');
    const r = await send(type, payload);
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err.code === 'APPROVAL_REQUIRED') {
      const approval = await getApproval(err.message);
      if (!approval) return null;
      return run(type, { ...payload, approval }, okMsg);
    }
    toast(`${err.code ?? 'Error'}: ${err.message}`, 'err', 5000);
    throw err;
  }
}

/** Run, swallowing the (already toasted) error. @param {string} type @param {any} [payload] @param {string} [okMsg] */
export const tryRun = (type, payload, okMsg) => run(type, payload, okMsg).catch(() => null);

/** Download a Blob as a file (works on insecure origins). @param {Blob} blob @param {string} name */
export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.getAttribute('href') ?? ''); a.remove(); }, 1000);
}

/** Clipboard with execCommand fallback (Async Clipboard is secure-context only). @param {string} text */
export function copyText(text) {
  const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { style: { position: 'fixed', opacity: '0' } }));
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  toast(ok ? 'Copied' : 'Copy not available — long-press to copy', ok ? 'ok' : 'info');
}
