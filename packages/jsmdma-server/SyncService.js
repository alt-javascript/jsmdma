/**
 * SyncService.js — Orchestrates the sync protocol.
 *
 * Accepts a client changeset (array of changed documents), applies field-level
 * merge against the server's stored versions, persists the results, and returns
 * server-side changes the client hasn't seen yet.
 *
 * Merge strategy — field revision comparison:
 *   For each field, the service compares each side's fieldRev against the
 *   client's baseClock (the last clock the client had synced from the server).
 *
 *   clientChanged  = clientFieldRevs[field] > baseClock
 *   serverChanged  = serverFieldRevs[field] > baseClock
 *
 *   - Neither changed → take server value (shared state)
 *   - Only client changed → take client value
 *   - Only server changed → take server value
 *   - Both changed, string fields → attempt line-level text auto-merge first.
 *     If hunks are non-overlapping: store merged text, report as
 *     winner:'auto-merged', mergeStrategy:'text-auto-merged'.
 *     If hunks overlap → fall through to HLC winner.
 *   - Both changed, non-string fields → HLC winner; higher fieldRev wins;
 *     local wins on tie.
 *
 * Storage namespacing:
 *   The internal collection key is namespaced as
 *   {userId}:{application}:{collection} (with ':' in segments encoded as %3A).
 *   This ensures per-user, per-application isolation at the storage layer.
 *
 * Dependencies (CDI autowired by name):
 *   this.syncRepository — SyncRepository instance
 *   this.logger         — optional logger
 */
import { HLC, textMerge } from 'packages/jsmdma-core';
import { namespaceKey } from './namespaceKey.js';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Get the effective revision for a top-level field, considering dot-path sub-fields.
 * e.g. for field 'days', checks 'days' AND all 'days.*' paths, returns the max.
 */
function maxRevForField(fieldRevs, field) {
  let maxRev = fieldRevs[field] ?? HLC.zero();
  const prefix = field + '.';
  for (const [path, rev] of Object.entries(fieldRevs)) {
    if (path.startsWith(prefix) && HLC.compare(rev, maxRev) > 0) {
      maxRev = rev;
    }
  }
  return maxRev;
}

/**
 * Copy all dot-path fieldRevs for a top-level field into the target map.
 * Also sets the top-level key if topLevelRev is provided.
 */
function copyFieldRevs(target, source, field, topLevelRev) {
  const prefix = field + '.';
  for (const [path, rev] of Object.entries(source)) {
    if (path === field || path.startsWith(prefix)) {
      target[path] = rev;
    }
  }
  if (topLevelRev) target[field] = topLevelRev;
}

export default class SyncService {
  constructor() {
    // CDI will autowire these; direct injection used in tests
    this.syncRepository = null;
    this.logger = null;
    this.documentIndexRepository = null;
  }

  /**
   * Process a sync request from a client.
   *
   * @param {string} collection   — logical collection name (from request body)
   * @param {string} clientClock  — the client's current HLC (highest clock it has seen)
   * @param {Array<{key, doc, fieldRevs, baseClock}>} changes — client's local changes
   * @param {string} [userId]     — identity from JWT sub claim (required for namespacing)
   * @param {string} [application] — application name from URL path (required for namespacing)
   * @returns {Promise<{ serverClock: string, serverChanges: Object[], conflicts: Conflict[] }>}
   */
  async sync(collection, clientClock, changes = [], userId, application) {
    const wallMs = Date.now();
    // Advance server clock past the client's clock to maintain causality
    const serverClock = HLC.recv(
      HLC.create('server', wallMs),
      clientClock,
      wallMs,
    );

    // Compute the namespaced collection key for storage isolation.
    // Fall back to bare collection if userId/application not provided (e.g. tests).
    const storageCollection = (userId != null && application != null)
      ? namespaceKey(userId, application, collection)
      : collection;

    const allConflicts = [];

    // Apply each client change
    for (const change of changes) {
      const { key, doc, fieldRevs, baseClock } = change;
      const clientFieldRevs = fieldRevs ?? {};
      const baseHLC = baseClock ?? HLC.zero();

      // Load current server version
      const serverDoc = await this.syncRepository.get(storageCollection, key);

      let mergedDoc;
      let mergedFieldRevs;

      if (serverDoc == null) {
        // No server version — accept client doc as-is
        mergedDoc = doc;
        mergedFieldRevs = clientFieldRevs;
      } else {
        const serverFieldRevs = serverDoc._fieldRevs ?? {};

        const allFields = new Set([
          ...Object.keys(doc),
          ...Object.keys(serverDoc),
        ].filter((f) => !f.startsWith('_')));

        mergedDoc = {};
        mergedFieldRevs = {};

        for (const field of allFields) {
          const clientRev = maxRevForField(clientFieldRevs, field);
          const serverRev = maxRevForField(serverFieldRevs, field);

          const clientChanged = HLC.compare(clientRev, baseHLC) > 0;
          const serverChanged = HLC.compare(serverRev, baseHLC) > 0;

          if (!clientChanged && !serverChanged) {
            mergedDoc[field] = serverDoc[field];
            copyFieldRevs(mergedFieldRevs, serverFieldRevs, field, serverRev);
          } else if (clientChanged && !serverChanged) {
            mergedDoc[field] = doc[field];
            copyFieldRevs(mergedFieldRevs, clientFieldRevs, field, clientRev);
          } else if (!clientChanged && serverChanged) {
            mergedDoc[field] = serverDoc[field];
            copyFieldRevs(mergedFieldRevs, serverFieldRevs, field, serverRev);
          } else {
            // Both changed — attempt text auto-merge for string fields first
            const clientVal = doc[field];
            const serverVal = serverDoc[field];

            if (typeof clientVal === 'string' && typeof serverVal === 'string') {
              // Reconstruct best-guess base value: the server value at baseClock.
              // We don't store a snapshot at baseClock, so we use an empty string
              // as a conservative base — this means we treat the field as if both
              // sides added their content independently.  For a true 3-way merge
              // the base would need to be stored; absent that, we rely on the
              // stored server doc and report auto-merged when one side is a
              // strict prefix/suffix of the other or hunks don't overlap.
              const baseVal = serverDoc[`_base_${field}`] ?? '';
              const { merged: autoMergedText, autoMerged } = textMerge(baseVal, clientVal, serverVal);

              if (autoMerged) {
                mergedDoc[field] = autoMergedText;
                copyFieldRevs(mergedFieldRevs, clientFieldRevs, field);
                copyFieldRevs(mergedFieldRevs, serverFieldRevs, field);
                mergedFieldRevs[field] = HLC.merge(clientRev, serverRev);
                allConflicts.push({
                  key,
                  collection,
                  field,
                  localRev:    clientRev,
                  remoteRev:   serverRev,
                  localValue:  clientVal,
                  remoteValue: serverVal,
                  winner:      'auto-merged',
                  winnerValue: autoMergedText,
                  mergeStrategy: 'text-auto-merged',
                });
                continue;
              }
            }

            // Object merge: when both sides changed a plain object, merge sub-keys
            // individually so non-colliding entries from both sides are preserved.
            if (isPlainObject(clientVal) && isPlainObject(serverVal)) {
              const mergedObj = {};
              const allSubKeys = new Set([...Object.keys(clientVal), ...Object.keys(serverVal)]);
              for (const subKey of allSubKeys) {
                const subPath = `${field}.${subKey}`;
                const clientSubRev = maxRevForField(clientFieldRevs, subPath);
                const serverSubRev = maxRevForField(serverFieldRevs, subPath);
                const clientSubChanged = HLC.compare(clientSubRev, baseHLC) > 0;
                const serverSubChanged = HLC.compare(serverSubRev, baseHLC) > 0;

                if (!clientSubChanged && !serverSubChanged) {
                  if (subKey in serverVal) mergedObj[subKey] = serverVal[subKey];
                } else if (clientSubChanged && !serverSubChanged) {
                  if (subKey in clientVal) mergedObj[subKey] = clientVal[subKey];
                } else if (!clientSubChanged && serverSubChanged) {
                  if (subKey in serverVal) mergedObj[subKey] = serverVal[subKey];
                } else {
                  // Both changed same sub-key — HLC winner
                  const subWinner = HLC.compare(clientSubRev, serverSubRev) >= 0 ? 'local' : 'remote';
                  const val = subWinner === 'local' ? clientVal[subKey] : serverVal[subKey];
                  if (val !== undefined) mergedObj[subKey] = val;
                }
              }
              mergedDoc[field] = mergedObj;
              copyFieldRevs(mergedFieldRevs, clientFieldRevs, field);
              copyFieldRevs(mergedFieldRevs, serverFieldRevs, field);
              mergedFieldRevs[field] = HLC.merge(clientRev, serverRev);
              continue;
            }

            // HLC fallback — higher rev wins; local wins on tie
            const winner = HLC.compare(clientRev, serverRev) >= 0 ? 'local' : 'remote';
            mergedDoc[field]       = winner === 'local' ? clientVal ?? doc[field] : serverVal ?? serverDoc[field];
            copyFieldRevs(mergedFieldRevs, winner === 'local' ? clientFieldRevs : serverFieldRevs, field, winner === 'local' ? clientRev : serverRev);

            allConflicts.push({
              key,
              collection,
              field,
              localRev:    clientRev,
              remoteRev:   serverRev,
              localValue:  doc[field],
              remoteValue: serverDoc[field],
              winner,
              winnerValue: mergedDoc[field],
            });
          }
        }
      }

      await this.syncRepository.store(storageCollection, key, mergedDoc, mergedFieldRevs, serverClock);
    }

    // Return everything the client hasn't seen yet (own namespace)
    const serverChanges = await this.syncRepository.changesSince(storageCollection, clientClock);

    // ACL fan-out: aggregate cross-namespace shared docs when documentIndexRepository is wired
    if (this.documentIndexRepository != null && userId != null && application != null) {
      // Get all docIndex entries visible to this user for this app
      const accessibleEntries = await this.documentIndexRepository.listAccessibleDocs(userId, application);

      // Group cross-namespace entries by owner (skip own docs — already fetched above)
      const byOwner = new Map();
      for (const entry of accessibleEntries) {
        if (entry.userId === userId) continue; // own docs handled by storageCollection query
        if (!byOwner.has(entry.userId)) byOwner.set(entry.userId, []);
        byOwner.get(entry.userId).push(entry);
      }

      // For each distinct owner, fetch their namespace changes and filter to accessible keys
      for (const [ownerId, entries] of byOwner) {
        // Build a set of accessible docKeys for fast lookup
        const accessibleKeys = new Set(entries.map((e) => e.docKey));

        // Group entries by collection so we make one changesSince call per owner:collection
        const byCollection = new Map();
        for (const entry of entries) {
          if (!byCollection.has(entry.collection)) byCollection.set(entry.collection, []);
          byCollection.get(entry.collection).push(entry);
        }

        for (const [col, colEntries] of byCollection) {
          const crossNamespaceKey = namespaceKey(ownerId, application, col);
          const crossChanges = await this.syncRepository.changesSince(crossNamespaceKey, clientClock);

          // Keep only docs whose _key appears in the accessible docIndex entries
          const colAccessibleKeys = new Set(colEntries.map((e) => e.docKey));
          for (const doc of crossChanges) {
            if (colAccessibleKeys.has(doc._key)) {
              serverChanges.push(doc);
            }
          }
        }
      }
    }

    this.logger?.info?.(
      `[SyncService] sync userId=${userId ?? 'anon'} app=${application ?? 'none'} collection=${collection} storageKey=${storageCollection} clientClock=${clientClock} applied=${changes.length} returning=${serverChanges.length} conflicts=${allConflicts.length}`,
    );

    return { serverClock, serverChanges, conflicts: allConflicts };
  }
}
