# @alt-javascript/jsmdma-auth-hono

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-auth-hono)](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-hono)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Hono auth adapter for jsmdma — JWT middleware, OAuth routes, and org management endpoints. CDI-managed, mounts into any boot-hono application.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-auth-hono
```

## Exports

| Class | Route(s) | Description |
|---|---|---|
| `AuthMiddlewareRegistrar` | `app.use(...)` | Registers JWT verification middleware for all protected routes. Must be registered **before** all controllers. |
| `AuthController` | `GET /auth/:provider`, `GET /auth/:provider/callback`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/link/:provider`, `DELETE /auth/providers/:provider` | OAuth flow and identity endpoints. |
| `OrgController` | `POST /orgs`, `GET /orgs`, `GET /orgs/:orgId/members`, `POST/PATCH/DELETE /orgs/:orgId/members/:userId` | Org lifecycle and membership management. |

## CDI Registration

```js
import { AuthMiddlewareRegistrar, AuthController,
         OrgController } from '@alt-javascript/jsmdma-auth-hono';

const context = new Context([
  // ... repositories and services first ...

  // ↓ MUST come before all other controllers
  { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },

  { Reference: AuthController, name: 'authController', scope: 'singleton' },
  { Reference: OrgController,  name: 'orgController',  scope: 'singleton',
    properties: [{ name: 'registerable', path: 'orgs.registerable' }] },
]);
```

`OrgController` requires `orgs.registerable: true` in config for `POST /orgs` to accept requests. Without it, org creation always returns 403.

## Auth Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/:provider` | — | Begin OAuth flow. Returns `{ authorizationURL, state, codeVerifier }`. |
| `GET` | `/auth/:provider/callback` | — | Complete OAuth flow. Returns `{ user, token }`. |
| `GET` | `/auth/me` | ✅ | Current user identity: `{ userId, email, providers }`. |
| `POST` | `/auth/logout` | — | Stateless logout guidance. |
| `POST` | `/auth/link/:provider` | ✅ | Link a second OAuth provider. |
| `DELETE` | `/auth/providers/:provider` | ✅ | Remove a provider. Returns `409` if it would be the last. |

**Supported providers:** `google`, `github`, `microsoft`, `apple`

## License

MIT
