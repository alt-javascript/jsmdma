# ADR-001: Hybrid Logical Clock (HLC) for conflict resolution

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

An offline-first sync system must resolve write conflicts when the same document field is modified independently on two or more devices while offline. The system needs a causality mechanism that:

1. Requires no coordination between nodes at write time.
2. Keeps bounded, constant-size state per node (regardless of the number of peers).
3. Produces a total order that can be used directly as a NoSQL sort key.
4. Works in a browser environment (no Node.js-specific dependencies).

The main alternatives considered were:

- **Vector clocks** — correct, but grow linearly with the number of participants; state size is unbounded in open peer sets.
- **Lamport timestamps** — bounded, but offer no relationship to wall-clock time, making them unreadable in debugging and useless for time-ranged queries.
- **Last-write-wins on wall clock** — simple, but subject to clock skew; two devices with even modestly skewed clocks can silently lose writes.

## Decision

Use a Hybrid Logical Clock (HLC) as specified by Kulkarni et al. ("Logical Physical Clocks", 2014). Each node maintains a single HLC state `{ ms, seq, node }`, encoded as a zero-padded hex string:

```
<13-hex-ms>-<6-hex-seq>-<node>
```

- **13 hex digits for ms** — covers ~8,925 years from epoch (2^52 ms).
- **6 hex digits for seq** — supports up to 16,777,215 causally ordered events per millisecond.
- **node** — arbitrary stable identifier (UUID short-form recommended).

The encoded string is lexicographically ordered and preserves causal ordering, making it safe to use as a NoSQL sort key or filter comparator without decoding.

### Sentinel value

`HLC.zero()` returns `0000000000000-000000-00000000` — the minimum possible HLC string. All real clocks compare greater than this. It is used as the initial `baseClock` for a client that has never synced (i.e., "I have seen nothing yet").

### Clock operations

| Operation | When used |
|-----------|-----------|
| `HLC.tick(current, wallMs)` | Before sending a local write; advances to `max(local.ms, wall)` and increments seq |
| `HLC.recv(local, remote, wallMs)` | On receiving a message; advances beyond both local and remote clocks |
| `HLC.merge(a, b)` | Returns the greater of two encoded strings — used to pick the winning field revision |
| `HLC.compare(a, b)` | Lexicographic comparison; returns -1 / 0 / 1 |

### Server-side merge protocol

`SyncService.sync()` applies a three-way per-field merge:

```
clientChanged  = HLC.compare(clientFieldRevs[f], baseClock) > 0
serverChanged  = HLC.compare(serverFieldRevs[f], baseClock) > 0
```

| clientChanged | serverChanged | Resolution |
|:---:|:---:|---|
| ✗ | ✗ | Keep server value (no-op) |
| ✓ | ✗ | Client wins — apply client value |
| ✗ | ✓ | Server wins — return server value to client |
| ✓ | ✓ | Both changed — attempt text auto-merge (non-overlapping line hunks); if successful, store merged text and advance clock to `HLC.merge(clientRev, serverRev)`; otherwise, HLC winner wins |

`baseClock` is the `serverClock` returned by the previous successful sync — the anchor that determines what each side changed relative to a shared point in time.

## Consequences

**Positive:**
- Constant state per node (O(1)) — no growth with peer count.
- Lexicographic string sort preserves causal order; HLC strings work directly as DynamoDB/MongoDB sort keys.
- Combined wall-clock + logical counter keeps timestamps human-readable in logs and dashboards.
- Per-field granularity: independent field edits on two devices produce no conflict; only true concurrent overwrites of the same field go to resolution.
- `HLC.zero()` as a sentinel eliminates the need for null checks in the merge logic — the zero clock is always less than any real timestamp.

**Negative:**
- Requires all devices to participate in the HLC protocol (tick on write, recv on pull). A non-participating writer silently breaks causality.
- Clock skew beyond a session boundary can cause a later event to appear causally earlier — mitigated by the `recv` operation advancing the clock on every sync.

**Risks:**
- Node identifier collision: two devices generating the same node id would cause ambiguous seq counters. Mitigated by using `crypto.randomUUID()` for node ids.
