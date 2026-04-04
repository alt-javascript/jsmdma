# ADR-018: Structured JSON envelope for data export

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

data-api exposes export endpoints for user accounts (`GET /account/export`) and organisations (`GET /orgs/:orgId/export`). The system needs to decide the response format for these exports.

The main alternatives considered were:

- **Flat array of all documents** — return `[{ ...doc, _app, _collection, _userId }]`. Simple to produce, but loses the hierarchical structure that distinguishes applications and collections. Difficult for a human to inspect or selectively restore.
- **NDJSON stream** — return one JSON object per line, streamed. Efficient for very large exports and avoids loading all data into memory. Adds client-side parsing complexity (streaming JSON rather than `JSON.parse`) with no benefit at the expected data volumes for a personal or small-team deployment.
- **Structured JSON envelope** — a single JSON object with nested maps: `{ user/org, docs: { appName: { collectionName: [docs] } }, docIndex: [...] }`. Mirrors the storage namespace structure, is human-readable, and parseable with a single `JSON.parse`.

## Decision

Use a structured JSON envelope for both export endpoints.

**User export** (`GET /account/export`):

```json
{
  "user": { "userId": "uuid", "email": "...", "providers": [...] },
  "docs": {
    "year-planner": {
      "planners": [{ "_key": "planner-2026", ... }]
    },
    "todo": {
      "tasks": [{ "_key": "task-1", ... }]
    }
  },
  "docIndex": [
    {
      "docKey": "planner-2026",
      "userId": "uuid",
      "app": "year-planner",
      "collection": "planners",
      "visibility": "shared"
    }
  ]
}
```

**Org export** (`GET /orgs/:orgId/export`):

```json
{
  "org": { "orgId": "uuid", "name": "Acme Corp", "createdBy": "uuid", "createdAt": "ISO8601" },
  "members": [
    { "orgId": "uuid", "userId": "uuid", "role": "org-admin", "joinedAt": "ISO8601" }
  ],
  "docs": {
    "year-planner": {
      "planners": [{ "_key": "org-planner-2026", ... }]
    }
  }
}
```

Empty applications and collections are pruned from the envelope. User export discovers collections from `docIndex.listByUser()`; org export enumerates all configured collections from `ApplicationRegistry`.

Source: DECISIONS.md D012; `docs/data-model.md § 8 Data Export`.

## Consequences

**Positive:**
- The nested `{ appName: { collectionName: [docs] } }` structure mirrors the storage namespace, making it straightforward to understand what collection each document came from.
- Human-readable and machine-parseable with standard JSON tools. No streaming parser needed.
- The envelope is self-contained: a single download captures all data, including the `docIndex` ACL metadata required for full fidelity restore.

**Negative:**
- Synchronous single-request export loads all data into memory before responding. For very large accounts this may be slow and memory-intensive.

**Risks:**
- If export sizes become problematic, NDJSON streaming can be added as an alternative response format negotiated via `Accept: application/x-ndjson` — the envelope format is then the default and streaming is opt-in. See DECISIONS.md D012.
