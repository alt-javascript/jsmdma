/**
 * linking.spec.js — Integration tests for provider linking/unlinking via mode-aware lifecycle routes
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
    this.anchorOwners = new Map();
    this.userLinks = new Map();
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
    {
      Reference: AuthController,
      name: 'authController',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
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

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function encode(value) {
  return encodeURIComponent(value ?? '');
}

async function beginAuth(app, provider, query = '') {
  const res = await app.request(`/auth/${provider}${query}`);
  assert.equal(res.status, 200, `Expected begin auth 200, got ${res.status}`);
  return res.json();
}

/** Login via a mock provider and return { user, token } */
async function loginAs(app, repo, store, provider, providerUserId) {
  const begin = await beginAuth(app, provider);

  const finalize = await app.request(
    `/auth/login/finalize?provider=${encode(provider)}&code=mock-code&state=${encode(begin.state)}&mode=bearer`,
    { method: 'POST' },
  );
  assert.equal(finalize.status, 200, `Expected login finalize 200, got ${finalize.status}`);

  const body = await finalize.json();
  assert.isString(body.token);

  const userId = await store.getUserByProviderAnchor({ provider, providerUserId });
  assert.isString(userId, `Expected userId for provider=${provider} providerUserId=${providerUserId}`);

  const userRecord = await repo.getUser(userId);
  assert(userRecord, `Expected user record for userId=${userId}`);

  return {
    token: body.token,
    user: {
      userId: userRecord.userId,
      email: userRecord.email ?? null,
      providers: userRecord.providers.map((p) => p.provider),
    },
  };
}

async function beginLink(app, provider) {
  const beginRes = await beginAuth(app, provider, '?link=true');
  return { code: 'mock-code', state: beginRes.state, codeVerifier: '' };
}

describe('Provider linking (mode-aware lifecycle routes)', () => {
  it('adds a second provider to an existing user', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-1', 'user@github.com'),
      google: new MockProvider('google-uid-1', 'user@google.com'),
    });

    const { user: before, token } = await loginAs(app, repo, store, 'github', 'gh-uid-1');
    assert.deepEqual(before.providers, ['github']);

    const { code, state, codeVerifier } = await beginLink(app, 'google');
    const linkRes = await app.request(
      `/auth/link/finalize?provider=google&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );

    assert.equal(linkRes.status, 200, `Expected 200, got ${linkRes.status}`);
    const { user: linked } = await linkRes.json();
    const providerNames = linked.providers.map((p) => p.provider).sort();
    assert.deepEqual(providerNames, ['github', 'google']);
  });

  it('UUID remains unchanged after linking', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-stable', 'user@github.com'),
      google: new MockProvider('google-uid-stable', 'user@google.com'),
    });

    const { user: before, token } = await loginAs(app, repo, store, 'github', 'gh-uid-stable');
    const { code, state, codeVerifier } = await beginLink(app, 'google');
    const linkRes = await app.request(
      `/auth/link/finalize?provider=google&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
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

    await loginAs(app, repo, store, 'github', 'gh-uid-taken');
    const { token: tokenB } = await loginAs(app, repo, store, 'google', 'google-uid-other');

    const { code, state, codeVerifier } = await beginLink(app, 'github');
    const linkRes = await app.request(
      `/auth/link/finalize?provider=github&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
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

    const first = await beginLink(app, 'google');
    const firstRes = await app.request(
      `/auth/link/finalize?provider=google&code=${encode(first.code)}&state=${encode(first.state)}&stored_state=${encode(first.state)}&code_verifier=${encode(first.codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(firstRes.status, 200);

    const second = await beginLink(app, 'google');
    const secondRes = await app.request(
      `/auth/link/finalize?provider=google&code=${encode(second.code)}&state=${encode(second.state)}&stored_state=${encode(second.state)}&code_verifier=${encode(second.codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(secondRes.status, 200);

    const { user } = await secondRes.json();
    const providerNames = user.providers.map((p) => p.provider).sort();
    assert.deepEqual(providerNames, ['github', 'google']);
    assert.lengthOf(providerNames, 2, 'duplicate replay must not duplicate provider projection');
  });

  it('returns typed unsupported_provider for unsupported provider names', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-x', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-x');
    const res = await app.request('/auth/link/finalize?provider=linkedin&code=x&state=y&stored_state=y', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'unsupported_provider');
  });

  it('returns typed 400 for missing link query parameters', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-missing', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-missing');

    const res = await app.request('/auth/link/finalize?provider=github&code=x&state=y', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'bad_request');
    assert.include(body.error, 'Missing required field');
  });

  it('returns typed invalid_state for state mismatch', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-state', 'x@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-state');

    const res = await app.request('/auth/link/finalize?provider=github&code=x&state=s1&stored_state=s2', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'state_mismatch');
  });

  it('returns typed session_required without token', async () => {
    const { app } = await buildContext({ github: new MockProvider('gh-uid', 'u@g.com') });
    const res = await app.request('/auth/link/finalize?provider=github&code=x&state=y&stored_state=y', {
      method: 'POST',
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'session_required');
  });
});

describe('Provider unlinking (mode-aware lifecycle routes)', () => {
  it('removes a provider when user has multiple', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-2', 'user2@github.com'),
      google: new MockProvider('google-uid-2', 'user2@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-2');
    const { code, state, codeVerifier } = await beginLink(app, 'google');
    await app.request(
      `/auth/link/finalize?provider=google&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );

    const unlinkRes = await app.request('/auth/unlink/github', {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    assert.equal(unlinkRes.status, 200);
    const { providers } = await unlinkRes.json();
    assert.lengthOf(providers, 1);
    assert.equal(providers[0].provider, 'google');
  });

  it('supports POST /auth/unlink/:provider as alias', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-post', 'user@github.com'),
      google: new MockProvider('google-uid-post', 'user@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-post');
    const { code, state, codeVerifier } = await beginLink(app, 'google');
    await app.request(
      `/auth/link/finalize?provider=google&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );

    const unlinkRes = await app.request('/auth/unlink/github', {
      method: 'POST',
      headers: authHeaders(token),
    });

    assert.equal(unlinkRes.status, 200);
  });

  it('returns typed not-found when unlinking a non-linked provider', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-not-linked', 'x@github.com'),
      google: new MockProvider('google-uid-not-linked', 'x@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-not-linked');

    const res = await app.request('/auth/unlink/google', {
      method: 'DELETE',
      headers: authHeaders(token),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'identity_link_not_found');
    assert.equal(body.reason, 'provider_not_linked');
  });

  it('returns last_provider_lockout when trying to remove the last provider', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-last', 'last@github.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-last');

    const res = await app.request('/auth/unlink/github', {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'last_provider_unlink_forbidden');
    assert.equal(body.reason, 'last_provider_lockout');
  });

  it('returns session_required without token', async () => {
    const { app } = await buildContext({ github: new MockProvider('gh', 'u@g.com') });
    const res = await app.request('/auth/unlink/github', { method: 'DELETE' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'session_required');
  });

  it('returns deterministic timeout reason when link store read times out', async () => {
    const { app, repo, store } = await buildContext({
      github: new MockProvider('gh-uid-timeout', 'u@github.com'),
      google: new MockProvider('google-uid-timeout', 'u@google.com'),
    });

    const { token } = await loginAs(app, repo, store, 'github', 'gh-uid-timeout');
    const { code, state, codeVerifier } = await beginLink(app, 'google');

    store.setHook('getLinksForUser', async () => {
      const err = new Error('dependency timeout while reading links');
      err.code = 'ETIMEDOUT';
      throw err;
    });

    const res = await app.request(
      `/auth/link/finalize?provider=google&code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'dependency_timeout');
  });
});
