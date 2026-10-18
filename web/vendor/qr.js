// @ts-check
// Vendored pure-JS QR Code encoder (byte mode, ECC L/M, versions 1–40, auto mask).
// Algorithm follows ISO/IEC 18004 as popularised by Project Nayuki's MIT-licensed
// reference implementation. No dependencies; runs in browsers and Node.

const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS = { L: 1, M: 0 };

/** @param {number} x @param {number} i */
const bit = (x, i) => ((x >>> i) & 1) !== 0;

/** @param {number} ver */
function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
/** @param {number} ver @param {'L'|'M'} ecl */
const numDataCodewords = (ver, ecl) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];

/** GF(2^8) multiply modulo 0x11D. @param {number} x @param {number} y */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
/** @param {number} degree */
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
/** @param {number[]} data @param {number[]} div */
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ /** @type {number} */ (r.shift());
    r.push(0);
    div.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

/** @param {string} s */
function utf8(s) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
  return Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
}

/**
 * Encode text to a QR module matrix.
 * @param {string} text
 * @param {{ ecl?: 'L'|'M', mask?: number }} [opts] mask -1/undefined = auto
 * @returns {{ size: number, version: number, mask: number, modules: boolean[][] }}
 */
export function qr(text, opts = {}) {
  const ecl = opts.ecl ?? 'M';
  const data = utf8(text);
  let ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new Error('QR: data too long');
    const ccBits = ver < 10 ? 8 : 16;
    if (4 + ccBits + data.length * 8 <= numDataCodewords(ver, ecl) * 8 && data.length < 1 << ccBits) break;
  }
  // bit stream
  /** @type {number[]} */
  const bits = [];
  /** @param {number} v @param {number} n */
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(data.length, ver < 10 ? 8 : 16);
  for (const b of data) put(b, 8);
  const cap = numDataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  /** @type {number[]} */
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // ECC + interleave
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
  const raw = Math.floor(numRawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  /** @type {number[][]} */
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = codewords.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  /** @type {number[]} */
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) all.push(b[i]); });
  }

  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  /** @param {number} x @param {number} y @param {boolean} dark */
  const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

  // function patterns
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  /** @param {number} cx @param {number} cy */
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  /** @type {number[]} */
  let align = [];
  if (ver > 1) {
    const na = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
    align = [6];
    for (let pos = size - 7; align.length < na; pos -= step) align.splice(1, 0, pos);
  }
  const na = align.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  /** @param {number} mask */
  const drawFormat = (mask) => {
    const d = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
    setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(b, i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setF(a, c, bit(b, i)); setF(c, a, bit(b, i));
    }
  }

  // data
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < all.length * 8) { mod[y][x] = bit(all[i >>> 3], 7 - (i & 7)); i++; }
    }
  }

  /** @param {number} m */
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let inv;
      switch (m) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
    }
  };

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty(mod, size);
      if (p < best) { best = p; mask = m; }
      applyMask(m); // undo (XOR)
    }
  }
  applyMask(mask);
  drawFormat(mask);
  return { size, version: ver, mask, modules: mod };
}

/** Standard penalty score (N1..N4). @param {boolean[][]} m @param {number} size */
function penalty(m, size) {
  let r = 0;
  /** @param {(i: number, j: number) => boolean} at */
  const lines = (at) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let s = '';
      for (let j = 0; j < size; j++) {
        const c = at(i, j);
        s += c ? '1' : '0';
        if (j > 0 && c === at(i, j - 1)) {
          run++;
          if (run === 5) r += 3; else if (run > 5) r += 1;
        } else run = 1;
      }
      const padded = '0000' + s + '0000';
      for (let k = padded.indexOf('1011101'); k !== -1; k = padded.indexOf('1011101', k + 1)) {
        if (padded.slice(k - 4, k) === '0000' || padded.slice(k + 7, k + 11) === '0000') r += 40;
      }
    }
  };
  lines((i, j) => m[i][j]);
  lines((i, j) => m[j][i]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (y < size - 1 && x < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) r += 3;
  }
  const total = size * size;
  r += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return r;
}

/** Render to terminal with half-block characters (for install.sh / server start). @param {string} text */
export function qrTerminal(text) {
  const { size, modules } = qr(text, { ecl: 'L' });
  const q = 2; // quiet zone
  const at = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x < size && y < size && modules[y][x];
  let out = '';
  for (let y = -q; y < size + q; y += 2) {
    for (let x = -q; x < size + q; x++) {
      const top = at(x, y), bot = at(x, y + 1);
      out += top && bot ? ' ' : top ? '▄' : bot ? '▀' : '█';
    }
    out += '\n';
  }
  return out;
}
