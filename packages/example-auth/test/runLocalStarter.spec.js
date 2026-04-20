import { assert } from 'chai';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOT_OAUTH_GOOGLE_REDIRECT_URI,
  buildRunLocalStarterContext,
  createRunLocalConfigOverrides,
} from '../runtime/authStarterRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_LOCAL_PATH = resolve(__dirname, '../run-local.js');
const RUNTIME_PATH = resolve(__dirname, '../runtime/authStarterRuntime.js');

const JWT_SECRET = 'run-local-starter-spec-secret-123456';

class MockProvider {
  constructor(providerUserId, email) {
    this.providerUserId = providerUserId;
    this.email = email;
  }

  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${encodeURIComponent(state)}`);
  }

  async validateCallback() {
    return {
      providerUserId: this.providerUserId,
      email: this.email,
    };
  }
}

function extractStateFromLocation(location) {
  const parsed = new URL(location, 'https://oauth.local');
  return parsed.searchParams.get('state');
}

async function buildRunLocalContext() {
  return buildRunLocalStarterContext({
    jwtSecret: JWT_SECRET,
    googleClientId: 'example-auth-google-client-id',
    githubClientId: 'example-auth-github-client-id',
    providers: {
      google: new MockProvider('run-local-google-user', 'run-local-google@example.com'),
      github: new MockProvider('run-local-github-user', 'run-local-github@example.com'),
    },
    server: { host: '127.0.0.1', port: 0 },
  });
}

describe('run-local starter entrypoint regressions (packages/example-auth)', () => {
  describe('source contracts', () => {
    it('run-local.js is helper-owned and avoids manual logger/config/context startup seams', async () => {
      const source = await readFile(RUN_LOCAL_PATH, 'utf8');

      assert.match(source, /from\s*['"]\.\/runtime\/authStarterRuntime\.js['"]/);
      assert.match(source, /ensureRunLocalEnv\s*\(/);
      assert.match(source, /createRunLocalAuthProviders\s*\(/);
      assert.match(source, /buildRunLocalStarterApp\s*\(/);

      assert.notMatch(source, /from\s*['"]@alt-javascript\/logger['"]/);
      assert.notMatch(source, /LoggerFactory/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/cdi['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/config['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-hono['"]/);
      assert.notMatch(source, /new\s+Context\s*\(/);
      assert.notMatch(source, /new\s+ApplicationContext\s*\(/);
      assert.notMatch(source, /new\s+EphemeralConfig\s*\(/);

      assert.include(source, "console.log('    GET  /oauth/google/authorize    → boot oauth authorize start (302 + Location/Set-Cookie)');");
      assert.include(source, "console.log('    GET  /oauth/google/callback     → boot oauth callback consume (typed json envelope)');");
      assert.include(source, "console.log('    GET  /oauth/github/authorize    → boot oauth github authorize start');");
      assert.include(source, "console.log('    GET  /oauth/github/callback     → boot oauth github callback consume');");
    });

    it('runtime helper owns boot/config loading and malformed oauth provider guards', async () => {
      const source = await readFile(RUNTIME_PATH, 'utf8');

      assert.include(source, 'ConfigFactory.loadConfig');
      assert.include(source, 'Boot.boot({');
      assert.include(source, 'AUTH_STARTER_PACKAGE_BASE_PATH');
      assert.include(source, 'RUN_LOCAL_STARTER_OPTIONS');
      assert.include(source, 'CorsMiddlewareRegistrar');
      assert.include(source, 'createAuthOnlyBootOauthProviderConfig');
      assert.include(source, 'createAuthOnlyConfigOverrides');
      assert.include(source, 'assertBootOauthProviderConfig');
      assert.include(source, 'Malformed oauth provider config');
      assert.include(source, 'buildRunLocalStarterContext');
    });
  });

  describe('failure contracts', () => {
    it('fails fast on malformed oauth provider overlays before route wiring', () => {
      assert.throws(
        () => createRunLocalConfigOverrides({
          jwtSecret: JWT_SECRET,
          googleClientId: '',
          githubClientId: 'example-auth-github-client-id',
        }),
        /Malformed oauth provider config: providers\.google\.clientId must be a non-empty string/,
      );
    });
  });

  describe('runtime contracts', () => {
    it('starter boot keeps health/CORS/sync contracts and oauth typed envelopes', async () => {
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
        assert.include(oauthLocation, `redirect_uri=${encodeURIComponent(BOOT_OAUTH_GOOGLE_REDIRECT_URI)}`);

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

        const lifecycleRoute = await app.request('/auth/login/finalize');
        assert.equal(lifecycleRoute.status, 400);
        const lifecycleRouteBody = await lifecycleRoute.json();
        assert.equal(lifecycleRouteBody?.code, 'bad_request');
        assert.include(lifecycleRouteBody?.error ?? '', 'Missing required field');

        const unauthMe = await app.request('/auth/me');
        assert.equal(unauthMe.status, 401);
        const unauthMeBody = await unauthMe.json();
        assert.equal(unauthMeBody?.code, 'invalid_state');
        assert.equal(unauthMeBody?.reason, 'session_required');

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
});
