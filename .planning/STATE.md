# Project State: jsmdma

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-09)

**Core value:** Field-level HLC conflict resolution — clients go offline, make changes, sync back without losing data
**Current focus:** No active phase — all planned milestones complete

## Current Status

**Phase:** Complete — ready for next milestone
**Last completed milestone:** M010: Rename, Package Publication Readiness, and Documentation Refresh (2026-04-05)
**Active requirements:** 0 (all 49 requirements validated)
**Test suite:** 539+ tests passing across 6 workspaces

## Milestone Registry

- ✅ **M001:** Offline-First Sync Engine — Core Protocol & Hono Server
- ✅ **M002:** OAuth Identity — Provider Login, UUID Identity, Provider Linking
- ✅ **M003:** Application-Scoped Sync — Text Auto-Merge, Multi-App Routing, Schema Validation
- ✅ **M004:** Organisation Tenancy — App-Agnostic Orgs, Membership, Role Management
- ✅ **M005:** Deep Nested Document Support — Dot-Path fieldRevs & Recursive Merge
- ✅ **M006:** Planner Schema & Application Config
- ✅ **M007:** Data Model, Relationships & Sharing Design
- ✅ **M008:** Data API — ACL Enforcement, Search, Export & Deletion
- ✅ **M009:** SyncClient & Documentation
- ✅ **M010:** Rename, Package Publication Readiness, and Documentation Refresh

## Key Architecture Facts

- **Packages:** `@alt-javascript/jsmdma-{core,server,hono,auth-core,auth-server,auth-hono}` at v1.0.0
- **ESM bundle:** `packages/core/dist/jsmdma-core.esm.js` (16.9 kB, 7 exports)
- **DeletionController pattern:** Uses `routes()` imperative hook (not `static __routes`) for 204 responses
- **DocIndex key:** `docIndex:{userId}:{app}:{docKey}` — non-owner lookups naturally 404 (no 403 needed)
- **AuthMiddlewareRegistrar:** Must be registered BEFORE controllers in CDI Context array
- **Org registration:** `orgs.registerable: true` required in config + CDI property injection in OrgController

## Blockers

None.

## Next Action

All milestones complete. Run `/gsd-new-milestone` to define M011 scope.

## Session Continuity

**Imported:** 2026-04-09 — Project context migrated from .gsd/ (Pi Dev GSD CLI) to .planning/ (GSD Claude Code) after M010 completion. All milestone history preserved in .gsd/milestones/.
