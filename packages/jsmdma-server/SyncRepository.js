/**
 * SyncRepository.js — jsnosqlc-backed document store for the sync engine.
 *
 * Wraps a jsnosqlc nosqlClient to provide sync-aware upsert, get, and
 * changeset queries. Stores revision metadata (_rev, _fieldRevs) alongside
 * the document so that changesSince() can use a simple Filter.gt() query.
 *
 * The _rev field is an HLC hex string (lexicographically ordered), which means
 * Filter.where('_rev').gt(clientClock) correctly returns all docs modified
 * after clientClock — no special indexing required.
 *
 * nosqlClient can be:
 *   - Injected by CDI (autowired as 'nosqlClient' in S04)
 *   - Passed directly in tests
 *
 * logger is optional. If absent, logging is silently skipped.
 */
import { Filter } from '@alt-javascript/jsnosqlc-core';

export default class SyncRepository {
  /**
   * @param {import('@alt-javascript/jsnosqlc-core').Client} nosqlClient
   * @param {object} [logger] — optional logger with .info() and .debug()
   */
  constructor(nosqlClient, logger) {
    this.nosqlClient = nosqlClient;
    this.logger = logger ?? null;
  }

  _col(collection) {
    return this.nosqlClient.getCollection(collection);
  }

  /**
   * Upsert a document with sync revision metadata.
   *
   * @param {string} collection
   * @param {string} key
   * @param {Object} doc          — application document (no _ fields required)
   * @param {Object} fieldRevs    — { fieldName: hlcString } per-field revisions
   * @param {string} hlc          — current HLC string — becomes doc._rev
   * @returns {Promise<Object>}   — the stored record (with _rev, _fieldRevs, _key)
   */
  async store(collection, key, doc, fieldRevs, hlc) {
    const record = {
      ...doc,
      _key: key,
      _rev: hlc,
      _fieldRevs: fieldRevs ?? {},
    };
    await this._col(collection).store(key, record);
    this.logger?.info?.(`[SyncRepository] store ${collection}/${key} _rev=${hlc}`);
    return record;
  }

  /**
   * Retrieve a document by key.
   *
   * @param {string} collection
   * @param {string} key
   * @returns {Promise<Object|null>}
   */
  async get(collection, key) {
    const doc = await this._col(collection).get(key);
    this.logger?.debug?.(`[SyncRepository] get ${collection}/${key} found=${doc != null}`);
    return doc ?? null;
  }

  /**
   * Return all documents whose _rev is strictly greater than clientClock.
   *
   * Relies on HLC strings being lexicographically ordered — Filter.gt() on
   * string fields uses JavaScript's > operator, which is correct for HLC hex.
   *
   * @param {string} collection
   * @param {string} clientClock — HLC hex string; use HLC.zero() for "all docs"
   * @returns {Promise<Object[]>}
   */
  async changesSince(collection, clientClock) {
    const filter = Filter.where('_rev').gt(clientClock).build();
    const cursor = await this._col(collection).find(filter);
    const docs = await cursor.getDocuments();
    this.logger?.info?.(`[SyncRepository] changesSince ${collection} clock=${clientClock} results=${docs.length}`);
    return docs;
  }

  /**
   * Delete a document by key.
   *
   * @param {string} collection
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(collection, key) {
    await this._col(collection).delete(key);
    this.logger?.info?.(`[SyncRepository] delete ${collection}/${key}`);
  }

  /**
   * Return all documents in a collection matching the given filter AST.
   *
   * @param {string} collection  — namespaced storage collection key
   * @param {Object} filterAst   — pre-built filter AST (from Filter.where(...).build())
   * @returns {Promise<Object[]>}
   */
  async findByFilter(collection, filterAst) {
    const cursor = await this._col(collection).find(filterAst);
    const docs   = await cursor.getDocuments();
    this.logger?.info?.(`[SyncRepository] findByFilter ${collection} results=${docs.length}`);
    return docs;
  }
}
