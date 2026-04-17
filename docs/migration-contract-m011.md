# M011 Migration Contract — Starter Boundaries + Node↔Lambda Parity

This contract defines the required migration surfaces for M011 portability closure. It is the release-gate artifact for requirement **R012** and references executable parity evidence for **R011**.

## Audience

- Maintainers upgrading existing jsmdma integrations
- Support/admin operators validating parity in CI or pre-release checks

## Breaking Changes

1. **Canonical composition path is now `jsmdmaHonoStarter()`**
   - Integrations that manually assembled broad registration arrays should migrate to starter-first composition.
2. **`SyncController` is no longer a public `@alt-javascript/jsmdma-hono` export**
   - Public sync HTTP ownership is `AppSyncController` via starter wiring.
3. **Portability proof is now an explicit release gate**
   - Node and Lambda failure-class parity must be re-verified using the commands in this document.

## Old-to-New Mapping

| Previous integration surface | M011 migration target | Required action |
|---|---|---|
| Manual Hono/CDI assembly with low-level registration ordering | `jsmdmaHonoStarter()` from `@alt-javascript/jsmdma-hono` | Replace manual default-path wiring with starter-first composition; keep advanced behavior in staged starter hooks. |
| Public sync entrypoint assumptions based on `SyncController` export | Public sync boundary is `AppSyncController` + starter route registration (`POST /:application/sync`) | Remove public imports/usages of `SyncController`; consume package public API via starter and `AppSyncController` surface. |
| Runtime portability inferred from local/manual checks | Dedicated parity suite: `packages/example/test/nodeLambdaParity.spec.js` | Adopt `npm run -w packages/example test:parity` as the canonical parity check in migration/release verification. |
| Lambda adapter behavior checked ad hoc | Dedicated Lambda entrypoint verification: `packages/example/test/lambdaEntrypoint.spec.js` | Include `npm run -w packages/example test:lambda-entrypoint` in release/support runbooks. |
| Migration guidance spread across milestone notes only | Stable contract artifact at `docs/migration-contract-m011.md` | Link this document from README/support docs and keep command matrix current with real scripts. |

## Parity Verification Matrix

| Verification command (repo root) | Confirms | Expected outcome | Evidence artifact |
|---|---|---|---|
| `npm run -w packages/example test:parity` | Node↔Lambda parity for required failure classes: 401, 403, 400 (`details`), 404, and redacted 5xx | Pass; any envelope mismatch or 5xx sensitive-text leak fails | `packages/example/test/nodeLambdaParity.spec.js` |
| `npm run -w packages/example test:lambda-entrypoint` | Lambda adapter path keeps typed contract for health/auth/schema/unknown-route classes | Pass | `packages/example/test/lambdaEntrypoint.spec.js` |
| `npm test -w packages/example` | Full example workspace regression with parity + adapter tests included | Pass | `packages/example/test/**/*.spec.js` |
| `node -e "const fs=require('fs');const p='docs/migration-contract-m011.md';if(!fs.existsSync(p))process.exit(1);const s=fs.readFileSync(p,'utf8');const required=['## Breaking Changes','## Old-to-New Mapping','## Parity Verification Matrix'];if(!required.every((h)=>s.includes(h)))process.exit(1);if(!s.includes('test:parity')||!s.includes('test:lambda-entrypoint'))process.exit(1);"` | Contract completeness guard (required headings + command references) | Exit 0 | This document |

## Operational Notes

- Keep this contract aligned with `.gsd/REQUIREMENTS.md` entries **R011** and **R012**.
- If parity scope changes, update:
  1. `packages/example/test/nodeLambdaParity.spec.js`
  2. `packages/example/package.json` scripts (`test:parity`, `test:lambda-entrypoint`)
  3. This verification matrix and README links
- 5xx redaction leakage is treated as release-blocking; parity tests intentionally assert that sensitive injected throw text is absent from both parsed payloads and raw Lambda envelope bodies.
