/**
 * What an adapter carried over from the served copy instead of reading it this time: Чернівці's
 * tomorrow when `?next` fails, a picture channel's day missing from one page load, ДТЕК's days and
 * emergency flag while YASNO is silent, Запоріжжя's table while its site is down. Phones are better
 * off with it than without, but it is no look at the operator. Counted as one by send-news.mjs, the
 * served copy confirmed itself: a state read once — a table caught mid-edit — went out as settled
 * the moment the next request failed.
 *
 * Kept beside the snapshot, never on it, so none of it can reach the served file.
 */

const carried = new WeakMap();

/**
 * @param {Array<number|'emergency'>|true} parts Day epochs and/or `'emergency'`; `true` when the
 *   read leaned on the served copy as a whole and is no fresh look at the region at all.
 */
export function markCarried(snapshot, parts) {
  if (parts === true || parts.length) carried.set(snapshot, parts === true ? true : [...new Set(parts)].sort());
  return snapshot;
}

/** @returns {Array<number|'emergency'>|true|null} */
export function carriedParts(snapshot) {
  return (snapshot && carried.get(snapshot)) ?? null;
}
