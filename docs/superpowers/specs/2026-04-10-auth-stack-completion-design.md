# jsmdma Auth Stack Completion — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the full auth infrastructure that already exists across jsmdma packages (`auth-core`, `auth-server`, `auth-hono`) but is not yet running anywhere, so that any jsmdma application gets provider-agnostic, re-linkable user identity and rolling JWT sessions for free.

**Architecture:** The server issues JWTs whose `sub` claim is a stable internal UUID managed by `UserRepository` — not the OAuth provider's sub. This decouples user identity from any specific provider, enabling re-linking and migration. `authMiddleware` verifies JWTs on every request and emits a fresh token in `X-Auth-Token` when the session is within its rolling window.

**Tech Stack:** Hono, `@alt-javascript/jsmdma-auth-server` (UserRepository, AuthService), `@alt-javascript/jsmdma-auth-hono` (AuthController, AuthMiddlewareRegistrar), `arctic` (OAuth PKCE), `jose` (JWT sign/verify)

**Steering directive:** This is platform-level infrastructure. Zero year-planner-specific code here. Year-planner (and all future apps) consume this via standard HTTP routes and Bearer tokens.

---

## Scope Boundary

**In scope:**
- OAuth flows for Google, Microsoft, Apple (the three providers year-planner currently supports)
- `UserRepository` — persists `users` collection (internalUUID → { email, providers[] }) and `providerIndex` (provider:sub → internalUUID)
- `AuthService` — orchestrates: begin OAuth → complete OAuth → upsert user → issue JWT
- `AuthController` — HTTP routes: `/auth/:provider`, `/auth/:provider/callback`, `/auth/link/:provider`, `/auth/providers/:provider` (DELETE), `/auth/me`
- `authMiddleware` — JWT verify + rolling refresh (`X-Auth-Token` response header when token age > 1h)
- `preferences` collection: jsmdma sync schema extended with a generic per-user-per-app opaque preferences document (same sync pipeline as any other collection, no special handling)
- Integration wired in year-planner's local server (`api/` directory) as the reference implementation

**Out of scope:**
- GitHub provider (not used by year-planner; add later)
- Org/workspace model (OrgRepository, OrgService — future milestone)
- Client-side SDK (Spec B)

---

## Data Model

### User document (`users` collection)
```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "providers": ["google", "apple"],
  "created": "2026-04-10T00:00:00Z"
}
```

### Provider index entry (`providerIndex` collection)
```json
{
  "providerSub": "google:117480762187795587811",
  "internalUUID": "550e8400-e29b-41d4-a716-446655440000"
}
```

### JWT payload (issued by AuthService)
```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "providers": ["google"],
  "iat": 1712750000,
  "iat_session": 1712750000
}
```
- Idle TTL: 3 days from `iat_session`
- Hard TTL: 7 days from `iat`
- Rolling: `authMiddleware` refreshes `iat_session` when token age > 1h, emits new token in `X-Auth-Token`

### Preferences sync document (`preferences` collection)
```json
{
  "key": "<userUUID>:<appName>",
  "doc": { "<any-key>": "<any-value>" }
}
```
Synced identically to planner documents. Apps define their own keys. jsmdma stores and merges opaquely.

A `preferences.json` schema file is added alongside `planner.json` in `packages/server/schemas/`:
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Preferences",
  "description": "Generic per-user per-app preferences document",
  "type": "object",
  "additionalProperties": true
}
```
Schema validation is intentionally permissive (additionalProperties: true) — the app owns its preference keys.

---

## HTTP Routes

| Method | Path | Auth required | Description |
|--------|------|---------------|-------------|
| GET | `/auth/:provider` | No | Begin OAuth — redirects to provider |
| GET | `/auth/:provider/callback` | No | Complete OAuth — upserts user, issues JWT, redirects with token |
| GET | `/auth/me` | Yes | Returns current user payload from JWT |
| POST | `/auth/link/:provider` | Yes | Begin linking additional provider to existing account |
| GET | `/auth/link/:provider/callback` | Yes | Complete provider link |
| DELETE | `/auth/providers/:provider` | Yes | Unlink provider (must have ≥1 remaining) |
| POST | `/auth/logout` | Yes | Stateless guidance — client clears token |

---

## Auth Middleware Behaviour

```
Request arrives with Authorization: Bearer <jwt>
  → authMiddleware verifies signature and TTL
  → attaches payload to c.set('user', payload)
  → if (now - iat_session) > 1h: issue new JWT, attach to response X-Auth-Token
  → calls next()

On 401:
  → token missing, expired, or invalid signature
  → returns { error: 'unauthorized' }
```

Downstream controllers read `c.get('user').sub` as the stable user UUID for storage namespacing.

---

## AuthService Flow

```
beginAuth(provider, redirectUri)
  → generate PKCE code_verifier + state
  → store state in session cookie (httpOnly, SameSite=Lax)
  → return provider authorization URL

completeAuth(provider, code, state, redirectUri)
  → verify state matches cookie
  → exchange code for tokens (arctic)
  → extract provider sub from id_token or userinfo
  → upsertUser(provider, providerSub, email)
  → return signed JWT { sub: internalUUID, email, providers }

upsertUser(provider, providerSub, email)
  → look up providerIndex[provider:providerSub]
  → if found: return existing internalUUID
  → if not found: create new internalUUID (crypto.randomUUID())
    → write users[internalUUID]
    → write providerIndex[provider:providerSub]
    → return new internalUUID

linkProvider(existingInternalUUID, provider, providerSub)
  → verify providerSub not already linked to a different user (prevent account hijack)
  → write providerIndex[provider:providerSub] → existingInternalUUID
  → update users[existingInternalUUID].providers to include new provider

unlinkProvider(internalUUID, provider)
  → verify user has ≥2 providers (prevent lockout)
  → remove providerIndex[provider:providerSub]
  → update users[internalUUID].providers
```

---

## Integration in year-planner's local server

The year-planner `api/` server is the reference consumer. It wires:
1. `AuthMiddlewareRegistrar` on sync routes (replaces the current `GoogleIdTokenMiddlewareRegistrar` bridge)
2. `AuthController` on `/auth/*` routes
3. `AppSyncController` reads `c.get('user').sub` as userId (no change to sync logic)

The `GoogleIdTokenMiddlewareRegistrar` bridge is retired once this spec is complete.

---

## Preferences Collection

No new server code needed beyond schema registration. The `preferences` collection is registered alongside `planners` in the sync application config:

```js
// In the app's sync config
collections: ['planners', 'preferences']
```

`SyncRepository` handles it identically. Schema validation for preferences is skipped (opaque document — apps own their schema). The only constraint: document `key` must be `<userUUID>:<appName>` to namespace by user and app.

---

## Error Handling

| Scenario | HTTP Status | Response body |
|----------|-------------|---------------|
| Invalid/expired JWT | 401 | `{ error: 'unauthorized' }` |
| Provider OAuth error | 400 | `{ error: 'provider_error', detail: '...' }` |
| State mismatch (CSRF) | 400 | `{ error: 'invalid_state' }` |
| Unlink last provider | 400 | `{ error: 'cannot_unlink_last_provider' }` |
| Provider already linked to different user | 409 | `{ error: 'provider_already_linked' }` |

---

## Testing

- Unit: `AuthService.upsertUser` — new user, returning user, duplicate provider sub across users (409)
- Unit: `AuthService.linkProvider` — happy path, hijack prevention, already-linked idempotent
- Unit: `AuthService.unlinkProvider` — happy path, last-provider guard
- Unit: `authMiddleware` — valid token, expired idle, expired hard, rolling refresh window
- Integration: Full OAuth callback flow with mock provider (arctic mock)
- Integration: `/auth/link/:provider` flow
- Integration: `AppSyncController` reads `user.sub` correctly after middleware

---

## Success Criteria

- Any app using `authMiddleware` gets stable internal UUID as `userId` regardless of OAuth provider
- Re-linking: user can authenticate with a second provider and their data is preserved
- Provider migration: user can unlink original provider and use new one
- JWT rolling refresh: active users never see a session expiry within idle TTL
- `preferences` collection syncs without special handling
