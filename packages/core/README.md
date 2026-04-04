# @alt-javascript/data-api-core

Isomorphic offline-first sync state for the data-api ecosystem. Zero Node.js dependencies — runs in browsers, Node.js, and edge runtimes.

## Install

```bash
npm install @alt-javascript/data-api-core
```

## Quick Example

```js
import { SyncClient } from '@alt-javascript/data-api-core';

// Restore from storage or start fresh
const stored = localStorage.getItem('sync-snapshot');
const snapshot = stored ? JSON.parse(stored) : null;
const client = SyncClient.fromSnapshot(snapshot) ?? new SyncClient('device-abc');

// Record a local edit
client.edit('todos/1', { title: 'Buy milk', done: false });

// Build the POST body — use client.baseClock as clientClock
const payload = {
  clientClock: client.baseClock,
  changes: client.getChanges(),
};

// POST to server, then apply the response
const serverResponse = await fetch('/apps/myapp/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then(r => r.json());

client.sync(serverResponse);

// Persist updated state
localStorage.setItem('sync-snapshot', JSON.stringify(client.getSnapshot()));
```

## API: SyncClient

### `new SyncClient(nodeId, wallMs?)`

Create a new client with a stable unique node identifier (UUID or device ID). `wallMs` is an optional initial wall-clock time (defaults to `0`).

```js
const client = new SyncClient('device-abc');
```

### `client.edit(key, doc, wallMs?)`

Record a local edit for the document at `key`. Ticks the HLC, diffs against the last-synced snapshot, and stamps changed fields with the new clock. Chainable.

```js
client.edit('todos/1', { title: 'Buy milk', done: false });
```

### `client.getChanges()`

Return all pending local changes as a sync payload array. Each entry includes `key`, `doc`, `fieldRevs`, and `baseClock`.

```js
const changes = client.getChanges();
// [{ key: 'todos/1', doc: {...}, fieldRevs: {...}, baseClock: '000...' }]
```

### `client.sync(serverResponse, wallMs?)`

Apply a server sync response, merging remote changes with local state. Advances `baseClock` to `serverClock`. Returns `{ serverChanges, conflicts }`.

```js
const { conflicts } = client.sync(serverResponse);
```

### `client.prune()`

Reset the client to a clean slate — clears all local docs and resets `baseClock`. Chainable. Useful after a full server re-download or storage quota pressure. Takes no arguments.

```js
client.prune();
```

### `client.shouldPrune(thresholdMs)`

Return `true` if the client has synced at least once and the last sync was more than `thresholdMs` milliseconds ago. Takes one argument (the threshold).

```js
if (client.shouldPrune(7 * 24 * 60 * 60 * 1000)) {
  client.prune();
}
```

### `client.getSnapshot()`

Return a plain-object snapshot of all client state suitable for serialisation and later restoration.

```js
const snapshot = client.getSnapshot();
localStorage.setItem('sync-snapshot', JSON.stringify(snapshot));
```

### `SyncClient.fromSnapshot(snapshot)`

Restore a `SyncClient` from a previously serialised snapshot. **`fromSnapshot(null)` throws** — always use the null guard pattern:

```js
const client = SyncClient.fromSnapshot(snapshot) ?? new SyncClient(nodeId);
```

## API: HLC

Hybrid Logical Clock — encodes as a lexicographically orderable hex string usable as a NoSQL sort key.

### `HLC.create(nodeId, wallMs?)`

Create a new HLC string for a node, optionally seeded with a wall-clock time.

### `HLC.tick(clock, wallMs?)`

Advance a local clock for a send or local event.

### `HLC.recv(local, remote, wallMs?)`

Advance the local clock upon receiving a remote message — advances beyond both clocks.

### `HLC.zero()`

Return the minimum HLC string (`'000...000-000000-00000000'`). Means "I have seen nothing yet."

### `HLC.compare(a, b)`

Compare two HLC strings. Returns `-1`, `0`, or `1`.

```js
import { HLC } from '@alt-javascript/data-api-core';

const clock = HLC.create('device-abc', Date.now());
const next  = HLC.tick(clock, Date.now());
```

## Other Exports

| Export | Purpose |
|---|---|
| `diff(base, current, fieldRevs, clock)` | Compute field-level diff between base and current document |
| `merge(base, local, remote)` | 3-way field-level merge with HLC conflict resolution |
| `textMerge(base, local, remote)` | Line-level text auto-merge for non-overlapping string changes |
| `flatten(obj)` | Flatten a nested object to dot-notation keys |
| `unflatten(obj)` | Restore a dot-notation flat object to nested form |

## ESM Bundle

```bash
npm run build
```

Produces `dist/data-api-core.esm.js` — less than 30 kB, no external dependencies. Suitable for direct `<script type="module">` use or bundler import.

## Further Reading

- [Client Integration Guide](../../docs/client-integration.md) — full offline-first sync loop walkthrough
- [Sync Protocol Reference](../../docs/sync-protocol.md) — wire format, clock semantics, and server contract
