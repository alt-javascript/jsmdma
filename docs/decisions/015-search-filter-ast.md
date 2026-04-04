# ADR-015: Search endpoint uses jsnosqlc Filter AST as request body

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

data-api needs a search endpoint that allows clients to query documents within an application. The system needs to decide the shape of the query interface.

The main alternatives considered were:

- **Query string parameters** — `GET /:application/search?field=meta.name&op=contains&value=Plan`. Familiar REST convention but tightly limited: no compound queries, no AND/OR/NOT composition, no nested conditions. A single field/op/value triple is insufficient for real search requirements.
- **Custom JSON query language** — define a bespoke filter DSL for the API. Expressive but adds a translation layer between the API surface and the storage query engine, and creates a new schema to document and evolve.
- **jsnosqlc Filter AST** — use the existing storage abstraction's filter format directly as the request body. The `{ type, field, op, value }` node (and compound `and/or/not` nodes) is already the native query language for the underlying store, used internally by `changesSince` and all repository methods.

## Decision

`POST /:application/search` accepts a jsnosqlc Filter AST as its JSON request body. The filter is fully composable:

```json
{ "type": "filter", "field": "meta.name", "op": "contains", "value": "Plan" }
```

Compound queries:

```json
{
  "type": "and",
  "filters": [
    { "type": "filter", "field": "meta.name", "op": "contains", "value": "Plan" },
    { "type": "filter", "field": "visibility", "op": "eq", "value": "public" }
  ]
}
```

The server ANDs the client-supplied filter with the ACL constraints derived from `listAccessibleDocs()` before executing the query. The client filter therefore cannot bypass visibility enforcement — ACL is always applied additively.

Source: DECISIONS.md D010; `docs/data-model.md § 7 Sharing Model`.

## Consequences

**Positive:**
- The full expressiveness of the storage query engine is available to clients without additional translation. Any filter the store supports is supported by the endpoint.
- ACL enforcement is additive (server-side AND): arbitrary client filters are safe because the server always restricts results to the caller's accessible document set.
- No new query format to document or evolve — the jsnosqlc Filter AST is already documented as part of the storage abstraction.

**Negative:**
- Using `POST` for a query operation is unconventional REST. Caching at the HTTP layer (e.g. CDN) is not possible.
- Clients must understand the jsnosqlc Filter AST format, which is more complex than a simple query string.

**Risks:**
- If a simpler query interface is needed for read-only or browser clients, a GET overload with query string parameters can be added alongside the existing POST endpoint without a breaking change. See DECISIONS.md D010.
