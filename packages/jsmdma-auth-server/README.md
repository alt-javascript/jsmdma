# @alt-javascript/jsmdma-auth-server

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-auth-server)](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Server-side identity layer for jsmdma: user repository, auth service, org repository, and org service. CDI-managed, backed by jsnosqlc for storage-provider independence.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-auth-server
```

## Exports

| Class | Role |
|---|---|
| `UserRepository` | Persists user profiles; `providers` is synchronized projection state (ownership authority is `oauthIdentityLinkStore`). |
| `AuthService` | OAuth callback handling via `oauthIdentityLinkStore` ownership (`getUserByProviderAnchor`, `link`, `getLinksForUser`) with typed conflict/state outcomes. |
| `OrgRepository` | Persists org records, name reservations, and membership. |
| `OrgService` | Org lifecycle — create, add/remove/update members, role validation, last-admin guard. |

## Identity-link authority and failure contract

Runtime ownership authority is the injected `oauthIdentityLinkStore`; this package does not treat user-profile provider arrays as ownership indexes.

Typical typed oauth outcomes surfaced to route layers:

- `identity_link_conflict` (for example `reason=anchor_already_linked`)
- `identity_link_not_found` (for example `reason=provider_not_linked`)
- `last_provider_unlink_forbidden` (for example `reason=last_linked_provider`)
- `invalid_state` for malformed callback/dependency-state paths

These codes/reasons are intended for machine handling while preserving non-leaky messages.

## CDI Assembly

```js
import {
    UserRepository, AuthService,
    OrgRepository, OrgService
} from '@alt-javascript/jsmdma-auth-server';

const context = new Context([
    // ... boot/jsnosqlc config ...
    {Reference: UserRepository, name: 'userRepository', scope: 'singleton'},
    {
        Reference: AuthService, name: 'authService', scope: 'singleton',
        properties: [{name: 'jwtSecret', path: 'auth.jwt.secret'}]
    },
    {Reference: OrgRepository, name: 'orgRepository', scope: 'singleton'},
    {Reference: OrgService, name: 'orgService', scope: 'singleton'},
]);
```

## License

MIT
