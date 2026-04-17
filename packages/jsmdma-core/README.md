# @alt-javascript/jsmdma-core

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-core)](https://www.npmjs.com/package/@alt-javascript/jsmdma-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Isomorphic offline-first sync state for the jsmdma ecosystem. Zero Node.js dependencies — runs in browsers, Node.js, and edge runtimes.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-core
```

## Quick Example

```js
import {SyncClient} from '@alt-javascript/jsmdma-core';

// Restore from storage or start fresh
const stored = localStorage.getItem('sync-snapshot');
const snapshot = stored ? JSON.parse(stored) : null;
const client = SyncClient.fromSnapshot(snapshot) ?? new SyncClient('device-abc');

// Record a local edit
client.edit('todos/1', {title: 'Buy milk', done: false});

// Build the POST body — use client.baseClock as clientClock
const payload = {
    clientClock: client.baseClock,
    changes: client.getChanges(),
};

// POST to server, then apply the response
const serverResponse = await fetch('/apps/myapp/sync', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
}).then(r => r.json());

client.sync(serverResponse);

// Persist updated state
localStorage.setItem('sync-snapshot', JSON.stringify(client.getSnapshot()));
```

## API: SyncClient

| Method | Description |
|---|---|
| `new SyncClient(nodeId, wallMs?)` | Create a new client. `nodeId` is a stable UUID or device ID. |
| `client.edit(key, doc, wallMs?)` | Record a local edit. Diffs against last-synced snapshot, stamps changed fields with current HLC. Chainable. |
| `client.getChanges()` | Return all pending local changes as a sync payload array. |
| `client.sync(serverResponse, wallMs?)` | Apply a server sync response. Advances `baseClock`. Returns `{ serverChanges, conflicts }`. |
| `client.prune()` | Reset the client to a clean slate — clears all local docs, resets `baseClock`. Chainable. |
| `client.shouldPrune(thresholdMs)` | Return `true` if the last sync was more than `thresholdMs` ago. |
| `client.getSnapshot()` | Return a serialisable plain-object snapshot of all client state. |
| `SyncClient.fromSnapshot(snapshot)` | Restore a client from a snapshot. Returns `null` if snapshot is null — use the `?? new SyncClient(nodeId)` guard. |

### Important: use `client.baseClock` as `clientClock`

`baseClock` is the last `serverClock` received — the shared anchor that tells the server "return changes newer than my last confirmed sync." Sending `client.clock` (the local tick counter) instead will produce incorrect results.

```js
const payload = {
  clientClock: client.baseClock,  // ✓ correct
  changes: client.getChanges(),
};
```

## API: HLC

Hybrid Logical Clock — encodes as a lexicographically orderable hex string usable as a NoSQL sort key.

| Method | Description |
|---|---|
| `HLC.create(nodeId, wallMs?)` | Create a new HLC string. |
| `HLC.tick(clock, wallMs?)` | Advance a local clock for a send or local event. |
| `HLC.recv(local, remote, wallMs?)` | Advance the local clock upon receiving a remote message. |
| `HLC.zero()` | Return the minimum HLC string — means "I have seen nothing yet." |
| `HLC.compare(a, b)` | Compare two HLC strings. Returns `-1`, `0`, or `1`. |

```js
import {HLC} from '@alt-javascript/jsmdma-core';

const clock = HLC.create('device-abc', Date.now());
const next = HLC.tick(clock, Date.now());
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

Produces `dist/jsmdma-core.esm.js` — under 30 kB, no external dependencies. Suitable for direct `<script type="module">` use or bundler import.

## Further Reading

- [Client Integration Guide](../../docs/client-integration.md)
- [Sync Protocol Reference](../../docs/sync-protocol.md)

## License

MIT
