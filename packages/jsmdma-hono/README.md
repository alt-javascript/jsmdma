# @alt-javascript/jsmdma-hono

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-hono)](https://www.npmjs.com/package/@alt-javascript/jsmdma-hono)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Hono HTTP adapter for jsmdma — CDI-managed controllers that wire the sync, search, export, deletion, and document index services into a Hono application.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-hono
```

## Exports

| Class | Route(s) | Description |
|---|---|---|
| `AppSyncController` | `POST /:app/sync` | Bidirectional sync endpoint — push changes, pull server changes. |
| `SyncController` | `POST /sync` | App-agnostic sync (single-app deployments). |
| `DocIndexController` | `GET/PATCH /docIndex/:app/:docKey`, `POST/DELETE /docIndex/:app/:docKey/shareToken` | Document visibility and share token management. |
| `SearchController` | `POST /:app/search` | Filter-AST search across accessible documents. |
| `ExportController` | `GET /export/:app`, `GET /export/:app/org/:orgId` | Bulk data export. |
| `DeletionController` | `DELETE /account`, `DELETE /orgs/:orgId` | Hard-delete account or org and all associated data. |

## CDI Registration Order

`AuthMiddlewareRegistrar` **must** be registered before any controller. Hono registers middleware in insertion order — `app.use()` must fire before route handlers.

```js
import {
    AppSyncController, DocIndexController, SearchController,
    ExportController, DeletionController
} from '@alt-javascript/jsmdma-hono';
import {AuthMiddlewareRegistrar} from '@alt-javascript/jsmdma-auth-hono';

const context = new Context([
    // ... repositories and services ...
    {
        Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
        properties: [{name: 'jwtSecret', path: 'auth.jwt.secret'}]
    },
    {Reference: AppSyncController, name: 'appSyncController', scope: 'singleton'},
    {Reference: DocIndexController, name: 'docIndexController', scope: 'singleton'},
    {Reference: SearchController, name: 'searchController', scope: 'singleton'},
    {Reference: ExportController, name: 'exportController', scope: 'singleton'},
    {Reference: DeletionController, name: 'deletionController', scope: 'singleton'},
]);
```

## Canonical Starter Composition (`jsmdmaHonoStarter`)

`jsmdmaHonoStarter()` is the canonical auth-enabled composer for jsmdma Hono apps.

Internally it takes `authHonoStarter()` registrations and applies the explicit auth boundary API from `@alt-javascript/jsmdma-auth-hono`:

- `infrastructureRegistrations` (auth middleware + typed error contract layer)
- `legacyControllerRegistrations` (`AuthController`, `OrgController`)

Composition order is deterministic:

1. `honoStarter()` + `jsnosqlcAutoConfiguration()` infrastructure
2. jsmdma sync services (`SyncRepository`, `SyncService`, `AppSyncService`, registry/validator)
3. auth `infrastructureRegistrations`
4. boot oauth foundation (`oauthJsnosqlcStarter()`, `oauthStarter()`)
5. auth `legacyControllerRegistrations`
6. `AppSyncController`

This boundary-aware ordering preserves middleware-before-routes guarantees while exposing boot oauth routes (`/oauth/:provider/authorize`, `/oauth/:provider/callback`) on the canonical starter path.

Feature closures are still enforced:

- `features.auth=false` excludes both auth and oauth stacks.
- `features.sync=true` requires `features.auth=true`.

### Focused composition proof matrix

Run this matrix when validating canonical composition or diagnosing auth-boundary drift:

```bash
npx mocha --recursive packages/jsmdma-auth-hono/test/authHonoStarter.spec.js
npx mocha --recursive packages/jsmdma-hono/test/jsmdmaHonoStarter.spec.js
npx mocha --recursive packages/jsmdma-hono/test/oauthStarterRoutes.spec.js
npx mocha --recursive packages/example-auth/test/runLocalStarter.spec.js
npx mocha --recursive packages/example-auth/test/runCanonicalStarter.spec.js
node packages/example-auth/run.js
```

## Further Reading

- [Sync Protocol Reference](../../docs/sync-protocol.md)
- [Sharing & Visibility](../../docs/sharing.md)
- [Search](../../docs/search.md)

## License

MIT
