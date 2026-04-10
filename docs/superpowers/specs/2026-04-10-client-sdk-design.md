# jsmdma Client SDK — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish two new client-side ESM packages — `jsmdma-client` and `jsmdma-auth-client` — that replace the duplicated, bespoke infrastructure in year-planner (and any future app) with a single well-tested platform SDK.

**Architecture:** Two focused packages with clean interfaces. `jsmdma-client` owns offline-first document sync (DocumentStore, SyncClientAdapter, HttpClient). `jsmdma-auth-client` owns identity and session (DeviceSession, ClientAuthSession, IdentityStore, PreferencesStore). Both build to ESM bundles consumable from CDN or vendored. Zero app-specific code in either.

**Tech Stack:** Vanilla ES modules, Rollup/esbuild for bundling, `@alt-javascript/jsmdma-core` (HLC, merge, SyncClient), `jose` for JWT parsing on the client side.

**Steering directive:** These packages are the reusable platform layer. They must contain nothing year-planner-specific. Any concept that appears in both year-planner and another hypothetical app belongs here.

---

## Package: `jsmdma-client`

### Responsibility
Offline-first document sync over localStorage. Wraps `jsmdma-core`'s pure sync logic with browser-side persistence.

### Classes

#### `DocumentStore`
Generic localStorage document CRUD. Replaces the ~200 lines of document management scattered through year-planner's `StorageLocal.js`.

```js
class DocumentStore {
  constructor(options)
  // options: { namespace: 'plnr', migrations: [...] }

  // Read a document by UUID. Returns null if not found.
  get(uuid): object | null

  // Write a document by UUID.
  set(uuid, doc): void

  // List all documents in this namespace. Returns [{ uuid, doc }].
  list(): Array<{ uuid, doc }>

  // Find first document matching a predicate over the doc.
  find(predicate): { uuid, doc } | null

  // Delete a document and its sync state.
  delete(uuid): void

  // Run registered migrations if not yet applied.
  migrate(): void

  // Register a migration: { version, up(docs) }
  // up() receives all current docs, returns transformed docs.
  // Applied once; version stored in localStorage under '<namespace>:migration_version'.
  static registerMigration(namespace, version, up): void
}
```

**localStorage key pattern:** `<namespace>:<uuid>` — e.g. `plnr:550e8400-...`

#### `SyncClientAdapter`
Wraps `jsmdma-core/SyncClient` with localStorage persistence for clock state, fieldRevs, and base snapshots. Replaces year-planner's `SyncClient.js` in its entirety.

```js
class SyncClientAdapter {
  constructor(documentStore, options)
  // options: { clockKey: 'sync', revKey: 'rev', baseKey: 'base' }

  // Tick HLC for a dot-path field on a document. Call on every user edit.
  // dotPath: e.g. 'days.2026-03-28.tl'
  markEdited(docId, dotPath): void

  // POST to syncUrl with jsmdma payload, apply 3-way merge, persist result.
  // Returns merged document. Throws with err.status on HTTP error.
  async sync(docId, doc, authHeaders, syncUrl): object

  // Remove all sync state for a document (call on deletion).
  prune(docId): void

  // Remove sync state for ALL documents in the store (call on full sign-out wipe).
  pruneAll(): void
}
```

**localStorage key pattern:** `sync:<uuid>`, `rev:<uuid>`, `base:<uuid>`

**Foreign document handling:** When `sync()` receives server changes for a UUID that is not `docId`, it stores the foreign document via `documentStore.set()` if not already present. This implements the new-device planner adoption pattern generically — the caller decides what to do with foreign documents.

#### `HttpClient`
Shared `fetchJSON` with Bearer token injection and rolling refresh header handling. Replaces the duplicated function in `SyncClient.js` and `Api.js`.

```js
class HttpClient {
  constructor(options)
  // options: { getToken: () => string | null, onTokenRefresh: (newToken) => void }

  // Fetch JSON with auth header injected. Handles X-Auth-Token rolling refresh.
  // Throws with err.status on non-2xx.
  async fetchJSON(url, options): object

  // Convenience: POST JSON body.
  async post(url, body): object

  // Convenience: DELETE.
  async delete(url): object
}
```

`onTokenRefresh` is called when the server returns `X-Auth-Token` — the client stores the new token transparently.

---

## Package: `jsmdma-auth-client`

### Responsibility
Browser-side identity and session management. Replaces year-planner's `AuthProvider.js`, session logic in `StorageLocal.js`, and bespoke `KEY_DEV`/`KEY_TOK`/`KEY_IDS`/`prefs:{uid}` storage.

### Classes

#### `DeviceSession`
Stable anonymous device UUID. Generated once on first visit, persists until explicit wipe.

```js
class DeviceSession {
  // Returns the stable device UUID. Creates one if not present.
  static getDeviceId(): string

  // Generate a new anonymous user UUID (call on first visit or after sign-out wipe).
  static getOrCreateAnonUid(): string

  // Wipe device UUID and anon uid (call on full sign-out).
  static clear(): void
}
```

**localStorage keys:** `dev` (device UUID), `anon_uid` (anonymous user UUID)

#### `ClientAuthSession`
JWT storage, TTL validation, rolling refresh. Replaces the bespoke session management in `StorageLocal.js`.

```js
class ClientAuthSession {
  // Store a JWT (call after successful sign-in or on X-Auth-Token refresh).
  static store(token): void

  // Return the stored token, or null if absent/expired.
  static getToken(): string | null

  // Return the decoded payload, or null if absent/expired.
  static getPayload(): object | null

  // Return true if a valid, non-expired token is present.
  static isSignedIn(): boolean

  // Return the stable internal UUID (jwt.sub), or null.
  static getUserUuid(): string | null

  // Clear token and session state (call on sign-out).
  static clear(): void
}
```

**TTL rules (matching jsmdma-auth-server):**
- Idle TTL: 3 days from `iat_session`
- Hard TTL: 7 days from `iat`

**localStorage keys:** `auth_token`, `auth_provider`, `auth_time`

#### `AuthProvider`
OAuth sign-in flows for Google, Microsoft, Apple. Replaces year-planner's `AuthProvider.js`. Lazy-loads provider SDKs.

```js
class AuthProvider {
  constructor(config)
  // config: { google: { clientId }, apple: { clientId, redirectURI }, microsoft: { clientId, authority } }

  // Returns ['google', 'apple', 'microsoft'] for configured providers.
  getAvailableProviders(): string[]

  // Returns true if at least one provider is configured.
  isConfigured(): boolean

  // Sign in with the named provider. Returns JWT string from server.
  // Throws on failure.
  async signIn(provider): string

  // Clear stored auth credentials.
  signOut(): void
}
```

**Design note:** `signIn()` completes the OAuth flow with the jsmdma auth server (Spec A) and receives a jsmdma JWT (not a raw provider id_token). The JWT is stored via `ClientAuthSession.store()`.

#### `IdentityStore`
Generic identity list (replacing year-planner's `KEY_IDS` / `identities` array).

```js
class IdentityStore {
  // Return all stored identities. Returns [].
  static getAll(): Array<{ uuid, name, provider, email }>

  // Add or update an identity entry.
  static upsert(identity): void

  // Remove an identity by uuid.
  static remove(uuid): void

  // Clear all identities.
  static clear(): void
}
```

**localStorage key:** `ids`

#### `PreferencesStore`
Generic opaque key-value preferences per user. Replaces `prefs:{uid}` in `StorageLocal.js`.

```js
class PreferencesStore {
  // Return preferences object for a user. Returns {}.
  static get(userUuid): object

  // Write preferences for a user (merges with existing).
  static set(userUuid, prefs): void

  // Clear preferences for a user.
  static clear(userUuid): void
}
```

**localStorage key:** `prefs:<userUuid>`

---

## Build Pipeline

Both packages use the same build pattern as `jsmdma-core`:

```
packages/
  jsmdma-client/
    src/          — source files
    dist/
      jsmdma-client.esm.js    — ESM bundle (tree-shaken)
      jsmdma-client.cjs.js    — CJS bundle (Node.js)
    package.json  — exports: { ".": { import: "./dist/jsmdma-client.esm.js" } }

  jsmdma-auth-client/
    src/
    dist/
      jsmdma-auth-client.esm.js
      jsmdma-auth-client.cjs.js
    package.json
```

**Bundler:** Rollup with `@rollup/plugin-node-resolve` (same as jsmdma-core).
**External dependencies:** `jose` for JWT parsing (no bundle bloat — consumed by apps that already have it, or bundled thin).

Year-planner vendors both bundles in `site/js/vendor/`:
```
site/js/vendor/
  data-api-core.esm.js           (existing, from jsmdma-core)
  jsmdma-client.esm.js           (new, from jsmdma-client)
  jsmdma-auth-client.esm.js      (new, from jsmdma-auth-client)
```

---

## What Year-Planner Removes When Consuming This SDK

| Removed from year-planner | Replaced by |
|---------------------------|-------------|
| `SyncClient.js` (190 lines) | `jsmdma-client/SyncClientAdapter` |
| `StorageLocal.js` document CRUD (~200 lines) | `jsmdma-client/DocumentStore` |
| `StorageLocal.js` session management (~60 lines) | `jsmdma-auth-client/ClientAuthSession` |
| `StorageLocal.js` identity storage (~40 lines) | `jsmdma-auth-client/IdentityStore` |
| `StorageLocal.js` preferences (~40 lines) | `jsmdma-auth-client/PreferencesStore` |
| `StorageLocal.getDevId()` | `jsmdma-auth-client/DeviceSession` |
| `AuthProvider.js` (184 lines) | `jsmdma-auth-client/AuthProvider` |
| `Api.js` fetchJSON + _authHeaders | `jsmdma-client/HttpClient` |
| Duplicate `fetchJSON` in SyncClient.js | `jsmdma-client/HttpClient` |
| `KEY_DEV`, `KEY_TOK`, `KEY_IDS` constants | Owned by `jsmdma-auth-client` |
| `keyRev`, `keyBase`, `keySync` constants | Owned by `jsmdma-client/SyncClientAdapter` |

---

## Testing

### `jsmdma-client`
- `DocumentStore`: get/set/list/find/delete, migration version tracking, migration up() transforms
- `SyncClientAdapter`: markEdited ticks HLC forward, sync sends correct payload shape, foreign document stored via DocumentStore, prune removes all keys
- `HttpClient`: Bearer token injected, X-Auth-Token triggers onTokenRefresh, non-2xx throws with err.status

### `jsmdma-auth-client`
- `DeviceSession`: idempotent UUID generation, clear wipes both keys
- `ClientAuthSession`: store/retrieve, idle TTL rejection, hard TTL rejection, rolling refresh window, clear
- `AuthProvider`: configured providers list, unconfigured excluded, signIn calls correct flow
- `IdentityStore`: upsert/get/remove/clear
- `PreferencesStore`: set merges, get returns {}, clear removes key

---

## Success Criteria

- `SyncClientAdapter.sync()` produces identical payload to the current year-planner `SyncClient.sync()`
- `DocumentStore.migrate()` can transform year-planner's legacy numeric key format to M009 (validated by year-planner migration test)
- `ClientAuthSession.isSignedIn()` correctly rejects idle-expired and hard-expired tokens
- `AuthProvider.signIn('google')` completes full flow and stores jsmdma JWT (integration test with mock server)
- Both ESM bundles are < 30KB minified+gzipped
- Zero year-planner-specific code in either package
