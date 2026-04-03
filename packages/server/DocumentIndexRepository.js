/**
 * DocumentIndexRepository.js — Ownership and visibility index for synced documents.
 *
 * Manages docIndex entries in a single nosqlClient collection named 'docIndex'.
 * The compound storage key format is:
 *
 *   docIndex:{encode(userId)}:{encode(app)}:{encode(docKey)}
 *
 * where encode() replaces ':' with '%3A', matching the namespaceKey.js convention.
 *
 * Key invariant: upsertOwnership() NEVER resets visibility, sharedWith, or
 * shareToken. Once set, those fields are only mutated by their dedicated methods.
 *
 * nosqlClient can be:
 *   - Injected by CDI (autowired as 'nosqlClient')
 *   - Passed directly in tests
 *
 * logger is optional. If absent, logging is silently skipped.
 */
import { Filter } from '@alt-javascript/jsnosqlc-core';

const encode = (s) => String(s).replace(/:/g, '%3A');

export default class DocumentIndexRepository {
  /**
   * @param {import('@alt-javascript/jsnosqlc-core').Client} nosqlClient
   * @param {object} [logger] — optional logger with .info() and .debug()
   */
  constructor(nosqlClient, logger) {
    this.nosqlClient = nosqlClient;
    this.logger = logger ?? null;
  }

  _col() {
    return this.nosqlClient.getCollection('docIndex');
  }

  /**
   * Build the compound storage key for a docIndex entry.
   * @param {string} userId
   * @param {string} app
   * @param {string} docKey
   * @returns {string}
   */
  _key(userId, app, docKey) {
    return `docIndex:${encode(userId)}:${encode(app)}:${encode(docKey)}`;
  }

  /**
   * Create a docIndex entry if absent; update only updatedAt if present.
   * Never resets visibility, sharedWith, or shareToken.
   *
   * @param {string} userId
   * @param {string} app
   * @param {string} docKey
   * @param {string} collection
   * @returns {Promise<void>}
   */
  async upsertOwnership(userId, app, docKey, collection) {
    const key = this._key(userId, app, docKey);
    const existing = await this._col().get(key);
    const now = new Date().toISOString();

    if (existing == null) {
      const entry = {
        _key: key,
        docKey,
        userId,
        app,
        collection,
        visibility: 'private',
        sharedWith: [],
        shareToken: null,
        createdAt: now,
        updatedAt: now,
      };
      await this._col().store(key, entry);
      this.logger?.info?.(`[DocumentIndexRepository] upsert create ${key}`);
    } else {
      const updated = { ...existing, updatedAt: now };
      await this._col().store(key, updated);
      this.logger?.info?.(`[DocumentIndexRepository] upsert touch ${key}`);
    }
  }

  /**
   * Retrieve a docIndex entry.
   *
   * @param {string} userId
   * @param {string} app
   * @param {string} docKey
   * @returns {Promise<Object|null>}
   */
  async get(userId, app, docKey) {
    const key = this._key(userId, app, docKey);
    const doc = await this._col().get(key);
    this.logger?.debug?.(`[DocumentIndexRepository] get ${key} found=${doc != null}`);
    return doc ?? null;
  }

  /**
   * Set the visibility level of a docIndex entry.
   *
   * @param {string} userId
   * @param {string} app
   * @param {string} docKey
   * @param {'private'|'shared'|'org'|'public'} visibility
   * @returns {Promise<void>}
   */
  async setVisibility(userId, app, docKey, visibility) {
    const key = this._key(userId, app, docKey);
    const existing = await this._col().get(key);
    if (existing == null) throw new Error(`docIndex entry not found: ${key}`);
    const updated = { ...existing, visibility, updatedAt: new Date().toISOString() };
    await this._col().store(key, updated);
    this.logger?.info?.(`[DocumentIndexRepository] setVisibility ${key} → ${visibility}`);
  }

  /**
   * Add a (userId2, app2) share pair to sharedWith. Idempotent.
   *
   * @param {string} userId   — owner
   * @param {string} app      — owner's app
   * @param {string} docKey
   * @param {string} userId2  — user to grant access to
   * @param {string} app2     — app namespace the share is scoped to
   * @returns {Promise<void>}
   */
  async addSharedWith(userId, app, docKey, userId2, app2) {
    const key = this._key(userId, app, docKey);
    const existing = await this._col().get(key);
    if (existing == null) throw new Error(`docIndex entry not found: ${key}`);

    const alreadyPresent = (existing.sharedWith ?? []).some(
      (e) => e.userId === userId2 && e.app === app2
    );
    if (alreadyPresent) {
      this.logger?.debug?.(`[DocumentIndexRepository] addSharedWith ${key} already has ${userId2}:${app2}`);
      return;
    }

    const sharedWith = [...(existing.sharedWith ?? []), { userId: userId2, app: app2 }];
    const updated = { ...existing, sharedWith, updatedAt: new Date().toISOString() };
    await this._col().store(key, updated);
    this.logger?.info?.(`[DocumentIndexRepository] addSharedWith ${key} + ${userId2}:${app2}`);
  }

  /**
   * Set or clear the share token on a docIndex entry.
   *
   * @param {string} userId
   * @param {string} app
   * @param {string} docKey
   * @param {string|null} token — UUID token, or null to clear
   * @returns {Promise<void>}
   */
  async setShareToken(userId, app, docKey, token) {
    const key = this._key(userId, app, docKey);
    const existing = await this._col().get(key);
    if (existing == null) throw new Error(`docIndex entry not found: ${key}`);
    const updated = { ...existing, shareToken: token, updatedAt: new Date().toISOString() };
    await this._col().store(key, updated);
    this.logger?.info?.(`[DocumentIndexRepository] setShareToken ${key} token=${token}`);
  }

  /**
   * Delete a docIndex entry by its composite key.
   *
   * @param {string} compositeKey — the `_key` field stored on the entry
   * @returns {Promise<void>}
   */
  async delete(compositeKey) {
    await this._col().delete(compositeKey);
    this.logger?.info?.(`[DocumentIndexRepository] delete ${compositeKey}`);
  }

  /**
   * Return all docIndex entries for a given owner (userId + app).
   * Performs a filter scan over the 'docIndex' collection.
   *
   * @param {string} userId
   * @param {string} app
   * @returns {Promise<Object[]>}
   */
  async listByUser(userId, app) {
    const filter = Filter.where('userId').eq(userId).and('app').eq(app).build();
    const cursor = await this._col().find(filter);
    const docs = await cursor.getDocuments();
    this.logger?.info?.(`[DocumentIndexRepository] listByUser userId=${userId} app=${app} count=${docs.length}`);
    return docs;
  }

  /**
   * Return all docIndex entries visible to requestorId for a given app.
   *
   * ACL rules applied (in order):
   *   1. Own docs          — userId === requestorId (any visibility)
   *   2. Public docs       — visibility === 'public' (any owner)
   *   3. Shared docs       — visibility === 'shared' AND sharedWith contains
   *                          { userId: requestorId, app }
   *   4. Org docs          — visibility === 'org' AND orgIds.length > 0
   *                          // TODO S02: org cross-namespace fan-out requires owner orgId lookup
   *
   * Uses a single app-level scan (Filter.where('app').eq(app)) because the
   * memory driver does NOT support dot-path array traversal in filter predicates.
   * JS-side filtering is applied after the scan.
   *
   * @param {string}   requestorId — userId of the requestor
   * @param {string}   app         — app namespace to scan
   * @param {string[]} [orgIds=[]] — org IDs the requestor belongs to (reserved for S02)
   * @returns {Promise<Object[]>}
   */
  async listAccessibleDocs(requestorId, app, orgIds = []) {
    const filter = Filter.where('app').eq(app).build();
    const cursor = await this._col().find(filter);
    const docs = await cursor.getDocuments();

    const visible = docs.filter((doc) => {
      // Rule 1: own doc — always visible regardless of visibility setting
      if (doc.userId === requestorId) return true;

      // Rule 2: explicitly public
      if (doc.visibility === 'public') return true;

      // Rule 3: shared with requestorId in this app namespace
      if (doc.visibility === 'shared') {
        return (doc.sharedWith ?? []).some(
          (e) => e.userId === requestorId && e.app === app
        );
      }

      // Rule 4: org-visibility cross-namespace fan-out (deferred)
      // TODO S02: org cross-namespace fan-out requires owner orgId lookup
      // if (doc.visibility === 'org' && orgIds.length > 0) { ... }

      return false;
    });

    this.logger?.info?.(
      `[DocumentIndexRepository] listAccessibleDocs requestorId=${requestorId} app=${app} ` +
      `scanned=${docs.length} visible=${visible.length}`
    );
    return visible;
  }
}
