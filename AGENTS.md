# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Offline-first, bidirectional data sync API built on the alt-javascript/boot ecosystem. Clients maintain local data copies and sync with a server using field-level merge and HLC-based causal conflict resolution. Supports multiple configured applications, per-user isolated storage, organisation tenancy (X-Org-Id), JSON Schema validation, and text auto-merge for non-overlapping line-level changes.

## Commands

```bash
npm install                        # install all workspaces
npm test                           # run all workspace tests
npm test -w packages/core          # run tests for a single workspace
npm run build                      # bundle core (esbuild → dist/)

# run a single test file
npx mocha --recursive packages/core/test/hlc.spec.js

# run examples
node packages/example/run.js       # offline-first two-device demo
node packages/example/run-apps.js  # multi-app + org demo
```

## Tech Stack

- **ESM-only** (`"type": "module"`) — Node ≥ 20
- **Test framework:** Mocha + Chai (expect style), `test/**/*.spec.js` convention
- **CDI:** alt-javascript/cdi (Spring-style DI) — components registered in a Context array
- **HTTP:** Hono via boot-hono (runs on Node, Lambda, Cloudflare Workers)
- **Storage:** jsnosqlc NoSQL abstraction (memory in tests, DynamoDB/MongoDB/Firestore in prod)
- **Auth:** Stateless HS256 JWT sessions with idle/hard TTL and rolling refresh

## Monorepo Structure (npm workspaces)

| Package | npm name | Role |
|---|---|---|
| `packages/core` | `@alt-javascript/jsmdma-core` | Isomorphic: HLC clock, field diff, merge, textMerge, flatten (zero Node deps) |
| `packages/server` | `@alt-javascript/jsmdma-server` | SyncRepository, SyncService, ApplicationRegistry, SchemaValidator |
| `packages/hono` | `@alt-javascript/jsmdma-hono` | AppSyncController — Hono route wiring |
| `packages/auth-core` | `@alt-javascript/jsmdma-auth-core` | JWT session helpers, OAuth provider errors |
| `packages/auth-server` | `@alt-javascript/jsmdma-auth-server` | UserRepository, AuthService, OrgRepository, OrgService |
| `packages/auth-hono` | `@alt-javascript/jsmdma-auth-hono` | AuthMiddlewareRegistrar, AuthController, OrgController |
| `packages/example` | — | Runnable sync demos |
| `packages/example-auth` | — | Runnable auth demo |

## Architecture Notes

- **HLC strings** are lexicographically ordered hex (`<13-hex-ms>-<6-hex-seq>-<node>`), usable directly as NoSQL sort keys and in range queries.
- **Conflict resolution:** per-field HLC comparison → text auto-merge for strings with non-overlapping line changes → higher-HLC wins fallback.
- **Storage keys** are namespaced as `{userId}:{app}:{collection}` (personal) or `org:{orgId}:{app}:{collection}` (org-scoped). Colons in segment values are percent-encoded.
- **CDI ordering matters:** `AuthMiddlewareRegistrar` must be registered before any controllers in the Context array (Hono registers middleware in insertion order).
- **Application config** declares valid app paths; unknown app names → 404. Collections can have inline JSON Schema or `schemaPath` for validation.
- **core package is isomorphic** — must stay free of Node-specific dependencies so it can run in browsers.
