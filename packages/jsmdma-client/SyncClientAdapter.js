/**
 * SyncClientAdapter.js — localStorage-backed multi-document sync.
 *
 * Wraps the jsmdma HLC-based sync protocol with browser localStorage persistence.
 * Syncs ALL sync-eligible documents in a single HTTP request.
 *
 * localStorage key patterns:
 *   sync:<uuid>  — last server HLC clock (string)
 *   rev:<uuid>   — fieldRevs map { 'days.2026-03-28.tl': '<hlcString>', ... }
 *   base:<uuid>  — base snapshot (last known server state, for 3-way merge)
 */
import { HLC, merge } from 'packages/jsmdma-core';

export default class SyncClientAdapter {
  /**
   * @param {import('./SyncDocumentStore.js').default} syncDocumentStore
   * @param {{
   *   clockKey?: string,
   *   revKey?: string,
   *   baseKey?: string,
   *   collection?: string,
   * }} [options]
   */
  constructor(syncDocumentStore, options = {}) {
    this.syncDocumentStore = syncDocumentStore;
    this.documentStore = syncDocumentStore; // alias for pruneAll iteration
    this.clockKey   = options.clockKey  ?? 'sync';
    this.revKey     = options.revKey    ?? 'rev';
    this.baseKey    = options.baseKey   ?? 'base';
    this.collection = options.collection ?? 'documents';
  }

  _syncKey(docId)  { return `${this.clockKey}:${docId}`; }
  _revKey(docId)   { return `${this.revKey}:${docId}`; }
  _baseKey(docId)  { return `${this.baseKey}:${docId}`; }

  /**
   * Tick HLC for a dot-path field on a document. Call on every user edit.
   * @param {string} docId
   * @param {string} dotPath — e.g. 'days.2026-03-28.tl'
   */
  markEdited(docId, dotPath) {
    const rawRev    = localStorage.getItem(this._revKey(docId));
    const revs      = rawRev ? JSON.parse(rawRev) : {};
    const syncRaw   = localStorage.getItem(this._syncKey(docId));
    const baseClock = syncRaw || HLC.zero();
    const existing  = revs[dotPath] || baseClock;
    revs[dotPath]   = HLC.tick(existing, Date.now());
    localStorage.setItem(this._revKey(docId), JSON.stringify(revs));
  }

  /**
   * Sync all documents owned by userId in a single HTTP request.
   *
   * @param {string} userId — authenticated user UUID
   * @param {object} authHeaders — e.g. { Authorization: 'Bearer ...' }
   * @param {string} syncUrl — e.g. 'http://127.0.0.1:8081/year-planner/sync'
   * @returns {Promise<Object<string, object>>} map of docId → merged document
   * @throws {{ status: number }} on HTTP error
   */
  async sync(userId, authHeaders, syncUrl) {
    const syncableDocs = this.syncDocumentStore.listSyncable(userId);

    // Build changes array — one entry per syncable doc
    const changes = [];
    let maxClientClock = HLC.zero();

    for (const { uuid, doc } of syncableDocs) {
      const clientClock = localStorage.getItem(this._syncKey(uuid)) || HLC.zero();
      const fieldRevs   = JSON.parse(localStorage.getItem(this._revKey(uuid))  ?? '{}');

      if (HLC.compare(clientClock, maxClientClock) > 0) {
        maxClientClock = clientClock;
      }

      changes.push({ key: uuid, doc, fieldRevs, baseClock: clientClock });
    }

    const payload = {
      collection: this.collection,
      clientClock: maxClientClock,
      changes,
    };

    const response = await fetch(syncUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...authHeaders },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const { serverClock, serverChanges = [] } = await response.json();

    // Build lookup of local docs for merge
    const localDocMap = new Map(syncableDocs.map(({ uuid, doc }) => [uuid, doc]));
    const results = {};

    for (const serverChange of serverChanges) {
      const { _key, _rev, _fieldRevs, ...serverDoc } = serverChange;

      if (localDocMap.has(_key)) {
        // 3-way merge own document
        const localDoc  = localDocMap.get(_key);
        const base      = JSON.parse(localStorage.getItem(this._baseKey(_key)) ?? '{}');
        const fieldRevs = JSON.parse(localStorage.getItem(this._revKey(_key))  ?? '{}');
        const result    = merge(
          base,
          { doc: localDoc, fieldRevs },
          { doc: serverDoc, fieldRevs: _fieldRevs ?? {} },
        );
        results[_key] = result.merged;
      } else {
        // Foreign document — store locally
        this.syncDocumentStore.set(_key, serverDoc);
      }
    }

    // Persist sync state for all synced docs
    for (const { uuid } of syncableDocs) {
      localStorage.setItem(this._syncKey(uuid), serverClock);
      const merged = results[uuid] || localDocMap.get(uuid);
      localStorage.setItem(this._baseKey(uuid), JSON.stringify(merged));
      localStorage.setItem(this._revKey(uuid), '{}');
    }

    return results;
  }

  /** Remove all sync state for a document. */
  prune(docId) {
    localStorage.removeItem(this._syncKey(docId));
    localStorage.removeItem(this._revKey(docId));
    localStorage.removeItem(this._baseKey(docId));
  }

  /** Remove sync state for ALL documents in the store. */
  pruneAll() {
    for (const { uuid } of this.syncDocumentStore.list()) {
      this.prune(uuid);
    }
  }
}
