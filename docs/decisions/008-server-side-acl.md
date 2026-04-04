# ADR-008: Server-side ACL enforcement

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Documents in data-api can be private, shared with specific users, shared with an org, or fully public. The system needs to decide where visibility rules are evaluated: in the client, in the server request handler, or in a dedicated layer.

The main alternatives considered were:

- **Client-enforced ACL** — each client checks visibility before displaying data. Simple to implement but completely untrustworthy: any client can be modified to bypass visibility checks and read any data it can reach.
- **Inline handler checks** — each route handler queries visibility inline, with the logic duplicated across `changesSince`, `search`, and any future read endpoints. Fragile: a new endpoint forgetting the check silently exposes all data.
- **Server-layer ACL via DocIndex** — a dedicated `DocIndex` collection stores visibility metadata per document, and all read paths consult it through a single `listAccessibleDocs()` gate before returning data.

## Decision

Enforce document ACL at the server layer. Every document tracked by the sync service has a corresponding `DocIndex` entry that records `visibility`, `sharedWith`, and `shareToken`. All read paths — `changesSince` and `POST /:application/search` — call `listAccessibleDocs()` before fetching document payloads. This function applies visibility rules:

| `visibility` value | Who may read |
|---|---|
| `private` | Owner only |
| `shared` | Owner + every `{userId, app}` pair in `sharedWith` |
| `org` | All members of the owner's org for the same app |
| `public` | Any authenticated user |

The server holds the only authoritative copy of `DocIndex`, and clients cannot modify it directly. ACL decisions are therefore not delegable to untrusted endpoints.

Source: DECISIONS.md D001; DocIndex entity shape in `docs/data-model.md § 5`.

## Consequences

**Positive:**
- ACL enforcement is centralised: adding a new read endpoint only requires calling `listAccessibleDocs()` — no per-route duplication.
- Clients are untrusted by design. A compromised or modified client cannot bypass visibility checks because the server never returns documents outside the caller's ACL scope.
- `listAccessibleDocs()` can be evolved independently — e.g. adding row-level policy or attribute-based access control — without changing any route handler.

**Negative:**
- Every read path incurs a `docIndex` lookup before returning application data. In memory-backed deployments this is negligible; with a remote NoSQL store it adds a round-trip.
- ACL state is authoritative only on the server. Clients must re-sync to discover that their access to a document has been revoked.

**Risks:**
- A future endpoint that bypasses `listAccessibleDocs()` would silently expose data. Mitigated by centralising the gate in `SyncService` rather than scattering it across handlers.
