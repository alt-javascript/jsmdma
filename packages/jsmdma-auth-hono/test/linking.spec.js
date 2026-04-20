/**
 * linking.spec.js — Integration tests for provider linking and unlinking
 *
 * Tests the full link/unlink lifecycle via the HTTP layer.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import './registerBootWorkspaceMemoryDriver.js';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository,
  SyncService,
  AppSyncService,
  ApplicationRegistry,
  SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import { AppSyncController } from '@alt-javascript/jsmdma-hono';
import { UserRepository, AuthService } from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import AuthController from '../AuthController.js';
import AuthMiddlewareRegistrar from '../AuthMiddlewareRegistrar.js';

const JWT_SECRET = 'linking-test-secret-32-chars!!!!';
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

    const links = this._linksForUser(userId);
    if (!links.has(provider)) {
      throw createStoreError(
        'identity_link_not_found',
        'provider_not_linked',
        'provider is not linked to this user',
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

    const providerUserId = links.get(provider);
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
  constructor(providerUserId, email) {
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

async function buildContext(providers = {}) {
  const config = new EphemeralConfig({
    'boot': { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging': { level: { ROOT: 'error' } },
    'server': { port: 0 },
    'auth': { jwt: { secret: JWT_SECRET } },
    'applications': { todo: {} },
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
    {
      Reference: SchemaValidator,
      name: 'schemaValidator',
      scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }],
    },
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
  appCtx.get('authController').providers = providers;
  appCtx.get('authController').oauthIdentityLinkStore = store;
  appCtx.get('authService').oauthIdentityLinkStore = store;

  return {
    appCtx,
    app: appCtx.get('honoAdapter').app,
    repo: appCtx.get('userRepository'),
    store,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function encode(value) {
  return encodeURIComponent(value ?? '');
}

async function completeAuthCallback(app, provider, state) {
  const res = await app.request(`/auth/${provider}/callback?code=mock-code&state=${encode(state)}`);
  assert.equal(res.status, 302, `Expected callback 302, got ${res.status}`);
}

/** Login via a mock provider and return { user, token } */
async function loginAs(app, repo, store, provider, providerUserId) {
  const beginRes = await app.request(`/auth/${provider}`);
  assert.equal(beginRes.status, 200, `Expected begin auth 200, got ${beginRes.status}`);
  const { state } = await beginRes.json();

  await completeAuthCallback(app, provider, state);

  const userId = await store.getUserByProviderAnchor({ provider, providerUserId });
  assert.isString(userId, `Expected userId for provider=${provider} providerUserId=${providerUserId}`);

  const userRecord = await repo.getUser(userId);
  assert(userRecord, `Expected user record for userId=${userId}`);

  const providers = userRecord.providers.map((p) => p.provider);
  const token = await JwtSession.sign({
    sub: userRecord.userId,
    providers,
    email: userRecord.email ?? null,
  }, JWT_SECRET);

  return {
    token,
    user: {
      userId: userRecord.userId,
      email: userRecord.email ?? null,
      providers,
    },
  };
}

async function beginLink(app, provider, token) {
  const beginRes = await app.request(`/auth/${provider}?link=true`, {
    headers: authHeaders(token),
  });
  assert.equal(beginRes.status, 200, `Expected begin link 200, got ${beginRes.status}`);

  const { state } = await beginRes.json();

  return { code: 'mock-code', state, codeVerifier: '' };
}

// ── link provider ─────────────────────────────────────────────────────────────

describe('Provider linking', () => {

  it('adds a second provider to an existing user', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-1', 'user@github.com'),
      google: new MockProvider('google-uid-1', 'user@google.com'),
    });

    // Login with github
    const { user: u1, token } = await loginAs(app, repo, store, 'github', 'gh-uid-1');
    assert.deepEqual(u1.providers, ['github']);

    // Link google
    const { code, state, codeVerifier } = await beginLink(app, 'google', token);
    const linkRes = await app.request(
      `/auth/link/google?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(linkRes.status, 200, `Expected 200, got ${linkRes.status}`);
    const { user: linked } = await linkRes.json();
    assert.lengthOf(linked.providers, 2);
    const providerNames = linked.providers.map((p) => p.provider).sort();
    assert.deepEqual(providerNames, ['github', 'google']);
  });

  it('UUID remains unchanged after linking', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-stable', 'user@github.com'),
      google: new MockProvider('google-uid-stable', 'user@google.com'),
    });

    const { user: before, token } = await loginAs(app, repo, store, 'github', 'gh-uid-stable');
    const { code, state, codeVerifier } = await beginLink(app, 'google', token);
    const linkRes = await app.request(
      `/auth/link/google?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    const { user: after } = await linkRes.json();
    assert.equal(before.userId, after.userId);
  });

  it('returns typed identity_link_conflict when provider is already linked to another user', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-taken', 'user@github.com'),
      google: new MockProvider('google-uid-other', 'other@google.com'),
    });

    // Create user A with github
    await loginAs(app, repo, store, 'github', 'gh-uid-taken');

    // Create user B with google
    const { token: tokenB } = await loginAs(app, repo, store, 'google', 'google-uid-other');

    // Try to link github (already taken by user A) to user B
    const { code, state, codeVerifier } = await beginLink(app, 'github', tokenB);
    const linkRes = await app.request(
      `/auth/link/github?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(tokenB) },
    );
    assert.equal(linkRes.status, 409);
    const body = await linkRes.json();
    assert.equal(body.code, 'identity_link_conflict');
    assert.equal(body.reason, 'anchor_already_linked');
  });

  it('keeps duplicate link replay side-effect free for the same anchor', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-replay', 'user@github.com'),
      google: new MockProvider('google-uid-replay', 'user@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-replay');

    // First link
    const first = await beginLink(app, 'google', token);
    const firstRes = await app.request(
      `/auth/link/google?code=${encode(first.code)}&state=${encode(first.state)}&stored_state=${encode(first.state)}&code_verifier=${encode(first.codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(firstRes.status, 200);

    // Replay link for same anchor/user
    const second = await beginLink(app, 'google', token);
    const secondRes = await app.request(
      `/auth/link/google?code=${encode(second.code)}&state=${encode(second.state)}&stored_state=${encode(second.state)}&code_verifier=${encode(second.codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(secondRes.status, 200);

    const { user } = await secondRes.json();
    const providerNames = user.providers.map((p) => p.provider).sort();
    assert.deepEqual(providerNames, ['github', 'google']);
    assert.lengthOf(providerNames, 2, 'duplicate replay must not duplicate provider projection');
  });

  it('returns typed 400 for unsupported provider names', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-x', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-x');
    const res = await app.request('/auth/link/linkedin?code=x&state=y&stored_state=y', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'bad_request');
    assert.include(body.error, 'Unknown provider');
  });

  it('returns typed 400 for missing link query parameters', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-missing', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-missing');

    const res = await app.request('/auth/link/github?code=x&state=y', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'bad_request');
    assert.include(body.error, 'Missing required query params');
  });

  it('returns typed invalid_state for state mismatch', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-state', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-state');

    const res = await app.request('/auth/link/github?code=x&state=s1&stored_state=s2', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'state_mismatch');
  });

  it('returns 401 without token', async () => {
    const { app } = await buildContext({ github: new MockProvider('gh-uid', 'u@g.com') });
    const res = await app.request(
      '/auth/link/github?code=x&state=y&stored_state=y',
      { method: 'POST' },
    );
    assert.equal(res.status, 401);
  });

});

// ── unlink provider ───────────────────────────────────────────────────────────

describe('Provider unlinking', () => {

  it('removes a provider when user has multiple', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-2', 'user2@github.com'),
      google: new MockProvider('google-uid-2', 'user2@google.com'),
    });

    // Login with github, then link google
    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-2');
    const { code, state, codeVerifier } = await beginLink(app, 'google', token);
    await app.request(
      `/auth/link/google?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );

    // Unlink github
    const unlinkRes = await app.request('/auth/providers/github', {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    assert.equal(unlinkRes.status, 200);
    const { providers } = await unlinkRes.json();
    assert.lengthOf(providers, 1);
    assert.equal(providers[0].provider, 'google');
  });

  it('returns typed not-found when unlinking a non-linked provider', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-not-linked', 'x@github.com'),
      google: new MockProvider('google-uid-not-linked', 'x@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-not-linked');

    const res = await app.request('/auth/providers/google', {
      method: 'DELETE',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'identity_link_not_found');
    assert.equal(body.reason, 'provider_not_linked');
  });

  it('returns typed lockout when trying to remove the last provider', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-last', 'last@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-last');

    const res = await app.request('/auth/providers/github', {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'last_provider_unlink_forbidden');
    assert.equal(body.reason, 'last_linked_provider');
  });

  it('returns 401 without token', async () => {
    const { app } = await buildContext({ github: new MockProvider('gh', 'u@g.com') });
    const res = await app.request('/auth/providers/github', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

});
