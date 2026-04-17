import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from 'packages/jsmdma-hono';
import { JwtSession } from 'packages/jsmdma-auth-core';
import { HLC } from 'packages/jsmdma-core';
import CorsMiddlewareRegistrar from '../CorsMiddlewareRegistrar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_LOCAL_PATH = resolve(__dirname, '../run-local.js');

const JWT_SECRET = 'run-local-starter-spec-secret-123456';

const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner.json', import.meta.url));
const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner-preferences.json', import.meta.url));
const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../server/schemas/preferences.json', import.meta.url));

async function buildRunLocalContext() {
  const config = new EphemeralConfig({
    boot: { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    logging: { level: { ROOT: 'error' } },
    server: { port: 0, host: '127.0.0.1' },
    auth: { jwt: { secret: JWT_SECRET } },
    applications: {
      'year-planner': {
        description: 'Year planner application',
        collections: {
          planners: { schemaPath: PLANNER_SCHEMA_PATH },
          preferences: { schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH },
          'planner-preferences': { schemaPath: APP_PREFERENCES_SCHEMA_PATH },
        },
      },
    },
    orgs: { registerable: false },
  });

  const context = new Context([
    ...jsmdmaHonoStarter({
      hooks: {
        beforeAuth: [
          { Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton' },
        ],
      },
    }),
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
}

describe('run-local starter entrypoint regressions (packages/example-auth)', () => {
  it('run-local.js remains starter-based with CORS hook staged before auth', async () => {
    const source = await readFile(RUN_LOCAL_PATH, 'utf8');

    assert.match(
      source,
      /import\s*\{\s*jsmdmaHonoStarter\s*\}\s*from\s*['"]@alt-javascript\/jsmdma-hono['"];/,
    );
    assert.match(
      source,
      /\.\.\.jsmdmaHonoStarter\(\{[\s\S]*hooks:[\s\S]*beforeAuth:[\s\S]*CorsMiddlewareRegistrar[\s\S]*\}\)\s*,/,
    );

    assert.include(source, "const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner.json', import.meta.url));");
    assert.include(source, "const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner-preferences.json', import.meta.url));");
    assert.include(source, "const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../server/schemas/preferences.json', import.meta.url));");
  });

  it('starter boot keeps health up, CORS active, and /year-planner/sync auth-gated', async () => {
    const appCtx = await buildRunLocalContext();
    try {
      const app = appCtx.get('honoAdapter').app;

      const health = await app.request('/health');
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const preflight = await app.request('/year-planner/sync', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:8080',
          'Access-Control-Request-Method': 'POST',
        },
      });

      assert.include([200, 204], preflight.status, 'Expected CORS preflight to be handled');
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8080');
      assert.include((preflight.headers.get('access-control-allow-methods') || '').toUpperCase(), 'POST');

      const unauthSync = await app.request('/year-planner/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: 'planners',
          clientClock: HLC.zero(),
          changes: [],
        }),
      });
      assert.equal(unauthSync.status, 401);

      const token = await JwtSession.sign({ sub: 'local-starter-user', providers: ['test'] }, JWT_SECRET);
      const authedSync = await app.request('/year-planner/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          collection: 'planners',
          clientClock: HLC.zero(),
          changes: [],
        }),
      });

      assert.equal(authedSync.status, 200, 'Expected starter-wired sync route to stay mounted and reachable');
    } finally {
      await appCtx.stop?.();
    }
  });
});
