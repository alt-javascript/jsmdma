/**
 * namespaceKey.js — Compute a safe namespaced collection key.
 *
 * Internal storage uses ':' as a separator between userId, application, and
 * collection segments.  Any ':' appearing within a segment is percent-encoded
 * as '%3A' so the separator is unambiguous.
 *
 * @param {string} userId      — identity from JWT (sub claim)
 * @param {string} application — application name from URL path
 * @param {string} collection  — collection name from request body
 * @returns {string}           — e.g. "user-uuid:todo:tasks"
 */
export function namespaceKey(userId, application, collection) {
  const encode = (s) => String(s).replace(/:/g, '%3A');
  return `${encode(userId)}:${encode(application)}:${encode(collection)}`;
}
