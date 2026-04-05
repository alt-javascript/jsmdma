# Sync Protocol

The jsmdma bidirectional sync protocol lets any number of clients (browser tabs, mobile devices, Node.js processes) maintain local document copies and reconcile changes with a central server. Clients can work fully offline; conflicts are resolved automatically using field-level revision tracking.

---

## Overview

- **Offline-first** — the client holds a local document store and edits it without contacting the server. Sync happens in a single HTTP round-trip when connectivity is available.
- **Field-level merge** — instead of comparing whole documents, every leaf field carries an independent revision timestamp. Two devices that edit different fields of the same document never produce a conflict.
- **HLC-based causal ordering** — revisions are Hybrid Logical Clock (HLC) strings, not wall-clock timestamps. HLC strings preserve causality even when device clocks disagree, and they sort lexicographically so they can be used directly as NoSQL sort keys.

---

## HLC Basics

### Encoded format

Every revision is an HLC string with three dash-separated segments:

```
<13-hex-ms>-<6-hex-seq>-<node>

Example: 0019d2bc1234a-000001-client-uuid
         │             │      │
         │             │      └── stable node identifier (UUID or short ID)
         │             └───────── logical sequence counter (hex, 6 digits)
         └─────────────────────── wall-clock milliseconds (hex, 13 digits)
```

- **13 hex ms digits** — covers wall time to year ~143,000,000 from epoch (2⁵² ms).
- **6 hex seq digits** — up to 16,777,215 causally ordered events per millisecond.
- **node** — any stable unique string for this device or session (UUID short-form recommended).

Lexicographic string comparison preserves causal order: `a > b` in string comparison means "a happened causally after b". This means HLC strings can be used directly in NoSQL range queries (`Filter.where('_rev').gt(clientClock)`) without decoding.

### Sentinel value — `HLC.zero()`

`HLC.zero()` returns the minimum possible HLC string:

```
0000000000000-000000-00000000
```

Every real clock is greater than this value. It is used as the initial `baseClock` for a client that has never synced — meaning "I have seen nothing from the server."

### Clock roles

| Name | Where it lives | What it means |
|---|---|---|
| `baseClock` | Client | The `serverClock` from the most recent successful sync. Acts as the shared anchor: changes with a revision **above** this were made after the last sync. |
| `clientClock` | Sync request | The client's `baseClock` sent to the server — tells the server "return everything you have that's newer than this." |
| `serverClock` | Sync response | The server's current HLC after processing the request. The client stores this as its new `baseClock`. |

---

## POST /:application/sync

### Request

The `:application` segment must match a key in the server's configured `applications` block. Unknown application names return `404`. A valid JWT is required; unauthenticated requests return `401`.

```http
POST /todo/sync
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "collection":  "tasks",
  "clientClock": "0019d2bc1234a-000001-client-uuid",
  "changes": [
    {
      "key":       "task-1",
      "doc":       { "title": "Buy milk", "done": false },
      "fieldRevs": { "title": "0019d2bc1234a-000001-client-uuid" },
      "baseClock": "0019d2bc0000a-000000-server-uuid"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `collection` | string | Which collection to sync within the application |
| `clientClock` | HLC string | The client's `baseClock` — the last `serverClock` it received. Use `HLC.zero()` to request all documents ("I have seen nothing"). |
| `changes` | array | Local changes to push. May be empty for a pull-only sync. |
| `changes[].key` | string | Document primary key |
| `changes[].doc` | object | Current local document (application fields only; no `_` prefixes) |
| `changes[].fieldRevs` | object | Per-field HLC revisions: `{ "fieldPath": "hlcString", ... }` (dot-path format for nested fields) |
| `changes[].baseClock` | HLC string | The `serverClock` from when the client last received this document |

### Response

```json
{
  "serverClock": "0019d2bc1234b-000001-server-uuid",
  "serverChanges": [
    {
      "_key":       "task-1",
      "_rev":       "0019d2bc1234b-000001-server-uuid",
      "_fieldRevs": { "title": "0019d2bc1234a-000001-client-uuid", "done": "..." },
      "title":      "Buy milk",
      "done":       false
    }
  ],
  "conflicts": [
    {
      "key":           "task-1",
      "field":         "notes",
      "localRev":      "0019d2bc1234a-000001-client-uuid",
      "remoteRev":     "0019d2bc1234b-000001-server-uuid",
      "localValue":    "- Client note",
      "remoteValue":   "- Server note",
      "winner":        "auto-merged",
      "winnerValue":   "- Client note\n- Server note",
      "mergeStrategy": "text-auto-merged"
    }
  ]
}
```

| Field | Description |
|---|---|
| `serverClock` | Server's updated HLC. Store this as your new `baseClock`. |
| `serverChanges` | All documents modified on the server since your `clientClock`. Application fields plus `_key`, `_rev`, `_fieldRevs` protocol fields. |
| `conflicts` | Fields where both sides changed since `baseClock`. The conflict is already resolved in the stored document — the `conflicts` array is informational. |
| `conflicts[].winner` | `'local'`, `'remote'`, or `'auto-merged'` |
| `conflicts[].mergeStrategy` | Present only when `winner === 'auto-merged'`; value is `'text-auto-merged'` |

### Schema validation errors

When JSON Schema validation is configured for a collection, invalid documents return `400`:

```json
{
  "error":   "Schema validation failed",
  "details": [
    { "key": "task-1", "field": "title", "message": "must have required property 'title'" }
  ]
}
```

---

## Conflict Resolution

A conflict occurs when **both** the client and the server changed the same field since the client's `baseClock`. The server detects this by comparing per-field revision timestamps:

```
clientChanged = clientFieldRevs[field] > baseClock
serverChanged = serverFieldRevs[field] > baseClock
```

| clientChanged | serverChanged | Resolution |
|:---:|:---:|---|
| ✗ | ✗ | Keep server value (no-op) |
| ✓ | ✗ | Client wins — store client value |
| ✗ | ✓ | Server wins — return server value to client |
| ✓ | ✓ | **Both changed** — attempt text auto-merge; if that fails, higher HLC wins |

**Text auto-merge (string fields):** Both values are split into lines and diffed against the base. If the local and remote change-sets produce non-overlapping hunks (neither side edited the same line), both sets of edits are applied and the conflict entry reports `winner: 'auto-merged'` with `mergeStrategy: 'text-auto-merged'`. This is an informational result — no data was lost.

**HLC winner fallback:** When hunks overlap, or for non-string fields, the side with the higher HLC string wins. Equal HLC → local wins as a stable tie-break. The conflict entry reports `winner: 'local'` or `winner: 'remote'`. Warn the user — the losing value is gone.

See [docs/decisions/001-hlc-conflict-resolution.md](decisions/001-hlc-conflict-resolution.md) for the full ADR and [docs/decisions/002-dot-path-fieldrevs.md](decisions/002-dot-path-fieldrevs.md) for how nested document fields are tracked.

---

## Zero-Clock Full Pull

Sending `clientClock: HLC.zero()` tells the server "I have seen nothing." The server returns its complete current state for the collection. Use this in two cases:

1. **New device** — the client's initial `baseClock` is always `HLC.zero()` before the first sync.
2. **After pruning** — when the client calls `client.prune()`, it resets `baseClock` to `HLC.zero()`. The next sync fetches the full current state from the server, which is safe because the server always holds authoritative current state.

The server does not distinguish between "new device" and "pruned device" — both present `clientClock: HLC.zero()` and receive the same full-pull response.

---

## Storage Namespacing

All server-side storage keys include the user identifier and application to guarantee isolation. No two users can read each other's documents even if they use the same application and collection names.

### Personal namespace (no `X-Org-Id` header)

```
{userId}:{application}:{collection}
e.g.  alice-uuid:todo:tasks
```

### Org-scoped namespace (`X-Org-Id: <orgId>` header)

```
org:{orgId}:{application}:{collection}
e.g.  org:3f7b...a1:todo:tasks
```

- The `org:` prefix is unambiguous — user IDs are UUIDs and never start with `org:`.
- Personal and org namespaces are completely isolated, even for the same user.
- Non-members attempting org-scoped sync receive `403 { error: 'Not a member of organisation: ...' }`.

**Percent-encoding:** If a segment value (userId, orgId, application, or collection name) contains a literal colon, it is percent-encoded as `%3A` before being used as a storage key component.

---

## Cross-References

- [docs/decisions/001-hlc-conflict-resolution.md](decisions/001-hlc-conflict-resolution.md) — HLC design, clock operations, and merge protocol ADR
- [docs/decisions/002-dot-path-fieldrevs.md](decisions/002-dot-path-fieldrevs.md) — dot-path flat `fieldRevs` for nested documents
- [docs/data-model.md](data-model.md) — data model: document structure, DocIndex, storage layouts
