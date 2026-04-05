# ADR-017: Hard delete with no tombstone

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

jsmdma must support account and organisation deletion. The system needs to decide the deletion model: hard delete, soft delete with tombstone, or async sweep.

The main alternatives considered were:

- **Soft delete / tombstone** — mark records as deleted (`deletedAt` timestamp, `status: 'deleted'`); a background sweep removes them later. Allows undo windows and audit trails, but requires all read paths to filter out tombstoned records, adds sweep complexity, and leaves personally identifiable information in the database longer than necessary — a liability under GDPR right-to-erasure semantics.
- **Async cascade with event queue** — publish a `user.deleted` event; a background worker cascades deletes through related collections asynchronously. Decouples the delete from the HTTP response, but creates a window where the user is "deleted" in auth but their documents are still accessible. Adds queue infrastructure with no identified benefit for current scale.
- **Synchronous hard delete** — remove all records immediately and in full within the DELETE handler. The HTTP response is returned only after all data has been removed.

## Decision

Use synchronous hard delete with no tombstone and no async sweep. The `DELETE /account` and `DELETE /orgs/:orgId` handlers cascade through all associated data in a defined sequence before returning `204`:

**User deletion cascade:**
1. For each configured app: list `docIndex` entries via `listByUser`, group by collection, delete all personal documents and all `docIndex` entries.
2. Remove all org membership records.
3. Remove all OAuth provider index entries.
4. Delete the user identity record.

**Org deletion cascade:**
1. For each configured app: enumerate collections from `ApplicationRegistry`, delete all org-scoped documents (`org:{orgId}:{app}:{collection}`).
2. Remove all org membership records.
3. Release the org name uniqueness reservation in `orgNames`.
4. Delete the org identity record.

Source: DECISIONS.md D011; `docs/data-model.md § 9 Account & Org Deletion`.

## Consequences

**Positive:**
- Satisfies GDPR right-to-erasure semantics: once `DELETE /account` returns `204`, no PII remains in the database.
- No sweep infrastructure, no tombstone filtering in read paths, no async consistency windows.
- The cascade sequence is deterministic and auditable — all data removed within a single synchronous request.

**Negative:**
- Deletion is irreversible the moment the handler completes. There is no undo window, no soft-delete recovery, no audit trail.
- For large accounts (many documents across many collections), the synchronous cascade may take significant time to complete.

**Risks:**
- A partial cascade failure (e.g., crash after deleting documents but before deleting the user record) leaves orphan records. The recommended mitigation is to run `GET /account/export` before `DELETE /account` to confirm data shape, then verify deletion with a subsequent `GET /account/export` that returns `404`. See `docs/data-model.md § 9`.
