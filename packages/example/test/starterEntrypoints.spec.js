import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import {
  jsmdmaHonoStarter,
  DocIndexController,
  SearchController,
  ExportController,
  DeletionController,
} from '@alt-javascript/jsmdma-hono';
import {
  SearchService,
  DocumentIndexRepository,
  ExportService,
  DeletionService,
} from '@alt-javascript/jsmdma-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_JS_PATH = resolve(__dirname, '../run.js');
const RUN_APPS_PATH = resolve(__dirname, '../run-apps.js');

const RUN_JS_JWT_SECRET = 'example-jwt-secret-at-least-32-chars!';
const RUN_APPS_JWT_SECRET = 'run-apps-jwt-secret-at-least-32chars!';

const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../schemas/planner.json', import.meta.url));
const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../schemas/planner-preferences.json', import.meta.url));
const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../server/schemas/preferences.json', import.meta.url));

const RUN_JS_APPLICATION = 'shared-notes';

const RUN_APPS_APPLICATIONS_CONFIG = {
  todo: {
    description: 'To-do lists',
    collections: {
      tasks: {
        schema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            done: { type: 'boolean' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            notes: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
  },
  'shopping-list': {
    description: 'Shopping lists (free-form, no schema)',
  },
  'year-planner': {
    description: 'Year planner application',
    collections: {
      planners: { schemaPath: PLANNER_SCHEMA_PATH },
      preferences: { schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH },
      'planner-preferences': { schemaPath: APP_PREFERENCES_SCHEMA_PATH },
    },
  },
};

async function buildRunJsContext() {
  const config = new EphemeralConfig({
    boot: { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    logging: { level: { ROOT: 'error' } },
    server: { port: 0 },
    auth: { jwt: { secret: RUN_JS_JWT_SECRET } },
    applications: {
      [RUN_JS_APPLICATION]: { description: 'Shared notes application (example)' },
    },
    orgs: { registerable: false },
  });

  const context = new Context([
    ...jsmdmaHonoStarter(),
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
}

async function buildRunAppsContext() {
  const config = new EphemeralConfig({
    boot: { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    logging: { level: { ROOT: 'error' } },
    server: { port: 0 },
    auth: { jwt: { secret: RUN_APPS_JWT_SECRET } },
    applications: RUN_APPS_APPLICATIONS_CONFIG,
    orgs: { registerable: true },
  });

  const context = new Context([
    ...jsmdmaHonoStarter({
      hooks: {
        beforeAppSync: [
          { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
          { Reference: SearchService, name: 'searchService', scope: 'singleton' },
          { Reference: ExportService, name: 'exportService', scope: 'singleton' },
          { Reference: DeletionService, name: 'deletionService', scope: 'singleton' },
        ],
        afterAppSync: [
          { Reference: DocIndexController, name: 'docIndexController', scope: 'singleton' },
          { Reference: SearchController, name: 'searchController', scope: 'singleton' },
          { Reference: ExportController, name: 'exportController', scope: 'singleton' },
          { Reference: DeletionController, name: 'deletionController', scope: 'singleton' },
        ],
      },
    }),
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
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

describe('starter entrypoint regressions (packages/example)', () => {
  describe('source contracts', () => {
    it('run.js remains starter-based (no manual sync/auth assembly)', async () => {
      const source = await readFile(RUN_JS_PATH, 'utf8');

      assert.match(
        source,
        /import\s*\{\s*jsmdmaHonoStarter\s*\}\s*from\s*['"]@alt-javascript\/jsmdma-hono['"];/,
      );
      assert.match(source, /new\s+Context\(\s*\[\s*\.\.\.jsmdmaHonoStarter\(\)\s*,?\s*\]\s*\)/s);

      // Guard against regressing this entrypoint to manual wiring imports.
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-server['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-auth-hono['"]/);
    });

    it('run-apps.js keeps starter hooks and dual preferences ownership paths', async () => {
      const source = await readFile(RUN_APPS_PATH, 'utf8');

      assert.match(source, /\.\.\.jsmdmaHonoStarter\(\{[\s\S]*hooks:[\s\S]*beforeAppSync:[\s\S]*afterAppSync:[\s\S]*\}\)\s*,/);

      assert.include(source, "const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('./schemas/planner-preferences.json', import.meta.url));");
      assert.include(source, "const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../server/schemas/preferences.json', import.meta.url));");
      assert.include(source, "'planner-preferences': {");
      assert.include(source, 'schemaPath: APP_PREFERENCES_SCHEMA_PATH');
      assert.include(source, 'schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH');
    });
  });

  describe('runtime contracts', () => {
    it('run.js composition serves /health and keeps /shared-notes/sync JWT-gated', async () => {
      const appCtx = await buildRunJsContext();
      try {
        const app = appCtx.get('honoAdapter').app;

        const health = await app.request('/health');
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: 'ok' });

        const unauthSync = await app.request(`/${RUN_JS_APPLICATION}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection: 'notes',
            clientClock: HLC.zero(),
            changes: [],
          }),
        });

        assert.equal(unauthSync.status, 401);
      } finally {
        await appCtx.stop?.();
      }
    });

    it('run-apps composition keeps preference boundary checks and hook-mounted routes live', async () => {
      const appCtx = await buildRunAppsContext();
      try {
        const app = appCtx.get('honoAdapter').app;

        const health = await app.request('/health');
        assert.equal(health.status, 200);

        const token = await JwtSession.sign(
          { sub: 'starter-entrypoint-user', providers: ['test'] },
          RUN_APPS_JWT_SECRET,
        );

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
  });
});
