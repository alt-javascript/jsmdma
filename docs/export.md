# Export Guide

This guide explains how to export all data for a user account or an organisation using the structured JSON export endpoints.

---

## Table of Contents

1. [User Export](#1-user-export)
2. [Org Export](#2-org-export)
3. [Collection Discovery Semantics](#3-collection-discovery-semantics)
4. [Recommended Workflow](#4-recommended-workflow)
5. [Cross-References](#5-cross-references)

---

## 1. User Export

```
GET /account/export
Authorization: Bearer <jwt>
```

Returns all data for the authenticated user as a single JSON download.

**Envelope shape:**

```json
{
  "user": {
    "userId": "uuid",
    "email": "alice@example.com",
    "providers": [
      { "provider": "google", "providerUserId": "1234567890" }
    ]
  },
  "docs": {
    "year-planner": {
      "planners": [
        { "_key": "planner-2026", "meta": { "name": "Year Plan" }, "_rev": "...", "_fieldRevs": { ... } }
      ]
    },
    "todo": {
      "tasks": [
        { "_key": "task-1", "title": "Buy milk", "_rev": "...", "_fieldRevs": { ... } }
      ]
    }
  },
  "docIndex": [
    {
      "docKey": "planner-2026",
      "userId": "uuid",
      "app": "year-planner",
      "collection": "planners",
      "visibility": "shared",
      "sharedWith": [ { "userId": "user-xyz", "app": "year-planner" } ],
      "shareToken": null,
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-01-16T08:30:00.000Z"
    }
  ]
}
```

The `docs` map is structured as `{ appName: { collectionName: [documents] } }`, mirroring the storage namespace. Empty apps and empty collections are pruned — only collections the user has actually written to are included.

The `docIndex` array contains the ACL metadata for every document, including `visibility` and `sharedWith`. This is needed for a full-fidelity restore.

**Responses:**

| Status | Meaning |
|---|---|
| 200 | Export envelope returned |
| 401 | Missing or invalid JWT |
| 404 | User record not found (e.g. after deletion) |

---

## 2. Org Export

```
GET /orgs/:orgId/export
Authorization: Bearer <jwt>
```

Returns all data for the organisation. **Requires org-admin role.**

**Envelope shape:**

```json
{
  "org": {
    "orgId": "uuid",
    "name": "Acme Corp",
    "createdBy": "uuid",
    "createdAt": "2026-01-10T09:00:00.000Z"
  },
  "members": [
    { "orgId": "uuid", "userId": "uuid", "role": "org-admin", "joinedAt": "2026-01-10T09:01:00.000Z" },
    { "orgId": "uuid", "userId": "uuid", "role": "member", "joinedAt": "2026-01-12T14:00:00.000Z" }
  ],
  "docs": {
    "year-planner": {
      "planners": [
        { "_key": "org-planner-2026", "meta": { "name": "Org Year Plan" }, "_rev": "...", "_fieldRevs": { ... } }
      ]
    }
  }
}
```

The `docs` map covers org-scoped documents stored under the `org:{orgId}:{app}:{collection}` namespace. Empty apps and collections are pruned.

Note that the org export does **not** include a `docIndex` key — DocIndex entries are stored per document owner, not per org.

**Responses:**

| Status | Meaning |
|---|---|
| 200 | Export envelope returned |
| 401 | Missing or invalid JWT |
| 403 | Caller is not an org-admin |
| 404 | Organisation not found |

---

## 3. Collection Discovery Semantics

The two endpoints use different strategies to discover which collections to include:

| Export type | Discovery strategy |
|---|---|
| User (`/account/export`) | Derives collections from `docIndex.listByUser()` — only collections the user has written to are included |
| Org (`/orgs/:orgId/export`) | Enumerates all configured collections from `ApplicationRegistry` — all app/collection combinations declared in the server config are checked |

**Practical implication:** If you add a new collection to your application config but no org documents have been written to it yet, it will not appear in a user export (no `docIndex` entries) but will appear as an empty collection in an org export (config-driven enumeration). Empty collections are pruned from both envelopes, so neither case produces `[]` arrays in the output.

---

## 4. Recommended Workflow

Export before deleting to preserve an archive and confirm the data shape:

```
# User account
GET  /account/export         → save as archive.json
DELETE /account              → 204 No Content
GET  /account/export         → 404 (confirmed deleted)

# Organisation
GET  /orgs/:orgId/export     → save as org-archive.json
DELETE /orgs/:orgId          → 204 No Content
GET  /orgs/:orgId/export     → 404 (confirmed deleted)
```

The `404` on the final `GET` confirms that the deletion cascade completed successfully and the identity record was removed.

> **Warning:** Deletion is synchronous and irreversible. Once `DELETE /account` or `DELETE /orgs/:orgId` returns `204`, all data has been permanently removed — there is no undo. Always export first. See [docs/deletion.md](deletion.md) for cascade details.

---

## 5. Cross-References

- [ADR-018 — Structured JSON envelope for data export](decisions/018-export-format.md)
- [Deletion Guide](deletion.md)
- [Data Model Reference — §8 Data Export](data-model.md#8-data-export)
