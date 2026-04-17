# jsmdma Client SDK — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create two new ESM packages — `@alt-javascript/jsmdma-client` (DocumentStore, SyncClientAdapter, HttpClient) and `@alt-javascript/jsmdma-auth-client` (DeviceSession, ClientAuthSession, IdentityStore, PreferencesStore, AuthProvider) — built and bundled for use in browser apps.

**Architecture:** Both packages live in the jsmdma monorepo under `packages/`. They follow the same pattern as `packages/core`: root-level `.js` files (no `src/`), Mocha + Chai tests, esbuild for bundling. No CDI — these are plain ES module classes consumed directly by browser apps. `jsmdma-client` wraps jsmdma-core's `SyncClient` with localStorage persistence. `jsmdma-auth-client` is entirely independent and handles browser-side identity management using `jose` for JWT decoding.

**Tech Stack:** ES modules, esbuild, Mocha + Chai, `@alt-javascript/jsmdma-core` (HLC, SyncClient), `jose` (JWT decode), `@alt-javascript/jsmdma-auth-core` (used in tests only for creating test JWTs)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/jsmdma-client/package.json` | Create | Package manifest, deps, build + test scripts |
| `packages/jsmdma-client/index.js` | Create | Public exports |
| `packages/jsmdma-client/DocumentStore.js` | Create | localStorage CRUD + migrations |
| `packages/jsmdma-client/HttpClient.js` | Create | fetchJSON + Bearer auth + rolling refresh |
| `packages/jsmdma-client/SyncClientAdapter.js` | Create | Wraps jsmdma-core SyncClient with localStorage persistence |
| `packages/jsmdma-client/test/DocumentStore.spec.js` | Create | TDD tests for DocumentStore |
| `packages/jsmdma-client/test/HttpClient.spec.js` | Create | TDD tests for HttpClient |
| `packages/jsmdma-client/test/SyncClientAdapter.spec.js` | Create | TDD tests for SyncClientAdapter |
| `packages/jsmdma-auth-client/package.json` | Create | Package manifest, deps |
| `packages/jsmdma-auth-client/index.js` | Create | Public exports |
| `packages/jsmdma-auth-client/DeviceSession.js` | Create | Stable anon UUID management |
| `packages/jsmdma-auth-client/ClientAuthSession.js` | Create | JWT storage + TTL validation |
| `packages/jsmdma-auth-client/IdentityStore.js` | Create | Identity list persistence |
| `packages/jsmdma-auth-client/PreferencesStore.js` | Create | Per-user preferences persistence |
| `packages/jsmdma-auth-client/AuthProvider.js` | Create | OAuth redirect flow |
| `packages/jsmdma-auth-client/test/DeviceSession.spec.js` | Create | TDD tests |
| `packages/jsmdma-auth-client/test/ClientAuthSession.spec.js` | Create | TDD tests |
| `packages/jsmdma-auth-client/test/IdentityStore.spec.js` | Create | TDD tests |
| `packages/jsmdma-auth-client/test/PreferencesStore.spec.js` | Create | TDD tests |
| `packages/jsmdma-auth-client/test/AuthProvider.spec.js` | Create | TDD tests |

---

### Task 1: `jsmdma-client` package scaffold

**Files:**
- Create: `packages/jsmdma-client/package.json`
- Create: `packages/jsmdma-client/index.js`

- [ ] **Step 1: Create `packages/jsmdma-client/package.json`**

```bash
mkdir -p /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-client/test
```

Create `packages/jsmdma-client/package.json`:

```json
{
  "name": "@alt-javascript/jsmdma-client",
  "version": "1.0.0",
  "description": "Browser-side offline-first document sync and HTTP client for jsmdma applications",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "scripts": {
    "build": "esbuild index.js --bundle --format=esm --outfile=dist/jsmdma-client.esm.js --external:@alt-javascript/jsmdma-core",
    "test": "mocha --recursive test/**/*.spec.js"
  },
  "dependencies": {
    "@alt-javascript/jsmdma-core": "*"
  },
  "devDependencies": {
    "chai": "^4.3.7",
    "esbuild": "^0.25.0",
    "mocha": "^11.7.5"
  },
  "license": "MIT",
  "author": "Craig Parravicini",
  "contributors": ["Claude (Anthropic)"],
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `packages/jsmdma-client/index.js` (empty stubs)**

```js
/**
 * index.js — Public exports for @alt-javascript/jsmdma-client
 */
export { default as DocumentStore }       from './DocumentStore.js';
export { default as HttpClient }          from './HttpClient.js';
export { default as SyncClientAdapter }   from './SyncClientAdapter.js';
```

- [ ] **Step 3: Verify the workspace sees the new package**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm install
node -e "import('@alt-javascript/jsmdma-client').then(m => console.log('OK', Object.keys(m)))"
```
Expected: `OK [ 'DocumentStore', 'HttpClient', 'SyncClientAdapter' ]` (will throw on actual classes until implemented — that's fine)

- [ ] **Step 4: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-client/
git commit -m "feat(jsmdma-client): scaffold package with empty exports"
```

---

### Task 2: `DocumentStore` — TDD

**Files:**
- Create: `packages/jsmdma-client/test/DocumentStore.spec.js`
- Create: `packages/jsmdma-client/DocumentStore.js`

- [ ] **Step 1: Write the failing test**

Create `packages/jsmdma-client/test/DocumentStore.spec.js`:

```js
/**
 * DocumentStore.spec.js — TDD tests for DocumentStore
 *
 * Uses a mock localStorage so tests run in Node without a browser.
 * Each test resets storage to a clean state.
 */
import { assert } from 'chai';
import DocumentStore from '../DocumentStore.js';

// ── mock localStorage ──────────────────────────────────────────────────────────
let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
  key:        (n) => Object.keys(_store)[n] ?? null,
  get length() { return Object.keys(_store).length; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => { mockStorage.clear(); });

// ── helpers ────────────────────────────────────────────────────────────────────
function makeStore(opts = {}) {
  return new DocumentStore({ namespace: 'test', ...opts });
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('DocumentStore', () => {
  it('set() and get() round-trip a document', () => {
    const store = makeStore();
    store.set('uuid-1', { name: 'Test', year: 2026 });
    const doc = store.get('uuid-1');
    assert.deepEqual(doc, { name: 'Test', year: 2026 });
  });

  it('get() returns null for unknown uuid', () => {
    const store = makeStore();
    assert.isNull(store.get('no-such-uuid'));
  });

  it('list() returns all documents', () => {
    const store = makeStore();
    store.set('a', { x: 1 });
    store.set('b', { x: 2 });
    const list = store.list();
    assert.lengthOf(list, 2);
    const uuids = list.map(e => e.uuid).sort();
    assert.deepEqual(uuids, ['a', 'b']);
    const docs = list.map(e => e.doc);
    assert.ok(docs.find(d => d.x === 1));
    assert.ok(docs.find(d => d.x === 2));
  });

  it('list() returns empty array when store is empty', () => {
    const store = makeStore();
    assert.deepEqual(store.list(), []);
  });

  it('find() returns the first matching document', () => {
    const store = makeStore();
    store.set('x1', { type: 'a', val: 1 });
    store.set('x2', { type: 'b', val: 2 });
    store.set('x3', { type: 'a', val: 3 });
    const result = store.find(doc => doc.type === 'a');
    assert.equal(result.doc.type, 'a');
    assert.ok(['x1', 'x3'].includes(result.uuid));
  });

  it('find() returns null when no document matches', () => {
    const store = makeStore();
    store.set('x1', { type: 'a' });
    assert.isNull(store.find(doc => doc.type === 'z'));
  });

  it('delete() removes the document', () => {
    const store = makeStore();
    store.set('del-me', { v: 1 });
    store.delete('del-me');
    assert.isNull(store.get('del-me'));
    assert.lengthOf(store.list(), 0);
  });

  it('namespaces are isolated — two stores with different namespaces do not share docs', () => {
    const storeA = new DocumentStore({ namespace: 'alpha' });
    const storeB = new DocumentStore({ namespace: 'beta' });
    storeA.set('shared-key', { from: 'alpha' });
    assert.isNull(storeB.get('shared-key'));
  });

  it('migrate() applies a registered migration once and updates migration_version', () => {
    // Register a migration that adds a default field
    DocumentStore.registerMigration('test', 1, (docs) =>
      docs.map(({ uuid, doc }) => ({ uuid, doc: { ...doc, migrated: true } }))
    );

    const store = makeStore();
    store.set('m1', { name: 'Before' });
    store.migrate();

    const doc = store.get('m1');
    assert.equal(doc.migrated, true);
    // Version stored in localStorage
    assert.equal(mockStorage.getItem('test:migration_version'), '1');
  });

  it('migrate() does NOT re-apply a migration that was already applied', () => {
    // Version already at 1
    mockStorage.setItem('test:migration_version', '1');
    let callCount = 0;
    DocumentStore.registerMigration('test', 1, (docs) => {
      callCount++;
      return docs;
    });
    const store = makeStore();
    store.set('x', { val: 42 });
    store.migrate();
    assert.equal(callCount, 0);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "Error|Cannot find|passing|failing"
```
Expected: Error about missing `DocumentStore.js`

- [ ] **Step 3: Create `DocumentStore.js`**

Create `packages/jsmdma-client/DocumentStore.js`:

```js
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
   * @param {{ namespace: string, migrations?: Array }} options
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
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: `9 passing`

- [ ] **Step 5: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-client/DocumentStore.js \
        packages/jsmdma-client/test/DocumentStore.spec.js
git commit -m "feat(jsmdma-client): add DocumentStore with localStorage CRUD and migrations"
```

---

### Task 3: `HttpClient` — TDD

**Files:**
- Create: `packages/jsmdma-client/test/HttpClient.spec.js`
- Create: `packages/jsmdma-client/HttpClient.js`

- [ ] **Step 1: Write the failing test**

Create `packages/jsmdma-client/test/HttpClient.spec.js`:

```js
/**
 * HttpClient.spec.js — TDD tests for HttpClient
 *
 * Mocks global.fetch for all tests.
 */
import { assert } from 'chai';
import HttpClient from '../HttpClient.js';

// ── helpers ────────────────────────────────────────────────────────────────────
function makeClient(overrides = {}) {
  return new HttpClient({
    getToken: () => 'test-token-abc',
    onTokenRefresh: () => {},
    ...overrides,
  });
}

function mockFetch(status, body, headers = {}) {
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('HttpClient', () => {
  afterEach(() => { delete global.fetch; });

  it('fetchJSON injects Authorization Bearer header', async () => {
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.fetchJSON('http://example.com/api');
    assert.equal(capturedHeaders['Authorization'], 'Bearer test-token-abc');
  });

  it('fetchJSON does not inject Authorization when getToken returns null', async () => {
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true, status: 200,
        json: async () => ({}),
        headers: { get: () => null },
      };
    };

    const client = makeClient({ getToken: () => null });
    await client.fetchJSON('http://example.com/api');
    assert.isUndefined(capturedHeaders['Authorization']);
  });

  it('fetchJSON returns parsed JSON body on 2xx', async () => {
    mockFetch(200, { result: 'hello' });
    const client = makeClient();
    const data = await client.fetchJSON('http://example.com/api');
    assert.deepEqual(data, { result: 'hello' });
  });

  it('fetchJSON throws with err.status on non-2xx', async () => {
    mockFetch(401, { error: 'unauthorized' });
    const client = makeClient();
    try {
      await client.fetchJSON('http://example.com/api');
      assert.fail('expected error');
    } catch (err) {
      assert.equal(err.status, 401);
    }
  });

  it('fetchJSON calls onTokenRefresh when X-Auth-Token header is present', async () => {
    let refreshedToken = null;
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true }),
      headers: { get: (name) => name.toLowerCase() === 'x-auth-token' ? 'new-token-xyz' : null },
    });

    const client = makeClient({ onTokenRefresh: (t) => { refreshedToken = t; } });
    await client.fetchJSON('http://example.com/api');
    assert.equal(refreshedToken, 'new-token-xyz');
  });

  it('post() sends method POST with JSON body', async () => {
    let capturedMethod = null;
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      capturedBody = opts.body;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.post('http://example.com/api', { key: 'val' });
    assert.equal(capturedMethod, 'POST');
    assert.deepEqual(JSON.parse(capturedBody), { key: 'val' });
  });

  it('delete() sends method DELETE', async () => {
    let capturedMethod = null;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      return {
        ok: true, status: 200,
        json: async () => ({}),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.delete('http://example.com/api/item');
    assert.equal(capturedMethod, 'DELETE');
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: Error about missing `HttpClient.js`

- [ ] **Step 3: Create `HttpClient.js`**

Create `packages/jsmdma-client/HttpClient.js`:

```js
/**
 * HttpClient.js — Shared fetch wrapper with Bearer token injection and rolling refresh.
 *
 * Replaces the duplicated fetchJSON helpers in year-planner's SyncClient.js and Api.js.
 *
 * On every request:
 *   - Injects `Authorization: Bearer <token>` if getToken() returns a non-null string
 *   - After every successful response: checks for X-Auth-Token header; if present,
 *     calls onTokenRefresh(newToken) so the caller can store the refreshed JWT
 *
 * On non-2xx:
 *   - Throws Error with err.status set to the HTTP status code
 */
export default class HttpClient {
  /**
   * @param {{ getToken: () => string|null, onTokenRefresh: (token: string) => void }} options
   */
  constructor({ getToken, onTokenRefresh } = {}) {
    this.getToken = getToken ?? (() => null);
    this.onTokenRefresh = onTokenRefresh ?? (() => {});
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
      Accept: 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    const response = await fetch(url, { ...options, headers });

    // Rolling refresh — store new token transparently
    const newToken = response.headers.get('X-Auth-Token');
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
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE request to url.
   * @param {string} url
   * @returns {Promise<object>}
   */
  async delete(url) {
    return this.fetchJSON(url, { method: 'DELETE' });
  }
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "passing|failing"
```
Expected: `16 passing` (9 DocumentStore + 7 HttpClient)

- [ ] **Step 5: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-client/HttpClient.js \
        packages/jsmdma-client/test/HttpClient.spec.js
git commit -m "feat(jsmdma-client): add HttpClient with Bearer auth and rolling refresh"
```

---

### Task 4: `SyncClientAdapter` — TDD

**Files:**
- Create: `packages/jsmdma-client/test/SyncClientAdapter.spec.js`
- Create: `packages/jsmdma-client/SyncClientAdapter.js`

The `SyncClientAdapter` wraps `jsmdma-core/SyncClient` with localStorage persistence. It replicates year-planner's `SyncClient.js` generically. Key behaviors:

- `markEdited(docId, dotPath)` — ticks HLC from the stored sync clock, writes field rev to `rev:<docId>`
- `sync(docId, doc, authHeaders, syncUrl, collection)` — reads clock/revs/base from localStorage, POSTs `{ collection, clientClock, changes: [{ key, doc, fieldRevs, baseClock }] }`, applies merge, persists result
- `prune(docId)` — removes `rev:`, `base:`, `sync:` keys for docId
- `pruneAll()` — calls prune for every uuid in the associated DocumentStore

**Note on constructor:** The spec shows `options: { clockKey, revKey, baseKey }`. An additional `collection` option is required to populate the payload `collection` field (e.g. `'planners'`). Default is `'documents'`.

- [ ] **Step 1: Write the failing test**

Create `packages/jsmdma-client/test/SyncClientAdapter.spec.js`:

```js
/**
 * SyncClientAdapter.spec.js — TDD tests for SyncClientAdapter
 */
import { assert } from 'chai';
import DocumentStore from '../DocumentStore.js';
import SyncClientAdapter from '../SyncClientAdapter.js';
import HLC from '@alt-javascript/jsmdma-core/hlc.js';

// ── mock localStorage ──────────────────────────────────────────────────────────
let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
  key:        (n) => Object.keys(_store)[n] ?? null,
  get length() { return Object.keys(_store).length; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => {
  mockStorage.clear();
  delete global.fetch;
});

const DOC_ID  = 'plan-uuid-1';
const SYNC_URL = 'http://127.0.0.1:8081/year-planner/sync';
const AUTH_HDR = { Authorization: 'Bearer test-jwt' };

function makeAdapter(collection = 'planners') {
  const store = new DocumentStore({ namespace: 'plnr' });
  return { store, adapter: new SyncClientAdapter(store, { collection }) };
}

function mockSyncResponse(serverChanges = [], serverClock = null) {
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        serverClock: serverClock ?? HLC.tick(HLC.zero(), Date.now()),
        serverChanges,
        conflicts: [],
      }),
      headers: { get: () => null },
    };
  };
  return () => capturedBody;
}

describe('SyncClientAdapter', () => {
  describe('markEdited()', () => {
    it('stores an HLC timestamp for the given dotPath', () => {
      const { adapter } = makeAdapter();
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const revs = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`));
      assert.property(revs, 'days.2026-03-28.tl');
      assert.isString(revs['days.2026-03-28.tl']);
    });

    it('second markEdited produces a strictly later clock than the first', () => {
      const { adapter } = makeAdapter();
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const first = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`))['days.2026-03-28.tl'];
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const second = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`))['days.2026-03-28.tl'];
      assert.equal(HLC.compare(first, second), -1, 'second clock must be > first');
    });
  });

  describe('sync()', () => {
    it('sends correct jsmdma payload shape', async () => {
      const { store, adapter } = makeAdapter();
      const doc = { meta: { year: 2026 }, days: {} };
      store.set(DOC_ID, doc);
      const getBody = mockSyncResponse();

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);

      const body = getBody();
      assert.equal(body.collection, 'planners');
      assert.isString(body.clientClock);
      assert.isArray(body.changes);
      assert.lengthOf(body.changes, 1);
      assert.equal(body.changes[0].key, DOC_ID);
      assert.deepEqual(body.changes[0].doc, doc);
      assert.isObject(body.changes[0].fieldRevs);
      assert.isString(body.changes[0].baseClock);
    });

    it('sends Authorization header from authHeaders', async () => {
      const { store, adapter } = makeAdapter();
      const doc = {};
      store.set(DOC_ID, doc);
      let capturedHeaders = null;
      global.fetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true, status: 200,
          json: async () => ({ serverClock: HLC.zero(), serverChanges: [], conflicts: [] }),
          headers: { get: () => null },
        };
      };

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);
      assert.equal(capturedHeaders['Authorization'], 'Bearer test-jwt');
    });

    it('persists sync clock, base snapshot after successful sync', async () => {
      const { store, adapter } = makeAdapter();
      const doc = { days: { '2026-01-01': { tp: 1 } } };
      store.set(DOC_ID, doc);
      const serverClock = HLC.tick(HLC.zero(), Date.now());
      mockSyncResponse([], serverClock);

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);

      assert.equal(mockStorage.getItem(`sync:${DOC_ID}`), serverClock);
      const base = JSON.parse(mockStorage.getItem(`base:${DOC_ID}`));
      assert.deepEqual(base, doc);
    });

    it('stores a foreign document received from the server via DocumentStore.set()', async () => {
      const { store, adapter } = makeAdapter();
      const ownDoc = { meta: { year: 2026, uid: 'user-1' }, days: {} };
      const foreignKey = 'foreign-planner-uuid';
      const foreignDoc = { meta: { year: 2026, uid: 'user-1' }, days: { '2026-05-01': { tp: 2 } } };
      store.set(DOC_ID, ownDoc);

      const serverClock = HLC.tick(HLC.zero(), Date.now());
      mockSyncResponse([{ _key: foreignKey, _rev: 1, _fieldRevs: {}, ...foreignDoc }], serverClock);

      await adapter.sync(DOC_ID, ownDoc, AUTH_HDR, SYNC_URL);

      // Foreign document stored in DocumentStore
      const stored = store.get(foreignKey);
      assert.deepEqual(stored.meta, foreignDoc.meta);
      assert.deepEqual(stored.days, foreignDoc.days);
    });

    it('throws with err.status on HTTP error', async () => {
      const { store, adapter } = makeAdapter();
      store.set(DOC_ID, {});
      global.fetch = async () => ({
        ok: false, status: 401,
        json: async () => ({ error: 'unauthorized' }),
        headers: { get: () => null },
      });

      try {
        await adapter.sync(DOC_ID, {}, AUTH_HDR, SYNC_URL);
        assert.fail('expected error');
      } catch (err) {
        assert.equal(err.status, 401);
      }
    });
  });

  describe('prune()', () => {
    it('removes rev:, base:, sync: keys for the docId', () => {
      const { adapter } = makeAdapter();
      mockStorage.setItem(`rev:${DOC_ID}`,  JSON.stringify({ 'a.b': 'clock' }));
      mockStorage.setItem(`base:${DOC_ID}`, JSON.stringify({ x: 1 }));
      mockStorage.setItem(`sync:${DOC_ID}`, 'some-clock');

      adapter.prune(DOC_ID);

      assert.isNull(mockStorage.getItem(`rev:${DOC_ID}`));
      assert.isNull(mockStorage.getItem(`base:${DOC_ID}`));
      assert.isNull(mockStorage.getItem(`sync:${DOC_ID}`));
    });
  });

  describe('pruneAll()', () => {
    it('prunes sync state for every document in the DocumentStore', () => {
      const { store, adapter } = makeAdapter();
      store.set('uuid-a', { val: 1 });
      store.set('uuid-b', { val: 2 });
      mockStorage.setItem('rev:uuid-a',  '{}');
      mockStorage.setItem('sync:uuid-a', 'clock-a');
      mockStorage.setItem('rev:uuid-b',  '{}');
      mockStorage.setItem('sync:uuid-b', 'clock-b');

      adapter.pruneAll();

      assert.isNull(mockStorage.getItem('rev:uuid-a'));
      assert.isNull(mockStorage.getItem('sync:uuid-a'));
      assert.isNull(mockStorage.getItem('rev:uuid-b'));
      assert.isNull(mockStorage.getItem('sync:uuid-b'));
    });
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: Error about missing `SyncClientAdapter.js`

- [ ] **Step 3: Create `SyncClientAdapter.js`**

Create `packages/jsmdma-client/SyncClientAdapter.js`:

```js
/**
 * SyncClientAdapter.js — localStorage-backed sync state management.
 *
 * Wraps the jsmdma HLC-based sync protocol with browser localStorage persistence.
 * Replicates year-planner's SyncClient.js generically so any app can use it.
 *
 * localStorage key patterns (configurable via options):
 *   sync:<uuid>  — last server HLC clock (string)
 *   rev:<uuid>   — fieldRevs map { 'days.2026-03-28.tl': '<hlcString>', ... }
 *   base:<uuid>  — base snapshot (last known server state, for 3-way merge)
 */
import HLC from '@alt-javascript/jsmdma-core/hlc.js';
import merge from '@alt-javascript/jsmdma-core/merge.js';

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

    // Check for rolling refresh token
    const newToken = response.headers.get('X-Auth-Token');
    if (newToken && this._onTokenRefresh) this._onTokenRefresh(newToken);

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
```

- [ ] **Step 4: Run all tests and confirm they pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-client 2>&1 | grep -E "passing|failing"
```
Expected: `~26 passing` (9 + 7 + at least 10 new)

- [ ] **Step 5: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-client/SyncClientAdapter.js \
        packages/jsmdma-client/test/SyncClientAdapter.spec.js
git commit -m "feat(jsmdma-client): add SyncClientAdapter with localStorage persistence"
```

---

### Task 5: Build `jsmdma-client` ESM bundle

**Files:**
- Modify: `packages/jsmdma-client/index.js` (already has exports — no change needed)

- [ ] **Step 1: Install esbuild for the package**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm install --workspace=packages/jsmdma-client
```

- [ ] **Step 2: Build the ESM bundle**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run build --workspace=packages/jsmdma-client
```
Expected: `dist/jsmdma-client.esm.js` created in `packages/jsmdma-client/dist/`

- [ ] **Step 3: Verify the bundle is under 30KB**

```bash
wc -c /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-client/dist/jsmdma-client.esm.js
```
Expected: under 30720 bytes (30KB)

- [ ] **Step 4: Verify the bundle exports the three classes**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
node -e "import('./packages/jsmdma-client/dist/jsmdma-client.esm.js').then(m => console.log(Object.keys(m)))"
```
Expected: `[ 'DocumentStore', 'HttpClient', 'SyncClientAdapter' ]`

- [ ] **Step 5: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-client/dist/
git commit -m "build(jsmdma-client): add ESM bundle"
```

---

### Task 6: `jsmdma-auth-client` package scaffold

**Files:**
- Create: `packages/jsmdma-auth-client/package.json`
- Create: `packages/jsmdma-auth-client/index.js`

- [ ] **Step 1: Create package directory and manifest**

```bash
mkdir -p /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-auth-client/test
```

Create `packages/jsmdma-auth-client/package.json`:

```json
{
  "name": "@alt-javascript/jsmdma-auth-client",
  "version": "1.0.0",
  "description": "Browser-side identity and session management for jsmdma applications",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "scripts": {
    "build": "esbuild index.js --bundle --format=esm --outfile=dist/jsmdma-auth-client.esm.js --external:jose",
    "test": "mocha --recursive test/**/*.spec.js"
  },
  "dependencies": {
    "jose": "^5.9.6"
  },
  "devDependencies": {
    "@alt-javascript/jsmdma-auth-core": "*",
    "chai": "^4.3.7",
    "esbuild": "^0.25.0",
    "mocha": "^11.7.5"
  },
  "license": "MIT",
  "author": "Craig Parravicini",
  "contributors": ["Claude (Anthropic)"],
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `packages/jsmdma-auth-client/index.js`**

```js
/**
 * index.js — Public exports for @alt-javascript/jsmdma-auth-client
 */
export { default as DeviceSession }       from './DeviceSession.js';
export { default as ClientAuthSession }   from './ClientAuthSession.js';
export { default as IdentityStore }       from './IdentityStore.js';
export { default as PreferencesStore }    from './PreferencesStore.js';
export { default as AuthProvider }        from './AuthProvider.js';
```

- [ ] **Step 3: Install dependencies**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm install
```

- [ ] **Step 4: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-auth-client/
git commit -m "feat(jsmdma-auth-client): scaffold package"
```

---

### Task 7: `DeviceSession` + `ClientAuthSession` — TDD

**Files:**
- Create: `packages/jsmdma-auth-client/DeviceSession.js`
- Create: `packages/jsmdma-auth-client/ClientAuthSession.js`
- Create: `packages/jsmdma-auth-client/test/DeviceSession.spec.js`
- Create: `packages/jsmdma-auth-client/test/ClientAuthSession.spec.js`

- [ ] **Step 1: Write `DeviceSession` tests**

Create `packages/jsmdma-auth-client/test/DeviceSession.spec.js`:

```js
import { assert } from 'chai';
import DeviceSession from '../DeviceSession.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => { mockStorage.clear(); });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('DeviceSession', () => {
  it('getDeviceId() creates and returns a UUID on first call', () => {
    const id = DeviceSession.getDeviceId();
    assert.match(id, UUID_RE);
  });

  it('getDeviceId() returns the same UUID on repeated calls', () => {
    const a = DeviceSession.getDeviceId();
    const b = DeviceSession.getDeviceId();
    assert.equal(a, b);
  });

  it('getOrCreateAnonUid() creates and returns a UUID', () => {
    const uid = DeviceSession.getOrCreateAnonUid();
    assert.match(uid, UUID_RE);
  });

  it('getOrCreateAnonUid() returns the same UUID on repeated calls', () => {
    const a = DeviceSession.getOrCreateAnonUid();
    const b = DeviceSession.getOrCreateAnonUid();
    assert.equal(a, b);
  });

  it('clear() removes dev and anon_uid from localStorage', () => {
    DeviceSession.getDeviceId();
    DeviceSession.getOrCreateAnonUid();
    DeviceSession.clear();
    assert.isNull(mockStorage.getItem('dev'));
    assert.isNull(mockStorage.getItem('anon_uid'));
  });
});
```

- [ ] **Step 2: Write `ClientAuthSession` tests**

Create `packages/jsmdma-auth-client/test/ClientAuthSession.spec.js`:

```js
import { assert } from 'chai';
import ClientAuthSession from '../ClientAuthSession.js';
import JwtSession from '@alt-javascript/jsmdma-auth-core/JwtSession.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => { mockStorage.clear(); });

const TEST_SECRET = 'client-auth-session-test-secret-32';

async function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return JwtSession.sign(
    { sub: 'user-uuid-abc', providers: ['google'], email: 'test@example.com', ...overrides },
    TEST_SECRET,
    { iatSession: overrides.iat_session ?? now },
  );
}

async function makeExpiredIdleToken() {
  // iat = 4 days ago, iat_session = 4 days ago — exceeds 3-day idle TTL
  const nowSec = Math.floor(Date.now() / 1000);
  const fourDaysAgo = nowSec - 4 * 24 * 60 * 60;
  // Must sign with past iat — use JwtSession.sign with iatSession override
  // but also forge the iat. We create the token manually using jose.
  const { SignJWT } = await import('jose');
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT({ sub: 'user-old', providers: ['google'], iat_session: fourDaysAgo })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(fourDaysAgo)
    .sign(secret);
}

describe('ClientAuthSession', () => {
  it('store() and getToken() round-trip the JWT', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.equal(ClientAuthSession.getToken(), token);
  });

  it('getToken() returns null when no token stored', () => {
    assert.isNull(ClientAuthSession.getToken());
  });

  it('getPayload() returns decoded payload with sub', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    const payload = ClientAuthSession.getPayload();
    assert.equal(payload.sub, 'user-uuid-abc');
    assert.deepEqual(payload.providers, ['google']);
  });

  it('isSignedIn() returns true when valid token present', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.isTrue(ClientAuthSession.isSignedIn());
  });

  it('isSignedIn() returns false when no token', () => {
    assert.isFalse(ClientAuthSession.isSignedIn());
  });

  it('getUserUuid() returns jwt.sub', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.equal(ClientAuthSession.getUserUuid(), 'user-uuid-abc');
  });

  it('getUserUuid() returns null when no token', () => {
    assert.isNull(ClientAuthSession.getUserUuid());
  });

  it('getToken() returns null for idle-expired token (iat > 3 days old)', async () => {
    const token = await makeExpiredIdleToken();
    ClientAuthSession.store(token);
    assert.isNull(ClientAuthSession.getToken());
  });

  it('clear() removes auth_token, auth_provider, auth_time', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    mockStorage.setItem('auth_provider', 'google');
    mockStorage.setItem('auth_time', String(Date.now()));
    ClientAuthSession.clear();
    assert.isNull(mockStorage.getItem('auth_token'));
    assert.isNull(mockStorage.getItem('auth_provider'));
    assert.isNull(mockStorage.getItem('auth_time'));
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: Error about missing implementation files.

- [ ] **Step 4: Create `DeviceSession.js`**

Create `packages/jsmdma-auth-client/DeviceSession.js`:

```js
/**
 * DeviceSession.js — Stable anonymous device UUID management.
 *
 * localStorage keys:
 *   dev      — stable device UUID (one per browser profile, never changes)
 *   anon_uid — anonymous user UUID (cleared on sign-out, recreated on next visit)
 */
export default class DeviceSession {
  /**
   * Returns the stable device UUID. Creates one if not present.
   * @returns {string}
   */
  static getDeviceId() {
    let id = localStorage.getItem('dev');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dev', id);
    }
    return id;
  }

  /**
   * Returns the anonymous user UUID. Creates one if not present.
   * @returns {string}
   */
  static getOrCreateAnonUid() {
    let uid = localStorage.getItem('anon_uid');
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem('anon_uid', uid);
    }
    return uid;
  }

  /**
   * Wipe device UUID and anon uid (call on full sign-out).
   */
  static clear() {
    localStorage.removeItem('dev');
    localStorage.removeItem('anon_uid');
  }
}
```

- [ ] **Step 5: Create `ClientAuthSession.js`**

Client-side JWT TTL validation decodes without signature verification (the server signed it; the client just reads the claims).

Create `packages/jsmdma-auth-client/ClientAuthSession.js`:

```js
/**
 * ClientAuthSession.js — JWT storage with client-side TTL validation.
 *
 * Does NOT verify the JWT signature (secret is server-only).
 * Decodes the payload and checks iat/iat_session against TTL rules.
 *
 * TTL rules (matching jsmdma-auth-server):
 *   Idle: 3 days from iat
 *   Hard: 7 days from iat_session
 *
 * localStorage keys: auth_token, auth_provider, auth_time
 */
import { decodeJwt } from 'jose';

const IDLE_TTL_SECONDS = 3 * 24 * 60 * 60;   // 3 days
const HARD_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 days

function isExpired(payload) {
  const now = Math.floor(Date.now() / 1000);
  const { iat, iat_session } = payload;
  if (typeof iat !== 'number' || typeof iat_session !== 'number') return true;
  if (now - iat > IDLE_TTL_SECONDS) return true;
  if (now - iat_session > HARD_TTL_SECONDS) return true;
  return false;
}

export default class ClientAuthSession {
  /**
   * Store a JWT in localStorage.
   * @param {string} token
   */
  static store(token) {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_time', String(Date.now()));
  }

  /**
   * Return the stored token, or null if absent or TTL-expired.
   * @returns {string|null}
   */
  static getToken() {
    const token = localStorage.getItem('auth_token');
    if (!token) return null;
    try {
      const payload = decodeJwt(token);
      if (isExpired(payload)) return null;
      return token;
    } catch {
      return null;
    }
  }

  /**
   * Return the decoded payload, or null if absent or expired.
   * @returns {object|null}
   */
  static getPayload() {
    const token = this.getToken();
    if (!token) return null;
    try { return decodeJwt(token); } catch { return null; }
  }

  /**
   * Return true if a valid, non-expired token is present.
   * @returns {boolean}
   */
  static isSignedIn() {
    return this.getToken() !== null;
  }

  /**
   * Return the stable internal UUID (jwt.sub), or null.
   * @returns {string|null}
   */
  static getUserUuid() {
    return this.getPayload()?.sub ?? null;
  }

  /**
   * Clear token and session state (call on sign-out).
   */
  static clear() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_provider');
    localStorage.removeItem('auth_time');
  }
}
```

- [ ] **Step 6: Run tests and confirm they pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing"
```
Expected: `14 passing` (5 DeviceSession + 9 ClientAuthSession)

- [ ] **Step 7: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-auth-client/DeviceSession.js \
        packages/jsmdma-auth-client/ClientAuthSession.js \
        packages/jsmdma-auth-client/test/DeviceSession.spec.js \
        packages/jsmdma-auth-client/test/ClientAuthSession.spec.js
git commit -m "feat(jsmdma-auth-client): add DeviceSession and ClientAuthSession with TTL validation"
```

---

### Task 8: `IdentityStore` + `PreferencesStore` — TDD

**Files:**
- Create: `packages/jsmdma-auth-client/IdentityStore.js`
- Create: `packages/jsmdma-auth-client/PreferencesStore.js`
- Create: `packages/jsmdma-auth-client/test/IdentityStore.spec.js`
- Create: `packages/jsmdma-auth-client/test/PreferencesStore.spec.js`

- [ ] **Step 1: Write tests**

Create `packages/jsmdma-auth-client/test/IdentityStore.spec.js`:

```js
import { assert } from 'chai';
import IdentityStore from '../IdentityStore.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => { mockStorage.clear(); });

describe('IdentityStore', () => {
  it('getAll() returns [] when empty', () => {
    assert.deepEqual(IdentityStore.getAll(), []);
  });

  it('upsert() adds a new identity', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'alice@example.com' });
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].uuid, 'u1');
  });

  it('upsert() updates an existing identity by uuid', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice Updated', provider: 'google', email: 'a@b.com' });
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].name, 'Alice Updated');
  });

  it('remove() deletes an identity by uuid', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.upsert({ uuid: 'u2', name: 'Bob', provider: 'apple', email: 'b@b.com' });
    IdentityStore.remove('u1');
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].uuid, 'u2');
  });

  it('clear() removes all identities', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.clear();
    assert.deepEqual(IdentityStore.getAll(), []);
  });
});
```

Create `packages/jsmdma-auth-client/test/PreferencesStore.spec.js`:

```js
import { assert } from 'chai';
import PreferencesStore from '../PreferencesStore.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};
before(() => { global.localStorage = mockStorage; });
afterEach(() => { mockStorage.clear(); });

describe('PreferencesStore', () => {
  const USER_UUID = 'user-prefs-uuid';

  it('get() returns {} for unknown user', () => {
    assert.deepEqual(PreferencesStore.get(USER_UUID), {});
  });

  it('set() writes preferences for a user', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink', dark: false });
    assert.deepEqual(PreferencesStore.get(USER_UUID), { theme: 'ink', dark: false });
  });

  it('set() merges with existing preferences (does not wipe)', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink', dark: false });
    PreferencesStore.set(USER_UUID, { lang: 'en' });
    const prefs = PreferencesStore.get(USER_UUID);
    assert.equal(prefs.theme, 'ink');
    assert.equal(prefs.dark, false);
    assert.equal(prefs.lang, 'en');
  });

  it('set() overwrites an existing key', () => {
    PreferencesStore.set(USER_UUID, { dark: false });
    PreferencesStore.set(USER_UUID, { dark: true });
    assert.equal(PreferencesStore.get(USER_UUID).dark, true);
  });

  it('clear() removes preferences for the user', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink' });
    PreferencesStore.clear(USER_UUID);
    assert.deepEqual(PreferencesStore.get(USER_UUID), {});
  });

  it('different users have isolated preferences', () => {
    PreferencesStore.set('user-a', { theme: 'ink' });
    PreferencesStore.set('user-b', { theme: 'crisp' });
    assert.equal(PreferencesStore.get('user-a').theme, 'ink');
    assert.equal(PreferencesStore.get('user-b').theme, 'crisp');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: Error about missing IdentityStore/PreferencesStore

- [ ] **Step 3: Create `IdentityStore.js`**

Create `packages/jsmdma-auth-client/IdentityStore.js`:

```js
/**
 * IdentityStore.js — Persistent list of user identities.
 *
 * localStorage key: ids
 * Format: JSON array of { uuid, name, provider, email }
 */
export default class IdentityStore {
  static _key = 'ids';

  /** @returns {Array<{ uuid: string, name: string, provider: string, email: string }>} */
  static getAll() {
    try {
      return JSON.parse(localStorage.getItem(this._key) ?? '[]');
    } catch { return []; }
  }

  /**
   * Add or update an identity entry.
   * @param {{ uuid: string, name: string, provider: string, email: string }} identity
   */
  static upsert(identity) {
    const all = this.getAll();
    const idx = all.findIndex(i => i.uuid === identity.uuid);
    if (idx >= 0) all[idx] = identity;
    else all.push(identity);
    localStorage.setItem(this._key, JSON.stringify(all));
  }

  /**
   * Remove an identity by uuid.
   * @param {string} uuid
   */
  static remove(uuid) {
    const filtered = this.getAll().filter(i => i.uuid !== uuid);
    localStorage.setItem(this._key, JSON.stringify(filtered));
  }

  /** Clear all identities. */
  static clear() {
    localStorage.removeItem(this._key);
  }
}
```

- [ ] **Step 4: Create `PreferencesStore.js`**

Create `packages/jsmdma-auth-client/PreferencesStore.js`:

```js
/**
 * PreferencesStore.js — Per-user opaque key-value preferences.
 *
 * localStorage key pattern: prefs:<userUuid>
 * set() merges with existing preferences (shallow merge).
 */
export default class PreferencesStore {
  static _key(userUuid) { return `prefs:${userUuid}`; }

  /**
   * Return preferences object for a user. Returns {} if not set.
   * @param {string} userUuid
   * @returns {object}
   */
  static get(userUuid) {
    try {
      return JSON.parse(localStorage.getItem(this._key(userUuid)) ?? '{}');
    } catch { return {}; }
  }

  /**
   * Write preferences for a user (shallow merge with existing).
   * @param {string} userUuid
   * @param {object} prefs
   */
  static set(userUuid, prefs) {
    const existing = this.get(userUuid);
    localStorage.setItem(this._key(userUuid), JSON.stringify({ ...existing, ...prefs }));
  }

  /**
   * Clear preferences for a user.
   * @param {string} userUuid
   */
  static clear(userUuid) {
    localStorage.removeItem(this._key(userUuid));
  }
}
```

- [ ] **Step 5: Run tests and confirm all pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing"
```
Expected: `25 passing` (14 + 5 IdentityStore + 6 PreferencesStore)

- [ ] **Step 6: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-auth-client/IdentityStore.js \
        packages/jsmdma-auth-client/PreferencesStore.js \
        packages/jsmdma-auth-client/test/IdentityStore.spec.js \
        packages/jsmdma-auth-client/test/PreferencesStore.spec.js
git commit -m "feat(jsmdma-auth-client): add IdentityStore and PreferencesStore"
```

---

### Task 9: `AuthProvider` — TDD

**Files:**
- Create: `packages/jsmdma-auth-client/AuthProvider.js`
- Create: `packages/jsmdma-auth-client/test/AuthProvider.spec.js`

`AuthProvider` handles the redirect-based OAuth flow. `signIn(provider)` fetches the server's `/auth/:provider` endpoint, stores PKCE params in sessionStorage, and redirects `window.location.href`. Since the page navigates away, `signIn()` returns a never-resolving Promise.

- [ ] **Step 1: Write the failing test**

Create `packages/jsmdma-auth-client/test/AuthProvider.spec.js`:

```js
/**
 * AuthProvider.spec.js — TDD tests for AuthProvider
 *
 * Mocks global.fetch and window.location for redirect testing.
 */
import { assert } from 'chai';
import AuthProvider from '../AuthProvider.js';

// ── mock sessionStorage ────────────────────────────────────────────────────────
let _session = {};
const mockSessionStorage = {
  getItem:    (k) => _session[k] ?? null,
  setItem:    (k, v) => { _session[k] = String(v); },
  removeItem: (k) => { delete _session[k]; },
  clear:      () => { _session = {}; },
};
before(() => { global.sessionStorage = mockSessionStorage; });
afterEach(() => {
  mockSessionStorage.clear();
  delete global.fetch;
  delete global.window;
});

const CONFIG = {
  google: { clientId: 'test-google-client-id' },
  apiUrl: 'http://127.0.0.1:8081/',
};

function makeProvider(cfg = CONFIG) {
  return new AuthProvider(cfg);
}

describe('AuthProvider', () => {
  it('getAvailableProviders() returns configured providers', () => {
    const p = makeProvider({ google: { clientId: 'id' }, microsoft: { clientId: 'msid' }, apiUrl: 'http://x/' });
    const providers = p.getAvailableProviders();
    assert.include(providers, 'google');
    assert.include(providers, 'microsoft');
  });

  it('getAvailableProviders() excludes non-provider config keys (apiUrl)', () => {
    const p = makeProvider();
    const providers = p.getAvailableProviders();
    assert.notInclude(providers, 'apiUrl');
  });

  it('isConfigured() returns true when at least one provider is set', () => {
    const p = makeProvider();
    assert.isTrue(p.isConfigured());
  });

  it('isConfigured() returns false when no providers configured', () => {
    const p = makeProvider({ apiUrl: 'http://x/' });
    assert.isFalse(p.isConfigured());
  });

  it('signIn() fetches /auth/:provider and stores PKCE params in sessionStorage', async () => {
    let fetchedUrl = null;
    global.fetch = async (url) => {
      fetchedUrl = url;
      return {
        ok: true, status: 200,
        json: async () => ({
          authorizationURL: 'https://accounts.google.com/o/oauth2/auth?state=s1',
          state: 's1',
          codeVerifier: 'cv-abc123',
        }),
      };
    };

    // Mock window.location to capture the redirect without actually navigating
    let redirectedTo = null;
    global.window = { location: {} };
    Object.defineProperty(global.window.location, 'href', {
      set: (v) => { redirectedTo = v; },
      configurable: true,
    });

    const p = makeProvider();
    // signIn returns a never-resolving promise (page navigates away) — set a race timeout
    await Promise.race([
      p.signIn('google').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 50)),
    ]);

    assert.include(fetchedUrl, '/auth/google');
    assert.equal(mockSessionStorage.getItem('oauth_state'), 's1');
    assert.equal(mockSessionStorage.getItem('oauth_code_verifier'), 'cv-abc123');
    assert.include(redirectedTo, 'accounts.google.com');
  });

  it('signIn() throws if provider is not configured', async () => {
    const p = makeProvider();
    try {
      await p.signIn('apple');
      assert.fail('expected error');
    } catch (err) {
      assert.include(err.message, 'apple');
    }
  });

  it('signIn() throws if server returns error', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const p = makeProvider();
    try {
      await p.signIn('google');
      assert.fail('expected error');
    } catch (err) {
      assert.ok(err.message);
    }
  });

  it('signOut() clears auth_token, auth_provider, auth_time', () => {
    let _ls = {};
    global.localStorage = {
      getItem:    k => _ls[k] ?? null,
      setItem:    (k, v) => { _ls[k] = v; },
      removeItem: k => { delete _ls[k]; },
    };
    _ls['auth_token']    = 'some-token';
    _ls['auth_provider'] = 'google';
    _ls['auth_time']     = '123';

    const p = makeProvider();
    p.signOut();

    assert.isUndefined(_ls['auth_token']);
    assert.isUndefined(_ls['auth_provider']);
    assert.isUndefined(_ls['auth_time']);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing|Error"
```
Expected: Error about missing `AuthProvider.js`

- [ ] **Step 3: Create `AuthProvider.js`**

Create `packages/jsmdma-auth-client/AuthProvider.js`:

```js
/**
 * AuthProvider.js — OAuth sign-in flows for jsmdma applications.
 *
 * Replaces year-planner's AuthProvider.js with a generic redirect-based flow
 * that works with the jsmdma auth server (Spec A).
 *
 * Sign-in flow:
 *   1. Client calls signIn('google')
 *   2. AuthProvider fetches GET {apiUrl}auth/google → { authorizationURL, state, codeVerifier }
 *   3. Stores state + codeVerifier in sessionStorage for the callback handler
 *   4. Sets window.location.href to authorizationURL → browser redirects to Google
 *   5. After OAuth callback, Application.js handles ?code=&state= and exchanges for JWT
 *
 * config keys: one entry per provider (google, apple, microsoft), plus `apiUrl`.
 */

const KNOWN_PROVIDERS = new Set(['google', 'apple', 'microsoft']);

export default class AuthProvider {
  /**
   * @param {{
   *   google?: { clientId: string },
   *   apple?: { clientId: string, redirectURI?: string },
   *   microsoft?: { clientId: string, authority?: string },
   *   apiUrl?: string,
   * }} config
   */
  constructor(config = {}) {
    this._config = config;
    this._apiUrl = config.apiUrl ?? 'http://127.0.0.1:8081/';
    if (!this._apiUrl.endsWith('/')) this._apiUrl += '/';
  }

  /**
   * Returns provider names that are configured.
   * Excludes non-provider config keys like `apiUrl`.
   * @returns {string[]}
   */
  getAvailableProviders() {
    return Object.keys(this._config).filter(k => KNOWN_PROVIDERS.has(k));
  }

  /**
   * Returns true if at least one provider is configured.
   * @returns {boolean}
   */
  isConfigured() {
    return this.getAvailableProviders().length > 0;
  }

  /**
   * Sign in with the named provider using the redirect flow.
   *
   * Fetches GET {apiUrl}auth/{provider} to begin OAuth, stores PKCE params in
   * sessionStorage, then redirects window.location.href to the authorization URL.
   *
   * This promise never resolves — the page navigates away.
   *
   * @param {string} provider — e.g. 'google'
   * @returns {Promise<never>}
   * @throws {Error} if provider not configured or server unreachable
   */
  async signIn(provider) {
    if (!this._config[provider]) {
      throw new Error(`AuthProvider: provider '${provider}' is not configured`);
    }

    const res = await fetch(`${this._apiUrl}auth/${provider}`);
    if (!res.ok) {
      throw new Error(`AuthProvider: server returned ${res.status} for /auth/${provider}`);
    }

    const { authorizationURL, state, codeVerifier } = await res.json();
    if (!authorizationURL) {
      throw new Error(`AuthProvider: no authorizationURL from server for provider '${provider}'`);
    }

    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier);

    window.location.href = authorizationURL;

    // This promise never resolves — the page navigates away.
    return new Promise(() => {});
  }

  /**
   * Clear stored auth credentials (call on sign-out).
   */
  signOut() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_provider');
    localStorage.removeItem('auth_time');
  }
}
```

- [ ] **Step 4: Run all tests and confirm they pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/jsmdma-auth-client 2>&1 | grep -E "passing|failing"
```
Expected: `32 passing` (25 + 7 new)

- [ ] **Step 5: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-auth-client/AuthProvider.js \
        packages/jsmdma-auth-client/test/AuthProvider.spec.js
git commit -m "feat(jsmdma-auth-client): add AuthProvider with redirect-based OAuth flow"
```

---

### Task 10: Build `jsmdma-auth-client` + copy vendor bundles to year-planner

**Files:**
- Build `dist/jsmdma-auth-client.esm.js`
- Copy both bundles to `site/js/vendor/` in year-planner

- [ ] **Step 1: Build the `jsmdma-auth-client` ESM bundle**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run build --workspace=packages/jsmdma-auth-client
```
Expected: `packages/jsmdma-auth-client/dist/jsmdma-auth-client.esm.js` created.

- [ ] **Step 2: Verify bundle size**

```bash
wc -c /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-auth-client/dist/jsmdma-auth-client.esm.js
```
Expected: under 30720 bytes (30KB)

- [ ] **Step 3: Verify bundle exports all five classes**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
node -e "import('./packages/jsmdma-auth-client/dist/jsmdma-auth-client.esm.js').then(m => console.log(Object.keys(m)))"
```
Expected: `[ 'DeviceSession', 'ClientAuthSession', 'IdentityStore', 'PreferencesStore', 'AuthProvider' ]`

- [ ] **Step 4: Copy both bundles to year-planner vendor**

```bash
mkdir -p /Users/craig/src/github/alt-html/year-planner/site/js/vendor/
cp /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-client/dist/jsmdma-client.esm.js \
   /Users/craig/src/github/alt-html/year-planner/site/js/vendor/jsmdma-client.esm.js

cp /Users/craig/src/github/alt-javascript/jsmdma/packages/jsmdma-auth-client/dist/jsmdma-auth-client.esm.js \
   /Users/craig/src/github/alt-html/year-planner/site/js/vendor/jsmdma-auth-client.esm.js
```

- [ ] **Step 5: Verify vendor files exist and are readable**

```bash
ls -lh /Users/craig/src/github/alt-html/year-planner/site/js/vendor/jsmdma-*.esm.js
```
Expected: two files listed with non-zero size.

- [ ] **Step 6: Commit both repos**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/jsmdma-auth-client/dist/ packages/jsmdma-client/dist/
git commit -m "build(jsmdma-auth-client): add ESM bundle"

cd /Users/craig/src/github/alt-html/year-planner
git add site/js/vendor/jsmdma-client.esm.js site/js/vendor/jsmdma-auth-client.esm.js
git commit -m "chore: vendor jsmdma-client and jsmdma-auth-client ESM bundles"
```

- [ ] **Step 7: Run full test suite to verify nothing regressed**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm test 2>&1 | tail -5
```
Expected: All packages report passing tests.

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `DocumentStore`: get/set/list/find/delete, migrations | Task 2 |
| `SyncClientAdapter`: markEdited, sync payload shape, foreign doc storage, prune/pruneAll | Task 4 |
| `HttpClient`: Bearer injection, X-Auth-Token refresh, non-2xx throws | Task 3 |
| `DeviceSession`: idempotent UUID, clear | Task 7 |
| `ClientAuthSession`: store/retrieve, idle TTL rejection, hard TTL rejection, rolling refresh window (getToken checks TTL), clear | Task 7 |
| `AuthProvider`: configured providers list, unconfigured excluded, signIn redirect flow | Task 9 |
| `IdentityStore`: upsert/get/remove/clear | Task 8 |
| `PreferencesStore`: set merges, get returns {}, clear removes key | Task 8 |
| ESM bundles < 30KB | Tasks 5, 10 |
| Zero year-planner-specific code in either package | All tasks (verified by no imports from year-planner namespace) |
| Bundles vendored in year-planner `site/js/vendor/` | Task 10 |
| `SyncClientAdapter.sync()` produces identical payload to year-planner's SyncClient.sync() | Task 4 — payload shape: `{ collection, clientClock, changes: [{ key, doc, fieldRevs, baseClock }] }` |
| `DocumentStore.migrate()` can transform legacy formats | Task 2 — migration API tested with version-tracked up() transforms |

### Spec deviations

1. **`SyncClientAdapter` constructor adds `collection` option** — The spec shows `options: { clockKey, revKey, baseKey }`. A `collection` option (default: `'documents'`) is added because the jsmdma sync payload requires a `collection` field in the POST body. Without it, the server rejects the request. Year-planner will pass `collection: 'planners'`.

2. **`ClientAuthSession` uses `decodeJwt` (no signature verification)** — Client-side cannot verify HS256 signatures without the server secret. `decodeJwt` from `jose` decodes the payload for TTL checking without verifying the signature. This is the correct pattern for browser clients.

3. **`AuthProvider.signIn()` window.location is accessed directly** — The spec doesn't prescribe how the redirect is made. Direct `window.location.href = url` is the standard browser redirect pattern.

### Type consistency

- `DocumentStore._key(uuid)` returns `<namespace>:<uuid>` — consistent in set/get/delete/list
- `SyncClientAdapter`: `_syncKey(docId)` → `sync:`, `_revKey(docId)` → `rev:`, `_baseKey(docId)` → `base:` — consistent with year-planner's storage-schema.js conventions
- `ClientAuthSession.store()` → `ClientAuthSession.getToken()` → `ClientAuthSession.getPayload()` chain is consistent
- `IdentityStore._key` is a static property, not a method — used as `this._key` throughout — consistent
- `PreferencesStore._key(userUuid)` is a method returning `prefs:<userUuid>` — consistent in get/set/clear
