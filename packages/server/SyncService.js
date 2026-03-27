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
import { HLC, textMerge } from '@alt-javascript/data-api-core';
import { namespaceKey } from './namespaceKey.js';

export default class SyncService {
  constructor() {
    // CDI will autowire these; direct injection used in tests
    this.syncRepository = null;
    this.logger = null;
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
          const clientRev = clientFieldRevs[field] ?? HLC.zero();
          const serverRev = serverFieldRevs[field] ?? HLC.zero();

          const clientChanged = HLC.compare(clientRev, baseHLC) > 0;
          const serverChanged = HLC.compare(serverRev, baseHLC) > 0;

          if (!clientChanged && !serverChanged) {
            mergedDoc[field] = serverDoc[field];
            mergedFieldRevs[field] = serverRev;
          } else if (clientChanged && !serverChanged) {
            mergedDoc[field] = doc[field];
            mergedFieldRevs[field] = clientRev;
          } else if (!clientChanged && serverChanged) {
            mergedDoc[field] = serverDoc[field];
            mergedFieldRevs[field] = serverRev;
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

            // HLC fallback — higher rev wins; local wins on tie
            const winner = HLC.compare(clientRev, serverRev) >= 0 ? 'local' : 'remote';
            mergedDoc[field]       = winner === 'local' ? clientVal ?? doc[field] : serverVal ?? serverDoc[field];
            mergedFieldRevs[field] = winner === 'local' ? clientRev : serverRev;

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

    // Return everything the client hasn't seen yet
    const serverChanges = await this.syncRepository.changesSince(storageCollection, clientClock);

    this.logger?.info?.(
      `[SyncService] sync userId=${userId ?? 'anon'} app=${application ?? 'none'} collection=${collection} storageKey=${storageCollection} clientClock=${clientClock} applied=${changes.length} returning=${serverChanges.length} conflicts=${allConflicts.length}`,
    );

    return { serverClock, serverChanges, conflicts: allConflicts };
  }
}
