// DocumentStore.js
var _migrations = /* @__PURE__ */ new Map();
var DocumentStore = class {
  /**
   * @param {{ namespace: string }} options
   */
  constructor({ namespace } = {}) {
    if (!namespace) throw new Error("DocumentStore requires a namespace");
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
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
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
    const currentVersion = parseInt(localStorage.getItem(versionKey) ?? "0", 10);
    const pending = (_migrations.get(this.namespace) ?? []).filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
    if (pending.length === 0) return;
    let docs = this.list();
    let highestVersion = currentVersion;
    for (const migration of pending) {
      docs = migration.up(docs);
      highestVersion = migration.version;
    }
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
};

// HttpClient.js
var HttpClient = class {
  /**
   * @param {{ getToken: () => string|null, onTokenRefresh: (token: string) => void }} options
   */
  constructor({ getToken, onTokenRefresh } = {}) {
    this.getToken = getToken ?? (() => null);
    this.onTokenRefresh = onTokenRefresh ?? (() => {
    });
  }
  /**
   * Fetch JSON with auth header injected. Handles X-Auth-Token rolling refresh.
   *
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<object>}
   * @throws {{ status: number, message: string }} on non-2xx
   */
  async fetchJSON(url, options = {}) {
    const token = this.getToken();
    const headers = {
      Accept: "application/json",
      ...options.headers
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (options.body && typeof options.body === "string") {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }
    const response = await fetch(url, { ...options, headers });
    const newToken = response.headers.get("X-Auth-Token");
    if (newToken) this.onTokenRefresh(newToken);
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }
  /**
   * POST JSON body to url.
   * @param {string} url
   * @param {object} body
   * @returns {Promise<object>}
   */
  async post(url, body) {
    return this.fetchJSON(url, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }
  /**
   * DELETE request to url.
   * @param {string} url
   * @returns {Promise<object>}
   */
  async delete(url) {
    return this.fetchJSON(url, { method: "DELETE" });
  }
};

// SyncClientAdapter.js
import { HLC, merge } from "@alt-javascript/jsmdma-core";
var SyncClientAdapter = class {
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
    this.clockKey = options.clockKey ?? "sync";
    this.revKey = options.revKey ?? "rev";
    this.baseKey = options.baseKey ?? "base";
    this.collection = options.collection ?? "documents";
  }
  _syncKey(docId) {
    return `${this.clockKey}:${docId}`;
  }
  _revKey(docId) {
    return `${this.revKey}:${docId}`;
  }
  _baseKey(docId) {
    return `${this.baseKey}:${docId}`;
  }
  /**
   * Tick HLC for a dot-path field on a document. Call on every user edit.
   *
   * @param {string} docId — document UUID
   * @param {string} dotPath — e.g. 'days.2026-03-28.tl'
   */
  markEdited(docId, dotPath) {
    const rawRev = localStorage.getItem(this._revKey(docId));
    const revs = rawRev ? JSON.parse(rawRev) : {};
    const syncRaw = localStorage.getItem(this._syncKey(docId));
    const baseClock = syncRaw || HLC.zero();
    const existing = revs[dotPath] || baseClock;
    revs[dotPath] = HLC.tick(existing, Date.now());
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
    const fieldRevs = JSON.parse(localStorage.getItem(this._revKey(docId)) ?? "{}");
    const base = JSON.parse(localStorage.getItem(this._baseKey(docId)) ?? "{}");
    const payload = {
      collection: this.collection,
      clientClock,
      changes: [{ key: docId, doc, fieldRevs, baseClock: clientClock }]
    };
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...authHeaders },
      body: JSON.stringify(payload)
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
        const result = merge(
          base,
          { doc, fieldRevs },
          { doc: serverDoc, fieldRevs: _fieldRevs ?? {} }
        );
        merged = result.merged;
      } else {
        if (this.documentStore.get(_key) === null) {
          this.documentStore.set(_key, serverDoc);
        }
      }
    }
    localStorage.setItem(this._syncKey(docId), serverClock);
    localStorage.setItem(this._baseKey(docId), JSON.stringify(merged));
    localStorage.setItem(this._revKey(docId), "{}");
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
};
export {
  DocumentStore,
  HttpClient,
  SyncClientAdapter
};
