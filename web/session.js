// @ts-check
// Device token (from pairing) + session token (from PIN login), kept in localStorage.

const DEV = 'pos.device', SES = 'pos.session';

/** @param {string} k */
function read(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
}
/** @param {string} k @param {any} v */
function write(k, v) {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ }
}

/** @returns {{deviceId: string, deviceToken: string, kind: string, name?: string} | null} */
export const device = () => read(DEV);
/** @param {any} d */
export const setDevice = (d) => write(DEV, d);
/** @returns {{sessionToken: string, expiresAt: number, user: {id: string, name: string, roleId: string, rights: string[]}} | null} */
export const session = () => {
  const s = read(SES);
  return s && s.expiresAt > Date.now() ? s : null;
};
/** @param {any} s */
export const setSession = (s) => write(SES, s);

export const authHeaders = () => ({ deviceToken: device()?.deviceToken, sessionToken: session()?.sessionToken });

/** Live user from the host's welcome (rights are authoritative there; this is cosmetic). */
export const me = {
  /** @type {{id: string, name: string, roleId: string, rights: string[]} | null} */
  user: null,
  /** @type {{id: string, name: string, kind: string} | null} */
  device: null,
};
/** @param {string} r */
export const can = (r) => !!me.user?.rights.includes(r);
