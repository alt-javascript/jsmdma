# Requirements: jsmdma

**Defined:** 2026-03-28 (imported from .gsd on 2026-04-09)
**Core Value:** Field-level HLC conflict resolution that lets any number of clients go offline, make changes, and sync back without losing data

## Completed Requirements (M001–M010)

All requirements through M010 are validated. Listed here as the historical record.

### Sync Protocol

- [x] **PROTOCOL-01**: Bidirectional sync via POST /:application/sync — *validated M001–M004*
- [x] **PROTOCOL-02**: HLC causal ordering for conflict resolution — *validated M001*
- [x] **PROTOCOL-03**: Text auto-merge for concurrent string field edits — *validated M003*
- [x] **PROTOCOL-04**: Application-scoped routing and allowlist (unknown apps → 404) — *validated M003*
- [x] **PROTOCOL-05**: JSON Schema validation on push (invalid docs → 400 with per-field errors) — *validated M003*
- [x] **PROTOCOL-06**: JWT session with rolling refresh and TTL enforcement — *validated M002*
- [x] **PROTOCOL-07**: OAuth provider identity (Google, GitHub, Microsoft, Apple) — *validated M002*
- [x] **PROTOCOL-08**: Organisation tenancy with X-Org-Id header — *validated M004*
- [x] **PROTOCOL-09**: Storage namespacing: {userId}:{application}:{collection} — *validated M003*

### Core Engine

- [x] **CORE-01**: Dot-path fieldRevs for deeply nested documents — *validated M005*
- [x] **CORE-02**: flatten/unflatten utility (dot-path ↔ nested object) in packages/core — *validated M005*
- [x] **CORE-03**: diff.js operates on dot-path fieldRevs — *validated M005*
- [x] **CORE-04**: merge.js operates on dot-path fieldRevs — *validated M005*
- [x] **CORE-05**: SyncService works correctly with dot-path fieldRevs end-to-end — *validated M005*
- [x] **CORE-06**: ESM CDN bundle (dist/jsmdma-core.esm.js, <30KB, 7 exports) — *validated M006/M009*

### Schema & Application Config

- [x] **SCHEMA-01**: Year-planner application config registered in data-api — *validated M006*
- [x] **SCHEMA-02**: Planner JSON Schema at packages/server/schemas/planner.json — *validated M006*
- [x] **SCHEMA-03**: Planner document structure: sparse days map (not array), dot-path addressable — *validated M006*

### SyncClient & Pruning

- [x] **PRUNE-01**: Client-side local pruning without server-side delete (prune() resets baseClock to HLC.zero()) — *validated M009*
- [x] **PRUNE-02**: Server nodes prune and recover using the same zero-clock protocol — *validated M009*
- [x] **PRUNE-03**: SyncClient helper (edit/sync/prune/shouldPrune) in @alt-javascript/jsmdma-core — *validated M009*

### Data Model & Sharing

- [x] **MOD-01**: Entity relationship model (Mermaid ER diagrams + narrative) — *validated M007*
- [x] **MOD-02**: Storage namespace map (all key patterns formalised) — *validated M007*
- [x] **MOD-03**: JSON schemas for User, Org, OrgMember, DocIndex entry, AppConfig — *validated M007*
- [x] **MOD-04**: DocIndex: server-side ownership and visibility tracker — *validated M007*
- [x] **MOD-05**: Sharing model: private → shared → org → public — *validated M007*
- [x] **MOD-06**: Share token: server-issued UUID — *validated M007*
- [x] **MOD-07**: Org name uniqueness enforced instance-wide — *validated M007*
- [x] **MOD-08**: orgs.registerable instance config flag (default: false) — *validated M007*
- [x] **MOD-09**: OpenAPI spec for all endpoints (redocly lint exits 0) — *validated M007/M008*
- [x] **MOD-10**: Updated run-apps.js demonstrating full model (18+ scenarios) — *validated M007/M008*
- [x] **MOD-11**: Year-planner integration guide — *validated M007*

### ACL, Search, Export & Deletion

- [x] **ACL-01**: Read-side ACL enforcement in changesSince — *validated M008*
- [x] **ACL-02**: Cross-namespace shared doc aggregation in sync (server-side fan-out) — *validated M008*
- [x] **SRCH-01**: POST /:application/search with Filter AST body — *validated M008*
- [x] **SRCH-02**: Search respects ACL scoping — *validated M008*
- [x] **SRCH-03**: public visibility appears in open search; shareToken-only does not — *validated M008*
- [x] **EXP-01**: Per-user data export (GET /account/export) — *validated M008*
- [x] **EXP-02**: Per-org data export (GET /orgs/:orgId/export, org-admin only) — *validated M008*
- [x] **DEL-01**: User hard delete with full cascade — *validated M008*
- [x] **DEL-02**: Org hard delete with full cascade — *validated M008*

### Documentation

- [x] **DOC-01**: data-model.md updated for M008 additions — *validated M008*
- [x] **DOC-02**: openapi.yaml updated for all new endpoints — *validated M008*
- [x] **DOC-03**: run-apps.js scenarios for all M008 features (18 scenarios, exit 0) — *validated M008*
- [x] **DOC-04**: 19 ADR files in docs/decisions/ — *validated M009*
- [x] **DOC-05**: Six consumer-facing guide docs (sync-protocol, client-integration, sharing, search, export, deletion) — *validated M009*
- [x] **DOC-06**: Root README wired with Documentation section; packages/core README as npm-landing API reference — *validated M009*

### Publication Readiness

- [x] **PUB-01**: All packages renamed @alt-javascript/jsmdma-* at v1.0.0 — *validated M010*
- [x] **PUB-02**: publishConfig, homepage, repository in all six publishable packages — *validated M010*
- [x] **PUB-03**: ESM bundle renamed dist/jsmdma-core.esm.js — *validated M010*
- [x] **PUB-04**: Zero stale data-api references in source/docs — *validated M010*
- [x] **PUB-05**: Package READMEs for all six publishable packages — *validated M010*

## Next Milestone Requirements

*(To be defined — run `/gsd-new-milestone` to define M011 scope)*

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time push / WebSockets | Pull-based sync is the model; push adds complexity without clear benefit |
| Per-day document granularity | Dot-path addressing within one planner doc is sufficient |
| Deterministic JWT share tokens | UUID tokens sufficient; JWT approach designed as D004 upgrade path |
| CommonJS exports | ESM-only is a hard constraint; Node ≥ 20 |

## Traceability

| Requirement | Milestone | Status |
|-------------|-----------|--------|
| PROTOCOL-01–09 | M001–M004 | Complete |
| CORE-01–05 | M005 | Complete |
| CORE-06, SCHEMA-01–03 | M006 | Complete |
| MOD-01–11 | M007 | Complete |
| ACL-01–02, SRCH-01–03, EXP-01–02, DEL-01–02, DOC-01–03 | M008 | Complete |
| PRUNE-01–03, DOC-04–06 | M009 | Complete |
| PUB-01–05 | M010 | Complete |

**Coverage:**
- Completed requirements: 49 total
- All mapped and validated ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-28*
*Last updated: 2026-04-09 after import from .gsd (M001–M010 complete)*
