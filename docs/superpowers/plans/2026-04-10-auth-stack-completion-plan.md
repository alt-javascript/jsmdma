# jsmdma Auth Stack Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the jsmdma auth infrastructure (UserRepository, AuthService, AuthMiddlewareRegistrar, AuthController, OrgController) into a reusable `authHonoStarter()` helper, add a generic `preferences` sync collection, and replace the `GoogleIdTokenMiddlewareRegistrar` bridge in the local POC server with the full auth stack.

**Architecture:** `authHonoStarter()` mirrors `honoStarter()` — it returns a CDI registration array that wires the entire auth stack in one call. The local POC server (`packages/example-auth/run-local.js`) is updated to use the full stack with redirect-based OAuth. A minimal frontend change in year-planner (`Application.js`) reads `?token=` from URL after OAuth callback so the bridge can be fully retired.

**Tech Stack:** Hono, `@alt-javascript/cdi`, `@alt-javascript/jsmdma-auth-server` (UserRepository, AuthService), `@alt-javascript/jsmdma-auth-hono` (AuthController, AuthMiddlewareRegistrar, OrgController), `@alt-javascript/jsmdma-auth-core` (GoogleProvider, JwtSession), Chai + Mocha tests, ES modules throughout.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/server/schemas/preferences.json` | Create | Permissive schema for opaque preferences documents |
| `packages/auth-hono/authHonoStarter.js` | Create | CDI registration array for the full auth stack |
| `packages/auth-hono/index.js` | Modify | Export `authHonoStarter` |
| `packages/auth-hono/test/authHonoStarter.spec.js` | Create | CDI integration tests for `authHonoStarter` |
| `packages/example-auth/run-local.js` | Modify | Replace Google bridge with `authHonoStarter()` + Google OAuth provider |
| `packages/example-auth/run.js` | Modify | Simplify manual wiring to use `authHonoStarter()` |
| `site/js/Application.js` (year-planner repo) | Modify | Read `?token=` URL param on page load, store JWT, remove param from URL |
| `site/js/service/AuthProvider.js` (year-planner repo) | Modify | Replace GSI button flow with redirect to `/auth/google` |

---

### Task 1: Add `preferences` schema

**Files:**
- Create: `packages/server/schemas/preferences.json`

- [ ] **Step 1: Write the preferences JSON schema**

Create `packages/server/schemas/preferences.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Preferences",
  "description": "Generic per-user per-app preferences document. Schema is intentionally permissive — the consuming application owns its own preference keys.",
  "type": "object",
  "additionalProperties": true
}
```

- [ ] **Step 2: Verify the schema loads in node**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
node -e "import('./packages/server/schemas/preferences.json', { assert: { type: 'json' } }).then(m => console.log('OK', m.default.title))"
```
Expected output: `OK Preferences`

- [ ] **Step 3: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/server/schemas/preferences.json
git commit -m "feat(server): add permissive preferences collection schema"
```

---

### Task 2: Create `authHonoStarter()` helper

**Files:**
- Create: `packages/auth-hono/authHonoStarter.js`
- Modify: `packages/auth-hono/index.js`

- [ ] **Step 1: Write the failing test first**

Create `packages/auth-hono/test/authHonoStarter.spec.js`:

```js
/**
 * authHonoStarter.spec.js — CDI integration tests for authHonoStarter()
 *
 * Verifies the helper wires the full auth stack correctly:
 * - /auth/me returns 401 without token
 * - /:app/sync returns 401 without token
 * - /auth/:provider returns beginAuth JSON with authorizationURL
 * - authController.providers can be set post-startup
 */
import {assert} from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import {Context, ApplicationContext} from '@alt-javascript/cdi';
import {EphemeralConfig} from '@alt-javascript/config';
import {honoStarter} from '@alt-javascript/boot-hono';
import {jsnosqlcAutoConfiguration} from '@alt-javascript/boot-jsnosqlc';
import {
    SyncRepository, SyncService, ApplicationRegistry, SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import {AppSyncController} from 'packages/jsmdma-hono';
import {JwtSession} from 'packages/jsmdma-auth-core';
import {authHonoStarter} from '../authHonoStarter.js';

const JWT_SECRET = 'authHonoStarter-test-secret-32!!';

class MockProvider {
    constructor(uid = 'mock-uid', email = 'mock@test.com') {
        this._uid = uid;
        this._email = email;
    }

    createAuthorizationURL(state) {
        return new URL(`https://mock.provider/auth?state=${state}`);
    }

    async validateCallback() {
        return {providerUserId: this._uid, email: this._email};
    }
}

async function buildContext() {
    const config = new EphemeralConfig({
        'boot': {'banner-mode': 'off', nosql: {url: 'jsnosqlc:memory:'}},
        'logging': {level: {ROOT: 'error'}},
        'server': {port: 0},
        'auth': {jwt: {secret: JWT_SECRET}},
        'applications': {'test-app': {}},
        'orgs': {registerable: false},
    });

    const context = new Context([
        ...honoStarter(),
        ...jsnosqlcAutoConfiguration(),
        {Reference: SyncRepository, name: 'syncRepository', scope: 'singleton'},
        {Reference: SyncService, name: 'syncService', scope: 'singleton'},
        {
            Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
            properties: [{name: 'applications', path: 'applications'}]
        },
        {
            Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
            properties: [{name: 'applications', path: 'applications'}]
        },
        ...authHonoStarter(),
        {Reference: AppSyncController, name: 'appSyncController', scope: 'singleton'},
    ]);

    const appCtx = new ApplicationContext({contexts: [context], config});
    await appCtx.start({run: false});
    await appCtx.get('nosqlClient').ready();
    appCtx.get('authController').providers = {mock: new MockProvider()};
    return appCtx;
}

describe('authHonoStarter()', () => {
    let appCtx;
    before(async () => {
        appCtx = await buildContext();
    });

    it('GET /auth/me returns 401 without token', async () => {
        const app = appCtx.get('honoApp');
        const res = await app.request('http://localhost/auth/me');
        assert.equal(res.status, 401);
    });

    it('POST /test-app/sync returns 401 without token', async () => {
        const app = appCtx.get('honoApp');
        const res = await app.request('http://localhost/test-app/sync', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({collection: 'items', clientClock: '0', changes: []}),
        });
        assert.equal(res.status, 401);
    });

    it('GET /auth/mock returns beginAuth JSON', async () => {
        const app = appCtx.get('honoApp');
        const res = await app.request('http://localhost/auth/mock');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.property(body, 'authorizationURL');
        assert.property(body, 'state');
        assert.property(body, 'codeVerifier');
        assert.include(body.authorizationURL, 'mock.provider');
    });

    it('GET /auth/unknown returns 400 for unknown provider', async () => {
        const app = appCtx.get('honoApp');
        const res = await app.request('http://localhost/auth/unknown-provider');
        assert.equal(res.status, 400);
    });

    it('GET /auth/me returns user when given valid JWT', async () => {
        const app = appCtx.get('honoApp');
        const token = await JwtSession.sign(
            {sub: 'test-uuid', providers: ['mock'], email: 'test@example.com'},
            JWT_SECRET,
        );
        const res = await app.request('http://localhost/auth/me', {
            headers: {Authorization: `Bearer ${token}`},
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.userId, 'test-uuid');
        assert.deepEqual(body.providers, ['mock']);
    });

    it('authHonoStarter() does not register duplicate names when called twice', async () => {
        // The function must return fresh registration objects each call (no shared state)
        const reg1 = authHonoStarter();
        const reg2 = authHonoStarter();
        assert.deepEqual(
            reg1.map((r) => r.name),
            reg2.map((r) => r.name),
        );
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/auth-hono 2>&1 | grep -E "authHonoStarter|Error|Cannot find"
```
Expected: `Error: Cannot find module '../authHonoStarter.js'` or similar import error.

- [ ] **Step 3: Create `authHonoStarter.js`**

Create `packages/auth-hono/authHonoStarter.js`:

```js
/**
 * authHonoStarter.js — CDI registration bundle for the jsmdma auth stack.
 *
 * Usage:
 *   import { authHonoStarter } from '@alt-javascript/jsmdma-auth-hono';
 *
 *   const context = new Context([
 *     ...honoStarter(),
 *     ...jsnosqlcAutoConfiguration(),
 *     ...authHonoStarter(),
 *     // sync controllers after auth:
 *     { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
 *   ]);
 *
 * After appCtx.start(), set OAuth provider instances on authController:
 *   appCtx.get('authController').providers = {
 *     google: new GoogleProvider({ clientId, clientSecret, redirectUri }),
 *   };
 *
 * Required config paths:
 *   auth.jwt.secret  — JWT signing secret (min 32 chars)
 *
 * Optional config paths:
 *   orgs.registerable — true to allow org creation (default: false)
 *
 * Registration order is significant: AuthMiddlewareRegistrar MUST appear before
 * AppSyncController and AuthController so Hono's app.use() is registered before
 * route handlers.
 */
import {UserRepository, AuthService, OrgRepository, OrgService}
    from 'packages/jsmdma-auth-server';
import AuthMiddlewareRegistrar from './AuthMiddlewareRegistrar.js';
import AuthController from './AuthController.js';
import OrgController from './OrgController.js';

export function authHonoStarter() {
    return [
        // Repositories — no CDI dependencies, only jsnosqlc client injected
        {Reference: UserRepository, name: 'userRepository', scope: 'singleton'},
        {Reference: OrgRepository, name: 'orgRepository', scope: 'singleton'},

        // Services — autowired: userRepository, orgRepository, jwtSecret
        {
            Reference: AuthService,
            name: 'authService',
            scope: 'singleton',
            properties: [{name: 'jwtSecret', path: 'auth.jwt.secret'}],
        },
        {Reference: OrgService, name: 'orgService', scope: 'singleton'},

        // Middleware registrar — MUST come before AppSyncController in Context array
        // so app.use('/:application/sync', mw) fires before the route handler
        {
            Reference: AuthMiddlewareRegistrar,
            name: 'authMiddlewareRegistrar',
            scope: 'singleton',
            properties: [{name: 'jwtSecret', path: 'auth.jwt.secret'}],
        },

        // Controllers — route handlers registered after middleware
        {Reference: AuthController, name: 'authController', scope: 'singleton'},
        {
            Reference: OrgController,
            name: 'orgController',
            scope: 'singleton',
            properties: [{name: 'registerable', path: 'orgs.registerable'}],
        },
    ];
}
```

- [ ] **Step 4: Export from `packages/auth-hono/index.js`**

Read the current file first, then add the export:

```js
// Current contents of packages/auth-hono/index.js — append this line:
export { authHonoStarter } from './authHonoStarter.js';
```

The full updated `packages/auth-hono/index.js`:

```js
/**
 * index.js — Public exports for @alt-javascript/jsmdma-auth-hono
 */

export { authMiddleware, getUser }         from './authMiddleware.js';
export { default as AuthController }       from './AuthController.js';
export { default as AuthMiddlewareRegistrar } from './AuthMiddlewareRegistrar.js';
export { default as OrgController }        from './OrgController.js';
export { authHonoStarter }                 from './authHonoStarter.js';
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/auth-hono
```
Expected: All tests pass including the 6 new `authHonoStarter()` tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/auth-hono/authHonoStarter.js \
        packages/auth-hono/index.js \
        packages/auth-hono/test/authHonoStarter.spec.js
git commit -m "feat(auth-hono): add authHonoStarter() CDI bundle helper with tests"
```

---

### Task 3: Update `example-auth/run-local.js` to use full auth stack

**Files:**
- Modify: `packages/example-auth/run-local.js`

This replaces `GoogleIdTokenMiddlewareRegistrar` with `authHonoStarter()` + real Google OAuth provider. After this change, the local server issues jsmdma JWTs via `/auth/google` → `/auth/google/callback`.

Required env vars after this change:
- `GOOGLE_CLIENT_ID` — same as before
- `GOOGLE_CLIENT_SECRET` — new (server-side OAuth)
- `JWT_SECRET` — new (JWT signing, min 32 chars)

- [ ] **Step 1: Write the updated `run-local.js`**

Overwrite `packages/example-auth/run-local.js`:

```js
// packages/example-auth/run-local.js
/**
 * run-local.js — Local POC server with full jsmdma auth stack.
 *
 * Starts a real HTTP server on 127.0.0.1:8081.
 * Issues jsmdma JWTs after Google OAuth redirect flow.
 * Uses in-memory jsnosqlc for storage (data is lost on restart).
 *
 * Required environment variables:
 *   GOOGLE_CLIENT_ID      — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET  — Google OAuth client secret
 *   JWT_SECRET            — HS256 signing secret (min 32 chars)
 *
 * Google Cloud Console setup:
 *   Authorised redirect URIs must include:
 *     http://127.0.0.1:8081/auth/google/callback
 *   Authorised JavaScript origins must include:
 *     http://localhost:8080
 *     http://127.0.0.1:8080
 *
 * Run:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... JWT_SECRET=... \
 *     node packages/example-auth/run-local.js
 *
 * Sign-in flow:
 *   1. Browser: GET http://127.0.0.1:8081/auth/google
 *      → JSON { authorizationURL, state, codeVerifier }
 *   2. Browser: store state + codeVerifier in sessionStorage; redirect to authorizationURL
 *   3. Google: redirect to http://127.0.0.1:8081/auth/google/callback?code=...&state=...
 *   4. Browser: POST state + codeVerifier from sessionStorage to callback
 *      → JSON { user, token }
 *   5. Browser: store token in localStorage as auth_token
 */

import '@alt-javascript/jsnosqlc-memory';
import {Context, ApplicationContext} from '@alt-javascript/cdi';
import {EphemeralConfig} from '@alt-javascript/config';
import {honoStarter} from '@alt-javascript/boot-hono';
import {jsnosqlcAutoConfiguration} from '@alt-javascript/boot-jsnosqlc';
import {
    SyncRepository,
    SyncService,
    ApplicationRegistry,
    SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import {AppSyncController} from 'packages/jsmdma-hono';
import {authHonoStarter} from 'packages/jsmdma-auth-hono';
import GoogleProvider from '@alt-javascript/jsmdma-auth-core/providers/google.js';
import CorsMiddlewareRegistrar from './CorsMiddlewareRegistrar.js';

// ── validate env ──────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

const missing = [
    !GOOGLE_CLIENT_ID && 'GOOGLE_CLIENT_ID',
    !GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
    !JWT_SECRET && 'JWT_SECRET',
].filter(Boolean);

if (missing.length) {
    console.error('\nError: Missing required environment variables:', missing.join(', '));
    console.error('\nUsage:');
    console.error('  GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret> JWT_SECRET=<secret32> \\');
    console.error('    node packages/example-auth/run-local.js\n');
    process.exit(1);
}

if (JWT_SECRET.length < 32) {
    console.error('\nError: JWT_SECRET must be at least 32 characters.\n');
    process.exit(1);
}

// ── config ────────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'http://127.0.0.1:8081/auth/google/callback';

const APPLICATIONS_CONFIG = {
    'year-planner': {
        description: 'Year planner application',
        collections: {
            planners: {
                schemaPath: './packages/server/schemas/planner.json',
            },
            preferences: {
                schemaPath: './packages/server/schemas/preferences.json',
            },
        },
    },
};

// ── CDI context ───────────────────────────────────────────────────────────────

const config = new EphemeralConfig({
    'boot': {'banner-mode': 'off', nosql: {url: 'jsnosqlc:memory:'}},
    'logging': {level: {ROOT: 'info'}},
    'server': {port: 8081, host: '127.0.0.1'},
    'auth': {jwt: {secret: JWT_SECRET}},
    'applications': APPLICATIONS_CONFIG,
    'orgs': {registerable: false},
});

const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    {Reference: SyncRepository, name: 'syncRepository', scope: 'singleton'},
    {Reference: SyncService, name: 'syncService', scope: 'singleton'},
    {
        Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
        properties: [{name: 'applications', path: 'applications'}]
    },
    {
        Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
        properties: [{name: 'applications', path: 'applications'}]
    },
    // CORS must be first
    {Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton'},
    // Full auth stack: AuthMiddlewareRegistrar MUST come before AppSyncController
    ...authHonoStarter(),
    {Reference: AppSyncController, name: 'appSyncController', scope: 'singleton'},
]);

const appCtx = new ApplicationContext({contexts: [context], config});

// ── start ─────────────────────────────────────────────────────────────────────

async function main() {
    await appCtx.start();
    await appCtx.get('nosqlClient').ready();

    // Set OAuth providers post-startup (providers are runtime instances, not CDI beans)
    appCtx.get('authController').providers = {
        google: new GoogleProvider({
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
            redirectUri: REDIRECT_URI,
        }),
    };

    console.log('\n  jsmdma local POC server running on http://127.0.0.1:8081');
    console.log('  Routes:');
    console.log('    GET  /health');
    console.log('    GET  /auth/google              → begin OAuth (returns authorizationURL JSON)');
    console.log('    GET  /auth/google/callback     → complete OAuth (returns { user, token })');
    console.log('    GET  /auth/me                  → current user (requires JWT)');
    console.log('    POST /year-planner/sync        → HLC sync (requires JWT)');
    console.log('  Auth: jsmdma JWT (issued after Google OAuth redirect flow)');
    console.log('  Storage: in-memory (data lost on restart)');
    console.log('\n  Start the SPA: npx http-server site/ -p 8080 (in year-planner repo)');
    console.log('  Sign in: redirect to http://127.0.0.1:8081/auth/google\n');
}

main().catch((err) => {
    console.error('\nFailed to start:', err.message);
    console.error(err.stack);
    process.exit(1);
});
```

- [ ] **Step 2: Verify the server starts (syntax + import check)**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake JWT_SECRET=test-secret-at-least-32chars-ok \
  node --input-type=module <<'EOF'
import './packages/example-auth/run-local.js';
EOF
```
Expected: Server starts and prints the routes. Press Ctrl+C.

- [ ] **Step 3: Verify env validation exits cleanly**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
node packages/example-auth/run-local.js 2>&1 | head -5
```
Expected: `Error: Missing required environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET`

- [ ] **Step 4: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/example-auth/run-local.js \
        packages/server/schemas/preferences.json
git commit -m "feat(example-auth): replace Google bridge with full jsmdma auth stack in run-local.js"
```

---

### Task 4: Simplify `example-auth/run.js` to use `authHonoStarter()`

**Files:**
- Modify: `packages/example-auth/run.js`

The `run.js` lifecycle example currently wires CDI manually. Use `authHonoStarter()` to remove duplication and confirm the helper works in a complete lifecycle.

- [ ] **Step 1: Read `run.js` fully before editing**

```bash
cat /Users/craig/src/github/alt-javascript/jsmdma/packages/example-auth/run.js
```

- [ ] **Step 2: Replace manual wiring with `authHonoStarter()`**

In `packages/example-auth/run.js`, find the CDI context definition (the `Context([...])` array). Replace the manual registrations of `UserRepository`, `AuthService`, `AuthMiddlewareRegistrar`, `AuthController` with `...authHonoStarter()`.

The import block at the top should add:

```js
import {authHonoStarter} from 'packages/jsmdma-auth-hono';
```

And remove the individual imports:

```js
// DELETE these lines:
import {AuthController, AuthMiddlewareRegistrar} from 'packages/jsmdma-auth-hono';
import {UserRepository, AuthService} from 'packages/jsmdma-auth-server';
```

The Context array changes from:
```js
const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository, ... },
  { Reference: SyncService, ... },
  { Reference: UserRepository, ... },        // ← DELETE
  { Reference: AuthService, ..., properties: [{ name: 'jwtSecret', ... }] }, // ← DELETE
  { Reference: AuthMiddlewareRegistrar, ... }, // ← DELETE
  { Reference: AuthController, ... },          // ← DELETE
]);
```

To:
```js
const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,    name: 'syncRepository',    scope: 'singleton' },
  { Reference: SyncService,       name: 'syncService',       scope: 'singleton' },
  ...authHonoStarter(),
]);
```

After `appCtx.start()`, providers are still set via:
```js
appCtx.get('authController').providers = { mock: new MockProvider('user-1', 'user1@example.com') };
```
This line is unchanged.

- [ ] **Step 3: Run the full auth lifecycle example to verify it still works**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
node packages/example-auth/run.js
```
Expected: All 10 lifecycle steps pass, `All checks passed. Exit 0.` at the end.

- [ ] **Step 4: Commit**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add packages/example-auth/run.js
git commit -m "refactor(example-auth): simplify run.js to use authHonoStarter()"
```

---

### Task 5: Frontend bridge — `?token=` URL handler in year-planner

**Files:**
- Modify: `site/js/Application.js` (year-planner repo)
- Modify: `site/js/service/AuthProvider.js` (year-planner repo)

With the Google bridge retired from the server, the year-planner frontend must:
1. On page load: read `?token=` from URL, store as `auth_token`, remove from URL
2. For sign-in: call `GET /auth/google` (server endpoint), store `state`+`codeVerifier` in sessionStorage, redirect to `authorizationURL`
3. After Google callback: read `?code=` + `?state=` from URL, call server callback endpoint with stored PKCE params, get JWT

- [ ] **Step 1: Read `Application.js` fully before editing**

```bash
cat /Users/craig/src/github/alt-html/year-planner/site/js/Application.js
```

- [ ] **Step 2: Add `?token=` URL handler to `Application.js`**

In `Application.js`, inside `init()`, add the following BEFORE the existing URL parameter reading (add it as the very first block in `init()`):

```js
// Handle OAuth callback: server sends JWT as ?token= after /auth/:provider/callback
const urlToken = urlParam('token');
if (urlToken) {
    localStorage.setItem('auth_token', urlToken);
    localStorage.setItem('auth_time', Date.now().toString());
    // Remove ?token= from URL without triggering a reload
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('token');
    window.history.replaceState({}, '', cleanUrl.toString());
}
```

- [ ] **Step 3: Read `AuthProvider.js` fully before editing**

```bash
cat /Users/craig/src/github/alt-html/year-planner/site/js/service/AuthProvider.js
```

- [ ] **Step 4: Replace `_signInGoogle()` with redirect-based OAuth**

Replace the entire `_signInGoogle()` method in `AuthProvider.js`:

```js
async _signInGoogle() {
    // Step 1: ask the server to begin the OAuth flow
    const apiUrl = this._getApiUrl();
    let beginResult;
    try {
        const res = await fetch(`${apiUrl}auth/google`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        beginResult = await res.json();
    } catch (err) {
        throw new Error(`Google sign-in failed: could not reach auth server (${err.message})`);
    }

    const { authorizationURL, state, codeVerifier } = beginResult;
    if (!authorizationURL) throw new Error('Google sign-in failed: no authorizationURL from server');

    // Step 2: store PKCE params in sessionStorage for the callback handler
    sessionStorage.setItem('oauth_state',         state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier);

    // Step 3: redirect browser to Google
    window.location.href = authorizationURL;

    // This promise never resolves — the page navigates away.
    // The ?token= URL handler in Application.js completes the flow on return.
    return new Promise(() => {});
}

// Helper to read the configured API base URL (strips ${...} template if present)
_getApiUrl() {
    const raw = this.url || '${api.url}';
    // In production, this is replaced by the build system.
    // For local dev, fall back to the known local server URL.
    if (raw.startsWith('${')) return 'http://127.0.0.1:8081/';
    return raw.endsWith('/') ? raw : raw + '/';
}
```

Also add `this.url = '${api.url}';` to the constructor if it doesn't already exist (check the constructor body — it may already have it).

- [ ] **Step 5: Handle the OAuth callback URL in the frontend**

The Google callback redirects to `http://127.0.0.1:8081/auth/google/callback`. The `?token=` handler in Application.js fires on page load in the SPA. However, the redirect URI registered with Google must point to the SPA, not the server, for the token to land in the SPA.

Update the redirect URI convention: the server's `AuthController.completeAuth` returns `{ user, token }` as JSON. The frontend needs to read the code+state from URL and call the callback itself.

Add a callback handler to `Application.js` after the `?token=` block:

```js
// Handle OAuth redirect: Google sends ?code=&state= back to the SPA
// (when redirectUri is configured to point at the SPA, not the server)
const oauthCode  = urlParam('code');
const oauthState = urlParam('state');
if (oauthCode && oauthState) {
    const storedState    = sessionStorage.getItem('oauth_state');
    const codeVerifier   = sessionStorage.getItem('oauth_code_verifier');
    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('oauth_code_verifier');

    const apiUrl = 'http://127.0.0.1:8081/';
    try {
        const res = await fetch(
            `${apiUrl}auth/google/callback?code=${encodeURIComponent(oauthCode)}` +
            `&state=${encodeURIComponent(oauthState)}` +
            `&stored_state=${encodeURIComponent(storedState ?? '')}` +
            `&code_verifier=${encodeURIComponent(codeVerifier ?? '')}`,
        );
        if (res.ok) {
            const body = await res.json();
            if (body.token) {
                localStorage.setItem('auth_token', body.token);
                localStorage.setItem('auth_time', Date.now().toString());
            }
        }
    } catch { /* silent — auth failed, user stays signed out */ }

    // Clean up URL
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('code');
    cleanUrl.searchParams.delete('state');
    window.history.replaceState({}, '', cleanUrl.toString());
}
```

**Note:** For this to work with Google, the Google OAuth redirect URI registered in Cloud Console must be updated from `http://localhost:8080` (origin) to the SPA URL (e.g. `http://localhost:8080/`). The server's GoogleProvider `redirectUri` must also match: set `GOOGLE_REDIRECT_URI=http://localhost:8080/` or keep using the server callback. See the architecture note in the spec — this completes in Spec C when `AuthProvider.js` is fully replaced.

- [ ] **Step 6: Commit year-planner changes**

```bash
cd /Users/craig/src/github/alt-html/year-planner
git add site/js/Application.js site/js/service/AuthProvider.js
git commit -m "feat(auth): add OAuth redirect flow and ?token= URL handler for jsmdma JWT"
```

---

### Task 6: Run all auth-hono tests to verify nothing regressed

- [ ] **Step 1: Run the full auth-hono test suite**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
npm run test --workspace=packages/auth-hono
```
Expected: All tests pass (authMiddleware, AuthController, OrgController, linking, authHonoStarter).

- [ ] **Step 2: Run auth-server tests**

```bash
npm run test --workspace=packages/auth-server
```
Expected: All tests pass.

- [ ] **Step 3: Run the auth lifecycle example end-to-end**

```bash
node packages/example-auth/run.js
```
Expected: `All checks passed. Exit 0.`

- [ ] **Step 4: Commit if any fixes were needed**

```bash
cd /Users/craig/src/github/alt-javascript/jsmdma
git add -A
git commit -m "fix(auth): resolve any test failures from auth stack integration"
```
(Only needed if fixes were required in steps 1-3.)

---

## Self-Review Checklist

**Spec coverage:**
- ✅ OAuth flows for Google wired (Microsoft + Apple follow same pattern; add their providers to `authController.providers` map)
- ✅ `UserRepository` + `AuthService` wired via `authHonoStarter()`
- ✅ `OrgRepository` + `OrgService` wired via `authHonoStarter()`
- ✅ `authMiddleware` verified by tests — 401 without JWT, 200 with valid JWT
- ✅ `AuthController` — `/auth/:provider`, `/auth/:provider/callback`, `/auth/me`, link/unlink routes
- ✅ `preferences` collection schema created and registered
- ✅ Rolling JWT refresh handled by `AuthMiddlewareRegistrar` (existing implementation)
- ✅ `GoogleIdTokenMiddlewareRegistrar` retired from `run-local.js`
- ✅ Frontend `?token=` handler for JWT receipt

**Microsoft + Apple providers:**
These follow the identical pattern as Google (Task 3, Step 1: `authController.providers = { google, microsoft, apple }`). Add them when `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `APPLE_TEAM_ID` etc. are available. The server infrastructure supports them already.
