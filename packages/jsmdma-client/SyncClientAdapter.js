/**
 * SyncClientAdapter.js — localStorage-backed sync state management.
 *
 * Wraps the jsmdma HLC-based sync protocol with browser localStorage persistence.
 *
 * localStorage key patterns (configurable via options):
 *   sync:<uuid>  — last server HLC clock (string)
 *   rev:<uuid>   — fieldRevs map { 'days.2026-03-28.tl': '<hlcString>', ... }
 *   base:<uuid>  — base snapshot (last known server state, for 3-way merge)
 */
import { HLC, merge } from '@alt-javascript/jsmdma-core';

export default class SyncClientAdapter {
  /**
   * @param {import('./DocumentStore.js').default} documentStore
   * @param {{
   *   clockKey?: string,
   *   revKey?: string,
   *   baseKey?: string,
   *   collection?: string,
   * }} [options]
   */
  constructor(documentStore, options = {}) {
    this.documentStore = documentStore;
    this.clockKey  = options.clockKey  ?? 'sync';
    this.revKey    = options.revKey    ?? 'rev';
    this.baseKey   = options.baseKey   ?? 'base';
    this.collection = options.collection ?? 'documents';
  }

  _syncKey(docId)  { return `${this.clockKey}:${docId}`; }
  _revKey(docId)   { return `${this.revKey}:${docId}`; }
  _baseKey(docId)  { return `${this.baseKey}:${docId}`; }

  /**
   * Tick HLC for a dot-path field on a document. Call on every user edit.
   *
   * @param {string} docId — document UUID
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
   * POST to syncUrl with jsmdma payload, apply 3-way merge, persist result.
   *
   * @param {string} docId
   * @param {object} doc — current full document
   * @param {object} authHeaders — e.g. { Authorization: 'Bearer ...' }
   * @param {string} syncUrl — e.g. 'http://127.0.0.1:8081/year-planner/sync'
   * @returns {Promise<object>} merged document
   * @throws {{ status: number }} on HTTP error
   */
  async sync(docId, doc, authHeaders, syncUrl) {
    const clientClock = localStorage.getItem(this._syncKey(docId)) || HLC.zero();
    const fieldRevs   = JSON.parse(localStorage.getItem(this._revKey(docId))  ?? '{}');
    const base        = JSON.parse(localStorage.getItem(this._baseKey(docId)) ?? '{}');

    const payload = {
      collection: this.collection,
      clientClock,
      changes: [{ key: docId, doc, fieldRevs, baseClock: clientClock }],
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
    let merged = doc;

    for (const serverChange of serverChanges) {
      const { _key, _rev, _fieldRevs, ...serverDoc } = serverChange;

      if (_key === docId) {
        // 3-way merge own document
        const result = merge(
          base,
          { doc, fieldRevs },
          { doc: serverDoc, fieldRevs: _fieldRevs ?? {} },
        );
        merged = result.merged;
      } else {
        // Foreign document from another device — store if not already present
        if (this.documentStore.get(_key) === null) {
          this.documentStore.set(_key, serverDoc);
        }
      }
    }

    localStorage.setItem(this._syncKey(docId),  serverClock);
    localStorage.setItem(this._baseKey(docId), JSON.stringify(merged));
    // Clear fieldRevs after successful sync (they've been applied)
    localStorage.setItem(this._revKey(docId), '{}');

    return merged;
  }

  /**
   * Remove all sync state for a document.
   * @param {string} docId
   */
  prune(docId) {
    localStorage.removeItem(this._syncKey(docId));
    localStorage.removeItem(this._revKey(docId));
    localStorage.removeItem(this._baseKey(docId));
  }

  /**
   * Remove sync state for ALL documents in the DocumentStore.
   */
  pruneAll() {
    for (const { uuid } of this.documentStore.list()) {
      this.prune(uuid);
    }
  }
}
