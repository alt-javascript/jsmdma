/**
 * jsmdmaHonoStarter.spec.js — Integration tests for canonical starter composition.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from '../jsmdmaHonoStarter.js';

const JWT_SECRET = 'jsmdmaHonoStarter-test-secret-32!!';

const BASE_CONFIG = {
  boot:         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging:      { level: { ROOT: 'error' } },
  server:       { port: 0 },
  auth:         { jwt: { secret: JWT_SECRET } },
  applications: { todo: { description: 'Todo app' } },
  orgs:         { registerable: false },
};

async function buildContext(configData = BASE_CONFIG) {
  const config = new EphemeralConfig(configData);
  const context = new Context([
    ...jsmdmaHonoStarter(),
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
}

describe('jsmdmaHonoStarter()', () => {
  it('returns deterministic registration names across multiple calls', () => {
    const reg1 = jsmdmaHonoStarter();
    const reg2 = jsmdmaHonoStarter();

    assert.deepEqual(
      reg1.map((r) => r.name),
      reg2.map((r) => r.name),
    );

    // Boundary condition: each invocation must return a fresh array/object set.
    assert.notStrictEqual(reg1, reg2);
    assert.notStrictEqual(reg1[0], reg2[0]);

    const names = reg1.map((r) => r.name);
    assert.includeMembers(names, [
      'syncRepository',
      'syncService',
      'applicationRegistry',
      'schemaValidator',
      'authMiddlewareRegistrar',
      'authController',
      'orgController',
      'appSyncController',
    ]);
  });

  it('boots with no options and serves GET /health', async () => {
    const appCtx = await buildContext();
    const app = appCtx.get('honoAdapter').app;

    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('keeps POST /:application/sync protected (401 without JWT)', async () => {
    const appCtx = await buildContext();
    const app = appCtx.get('honoAdapter').app;

    const res = await app.request('/todo/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        collection:  'tasks',
        clientClock: '0000000000000-000000-00000000',
        changes:     [],
      }),
    });

    assert.equal(res.status, 401);
  });

  it('fails fast at startup when auth.jwt.secret is missing', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      auth: { jwt: {} },
    };

    let startupError = null;
    try {
      await buildContext(badConfig);
    } catch (err) {
      startupError = err;
    }

    assert.instanceOf(startupError, Error);
    assert.include(startupError.message, 'auth.jwt.secret');
  });

  it('fails fast at startup when auth.jwt.secret is invalid', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      auth: { jwt: { secret: 'too-short' } },
    };

    let startupError = null;
    try {
      await buildContext(badConfig);
    } catch (err) {
      startupError = err;
    }

    assert.instanceOf(startupError, Error);
    assert.include(startupError.message, 'auth.jwt.secret');
  });
});
