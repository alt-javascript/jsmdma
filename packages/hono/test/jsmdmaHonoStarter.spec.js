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

class BeforeSyncHook {
  routes() {}
}

class BeforeAppSyncHook {
  routes() {}
}

class AfterAppSyncHook {
  routes() {}
}

async function buildContext({ configData = BASE_CONFIG, starterOptions } = {}) {
  const config = new EphemeralConfig(configData);
  const context = new Context([
    ...jsmdmaHonoStarter(starterOptions),
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

  it('keeps default config pass-through bindings for applications + auth.jwt.secret', () => {
    const regs = jsmdmaHonoStarter();

    const configValidator = regs.find((r) => r.name === 'jsmdmaHonoStarterConfigValidator');
    const applicationRegistry = regs.find((r) => r.name === 'applicationRegistry');
    const schemaValidator = regs.find((r) => r.name === 'schemaValidator');
    const authMiddlewareRegistrar = regs.find((r) => r.name === 'authMiddlewareRegistrar');

    assert.deepEqual(configValidator?.properties, [
      { name: 'jwtSecret', path: 'auth.jwt.secret' },
      { name: 'applications', path: 'applications' },
    ]);
    assert.deepEqual(applicationRegistry?.properties, [{ name: 'applications', path: 'applications' }]);
    assert.deepEqual(schemaValidator?.properties, [{ name: 'applications', path: 'applications' }]);
    assert.deepEqual(authMiddlewareRegistrar?.properties, [{ name: 'jwtSecret', path: 'auth.jwt.secret' }]);
  });

  it('respects hook stage ordering around auth middleware and app sync controller', () => {
    const regs = jsmdmaHonoStarter({
      hooks: {
        beforeSync: [BeforeSyncHook],
        beforeAuth: [{ Reference: class BeforeAuthHook { routes() {} }, name: 'beforeAuthHook', scope: 'singleton' }],
        beforeAppSync: [BeforeAppSyncHook],
        afterAppSync: [AfterAppSyncHook],
      },
    });

    const names = regs.map((r) => r.name);

    const beforeSyncIdx = names.indexOf('beforeSyncHook');
    const syncRepositoryIdx = names.indexOf('syncRepository');
    const beforeAuthIdx = names.indexOf('beforeAuthHook');
    const authMiddlewareIdx = names.indexOf('authMiddlewareRegistrar');
    const beforeAppSyncIdx = names.indexOf('beforeAppSyncHook');
    const appSyncIdx = names.indexOf('appSyncController');
    const afterAppSyncIdx = names.indexOf('afterAppSyncHook');

    assert.isAtLeast(beforeSyncIdx, 0);
    assert.isBelow(beforeSyncIdx, syncRepositoryIdx, 'beforeSync hook should be inserted before sync stack');

    assert.isAtLeast(beforeAuthIdx, 0);
    assert.isBelow(beforeAuthIdx, authMiddlewareIdx, 'beforeAuth hook should be inserted before auth middleware');

    assert.isAtLeast(beforeAppSyncIdx, 0);
    assert.isBelow(authMiddlewareIdx, beforeAppSyncIdx, 'auth middleware must remain before beforeAppSync stage');
    assert.isBelow(beforeAppSyncIdx, appSyncIdx, 'beforeAppSync hook should be inserted before appSyncController');

    assert.isAtLeast(afterAppSyncIdx, 0);
    assert.isAbove(afterAppSyncIdx, appSyncIdx, 'afterAppSync hook should be inserted after appSyncController');
  });

  it('rejects malformed features payloads and unsupported feature keys', () => {
    assert.throws(
      () => jsmdmaHonoStarter({ features: 'not-an-object' }),
      'features must be an object map of boolean flags',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ features: { sync: 'yes' } }),
      'features.sync must be a boolean',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ features: { unknownFeature: true } }),
      'Unsupported feature flag(s): unknownFeature',
    );
  });

  it('rejects malformed hook stage payloads and unsupported stages', () => {
    assert.throws(
      () => jsmdmaHonoStarter({ hooks: 'not-an-object' }),
      'hooks must be an object map keyed by hook stage',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ hooks: { madeUpStage: [] } }),
      'Unsupported hook stage(s): madeUpStage',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ hooks: { beforeAuth: [123] } }),
      'hooks.beforeAuth[0] must be a function/class or a registration object',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ hooks: { beforeAuth: [{ name: 'noReference' }] } }),
      'hooks.beforeAuth[0] registration object must include Reference (function/class)',
    );
  });

  it('rejects feature combinations that violate dependency closure', () => {
    assert.throws(
      () => jsmdmaHonoStarter({ features: { auth: false, sync: true } }),
      'features.sync requires features.auth=true',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ features: { sync: false, appSyncController: true } }),
      'features.appSyncController requires features.sync=true',
    );
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

  it('boots with a supported auth-only feature set (no sync stack)', async () => {
    const appCtx = await buildContext({
      starterOptions: {
        features: {
          sync: false,
          appSyncController: false,
        },
      },
    });
    const app = appCtx.get('honoAdapter').app;

    const regs = jsmdmaHonoStarter({
      features: {
        sync: false,
        appSyncController: false,
      },
    });
    const names = regs.map((r) => r.name);

    assert.notInclude(names, 'syncRepository');
    assert.notInclude(names, 'syncService');
    assert.notInclude(names, 'applicationRegistry');
    assert.notInclude(names, 'schemaValidator');
    assert.notInclude(names, 'appSyncController');
    assert.include(names, 'authMiddlewareRegistrar');

    const authMe = await app.request('/auth/me');
    assert.equal(authMe.status, 401);
  });

  it('boots with maximal supported options (explicit features + all hook stages)', async () => {
    const starterOptions = {
      features: {
        configValidation: true,
        sync:             true,
        auth:             true,
        appSyncController: true,
      },
      hooks: {
        beforeSync: [BeforeSyncHook],
        beforeAuth: [{ Reference: class BeforeAuthHookMax { routes() {} }, name: 'beforeAuthHookMax', scope: 'singleton' }],
        beforeAppSync: [BeforeAppSyncHook],
        afterAppSync: [AfterAppSyncHook],
      },
    };

    const appCtx = await buildContext({ starterOptions });
    const app = appCtx.get('honoAdapter').app;

    const health = await app.request('/health');
    assert.equal(health.status, 200);

    const syncWithoutJwt = await app.request('/todo/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ collection: 'tasks', clientClock: '0', changes: [] }),
    });
    assert.equal(syncWithoutJwt.status, 401);
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

  it('fails fast at startup when auth.jwt.secret is invalid', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      auth: { jwt: { secret: 'too-short' } },
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

  it('fails fast at startup when applications config is malformed for sync-enabled composition', async () => {
    const badConfig = {
      ...BASE_CONFIG,
      applications: ['not', 'an', 'object'],
    };

    let startupError = null;
    try {
      await buildContext({ configData: badConfig });
    } catch (err) {
      startupError = err;
    }

    assert.instanceOf(startupError, Error);
    assert.include(startupError.message, 'applications');
  });
});
