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

// ../core/hlc.js
var MS_PAD = 13;
var SEQ_PAD = 6;
function encode(state) {
  const msPart = Math.floor(state.ms).toString(16).padStart(MS_PAD, "0");
  const seqPart = Math.floor(state.seq).toString(16).padStart(SEQ_PAD, "0");
  return `${msPart}-${seqPart}-${state.node}`;
}
function decode(str) {
  const first = str.indexOf("-");
  const second = str.indexOf("-", first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`HLC.decode: invalid format "${str}"`);
  }
  const ms = parseInt(str.slice(0, first), 16);
  const seq = parseInt(str.slice(first + 1, second), 16);
  const node = str.slice(second + 1);
  return { ms, seq, node };
}
function zero() {
  return `${"0".repeat(MS_PAD)}-${"0".repeat(SEQ_PAD)}-00000000`;
}
function tick(current, wallMs) {
  const c = typeof current === "string" ? decode(current) : current;
  const wall = Math.floor(wallMs);
  if (wall > c.ms) {
    return encode({ ms: wall, seq: 0, node: c.node });
  }
  return encode({ ms: c.ms, seq: c.seq + 1, node: c.node });
}
function recv(local, remote, wallMs) {
  const l = typeof local === "string" ? decode(local) : local;
  const r = typeof remote === "string" ? decode(remote) : remote;
  const wall = Math.floor(wallMs);
  const maxMs = Math.max(l.ms, r.ms, wall);
  if (maxMs === wall && wall > l.ms && wall > r.ms) {
    return encode({ ms: wall, seq: 0, node: l.node });
  }
  if (maxMs === l.ms && l.ms === r.ms) {
    return encode({ ms: maxMs, seq: Math.max(l.seq, r.seq) + 1, node: l.node });
  }
  if (maxMs === l.ms) {
    return encode({ ms: maxMs, seq: l.seq + 1, node: l.node });
  }
  return encode({ ms: maxMs, seq: r.seq + 1, node: l.node });
}
function merge(a, b) {
  return compare(a, b) >= 0 ? a : b;
}
function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function create(nodeId, wallMs) {
  const ms = wallMs !== void 0 ? Math.floor(wallMs) : 0;
  return encode({ ms, seq: 0, node: nodeId });
}
var HLC = { encode, decode, zero, tick, recv, merge, compare, create };
var hlc_default = HLC;

// ../core/textMerge.js
function splitLines(text) {
  if (text == null || text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const raw = trailingNewline ? text.slice(0, -1) : text;
  return { lines: raw.split("\n"), trailingNewline };
}
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  const table = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i * (n + 1) + j] = a[i - 1] === b[j - 1] ? table[(i - 1) * (n + 1) + (j - 1)] + 1 : Math.max(table[(i - 1) * (n + 1) + j], table[i * (n + 1) + (j - 1)]);
    }
  }
  return table;
}
function computeHunks(base, modified) {
  const m = base.length;
  const n = modified.length;
  const table = lcsTable(base, modified);
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === modified[j - 1]) {
      ops.push({ type: "keep", baseLine: i - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i * (n + 1) + (j - 1)] >= table[(i - 1) * (n + 1) + j])) {
      ops.push({ type: "insert", modLine: modified[j - 1] });
      j--;
    } else {
      ops.push({ type: "delete", baseLine: i - 1 });
      i--;
    }
  }
  ops.reverse();
  const hunks = [];
  let opIdx = 0;
  while (opIdx < ops.length) {
    const op = ops[opIdx];
    if (op.type === "keep") {
      opIdx++;
      continue;
    }
    let baseStart = null;
    let baseEnd = null;
    const hunkLines = [];
    while (opIdx < ops.length && ops[opIdx].type !== "keep") {
      const cur = ops[opIdx];
      if (cur.type === "delete") {
        if (baseStart === null) baseStart = cur.baseLine;
        baseEnd = cur.baseLine + 1;
      } else {
        hunkLines.push(cur.modLine);
      }
      opIdx++;
    }
    if (baseStart === null) {
      let insertPoint = 0;
      for (let k = opIdx - 1; k >= 0; k--) {
        if (ops[k] && ops[k].type === "keep") {
          insertPoint = ops[k].baseLine + 1;
          break;
        }
      }
      baseStart = insertPoint;
      baseEnd = insertPoint;
    }
    hunks.push({ baseStart, baseEnd, lines: hunkLines });
  }
  return hunks;
}
function haveOverlap(hunksA, hunksB) {
  for (const a of hunksA) {
    for (const b of hunksB) {
      const aStart = a.baseStart;
      const aEnd = a.baseEnd;
      const bStart = b.baseStart;
      const bEnd = b.baseEnd;
      if (aStart === aEnd && bStart === bEnd) {
        if (aStart === bStart) return true;
        continue;
      }
      if (aStart < bEnd && bStart < aEnd) return true;
      if (aStart === aEnd && aStart > bStart && aStart < bEnd) return true;
      if (bStart === bEnd && bStart > aStart && bStart < aEnd) return true;
    }
  }
  return false;
}
function applyHunks(baseLines, hunks) {
  const result = baseLines.slice();
  const sorted = hunks.slice().sort((a, b) => b.baseStart - a.baseStart);
  for (const hunk of sorted) {
    result.splice(hunk.baseStart, hunk.baseEnd - hunk.baseStart, ...hunk.lines);
  }
  return result;
}
function mergeHunks(baseLines, localHunks, remoteHunks) {
  const all = [...localHunks];
  for (const rh of remoteHunks) {
    const duplicate = localHunks.some(
      (lh) => lh.baseStart === rh.baseStart && lh.baseEnd === rh.baseEnd && lh.lines.join("\n") === rh.lines.join("\n")
    );
    if (!duplicate) all.push(rh);
  }
  return applyHunks(baseLines, all);
}
function textMerge(base, local, remote) {
  const { lines: baseLines } = splitLines(base);
  const { lines: localLines } = splitLines(local);
  const { lines: remoteLines, trailingNewline: remoteTrail } = splitLines(remote);
  const { trailingNewline: localTrail } = splitLines(local);
  const { trailingNewline: baseTrail } = splitLines(base);
  if (local === base || local == null && base == null) {
    return { merged: remote ?? "", autoMerged: true };
  }
  if (remote === base || remote == null && base == null) {
    return { merged: local ?? "", autoMerged: true };
  }
  if (local === remote) {
    return { merged: local, autoMerged: true };
  }
  const localHunks = computeHunks(baseLines, localLines);
  const remoteHunks = computeHunks(baseLines, remoteLines);
  if (haveOverlap(localHunks, remoteHunks)) {
    return { merged: null, autoMerged: false };
  }
  const mergedLines = mergeHunks(baseLines, localHunks, remoteHunks);
  const trailingNewline = localTrail || remoteTrail || baseTrail;
  const merged = mergedLines.join("\n") + (trailingNewline ? "\n" : "");
  return { merged, autoMerged: true };
}

// ../core/merge.js
function merge2(base, local, remote) {
  const localDoc = local.doc ?? {};
  const remoteDoc = remote.doc ?? {};
  const localRevs = local.fieldRevs ?? {};
  const remoteRevs = remote.fieldRevs ?? {};
  const baseDoc = base ?? {};
  const allFields = /* @__PURE__ */ new Set([
    ...Object.keys(localDoc),
    ...Object.keys(remoteDoc),
    ...Object.keys(baseDoc)
  ]);
  const merged = {};
  const conflicts = [];
  for (const field of allFields) {
    if (field.startsWith("_")) continue;
    const baseVal = baseDoc[field];
    const localVal = localDoc[field];
    const remoteVal = remoteDoc[field];
    const localChanged = localVal !== baseVal;
    const remoteChanged = remoteVal !== baseVal;
    if (!localChanged && !remoteChanged) {
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
    const localRev = localRevs[field] ?? hlc_default.zero();
    const remoteRev = remoteRevs[field] ?? hlc_default.zero();
    if (typeof localVal === "string" && typeof remoteVal === "string") {
      const baseStr = typeof baseVal === "string" ? baseVal : "";
      const { merged: autoMergedText, autoMerged } = textMerge(baseStr, localVal, remoteVal);
      if (autoMerged) {
        merged[field] = autoMergedText;
        conflicts.push({
          field,
          localRev,
          remoteRev,
          localValue: localVal,
          remoteValue: remoteVal,
          winner: "auto-merged",
          winnerValue: autoMergedText,
          mergeStrategy: "text-auto-merged"
        });
        continue;
      }
    }
    const winner = hlc_default.compare(localRev, remoteRev) >= 0 ? "local" : "remote";
    const winnerValue = winner === "local" ? localVal : remoteVal;
    merged[field] = winnerValue;
    conflicts.push({
      field,
      localRev,
      remoteRev,
      localValue: localVal,
      remoteValue: remoteVal,
      winner,
      winnerValue
    });
  }
  return { merged, conflicts };
}

// SyncClientAdapter.js
var SyncClientAdapter = class {
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
    this.documentStore = syncDocumentStore;
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
   * @param {string} docId
   * @param {string} dotPath — e.g. 'days.2026-03-28.tl'
   */
  markEdited(docId, dotPath) {
    const rawRev = localStorage.getItem(this._revKey(docId));
    const revs = rawRev ? JSON.parse(rawRev) : {};
    const syncRaw = localStorage.getItem(this._syncKey(docId));
    const baseClock = syncRaw || hlc_default.zero();
    const existing = revs[dotPath] || baseClock;
    revs[dotPath] = hlc_default.tick(existing, Date.now());
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
    const changes = [];
    let maxClientClock = hlc_default.zero();
    for (const { uuid, doc } of syncableDocs) {
      const clientClock = localStorage.getItem(this._syncKey(uuid)) || hlc_default.zero();
      const fieldRevs = JSON.parse(localStorage.getItem(this._revKey(uuid)) ?? "{}");
      if (hlc_default.compare(clientClock, maxClientClock) > 0) {
        maxClientClock = clientClock;
      }
      changes.push({ key: uuid, doc, fieldRevs, baseClock: clientClock });
    }
    const payload = {
      collection: this.collection,
      clientClock: maxClientClock,
      changes
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
    const localDocMap = new Map(syncableDocs.map(({ uuid, doc }) => [uuid, doc]));
    const results = {};
    for (const serverChange of serverChanges) {
      const { _key, _rev, _fieldRevs, ...serverDoc } = serverChange;
      if (localDocMap.has(_key)) {
        const localDoc = localDocMap.get(_key);
        const base = JSON.parse(localStorage.getItem(this._baseKey(_key)) ?? "{}");
        const fieldRevs = JSON.parse(localStorage.getItem(this._revKey(_key)) ?? "{}");
        const result = merge2(
          base,
          { doc: localDoc, fieldRevs },
          { doc: serverDoc, fieldRevs: _fieldRevs ?? {} }
        );
        results[_key] = result.merged;
      } else {
        this.syncDocumentStore.set(_key, serverDoc);
      }
    }
    for (const { uuid } of syncableDocs) {
      localStorage.setItem(this._syncKey(uuid), serverClock);
      const merged = results[uuid] || localDocMap.get(uuid);
      localStorage.setItem(this._baseKey(uuid), JSON.stringify(merged));
      localStorage.setItem(this._revKey(uuid), "{}");
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
};

// SyncDocumentStore.js
var SyncDocumentStore = class {
  constructor({ namespace } = {}) {
    this._store = new DocumentStore({ namespace });
  }
  get(uuid) {
    return this._store.get(uuid);
  }
  set(uuid, doc) {
    this._store.set(uuid, doc);
  }
  delete(uuid) {
    this._store.delete(uuid);
  }
  list() {
    return this._store.list();
  }
  find(predicate) {
    return this._store.find(predicate);
  }
  listSyncable(userId) {
    return this._store.list().filter(({ doc }) => doc.meta?.userKey === userId);
  }
  listLocal() {
    return this._store.list();
  }
  takeOwnership(uuid, userId) {
    const doc = this._store.get(uuid);
    if (!doc) return;
    doc.meta = { ...doc.meta, userKey: userId };
    this._store.set(uuid, doc);
  }
};
export {
  DocumentStore,
  HttpClient,
  SyncClientAdapter,
  SyncDocumentStore
};
