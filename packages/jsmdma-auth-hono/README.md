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
| `AuthController` | `GET /auth/:provider`, `GET|POST /auth/login/finalize`, `GET /auth/me`, `GET|POST /auth/link/finalize`, `POST|DELETE /auth/unlink/:provider`, `POST /auth/signout` | Mode-aware OAuth lifecycle and identity endpoints. |
| `OrgController` | `POST /orgs`, `GET /orgs`, `GET /orgs/:orgId/members`, `POST/PATCH/DELETE /orgs/:orgId/members/:userId` | Org lifecycle and membership management. |

## CDI Registration

```js
import {
    AuthMiddlewareRegistrar, AuthController,
    OrgController
} from '@alt-javascript/jsmdma-auth-hono';

const context = new Context([
    // ... repositories and services first ...

    // ↓ MUST come before all other controllers
    {
        Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
        properties: [{name: 'jwtSecret', path: 'auth.jwt.secret'}]
    },

    {Reference: AuthController, name: 'authController', scope: 'singleton'},
    {
        Reference: OrgController, name: 'orgController', scope: 'singleton',
        properties: [{name: 'registerable', path: 'orgs.registerable'}]
    },
]);
```

`OrgController` requires `orgs.registerable: true` in config for `POST /orgs` to accept requests. Without it, org creation always returns 403.

## Auth Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/:provider` | — | Begin OAuth flow. Returns `{ authorizationURL, state }`. |
| `GET`, `POST` | `/auth/login/finalize` | — | Complete login callback with `provider`, `code`, `state`, and explicit `mode` (`cookie|bearer` + aliases `session|stateless`). Cookie mode sets `auth_session`; bearer mode returns `{ token }`. |
| `GET` | `/auth/me` | mode-aware | Resolve current identity from cookie/bearer session. Returns `{ userId, email, providers, mode }`. |
| `GET`, `POST` | `/auth/link/finalize` | mode-aware | Link an additional provider for the authenticated user using callback params (`provider`, `code`, `state`, `stored_state`). |
| `POST`, `DELETE` | `/auth/unlink/:provider` | mode-aware | Remove a linked provider. Returns typed `identity_link_not_found/provider_not_linked` or `last_provider_unlink_forbidden/last_provider_lockout` on guarded failures. |
| `POST` | `/auth/signout` | mode-aware | Sign out current session mode and invalidate the presented session token. |

**Supported providers:** `google`, `github`, `microsoft`, `apple`

## License

MIT
