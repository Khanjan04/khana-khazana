// @ts-check
// Host LAN IPv4 discovery: os.networkInterfaces() -> `ip -4 addr` -> `ifconfig` (Day 4).
// os.networkInterfaces() can be restricted on some Android builds.
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** @param {string} a */
export function isPrivateIPv4(a) {
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

/** @param {string} text */
function parseInet(text) {
  const out = [];
  for (const m of text.matchAll(/inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/g)) out.push(m[1]);
  return out;
}

/** @returns {string[]} private LAN IPv4 addresses, best first */
export function lanIps() {
  /** @type {string[]} */
  let ips = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  } catch { /* restricted on some Android builds */ }
  if (!ips.length) {
    for (const [cmd, args] of /** @type {[string, string[]][]} */ ([['ip', ['-4', 'addr']], ['ifconfig', []]])) {
      try {
        ips = parseInet(execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
        if (ips.length) break;
      } catch { /* try next */ }
    }
  }
  const priv = [...new Set(ips.filter((a) => isPrivateIPv4(a)))];
  // Prefer router-style 192.168.x over hotspot-style / VPN 10.x
  return priv.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

/** Allowed client source: loopback, RFC1918, link-local, IPv6 ULA. @param {string | undefined} addr */
export function isAllowedSource(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  if (a === '::1' || /^127\./.test(a)) return true;
  if (isPrivateIPv4(a) || /^169\.254\./.test(a)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}

/** @param {string | undefined} addr */
export function isLoopback(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(lanIps().join('\n'));
