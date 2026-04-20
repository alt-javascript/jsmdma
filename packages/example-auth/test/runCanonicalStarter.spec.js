import { assert } from 'chai';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID,
  BOOT_OAUTH_GOOGLE_REDIRECT_URI,
  BOOT_OAUTH_GITHUB_REDIRECT_URI,
  buildAuthOnlyStarterApp,
  createAuthOnlyConfigOverrides,
} from '../runtime/authStarterRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_PATH = resolve(__dirname, '../run.js');
const RUNTIME_PATH = resolve(__dirname, '../runtime/authStarterRuntime.js');

const RUN_JS_JWT_SECRET = 'example-auth-secret-must-be-32-chars!!';

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

describe('run.js canonical starter source/runtime contract (packages/example-auth)', () => {
  describe('source contracts', () => {
    it('run.js delegates startup to authStarterRuntime helper and avoids manual startup assembly', async () => {
      const source = await readFile(RUN_PATH, 'utf8');

      assert.match(source, /from\s*['"]\.\/runtime\/authStarterRuntime\.js['"]/);
      assert.match(source, /buildAuthOnlyStarterApp\s*\(/);

      assert.notMatch(source, /from\s*['"]@alt-javascript\/cdi['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/config['"]/);
      assert.notMatch(source, /from\s*['"]@alt-javascript\/jsmdma-hono['"]/);
      assert.notMatch(source, /new\s+Context\s*\(/);
      assert.notMatch(source, /new\s+ApplicationContext\s*\(/);
      assert.notMatch(source, /new\s+EphemeralConfig\s*\(/);
    });

    it('auth starter runtime owns package-base config loading, auth-only oauth defaults, and boot-first startup', async () => {
      const source = await readFile(RUNTIME_PATH, 'utf8');

      assert.include(source, 'ConfigFactory.loadConfig');
      assert.include(source, 'Boot.boot({');
      assert.include(source, 'AUTH_STARTER_PACKAGE_BASE_PATH');
      assert.include(source, 'basePath = AUTH_STARTER_PACKAGE_BASE_PATH');
      assert.include(source, 'run = false');
      assert.include(source, 'AUTH_ONLY_STARTER_OPTIONS');
      assert.include(source, 'sync: false');
      assert.include(source, 'appSyncController: false');
      assert.include(source, 'createAuthOnlyBootOauthProviderConfig');
      assert.include(source, 'AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID');
      assert.include(source, 'buildAuthOnlyStarterApp');
    });
  });

  describe('failure contracts', () => {
    it('fails fast on malformed auth-only oauth provider overlays', () => {
      assert.throws(
        () => createAuthOnlyConfigOverrides({
          jwtSecret: RUN_JS_JWT_SECRET,
          bootOauth: {
            providers: {
              google: {
                clientId: '',
                redirectUri: BOOT_OAUTH_GOOGLE_REDIRECT_URI,
              },
              github: {
                clientId: 'canonical-gh-client-id',
                redirectUri: BOOT_OAUTH_GITHUB_REDIRECT_URI,
              },
            },
          },
        }),
        /Malformed oauth provider config: providers\.google\.clientId must be a non-empty string/,
      );
    });
  });

  describe('runtime contracts', () => {
    it('auth-only helper keeps /oauth and /auth routes alive while sync/appSync stays disabled', async () => {
      const { app, appCtx } = await buildAuthOnlyStarterApp({
        jwtSecret: RUN_JS_JWT_SECRET,
        providers: {
          github: new MockProvider('canonical-gh-user', 'canonical-gh@example.com'),
          google: new MockProvider('canonical-google-user', 'canonical-google@example.com'),
        },
      });

      try {
        const oauthAuthorize = await app.request('/oauth/google/authorize?mode=cookie');
        assert.equal(oauthAuthorize.status, 302, 'Expected auth-only boot oauth authorize route to return redirect response');

        const oauthLocation = oauthAuthorize.headers.get('location');
        assert.isString(oauthLocation);
        assert.include(oauthLocation, 'state=');
        assert.include(oauthLocation, `client_id=${AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID}`);
        assert.include(oauthLocation, `redirect_uri=${encodeURIComponent(BOOT_OAUTH_GOOGLE_REDIRECT_URI)}`);

        const oauthState = extractStateFromLocation(oauthLocation);
        assert.isString(oauthState);
        assert.notEqual(oauthState.length, 0);

        const callbackMissingState = await app.request('/oauth/google/callback?code=missing-state-code');
        assert.equal(callbackMissingState.status, 400);
        const callbackMissingStateBody = await callbackMissingState.json();
        assert.equal(callbackMissingStateBody?.code, 'invalid_state');
        assert.equal(callbackMissingStateBody?.reason, 'non_empty_string_required');
        assert.notEqual(callbackMissingState.status, 404);

        const callbackMissingCode = await app.request('/oauth/google/callback?state=missing-code-state');
        assert.equal(callbackMissingCode.status, 400);
        const callbackMissingCodeBody = await callbackMissingCode.json();
        assert.equal(callbackMissingCodeBody?.code, 'invalid_state');
        assert.equal(callbackMissingCodeBody?.reason, 'non_empty_string_required');
        assert.notEqual(callbackMissingCode.status, 404);

        const unknownProvider = await app.request('/oauth/linkedin/authorize');
        assert.equal(unknownProvider.status, 400);
        const unknownProviderBody = await unknownProvider.json();
        assert.equal(unknownProviderBody?.code, 'invalid_state');
        assert.equal(unknownProviderBody?.reason, 'unsupported_provider');
        assert.notEqual(unknownProvider.status, 404);

        const beginAuth = await app.request('/auth/github');
        assert.equal(beginAuth.status, 200);
        const beginAuthBody = await beginAuth.json();
        assert.isString(beginAuthBody.state);
        assert.notEqual(beginAuthBody.state.length, 0);
        assert.include(beginAuthBody.authorizationURL, 'state=');

        const meUnauth = await app.request('/auth/me');
        assert.equal(meUnauth.status, 401);
        const meUnauthBody = await meUnauth.json();
        assert.equal(meUnauthBody?.code, 'invalid_state');
        assert.equal(meUnauthBody?.reason, 'session_required');

        // Runtime auth+oauth contracts remain active with typed envelopes.
        // Sync/appSync disablement is guarded in source contracts via AUTH_ONLY_STARTER_OPTIONS.
      } finally {
        await appCtx.stop?.();
      }
    });
  });
});
