# year-planner × jsmdma Integration Guide

This guide explains how to wire up **jsmdma** as the backend for the
**year-planner** GSD project. jsmdma provides offline-first, bidirectional
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

jsmdma is an offline-first, bidirectional sync service built on the
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

Use `jsmdmaHonoStarter()` as the canonical composition entrypoint for year-planner.
It bakes in safe registration order (boot infra, sync/auth services, auth middleware,
then controllers), and exposes hook stages for app-specific extensions.

### Starter-first Context for year-planner

```js
import '@alt-javascript/jsnosqlc-memory';
import {Context, ApplicationContext} from '@alt-javascript/cdi';
import {EphemeralConfig} from '@alt-javascript/config';
import {
    jsmdmaHonoStarter,
    DocIndexController,
    SearchController,
    ExportController,
    DeletionController,
} from 'packages/jsmdma-hono';
import {
    DocumentIndexRepository,
    SearchService,
    ExportService,
    DeletionService,
} from '@alt-javascript/jsmdma-server';

const config = new EphemeralConfig({
    boot: {'banner-mode': 'off', nosql: {url: 'jsnosqlc:memory:'}},
    logging: {level: {ROOT: 'error'}},
    server: {port: 3000},
    auth: {jwt: {secret: process.env.JWT_SECRET}},
    applications: APPLICATIONS_CONFIG,    // see Section 4
    orgs: {registerable: true},
});

const context = new Context([
    ...jsmdmaHonoStarter({
        hooks: {
            // Add app services before AppSyncController is registered
            beforeAppSync: [
                {Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton'},
                {Reference: SearchService, name: 'searchService', scope: 'singleton'},
                {Reference: ExportService, name: 'exportService', scope: 'singleton'},
                {Reference: DeletionService, name: 'deletionService', scope: 'singleton'},
            ],
            // Add controllers after AppSyncController + auth middleware are in place
            afterAppSync: [
                {Reference: DocIndexController, name: 'docIndexController', scope: 'singleton'},
                {Reference: SearchController, name: 'searchController', scope: 'singleton'},
                {Reference: ExportController, name: 'exportController', scope: 'singleton'},
                {Reference: DeletionController, name: 'deletionController', scope: 'singleton'},
            ],
        },
    }),
]);

const appCtx = new ApplicationContext({contexts: [context], config});
await appCtx.start({run: false});
await appCtx.get('nosqlClient').ready();
```

Hook stage reminders:
- `beforeAuth`: middleware that must execute before auth guards (for example the CORS hook in `packages/example-auth/run-local.js`)
- `beforeAppSync`: additional services required by app-level controllers
- `afterAppSync`: app-level controllers mounted after sync/auth baseline wiring

For complete starter-based examples, see `packages/example/run-apps.js`, `packages/example/run.js`, and `packages/example-auth/run-local.js`.

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
import { fileURLToPath } from 'node:url';

const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner.json', import.meta.url));
const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner-preferences.json', import.meta.url));
const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../server/schemas/preferences.json', import.meta.url));

const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner documents',
    collections: {
      planners: {
        schemaPath: PLANNER_SCHEMA_PATH,
      },
      preferences: {
        schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH,
      },
      'planner-preferences': {
        schemaPath: APP_PREFERENCES_SCHEMA_PATH,
      },
    },
  },
};
```

Use `schemaPath` when the schema is large or shared between projects.
For year-planner, schema ownership is split intentionally:
- app-owned planner contracts live in `packages/example/schemas/` (`planner.json`, `planner-preferences.json`)
- generic server-owned preferences remain in `packages/server/schemas/preferences.json`

Omit the `schema` / `schemaPath` key entirely to accept free-form documents
(no validation).

---

## 5. Auth Flow

### Local dev / testing — mint a JWT directly

Use `JwtSession.sign` to create a token without going through an OAuth
provider. This is the pattern used throughout `packages/example/run-apps.js`.

```js
import {JwtSession} from 'packages/jsmdma-auth-core';

const JWT_SECRET = 'your-dev-secret-at-least-32-chars!!';

// Mint a token for a user
const token = await JwtSession.sign(
    {sub: 'alice-uuid', email: 'alice@example.com', providers: ['demo']},
    JWT_SECRET,
);

// Use it in HTTP requests
const res = await fetch('/year-planner/sync', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({collection: 'planners', clientClock: HLC.zero(), changes: []}),
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
import {HLC} from 'packages/jsmdma-core';

// Advance the local clock before writing a new document
const newClock = HLC.tick(lastServerClock, Date.now());

const res = await fetch('/year-planner/sync', {
    method: 'POST',
    headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        collection: 'planners',
        clientClock: lastServerClock,   // clock received from the previous sync response
        changes: [
            {
                key: 'planner-2026',
                doc: {
                    meta: {name: 'My 2026 Planner', year: 2026},
                    days: {
                        '2026-01-01': {tp: '08:00', notes: 'New Year'},
                        '2026-06-15': {tp: '09:00', notes: 'Mid-year review'},
                    },
                },
                fieldRevs: {
                    // flat dot-path map — one HLC string per leaf field
                    'meta.name': newClock,
                    'meta.year': newClock,
                    'days.2026-01-01.tp': newClock,
                    'days.2026-01-01.notes': newClock,
                    'days.2026-06-15.tp': newClock,
                    'days.2026-06-15.notes': newClock,
                },
                baseClock: HLC.zero(),  // clock of the version this change is based on
            },
        ],
    }),
});

const {serverChanges, serverClock, conflicts} = await res.json();
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

### Search and ACL

The `POST /:application/search` endpoint enforces the same ACL rules as `changesSince`. Setting a document's visibility to `public` makes it discoverable in open search results for any authenticated user. A share token alone does not cause a document to appear in search results — share tokens are for direct-link sharing only.

```js
// Search for planners matching a filter — ACL-scoped automatically
const response = await fetch('/year-planner/search', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    collection: 'planners',
    filter: { type: 'condition', field: 'meta.name', op: 'contains', value: 'Plan' },
  }),
});
const { results } = await response.json();
```

---

## 8. HLC Usage

HLC (Hybrid Logical Clock) strings are the revision stamps for every field.
The core package is isomorphic — it runs in browsers, Node, and edge runtimes
with no Node-specific dependencies.

```js
import {HLC} from 'packages/jsmdma-core';

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
| `packages/example/run-apps.js` | Working end-to-end scenarios — Scenario 3 (valid sync), 5 (text auto-merge), 7 (org sync), 8–10 (year-planner + schema validation + conflict-free multi-device edit), 11 (DocIndex + share token), 12 (HTTP org creation), 13 (ACL delivery: shared doc in sync), 14 (search ACL scoping), 15 (user export), 16 (org export), 17 (user hard-delete → 404), 18 (org hard-delete → 404) |
| `docs/openapi.yaml` | Machine-readable OpenAPI 3.1 spec for all 23 endpoints |
| `docs/data-model.md` | Entity model, storage key patterns, ER diagrams, sharing model, export envelopes, and deletion cascade |
| `packages/example/schemas/` | App-owned year-planner contracts: `planner.json`, `planner-preferences.json` |
| `packages/server/schemas/` | Shared server-side schemas: `preferences.json`, `appConfig.json`, `docIndex.json`, `org.json`, `orgMember.json`, `user.json` |
| `packages/core/index.js` | Public exports: `HLC`, `diff`, `merge`, `textMerge` |
| `packages/auth-core/` | `JwtSession` — JWT mint/verify helpers |
