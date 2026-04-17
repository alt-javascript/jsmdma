# @alt-javascript/jsmdma-auth-core

[![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/%40alt-javascript%2Fjsmdma-auth-core)](https://www.npmjs.com/package/@alt-javascript/jsmdma-auth-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Isomorphic auth core for jsmdma: stateless HS256 JWT session engine and OAuth provider wrappers (Google, GitHub, Microsoft, Apple). Zero Node.js dependencies in the session layer — runs in browsers, Node.js, and edge runtimes.

**Part of the [@alt-javascript/jsmdma](https://github.com/alt-javascript/jsmdma) monorepo.**

## Install

```bash
npm install @alt-javascript/jsmdma-auth-core
```

## Exports

| Export | Description |
|---|---|
| `JwtSession` | Signs and verifies HS256 JWTs. Enforces idle TTL (3d), hard TTL (7d), and rolling refresh. |
| `GoogleProvider` | OAuth 2.0 + PKCE flow for Google. |
| `GitHubProvider` | OAuth 2.0 flow for GitHub. |
| `MicrosoftProvider` | OAuth 2.0 + PKCE flow for Microsoft. |
| `AppleProvider` | Sign In with Apple — ES256 client secret, PKCE. |
| `InvalidTokenError` | Thrown when a JWT cannot be verified. |
| `IdleExpiredError` | Thrown when `now - iat > idleTtl`. |
| `HardExpiredError` | Thrown when `now - iat_session > hardTtl`. |
| `InvalidStateError` | Thrown when OAuth state validation fails. |

## JWT Session Contract

```js
import {JwtSession} from '@alt-javascript/jsmdma-auth-core';

const session = new JwtSession({secret: process.env.JWT_SECRET});

const token = await session.sign({sub: userId, providers: ['github'], email});
const payload = await session.verify(token);
// payload.refreshToken is the new token if rolling refresh was triggered
```

**Token payload:**
```json
{
  "sub":         "uuid",
  "providers":   ["github"],
  "email":       "user@example.com",
  "iat":         1700000000,
  "iat_session": 1700000000
}
```

## Apple Sign In

```js
import {AppleProvider} from '@alt-javascript/jsmdma-auth-core';

const apple = new AppleProvider({
    clientId: 'com.example.app',
    teamId: 'YOURTEAMID',
    keyId: 'YOURKEYID',
    privateKey: process.env.APPLE_PRIVATE_KEY_PEM,
    redirectUri: 'https://example.com/auth/apple/callback',
});
```

## License

MIT
