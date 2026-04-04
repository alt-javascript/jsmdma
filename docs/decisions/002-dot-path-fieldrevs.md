# ADR-002: Dot-path flat fieldRevs for nested document HLC tracking

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Field-level conflict resolution (see ADR-001) requires a `fieldRevs` map that associates each tracked value with the HLC timestamp of its last write. The initial depth-1 model used top-level key names as map keys:

```json
{ "title": "0018f...abc", "notes": "0018f...def" }
```

This breaks for nested documents. Given a document like:

```json
{
  "meta": { "name": "Year Plan 2026", "color": "blue" },
  "days": { "2026-03-28": { "tp": 3, "notes": "standup" } }
}
```

Two devices editing `meta.name` and `days.2026-03-28.notes` respectively produce a revision entry for the same top-level key `meta` (or `days`). The merge engine sees a conflict at the top-level key even though the actual edits are to entirely disjoint leaf paths. One side's changes are silently lost.

## Decision

Replace depth-1 key names with a flat dot-path map where each key is the full path to a leaf value:

```json
{
  "meta.name":              "0018f...abc",
  "meta.color":             "0018f...aaa",
  "days.2026-03-28.tp":     "0018f...bbb",
  "days.2026-03-28.notes":  "0018f...def"
}
```

**Encoding rule:** Literal dots that appear inside a key segment (not as path separators) are percent-encoded as `%2E`. For example, a field named `file.name` at the top level becomes the path `file%2Ename` — unambiguously a single path segment, not two.

**Backward compatibility:** Depth-1 fieldRevs are valid dot-path maps where all paths happen to have length 1. Existing serialised data does not need migration.

**Wire format:** The wire representation is unchanged — `fieldRevs` remains an opaque JSON object in the HTTP payload. Only the merge engine changes: documents are flattened before field-level comparison and unflattened after merging.

## Consequences

**Positive:**
- Enables conflict-free independent edits to any two distinct leaf paths in a nested document.
- The planner's `days.YYYY-MM-DD.field` addressing model works without modification.
- Backward-compatible: depth-1 fieldRevs remain valid; no migration of existing stored revisions.
- Wire format unchanged — no breaking change to the HTTP API.

**Negative:**
- Path strings are longer than single field names for deeply nested documents.
- Large documents with many leaf paths produce proportionally larger `fieldRevs` maps. Acceptable given localStorage's ~5 MB budget and the bounded size of planner documents (~50 KB maximum for a full year).

**Risks:**
- Key-segment dots that are not percent-encoded would be misinterpreted as path separators. Any client that writes literal dots in key names without encoding them will produce incorrect merge results. Clients must use the provided `flatten`/`unflatten` utilities from `packages/core` rather than constructing fieldRevs manually.
