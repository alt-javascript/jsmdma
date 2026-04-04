# ADR-003: SyncClient is isomorphic and lives in packages/core

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

The year-planner browser client needs a clean abstraction for maintaining the per-document sync state: `baseClock` (the last server clock seen), per-field `fieldRevs` (HLC timestamps for each leaf value), and `baseSnapshot` (the document value at last sync, used for 3-way text merge). This state is protocol logic, not application logic.

Options considered:

1. **Embed in year-planner's StorageLocal.js** — Keep sync state management close to the persistence layer in the browser client. Fast to implement, but ties the sync protocol to one application's storage abstraction. A future mobile client would have to re-implement the same logic.

2. **Expose as a class in packages/server** — Centralised, but pulls a Node.js dependency graph into the browser bundle and prevents isomorphic use.

3. **Live in packages/core as an isomorphic module** — packages/core already contains HLC, merge, textMerge, and flatten — all of the protocol primitives. SyncClient is the stateful coordinator that uses them.

## Decision

`SyncClient` lives in `packages/core`. It is isomorphic (zero Node.js-specific imports) and exposes the following API:

| Method | Description |
|--------|-------------|
| `edit(key, patch, clock)` | Record a local field edit; updates fieldRevs and the local document |
| `sync(serverResponse)` | Apply a server sync response; advances baseClock and merges incoming changes |
| `prune(key)` | Drop local state for a document and reset its baseClock to `HLC.zero()` |
| `shouldPrune(key, thresholdMs)` | Returns true if the document's baseClock is older than the threshold |
| `getChanges()` | Returns the pending change set to send to the server |
| `getSnapshot()` | Serialises full in-memory state for caller-side persistence |
| `fromSnapshot(snapshot)` | Rehydrates state from a previously serialised snapshot |

**Persistence is the caller's responsibility.** SyncClient accepts and returns serialisable state snapshots but does not touch localStorage, IndexedDB, or any other storage API. This keeps the module testable without a DOM and reusable from server-side, mobile, or CLI clients.

## Consequences

**Positive:**
- Protocol logic (state tracking, clock advancement, merge orchestration) is co-located with HLC and merge in packages/core — the natural home for isomorphic protocol code.
- Fully testable with plain Mocha + Chai — no DOM, no mocks.
- Any future client (mobile, CLI, server-to-server) gets SyncClient for free from the same package.
- Snapshot API decouples persistence strategy from protocol correctness.

**Negative:**
- year-planner must adapt its existing `StorageLocal.js` to delegate sync state management to SyncClient rather than managing it directly. A small but real refactoring cost.
- The caller bears the operational burden of calling `getSnapshot()` and persisting it at the right time. Missing a persist after `edit()` can result in re-sending already-applied changes on restart.

**Risks:**
- If a caller forgets to call `fromSnapshot()` on startup, SyncClient starts with a zero clock and triggers a full pull on next sync. This is safe (the server returns complete current state) but wastes bandwidth for large document sets.
