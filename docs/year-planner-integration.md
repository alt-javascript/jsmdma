# year-planner × data-api Integration Guide

This guide explains how to wire up **data-api** as the backend for the
**year-planner** GSD project. data-api provides offline-first, bidirectional
sync with field-level merge and HLC-based causal conflict resolution;
year-planner uses it to persist planner documents and sync state across
multiple devices or browser tabs.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [CDI Context Setup](#3-cdi-context-setup)
4. [Application Config](#4-application-config)
5. [Auth Flow](#5-auth-flow)
6. [Sync Protocol](#6-sync-protocol)
7. [DocIndex — Ownership and Sharing](#7-docindex--ownership-and-sharing)
8. [HLC Usage](#8-hlc-usage)
9. [Reference](#9-reference)

---

## 1. Overview

data-api is an offline-first, bidirectional sync service built on the
alt-javascript/boot CDI ecosystem. Core properties:

- **Field-level merge** — each leaf field carries its own HLC revision;
  concurrent edits on different devices are merged without full-document
  overwrites.
- **HLC-based conflict resolution** — Hybrid Logical Clocks provide causal
  ordering. Higher-HLC wins per field; non-overlapping line edits in string
  fields are auto-merged by `textMerge`.
- **Per-user isolated storage** — documents are keyed as
  `{userId}:{app}:{collection}` so each user's namespace is fully isolated.
- **Org-scoped storage** — when a document is synced with the `x-org-id`
  header the key becomes `org:{orgId}:{app}:{collection}`, shared by all
  members of that org.
- **DocIndex** — after every sync write the server maintains a metadata
  entry (owner, visibility, sharedWith, shareToken) for each document.

---

## 2. Prerequisites

- **Node ≥ 20** (ESM-only; `"type": "module"` throughout)
- `npm install` in the monorepo root to resolve all workspace dependencies
- A **JWT secret** of at least 32 characters stored as an environment
  variable (e.g. `JWT_SECRET`)
- A **storage back-end** configured via `boot.nosql.url`:
  - `jsnosqlc:memory:` for tests / local dev (add `@alt-javascript/jsnosqlc-memory`)
  - DynamoDB, MongoDB, or Firestore for production

---

## 3. CDI Context Setup

CDI registration order is load-order significant in Hono — middleware is
registered in insertion order. The rules are:

1. `jsnosqlcAutoConfiguration()` and `honoStarter()` must come first.
2. `AuthMiddlewareRegistrar` must be registered **before** any controllers.
3. `DocumentIndexRepository` must be registered **before** `AppSyncController`
   (CDI autowires by name match at start time).
4. `OrgController` needs `properties: [{ name: 'registerable', path: 'orgs.registerable' }]`
   if you want HTTP org creation to be enabled; omit or leave the config key
   absent to return 403 for all POST /orgs requests.

### Minimal Context for year-planner

```js
import '@alt-javascript/jsnosqlc-memory';          // or your prod driver
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig }             from '@alt-javascript/config';
import { honoStarter }                 from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration }   from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService,
  ApplicationRegistry, SchemaValidator,
  DocumentIndexRepository,
} from '@alt-javascript/data-api-server';
import { AppSyncController, DocIndexController } from '@alt-javascript/data-api-hono';
import { AuthMiddlewareRegistrar, OrgController } from '@alt-javascript/data-api-auth-hono';
import { UserRepository, OrgRepository, OrgService } from '@alt-javascript/data-api-auth-server';

const JWT_SECRET = process.env.JWT_SECRET; // ≥ 32 chars

const config = new EphemeralConfig({
  boot:         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging:      { level: { ROOT: 'error' } },
  server:       { port: 3000 },
  auth:         { jwt: { secret: JWT_SECRET } },
  applications: APPLICATIONS_CONFIG,     // see Section 4
  orgs:         { registerable: true },  // remove to disable HTTP org creation
});

const context = new Context([
  // 1. Infrastructure — must be first
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),

  // 2. Sync layer
  { Reference: SyncRepository,      name: 'syncRepository',      scope: 'singleton' },
  { Reference: SyncService,         name: 'syncService',         scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator,     name: 'schemaValidator',     scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },

  // 3. Auth layer
  { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
  { Reference: OrgRepository,  name: 'orgRepository',  scope: 'singleton' },
  { Reference: OrgService,     name: 'orgService',     scope: 'singleton' },

  // 4. Auth middleware — MUST precede all controllers
  { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },

  // 5. DocIndex — MUST precede AppSyncController
  { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },

  // 6. Controllers
  { Reference: AppSyncController,  name: 'appSyncController',  scope: 'singleton' },
  { Reference: OrgController,      name: 'orgController',      scope: 'singleton',
    properties: [{ name: 'registerable', path: 'orgs.registerable' }] },
  { Reference: DocIndexController, name: 'docIndexController', scope: 'singleton' },
]);

const appCtx = new ApplicationContext({ contexts: [context], config });
await appCtx.start({ run: false }); // run:false = don't bind a port (useful in tests)
await appCtx.get('nosqlClient').ready();

const app = appCtx.get('honoAdapter').app;  // Hono instance — pass to your server
```

For a complete working example, see `packages/example/run-apps.js` lines 83–120.

---

## 4. Application Config

The `APPLICATIONS_CONFIG` object declares which app names are valid and
what collections they expose. Unknown app names receive a 404.

### With inline JSON Schema (validation on every sync write)

```js
const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner documents',
    collections: {
      planners: {
        schema: {
          type: 'object',
          required: ['meta'],
          properties: {
            meta: {
              type: 'object',
              required: ['name', 'year'],
              properties: {
                name: { type: 'string' },
                year: { type: 'integer' },
              },
            },
            days: {
              type: 'object',
              description: 'Sparse map of ISO date strings to day entries',
              additionalProperties: {
                type: 'object',
                properties: {
                  tp:    { type: 'string' },  // time-planned
                  notes: { type: 'string' },
                },
              },
            },
          },
          additionalProperties: true,
        },
      },
    },
  },
};
```

### With schemaPath (load from disk)

```js
const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner documents',
    collections: {
      planners: {
        schemaPath: './schemas/planner.json',  // relative to server CWD
      },
    },
  },
};
```

Use `schemaPath` when the schema is large or shared between projects.
The canonical server-side schema files live in `packages/server/schemas/`.
Omit the `schema` / `schemaPath` key entirely to accept free-form documents
(no validation).

---

## 5. Auth Flow

### Local dev / testing — mint a JWT directly

Use `JwtSession.sign` to create a token without going through an OAuth
provider. This is the pattern used throughout `packages/example/run-apps.js`.

```js
import { JwtSession } from '@alt-javascript/data-api-auth-core';

const JWT_SECRET = 'your-dev-secret-at-least-32-chars!!';

// Mint a token for a user
const token = await JwtSession.sign(
  { sub: 'alice-uuid', email: 'alice@example.com', providers: ['demo'] },
  JWT_SECRET,
);

// Use it in HTTP requests
const res = await fetch('/year-planner/sync', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ collection: 'planners', clientClock: HLC.zero(), changes: [] }),
});
```

The `sub` claim becomes the `userId` used for storage key namespacing.

### Production — OAuth provider flow

1. Client navigates to `GET /auth/:provider` (e.g. `/auth/google`).
2. Server redirects to the OAuth provider's consent screen.
3. Provider redirects back to `GET /auth/:provider/callback`.
4. Server exchanges the code, looks up or creates the user, mints a JWT,
   and returns it in the response body as `{ token }`.
5. Client stores the token locally (localStorage or similar) and attaches
   it to all subsequent requests as `Authorization: Bearer <token>`.

The token carries an expiry; the server auto-refreshes tokens on each
authenticated request (rolling refresh). The token payload includes `sub`
(userId), `email`, and `providers` (list of connected OAuth provider names).

---

## 6. Sync Protocol

All sync requests go to `POST /{app}/sync` with a JSON body. The response
is always 200 on success; errors return the appropriate 4xx status.

### First sync (cold start)

On first sync the client has no local data and no server clock:

```js
const res = await fetch('/year-planner/sync', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    collection:  'planners',
    clientClock: HLC.zero(),   // '0000000000000-000000-' — "I have seen nothing"
    changes:     [],           // no local changes yet
  }),
});

const { serverChanges, serverClock, conflicts } = await res.json();
// serverChanges — full set of documents the server has (everything > clientClock)
// serverClock   — HLC string; store this and send as clientClock on next sync
// conflicts     — [] on first pull (nothing to conflict with)
```

### Subsequent syncs (bidirectional)

```js
import { HLC } from '@alt-javascript/data-api-core';

// Advance the local clock before writing a new document
const newClock = HLC.tick(lastServerClock, Date.now());

const res = await fetch('/year-planner/sync', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    collection:  'planners',
    clientClock: lastServerClock,   // clock received from the previous sync response
    changes: [
      {
        key:       'planner-2026',
        doc: {
          meta: { name: 'My 2026 Planner', year: 2026 },
          days: {
            '2026-01-01': { tp: '08:00', notes: 'New Year' },
            '2026-06-15': { tp: '09:00', notes: 'Mid-year review' },
          },
        },
        fieldRevs: {
          // flat dot-path map — one HLC string per leaf field
          'meta.name':               newClock,
          'meta.year':               newClock,
          'days.2026-01-01.tp':      newClock,
          'days.2026-01-01.notes':   newClock,
          'days.2026-06-15.tp':      newClock,
          'days.2026-06-15.notes':   newClock,
        },
        baseClock: HLC.zero(),  // clock of the version this change is based on
      },
    ],
  }),
});

const { serverChanges, serverClock, conflicts } = await res.json();
// Store serverClock as the new lastServerClock for the next request
```

### fieldRevs shape

`fieldRevs` is a **flat dot-path map** from leaf field path to HLC string.
Every field you are writing must have an entry — omitted fields are not
touched. Array elements are addressed by index: `'days.0.notes'`.

The server performs per-field HLC comparison during merge:
- If the incoming field HLC > stored HLC → incoming wins.
- If the incoming field HLC < stored HLC → stored wins (the field is dropped from the write).
- Equal HLCs → no-op (already applied).

String fields with non-overlapping line edits are auto-merged via `textMerge`.

### Org-scoped sync

To sync into a shared org namespace, add the `x-org-id` header:

```js
headers: {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'x-org-id': orgId,
},
```

The user must be a member of the org; non-members receive 403.

---

## 7. DocIndex — Ownership and Sharing

After every sync write the server creates or updates a DocIndex entry
keyed as `docIndex:{userId}:{app}:{docKey}`. This entry tracks ownership,
visibility, and sharing metadata.

### Reading the DocIndex entry

```http
GET /docIndex/year-planner/planner-2026
Authorization: Bearer <token>
```

Returns the entry for the requesting user's document. If the document
belongs to a different user the key does not exist for the caller — the
response is **404, not 403** (the compound storage key includes the
owner's userId).

### Updating visibility

```http
PATCH /docIndex/year-planner/planner-2026
Authorization: Bearer <token>
Content-Type: application/json

{ "visibility": "shared" }
```

Valid values: `"private"` (default) or `"shared"`.

### Adding shared-with entries (additive)

```http
PATCH /docIndex/year-planner/planner-2026
Authorization: Bearer <token>
Content-Type: application/json

{ "sharedWith": [{ "userId": "bob-uuid", "app": "year-planner" }] }
```

`sharedWith` is **additive** — PATCH appends entries to the existing list.
It does not replace the list. Send only the new entries you want to add.

### Share tokens

Mint a token to allow link-based access:

```http
POST /docIndex/year-planner/planner-2026/shareToken
Authorization: Bearer <token>
```

Returns `{ shareToken: "<uuid>" }`. Revoke by sending:

```http
DELETE /docIndex/year-planner/planner-2026/shareToken
Authorization: Bearer <token>
```

---

## 8. HLC Usage

HLC (Hybrid Logical Clock) strings are the revision stamps for every field.
The core package is isomorphic — it runs in browsers, Node, and edge runtimes
with no Node-specific dependencies.

```js
import { HLC } from '@alt-javascript/data-api-core';

// Zero clock — "I have seen nothing yet"
// All real clocks compare greater than this value
const zero = HLC.zero();
// → '0000000000000-000000-'

// Advance the clock before a local write
// Call this once per write operation, not per field
const newClock = HLC.tick(lastClock, Date.now());
// → e.g. '018e4a3b2c1d0-000001-'

// Receive a clock from a remote source (e.g. serverClock from sync response)
// recv advances the local clock to be causally after the remote clock
const merged = HLC.recv(localClock, remoteClock, Date.now());

// Compare two HLC strings (returns -1, 0, or 1)
const order = HLC.compare(a, b);

// HLC strings are lexicographically sortable — safe to use as NoSQL sort keys
// and in range queries without decoding
```

**Key rules for year-planner:**

1. Call `HLC.tick(lastClock, Date.now())` **once per write**, not per field.
   Use the same resulting clock for all `fieldRevs` entries in a single change.
2. Persist `serverClock` from each sync response as `lastClock` for the next
   call. This is the causal anchor for the next write.
3. On app cold start, use `HLC.zero()` as `clientClock` and start with an
   empty `changes` array. The server returns the full document set.
4. Never fabricate or hard-code HLC strings. Always derive them via
   `HLC.tick` or `HLC.recv`.

---

## 9. Reference

| Resource | Description |
|---|---|
| `packages/example/run-apps.js` | Working end-to-end scenarios — see Scenario 3 (valid sync), 5 (text auto-merge), 8 (org sync), 9 (DocIndex read), 10 (DocIndex PATCH), 11 (share token), 12 (HTTP org creation) |
| `docs/openapi.yaml` | Machine-readable OpenAPI 3.1 spec for all 18 endpoints |
| `docs/data-model.md` | Entity model, storage key patterns, ER diagrams for flat and org-enabled modes |
| `packages/server/schemas/` | Server-side JSON Schema files: `appConfig.json`, `docIndex.json`, `org.json`, `orgMember.json`, `user.json` |
| `packages/core/index.js` | Public exports: `HLC`, `diff`, `merge`, `textMerge` |
| `packages/auth-core/` | `JwtSession` — JWT mint/verify helpers |
