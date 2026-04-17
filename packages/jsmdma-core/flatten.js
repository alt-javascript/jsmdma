/**
 * flatten.js — Dot-path flatten/unflatten for nested objects
 *
 * Isomorphic: zero Node-specific imports.
 *
 * flatten(obj) converts a nested object to a flat map of dot-path keys:
 *   { a: { b: { c: 1 } } }  →  { 'a.b.c': 1 }
 *
 * unflatten(flat) is the inverse:
 *   { 'a.b.c': 1 }  →  { a: { b: { c: 1 } } }
 *
 * Encoding rules:
 *   - Literal dots in key names are percent-encoded as %2E before joining with '.'
 *   - Arrays are treated as opaque leaf values — they are NOT recursed into
 *   - Empty objects are treated as leaf values (no keys to recurse)
 *   - Private fields (starting with '_') are excluded from both directions
 *
 * @module flatten
 */

/**
 * Flatten a nested object into a flat map of dot-path → leaf-value pairs.
 *
 * @param {Object} obj     — object to flatten
 * @param {string} prefix  — current path prefix (for recursion; leave empty on first call)
 * @param {Object} result  — accumulator (for recursion; leave empty on first call)
 * @returns {Object}       — flat dot-path map
 */
export function flatten(obj, prefix = '', result = {}) {
  if (obj == null || typeof obj !== 'object') {
    // Scalar input — treat the whole thing as a single leaf if prefix is set
    if (prefix !== '') result[prefix] = obj;
    return result;
  }

  const keys = Object.keys(obj);

  // Treat as a leaf if it's an array, or if it has no own keys (empty object)
  const isLeaf =
    Array.isArray(obj) ||
    keys.length === 0;

  if (isLeaf) {
    if (prefix !== '') result[prefix] = obj;
    return result;
  }

  for (const key of keys) {
    if (key.startsWith('_')) continue; // private — excluded

    const encodedKey = key.replace(/\./g, '%2E');
    const path = prefix ? `${prefix}.${encodedKey}` : encodedKey;
    const val = obj[key];

    const isPlainObj =
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val);

    if (isPlainObj && Object.keys(val).length > 0) {
      // Non-empty plain object — recurse
      flatten(val, path, result);
    } else {
      // Leaf: primitives, null, arrays, empty objects
      result[path] = val;
    }
  }

  return result;
}

/**
 * Unflatten a flat dot-path map back into a nested object.
 *
 * @param {Object} flat — flat dot-path map produced by flatten()
 * @returns {Object}    — nested object
 */
export function unflatten(flat) {
  const result = {};

  for (const dotPath of Object.keys(flat)) {
    // Split on literal '.' but not on '%2E'
    // Strategy: split on '.', then re-join any segments that were split
    // across a percent-encoded dot. Since '%2E' contains no '.', a simple
    // split on '.' is safe — '%2E' won't be split. Then decode '%2E' → '.'
    // in each segment.
    const segments = dotPath.split('.');
    const decodedSegments = segments.map(s => s.replace(/%2E/gi, '.'));

    // Skip private path segments
    if (decodedSegments.some(s => s.startsWith('_'))) continue;

    let cursor = result;

    for (let i = 0; i < decodedSegments.length - 1; i++) {
      const seg = decodedSegments[i];
      if (cursor[seg] == null || typeof cursor[seg] !== 'object' || Array.isArray(cursor[seg])) {
        cursor[seg] = {};
      }
      cursor = cursor[seg];
    }

    const lastSeg = decodedSegments[decodedSegments.length - 1];
    cursor[lastSeg] = flat[dotPath];
  }

  return result;
}
