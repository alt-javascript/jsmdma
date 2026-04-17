/**
 * merge.js — Three-way field-level merge with conflict detection
 *
 * Isomorphic: zero Node-specific imports.
 *
 * Performs a three-way merge of a base document against local and remote
 * versions. Each side carries per-field HLC revision maps that establish
 * causality for conflict resolution.
 *
 * Conflict resolution: when both sides changed the same field, the version
 * with the higher HLC wins (later in causal time). On equal HLC (tie), local
 * wins as a stable tie-break.
 *
 * Private fields (names starting with '_') are excluded from field-level
 * processing — they are owned by the sync protocol layer.
 *
 * @param {Object} base   — common ancestor document (last synced state)
 * @param {{ doc: Object, fieldRevs: Object }} local  — local version
 * @param {{ doc: Object, fieldRevs: Object }} remote — remote version
 *
 * @returns {{
 *   merged: Object,
 *   conflicts: Array<{
 *     field: string,
 *     localRev: string,
 *     remoteRev: string,
 *     localValue: any,
 *     remoteValue: any,
 *     winner: 'local' | 'remote',
 *     winnerValue: any
 *   }>
 * }}
 */
import HLC from './hlc.js';
import textMerge from './textMerge.js';

export default function merge(base, local, remote) {
  const localDoc   = local.doc  ?? {};
  const remoteDoc  = remote.doc ?? {};
  const localRevs  = local.fieldRevs  ?? {};
  const remoteRevs = remote.fieldRevs ?? {};
  const baseDoc    = base ?? {};

  // Collect all application-level (non-private) fields from both sides
  const allFields = new Set([
    ...Object.keys(localDoc),
    ...Object.keys(remoteDoc),
    ...Object.keys(baseDoc),
  ]);

  const merged = {};
  const conflicts = [];

  for (const field of allFields) {
    if (field.startsWith('_')) continue; // private — skip

    const baseVal   = baseDoc[field];
    const localVal  = localDoc[field];
    const remoteVal = remoteDoc[field];

    const localChanged  = localVal  !== baseVal;
    const remoteChanged = remoteVal !== baseVal;

    if (!localChanged && !remoteChanged) {
      // Neither side changed — take base (same as local/remote)
      merged[field] = baseVal;
      continue;
    }

    if (localChanged && !remoteChanged) {
      merged[field] = localVal;
      continue;
    }

    if (!localChanged && remoteChanged) {
      merged[field] = remoteVal;
      continue;
    }

    // Both changed — attempt text auto-merge for string fields first
    const localRev  = localRevs[field]  ?? HLC.zero();
    const remoteRev = remoteRevs[field] ?? HLC.zero();

    if (typeof localVal === 'string' && typeof remoteVal === 'string') {
      const baseStr = typeof baseVal === 'string' ? baseVal : '';
      const { merged: autoMergedText, autoMerged } = textMerge(baseStr, localVal, remoteVal);
      if (autoMerged) {
        merged[field] = autoMergedText;
        conflicts.push({
          field,
          localRev,
          remoteRev,
          localValue:  localVal,
          remoteValue: remoteVal,
          winner:      'auto-merged',
          winnerValue: autoMergedText,
          mergeStrategy: 'text-auto-merged',
        });
        continue;
      }
    }

    // Higher HLC wins; local wins on tie (stable tie-break)
    const winner = HLC.compare(localRev, remoteRev) >= 0 ? 'local' : 'remote';
    const winnerValue = winner === 'local' ? localVal : remoteVal;

    merged[field] = winnerValue;

    conflicts.push({
      field,
      localRev,
      remoteRev,
      localValue: localVal,
      remoteValue: remoteVal,
      winner,
      winnerValue,
    });
  }

  return { merged, conflicts };
}
