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
import { SyncRepository, SyncService } from '@alt-javascript/jsmdma-server';
import { SyncController } from '@alt-javascript/jsmdma-hono';
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
    'boot':    { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging': { level: { ROOT: 'error' } },
    'server':  { port: 0 },
    'auth':    { jwt: { secret: JWT_SECRET } },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,          name: 'syncRepository',          scope: 'singleton' },
    { Reference: SyncService,             name: 'syncService',              scope: 'singleton' },
    { Reference: SyncController,          name: 'syncController',           scope: 'singleton' },
    { Reference: UserRepository,          name: 'userRepository',           scope: 'singleton' },
    {
      Reference: AuthService,
      name: 'authService',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    {
      Reference: AuthMiddlewareRegistrar,
      name: 'authMiddlewareRegistrar',
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
    app:  appCtx.get('honoAdapter').app,
    repo: appCtx.get('userRepository'),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Login via a mock provider and return { user, token } */
async function loginAs(app, provider, stateParam) {
  const beginRes  = await app.request(`/auth/${provider}`);
  const { state, codeVerifier } = await beginRes.json();
  const callbackUrl = `/auth/${provider}/callback?code=mock-code&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`;
  const res = await app.request(callbackUrl);
  return res.json();
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// ── link provider ─────────────────────────────────────────────────────────────

describe('Provider linking', () => {

  it('adds a second provider to an existing user', async () => {
    const { app, repo } = await buildContext({
      github: new MockProvider('gh-uid-1', 'user@github.com'),
      google: new MockProvider('google-uid-1', 'user@google.com'),
    });

    // Login with github
    const { user: u1, token } = await loginAs(app, 'github');
    assert.lengthOf(u1.providers, 1);

    // Get link params for google
    const beginRes = await app.request('/auth/google', { headers: authHeaders(token) });
    const { state, codeVerifier } = await beginRes.json();

    // Link google
    const linkRes = await app.request(
      `/auth/link/google?code=mock-code&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    assert.equal(linkRes.status, 200, `Expected 200, got ${linkRes.status}`);
    const { user: linked } = await linkRes.json();
    assert.lengthOf(linked.providers, 2);
    const providerNames = linked.providers.map((p) => p.provider).sort();
    assert.deepEqual(providerNames, ['github', 'google']);
  });

  it('UUID remains unchanged after linking', async () => {
    const { app } = await buildContext({
      github: new MockProvider('gh-uid-stable', 'user@github.com'),
      google: new MockProvider('google-uid-stable', 'user@google.com'),
    });

    const { user: before, token } = await loginAs(app, 'github');
    const beginRes = await app.request('/auth/google', { headers: authHeaders(token) });
    const { state, codeVerifier } = await beginRes.json();
    const linkRes = await app.request(
      `/auth/link/google?code=mock-code&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`,
      { method: 'POST', headers: authHeaders(token) },
    );
    const { user: after } = await linkRes.json();
    assert.equal(before.userId, after.userId);
  });

  it('returns 409 when provider already linked to another user', async () => {
    const { app } = await buildContext({
      github: new MockProvider('gh-uid-taken', 'user@github.com'),
      google: new MockProvider('google-uid-other', 'other@google.com'),
    });

    // Create user A with github
    await loginAs(app, 'github');

    // Create user B with google
    const { token: tokenB } = await loginAs(app, 'google');

    // Try to link github (already taken by user A) to user B
    const beginRes = await app.request('/auth/github', { headers: authHeaders(tokenB) });
    const { state, codeVerifier } = await beginRes.json();
    const linkRes = await app.request(
      `/auth/link/github?code=mock-code&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`,
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
    const { user: u1, token } = await loginAs(app, 'github');
    const beginRes = await app.request('/auth/google', { headers: authHeaders(token) });
    const { state, codeVerifier } = await beginRes.json();
    await app.request(
      `/auth/link/google?code=mock-code&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`,
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
    const { app } = await buildContext({
      github: new MockProvider('gh-uid-last', 'last@github.com'),
    });

    const { token } = await loginAs(app, 'github');

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
