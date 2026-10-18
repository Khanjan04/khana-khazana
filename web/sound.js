// @ts-check
// Beeps via AudioContext. Autoplay needs a user gesture: the KDS "Start shift" tap unlocks it.

/** @type {AudioContext | null} */
let ctx = null;

export function unlockAudio() {
  const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!AC) return false;
  ctx ??= new AC();
  if (ctx.state === 'suspended') void ctx.resume();
  beep(880, 60); // audible confirmation
  return true;
}

// created inside a user gesture; resume() may still be settling, which is fine
export const audioReady = () => !!ctx && ctx.state !== 'closed';

/** @param {number} [freq] @param {number} [ms] @param {number} [times] */
export function beep(freq = 1000, ms = 180, times = 1) {
  if (!ctx) return;
  for (let i = 0; i < times; i++) {
    const t0 = ctx.currentTime + i * (ms / 1000 + 0.12);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.25, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + ms / 1000 + 0.02);
  }
}

/** Vibration is not secure-context-only; works on Chrome Android over http. @param {number | number[]} p */
export function vibrate(p) {
  try { navigator.vibrate?.(p); } catch { /* unsupported */ }
}
