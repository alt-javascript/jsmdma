/**
 * SyncClient.js — Offline-first sync state manager
 *
 * Isomorphic: zero Node-specific imports. Runs in browser, Node, and edge runtimes.
 *
 * Manages per-document local state and delegates to HLC, diff, and merge to
 * produce sync-ready payloads and apply server responses.
 *
 * Usage:
 *   const client = new SyncClient('device-abc');
 *   client.edit('todos/1', { title: 'Buy milk', done: false });
 *   const payload = client.getChanges();
 *   // ... POST payload to server, receive serverResponse ...
 *   client.sync(serverResponse);
 */

import HLC from './hlc.js';
import diff from './diff.js';
import merge from './merge.js';

export default class SyncClient {
  /**
   * @param {string} nodeId  — stable unique identifier for this client (device/session)
   * @param {number} [wallMs] — optional initial wall-clock time (defaults to 0)
   */
  constructor(nodeId, wallMs) {
    this.clock = HLC.create(nodeId, wallMs ?? 0);
    this.baseClock = HLC.zero();
    /** @type {Object.<string, { doc: Object, fieldRevs: Object, baseSnapshot: Object }>} */
    this.docs = {};
    this.lastSyncAt = null;
  }

  /**
   * Record a local edit for the document at `key`.
   *
   * Ticks the local HLC, computes a field-level diff against the last-synced
   * baseSnapshot, stamps every changed field with the new clock, and stores the
   * current document state.
   *
   * @param {string} key       — document key (e.g. 'todos/1')
   * @param {Object} currentDoc — the full current document object
   * @param {number} [wallMs]  — optional wall-clock override (defaults to Date.now())
   * @returns {this} — chainable
   */
  edit(key, currentDoc, wallMs) {
    this.clock = HLC.tick(this.clock, wallMs ?? Date.now());

    const existing = this.docs[key];
    const baseSnapshot = existing?.baseSnapshot ?? {};
    const existingFieldRevs = existing?.fieldRevs ?? {};

    const { changed } = diff(baseSnapshot, currentDoc, existingFieldRevs, this.clock);

    // Stamp every changed field with the current clock
    const newFieldRevs = { ...existingFieldRevs };
    for (const field of Object.keys(changed)) {
      newFieldRevs[field] = this.clock;
    }

    this.docs[key] = {
      doc: currentDoc,
      fieldRevs: newFieldRevs,
      baseSnapshot,
    };

    return this;
  }

  /**
   * Return all pending local changes as a sync payload array.
   *
   * @returns {Array<{ key: string, doc: Object, fieldRevs: Object, baseClock: string }>}
   */
  getChanges() {
    return Object.entries(this.docs).map(([key, entry]) => ({
      key,
      doc: entry.doc,
      fieldRevs: entry.fieldRevs,
      baseClock: this.baseClock,
    }));
  }

  /**
   * Apply a server sync response, merging remote changes with local state.
   *
   * For each document in serverChanges:
   *   - strips private protocol fields (_key, _rev, _fieldRevs) to isolate app fields
   *   - 3-way merges with the local doc using baseSnapshot as common ancestor
   *   - updates docs[key] with the merged result and advances baseSnapshot
   *
   * After processing all docs:
   *   - advances baseClock to serverClock
   *   - advances local HLC via HLC.recv
   *   - records lastSyncAt
   *
   * @param {{ serverClock: string, serverChanges: Array, conflicts?: Array }} serverResponse
   * @param {number} [wallMs] — optional wall-clock override (defaults to Date.now())
   * @returns {{ serverChanges: Array, conflicts: Array }}
   */
  sync(serverResponse, wallMs) {
    const now = wallMs ?? Date.now();
    const { serverChanges = [], serverClock } = serverResponse;

    for (const serverDoc of serverChanges) {
      const key = serverDoc._key;

      // Strip private protocol fields to extract application fields
      const appFields = {};
      for (const [field, value] of Object.entries(serverDoc)) {
        if (!field.startsWith('_')) {
          appFields[field] = value;
        }
      }
      const serverFieldRevs = serverDoc._fieldRevs ?? {};

      const local = this.docs[key];

      if (!local) {
        // New doc from server — no local version; insert with baseSnapshot = appFields
        this.docs[key] = {
          doc: appFields,
          fieldRevs: serverFieldRevs,
          baseSnapshot: appFields,
        };
      } else {
        // Merge: base = local.baseSnapshot, local side = existing doc, remote side = server doc
        const { merged, conflicts } = merge(
          local.baseSnapshot ?? {},
          { doc: local.doc ?? {}, fieldRevs: local.fieldRevs ?? {} },
          { doc: appFields, fieldRevs: serverFieldRevs },
        );

        this.docs[key] = {
          doc: merged,
          fieldRevs: local.fieldRevs ?? {},
          baseSnapshot: merged,
        };

        // Surface merge conflicts in the returned object (accumulated below)
        if (conflicts.length > 0) {
          serverResponse._mergeConflicts = serverResponse._mergeConflicts ?? [];
          serverResponse._mergeConflicts.push(...conflicts.map(c => ({ ...c, key })));
        }
      }
    }

    this.baseClock = serverClock;
    this.clock = HLC.recv(this.clock, serverClock, now);
    this.lastSyncAt = now;

    const allConflicts = [
      ...(serverResponse.conflicts ?? []),
      ...(serverResponse._mergeConflicts ?? []),
    ];

    return {
      serverChanges: serverResponse.serverChanges,
      conflicts: allConflicts,
    };
  }

  /**
   * Prune local state — resets to a clean slate as if the client just started.
   * Useful after a full server re-download or storage quota pressure.
   *
   * @returns {this} — chainable
   */
  prune() {
    this.baseClock = HLC.zero();
    this.docs = {};
    this.lastSyncAt = null;
    return this;
  }

  /**
   * Return true if the client has synced at least once AND the last sync was
   * more than `thresholdMs` milliseconds ago.
   *
   * @param {number} thresholdMs
   * @returns {boolean}
   */
  shouldPrune(thresholdMs) {
    return this.lastSyncAt !== null && (Date.now() - this.lastSyncAt) > thresholdMs;
  }

  /**
   * Return a plain-object snapshot of all client state suitable for
   * serialisation and later restoration via fromSnapshot().
   *
   * @returns {{ nodeId: string, clock: string, baseClock: string, docs: Object, lastSyncAt: number|null }}
   */
  getSnapshot() {
    return {
      nodeId: HLC.decode(this.clock).node,
      clock: this.clock,
      baseClock: this.baseClock,
      docs: this.docs,
      lastSyncAt: this.lastSyncAt,
    };
  }

  /**
   * Restore a SyncClient from a previously serialised snapshot.
   *
   * @param {{ nodeId: string, clock: string, baseClock: string, docs: Object, lastSyncAt: number|null }} snapshot
   * @returns {SyncClient}
   */
  static fromSnapshot(snapshot) {
    // Derive nodeId from the stored clock to avoid double-initialisation
    const nodeId = HLC.decode(snapshot.clock).node;
    const client = new SyncClient(nodeId, 0);
    client.clock = snapshot.clock;
    client.baseClock = snapshot.baseClock;
    client.docs = snapshot.docs;
    client.lastSyncAt = snapshot.lastSyncAt;
    return client;
  }
}
