// @ts-check
// Pairing, login, sessions, approvals — PLAN §9.
import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { get, all, run, tx } from './db.js';
import { CmdError, need } from './errors.js';
import { loadRights, can, seedRoles } from './rights.js';
import { newId, putSetting, getPrivate } from './model.js';

export const PAIR_TTL_MS = 5 * 60_000;
export const PAIR_MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 12 * 3600_000;
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;

export const sha256 = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url'); // 256-bit

/** @param {string} pin */
export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

/** @param {string} pin @returns {{hash: string, salt: string}} */
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pin, salt, 32).toString('hex') };
}

/** @param {string} pin @param {string} salt @param {string} hash */
export function checkPin(pin, salt, hash) {
  const a = scryptSync(String(pin), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a PIN for a user with lockout bookkeeping. Throws on failure.
 * @param {any} db @param {string} userId @param {string} pin @param {number} now
 */
export function verifyUserPin(db, userId, pin, now) {
  const u = get(db, 'SELECT * FROM users WHERE id=? AND active=1', userId);
  need(u, 'BAD_LOGIN', 'Unknown user');
  if (u.locked_until > now) throw new CmdError('LOCKED', `Locked for ${Math.ceil((u.locked_until - now) / 60000)} min`);
  if (!checkPin(pin, u.pin_salt, u.pin_hash)) {
    const failed = u.failed + 1;
    const lock = failed >= LOCK_AFTER ? now + LOCK_MS : 0;
    run(db, 'UPDATE users SET failed=?, locked_until=? WHERE id=?', lock ? 0 : failed, lock, userId);
    throw new CmdError(lock ? 'LOCKED' : 'BAD_LOGIN', lock ? 'Too many attempts: locked 15 min' : 'Wrong PIN');
  }
  if (u.failed) run(db, 'UPDATE users SET failed=0 WHERE id=?', userId);
  return u;
}

/** @param {any} db @param {any} u */
function userCtx(db, u) {
  return { id: u.id, name: u.name, roleId: u.role_id, rights: loadRights(db, u.role_id) };
}

// ---- first-run setup (host loopback only) ----

/** @param {any} db */
export const needsSetup = (db) => !get(db, 'SELECT id FROM users LIMIT 1');

/**
 * Create the owner, pair the host browser and log it in.
 * @param {any} db @param {{ownerName: string, pin: string, restaurantName?: string}} p @param {number} now
 */
export function setup(db, p, now) {
  need(needsSetup(db), 'ALREADY_SETUP');
  need(typeof p.ownerName === 'string' && p.ownerName.trim(), 'BAD_PAYLOAD', 'ownerName required');
  need(validPin(p.pin), 'BAD_PIN', 'PIN must be 4–8 digits');
  return tx(db, () => {
    seedRoles(db);
    const userId = newId();
    const { hash, salt } = hashPin(p.pin);
    run(db, 'INSERT INTO users(id,name,role_id,pin_hash,pin_salt,created_at) VALUES (?,?,?,?,?,?)', userId, p.ownerName.trim(), 'owner', hash, salt, now);
    if (p.restaurantName) putSetting(db, 'name', String(p.restaurantName).slice(0, 80));
    const recoveryCode = randomBytes(9).toString('base64url').toUpperCase();
    putSetting(db, '_recovery', sha256(recoveryCode));
    const dev = addDevice(db, 'Host phone', 'host', now);
    const ses = createSession(db, userId, dev.deviceId, now);
    return { ...dev, ...ses, userId, recoveryCode };
  });
}

/** Owner PIN reset with the printed recovery code (host loopback only). @param {any} db @param {string} code @param {string} pin */
export function recover(db, code, pin) {
  need(validPin(pin), 'BAD_PIN', 'PIN must be 4–8 digits');
  const h = getPrivate(db, '_recovery');
  need(h && typeof code === 'string' && sha256(code.trim().toUpperCase()) === h, 'BAD_CODE', 'Wrong recovery code');
  const owner = get(db, "SELECT id FROM users WHERE role_id='owner' AND active=1 ORDER BY created_at LIMIT 1");
  need(owner, 'NO_OWNER');
  const { hash, salt } = hashPin(pin);
  run(db, 'UPDATE users SET pin_hash=?, pin_salt=?, failed=0, locked_until=0 WHERE id=?', hash, salt, owner.id);
  return { userId: owner.id };
}

// ---- devices & pairing ----

/** @param {any} db @param {string} name @param {string} kind @param {number} now */
function addDevice(db, name, kind, now) {
  const deviceId = newId();
  const deviceToken = token();
  run(db, 'INSERT INTO devices(id,name,kind,token_hash,created_at) VALUES (?,?,?,?,?)', deviceId, name, kind, sha256(deviceToken), now);
  return { deviceId, deviceToken, kind };
}

/** One-time 6-digit code. @param {any} db @param {{kind?: string, createdBy?: string}} p @param {number} now */
export function createPairCode(db, p, now) {
  const kind = p.kind === 'kds' ? 'kds' : 'staff';
  run(db, 'DELETE FROM pair_codes WHERE expires_at < ? OR used=1', now);
  let code;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  while (get(db, 'SELECT 1 AS x FROM pair_codes WHERE code_hash=?', sha256(code)));
  const expiresAt = now + PAIR_TTL_MS;
  run(db, 'INSERT INTO pair_codes(code_hash,kind,expires_at,created_by) VALUES (?,?,?,?)', sha256(code), kind, expiresAt, p.createdBy ?? null);
  return { code, kind, expiresAt };
}

/** @param {any} db @param {{code: string, kind?: string, name?: string}} p @param {number} now */
export function claimPairCode(db, p, now) {
  const r = tx(db, () => {
    const live = all(db, 'SELECT * FROM pair_codes WHERE used=0 AND expires_at>=? AND attempts<?', now, PAIR_MAX_ATTEMPTS);
    const hit = live.find((c) => c.code_hash === sha256(String(p.code ?? '').trim()));
    if (!hit) {
      // every live code burns an attempt: 5 wrong guesses in total kill outstanding codes.
      // Return (not throw) so the increment commits.
      run(db, 'UPDATE pair_codes SET attempts=attempts+1 WHERE used=0');
      return null;
    }
    run(db, 'UPDATE pair_codes SET used=1 WHERE code_hash=?', hit.code_hash);
    const kind = p.kind === 'kds' || hit.kind === 'kds' ? 'kds' : 'staff';
    const name = (typeof p.name === 'string' && p.name.trim().slice(0, 40)) || (kind === 'kds' ? 'Kitchen screen' : 'Phone');
    return addDevice(db, name, kind, now);
  });
  if (!r) throw new CmdError('BAD_CODE', 'Code wrong or expired');
  return r;
}

/** @param {any} db @param {string | undefined} deviceToken */
export function deviceFromToken(db, deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return null;
  const d = get(db, 'SELECT id, name, kind, revoked FROM devices WHERE token_hash=?', sha256(deviceToken));
  return d && !d.revoked ? { id: d.id, name: d.name, kind: d.kind } : null;
}

/** @param {any} db @param {string} deviceId */
export function revokeDevice(db, deviceId) {
  run(db, 'UPDATE devices SET revoked=1 WHERE id=?', deviceId);
  run(db, 'UPDATE sessions SET revoked=1 WHERE device_id=?', deviceId);
}

// ---- sessions ----

/** @param {any} db @param {string} userId @param {string} deviceId @param {number} now */
function createSession(db, userId, deviceId, now) {
  const sessionToken = token();
  const expiresAt = now + SESSION_TTL_MS;
  run(db, 'INSERT INTO sessions(token_hash,user_id,device_id,created_at,expires_at) VALUES (?,?,?,?,?)', sha256(sessionToken), userId, deviceId, now, expiresAt);
  return { sessionToken, expiresAt };
}

/** device token + PIN -> session token. @param {any} db @param {{deviceToken: string, userId: string, pin: string}} p @param {number} now */
export function login(db, p, now) {
  const device = deviceFromToken(db, p.deviceToken);
  need(device, 'BAD_DEVICE', 'Device not paired or revoked');
  const u = verifyUserPin(db, p.userId, p.pin, now);
  const s = createSession(db, u.id, device.id, now);
  return { ...s, user: { id: u.id, name: u.name, roleId: u.role_id, rights: [...loadRights(db, u.role_id)] } };
}

/** @param {any} db @param {string} sessionToken */
export function logout(db, sessionToken) {
  run(db, 'UPDATE sessions SET revoked=1 WHERE token_hash=?', sha256(String(sessionToken)));
}

/**
 * Resolve device token + session token into {user, device}, or null.
 * @param {any} db @param {string | undefined} deviceToken @param {string | undefined} sessionToken @param {number} now
 */
export function authenticate(db, deviceToken, sessionToken, now) {
  const device = deviceFromToken(db, deviceToken);
  if (!device || !sessionToken || typeof sessionToken !== 'string') return null;
  const s = get(db, 'SELECT * FROM sessions WHERE token_hash=?', sha256(sessionToken));
  if (!s || s.revoked || s.expires_at < now || s.device_id !== device.id) return null;
  const u = get(db, 'SELECT * FROM users WHERE id=? AND active=1', s.user_id);
  if (!u) return null;
  run(db, 'UPDATE devices SET last_seen=? WHERE id=?', now, device.id);
  return { user: userCtx(db, u), device, sessionHash: s.token_hash };
}

/** Is this session still valid? Cheap check before every command. @param {any} db @param {string} sessionHash @param {number} now */
export function sessionAlive(db, sessionHash, now) {
  const s = get(db, 'SELECT s.revoked, s.expires_at, d.revoked AS drev, u.active FROM sessions s JOIN devices d ON d.id=s.device_id JOIN users u ON u.id=s.user_id WHERE s.token_hash=?', sessionHash);
  return !!s && !s.revoked && !s.drev && s.active === 1 && s.expires_at >= now;
}

/**
 * The father's need(right, cb) flow: another user with `approve` + the right enters their PIN.
 * @param {any} db @param {{userId?: string, pin?: string}} approval @param {string} right @param {number} now
 */
export function verifyApproval(db, approval, right, now) {
  need(approval && typeof approval.userId === 'string' && typeof approval.pin === 'string', 'APPROVAL_REQUIRED', right);
  const u = verifyUserPin(db, approval.userId, approval.pin, now);
  const ctx = userCtx(db, u);
  need(can(ctx, 'approve') && can(ctx, right), 'APPROVAL_DENIED', `${u.name} cannot approve ${right}`);
  return ctx;
}
