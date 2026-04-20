import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import CorsMiddlewareRegistrar from '../CorsMiddlewareRegistrar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_LOCAL_PATH = resolve(__dirname, '../run-local.js');
const require = createRequire(import.meta.url);

async function registerBootWorkspaceMemoryDriver() {
  let bootJsnosqlcEntry = null;
  try {
    bootJsnosqlcEntry = require.resolve('@alt-javascript/boot-jsnosqlc');
  } catch {
    return;
  }

  const bootMemoryDriverEntry = resolve(
    dirname(bootJsnosqlcEntry),
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

const JWT_SECRET = 'run-local-starter-spec-secret-123456';

const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner.json', import.meta.url));
const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner-preferences.json', import.meta.url));
const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../jsmdma-server/schemas/preferences.json', import.meta.url));

const OAUTH_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/google/callback';
const OAUTH_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/github/callback';

function extractStateFromLocation(location) {
  const parsed = new URL(location, 'https://oauth.local');
  return parsed.searchParams.get('state');
}

async function buildRunLocalContext() {
  const config = new EphemeralConfig({
    boot: {
      'banner-mode': 'off',
      nosql: { url: 'jsnosqlc:memory:' },
      oauth: {
        providers: {
          google: {
            clientId: 'example-auth-google-client-id',
            redirectUri: OAUTH_GOOGLE_REDIRECT_URI,
          },
          github: {
            clientId: 'example-auth-github-client-id',
            redirectUri: OAUTH_GITHUB_REDIRECT_URI,
          },
        },
      },
    },
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
  it('run-local.js stays starter-based and advertises boot oauth config/routes', async () => {
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
    assert.include(source, "const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../jsmdma-server/schemas/preferences.json', import.meta.url));");

    assert.include(source, "const BOOT_OAUTH_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/google/callback';");
    assert.include(source, "const BOOT_OAUTH_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/github/callback';");
    assert.include(source, "'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' }, oauth: BOOT_OAUTH_PROVIDER_CONFIG },");

    assert.include(source, "console.log('    GET  /oauth/google/authorize    → boot oauth authorize start (302 + Location/Set-Cookie)');");
    assert.include(source, "console.log('    GET  /oauth/google/callback     → boot oauth callback consume (typed json envelope)');");
    assert.include(source, "console.log('    GET  /oauth/github/authorize    → boot oauth github authorize start');");
    assert.include(source, "console.log('    GET  /oauth/github/callback     → boot oauth github callback consume');");
  });

  it('starter boot keeps health/CORS/sync contracts and exposes oauth route-level behaviors', async () => {
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

      const oauthAuthorize = await app.request('/oauth/google/authorize?mode=cookie');
      assert.equal(oauthAuthorize.status, 302, 'Expected boot oauth authorize route to return redirect response');

      const oauthLocation = oauthAuthorize.headers.get('location');
      assert.isString(oauthLocation);
      assert.include(oauthLocation, 'state=');
      assert.include(oauthLocation, 'client_id=example-auth-google-client-id');
      assert.include(oauthLocation, `redirect_uri=${encodeURIComponent(OAUTH_GOOGLE_REDIRECT_URI)}`);

      const oauthSetCookie = oauthAuthorize.headers.get('set-cookie');
      assert.isString(oauthSetCookie, 'Expected authorize redirect to propagate Set-Cookie headers');
      assert.include(oauthSetCookie.toLowerCase(), 'oauth_provider=google');

      const oauthState = extractStateFromLocation(oauthLocation);
      assert.isString(oauthState);
      assert.notEqual(oauthState.length, 0);

      const callbackMissingState = await app.request('/oauth/google/callback?code=missing-state-code');
      assert.equal(callbackMissingState.status, 400);
      const callbackMissingStateBody = await callbackMissingState.json();
      assert.equal(callbackMissingStateBody?.code, 'invalid_state');
      assert.notEqual(callbackMissingState.status, 404);

      const callbackMissingCode = await app.request('/oauth/google/callback?state=missing-code-state');
      assert.equal(callbackMissingCode.status, 400);
      const callbackMissingCodeBody = await callbackMissingCode.json();
      assert.equal(callbackMissingCodeBody?.code, 'invalid_state');
      assert.notEqual(callbackMissingCode.status, 404);

      const oauthUnknownProvider = await app.request('/oauth/linkedin/authorize');
      assert.equal(oauthUnknownProvider.status, 400);
      const oauthUnknownProviderBody = await oauthUnknownProvider.json();
      assert.equal(oauthUnknownProviderBody?.code, 'invalid_state');
      assert.equal(oauthUnknownProviderBody?.reason, 'unsupported_provider');
      assert.notEqual(oauthUnknownProvider.status, 404);

      const callbackSuccess = await app.request(
        `/oauth/google/callback?state=${encodeURIComponent(oauthState)}&code=mock-code-first`,
      );
      assert.equal(callbackSuccess.status, 200);
      const callbackSuccessBody = await callbackSuccess.json();
      assert.equal(callbackSuccessBody.code, 'oauth_callback_accepted');
      assert.equal(callbackSuccessBody.provider, 'google');

      const callbackReplay = await app.request(
        `/oauth/google/callback?state=${encodeURIComponent(oauthState)}&code=mock-code-replay`,
      );
      assert.equal(callbackReplay.status, 409);
      const callbackReplayBody = await callbackReplay.json();
      assert.equal(callbackReplayBody?.code, 'replay_detected');
      assert.notEqual(callbackReplay.status, 404);

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
