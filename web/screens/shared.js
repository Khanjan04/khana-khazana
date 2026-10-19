// @ts-check
// Constants shared by screens (mirror server-side enums; the host validates).
export const PLATFORMS = ['Zomato', 'Swiggy', 'Phone call', 'Other'];
export const PAY_MODES = ['cash', 'card', 'upi', 'due', 'other'];
export const VOID_REASONS = ['Customer changed mind', 'Wrong item punched', 'Kitchen out of stock', 'Customer complaint'];
export const DIET_LABEL = /** @type {Record<string, string>} */ ({ veg: 'Veg', egg: 'Egg', nonveg: 'Non-Veg', none: 'No mark' });
export const KOT_COLUMNS = ['new', 'accepted', 'preparing', 'ready'];
