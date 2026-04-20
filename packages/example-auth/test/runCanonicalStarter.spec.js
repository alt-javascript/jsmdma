import { assert } from 'chai';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuthOnlyStarterApp } from '../runtime/authStarterRuntime.js';

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

    it('auth starter runtime owns package-base config loading and boot-first startup', async () => {
      const source = await readFile(RUNTIME_PATH, 'utf8');

      assert.include(source, 'ConfigFactory.loadConfig');
      assert.include(source, 'Boot.boot({');
      assert.include(source, 'AUTH_STARTER_PACKAGE_BASE_PATH');
      assert.include(source, 'basePath = AUTH_STARTER_PACKAGE_BASE_PATH');
      assert.include(source, 'run = false');
      assert.include(source, 'AUTH_ONLY_STARTER_OPTIONS');
      assert.include(source, 'sync: false');
      assert.include(source, 'appSyncController: false');
      assert.include(source, 'buildAuthOnlyStarterApp');
    });
  });

  describe('runtime contracts', () => {
    it('auth-only helper keeps /auth routes alive while sync/appSync stays disabled', async () => {
      const { app, appCtx } = await buildAuthOnlyStarterApp({
        jwtSecret: RUN_JS_JWT_SECRET,
        providers: {
          github: new MockProvider('canonical-gh-user', 'canonical-gh@example.com'),
        },
      });

      try {
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

        // Runtime auth contract remains active with typed unauthenticated envelope.
        // Sync/appSync disablement is guarded in source contracts via AUTH_ONLY_STARTER_OPTIONS.
      } finally {
        await appCtx.stop?.();
      }
    });
  });
});
