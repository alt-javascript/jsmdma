# M013 Migration Contract

## Audience

Maintainers upgrading existing jsmdma integrations past M013.

M013 removes all five auth packages from the jsmdma monorepo and migrates authentication and identity concerns to the `boot-oauth` ecosystem. This document covers all breaking changes, the complete old-to-new API mapping, and an executable verification matrix to confirm a successful migration.

---

## Breaking Changes

1. **Five packages removed:** `@alt-javascript/jsmdma-auth-core`, `@alt-javascript/jsmdma-auth-client`, `@alt-javascript/jsmdma-auth-server`, `@alt-javascript/jsmdma-auth-hono`, `@alt-javascript/jsmdma-example-auth` are deleted from the monorepo. Any direct dependency on these packages must be replaced before upgrading.

2. **`jsmdmaHonoStarter()` no longer registers auth endpoints.** The starter now wires sync and org routes only. Auth lifecycle endpoints (login, callback, token refresh, logout) must be wired via `boot-oauth` route handlers outside the jsmdma starter.

3. **Controller identity access changed.** The pattern `c.get('user').sub` is replaced by `request.identity.userId`. The `HonoControllerRegistrar` bridges boot's `request.identity` object into Hono context so controllers can call `c.get('identity').userId`. Any controller or service that read `c.get('user')` must migrate to this pattern.

4. **`JwtSession` removed.** The `JwtSession` class (previously in `jsmdma-auth-core`) no longer exists. Token signing, verification, and session management must use `@alt-javascript/boot-oauth`'s `OAuthSessionEngine`.

5. **`arctic` and `jose` dependencies removed.** These were pulled in transitively by the auth packages. They are no longer present in any package manifest. If your application depended on them through jsmdma, add them to your own `package.json`.

6. **Test token minting via shared helper.** Per-test usage of `JwtSession.sign()` is replaced by the shared `mintTestToken({ userId })` helper located at `test/helpers/mintTestToken.js`. All workspace tests that mint tokens use this helper.

7. **`UserRepository` relocated.** `UserRepository` moved from `@alt-javascript/jsmdma-auth-server` to `@alt-javascript/jsmdma-server`. Import path changes; the class API is unchanged.

8. **`OrgRepository`, `OrgService`, and `orgErrors` relocated.** These moved from `@alt-javascript/jsmdma-auth-server` to `@alt-javascript/jsmdma-server`. Import paths change; APIs are unchanged.

9. **`OrgController` relocated.** `OrgController` moved from `@alt-javascript/jsmdma-auth-hono` to `@alt-javascript/jsmdma-hono`. Import path changes; the class API is unchanged.

10. **`FrameworkErrorContractMiddleware` relocated.** This middleware moved from `@alt-javascript/jsmdma-auth-hono` to `@alt-javascript/jsmdma-hono`. Import path changes; the middleware API is unchanged.

---

## Old-to-New Mapping

| Previous surface | M013 migration target |
|---|---|
| `@alt-javascript/jsmdma-auth-core` `JwtSession` | `@alt-javascript/boot-oauth` `OAuthSessionEngine` |
| `@alt-javascript/jsmdma-auth-hono` `AuthController` | boot-oauth route handlers |
| `@alt-javascript/jsmdma-auth-hono` `AuthMiddlewareRegistrar` | boot `OAuthSessionMiddleware` (CDI, order 5) |
| `@alt-javascript/jsmdma-auth-server` `OrgRepository` / `OrgService` | `@alt-javascript/jsmdma-server` (same classes, new package home) |
| `@alt-javascript/jsmdma-auth-hono` `OrgController` | `@alt-javascript/jsmdma-hono` (same class, new package home) |
| `@alt-javascript/jsmdma-auth-hono` `FrameworkErrorContractMiddleware` | `@alt-javascript/jsmdma-hono` (same class, new package home) |
| `@alt-javascript/jsmdma-auth-server` `UserRepository` | `@alt-javascript/jsmdma-server` (same class, new package home) |
| `c.get('user').sub` in controllers/services | `request.identity.userId` via boot identity bridge (`c.get('identity').userId`) |
| Per-test `JwtSession.sign()` | Shared `mintTestToken({ userId })` from `test/helpers/mintTestToken.js` |
| `jsmdmaHonoStarter` with auth composition | `jsmdmaHonoStarter` sync+org only; wire boot-oauth via `hooks.beforeSync` |
| `arctic` / `jose` as transitive deps | Add directly to your own `package.json` if needed |
| `@alt-javascript/jsmdma-auth-client` | No jsmdma replacement — use boot-oauth client utilities |

---

## Verification Matrix

Run these checks after completing the migration to confirm no stale references remain.

| Command | Confirms | Expected |
|---|---|---|
| `npm test` | Full workspace suite green | Exit 0 |
| `grep -rn 'jsmdma-auth-core\|jsmdma-auth-client\|jsmdma-auth-server\|jsmdma-auth-hono\|example-auth' --include='*.js' packages/ --exclude-dir=node_modules \| grep -v 'notMatch\|assert.*not'` | No stale JS source references to removed packages | 0 matches |
| `grep -rn 'arctic\|jose' --include=package.json packages/ --exclude-dir=node_modules` | No stale `arctic`/`jose` deps in any workspace manifest | 0 matches |
| `node packages/example/run-apps.js` | Multi-app and org demo boots and exits cleanly | Exit 0 |
| `node packages/example/run.js` | Offline-first two-device demo boots and exits cleanly | Exit 0 |
| `node -e "import('fs').then(fs=>{const s=fs.default.readFileSync('docs/migration-contract-m013.md','utf8');const h=['## Breaking Changes','## Old-to-New Mapping','## Verification Matrix','## Operational Notes'];if(!h.every(x=>new RegExp('^'+x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','m').test(s))){console.error('Missing heading');process.exit(1)}console.log('headings OK')})"` | Contract document has all required sections | Exit 0 / `headings OK` |

---

## Operational Notes

- Keep this contract aligned with R033 (migration contract requirement for M013 auth removal).
- If `boot-oauth` API changes after M013, update the Old-to-New Mapping table and re-run the verification matrix.
- `package-lock.json` may retain extraneous entries for deleted auth packages after upgrade. Running `rm package-lock.json && npm install` regenerates a clean lockfile.
- The CDI `Context` array ordering still matters: `OAuthSessionMiddleware` (boot-oauth) must appear before any controllers that rely on `request.identity`. The former order constraint on `AuthMiddlewareRegistrar` (now deleted) translates directly to this boot-oauth middleware placement rule.
- Tests that assert auth contract removal (e.g., `notMatch` guards) use the `grep -v 'notMatch\|assert.*not'` exclusion so they are not falsely flagged by the stale-reference check.
