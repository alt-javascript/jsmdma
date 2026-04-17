/**
 * diff.js — Shallow field-level diff with HLC annotation
 *
 * Isomorphic: zero Node-specific imports.
 *
 * Compares a base document against a current (locally modified) document and
 * returns which fields changed, what their old/new values were, and stamps each
 * changed field with the provided HLC string.
 *
 * Private fields (names starting with '_') are excluded from the diff — they
 * are managed by the sync protocol, not the application merge engine.
 *
 * @param {Object} base       — last-synced document (common ancestor)
 * @param {Object} current    — locally-modified document
 * @param {Object} fieldRevs  — { fieldName: hlcString } from last sync (unused in diff,
 *                              passed through for caller convenience)
 * @param {string} hlcNow     — HLC string to stamp on each changed field
 * @returns {{ changed: Object, unchanged: string[] }}
 *
 * changed shape:
 *   { [fieldName]: { old: any, new: any, rev: hlcString } }
 */
export default function diff(base, current, fieldRevs, hlcNow) {
  const allFields = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(current || {}),
  ]);

  const changed = {};
  const unchanged = [];

  for (const field of allFields) {
    if (field.startsWith('_')) continue; // private — managed by sync protocol

    const oldVal = base != null ? base[field] : undefined;
    const newVal = current != null ? current[field] : undefined;

    if (oldVal !== newVal) {
      changed[field] = { old: oldVal, new: newVal, rev: hlcNow };
    } else {
      unchanged.push(field);
    }
  }

  return { changed, unchanged };
}
