# ADR-011: Cross-namespace fan-out for shared documents in changesSince

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

The sync model gives each user their own document namespace (`{userId}:{app}:{collection}`). When a document is shared with another user, that document lives in the owner's namespace — not the recipient's. The recipient's `changesSince` call only queries their own namespace by default.

The system needs to decide how shared documents reach the recipient's sync client.

The main alternatives considered were:

- **Copy-on-share** — when a document is shared, copy it into the recipient's namespace. Keeps the sync read path simple, but creates data divergence: the recipient's copy is stale the moment the owner edits the original. Bidirectional sync between copies adds significant complexity.
- **Client pull from explicit namespace list** — the client maintains a list of foreign namespaces to pull from (e.g., Alice's namespace). Requires clients to know other users' identifiers, breaks the single-endpoint model, and exposes namespace enumeration to untrusted clients.
- **Server-side fan-out from docIndex** — the server, when processing a `changesSince` request for user Bob, queries `docIndex` for all entries accessible to Bob (by `sharedWith` match, org membership, or `public` visibility) and fetches documents from their respective owner namespaces, merging results with Bob's own documents before responding.

## Decision

Use server-side fan-out from `docIndex`. When `SyncService.sync()` runs for user Bob:

1. Query `docIndex` for all entries where Bob is in `sharedWith`, the document is `org`-visible and Bob is an org member, or the document is `public`.
2. Group the resulting entries by `(entry.userId, entry.collection)` to avoid N+1 storage queries — all shared docs from the same owner collection are fetched in a single `changesSince` call.
3. For each `(owner, collection)` group, call `changesSince(ownerNamespace, baseClock)` and filter returned documents to only those whose `_key` is in the accessible set.
4. Merge the cross-namespace results with Bob's own `changesSince` results and return the combined set.

The client has a single sync endpoint and no knowledge of other users' namespaces.

Source: DECISIONS.md D009, D014; `docs/data-model.md § 7 Sharing Model`.

## Consequences

**Positive:**
- Clients require no changes to benefit from shared documents — the fan-out is entirely server-side and transparent.
- Grouping by `(owner, collection)` reduces the number of storage queries from O(shared docs) to O(distinct owner×collection pairs), avoiding N+1 for the common case of multiple shared docs from one owner.
- The single-endpoint design preserves the offline-first model: clients do not need to enumerate peers or maintain foreign namespace state.

**Negative:**
- The `docIndex` scan for a user with many shared/public documents adds latency proportional to the number of accessible entries.
- Cross-namespace fan-out requires the server to hold results from multiple storage namespaces in memory before responding.

**Risks:**
- At scale, the O(accessible docs) docIndex scan may become a bottleneck. Mitigated by the documented future direction: replace the scan with a materialised push index (maintained on every share write) for O(1) lookup. See DECISIONS.md D009.
