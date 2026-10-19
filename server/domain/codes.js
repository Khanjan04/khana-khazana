// @ts-check
// Short codes: 3 letters + a number for every dish (port of legacy autoCode/assignCodes).

/** @param {string} name @param {Set<string>} taken */
export function autoCode(name, taken) {
  const words = String(name).replace(/[^A-Za-z ]/g, ' ').toUpperCase().split(/\s+/).filter(Boolean);
  const flat = words.join('');
  let base;
  if (words.length >= 3) base = words[0][0] + words[1][0] + words[2][0];
  else if (words.length === 2) base = words[0][0] + words[1][0] + (words[1][1] || words[0][1] || 'X');
  else base = (flat + 'XXX').slice(0, 3);
  if (!taken.has(base)) return base;
  for (let i = 0; i < flat.length; i++) { const c = base.slice(0, 2) + flat[i]; if (/^[A-Z]{3}$/.test(c) && !taken.has(c)) return c; }
  for (let i = 0; i < flat.length; i++) { const c = base[0] + flat[i] + base[2]; if (/^[A-Z]{3}$/.test(c) && !taken.has(c)) return c; }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const x of A) for (const y of A) { const c = base[0] + x + y; if (!taken.has(c)) return c; }
  return base;
}

/** Lowest free short number. @param {Set<number>} used */
export function nextNum(used) {
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Paste-many parser (legacy parseBulk): "Paneer Tikka 200", "Dal Tadka - Rs. 300", "Masala Chai ..... ₹60".
 * @param {string} text
 * @returns {({name: string, price: number} | {line: string, bad: true})[]}
 */
export function parseBulk(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*?)[\s.:\-–—,=|…]+(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)\s*(?:\/-)?$/i) || line.match(/^(.*?)(?:rs\.?|₹)\s*(\d+(?:\.\d+)?)\s*(?:\/-)?$/i);
    if (!m) return { line, bad: /** @type {const} */ (true) };
    const name = m[1].replace(/^[\s\-*•.\d)]+(?=[A-Za-z(])/, '').replace(/[\s.:\-–—,=|…]+$/, '').trim();
    return name ? { name, price: parseFloat(m[2]) } : { line, bad: /** @type {const} */ (true) };
  });
}

/** Legacy table builder: rows × cols, numbered prefix+startNo…, seats per row "4,6" (last value repeats). */
/** @param {string} seats */
export function seatList(seats) {
  return String(seats || '').split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => n > 0);
}
