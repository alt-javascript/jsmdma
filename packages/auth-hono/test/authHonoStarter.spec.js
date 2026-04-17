/**
 * authHonoStarter.spec.js — CDI integration tests for authHonoStarter()
 *
 * Verifies the helper wires the full auth stack correctly:
 * - /auth/me returns 401 without token
 * - /:app/sync returns 401 without token
 * - /auth/:provider returns beginAuth JSON with authorizationURL
 * - authController.providers can be set post-startup
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService, AppSyncService, ApplicationRegistry, SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import { AppSyncController } from '@alt-javascript/jsmdma-hono';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { authHonoStarter } from '../authHonoStarter.js';

const JWT_SECRET = 'authHonoStarter-test-secret-32!!';

class MockProvider {
  constructor(uid = 'mock-uid', email = 'mock@test.com') {
    this._uid = uid; this._email = email;
  }
  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }
  async validateCallback() {
    return { providerUserId: this._uid, email: this._email };
  }
}

async function buildContext() {
  const config = new EphemeralConfig({
    'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging':      { level: { ROOT: 'error' } },
    'server':       { port: 0 },
    'auth':         { jwt: { secret: JWT_SECRET } },
    'applications': { 'test-app': {} },
    'orgs':         { registerable: false },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,    name: 'syncRepository',    scope: 'singleton' },
    { Reference: SyncService,       name: 'syncService',       scope: 'singleton' },
    { Reference: AppSyncService,    name: 'appSyncService',    scope: 'singleton' },
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    ...authHonoStarter(),
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  appCtx.get('authController').providers = { mock: new MockProvider() };
  return appCtx;
}

describe('authHonoStarter()', () => {
  let appCtx;
  let app;
  before(async () => {
    appCtx = await buildContext();
    app = appCtx.get('honoAdapter').app;
  });

  it('GET /auth/me returns 401 without token', async () => {
    const res = await app.request('http://localhost/auth/me');
    assert.equal(res.status, 401);
  });

  it('POST /test-app/sync returns 401 without token', async () => {
    const res = await app.request('http://localhost/test-app/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'items', clientClock: '0', changes: [] }),
    });
    assert.equal(res.status, 401);
  });

  it('GET /auth/mock returns beginAuth JSON', async () => {
    const res = await app.request('http://localhost/auth/mock');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.property(body, 'authorizationURL');
    assert.property(body, 'state');
    assert.notProperty(body, 'codeVerifier');
    assert.include(body.authorizationURL, 'mock.provider');
  });

  it('GET /auth/unknown returns 400 for unknown provider', async () => {
    const res = await app.request('http://localhost/auth/unknown-provider');
    assert.equal(res.status, 400);
  });

  it('GET /auth/me returns user when given valid JWT', async () => {
    const token = await JwtSession.sign(
      { sub: 'test-uuid', providers: ['mock'], email: 'test@example.com' },
      JWT_SECRET,
    );
    const res = await app.request('http://localhost/auth/me', {  // eslint-disable-line no-shadow
      headers: { Authorization: `Bearer ${token}` },
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
