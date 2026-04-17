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
| `UserRepository` | Persists user records and provider index (`provider:id → userId`). |
| `AuthService` | OAuth callback handling — upserts users, signs JWT sessions, manages provider linking and unlinking. |
| `OrgRepository` | Persists org records, name reservations, and membership. |
| `OrgService` | Org lifecycle — create, add/remove/update members, role validation, last-admin guard. |

## CDI Assembly

```js
import {
    UserRepository, AuthService,
    OrgRepository, OrgService
} from 'packages/jsmdma-auth-server';

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
