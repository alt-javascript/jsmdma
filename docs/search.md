# Search Guide

This guide explains how to query documents using `POST /:application/search`, the Filter AST format, compound query composition, and how ACL enforcement interacts with search results.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Request Body](#2-request-body)
3. [Filter AST — Leaf Nodes](#3-filter-ast--leaf-nodes)
4. [Compound Queries](#4-compound-queries)
5. [ACL Enforcement](#5-acl-enforcement)
6. [Search Discoverability](#6-search-discoverability)
7. [Cross-References](#7-cross-references)

---

## 1. Overview

```
POST /:application/search
Authorization: Bearer <jwt>
Content-Type: application/json
```

The search endpoint queries documents within a specific application. The `:application` path segment must match a configured application name — unknown applications return `404`.

ACL enforcement mirrors the sync endpoint: `search` uses the same `listAccessibleDocs()` gate as `changesSince`. A caller only ever receives documents they are authorised to read — private docs from other users are never returned, regardless of what filter is supplied.

---

## 2. Request Body

```json
{
  "collection": "planners",
  "filter": { "type": "filter", "field": "meta.name", "op": "contains", "value": "Plan" }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `collection` | `string` | ✅ | Collection name within the application |
| `filter` | `object` | ✅ | Filter AST node (leaf or compound). Must have a `type` field. |

**Response:**

```json
{ "results": [ { "_key": "planner-2026", "meta": { "name": "Year Plan" }, ... } ] }
```

**Error responses:**

| Status | Meaning |
|---|---|
| 400 | Missing `collection`, missing/invalid `filter`, or filter missing `type` field |
| 401 | Missing or invalid JWT |
| 404 | Unknown application name |

---

## 3. Filter AST — Leaf Nodes

A leaf node filters on a single field:

```json
{
  "type": "filter",
  "field": "meta.name",
  "op": "contains",
  "value": "Plan"
}
```

| Property | Description |
|---|---|
| `type` | Always `"filter"` for a leaf node |
| `field` | Dot-path to the field to match (e.g. `"status"`, `"meta.priority"`) |
| `op` | Comparison operator (see table below) |
| `value` | Value to compare against |

### Supported operators

| Operator | Meaning |
|---|---|
| `eq` | Equal |
| `ne` | Not equal |
| `contains` | String contains (case-sensitive substring match) |
| `gt` | Greater than |
| `gte` | Greater than or equal |
| `lt` | Less than |
| `lte` | Less than or equal |

The Filter AST is the native query format of jsnosqlc — the storage abstraction used internally by the sync engine. The full expressiveness of the store is available to callers; no translation layer is applied.

**Example — find all high-priority tasks:**

```json
{
  "collection": "tasks",
  "filter": {
    "type": "filter",
    "field": "priority",
    "op": "eq",
    "value": "high"
  }
}
```

---

## 4. Compound Queries

Combine leaf nodes using `and`, `or`, and `not` to express multi-condition queries.

### `and` — all conditions must match

```json
{
  "type": "and",
  "filters": [
    { "type": "filter", "field": "status", "op": "eq", "value": "open" },
    { "type": "filter", "field": "priority", "op": "eq", "value": "high" }
  ]
}
```

### `or` — at least one condition must match

```json
{
  "type": "or",
  "filters": [
    { "type": "filter", "field": "status", "op": "eq", "value": "open" },
    { "type": "filter", "field": "status", "op": "eq", "value": "in-progress" }
  ]
}
```

### `not` — condition must not match

```json
{
  "type": "not",
  "filters": [
    { "type": "filter", "field": "status", "op": "eq", "value": "done" }
  ]
}
```

### Nested composition

`and`, `or`, and `not` nodes can be nested to arbitrary depth:

```json
{
  "type": "and",
  "filters": [
    { "type": "filter", "field": "status", "op": "eq", "value": "open" },
    {
      "type": "or",
      "filters": [
        { "type": "filter", "field": "priority", "op": "eq", "value": "high" },
        { "type": "filter", "field": "dueDate", "op": "lt", "value": "2026-04-01" }
      ]
    }
  ]
}
```

**Full request example — open tasks that are high-priority or overdue:**

```http
POST /todo/search
Authorization: Bearer eyJhbGci...
Content-Type: application/json

{
  "collection": "tasks",
  "filter": {
    "type": "and",
    "filters": [
      { "type": "filter", "field": "status", "op": "eq", "value": "open" },
      {
        "type": "or",
        "filters": [
          { "type": "filter", "field": "priority", "op": "eq", "value": "high" },
          { "type": "filter", "field": "dueDate", "op": "lt", "value": "2026-04-01" }
        ]
      }
    ]
  }
}
```

---

## 5. ACL Enforcement

The search endpoint enforces the same ACL rules as the sync `changesSince` endpoint. Before executing your filter, the server calls `listAccessibleDocs()` and ANDs its result with your filter:

```
effective query = your filter AND (own docs OR accessible cross-namespace docs)
```

The accessible document set includes:

- All documents the caller owns (any visibility)
- Documents shared with the caller via `sharedWith` (visibility `"shared"`)
- Documents from orgs the caller belongs to (visibility `"org"`, when `X-Org-Id` is provided)
- Documents with `visibility: "public"` from any owner

Your filter **cannot bypass** ACL enforcement — it is always applied additively by the server. A caller cannot retrieve documents outside their authorised scope by crafting a filter that matches private documents belonging to other users.

---

## 6. Search Discoverability

Which documents appear in search results from other users depends on `visibility`:

| Visibility | Appears in other users' search results |
|---|---|
| `private` | ❌ No |
| `shared` | Only for users listed in `sharedWith` for this app |
| `org` | Org members only |
| `public` | ✅ Yes — any authenticated user |
| Share token only (visibility ≠ `"public"`) | ❌ No |

> **Important:** Minting a share token does **not** make a document discoverable in search. A share token is for direct-link access only. To make a document appear in search results, set `visibility: "public"`. See [ADR-016](decisions/016-search-visibility.md) and [docs/sharing.md §6](sharing.md#6-public-vs-share-token-only).

---

## 7. Cross-References

- [ADR-015 — Search endpoint uses jsnosqlc Filter AST](decisions/015-search-filter-ast.md)
- [ADR-016 — public visibility appears in search; share-token-only does not](decisions/016-search-visibility.md)
- [Sharing Guide — visibility levels and share tokens](sharing.md)
