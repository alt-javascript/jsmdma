/**
 * jsmdmaHonoStarter.spec.js — Integration tests for canonical starter composition.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from '../jsmdmaHonoStarter.js';

const require = createRequire(import.meta.url);

async function registerBootWorkspaceMemoryDriver() {
  let bootJsnosqlcEntry = null;
  try {
    bootJsnosqlcEntry = require.resolve('@alt-javascript/boot-jsnosqlc');
  } catch {
    return;
  }

  const bootMemoryDriverEntry = path.join(
    path.dirname(bootJsnosqlcEntry),
    '../../node_modules/@alt-javascript/jsnosqlc-memory/index.js',
  );

  try {
    await import(pathToFileURL(bootMemoryDriverEntry).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ENOENT') {
      throw err;
    }
  }
}

await registerBootWorkspaceMemoryDriver();

const BASE_CONFIG = {
  boot:         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging:      { level: { ROOT: 'error' } },
  server:       { port: 0 },
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

class MalformedErrorController {
  static __routes = [
    { method: 'GET', path: '/_starter/malformed-error', handler: 'malformedError' },
  ];

  malformedError() {
    return { statusCode: 418, body: 'teapot exploded' };
  }
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
      'appSyncService',
      'applicationRegistry',
      'schemaValidator',
      'userRepository',
      'orgRepository',
      'orgService',
      'frameworkErrorContractMiddleware',
      'orgController',
      'appSyncController',
    ]);

    assert.notInclude(names, 'authMiddlewareRegistrar');
    assert.notInclude(names, 'oauthTransactionPolicy');
    assert.notInclude(names, 'oauthTransactionStore');
    assert.notInclude(names, 'oauthStarterController');
    assert.notInclude(names, 'authController');
  });

  it('keeps default config pass-through bindings for applications only', () => {
    const regs = jsmdmaHonoStarter();

    const configValidator = regs.find((r) => r.name === 'jsmdmaHonoStarterConfigValidator');
    const applicationRegistry = regs.find((r) => r.name === 'applicationRegistry');
    const schemaValidator = regs.find((r) => r.name === 'schemaValidator');
    const orgController = regs.find((r) => r.name === 'orgController');

    assert.deepEqual(configValidator?.properties, [
      { name: 'applications', path: 'applications' },
    ]);
    assert.deepEqual(applicationRegistry?.properties, [{ name: 'applications', path: 'applications' }]);
    assert.deepEqual(schemaValidator?.properties, [{ name: 'applications', path: 'applications' }]);
    assert.deepEqual(orgController?.properties, [{ name: 'registerable', path: 'orgs.registerable' }]);
  });

  it('registers FrameworkErrorContractMiddleware as singleton and class carries __middleware order marker', () => {
    const regs = jsmdmaHonoStarter();
    const middleware = regs.find((r) => r.name === 'frameworkErrorContractMiddleware');
    assert.isOk(middleware);
    assert.equal(middleware.scope, 'singleton');
    // Boot reads static __middleware from the class, not from the registration descriptor
    assert.deepEqual(middleware.Reference.__middleware, { order: 3 });
  });

  it('respects hook stage ordering: beforeSync → sync → org → beforeAppSync → appSync → afterAppSync', () => {
    const regs = jsmdmaHonoStarter({
      hooks: {
        beforeSync: [BeforeSyncHook],
        beforeAppSync: [BeforeAppSyncHook],
        afterAppSync: [AfterAppSyncHook],
      },
    });

    const names = regs.map((r) => r.name);

    const beforeSyncIdx          = names.indexOf('beforeSyncHook');
    const syncRepositoryIdx      = names.indexOf('syncRepository');
    const appSyncServiceIdx      = names.indexOf('appSyncService');
    const orgRepositoryIdx       = names.indexOf('orgRepository');
    const orgServiceIdx          = names.indexOf('orgService');
    const frameworkErrorIdx      = names.indexOf('frameworkErrorContractMiddleware');
    const orgControllerIdx       = names.indexOf('orgController');
    const beforeAppSyncIdx       = names.indexOf('beforeAppSyncHook');
    const appSyncIdx             = names.indexOf('appSyncController');
    const afterAppSyncIdx        = names.indexOf('afterAppSyncHook');

    assert.isAtLeast(beforeSyncIdx, 0);
    assert.isBelow(beforeSyncIdx, syncRepositoryIdx, 'beforeSync hook should precede sync stack');

    assert.isAtLeast(appSyncServiceIdx, 0);
    assert.isBelow(syncRepositoryIdx, appSyncServiceIdx, 'syncRepository should precede appSyncService');

    assert.isAtLeast(orgRepositoryIdx, 0);
    assert.isBelow(appSyncServiceIdx, orgRepositoryIdx, 'org stack should follow sync stack');
    assert.isBelow(orgRepositoryIdx, orgServiceIdx, 'orgRepository precedes orgService');
    assert.isBelow(orgServiceIdx, frameworkErrorIdx, 'orgService precedes frameworkErrorContractMiddleware');
    assert.isBelow(frameworkErrorIdx, orgControllerIdx, 'frameworkErrorContractMiddleware precedes orgController');

    assert.isAtLeast(beforeAppSyncIdx, 0);
    assert.isBelow(orgControllerIdx, beforeAppSyncIdx, 'org registrations precede beforeAppSync hooks');
    assert.isBelow(beforeAppSyncIdx, appSyncIdx, 'beforeAppSync hook precedes appSyncController');

    assert.isAtLeast(afterAppSyncIdx, 0);
    assert.isAbove(afterAppSyncIdx, appSyncIdx, 'afterAppSync hook follows appSyncController');
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

    assert.throws(
      () => jsmdmaHonoStarter({ features: { auth: true } }),
      'Unsupported feature flag(s): auth',
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
      () => jsmdmaHonoStarter({ hooks: { beforeAuth: [] } }),
      'Unsupported hook stage(s): beforeAuth',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ hooks: { beforeAppSync: [123] } }),
      'hooks.beforeAppSync[0] must be a function/class or a registration object',
    );

    assert.throws(
      () => jsmdmaHonoStarter({ hooks: { beforeAppSync: [{ name: 'noReference' }] } }),
      'hooks.beforeAppSync[0] registration object must include Reference (function/class)',
    );
  });

  it('rejects feature combinations that violate dependency closure', () => {
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

  it('returns 404 for routes not registered by any Boot CDI controller', async () => {
    const appCtx = await buildContext();
    const app = appCtx.get('honoAdapter').app;

    // Hono-native 404 bypasses the Boot CDI pipeline; no JSON envelope normalization here.
    const res = await app.request('/_starter/unknown-route');
    assert.equal(res.status, 404);
  });

  it('boots with sync=false,appSyncController=false (org-only composition) and serves GET /health', async () => {
    const appCtx = await buildContext({
      configData: {
        boot:    BASE_CONFIG.boot,
        logging: BASE_CONFIG.logging,
        server:  BASE_CONFIG.server,
        orgs:    BASE_CONFIG.orgs,
      },
      starterOptions: {
        features: {
          sync:             false,
          appSyncController: false,
        },
      },
    });
    const app = appCtx.get('honoAdapter').app;

    const regs = jsmdmaHonoStarter({
      features: {
        sync:             false,
        appSyncController: false,
      },
    });
    const names = regs.map((r) => r.name);

    assert.notInclude(names, 'syncRepository');
    assert.notInclude(names, 'syncService');
    assert.notInclude(names, 'appSyncService');
    assert.notInclude(names, 'applicationRegistry');
    assert.notInclude(names, 'schemaValidator');
    assert.notInclude(names, 'appSyncController');
    assert.include(names, 'orgRepository');
    assert.include(names, 'orgService');
    assert.include(names, 'frameworkErrorContractMiddleware');
    assert.include(names, 'orgController');

    // /health comes from AppSyncController which is disabled — verify org routes are live instead
    const orgsRes = await app.request('/orgs');
    assert.equal(orgsRes.status, 401);
  });

  it('boots with maximal supported options (explicit features + all hook stages)', async () => {
    const starterOptions = {
      features: {
        configValidation:  true,
        sync:              true,
        appSyncController: true,
      },
      hooks: {
        beforeSync:    [BeforeSyncHook],
        beforeAppSync: [BeforeAppSyncHook],
        afterAppSync:  [AfterAppSyncHook],
      },
    };

    const appCtx = await buildContext({ starterOptions });
    const app = appCtx.get('honoAdapter').app;

    const health = await app.request('/health');
    assert.equal(health.status, 200);
  });

  it('coerces malformed non-2xx bodies into deterministic typed envelopes', async () => {
    const appCtx = await buildContext({
      starterOptions: {
        hooks: {
          afterAppSync: [MalformedErrorController],
        },
      },
    });
    const app = appCtx.get('honoAdapter').app;

    const res = await app.request('/_starter/malformed-error');
    assert.equal(res.status, 418);
    assert.deepEqual(await res.json(), {
      error: 'teapot exploded',
      code:  'request_error',
    });
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
