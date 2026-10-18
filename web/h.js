// @ts-check
// Tiny hyperscript helper: h('div.card#x', {onclick, class, style:{...}}, ...children)

/**
 * @param {string} sel tag with optional .class and #id
 * @param {any} [props] attributes object, or the first child
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(sel, props, ...children) {
  const m = /^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i.exec(sel);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props !== undefined && props !== null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList.add(c);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') /** @type {any} */ (el)[k] = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** @param {Node} el @param {any[]} children */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** SVG element helper. @param {string} tag @param {Record<string, any>} [attrs] @param {...Node} children */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

/** @param {any} e @returns {string} */
export const val = (e) => /** @type {HTMLInputElement} */ (e.target).value;
