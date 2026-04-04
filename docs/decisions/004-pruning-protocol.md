# ADR-004: Pruning is a client-local compaction; server treats pruned clients as new devices

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

localStorage has a ~5 MB budget. Clients accumulate planner data across years. Without compaction, a long-lived client will eventually exhaust storage. Pruning must:

1. Reclaim space on the local device.
2. Not affect server state or propagate any delete to other devices.
3. Require no new protocol surface or server endpoint.

Options considered:

- **Server-side tombstone / delete endpoint** — client sends a "I pruned planner X" message; server marks documents as deleted and propagates to other devices. Overly complex: introduces tombstone management, increases protocol surface, and risks unintended deletion on peers.
- **Time-to-live (TTL) sweep** — server ages out documents automatically. Changes semantics from "sync what the user has" to "auto-delete old data" — a different system with different guarantees.
- **Pure client-local compaction using the zero-clock protocol** — no new server endpoint; the existing full-pull path (triggered by `clientClock: HLC.zero()`) already handles this case correctly.

## Decision

Pruning is purely client-local. The sequence:

1. Drop all local state for the pruned planner: the stored document, its `fieldRevs`, and its `baseSnapshot`.
2. Reset the stored `baseClock` for that planner to `HLC.zero()`.
3. On the next sync, send `clientClock: HLC.zero()` to the server.

The server interprets `clientClock: HLC.zero()` as "client has seen nothing" and returns the full current document state — the same path taken by a brand new device. No server state is modified. No other device receives any notification.

**Symmetric mesh:** Server nodes that prune their own local store follow the identical protocol — they send `clientClock: HLC.zero()` to any peer and receive a full pull in response. All nodes are peers; "I don't have this locally" is represented as "I have seen nothing" (zero clock).

## Consequences

**Positive:**
- No new server endpoint, no new protocol messages. Zero server-side complexity.
- Symmetric — the same mechanism works for any node type (browser, server replica, CLI).
- Safe: the server always has the authoritative current state. Pruning a client simply causes it to re-download that state on next sync.
- Other devices are completely unaffected.

**Negative:**
- A pruned client loses its `baseSnapshot` for pruned planners. If the same document is edited offline on the pruned client and on another device before the next sync, text auto-merge falls back to HLC-winner-wins rather than a true 3-way merge. Acceptable for old, infrequently-edited data.
- Next sync after pruning transfers the full document, not just a delta. For a large year-planner (~50 KB) this is a single round-trip with no user-visible delay.

**Risks:**
- A caller that prunes and then edits the document offline before syncing will accumulate field revisions based on a zero base clock. On sync, all fields appear as "client changed since last sync", which is correct — the server will resolve each field against its current state using the normal three-way merge.
