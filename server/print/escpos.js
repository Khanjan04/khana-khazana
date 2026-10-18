// @ts-check
// Minimal ESC/POS builder (Day 18): init, align, bold, double, cut, 32/48 columns.
// ASCII only — regional-script raster printing is deferred (PLAN §14).

const ESC = 0x1b, GS = 0x1d;

/** Make text printable on a codepage-437 printer. @param {string} s */
export function ascii(s) {
  return String(s ?? '')
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e\n]/g, '?');
}

export class EscPos {
  /** @param {number} [cols] 32 for 58 mm, 48 for 80 mm */
  constructor(cols = 48) {
    this.cols = cols;
    /** @type {number[]} */
    this.bytes = [];
    this.init();
  }
  /** @param {...number} b */
  raw(...b) { this.bytes.push(...b); return this; }
  init() { return this.raw(ESC, 0x40); }
  /** @param {'left'|'center'|'right'} a */
  align(a) { return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0); }
  /** @param {boolean} on */
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  /** Double width + height. @param {boolean} on */
  double(on) { return this.raw(GS, 0x21, on ? 0x11 : 0x00); }
  /** @param {string} s */
  text(s) {
    for (const ch of ascii(s)) this.bytes.push(ch.charCodeAt(0));
    return this;
  }
  /** @param {string} [s] */
  line(s = '') { return this.text(s + '\n'); }
  /** @param {string} [ch] */
  hr(ch = '-') { return this.line(ch.repeat(this.cols)); }
  /** Left text + right text on one line (wraps left if needed). @param {string} left @param {string} right @param {number} [width] */
  lr(left, right, width = this.cols) {
    const l = ascii(left), r = ascii(right);
    const room = width - r.length - 1;
    if (l.length <= room) return this.line(l + ' '.repeat(width - l.length - r.length) + r);
    this.line(l.slice(0, width));
    return this.lr(l.slice(width), right, width);
  }
  /** @param {number} [n] */
  feed(n = 3) { return this.raw(ESC, 0x64, n); }
  cut() { return this.feed(3).raw(GS, 0x56, 0x42, 0x00); }
  /** Beep on printers that support ESC B (kitchen). */
  beep() { return this.raw(ESC, 0x42, 2, 2); }
  toBuffer() { return Buffer.from(this.bytes); }
}

/** @param {number} paper 58|80 */
export const colsFor = (paper) => (Number(paper) === 58 ? 32 : 48);
