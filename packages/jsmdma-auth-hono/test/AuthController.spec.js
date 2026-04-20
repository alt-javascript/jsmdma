/**
 * AuthController.spec.js — CDI integration tests for AuthController
 *
 * Tests the full auth stack: CDI → AuthMiddlewareRegistrar → AuthController →
 * AuthService → UserRepository → jsnosqlc-memory.
 * Also tests that /:application/sync is gated by auth middleware.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import './registerBootWorkspaceMemoryDriver.js';
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
const SUPPORTED_PROVIDERS = new Set(['google', 'github', 'apple', 'microsoft', 'meta', 'generic']);

function createStoreError(code, reason, message, status = 500, diagnostics) {
  const err = new Error(message ?? `${code}:${reason}`);
  err.name = 'OAuthError';
  err.code = code;
  err.reason = reason;
  err.status = status;
  err.diagnostics = diagnostics ?? { reason };
  return err;
}

function assertNonEmptyString(value, field, operation) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createStoreError(
      'invalid_state',
      'non_empty_string_required',
      `${operation} requires non-empty ${field}`,
      400,
    );
  }

  return value.trim();
}

function assertSupportedProvider(value, operation) {
  const provider = assertNonEmptyString(value, 'provider', operation);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw createStoreError('invalid_state', 'unsupported_provider', `${operation} unsupported provider`, 400);
  }
  return provider;
}

class InMemoryIdentityLinkStore {
  constructor() {
    this.anchorOwners = new Map(); // `${provider}::${providerUserId}` -> userId
    this.userLinks = new Map(); // userId -> Map<provider, providerUserId>
    this.hooks = {
      getUserByProviderAnchor: null,
      link: null,
      unlink: null,
      getLinksForUser: null,
    };
  }

  setHook(operation, hook) {
    this.hooks[operation] = hook;
  }

  _anchorKey(provider, providerUserId) {
    return `${provider}::${providerUserId}`;
  }

  _linksForUser(userId) {
    return this.userLinks.get(userId) ?? new Map();
  }

  seedLink(userId, provider, providerUserId) {
    const normalizedUserId = assertNonEmptyString(userId, 'userId', 'seedLink');
    const normalizedProvider = assertSupportedProvider(provider, 'seedLink');
    const normalizedProviderUserId = assertNonEmptyString(providerUserId, 'providerUserId', 'seedLink');

    const links = this._linksForUser(normalizedUserId);
    links.set(normalizedProvider, normalizedProviderUserId);
    this.userLinks.set(normalizedUserId, links);
    this.anchorOwners.set(this._anchorKey(normalizedProvider, normalizedProviderUserId), normalizedUserId);
  }

  async getUserByProviderAnchor(input) {
    if (this.hooks.getUserByProviderAnchor) {
      return this.hooks.getUserByProviderAnchor(input, this);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createStoreError('invalid_state', 'invalid_operation_shape', 'lookup input must be object', 400);
    }

    const provider = assertSupportedProvider(input.provider, 'getUserByProviderAnchor');
    const providerUserId = assertNonEmptyString(input.providerUserId, 'providerUserId', 'getUserByProviderAnchor');

    return this.anchorOwners.get(this._anchorKey(provider, providerUserId)) ?? null;
  }

  async link(input) {
    if (this.hooks.link) {
      return this.hooks.link(input, this);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createStoreError('invalid_state', 'invalid_operation_shape', 'link input must be object', 400);
    }

    const userId = assertNonEmptyString(input.userId, 'userId', 'link');
    const provider = assertSupportedProvider(input.provider, 'link');
    const providerUserId = assertNonEmptyString(input.providerUserId, 'providerUserId', 'link');

    const anchor = this._anchorKey(provider, providerUserId);
    const owner = this.anchorOwners.get(anchor);

    if (owner && owner !== userId) {
      throw createStoreError(
        'identity_link_conflict',
        'anchor_already_linked',
        'provider anchor already linked to another user',
        409,
      );
    }

    const links = this._linksForUser(userId);
    const existingForProvider = links.get(provider);
    if (existingForProvider && existingForProvider !== providerUserId) {
      throw createStoreError(
        'identity_link_conflict',
        'duplicate_provider_swap_attempt',
        'provider already linked to a different providerUserId',
        409,
      );
    }

    const outcome = existingForProvider === providerUserId ? 'noop' : 'linked';
    links.set(provider, providerUserId);
    this.userLinks.set(userId, links);
    this.anchorOwners.set(anchor, userId);

    return {
      outcome,
      link: {
        userId,
        provider,
        providerUserId,
        anchor,
      },
    };
  }

  async unlink(input) {
    if (this.hooks.unlink) {
      return this.hooks.unlink(input, this);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createStoreError('invalid_state', 'invalid_operation_shape', 'unlink input must be object', 400);
    }

    const userId = assertNonEmptyString(input.userId, 'userId', 'unlink');
    const provider = assertSupportedProvider(input.provider, 'unlink');
    const providerUserId = assertNonEmptyString(input.providerUserId, 'providerUserId', 'unlink');

    const links = this._linksForUser(userId);
    if (!links.has(provider)) {
      throw createStoreError(
        'identity_link_not_found',
        'provider_not_linked',
        'provider is not linked to this user',
        404,
      );
    }

    const linkedProviderUserId = links.get(provider);
    if (linkedProviderUserId !== providerUserId) {
      throw createStoreError(
        'identity_link_not_found',
        'provider_not_linked',
        'provider anchor is not linked to this user',
        404,
      );
    }

    if (links.size <= 1) {
      throw createStoreError(
        'last_provider_unlink_forbidden',
        'last_linked_provider',
        'cannot unlink the last provider',
        409,
      );
    }

    const anchor = this._anchorKey(provider, providerUserId);
    links.delete(provider);
    this.userLinks.set(userId, links);
    this.anchorOwners.delete(anchor);

    return {
      outcome: 'unlinked',
      userId,
      provider,
      providerUserId,
    };
  }

  async getLinksForUser(userId) {
    if (this.hooks.getLinksForUser) {
      return this.hooks.getLinksForUser(userId, this);
    }

    const normalizedUserId = assertNonEmptyString(userId, 'userId', 'getLinksForUser');
    const links = this.userLinks.get(normalizedUserId);
    if (!links) return [];

    return [...links.entries()]
      .map(([provider, providerUserId]) => ({
        userId: normalizedUserId,
        provider,
        providerUserId,
        anchor: this._anchorKey(provider, providerUserId),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

// ── MockProvider ──────────────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId = 'github-uid', email = 'user@github.com') {
    this._uid = providerUserId;
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
    'boot': { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging': { level: { ROOT: 'error' } },
    'server': { port: 0 },
    'auth': { jwt: { secret: JWT_SECRET } },
    'applications': { todo: {}, 'shopping-list': {} },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository, name: 'syncRepository', scope: 'singleton' },
    { Reference: SyncService, name: 'syncService', scope: 'singleton' },
    { Reference: AppSyncService, name: 'appSyncService', scope: 'singleton' },
    {
      Reference: ApplicationRegistry,
      name: 'applicationRegistry',
      scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }],
    },
    // AuthMiddlewareRegistrar MUST come before AppSyncController and AuthController
    // so app.use('/:application/sync') is registered before route handlers in Hono
    {
      Reference: AuthMiddlewareRegistrar,
      name: 'authMiddlewareRegistrar',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
    { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
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

  const store = new InMemoryIdentityLinkStore();

  // Set providers map on authController (runtime, not CDI-injectable from config)
  appCtx.get('authController').providers = { github: new MockProvider() };
  appCtx.get('authController').oauthIdentityLinkStore = store;
  appCtx.get('authService').oauthIdentityLinkStore = store;

  return { appCtx, app: appCtx.get('honoAdapter').app, store };
}

// ── helper: make a valid token ────────────────────────────────────────────────

async function makeToken(sub = 'user-1', providers = ['github']) {
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
      const token = await makeToken('my-uuid', ['github']);
      const res = await ctx.app.request('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.userId, 'my-uuid');
      assert.deepEqual(body.providers, ['github']);
    });
  });

  // ── GET /auth/:provider ───────────────────────────────────────────────────────

  describe('GET /auth/:provider', () => {
    it('returns authorizationURL and state (without codeVerifier) for known provider', async () => {
      const res = await ctx.app.request('/auth/github');
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
      const beginRes = await ctx.app.request('/auth/github');
      const beginBody = await beginRes.json();
      const { state } = beginBody;

      const res = await ctx.app.request(
        `/auth/github/callback?code=mock-code&state=${state}`,
      );
      assert.equal(res.status, 302);
      assert.include(['', '""'], await res.text());

      const ownerUserId = await ctx.store.getUserByProviderAnchor({
        provider: 'github',
        providerUserId: 'github-uid',
      });
      assert.isString(ownerUserId, 'callback should create provider anchor ownership');

      const storedUser = await ctx.appCtx.get('userRepository').getUser(ownerUserId);
      assert.isOk(storedUser, 'callback should create or resolve provider-linked user');
      assert.match(storedUser.userId, /^[0-9a-f-]{36}$/);

      const token = await makeToken(storedUser.userId, ['github']);
      const meRes = await ctx.app.request('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(meRes.status, 200);
      const me = await meRes.json();
      assert.equal(me.userId, storedUser.userId);
      assert.deepEqual(me.providers, ['github']);
    });

    it('returns typed 400 when state is missing', async () => {
      const res = await ctx.app.request('/auth/github/callback?code=code');
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Missing required query params: code, state');
      assert.equal(body.code, 'bad_request');
    });

    it('returns typed 400 on unknown state (CSRF/replay)', async () => {
      const res = await ctx.app.request(
        '/auth/github/callback?code=code&state=unknown-state',
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'invalid_state');
      assert.equal(body.reason, 'unknown_state');
    });

    it('returns typed non-leaky 500 when provider callback throws', async () => {
      const beginRes = await ctx.app.request('/auth/github');
      const beginBody = await beginRes.json();

      ctx.appCtx.get('authController').providers = {
        github: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            throw new Error('provider-secret-details');
          },
        },
      };

      const res = await ctx.app.request(
        `/auth/github/callback?code=mock-code&state=${beginBody.state}`,
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
      const token = await makeToken('link-user', ['github']);
      ctx.appCtx.get('authController').providers = {
        github: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            throw new Error('link-provider-secret');
          },
        },
      };

      const res = await ctx.app.request('/auth/link/github?code=abc&state=s1&stored_state=s1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Provider callback failed');
      assert.equal(body.code, 'internal_error');
      assert.notInclude(body.error, 'link-provider-secret');
    });

    it('returns typed invalid_state when provider callback payload is malformed', async () => {
      const token = await makeToken('link-user', ['github']);
      ctx.appCtx.get('authController').providers = {
        github: {
          createAuthorizationURL(state) {
            return new URL(`https://mock.provider/auth?state=${state}`);
          },
          async validateCallback() {
            return { email: 'bad@payload.dev' };
          },
        },
      };

      const res = await ctx.app.request('/auth/link/github?code=abc&state=s1&stored_state=s1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Provider callback failed');
      assert.equal(body.code, 'invalid_state');
      assert.equal(body.reason, 'malformed_provider_callback');
    });

    it('returns typed state mismatch error', async () => {
      const token = await makeToken('link-user', ['github']);

      const res = await ctx.app.request('/auth/link/github?code=abc&state=s1&stored_state=s2', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'invalid_state');
      assert.equal(body.reason, 'state_mismatch');
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
      const token = await makeToken('sync-user', ['github']);
      const res = await ctx.app.request('/todo/sync', {
        method: 'POST',
        body: JSON.stringify({ collection: 'items', clientClock: '0000000000000-000000-00000000', changes: [] }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'serverClock');
    });

    it('returns typed 404 for unknown application even with valid token', async () => {
      const token = await makeToken('sync-user', ['github']);
      const res = await ctx.app.request('/unknown-app/sync', {
        method: 'POST',
        body: JSON.stringify({ collection: 'items', clientClock: '0000000000000-000000-00000000', changes: [] }),
        headers: {
          'Content-Type': 'application/json',
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
