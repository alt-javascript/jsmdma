# Sharing Guide

This guide explains how to control who can read a document beyond its owner — using visibility levels, explicit per-user sharing, share tokens, and org-scoped access.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Visibility Levels](#2-visibility-levels)
3. [Reading the DocIndex Entry](#3-reading-the-docindex-entry)
4. [Setting Visibility and Sharing](#4-setting-visibility-and-sharing)
5. [Share Tokens](#5-share-tokens)
6. [Public vs Share-Token-Only](#6-public-vs-share-token-only)
7. [Org-Scoped Documents](#7-org-scoped-documents)
8. [Cross-References](#8-cross-references)

---

## 1. Overview

Every document written through the sync API gets a corresponding **DocIndex entry** created automatically on the first write. You do not need to call any endpoint to initialise it — the server creates it for you as part of the sync write flow.

The DocIndex entry tracks:

```json
{
  "docKey": "planner-2026",
  "userId": "owner-uuid",
  "app": "year-planner",
  "collection": "planners",
  "visibility": "private",
  "sharedWith": [],
  "shareToken": null,
  "createdAt": "2026-01-15T10:00:00.000Z",
  "updatedAt": "2026-01-15T10:00:00.000Z"
}
```

The `visibility` field controls who can read the document via `changesSince` and `POST /:application/search`. The default is `"private"`.

---

## 2. Visibility Levels

| Value | Who can read | Appears in search | Notes |
|---|---|---|---|
| `private` | Owner only | Owner only | Default. `sharedWith` entries are ignored. |
| `shared` | Owner + every `{userId, app}` pair in `sharedWith` | Owner + sharedWith users | Per-app scoped — see §4. |
| `org` | All members of the owner's org (same app) | Org members | Requires `X-Org-Id` header on sync requests. |
| `public` | Any authenticated user | Any authenticated user | Explicit opt-in to discoverability. |

---

## 3. Reading the DocIndex Entry

```
GET /docIndex/:app/:docKey
Authorization: Bearer <jwt>
```

Returns the full DocIndex entry for the authenticated owner.

**Responses:**

| Status | Meaning |
|---|---|
| 200 | Entry returned |
| 401 | Missing or invalid JWT |
| 404 | Entry not found (or caller is not the owner — see below) |

> **Why 404 instead of 403 for non-owners?**
> The DocIndex storage key embeds the requesting user's `userId` (`docIndex:{userId}:{app}:{docKey}`). A non-owner's `userId` does not match the owner's key, so the lookup genuinely returns nothing — the entry is not found from that caller's perspective. This prevents existence oracles and enumeration attacks. See [ADR-019](decisions/019-404-not-403-non-owner.md).

**Example:**

```http
GET /docIndex/year-planner/planner-2026
Authorization: Bearer eyJhbGci...
```

```json
{
  "docKey": "planner-2026",
  "userId": "user-abc",
  "app": "year-planner",
  "collection": "planners",
  "visibility": "shared",
  "sharedWith": [
    { "userId": "user-xyz", "app": "year-planner" }
  ],
  "shareToken": null,
  "createdAt": "2026-01-15T10:00:00.000Z",
  "updatedAt": "2026-01-16T08:30:00.000Z"
}
```

---

## 4. Setting Visibility and Sharing

```
PATCH /docIndex/:app/:docKey
Authorization: Bearer <jwt>
Content-Type: application/json
```

Owner-only. Update `visibility`, `sharedWith`, or both in a single request. Unspecified fields are left unchanged.

**Request body:**

```json
{
  "visibility": "shared",
  "sharedWith": [
    { "userId": "user-xyz", "app": "year-planner" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `visibility` | `string?` | One of `"private"`, `"shared"`, `"org"`, `"public"` |
| `sharedWith` | `Array<{userId, app}>?` | Entries to add. Each entry scopes the share to one application namespace. |

**Responses:**

| Status | Meaning |
|---|---|
| 200 | Updated entry returned |
| 400 | Invalid `visibility` value or malformed `sharedWith` |
| 401 | Missing or invalid JWT |
| 404 | Entry not found (or caller is not the owner) |

### `sharedWith` is per-application scoped

Each `{userId, app}` entry grants access only within the named application. Sharing a `year-planner` document with `user-xyz` does **not** grant that user access to any `todo` items. To share in another app, add a separate entry:

```json
{
  "sharedWith": [
    { "userId": "user-xyz", "app": "year-planner" },
    { "userId": "user-xyz", "app": "todo" }
  ]
}
```

This design is intentional — see [ADR-010](decisions/010-sharedwith-per-app.md).

**Example — make a document shared with one user:**

```http
PATCH /docIndex/year-planner/planner-2026
Authorization: Bearer eyJhbGci...
Content-Type: application/json

{
  "visibility": "shared",
  "sharedWith": [
    { "userId": "user-xyz", "app": "year-planner" }
  ]
}
```

**Example — make a document fully public:**

```http
PATCH /docIndex/year-planner/planner-2026
Authorization: Bearer eyJhbGci...
Content-Type: application/json

{ "visibility": "public" }
```

---

## 5. Share Tokens

A share token grants direct-link access to a specific document without requiring the recipient to be in `sharedWith`. The token is a UUID minted by the server.

### Mint a token

```
POST /docIndex/:app/:docKey/shareToken
Authorization: Bearer <jwt>
```

Owner-only. Returns the generated token.

```json
{ "shareToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

The token is stored on the DocIndex entry and returned once. Store it securely — there is no way to retrieve a previously minted token.

### Revoke a token

```
DELETE /docIndex/:app/:docKey/shareToken
Authorization: Bearer <jwt>
```

Owner-only. Sets `shareToken` to `null`. The token stops working immediately.

```json
{ "shareToken": null }
```

> **Share token format:** Currently a `crypto.randomUUID()` value stored in `docIndex.shareToken`. The documented future direction is a deterministic JWT signed with the instance secret, which would require no storage and be verifiable without a database lookup. See [ADR-014](decisions/014-share-token-uuid.md).

---

## 6. Public vs Share-Token-Only

These two mechanisms have different intent and are enforced separately:

| Mechanism | Accessible to | Appears in search |
|---|---|---|
| `visibility: "public"` | Any authenticated user | ✅ Yes |
| Share token (visibility ≠ `"public"`) | Anyone with the token | ❌ No |

Setting `visibility: "public"` is an explicit opt-in to discoverability — the document will appear in `POST /:application/search` results for any authenticated user.

Minting a share token does **not** make the document discoverable in search. A share token is for direct-link sharing ("anyone with the link can access it"), not broadcasting. A user who wants both search visibility and share-token access must set `visibility: "public"` **and** mint a token.

> This behaviour is non-revisable — conflating share-token access with search discoverability would violate users' privacy expectations for documents they intend to share only via direct link. See [ADR-016](decisions/016-search-visibility.md).

---

## 7. Org-Scoped Documents

When a document is stored with `visibility: "org"`, all authenticated members of the document owner's organisation can read it — but only within the same application namespace.

To store and sync org-scoped documents, include the `X-Org-Id` header on sync requests:

```http
POST /year-planner/sync
Authorization: Bearer <jwt>
X-Org-Id: org-uuid-here
Content-Type: application/json

{ ... }
```

Org membership is verified server-side against `OrgRepository`. A user who is not a member of the org will not receive org-scoped documents in `changesSince` or search results.

DocIndex entries for org-scoped documents follow the same management API — `GET`, `PATCH`, share-token mint and revoke — but the owner is the user who wrote the document, not the org itself.

---

## 8. Cross-References

- [ADR-008 — Server-side ACL enforcement](decisions/008-server-side-acl.md)
- [ADR-010 — sharedWith is scoped per application](decisions/010-sharedwith-per-app.md)
- [ADR-014 — Share token is a UUID (JWT as future direction)](decisions/014-share-token-uuid.md)
- [ADR-016 — public visibility appears in search; share-token-only does not](decisions/016-search-visibility.md)
- [ADR-019 — Non-owner DocIndex access returns 404, not 403](decisions/019-404-not-403-non-owner.md)
- [Data Model Reference — §7 Sharing Model](data-model.md#7-sharing-model)
