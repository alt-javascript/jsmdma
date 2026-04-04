# ADR-006: Planner UUID is client-generated at creation time

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Planner documents need a stable key in the `planners` collection that is known before any network round-trip occurs. The key is used as:

1. The document key in the sync collection (`{userId}:year-planner:planners`).
2. The localStorage key prefix for local persistence (`plnr:{uuid}`).
3. The anchor for per-document sync state (`baseClock`, `fieldRevs`, `baseSnapshot`).

Options considered:

- **Server-assigned UUID on first sync** — Clean in principle; the server is the authority on document identity. In practice, requires a network round-trip before the planner can be used offline. If the device creates a planner while offline, it has no stable key until it reconnects — blocking all local operations.

- **Client-generated UUID at creation time** — The planner is immediately usable offline. The UUID is written to localStorage and used as the sync key on first successful sync. No server round-trip needed for creation.

## Decision

The client generates a UUID using `crypto.randomUUID()` at planner creation time. This UUID is:

- The document key stored in the sync collection on the server.
- The localStorage key prefix for all local planner data.
- Stable for the lifetime of the planner — never reassigned by the server.

The server never assigns document IDs. On first sync, the client sends the client-generated UUID as the document key. The server stores it without modification.

## Consequences

**Positive:**
- Offline-first: planners are fully usable — created, edited, and read — before any network connection is established.
- No round-trip dependency for creation. The UX path (create → use → sync when online) is unblocked.
- Collision probability with UUIDv4 is astronomically low (~5.3 × 10⁻³⁶ per pair of UUIDs) — negligible in practice.
- Simple: no server endpoint needed for ID assignment, no provisional → final ID transition logic.

**Negative:**
- Two devices creating a planner while offline could theoretically generate the same UUID. In the event of a collision at the storage layer, last-write-wins on the document key. One planner's data would silently overwrite the other's on first sync.

**Risks:**
- `crypto.randomUUID()` is only available in secure contexts (HTTPS or localhost) and in modern runtimes. Older browsers or non-secure origins would need a polyfill. All target environments for year-planner are HTTPS or localhost, so this is not an active concern.
