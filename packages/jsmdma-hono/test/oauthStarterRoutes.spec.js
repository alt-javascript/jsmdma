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

const JWT_SECRET = 'oauth-starter-route-spec-secret-123456';
const OAUTH_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/google/callback';
const OAUTH_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/github/callback';

function createConfig({ providers } = {}) {
  return {
    boot: {
      'banner-mode': 'off',
      nosql: { url: 'jsnosqlc:memory:' },
      oauth: {
        providers: providers ?? {
          google: {
            clientId: 'starter-google-client-id',
            redirectUri: OAUTH_GOOGLE_REDIRECT_URI,
          },
          github: {
            clientId: 'starter-github-client-id',
            redirectUri: OAUTH_GITHUB_REDIRECT_URI,
          },
        },
      },
    },
    logging: { level: { ROOT: 'error' } },
    server: { port: 0 },
    auth: { jwt: { secret: JWT_SECRET } },
    applications: {
      todo: {
        description: 'Todo app',
      },
    },
    orgs: { registerable: false },
  };
}

function extractStateFromLocation(location) {
  const parsed = new URL(location, 'https://oauth.local');
  return parsed.searchParams.get('state');
}

async function buildContext(configData = createConfig()) {
  const config = new EphemeralConfig(configData);
  const context = new Context([
    ...jsmdmaHonoStarter(),
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
}

describe('oauth route contracts via jsmdmaHonoStarter()', () => {
  it('keeps GET /oauth/:provider/authorize mounted and propagates redirect headers', async () => {
    const appCtx = await buildContext();
    try {
      const app = appCtx.get('honoAdapter').app;
      const response = await app.request('/oauth/google/authorize?mode=cookie');

      assert.equal(response.status, 302, 'Expected oauth authorize route to return redirect');

      const location = response.headers.get('location');
      assert.isString(location);
      assert.include(location, 'state=');
      assert.include(location, 'client_id=starter-google-client-id');
      assert.include(location, `redirect_uri=${encodeURIComponent(OAUTH_GOOGLE_REDIRECT_URI)}`);

      const setCookie = response.headers.get('set-cookie');
      assert.isString(setCookie, 'Expected oauth authorize route to preserve Set-Cookie headers');
      assert.include(setCookie.toLowerCase(), 'oauth_provider=google');
    } finally {
      await appCtx.stop?.();
    }
  });

  it('surfaces deterministic invalid_state envelopes for malformed callback input and unknown providers', async () => {
    const appCtx = await buildContext();
    try {
      const app = appCtx.get('honoAdapter').app;

      const missingState = await app.request('/oauth/google/callback?code=missing-state-code');
      assert.equal(missingState.status, 400);
      assert.notEqual(missingState.status, 404);
      const missingStateBody = await missingState.json();
      assert.equal(missingStateBody?.code, 'invalid_state');
      assert.equal(missingStateBody?.reason, 'non_empty_string_required');

      const missingCode = await app.request('/oauth/google/callback?state=missing-code-state');
      assert.equal(missingCode.status, 400);
      assert.notEqual(missingCode.status, 404);
      const missingCodeBody = await missingCode.json();
      assert.equal(missingCodeBody?.code, 'invalid_state');
      assert.equal(missingCodeBody?.reason, 'non_empty_string_required');

      const unknownProvider = await app.request('/oauth/linkedin/authorize');
      assert.equal(unknownProvider.status, 400);
      assert.notEqual(unknownProvider.status, 404);
      const unknownProviderBody = await unknownProvider.json();
      assert.equal(unknownProviderBody?.code, 'invalid_state');
      assert.equal(unknownProviderBody?.reason, 'unsupported_provider');

      const unknownState = await app.request('/oauth/google/callback?state=never-issued-state&code=unknown-state-code');
      assert.equal(unknownState.status, 400);
      const unknownStateBody = await unknownState.json();
      assert.equal(unknownStateBody?.code, 'invalid_state');
      assert.equal(unknownStateBody?.reason, 'unknown_state');
    } finally {
      await appCtx.stop?.();
    }
  });

  it('reports replay_detected for repeated callback consumption of the same oauth state', async () => {
    const appCtx = await buildContext();
    try {
      const app = appCtx.get('honoAdapter').app;

      const authorize = await app.request('/oauth/google/authorize?mode=cookie');
      assert.equal(authorize.status, 302);
      const location = authorize.headers.get('location');
      assert.isString(location);

      const state = extractStateFromLocation(location);
      assert.isString(state);
      assert.notEqual(state.length, 0);

      const callbackAccepted = await app.request(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=oauth-code-first`);
      assert.equal(callbackAccepted.status, 200);
      const callbackAcceptedBody = await callbackAccepted.json();
      assert.equal(callbackAcceptedBody.code, 'oauth_callback_accepted');
      assert.equal(callbackAcceptedBody.provider, 'google');

      const callbackReplay = await app.request(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=oauth-code-replay`);
      assert.equal(callbackReplay.status, 409);
      assert.notEqual(callbackReplay.status, 404);
      const callbackReplayBody = await callbackReplay.json();
      assert.equal(callbackReplayBody?.code, 'replay_detected');
      assert.equal(callbackReplayBody?.reason, 'replay_detected');
    } finally {
      await appCtx.stop?.();
    }
  });

  it('keeps authorize route mounted with malformed provider defaults (typed invalid_state, never 404)', async () => {
    const appCtx = await buildContext(createConfig({
      providers: {
        google: {},
        github: {},
      },
    }));

    try {
      const app = appCtx.get('honoAdapter').app;
      const response = await app.request('/oauth/google/authorize');

      assert.equal(response.status, 400);
      assert.notEqual(response.status, 404);

      const body = await response.json();
      assert.equal(body?.code, 'invalid_state');
      assert.equal(body?.reason, 'non_empty_string_required');
    } finally {
      await appCtx.stop?.();
    }
  });
});
