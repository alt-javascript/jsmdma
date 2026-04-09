# Roadmap: jsmdma

**Project:** Offline-first, bidirectional data sync API
**Core Value:** Field-level HLC conflict resolution — clients go offline, sync back, no data lost

---

## Completed Milestones

### ✅ M001 — Offline-First Sync Engine: Core Protocol & Hono Server

**Goal:** Working bidirectional sync with HLC conflict resolution over HTTP.

**Delivered:** Sync endpoint (POST /:application/sync), HLC clock, field diff, merge engine, text auto-merge, Hono server wiring, jsnosqlc in-memory storage adapter, run.js two-device demo.

**Requirements:** PROTOCOL-01, PROTOCOL-02, PROTOCOL-03, PROTOCOL-09

---

### ✅ M002 — OAuth Identity: Provider Login, UUID Identity, Provider Linking

**Goal:** Stateless JWT authentication with OAuth provider support.

**Delivered:** HS256 JWT sessions with idle/hard TTL and rolling refresh, OAuth adapters (Google, GitHub, Microsoft, Apple), provider linking/unlinking, UUID user identity.

**Requirements:** PROTOCOL-06, PROTOCOL-07

---

### ✅ M003 — Application-Scoped Sync: Text Auto-Merge, Multi-App Routing, Schema Validation

**Goal:** Multi-application support with schema validation at the sync boundary.

**Delivered:** ApplicationRegistry (unknown apps → 404), JSON Schema validation (invalid docs → 400), application-scoped namespacing, text auto-merge for non-overlapping string edits.

**Requirements:** PROTOCOL-03, PROTOCOL-04, PROTOCOL-05, PROTOCOL-09

---

### ✅ M004 — Organisation Tenancy: App-Agnostic Orgs, Membership, Role Management

**Goal:** Multi-tenant org model with membership and roles.

**Delivered:** X-Org-Id header routing, org-scoped storage namespace (org:{orgId}:{app}:{collection}), membership management, admin/member roles.

**Requirements:** PROTOCOL-08

---

### ✅ M005 — Deep Nested Document Support: Dot-Path fieldRevs & Recursive Merge

**Goal:** Field-level conflict resolution for deeply nested documents (year-planner day entries).

**Delivered:** Dot-path flat fieldRevs map ({a.b.c: hlcString}), flatten/unflatten utilities, updated diff.js and merge.js, backward compatibility with depth-1 fieldRevs, SyncService integration test with nested planner doc.

**Requirements:** CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, SYNC-01, SYNC-02

---

### ✅ M006 — Planner Schema & Application Config

**Goal:** Year-planner app wired into the data-api with JSON Schema validation.

**Delivered:** year-planner app config (planners collection), planner JSON Schema (packages/server/schemas/planner.json), sparse days-map document structure, ESM bundle (dist/jsmdma-core.esm.js, <30KB, esbuild pipeline).

**Requirements:** SCHEMA-01, SCHEMA-02, SCHEMA-03, CORE-06

---

### ✅ M007 — Data Model, Relationships & Sharing Design

**Goal:** Formal entity model, DocIndex infrastructure, sharing write-side API, OpenAPI spec, integration guide.

**Delivered:** Mermaid ER diagrams + narrative (data-model.md), storage namespace map, JSON schemas for all entity types, DocumentIndexRepository with upsertOwnership, four-level sharing model (private/shared/org/public), share token (UUID), DocIndexController, org name uniqueness (orgNames index), orgs.registerable flag, OpenAPI 3.1.0 spec (18 endpoints), year-planner integration guide, run-apps.js updated (Scenarios 1–12).

**Requirements:** MOD-01–11

---

### ✅ M008 — Data API: ACL Enforcement, Search, Export & Deletion

**Goal:** Complete read-side ACL, search, GDPR export, and hard delete.

**Delivered:** listAccessibleDocs() ACL helper, SyncService cross-namespace fan-out (Scenario 13), POST /:application/search with jsnosqlc Filter AST + ACL gating (Scenario 14), GET /account/export and GET /orgs/:orgId/export (Scenarios 15–16), DELETE /account and DELETE /orgs/:orgId with full cascade (Scenarios 17–18), OpenAPI updated (23 endpoints), data-model.md Sections 7–9, run-apps.js 18 scenarios all exit 0. 557 tests.

**Requirements:** ACL-01, ACL-02, SRCH-01, SRCH-02, SRCH-03, EXP-01, EXP-02, DEL-01, DEL-02, DOC-01, DOC-02, DOC-03

---

### ✅ M009 — SyncClient & Documentation

**Goal:** Isomorphic SyncClient in packages/core, full ADR coverage, consumer-facing guide docs.

**Delivered:** SyncClient class (edit/sync/prune/shouldPrune/getChanges/getSnapshot/fromSnapshot) with 69 Mocha tests; SyncClient exported from @alt-javascript/jsmdma-core; PRUNE-01/02/03 + CORE-06 validated; 19 ADR files (docs/decisions/); six consumer guide docs (sync-protocol, client-integration, sharing, search, export, deletion); root README wired with Documentation section; packages/core README as npm-landing API reference. 539 tests passing.

**Requirements:** PRUNE-01, PRUNE-02, PRUNE-03, DOC-04, DOC-05, DOC-06

---

### ✅ M010 — Rename, Package Publication Readiness, and Documentation Refresh

**Goal:** Rename all packages to @alt-javascript/jsmdma-*, bump to v1.0.0, publish-ready with READMEs.

**Delivered:** All 8 packages renamed to @alt-javascript/jsmdma-*; 6 publishable packages with publishConfig + homepage + repository metadata at v1.0.0; ESM bundle renamed dist/jsmdma-core.esm.js; 221 stale data-api references scrubbed; root README rewritten with badges; READMEs for all 6 publishable packages. 160 tests passing.

**Requirements:** PUB-01, PUB-02, PUB-03, PUB-04, PUB-05

---

## Next Steps

All planned milestones complete. The project is publish-ready.

**Possible next milestones:**
- npm publish to `@alt-javascript/jsmdma-*`
- Additional consumer application support (beyond year-planner)
- Performance / scale hardening (materialised push index for docIndex fan-out)
- Cloudflare Workers / Lambda deployment guide

Run `/gsd-new-milestone "M011: [name]"` to define the next milestone.

---
*Roadmap imported from .gsd on 2026-04-09 | 10 milestones complete | 49 requirements validated*
