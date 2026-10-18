// @ts-check
export class CmdError extends Error {
  /** @param {string} code @param {string} [msg] */
  constructor(code, msg) {
    super(msg || code);
    this.code = code;
  }
}

/** @param {any} cond @param {string} code @param {string} [msg] @returns {asserts cond} */
export function need(cond, code, msg) {
  if (!cond) throw new CmdError(code, msg);
}
