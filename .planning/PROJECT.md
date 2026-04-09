# jsmdma

## What This Is

Offline-first, bidirectional data sync API built on the alt-javascript/boot ecosystem. A configurable multi-tenant backend for mobile and web apps. Clients maintain local data copies and sync with a server using field-level merge and HLC-based causal conflict resolution. Supports multiple configured applications, per-user isolated storage, organisation tenancy (X-Org-Id header), JSON Schema validation, and text auto-merge for non-overlapping line-level changes. Published as `@alt-javascript/jsmdma-*` npm packages at v1.0.0.

## Core Value

The sync protocol: any number of clients can go offline, make changes, and sync back without losing data — field-level HLC conflict resolution ensures the right value wins, and text auto-merge handles concurrent string edits without requiring coordination.

## Requirements

### Validated

- ✓ Bidirectional sync via POST /:application/sync — M001–M004
- ✓ HLC causal ordering for conflict resolution — M001
- ✓ Text auto-merge for concurrent string field edits — M003
- ✓ Application-scoped routing and allowlist — M003
- ✓ JSON Schema validation on push — M003
- ✓ JWT session with rolling refresh and TTL enforcement — M002
- ✓ OAuth provider identity (Google, GitHub, Microsoft, Apple) — M002
- ✓ Organisation tenancy with X-Org-Id header — M004
- ✓ Storage namespacing: {userId}:{application}:{collection} — M003
- ✓ Dot-path fieldRevs for deeply nested documents — M005
- ✓ flatten/unflatten utility (dot-path ↔ nested object) — M005
- ✓ ESM CDN bundle for jsmdma-core (dist/jsmdma-core.esm.js, <30KB) — M006/M009
- ✓ Year-planner application config and planner JSON Schema — M006
- ✓ Entity relationship model and storage namespace map — M007
- ✓ JSON schemas for all entity types — M007
- ✓ DocIndex: server-side ownership and visibility tracker — M007
- ✓ Sharing model: private → shared → org → public — M007
- ✓ Share token: server-issued UUID — M007
- ✓ Org name uniqueness enforced instance-wide — M007
- ✓ orgs.registerable instance config flag — M007
- ✓ OpenAPI spec (23 endpoints, redocly lint exits 0) — M007/M008
- ✓ year-planner integration guide — M007
- ✓ Read-side ACL enforcement in changesSince — M008
- ✓ Cross-namespace shared doc aggregation in sync — M008
- ✓ POST /:application/search with Filter AST and ACL scoping — M008
- ✓ Per-user data export (GET /account/export) — M008
- ✓ Per-org data export (GET /orgs/:orgId/export) — M008
- ✓ User hard delete with full cascade — M008
- ✓ Org hard delete with full cascade — M008
- ✓ SyncClient class (edit/sync/prune/shouldPrune/getChanges/getSnapshot) — M009
- ✓ Client-side local pruning and full-pull recovery via HLC.zero() — M009
- ✓ 19 ADR files covering all significant architectural decisions — M009
- ✓ Six consumer-facing guide docs — M009
- ✓ All packages renamed @alt-javascript/jsmdma-* at v1.0.0 with publish metadata — M010
- ✓ Package READMEs for all six publishable packages — M010

### Active

(None — all planned features delivered through M010. Define next milestone for new scope.)

### Out of Scope

- Real-time push / WebSockets — pull-based sync is the model; push adds complexity without clear benefit for this use case
- Per-day document granularity for year-planner — one document per planner with dot-path field addressing is sufficient
- Deterministic JWT share tokens — designed as upgrade path (D004); UUID tokens are sufficient for current needs

## Context

- **Monorepo:** npm workspaces — 8 packages (6 publishable, 2 example)
- **ESM-only:** `"type": "module"` throughout, Node ≥ 20
- **CDI:** alt-javascript/cdi (Spring-style DI), Context array registration order matters
- **HTTP:** Hono via boot-hono (Node, Lambda, Cloudflare Workers compatible)
- **Storage:** jsnosqlc NoSQL abstraction (in-memory for tests, DynamoDB/MongoDB/Firestore in prod)
- **Auth:** Stateless HS256 JWT sessions with idle/hard TTL and rolling refresh
- **Test suite:** 539+ passing tests across 6 workspaces (Mocha + Chai)
- **Examples:** `packages/example/run.js` (two-device sync demo), `packages/example/run-apps.js` (18 scenarios: multi-app, org, sharing, search, export, deletion)
- **Prior tracker:** `.gsd/` directory — 10 milestones tracked by Pi Dev GSD CLI; imported to .planning on 2026-04-09

## Constraints

- **Tech stack:** ESM-only, Node ≥ 20 — no CommonJS exports
- **core package:** Must remain isomorphic (zero Node deps) — runs in browsers and Node alike
- **CDI ordering:** AuthMiddlewareRegistrar must be registered before controllers in Context array
- **DeletionController pattern:** Uses `routes()` imperative hook (not `static __routes`) — required for valid 204 responses in Node 20+ (undici rejects `c.json('', 204)` via the __routes path)
- **Storage keys:** Colons in segment values must be percent-encoded to avoid key collisions

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Dot-path flat fieldRevs for nested HLC (D001) | Backward-compatible; depth-1 is valid subset; merge operates at leaf granularity | ✓ Good |
| Planner document structure: sparse days map, not array (D002) | Dot-path addressable at day-field level; bounded doc size | ✓ Good |
| Pruning is client-local; server uses zero-clock protocol (D004) | Symmetric mesh model; no new protocol surface | ✓ Good |
| ESM bundle: local asset → jsDelivr CDN after npm publish (D005) | Unblocks year-planner without requiring npm publish first | ✓ Good |
| SyncClient is isomorphic, lives in packages/core (D006) | Protocol logic, not app logic; reusable from mobile clients | ✓ Good |
| DocIndex: separate collection, not inline ACL fields (D005/arch) | Keeps ACL metadata separate from app data; avoids leaking metadata to clients | ✓ Good |
| Org names unique instance-wide; orgNames index collection (D006/data) | Prevents impersonation; O(1) lookup | ✓ Good |
| Non-owner DocIndex access returns 404, not 403 (D008) | Avoids confirming document existence to non-owners | ✓ Good |
| Cross-namespace sync via server-side fan-out from docIndex (D009) | Offline-first model; clients have no knowledge of other namespaces | ✓ Good |
| Search uses jsnosqlc Filter AST body (D010) | Fully composable; ACL enforcement is additive | ✓ Good |
| Hard delete, no tombstone (D011) | GDPR right to erasure; simplest correct approach | ✓ Good |
| Packages renamed @alt-javascript/jsmdma-* (M010) | Aligned to new GitHub location and npm namespace | ✓ Good |

---
## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-09 after import from .gsd (M001–M010 complete)*
