/**
 * AuthController.spec.js — CDI integration tests for AuthController
 *
 * Tests the full auth stack: CDI → AuthMiddlewareRegistrar → AuthController →
 * AuthService → UserRepository → jsnosqlc-memory.
 * Also tests that /:application/sync is gated by auth middleware.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { SyncRepository, SyncService, AppSyncService, ApplicationRegistry } from '@alt-javascript/jsmdma-server';
import { AppSyncController } from '@alt-javascript/jsmdma-hono';
import { UserRepository, AuthService } from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import AuthController from '../AuthController.js';
import AuthMiddlewareRegistrar from '../AuthMiddlewareRegistrar.js';

const JWT_SECRET = 'auth-controller-test-secret-32!!';

// ── MockProvider ──────────────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId = 'mock-uid', email = 'user@mock.com') {
    this._uid   = providerUserId;
    this._email = email;
  }
  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }
  async validateCallback() {
    return { providerUserId: this._uid, email: this._email };
  }
}

// ── CDI context builder ───────────────────────────────────────────────────────

async function buildContext() {
  const config = new EphemeralConfig({
    'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging':      { level: { ROOT: 'error' } },
    'server':       { port: 0 },
    'auth':         { jwt: { secret: JWT_SECRET } },
    'applications': { todo: {}, 'shopping-list': {} },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,    name: 'syncRepository',    scope: 'singleton' },
    { Reference: SyncService,       name: 'syncService',       scope: 'singleton' },
    { Reference: AppSyncService,    name: 'appSyncService',    scope: 'singleton' },
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    // AuthMiddlewareRegistrar MUST come before AppSyncController and AuthController
    // so app.use('/:application/sync') is registered before route handlers in Hono
    {
      Reference: AuthMiddlewareRegistrar,
      name: 'authMiddlewareRegistrar',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    { Reference: AppSyncController,       name: 'appSyncController',       scope: 'singleton' },
    { Reference: UserRepository,          name: 'userRepository',           scope: 'singleton' },
    {
      Reference: AuthService,
      name: 'authService',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    { Reference: AuthController, name: 'authController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  // Set providers map on authController (runtime, not CDI-injectable from config)
  appCtx.get('authController').providers = { mock: new MockProvider() };

  return { appCtx, app: appCtx.get('honoAdapter').app };
}

// ── helper: make a valid token ────────────────────────────────────────────────

async function makeToken(sub = 'user-1', providers = ['mock']) {
  return JwtSession.sign({ sub, providers, email: 'test@example.com' }, JWT_SECRET);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AuthController (CDI integration)', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await buildContext();
  });

  // ── GET /auth/me ─────────────────────────────────────────────────────────────

  describe('GET /auth/me', () => {
    it('returns typed 401 without token', async () => {
      const res = await ctx.app.request('/auth/me');
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'Unauthorized');
      assert.equal(body.code, 'unauthorized');
    });

    it('returns user identity with valid token', async () => {
      const token = await makeToken('my-uuid', ['mock']);
      const res   = await ctx.app.request('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.userId, 'my-uuid');
      assert.deepEqual(body.providers, ['mock']);
    });
  });

  // ── GET /auth/:provider ───────────────────────────────────────────────────────

  describe('GET /auth/:provider', () => {
    it('returns authorizationURL and state (without codeVerifier) for known provider', async () => {
      const res = await ctx.app.request('/auth/mock');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'authorizationURL');
      assert.property(body, 'state');
      assert.notProperty(body, 'codeVerifier');
      assert.include(body.authorizationURL, 'mock.provider');
    });

    it('returns typed 400 for unknown provider', async () => {
      const res = await ctx.app.request('/auth/unknown-provider');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'Unknown provider');
      assert.equal(body.code, 'bad_request');
    });
  });

  // ── GET /auth/:provider/callback ─────────────────────────────────────────────

  describe('GET /auth/:provider/callback', () => {
    it('completes auth and persists the provider-linked user', async () => {
      // First: get a real state from beginAuth
      const beginRes = await ctx.app.request('/auth/mock');
      const beginBody = await beginRes.json();
      const { state } = beginBody;

      const res = await ctx.app.request(
        `/auth/mock/callback?code=mock-code&state=${state}`,
      );
      assert.equal(res.status, 302);
      assert.include(['', '""'], await res.text());

      const storedUser = await ctx.appCtx.get('userRepository').findByProvider('mock', 'mock-uid');
      assert.isOk(storedUser, 'callback should create or resolve provider-linked user');
      assert.match(storedUser.userId, /^[0-9a-f-]{36}$/);

      const token = await makeToken(storedUser.userId, ['mock']);
      const meRes = await ctx.app.request('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(meRes.status, 200);
      const me = await meRes.json();
      assert.equal(me.userId, storedUser.userId);
      assert.deepEqual(me.providers, ['mock']);
    });

    it('returns typed 400 when state is missing', async () => {
      const res = await ctx.app.request('/auth/mock/callback?code=code');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Missing required query params: code, state');
      assert.equal(body.code, 'bad_request');
    });

    it('returns typed 400 on unknown state (CSRF/replay)', async () => {
      const res = await ctx.app.request(
        '/auth/mock/callback?code=code&state=unknown-state',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error.toLowerCase(), 'state');
      assert.equal(body.code, 'bad_request');
    });

    it('returns typed non-leaky 500 when provider callback throws', async () => {
      const beginRes = await ctx.app.request('/auth/mock');
      const beginBody = await beginRes.json();

      ctx.appCtx.get('authController').providers = {
        mock: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            throw new Error('provider-secret-details');
          },
        },
      };

      const res = await ctx.app.request(
        `/auth/mock/callback?code=mock-code&state=${beginBody.state}`,
      );

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Authentication failed');
      assert.equal(body.code, 'internal_error');
      assert.notInclude(body.error, 'provider-secret-details');
    });
  });

  // ── POST /auth/link/:provider ───────────────────────────────────────────────

  describe('POST /auth/link/:provider', () => {
    it('returns typed non-leaky 500 when provider callback throws', async () => {
      const token = await makeToken('link-user', ['mock']);
      ctx.appCtx.get('authController').providers = {
        mock: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            throw new Error('link-provider-secret');
          },
        },
      };

      const res = await ctx.app.request('/auth/link/mock?code=abc&state=s1&stored_state=s1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Provider callback failed');
      assert.equal(body.code, 'internal_error');
      assert.notInclude(body.error, 'link-provider-secret');
    });

    it('returns typed 500 when provider callback payload is malformed', async () => {
      const token = await makeToken('link-user', ['mock']);
      ctx.appCtx.get('authController').providers = {
        mock: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            return { email: 'bad@payload.dev' };
          },
        },
      };

      const res = await ctx.app.request('/auth/link/mock?code=abc&state=s1&stored_state=s1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Provider callback failed');
      assert.equal(body.code, 'internal_error');
    });
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('returns logout guidance message', async () => {
      const res = await ctx.app.request('/auth/logout', { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'message');
    });
  });

  // ── POST /:application/sync auth gating ─────────────────────────────────────

  describe('POST /:application/sync — auth gating', () => {
    it('returns typed 401 without token', async () => {
      const res = await ctx.app.request('/todo/sync', {
        method: 'POST',
        body: JSON.stringify({ collection: 'items', clientClock: '0000000000000-000000-00000000', changes: [] }),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, 'Unauthorized');
      assert.equal(body.code, 'unauthorized');
    });

    it('returns 200 with valid token and known application', async () => {
      const token = await makeToken('sync-user', ['mock']);
      const res   = await ctx.app.request('/todo/sync', {
        method:  'POST',
        body:    JSON.stringify({ collection: 'items', clientClock: '0000000000000-000000-00000000', changes: [] }),
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'serverClock');
    });

    it('returns typed 404 for unknown application even with valid token', async () => {
      const token = await makeToken('sync-user', ['mock']);
      const res   = await ctx.app.request('/unknown-app/sync', {
        method:  'POST',
        body:    JSON.stringify({ collection: 'items', clientClock: '0000000000000-000000-00000000', changes: [] }),
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.include(body.error, 'Unknown application');
      assert.equal(body.code, 'not_found');
    });
  });
});
