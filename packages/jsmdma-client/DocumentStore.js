/**
 * DocumentStore.js — Generic localStorage document CRUD with migration support.
 *
 * localStorage key pattern: <namespace>:<uuid>
 * Migration version key:    <namespace>:migration_version
 *
 * All documents are stored as JSON strings.
 * get() returns null if not found (never undefined).
 */

/** @type {Map<string, Array<{ version: number, up: Function }>>} */
const _migrations = new Map();

export default class DocumentStore {
  /**
   * @param {{ namespace: string }} options
   */
  constructor({ namespace } = {}) {
    if (!namespace) throw new Error('DocumentStore requires a namespace');
    this.namespace = namespace;
  }

  /** @returns {string} */
  _key(uuid) {
    return `${this.namespace}:${uuid}`;
  }

  /**
   * Read a document by UUID. Returns null if not found.
   * @param {string} uuid
   * @returns {object|null}
   */
  get(uuid) {
    const raw = localStorage.getItem(this._key(uuid));
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Write a document by UUID.
   * @param {string} uuid
   * @param {object} doc
   */
  set(uuid, doc) {
    localStorage.setItem(this._key(uuid), JSON.stringify(doc));
  }

  /**
   * List all documents in this namespace.
   * @returns {Array<{ uuid: string, doc: object }>}
   */
  list() {
    const prefix = `${this.namespace}:`;
    const migVersionKey = `${this.namespace}:migration_version`;
    const results = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix) && k !== migVersionKey) {
        const uuid = k.slice(prefix.length);
        const doc = this.get(uuid);
        if (doc !== null) results.push({ uuid, doc });
      }
    }
    return results;
  }

  /**
   * Find the first document matching a predicate.
   * @param {(doc: object) => boolean} predicate
   * @returns {{ uuid: string, doc: object }|null}
   */
  find(predicate) {
    return this.list().find(({ doc }) => predicate(doc)) ?? null;
  }

  /**
   * Delete a document by UUID.
   * @param {string} uuid
   */
  delete(uuid) {
    localStorage.removeItem(this._key(uuid));
  }

  /**
   * Run all registered migrations for this namespace that have not yet been applied.
   * Migrations are applied in version order.
   */
  migrate() {
    const versionKey = `${this.namespace}:migration_version`;
    const currentVersion = parseInt(localStorage.getItem(versionKey) ?? '0', 10);

    const pending = (_migrations.get(this.namespace) ?? [])
      .filter(m => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    if (pending.length === 0) return;

    let docs = this.list();
    let highestVersion = currentVersion;

    for (const migration of pending) {
      docs = migration.up(docs);
      highestVersion = migration.version;
    }

    // Persist transformed documents
    for (const { uuid, doc } of docs) {
      this.set(uuid, doc);
    }

    localStorage.setItem(versionKey, String(highestVersion));
  }

  /**
   * Register a migration for a namespace.
   *
   * @param {string} namespace
   * @param {number} version — must be strictly increasing
   * @param {(docs: Array<{ uuid: string, doc: object }>) => Array<{ uuid: string, doc: object }>} up
   */
  static registerMigration(namespace, version, up) {
    if (!_migrations.has(namespace)) _migrations.set(namespace, []);
    _migrations.get(namespace).push({ version, up });
  }
}
