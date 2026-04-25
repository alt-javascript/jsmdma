import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuthSessionMiddleware } from '@alt-javascript/boot-oauth';
import { HLC } from '@alt-javascript/jsmdma-core';
import {
  FULL_STACK_APPLICATIONS_CONFIG,
  FULL_STACK_STARTER_OPTIONS,
  NO_REG_ORG_ONLY_STARTER_OPTIONS,
  buildFullStackStarterApp,
  buildFullStackStarterAppNoReg,
  buildFullStackStarterContext,
} from '../runtime/fullStackStarterApp.js';
import {
  SHARED_NOTES_APPLICATION,
  buildSharedNotesStarterContext,
} from '../runtime/sharedNotesStarterApp.js';
import { mintTestToken, TestOAuthSessionEngine } from '../../jsmdma-hono/test/helpers/mintTestToken.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_JS_PATH = resolve(__dirname, '../run.js');
const RUN_APPS_PATH = resolve(__dirname, '../run-apps.js');
const LAMBDA_HANDLER_PATH = resolve(__dirname, '../lambda-handler.js');
const FULL_STACK_RUNTIME_PATH = resolve(__dirname, '../runtime/fullStackStarterApp.js');
const SHARED_NOTES_RUNTIME_PATH = resolve(__dirname, '../runtime/sharedNotesStarterApp.js');

function withTestAuth(extraHooks = {}) {
  return {
    hooks: {
      beforeSync: [
        { Reference: TestOAuthSessionEngine, name: 'oauthSessionEngine', scope: 'singleton' },
        { Reference: OAuthSessionMiddleware,  name: 'oauthSessionMiddleware',  scope: 'singleton' },
        ...(extraHooks.beforeSync ?? []),
      ],
      ...(extraHooks.beforeAppSync ? { beforeAppSync: extraHooks.beforeAppSync } : {}),
      ...(extraHooks.afterAppSync  ? { afterAppSync:  extraHooks.afterAppSync  } : {}),
    },
  };
}

async function buildRunJsContext() {
  return buildSharedNotesStarterContext();
}

async function syncPost(app, application, body, token) {
  const res = await app.request(`/${application}/sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { status: res.status, body: await res.json() };
}

async function expectStartupFailure(factory, expectedMessagePart) {
  let error = null;
  try {
    const appCtx = await factory();
    await appCtx.stop?.();
  } catch (err) {
    error = err;
  }

  assert.instanceOf(error, Error, 'Expected startup/build to throw');
  assert.include(error.message, expectedMessagePart);
}

describe('starter entrypoint regressions (packages/example)', () => {
  describe('source contracts', () => {
    it('run.js remains helper-owned (no manual context/config startup assembly)', async () => {
      const source = await readFile(RUN_JS_PATH, 'utf8');

      assert.match(source, /from\s*['"]\.\/runtime\/sharedNotesStarterApp\.js['"]/);
      assert.match(source, /buildSharedNotesStarterApp\s*\(/);

      // Guard against regressing this entrypoint to manual startup assembly.
      assert.notMatch(source, /from\s*['"]@alt-javascript\/cdi['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/config['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-hono['"]/);
      assert.notMatch(source, /new\s+Context\(/);
      assert.notMatch(source, /new\s+ApplicationContext\(/);
      assert.notMatch(source, /new\s+EphemeralConfig\(/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-auth-core['"]/);
      assert.notMatch(source, /JwtSession/);
      assert.match(source, /mintTestToken/);
    });

    it('run-apps.js consumes the shared full-stack starter runtime module', async () => {
      const source = await readFile(RUN_APPS_PATH, 'utf8');

      assert.match(source, /from\s*['"]\.\/runtime\/fullStackStarterApp\.js['"]/);
      assert.match(source, /buildFullStackStarterApp\s+as\s+buildApp/);
      assert.match(source, /buildFullStackStarterAppNoReg\s+as\s+buildAppNoReg/);

      // Guard against composition drift back to inline/manual wiring in run-apps.js.
      assert.notMatch(source, /const\s+APPLICATIONS_CONFIG\s*=\s*\{/);
      assert.notMatch(source, /const\s+PLANNER_SCHEMA_PATH\s*=/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-server['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-auth-server['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-auth-core['"]/);
      assert.notMatch(source, /JwtSession/);
      assert.notMatch(source, /FULL_STACK_JWT_SECRET/);
      assert.match(source, /mintTestToken/);
    });

    it('lambda-handler.js consumes shared runtime composition and hono/aws-lambda adapter wiring', async () => {
      const source = await readFile(LAMBDA_HANDLER_PATH, 'utf8');

      assert.match(source, /import\s*\{\s*handle\s*\}\s*from\s*['"]hono\/aws-lambda['"];/);
      assert.match(source, /import\s*\{\s*buildFullStackStarterApp\s*\}\s*from\s*['"]\.\/runtime\/fullStackStarterApp\.js['"];/);
      assert.match(source, /appBuilder\s*=\s*buildFullStackStarterApp/);
      assert.match(source, /const\s+lambdaAdapter\s*=\s*handle\(appRuntime\.app\)/);

      // Guard against composition drift back to local/manual starter wiring.
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-hono['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-server['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-auth-hono['"]/);
    });

    it('shared notes helper owns package-base config loading + boot-first startup', async () => {
      const source = await readFile(SHARED_NOTES_RUNTIME_PATH, 'utf8');

      assert.include(source, 'ConfigFactory.loadConfig');
      assert.include(source, 'Boot.boot({');
      assert.include(source, 'SHARED_NOTES_PACKAGE_BASE_PATH');
      assert.include(source, 'basePath = SHARED_NOTES_PACKAGE_BASE_PATH');
      assert.include(source, 'run: false');
      assert.include(source, 'buildSharedNotesStarterContext');
    });

    it('shared runtime module owns full-stack hooks, schema paths, and no-reg starter options', async () => {
      const source = await readFile(FULL_STACK_RUNTIME_PATH, 'utf8');

      assert.include(source, 'export const FULL_STACK_APPLICATIONS_CONFIG');
      assert.include(source, 'export const FULL_STACK_STARTER_OPTIONS');
      assert.include(source, 'beforeAppSync');
      assert.include(source, 'afterAppSync');
      assert.include(source, 'export const NO_REG_ORG_ONLY_STARTER_OPTIONS');
      assert.include(source, 'ConfigFactory.loadConfig');
      assert.include(source, 'Boot.boot({');
      assert.include(source, 'FULL_STACK_PACKAGE_BASE_PATH');
      assert.include(source, 'includeOrgsRegisterable: false');
      assert.include(source, 'buildFullStackStarterAppNoReg');
    });
  });

  describe('runtime contracts', () => {
    it('run.js composition serves /health and keeps /shared-notes/sync endpoint mounted', async () => {
      const appCtx = await buildRunJsContext();
      try {
        const app = appCtx.get('honoAdapter').app;

        const health = await app.request('/health');
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: 'ok' });

        const unauthSync = await app.request(`/${SHARED_NOTES_APPLICATION}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection: 'notes',
            clientClock: HLC.zero(),
            changes: [],
          }),
        });

        // Sync endpoint is mounted — starter does not register auth middleware.
        assert.notEqual(unauthSync.status, 404);
      } finally {
        await appCtx.stop?.();
      }
    });

    it('run-apps composition keeps preference boundary checks and hook-mounted routes live', async () => {
      const { app, appCtx } = await buildFullStackStarterApp({ starterOptions: withTestAuth() });
      try {
        const health = await app.request('/health');
        assert.equal(health.status, 200);

        const token = mintTestToken({ userId: 'starter-entrypoint-user' });

        const opaqueClock = HLC.tick(HLC.zero(), Date.now());
        const genericPrefs = await syncPost(app, 'year-planner', {
          collection: 'preferences',
          clientClock: HLC.zero(),
          changes: [{
            key: 'generic-prefs',
            doc: {
              arbitraryFlag: true,
              widgetState: { nested: { value: 42 } },
            },
            fieldRevs: {
              arbitraryFlag: opaqueClock,
              widgetState: opaqueClock,
            },
            baseClock: HLC.zero(),
          }],
        }, token);

        assert.equal(genericPrefs.status, 200, `Expected generic preferences sync to pass: ${JSON.stringify(genericPrefs.body)}`);

        const strictClock = HLC.tick(opaqueClock, Date.now());
        const strictPrefsInvalid = await syncPost(app, 'year-planner', {
          collection: 'planner-preferences',
          clientClock: HLC.zero(),
          changes: [{
            key: 'strict-invalid',
            doc: {
              defaultView: 'year',
              weekStartsOn: 'monday',
              timezone: 'UTC',
              showWeekNumbers: true,
              unexpected: 'disallowed',
            },
            fieldRevs: {
              defaultView: strictClock,
              weekStartsOn: strictClock,
              timezone: strictClock,
              showWeekNumbers: strictClock,
              unexpected: strictClock,
            },
            baseClock: HLC.zero(),
          }],
        }, token);

        assert.equal(strictPrefsInvalid.status, 400);
        assert.equal(strictPrefsInvalid.body.error, 'Schema validation failed');
        assert.isTrue(
          strictPrefsInvalid.body.details.some((detail) => detail.message.includes('additional properties')),
          `Expected additionalProperties schema detail; got ${JSON.stringify(strictPrefsInvalid.body.details)}`,
        );

        // Hook-mounted SearchController must stay registered after appSync.
        const searchRes = await app.request('/year-planner/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            collection: 'planners',
            filter: { type: 'condition', field: 'meta.name', op: 'contains', value: 'Plan' },
          }),
        });

        assert.equal(searchRes.status, 200, 'Expected /year-planner/search to remain mounted via starter hooks');
        const searchBody = await searchRes.json();
        assert.isArray(searchBody.results);
      } finally {
        await appCtx.stop?.();
      }
    });

    it('no-reg helper keeps POST /orgs deterministic at 403 when orgs.registerable is absent', async () => {
      const { app, appCtx } = await buildFullStackStarterAppNoReg({ starterOptions: withTestAuth() });
      try {
        const token = mintTestToken({ userId: 'starter-no-reg-user' });

        const res = await app.request('/orgs', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'starter-no-reg-org' }),
        });

        assert.equal(res.status, 403);
        const body = await res.json();
        assert.equal(body.error, 'Organisation registration is disabled on this instance.');
      } finally {
        await appCtx.stop?.();
      }
    });
  });

  describe('failure contracts', () => {
    it('fails fast on malformed hook descriptors', async () => {
      await expectStartupFailure(
        () => buildFullStackStarterContext({
          starterOptions: {
            hooks: {
              beforeAppSync: [{ name: 'missingReference' }],
            },
          },
        }),
        'hooks.beforeAppSync[0] registration object must include Reference',
      );
    });

    it('fails fast on missing required applications config path', async () => {
      await expectStartupFailure(
        () => buildFullStackStarterContext({ applicationsConfig: null }),
        'Missing or invalid config at applications',
      );
    });

    it('fails explicitly when planner schema path overlay is missing', async () => {
      const missingSchemaPath = '/definitely-missing/planner-schema.json';
      const yearPlannerConfig = FULL_STACK_APPLICATIONS_CONFIG['year-planner'];
      const appCtx = await buildFullStackStarterContext({
        starterOptions: withTestAuth(),
        applicationsConfig: {
          ...FULL_STACK_APPLICATIONS_CONFIG,
          'year-planner': {
            ...yearPlannerConfig,
            collections: {
              ...yearPlannerConfig.collections,
              planners: {
                ...yearPlannerConfig.collections.planners,
                schemaPath: missingSchemaPath,
              },
            },
          },
        },
      });

      try {
        const app = appCtx.get('honoAdapter').app;
        const token = mintTestToken({ userId: 'missing-schema-user' });
        const badClock = HLC.tick(HLC.zero(), Date.now());

        const response = await syncPost(app, 'year-planner', {
          collection: 'planners',
          clientClock: HLC.zero(),
          changes: [{
            key: 'planner-missing-schema',
            doc: { meta: { name: 'Missing schema path' } },
            fieldRevs: { meta: badClock },
            baseClock: HLC.zero(),
          }],
        }, token);

        assert.equal(response.status, 400);
        assert.equal(response.body.error, 'Schema validation failed');
        assert.isArray(response.body.details);
        assert.isTrue(
          response.body.details.some((detail) => detail.message.includes(`SchemaValidator: failed to load schema from "${missingSchemaPath}"`)),
          `Expected missing schema path detail, got: ${JSON.stringify(response.body.details)}`,
        );
      } finally {
        await appCtx.stop?.();
      }
    });
  });

  describe('shared composition invariants', () => {
    it('exports hook stages used by run-apps and future lambda entrypoints', () => {
      assert.containsAllKeys(FULL_STACK_STARTER_OPTIONS, ['hooks']);
      assert.containsAllKeys(FULL_STACK_STARTER_OPTIONS.hooks, ['beforeAppSync', 'afterAppSync']);
      assert.isAbove(FULL_STACK_STARTER_OPTIONS.hooks.beforeAppSync.length, 0);
      assert.isAbove(FULL_STACK_STARTER_OPTIONS.hooks.afterAppSync.length, 0);
    });

    it('exports applications config with planner + preferences ownership boundary', () => {
      assert.containsAllKeys(FULL_STACK_APPLICATIONS_CONFIG, ['todo', 'shopping-list', 'year-planner']);

      const yearPlanner = FULL_STACK_APPLICATIONS_CONFIG['year-planner'];
      assert.isObject(yearPlanner.collections);
      assert.containsAllKeys(yearPlanner.collections, ['planners', 'preferences', 'planner-preferences']);
      assert.isString(yearPlanner.collections.preferences.schemaPath);
      assert.isString(yearPlanner.collections['planner-preferences'].schemaPath);
    });

    it('exports deterministic org-only no-reg starter options', () => {
      assert.deepEqual(NO_REG_ORG_ONLY_STARTER_OPTIONS.features, {
        sync: false,
        appSyncController: false,
      });
    });
  });
});
