/**
 * linking.spec.js — Integration tests for provider linking and unlinking
 *
 * Tests the full link/unlink lifecycle via the HTTP layer.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
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

// ── MockProvider ──────────────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId, email) {
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

async function buildContext(providers = {}) {
  const config = new EphemeralConfig({
    'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging':      { level: { ROOT: 'error' } },
    'server':       { port: 0 },
    'auth':         { jwt: { secret: JWT_SECRET } },
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

  appCtx.get('authController').providers = providers;

  return {
    appCtx,
    app: appCtx.get('honoAdapter').app,
    repo: appCtx.get('userRepository'),
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
async function loginAs(app, repo, provider, providerUserId) {
  const beginRes = await app.request(`/auth/${provider}`);
  assert.equal(beginRes.status, 200, `Expected begin auth 200, got ${beginRes.status}`);
  const { state } = await beginRes.json();

  await completeAuthCallback(app, provider, state);

  const userRecord = await repo.findByProvider(provider, providerUserId);
  assert(userRecord, `Expected user for provider=${provider} providerUserId=${providerUserId}`);

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
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-1', 'user@github.com'),
      google: new MockProvider('google-uid-1', 'user@google.com'),
    });

    // Login with github
    const { user: u1, token } = await loginAs(app, repo, 'github', 'gh-uid-1');
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
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-stable', 'user@github.com'),
      google: new MockProvider('google-uid-stable', 'user@google.com'),
    });

    const { user: before, token } = await loginAs(app, repo, 'github', 'gh-uid-stable');
    const { code, state, codeVerifier } = await beginLink(app, 'google', token);
    const linkRes = await app.request(
      `/auth/link/google?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    const { user: after } = await linkRes.json();
    assert.equal(before.userId, after.userId);
  });

  it('returns 409 when provider already linked to another user', async () => {
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-taken', 'user@github.com'),
      google: new MockProvider('google-uid-other', 'other@google.com'),
    });

    // Create user A with github
    await loginAs(app, repo, 'github', 'gh-uid-taken');

    // Create user B with google
    const { token: tokenB } = await loginAs(app, repo, 'google', 'google-uid-other');

    // Try to link github (already taken by user A) to user B
    const { code, state, codeVerifier } = await beginLink(app, 'github', tokenB);
    const linkRes = await app.request(
      `/auth/link/github?code=${encode(code)}&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=${encode(codeVerifier)}`,
      { method: 'POST', headers: authHeaders(tokenB) },
    );
    assert.equal(linkRes.status, 409);
    const body = await linkRes.json();
    assert.include(body.error.toLowerCase(), 'already linked');
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
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-2', 'user2@github.com'),
      google: new MockProvider('google-uid-2', 'user2@google.com'),
    });

    // Login with github, then link google
    const { token } = await loginAs(app, repo, 'github', 'gh-uid-2');
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

  it('returns 409 when trying to remove the last provider', async () => {
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-last', 'last@github.com'),
    });

    const { token } = await loginAs(app, repo, 'github', 'gh-uid-last');

    const res = await app.request('/auth/providers/github', {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.include(body.error.toLowerCase(), 'last provider');
  });

  it('returns 401 without token', async () => {
    const { app } = await buildContext({ github: new MockProvider('gh', 'u@g.com') });
    const res = await app.request('/auth/providers/github', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

});
