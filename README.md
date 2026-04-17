# jsmdma

## Multi-Device Mobile Architecture for JavaScript

### Offline-first, multi-tenant, multi-purpose NoSQL application storage — local and remote, synchronised bidirectionally

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/badge/npm-%40alt--javascript-red.svg)](https://www.npmjs.com/search?q=%40alt-javascript%2Fjsmdma)

Clients — browser, mobile, or Node.js — maintain a local copy of application data and synchronise bidirectionally with a server using field-level merge and causal conflict resolution. Network outages are handled gracefully: applications continue operating locally and sync when connectivity is restored.

A single server supports multiple **configured applications** (e.g. `todo`, `shopping-list`, your own apps). Each application has isolated, user-scoped storage, optional JSON Schema validation, and smart conflict resolution that auto-merges non-overlapping line-level text changes rather than discarding one side.

Users can belong to **organisations** — app-agnostic named groups. An org member syncs under the org's isolated namespace in any configured application by sending an `X-Org-Id` header.

**Part of the [@alt-javascript](https://github.com/alt-javascript) ecosystem.**

---

## Packages

| Package | npm | Description |
|---|---|---|
| [`packages/core`](packages/core/) | [`@alt-javascript/jsmdma-core`](https://www.npmjs.com/package/@alt-javascript/jsmdma-core) | Isomorphic: HLC clock, field diff, merge engine, SyncClient (no Node deps) |
| [`packages/server`](packages/server/) | [`@alt-javascript/jsmdma-server`](https://www.npmjs.com/package/@alt-javascript/jsmdma-server) | SyncRepository, SyncService, ApplicationRegistry, SchemaValidator |
| [`packages/hono`](packages/hono/) | [`@alt-javascript/jsmdma-hono`](https://www.npmjs.com/package/@alt-javascript/jsmdma-hono) | AppSyncController — Hono route wiring |
| [`packages/auth-core`](packages/auth-core/) | [`@alt-javascript/jsmdma-auth-core`](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-core) | JWT session helpers, OAuth provider errors |
| [`packages/auth-server`](packages/auth-server/) | [`@alt-javascript/jsmdma-auth-server`](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-server) | UserRepository, AuthService, OrgRepository, OrgService |
| [`packages/auth-hono`](packages/auth-hono/) | [`@alt-javascript/jsmdma-auth-hono`](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-hono) | AuthMiddlewareRegistrar, AuthController, OrgController |
| [`packages/example`](packages/example/) | — (private) | Runnable sync demos: `run.js`, `run-apps.js` |
| [`packages/example-auth`](packages/example-auth/) | — (private) | Runnable auth lifecycle demo |

---

## Quick Start

```bash
npm install
npm test

# Offline-first two-device demo
node packages/example/run.js

# Multi-app + org demo
node packages/example/run-apps.js
```

**Prerequisites:** Node.js ≥ 20

---

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
          // Option B — schema loaded from disk
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

**Canonical starter (recommended):**

```js
import { Context } from '@alt-javascript/cdi';
import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';

const context = new Context([
  ...jsmdmaHonoStarter(),
]);
```

**Advanced options (constrained, opt-in):**

```js
import { Context } from '@alt-javascript/cdi';
import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
import AuditMiddlewareRegistrar from './AuditMiddlewareRegistrar.js';

const context = new Context([
  ...jsmdmaHonoStarter({
    // feature toggles are dependency-validated at startup
    features: {
      sync: false,
      appSyncController: false,
    },
    // hooks are stage-scoped; invalid stages/payloads fail fast
    hooks: {
      beforeAuth: [{
        Reference: AuditMiddlewareRegistrar,
        name: 'auditMiddlewareRegistrar',
        scope: 'singleton',
      }],
    },
  }),
]);
```

Manual CDI assembly is still possible, but the starter is the canonical path because it preserves auth-before-controller ordering and validates unsupported combinations before runtime.

**Storage isolation:**
Storage keys are namespaced as `{userId}:{application}:{collection}`. Two users posting to the same `/:application/sync` path cannot read each other's documents.

---

## Organisations

Organisations are app-agnostic named groups. A user creates an org and becomes its first `org-admin`. Any member can sync under the org's namespace in any configured application by sending the `X-Org-Id` header.

### Org Endpoints

| Method | Path | Requires | Description |
|---|---|---|---|
| `POST` | `/orgs` | JWT | Create org. Body: `{ name }`. |
| `GET` | `/orgs` | JWT | List orgs the caller belongs to. |
| `GET` | `/orgs/:orgId/members` | membership | List members. |
| `POST` | `/orgs/:orgId/members` | org-admin | Add a member. Body: `{ userId, role? }`. |
| `PATCH` | `/orgs/:orgId/members/:userId` | org-admin | Change a member's role. |
| `DELETE` | `/orgs/:orgId/members/:userId` | org-admin | Remove a member. |

```http
POST /todo/sync
Authorization: Bearer <token>
X-Org-Id: <orgId>
```

---

## HLC Format

```
<13-hex-ms>-<6-hex-seq>-<node>

Example: 0019d2bc1234a-000001-client-uuid
```

HLC strings are lexicographically ordered — `a > b` in string comparison means "a happened after b causally". They can be used directly as NoSQL sort keys and in range queries.

---

## Conflict Resolution

A conflict occurs when both client and server changed the same field since the client's `baseClock`.

1. **Text auto-merge** — non-overlapping line-level hunks are merged and applied; `winner: 'auto-merged'`
2. **HLC winner fallback** — overlapping hunks: higher HLC wins; equal HLC → local wins

Non-string fields go straight to step 2.

---

## How to Run

```bash
npm install
npm test

# Offline-first two-device demo
node packages/example/run.js

# Multi-app + org demo
node packages/example/run-apps.js

# Auth lifecycle demo
node packages/example-auth/run.js
```

---

## Auth API

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/:provider` | — | Begin OAuth flow. |
| `GET` | `/auth/:provider/callback` | — | Complete OAuth flow. Returns `{ user, token }`. |
| `GET` | `/auth/me` | ✅ | Current user identity from JWT. |
| `POST` | `/auth/logout` | — | Stateless logout guidance. |
| `POST` | `/auth/link/:provider` | ✅ | Link a second OAuth provider. |
| `DELETE` | `/auth/providers/:provider` | ✅ | Remove a provider. Returns `409` if it would be the last. |

**Supported providers:** `google`, `github`, `microsoft`, `apple`

### JWT Session

Sessions are stateless HS256 JWTs. Idle TTL: 3 days. Hard TTL: 7 days. Rolling refresh via `X-Auth-Token` response header when idle for more than 1 hour.

---

## Roadmap

| Milestone | Status | Description |
|---|---|---|
| M001 | ✅ | Sync engine, HLC, field-level merge, Hono server, example |
| M002 | ✅ | OAuth identity: Google, Microsoft, Apple, GitHub → UUID |
| M003 | ✅ | Application-scoped sync, text auto-merge, JSON Schema validation |
| M004 | ✅ | Organisation tenancy — orgs, membership, roles, X-Org-Id header sync |
| M005 | ✅ | Deep nested document support — dot-path fieldRevs and recursive merge |
| M006 | ✅ | Planner schema, application config, and isomorphic ESM bundle |
| M007 | ✅ | Data model, DocIndex, sharing design, OpenAPI spec, integration guides |
| M008 | ✅ | ACL enforcement, search, export, and hard deletion |
| M009 | ✅ | SyncClient (isomorphic, browser-ready), ADRs, and full documentation |

---

## License

MIT
