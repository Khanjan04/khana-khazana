// @ts-check
// Command registry. New command => handler here + right in rights.js + tests in test/.
import { kotHandlers } from './kot.js';
import { orderHandlers } from './order.js';
import { billHandlers } from './bill.js';
import { adminHandlers } from './admin.js';
import { dayHandlers } from './day.js';

/** @type {Record<string, import('../engine.js').Handler>} */
export const handlers = Object.freeze({
  ...kotHandlers,
  ...orderHandlers,
  ...billHandlers,
  ...adminHandlers,
  ...dayHandlers,
});
