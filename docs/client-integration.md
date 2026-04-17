# Client Integration Guide

`SyncClient` is the offline-first sync state manager from `@alt-javascript/jsmdma-core`. It is isomorphic — it runs in browsers, Node.js, and edge runtimes with zero platform-specific dependencies.

This guide walks you through wiring up a complete offline-first sync loop from scratch.

---

## Installation

```bash
npm install @alt-javascript/jsmdma-core
```

```js
import {SyncClient} from 'packages/jsmdma-core';
```

`SyncClient` has no runtime dependencies beyond the other modules in `packages/core` (HLC, diff, merge). It does not use `localStorage`, `IndexedDB`, `fs`, or any other storage API — persistence is your responsibility (see [Persisting State](#persisting-state)).

---

## Creating a Client

Every client instance needs a stable **node identifier** — a string that uniquely identifies this device or session. A UUID is recommended.

### First run

```js
import { v4 as uuidv4 } from 'uuid'; // or crypto.randomUUID() in modern runtimes

const client = new SyncClient(uuidv4());
```

### Restore from a saved snapshot

```js
// Safe null guard — fromSnapshot(null) throws, so check first
const client =
  SyncClient.fromSnapshot(JSON.parse(localStorage.getItem('syncState') ?? 'null'))
  ?? new SyncClient(crypto.randomUUID());
```

> **Why the null guard?** `JSON.parse('null')` returns `null`, and `SyncClient.fromSnapshot(null)` will throw because it tries to read `snapshot.clock`. The `?? new SyncClient(...)` pattern handles the first-run case cleanly.

`SyncClient.fromSnapshot(snapshot)` derives the node ID from the stored `snapshot.clock` — you do not need to pass a node ID separately. The snapshot is the plain object previously returned by `client.getSnapshot()`.

---

## Recording Edits

Before sending changes to the server, tell the client what you edited:

```js
// After the user modifies a document in your local store:
client.edit('todos/1', { title: 'Buy milk', done: false });

// With an explicit wall-clock timestamp (useful in tests):
client.edit('todos/1', { title: 'Buy milk', done: true }, Date.now());
```

- **`key`** — a string that uniquely identifies the document within the collection (e.g. `'todos/1'`).
- **`currentDoc`** — the full current document object (application fields only, no `_` prefixes).
- **`wallMs`** (optional) — wall-clock milliseconds. Defaults to `Date.now()`.
- **Returns** `this` — chainable. Does not return the computed diff.

`edit()` ticks the local HLC, computes a field-level diff against the document's last-synced snapshot, and stamps every changed field with the new clock. Call `edit()` every time the user (or your application logic) mutates a document, before the next sync.

---

## Syncing

A sync is a single HTTP round-trip: push local changes, pull server changes.

### Build the request body

```js
const requestBody = {
  collection:  'todos',
  clientClock: client.baseClock,   // ← IMPORTANT: use baseClock, NOT clock
  changes:     client.getChanges(),
};
```

> **`baseClock` vs `clock`:**
> - `client.baseClock` is the `serverClock` from the most recent successful sync — the shared anchor the server uses to compute what changed on each side. **Always use this as `clientClock` in the request.**
> - `client.clock` is the client's own local HLC tick counter. Do not send it as `clientClock` — the server would interpret it as "the client has seen everything up to this local tick" which is incorrect.

`client.getChanges()` returns:

```js
[
  {
    key:       'todos/1',
    doc:       { title: 'Buy milk', done: true },
    fieldRevs: { title: '0019d2bc...', done: '0019d2bc...' },
    baseClock: '0000000000000-000000-00000000',  // from client.baseClock at time of getChanges()
  }
]
```

### POST to the server

```js
const response = await fetch(`/todo/sync`, {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify(requestBody),
});

const serverResponse = await response.json();
```

### Apply the server response

```js
const { serverChanges, conflicts } = client.sync(serverResponse);
```

`client.sync()` does all of the following in one call:

1. Merges each document in `serverChanges` into the local state using a 3-way merge (base = last-synced snapshot, local = your pending edits, remote = server version).
2. Advances `baseClock` to `serverResponse.serverClock`.
3. Advances the local HLC via `HLC.recv`.
4. Records `lastSyncAt`.

After calling `sync()`, save the snapshot (see [Persisting State](#persisting-state)) so the updated `baseClock` survives a page refresh.

### Apply server changes to your local store

`serverChanges` contains documents the server sent back. Apply them to wherever your application stores its documents:

```js
for (const serverDoc of serverChanges) {
  const key = serverDoc._key;
  // Strip _ protocol fields to get application fields
  const appFields = Object.fromEntries(
    Object.entries(serverDoc).filter(([k]) => !k.startsWith('_'))
  );
  myLocalStore.set(key, appFields);
}
```

---

## Persisting State

`SyncClient` is a pure in-memory object. You must save and restore it yourself. Call `getSnapshot()` after every `sync()` call (and optionally after `edit()` if you want crash recovery):

```js
// Save
localStorage.setItem('syncState', JSON.stringify(client.getSnapshot()));

// Restore (on startup)
const client =
  SyncClient.fromSnapshot(JSON.parse(localStorage.getItem('syncState') ?? 'null'))
  ?? new SyncClient(crypto.randomUUID());
```

`getSnapshot()` returns a plain serialisable object:

```js
{
  nodeId:     'my-device-uuid',            // extracted from the stored clock
  clock:      '0019d2bc1234a-000002-my-device-uuid',
  baseClock:  '0019d2bc1234b-000001-server-uuid',
  docs: {
    'todos/1': {
      doc:          { title: 'Buy milk', done: true },
      fieldRevs:    { title: '...', done: '...' },
      baseSnapshot: { title: 'Buy milk', done: false },
    }
  },
  lastSyncAt: 1700000000000,
}
```

> **Important:** If you call `edit()` but forget to call `getSnapshot()` and persist it before a crash, the client will re-send those same edits on restart. The server handles this correctly (it merges idempotently), but you may see duplicate-apply behaviour in your local UI.

---

## Pruning

When the client's local store grows too large, you can wipe it and force a full re-download on the next sync.

```js
// Check whether it is time to prune (e.g. last sync was more than 30 days ago)
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
if (client.shouldPrune(THIRTY_DAYS_MS)) {
  client.prune();
  // Persist the pruned state immediately
  localStorage.setItem('syncState', JSON.stringify(client.getSnapshot()));
}
```

**API:**

| Method | Signature | Description |
|---|---|---|
| `prune()` | `() → this` | Resets the entire client: clears `docs`, sets `baseClock` to `HLC.zero()`, clears `lastSyncAt`. Chainable. |
| `shouldPrune(thresholdMs)` | `(number) → boolean` | Returns `true` if the client has synced at least once **and** the last sync was more than `thresholdMs` ms ago. |

> **Note:** The implementation operates on the whole client, not per-document. `prune()` clears all documents. If you want to prune individual documents, remove them from `client.docs` directly after calling `getSnapshot()` — but this is an advanced use case and is not part of the stable API.

After calling `prune()`, the next sync will use `clientClock: HLC.zero()`, signalling to the server "I have seen nothing." The server returns the complete current state for the collection. See [Zero-Clock Full Pull](sync-protocol.md#zero-clock-full-pull) in the sync-protocol guide.

---

## Handling Conflicts

`client.sync(serverResponse)` returns `{ serverChanges, conflicts }`. The `conflicts` array surfaces fields where both the client and the server changed the same value since the last sync.

```js
const { serverChanges, conflicts } = client.sync(serverResponse);

for (const conflict of conflicts) {
  if (conflict.winner === 'auto-merged') {
    // Non-overlapping line changes were merged automatically — informational only
    console.info(`Field ${conflict.field} on ${conflict.key}: auto-merged`, conflict.winnerValue);
  } else {
    // One side lost — warn the user
    const losingValue = conflict.winner === 'local' ? conflict.remoteValue : conflict.localValue;
    console.warn(
      `Conflict on ${conflict.key}.${conflict.field}: ` +
      `${conflict.winner} won. Losing value: ${losingValue}`
    );
  }
}
```

**Conflict object shape:**

```js
{
  key:           'todos/1',            // document key
  field:         'notes',              // field path (dot-path for nested fields)
  localRev:      '0019d2bc...',        // client's HLC for this field
  remoteRev:     '0019d2bd...',        // server's HLC for this field
  localValue:    '- Client note',      // client's value at time of sync
  remoteValue:   '- Server note',      // server's value at time of sync
  winner:        'auto-merged',        // 'local' | 'remote' | 'auto-merged'
  winnerValue:   '- Client note\n- Server note',
  mergeStrategy: 'text-auto-merged',   // only present when winner === 'auto-merged'
}
```

The conflict is **already resolved** in the stored document — the `conflicts` array is provided so you can inform the user. When `winner` is `'local'` or `'remote'`, the losing value is gone from the server store and you should display a warning.

---

## Complete End-to-End Example

The following example shows a complete offline-first sync loop wiring all the steps together.

```js
import {SyncClient} from 'packages/jsmdma-core';

const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiJ9...';  // from your auth flow
const API_BASE = 'https://api.example.com';

// ─── 1. Restore or create the client ────────────────────────────────────────

let client =
    SyncClient.fromSnapshot(JSON.parse(localStorage.getItem('syncState') ?? 'null'))
    ?? new SyncClient(crypto.randomUUID());

// ─── 2. Record a local edit ──────────────────────────────────────────────────

// The user saves a document in your UI:
client.edit('todos/1', {title: 'Buy milk', done: false});

// Persist the new edit state immediately (crash safety)
localStorage.setItem('syncState', JSON.stringify(client.getSnapshot()));

// ─── 3. Sync with the server ─────────────────────────────────────────────────

async function sync(collection) {
    const requestBody = {
        collection,
        clientClock: client.baseClock,   // last serverClock received
        changes: client.getChanges(),
    };

    const response = await fetch(`${API_BASE}/todo/sync`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        throw new Error(`Sync failed: ${response.status}`);
    }

    const serverResponse = await response.json();

    // Apply the response — merges server changes, advances baseClock
    const {serverChanges, conflicts} = client.sync(serverResponse);

    // ─── 4. Persist updated state ──────────────────────────────────────────────
    localStorage.setItem('syncState', JSON.stringify(client.getSnapshot()));

    // ─── 5. Apply server documents to local store ─────────────────────────────
    for (const serverDoc of serverChanges) {
        const key = serverDoc._key;
        const appFields = Object.fromEntries(
            Object.entries(serverDoc).filter(([k]) => !k.startsWith('_'))
        );
        myLocalStore.set(key, appFields);  // your own storage abstraction
    }

    // ─── 6. Handle conflicts ───────────────────────────────────────────────────
    for (const conflict of conflicts) {
        if (conflict.winner === 'auto-merged') {
            console.info(`Auto-merged ${conflict.key}.${conflict.field}`);
        } else {
            const losing = conflict.winner === 'local' ? conflict.remoteValue : conflict.localValue;
            console.warn(`Conflict on ${conflict.key}.${conflict.field}: ${conflict.winner} won. Lost: ${losing}`);
        }
    }

    return {serverChanges, conflicts};
}

// ─── 7. Optional: check pruning on startup ────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
if (client.shouldPrune(THIRTY_DAYS_MS)) {
    client.prune();
    localStorage.setItem('syncState', JSON.stringify(client.getSnapshot()));
    // Next sync will automatically use clientClock: HLC.zero() for a full re-download
}

// ─── 8. Kick off a sync ────────────────────────────────────────────────────

await sync('todos');
```

---

## Org-Scoped Sync

To sync into an organisation's namespace rather than your personal namespace, add the `X-Org-Id` header to the fetch call:

```js
const response = await fetch(`${API_BASE}/todo/sync`, {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    'X-Org-Id':      'my-org-uuid',       // ← opt in to org namespace
  },
  body: JSON.stringify(requestBody),
});
```

Org-scoped and personal documents are stored in separate namespaces — sending `X-Org-Id` in one sync call does not affect your personal documents. The `SyncClient` instance itself is namespace-agnostic; you choose the namespace at fetch time.

---

## Cross-References

- [docs/sync-protocol.md](sync-protocol.md) — complete sync protocol reference: HLC format, request/response shapes, conflict resolution, zero-clock full pull, storage namespacing
- [docs/decisions/003-syncclient-in-core.md](decisions/003-syncclient-in-core.md) — why `SyncClient` is isomorphic and lives in `packages/core`
- [docs/decisions/004-pruning-protocol.md](decisions/004-pruning-protocol.md) — why pruning is a client-local compaction (no server endpoint needed)
