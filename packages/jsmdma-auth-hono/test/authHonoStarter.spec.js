/**
 * authHonoStarter.spec.js — CDI integration tests for authHonoStarter()
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import './registerBootWorkspaceMemoryDriver.js';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService, AppSyncService, ApplicationRegistry, SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import { AppSyncController } from '@alt-javascript/jsmdma-hono';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import {
  authHonoStarter,
  legacyAuthHonoControllerNames,
  splitAuthHonoStarterRegistrations,
} from '../authHonoStarter.js';

const JWT_SECRET = 'authHonoStarter-test-secret-32!!';

const BASE_CONFIG = {
  'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  'logging':      { level: { ROOT: 'error' } },
  'server':       { port: 0 },
  'auth':         { jwt: { secret: JWT_SECRET } },
  'applications': { 'test-app': {} },
  'orgs':         { registerable: false },
};

class MockProvider {
  constructor(uid = 'mock-uid', email = 'mock@test.com') {
    this._uid = uid;
    this._email = email;
  }

  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }

  async validateCallback() {
    return { providerUserId: this._uid, email: this._email };
  }
}

class InMemoryIdentityLinkStore {
  constructor() {
    this.anchorOwners = new Map();
    this.userLinks = new Map();
  }

  _anchorKey(provider, providerUserId) {
    return `${provider}::${providerUserId}`;
  }

  async getUserByProviderAnchor({ provider, providerUserId }) {
    return this.anchorOwners.get(this._anchorKey(provider, providerUserId)) ?? null;
  }

  async link({ userId, provider, providerUserId }) {
    const key = this._anchorKey(provider, providerUserId);
    this.anchorOwners.set(key, userId);

    const links = this.userLinks.get(userId) ?? new Map();
    links.set(provider, providerUserId);
    this.userLinks.set(userId, links);

    return { outcome: 'linked' };
  }

  async unlink({ userId, provider }) {
    const links = this.userLinks.get(userId) ?? new Map();
    const providerUserId = links.get(provider);
    if (providerUserId) {
      this.anchorOwners.delete(this._anchorKey(provider, providerUserId));
      links.delete(provider);
      this.userLinks.set(userId, links);
    }
    return { outcome: 'unlinked' };
  }

  async getLinksForUser(userId) {
    const links = this.userLinks.get(userId) ?? new Map();
    return [...links.entries()].map(([provider, providerUserId]) => ({ provider, providerUserId }));
  }
}

async function buildContext({ configData = BASE_CONFIG } = {}) {
  const config = new EphemeralConfig(configData);

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
    ...authHonoStarter(),
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  const store = new InMemoryIdentityLinkStore();
  appCtx.get('authController').providers = { mock: new MockProvider() };
  appCtx.get('authController').oauthIdentityLinkStore = store;
  appCtx.get('authService').oauthIdentityLinkStore = store;

  return appCtx;
}

describe('authHonoStarter()', () => {
  let appCtx;
  let app;

  before(async () => {
    appCtx = await buildContext();
    app = appCtx.get('honoAdapter').app;
  });

  it('GET /auth/me returns typed session_required without credentials', async () => {
    const res = await app.request('http://localhost/auth/me');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: 'Unauthorized',
      code: 'invalid_state',
      reason: 'session_required',
      details: {},
    });
  });

  it('POST /test-app/sync remains bearer middleware-gated', async () => {
    const res = await app.request('http://localhost/test-app/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'items', clientClock: '0', changes: [] }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: 'Unauthorized',
      code:  'unauthorized',
    });
  });

  it('GET /auth/mock returns beginAuth JSON without codeVerifier leakage', async () => {
    const res = await app.request('http://localhost/auth/mock');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.property(body, 'authorizationURL');
    assert.property(body, 'state');
    assert.notProperty(body, 'codeVerifier');
    assert.include(body.authorizationURL, 'mock.provider');
  });

  it('GET /auth/login/finalize resolves to lifecycle route (not /auth/:provider shadow)', async () => {
    const res = await app.request('http://localhost/auth/login/finalize');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'bad_request');
    assert.include(body.error, 'Missing required field');
  });

  it('GET /auth/unknown returns typed unsupported_provider', async () => {
    const res = await app.request('http://localhost/auth/unknown-provider');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'invalid_state');
    assert.equal(body.reason, 'unsupported_provider');
  });

  it('unknown routes return typed 404 envelope', async () => {
    const res = await app.request('http://localhost/no-such-route');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: 'Not Found',
      code:  'not_found',
    });
  });

  it('GET /auth/me returns user when given valid bearer JWT', async () => {
    const token = await JwtSession.sign(
      { sub: 'test-uuid', providers: ['mock'], email: 'test@example.com' },
      JWT_SECRET,
    );
    const res = await app.request('http://localhost/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, 'test-uuid');
    assert.deepEqual(body.providers, ['mock']);
    assert.equal(body.mode, 'bearer');
  });

  it('GET /auth/me returns user when given valid cookie JWT', async () => {
    const token = await JwtSession.sign(
      { sub: 'cookie-uuid', providers: ['mock'], email: 'cookie@example.com' },
      JWT_SECRET,
    );
    const res = await app.request('http://localhost/auth/me', {
      headers: { Cookie: `auth_session=${encodeURIComponent(token)}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, 'cookie-uuid');
    assert.equal(body.mode, 'cookie');
  });

  it('fails fast at startup when auth.jwt.secret is missing', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      auth: { jwt: {} },
    };

    let startupError = null;
    try {
      await buildContext({ configData: badConfig });
    } catch (err) {
      startupError = err;
    }

    assert.instanceOf(startupError, Error);
    assert.include(startupError.message, 'auth.jwt.secret');
  });

  it('fails fast at startup when auth.jwt.secret is too short', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      auth: { jwt: { secret: 'short-secret' } },
    };

    let startupError = null;
    try {
      await buildContext({ configData: badConfig });
    } catch (err) {
      startupError = err;
    }

    assert.instanceOf(startupError, Error);
    assert.include(startupError.message, 'auth.jwt.secret');
  });

  it('authHonoStarter() does not register duplicate names when called twice', async () => {
    const reg1 = authHonoStarter();
    const reg2 = authHonoStarter();
    assert.deepEqual(
      reg1.map((r) => r.name),
      reg2.map((r) => r.name),
    );

    const names = reg1.map((r) => r.name);
    assert.include(names, 'frameworkErrorContractMiddleware');
    assert.include(names, 'authMiddlewareRegistrar');
    assert.isBelow(
      names.indexOf('frameworkErrorContractMiddleware'),
      names.indexOf('authMiddlewareRegistrar'),
      'error middleware must register before auth middleware',
    );
  });

  it('splitAuthHonoStarterRegistrations() returns explicit auth infrastructure/controller boundaries', () => {
    const registrations = authHonoStarter();
    const { infrastructureRegistrations, legacyControllerRegistrations } = splitAuthHonoStarterRegistrations(registrations);

    assert.deepEqual(
      legacyControllerRegistrations.map((registration) => registration.name),
      legacyAuthHonoControllerNames,
    );

    const stitchedNames = [...infrastructureRegistrations, ...legacyControllerRegistrations]
      .map((registration) => registration.name);
    assert.deepEqual(stitchedNames, registrations.map((registration) => registration.name));

    assert.include(
      infrastructureRegistrations.map((registration) => registration.name),
      'authMiddlewareRegistrar',
      'auth middleware must remain in the infrastructure group',
    );
  });

  it('splitAuthHonoStarterRegistrations() fails fast on malformed boundary input', () => {
    const registrations = authHonoStarter();

    const withoutOrgController = registrations.filter((registration) => registration.name !== 'orgController');
    assert.throws(
      () => splitAuthHonoStarterRegistrations(withoutOrgController),
      'Missing required legacy auth controller registration(s): orgController',
    );

    const withoutAuthMiddleware = registrations.filter((registration) => registration.name !== 'authMiddlewareRegistrar');
    assert.throws(
      () => splitAuthHonoStarterRegistrations(withoutAuthMiddleware),
      'Missing required infrastructure registration(s): authMiddlewareRegistrar',
    );

    const duplicateNameRegistrations = [...registrations, { ...registrations[0] }];
    assert.throws(
      () => splitAuthHonoStarterRegistrations(duplicateNameRegistrations),
      'Duplicate registration name(s) detected: userRepository',
    );
  });
});
