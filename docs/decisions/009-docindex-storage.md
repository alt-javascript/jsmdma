# ADR-009: DocIndex as a separate storage collection

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Each document stored in data-api needs associated ownership and visibility metadata: who owns it, which app and collection it belongs to, its visibility level, who it is shared with, and whether a share token is active. The system needs to decide where this metadata lives.

The main alternatives considered were:

- **Inline metadata on the document** — store `_visibility`, `_sharedWith`, `_shareToken` as reserved fields on the document itself. Simple, but metadata leaks into the application payload and is returned to all syncing clients (including shared recipients who should not see the `sharedWith` list of other users).
- **Embedded metadata on the user record** — maintain a list of all document keys and their visibility on the `User` entity. Creates unbounded growth on the user record and requires loading the full user every time any document's ACL is checked.
- **Separate `docIndex` collection** — a dedicated collection with key `docIndex:{userId}:{app}:{docKey}` stores ACL metadata, completely separate from the application data namespace.

## Decision

Store document ownership and visibility metadata in a separate `docIndex` collection. Each entry has the key `docIndex:{userId}:{app}:{docKey}` and the shape:

```json
{
  "docKey": "string",
  "userId": "uuid",
  "app": "string",
  "collection": "string",
  "visibility": "private | shared | org | public",
  "sharedWith": [{ "userId": "uuid", "app": "string" }],
  "shareToken": "uuid | null",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

Cross-namespace lookup — finding all documents accessible to a given user — becomes a clean query against the `docIndex` collection without scanning any application document. `DocIndexRepository.listAccessibleDocs()` queries by `userId` or by presence in `sharedWith` without touching the document storage namespaces.

Source: DECISIONS.md D005; `docs/data-model.md § 5 DocIndex`, `§ 6 Storage Key Reference`.

## Consequences

**Positive:**
- ACL metadata is fully separated from application data. Clients receive only document payloads; visibility metadata stays server-side.
- Cross-namespace queries (e.g. "all docs shared with Bob") are O(index size) rather than requiring a full scan of every user's document namespaces.
- The compound key `docIndex:{userId}:{app}:{docKey}` allows O(1) lookup when the full coordinates are known and supports prefix scans by `userId` or `userId:app`.

**Negative:**
- Every document write requires an additional write to `docIndex` to create or update the entry. Two-phase writes are not atomic in the current storage abstraction.
- The `docIndex` collection must be kept consistent with the document collection; a delete that removes the document but not its `docIndex` entry leaves stale ACL records.

**Risks:**
- Stale `docIndex` entries after partial failures. Mitigated by the deletion cascade in `DELETE /account` and `DELETE /orgs/:orgId` (see `docs/data-model.md § 9`), which explicitly removes all `docIndex` entries as part of the cascade.
