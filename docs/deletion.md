# Deletion Guide

This guide explains how hard delete works for user accounts and organisations, the cascade order, idempotency behaviour, and the recommended export-first workflow.

---

## Table of Contents

1. [User Deletion](#1-user-deletion)
2. [Org Deletion](#2-org-deletion)
3. [Idempotency](#3-idempotency)
4. [Recommended Workflow](#4-recommended-workflow)
5. [Cross-References](#5-cross-references)

---

## 1. User Deletion

```
DELETE /account
Authorization: Bearer <jwt>
```

Permanently deletes the authenticated user account and all associated data. The delete is **synchronous** — `204` is returned only after the full cascade completes.

**Cascade order:**

1. For each configured application: list `docIndex` entries via `listByUser`, group by collection, delete all personal documents, delete all docIndex entries
2. Remove all org membership records (from every org the user belongs to)
3. Remove all OAuth provider identity links (`{provider}:{providerUserId}` keys)
4. Delete the user identity record

**Responses:**

| Status | Meaning |
|---|---|
| 204 | Account and all data deleted |
| 401 | Missing or invalid JWT |

There is no response body on `204`.

> **Irreversible.** Once `DELETE /account` returns `204`, no personally identifiable information remains in the database. There is no tombstone, undo window, or soft-delete recovery. See [ADR-017](decisions/017-hard-delete.md).

---

## 2. Org Deletion

```
DELETE /orgs/:orgId
Authorization: Bearer <jwt>
```

Permanently deletes the organisation and all associated data. **Requires org-admin role.** The delete is **synchronous** — `204` is returned only after the full cascade completes.

**Cascade order:**

1. For each configured application: enumerate collections from `ApplicationRegistry`, delete all org-scoped documents (`org:{orgId}:{app}:{collection}` namespace)
2. Remove all org membership records
3. Release the org name uniqueness reservation (from the `orgNames` collection)
4. Delete the org identity record

**Responses:**

| Status | Meaning |
|---|---|
| 204 | Organisation and all data deleted |
| 401 | Missing or invalid JWT |
| 403 | Caller is not an org-admin |
| 404 | Organisation not found |

There is no response body on `204`.

> **Irreversible.** Once `DELETE /orgs/:orgId` returns `204`, all org data has been permanently removed. Org membership records are deleted — members are not notified. The org name reservation is released and can be re-registered by another user.

---

## 3. Idempotency

Both endpoints are safe to call on already-deleted entities:

- `DELETE /account` on a non-existent user: the cascade attempts to delete records that no longer exist. NoSQL deletes against missing keys are no-ops, so the operation completes without error and returns `204`.
- `DELETE /orgs/:orgId` on a non-existent org: the route returns `404` because the org existence check happens before the cascade. If the org record was deleted mid-cascade (partial failure scenario), re-running the delete is safe — any remaining orphan records are cleaned up by the subsequent cascade steps.

> **Partial cascade failure:** If the server crashes after deleting documents but before deleting the identity record, orphan records may exist. The recommended recovery is to re-run `DELETE /account` (or `DELETE /orgs/:orgId`). The second call will clean up any remaining records because all cascade steps are idempotent against missing data.

---

## 4. Recommended Workflow

Always export your data before deleting. Use the final `GET` to confirm the deletion completed successfully.

```
# User account deletion
GET  /account/export         → save archive.json (includes docs and docIndex)
DELETE /account              → 204 No Content
GET  /account/export         → 404 (confirmed: identity record removed)

# Organisation deletion
GET  /orgs/:orgId/export     → save org-archive.json
DELETE /orgs/:orgId          → 204 No Content
GET  /orgs/:orgId/export     → 404 (confirmed: org record removed)
```

The `404` on the final `GET` confirms that the cascade reached the identity record (the last step) and the deletion is complete.

> The export endpoint returns `404` after deletion because the user or org record is checked first. If the cascade fails mid-way and the identity record is not yet deleted, the export `GET` returns the remaining data (not `404`), which signals an incomplete deletion that should be retried.

---

## 5. Cross-References

- [ADR-017 — Hard delete with no tombstone](decisions/017-hard-delete.md)
- [Export Guide](export.md)
- [Data Model Reference — §9 Account & Org Deletion](data-model.md#9-account--org-deletion)
