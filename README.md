# jsmdma 

## Multi-Device Mobile Architecture for Javascript

### A Multi-tenant, Multi-purpose, Multi-device (Mobile & Web)  Local and Remote NoSQL Application Storage 

An offline-first, multitenant, multipurpose application data API built on the [alt-javascript/boot](https://github.com/alt-javascript/boot) ecosystem. Clients (browser, mobile, Node.js) maintain a local copy of data and synchronise bidirectionally with a server using field-level merge and causal conflict resolution. Network outages are handled gracefully — applications continue working locally and sync when connectivity is restored.

A single running server supports multiple **configured applications** (e.g. `todo`, `shopping-list`, your own custom apps). Each application has its own isolated user-scoped storage, optional JSON Schema validation, and smart conflict resolution that auto-merges non-overlapping line-level text changes instead of discarding one side.

Users can belong to **organisations** — app-agnostic named groups. An org member can sync under the org's isolated namespace in any configured application by sending an `X-Org-Id` header.

## Architecture

```
packages/
  core/        — Isomorphic: HLC clock, field diff, merge engine, text auto-merge (no Node deps)
  server/      — SyncRepository, SyncService, ApplicationRegistry, SchemaValidator
  hono/        — AppSyncController wired into boot-hono CDI context
  auth-core/   — JWT session, provider errors
  auth-hono/   — AuthMiddlewareRegistrar, AuthController, OrgController
  auth-server/ — UserRepository, AuthService, OrgRepository, OrgService
  example/     — Offline-first demo (run.js) and multi-app + org demo (run-apps.js)
```

**Technology stack:**
- [boot-hono](https://github.com/alt-javascript/boot/tree/main/packages/boot-hono) — CDI-managed Hono server (runs on Node, Lambda, Cloudflare Workers)
- [jsnosqlc](https://github.com/alt-javascript/jsnosqlc) — NoSQL abstraction (memory in tests, DynamoDB / MongoDB / Firestore in production)
- [alt-javascript/cdi](https://github.com/alt-javascript/boot/tree/main/packages/cdi) — Spring-style dependency injection
- Hybrid Logical Clock (HLC) for causal revision tracking
- [ajv](https://ajv.js.org/) — JSON Schema validation

---

## Documentation

- **[Client Integration Guide](docs/client-integration.md)** — step-by-step guide to building offline-first clients using SyncClient
- **[Sync Protocol Reference](docs/sync-protocol.md)** — wire-level detail of the POST /:app/sync request/response contract
- **[Sharing & Visibility](docs/sharing.md)** — per-document visibility flags, shareToken-based public access, and ACL fan-out
- **[Search](docs/search.md)** — filter-based full-text and structured search across accessible documents
- **[Export](docs/export.md)** — bulk export of personal or org-scoped data in JSON and CSV formats
- **[Deletion](docs/deletion.md)** — hard-delete protocol, tombstoning, and purge semantics
- **[Data Model](docs/data-model.md)** — document structure, DocIndex schema, storage namespace layout, and relationship design
- **[OpenAPI Spec](docs/openapi.yaml)** — machine-readable API description (OpenAPI 3.1.0) covering all endpoints
- **[Year Planner Integration](docs/year-planner-integration.md)** — worked example integrating the API with a calendar/planner front-end
- **[Architecture Decision Records](docs/decisions/)** — ADR-001 through ADR-019 capturing key design choices

---

## Sync Protocol

### POST /:application/sync

`application` must be a key in the configured `applications` block (see [Applications Configuration](#applications-configuration)).  Unknown values return `404`.  A valid JWT is required — unauthenticated requests return `401`.

**Request:**
```json
{
  "collection":  "tasks",
  "clientClock": "0019d2bc1234a-000001-client-uuid",
  "changes": [
    {
      "key":       "task-1",
      "doc":       { "title": "Buy milk", "done": false },
      "fieldRevs": { "title": "0019d2bc...", "done": "0019d2bc..." },
      "baseClock": "0019d2bc0000a-000000-server"
    }
  ]
}
```

| Field | Description |
|---|---|
| `collection` | Which collection to sync |
| `clientClock` | The client's `baseClock` — the last `serverClock` it received. Use `HLC.zero()` for "I have seen nothing" (pulls all docs). |
| `changes` | Array of local changes to push. May be empty for a pull-only sync. |
| `changes[].key` | Document primary key |
| `changes[].doc` | Current local document (application fields only) |
| `changes[].fieldRevs` | Per-field HLC revisions: `{ fieldName: hlcString }` |
| `changes[].baseClock` | The `serverClock` from the sync when the client last received this document |

**Response:**
```json
{
  "serverClock": "0019d2bc1234b-000001-server",
  "serverChanges": [
    { "_key": "task-1", "_rev": "...", "_fieldRevs": { ... }, "title": "Buy milk", "done": false }
  ],
  "conflicts": [
    {
      "key": "task-1",
      "field": "notes",
      "localRev":    "0019d2bc...",
      "remoteRev":   "0019d2bc...",
      "localValue":  "- Client version",
      "remoteValue": "- Server version",
      "winner":      "auto-merged",
      "winnerValue": "- Client version\n- Server version",
      "mergeStrategy": "text-auto-merged"
    }
  ]
}
```

| Field | Description |
|---|---|
| `serverClock` | Server's updated HLC — store this as your new `baseClock` |
| `serverChanges` | All documents modified after your `clientClock` (pull set) |
| `conflicts` | Fields where both sides changed since `baseClock`; already resolved in the stored doc |
| `conflicts[].winner` | `'local'`, `'remote'`, or `'auto-merged'` |
| `conflicts[].mergeStrategy` | Present only when `winner === 'auto-merged'`; value is `'text-auto-merged'` |

**The client loop:**
1. Send local changes with `clientClock = baseClock` (last serverClock received)
2. Apply `serverChanges` to local store
3. Set `baseClock = serverClock`
4. Inspect `conflicts`: `auto-merged` entries are informational; `local`/`remote` entries mean one side lost

**Schema validation errors (400):**
```json
{
  "error": "Schema validation failed",
  "details": [
    { "key": "task-1", "field": "title", "message": "must have required property 'title'" }
  ]
}
```

---

## Applications Configuration

The `applications` config block declares which application paths are accepted by the server. Unknown application names return `404`.

```js
// EphemeralConfig or application.yaml / config.js
{
  applications: {
    todo: {
      collections: {
        tasks: {
          // Option A — inline JSON Schema
          schema: {
            type: 'object',
            required: ['title'],
            properties: {
              title:    { type: 'string' },
              done:     { type: 'boolean' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
        },
        notes: {
          // Option B — schema loaded from disk (schemaPath wins when both present)
          schemaPath: './schemas/note.json',
        },
      },
    },
    'shopping-list': {
      // No collections block = free-form documents, no schema validation
    },
  },
}
```

**Schema resolution order:**
1. `schemaPath` — JSON file loaded at first validation call (relative to process.cwd())
2. `schema` — inline JSON Schema object in config
3. Neither present → no validation; all documents accepted

**CDI context assembly:**

```js
import {
  SyncRepository, SyncService,
  ApplicationRegistry, SchemaValidator,
} from '@alt-javascript/data-api-server';
import { AppSyncController } from '@alt-javascript/data-api-hono';
import { AuthMiddlewareRegistrar } from '@alt-javascript/data-api-auth-hono';

const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,     name: 'syncRepository',     scope: 'singleton' },
  { Reference: SyncService,        name: 'syncService',        scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator,    name: 'schemaValidator',    scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  // Auth middleware MUST come before AppSyncController
  { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
  { Reference: AppSyncController,  name: 'appSyncController',  scope: 'singleton' },
]);
```

**Storage isolation:**  
Storage keys are namespaced as `{userId}:{application}:{collection}` (colons in segment values are percent-encoded as `%3A`). Two users posting to the same `/:application/sync` path cannot read each other's documents.

---

## Organisations (M004)

Organisations are app-agnostic named groups. A user creates an org and becomes its first `org-admin`. Org admins can add/remove members and promote or demote other members. Any member can sync under the org's namespace in any configured application by sending the `X-Org-Id` header.

### Org Endpoints

All org endpoints require a valid JWT.

| Method | Path | Requires | Description |
|---|---|---|---|
| `POST` | `/orgs` | JWT | Create org. Body: `{ name }`. Creator becomes `org-admin`. Returns `{ orgId, name, role }`. |
| `GET` | `/orgs` | JWT | List all orgs the caller belongs to. |
| `GET` | `/orgs/:orgId/members` | membership | List all members of an org. |
| `POST` | `/orgs/:orgId/members` | org-admin | Add a member. Body: `{ userId, role? }`. Role defaults to `member`. |
| `PATCH` | `/orgs/:orgId/members/:userId` | org-admin | Change a member's role. Body: `{ role }`. Returns `409` if demoting the last org-admin. |
| `DELETE` | `/orgs/:orgId/members/:userId` | org-admin | Remove a member. Returns `409` if removing the last org-admin. |

**Roles:** `org-admin` — full management rights. `member` — read/write access to org data, read-only to member list.

### Org-Scoped Sync

To sync documents into an org's namespace, add the `X-Org-Id` header to any `POST /:application/sync` request:

```http
POST /todo/sync
Authorization: Bearer <token>
X-Org-Id: <orgId>
Content-Type: application/json

{ "collection": "tasks", "clientClock": "...", "changes": [...] }
```

- **Member check:** The server performs a live lookup — only members of the org can use its namespace.
- **Non-member:** `403 { error: 'Not a member of organisation: ...' }`
- **No header:** Personal namespace (unchanged behaviour)

### Storage Namespace Layout

```
Personal sync (no X-Org-Id):
  {userId}:{application}:{collection}
  e.g.  alice-uuid:todo:tasks

Org-scoped sync (X-Org-Id: <orgId>):
  org:{orgId}:{application}:{collection}
  e.g.  org:3f7b...a1:todo:tasks
         org:3f7b...a1:shopping-list:lists

Key properties:
- org: prefix is unambiguous — userIds are UUIDs and never start with 'org:'
- Same orgId across different applications → isolated namespaces per app
- Personal and org namespaces are completely isolated even for the same user
```

### CDI Context Assembly (with Orgs)

```js
import {
  UserRepository, AuthService,
  OrgRepository, OrgService,
} from '@alt-javascript/data-api-auth-server';
import { OrgController } from '@alt-javascript/data-api-auth-hono';

const context = new Context([
  // ... sync components from M003 context ...
  { Reference: UserRepository,  name: 'userRepository',  scope: 'singleton' },
  { Reference: AuthService,     name: 'authService',     scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
  { Reference: OrgRepository,   name: 'orgRepository',   scope: 'singleton' },
  { Reference: OrgService,      name: 'orgService',      scope: 'singleton' },
  // ↓ Auth middleware MUST come before all controllers
  { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
  { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  { Reference: AuthController,    name: 'authController',    scope: 'singleton' },
  { Reference: OrgController,     name: 'orgController',     scope: 'singleton' },
]);
```

---

## HLC Format

HLC (Hybrid Logical Clock) is a causality-preserving clock that combines wall time with a logical counter. This project encodes it as a zero-padded hex string:

```
<13-hex-ms>-<6-hex-seq>-<node>

Example: 0019d2bc1234a-000001-client-uuid
         ↑ wall ms     ↑ seq  ↑ node id
```

- **13 hex digits for ms** — covers wall time to year ~143,000,000 from epoch
- **6 hex digits for seq** — up to 16,777,215 events per millisecond
- **node** — stable unique identifier for the sender (UUID or short ID)

**Key property:** HLC strings are lexicographically ordered, so `a > b` in string comparison means "a happened after b causally". This means HLC strings can be used directly as NoSQL sort keys and with range queries (`Filter.where('_rev').gt(clientClock)`).

**Using HLC in your client:**
```js
import { HLC } from '@alt-javascript/data-api-core';

// Create a new clock for this node
let clock = HLC.create('my-device-uuid', Date.now());

// Advance before each local edit
clock = HLC.tick(clock, Date.now());
fieldRevs[field] = clock;

// Advance on receiving server response
clock = HLC.recv(clock, serverClock, Date.now());
```

---

## Conflict Resolution

A conflict occurs when **both the client and the server** changed the same field since the client's `baseClock`.

**Detection:**
```
clientChanged = clientFieldRevs[field] > baseClock
serverChanged = serverFieldRevs[field] > baseClock

if (clientChanged && serverChanged) → conflict
```

**Resolution order for string fields:**
1. **Text auto-merge** — split both values into lines and diff against the base. If the local and remote change-sets produce non-overlapping hunks (no line is edited by both sides), apply both sets and return the merged text. The conflict entry reports `winner: 'auto-merged'` and `mergeStrategy: 'text-auto-merged'`. The client can display this as informational — no data was lost.
2. **HLC winner fallback** — if hunks overlap (both sides changed the same lines), the version with the higher HLC wins. Equal HLC → local wins as a stable tie-break. The conflict entry reports `winner: 'local'` or `winner: 'remote'`.

**Resolution for non-string fields:**
- Higher HLC wins directly (no text diff attempted)
- Equal HLC → local wins

**The client should display warnings** when `winner === 'local'` or `winner === 'remote'` — the losing value is gone and the user may want to review it.  `winner === 'auto-merged'` is informational — both sides' changes are preserved in the merged value.

---

## How to Run

**Prerequisites:** Node.js ≥ 20, npm ≥ 7

```bash
# Install all workspaces
npm install

# Run all tests
npm test

# Run the offline-first example (two devices, same user, HLC conflict)
node packages/example/run.js

# Run the multi-app example (todo + shopping-list, two users, schema validation)
node packages/example/run-apps.js
```

**Expected run.js output:**
```
  ✓ field1 = "A-edit"   (only Client A changed this — clean merge)
  ✓ field2 = "B-edit"   (both changed — conflict, B wins (higher HLC))
  ✓ field3 = "B-edit"   (only Client B changed this — clean merge)

  All assertions passed. Offline-first sync protocol working correctly.
```

**Expected run-apps.js output:**
```
  ✓ Unknown application → 404
  ✓ Invalid todo doc (missing title) → 400 with schema details
  ✓ Valid todo task → 200 stored and retrievable
  ✓ User isolation — Bob cannot see Alice's data
  ✓ Text auto-merge attempted on concurrent notes edits
  ✓ Shopping list (no schema) syncs free-form documents
  ✓ Shopping list user isolation — Bob cannot see Alice's lists
  ✓ Org created; Bob added as member
  ✓ Alice + Bob share documents via x-org-id header
  ✓ Carol (non-member) rejected with 403
  ✓ Org namespace isolated from personal namespace

  Multi-app, multi-user, org-scoped sync working correctly.
```

---

## Package Map

| Package | Description |
|---|---|
| `packages/core` | `@alt-javascript/data-api-core` — HLC, diff, merge, textMerge (isomorphic) |
| `packages/server` | `@alt-javascript/data-api-server` — SyncRepository, SyncService, ApplicationRegistry, SchemaValidator |
| `packages/hono` | `@alt-javascript/data-api-hono` — AppSyncController, boot-hono wiring |
| `packages/auth-core` | `@alt-javascript/data-api-auth-core` — JWT session, provider errors |
| `packages/auth-hono` | `@alt-javascript/data-api-auth-hono` — AuthMiddlewareRegistrar, AuthController, OrgController |
| `packages/auth-server` | `@alt-javascript/data-api-auth-server` — UserRepository, AuthService, OrgRepository, OrgService |
| `packages/example` | Runnable demos: `run.js` (offline-first), `run-apps.js` (multi-app + orgs) |

---

## Auth API (M002)

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/:provider` | — | Begin OAuth flow. Returns `{ authorizationURL, state, codeVerifier }`. |
| `GET` | `/auth/:provider/callback` | — | Complete OAuth flow. Query: `code`, `state`, `stored_state`, `code_verifier`. Returns `{ user, token }`. |
| `GET` | `/auth/me` | ✅ | Current user identity from JWT: `{ userId, email, providers }`. |
| `POST` | `/auth/logout` | — | Stateless logout guidance. Client deletes the stored token. |
| `POST` | `/auth/link/:provider` | ✅ | Add a second OAuth provider to the current identity. Same query params as callback. |
| `DELETE` | `/auth/providers/:provider` | ✅ | Remove a provider. Returns `409` if it would be the last. |

**Supported providers:** `google`, `github`, `microsoft`, `apple`

### JWT Session Contract

Sessions are stateless HS256 JWTs. All protected routes require:

```
Authorization: Bearer <token>
```

**Token payload:**
```json
{
  "sub":         "uuid",
  "providers":   ["github", "google"],
  "email":       "user@example.com",
  "iat":         1700000000,
  "iat_session": 1700000000
}
```

**TTL policy:**
- **Idle TTL:** 3 days — if `now - iat > 3d`, token is rejected with `{ error: 'Session expired', reason: 'idle' }`
- **Hard TTL:** 7 days — if `now - iat_session > 7d`, token is rejected with `{ error: 'Session expired', reason: 'hard' }`
- **Rolling refresh:** when `now - iat > 1h`, a fresh token is issued in the `X-Auth-Token` response header. Client should store it and use it for subsequent requests.

### CDI Context Assembly

**Critical ordering rule:** `AuthMiddlewareRegistrar` must be registered **before** `AppSyncController` and `AuthController` in the CDI context array. Hono registers middleware and routes in insertion order — `app.use()` must fire before route handlers.

```js
const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,      name: 'syncRepository',      scope: 'singleton' },
  { Reference: SyncService,         name: 'syncService',         scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator,     name: 'schemaValidator',     scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
  { Reference: AuthService,    name: 'authService',    scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
  // ↓ MUST come before AppSyncController and AuthController
  { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
  { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  { Reference: AuthController,    name: 'authController',    scope: 'singleton' },
]);
```

**Config:**
```
auth.jwt.secret = <your-secret-at-least-32-chars>
```

### Apple Sign In

Apple requires a private key (ES256) for its JWT client secret. Pass the PEM-encoded key in the provider config:

```js
import { AppleProvider } from '@alt-javascript/data-api-auth-core';
const apple = new AppleProvider({
  clientId:    'com.example.app',
  teamId:      'YOURTEAMID',
  keyId:       'YOURKEYID',
  privateKey:  process.env.APPLE_PRIVATE_KEY_PEM,  // PEM string
  redirectUri: 'https://example.com/auth/apple/callback',
});
```

`pemToDer()` is called internally — you provide a PEM string, arctic handles the rest.

### How to run auth example

```bash
node packages/example-auth/run.js
```

Expected output includes:
```
  ✓ First login → new UUID assigned
  ✓ GET /auth/me → identity confirmed
  ✓ POST /todo/sync → authenticated request succeeds
  ✓ Rolling refresh → X-Auth-Token emitted, iat_session preserved
  ✓ Provider link → second provider added, UUID unchanged
  ✓ Provider unlink → first provider removed
  ✓ Last provider protection → 409 on unlink attempt
  ✓ Expired token → 401 with reason=idle
```

---

## Roadmap

| Milestone | Status | Description |
|---|---|---|
| M001 | ✅ Complete | Sync engine, HLC, field-level merge, Hono server, example |
| M002 | ✅ Complete | OAuth identity: Google, Microsoft, Apple, GitHub → UUID |
| M003 | ✅ Complete | Application-scoped sync, text auto-merge, JSON Schema validation |
| M004 | ✅ Complete | Organisation tenancy — app-agnostic orgs, membership, role management, X-Org-Id header sync |
| M005 | ✅ Complete | Deep nested document support — dot-path fieldRevs and recursive field-level merge |
| M006 | ✅ Complete | Planner schema, application config, and isomorphic ESM bundle |
| M007 | ✅ Complete | Data model, DocIndex, sharing design, OpenAPI spec, and integration guide authoring |
| M008 | ✅ Complete | ACL enforcement, search, export, and hard deletion |
| M009 | ✅ Complete | SyncClient (isomorphic, browser-ready), ADRs, and full documentation wiring |
