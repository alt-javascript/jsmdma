/**
 * AuthService.spec.js — Integration tests for AuthService + UserRepository
 *
 * Uses jsnosqlc-memory driver. No real OAuth providers — MockProvider simulates
 * validateCallback() returning controlled { providerUserId, email } values.
 */
import { assert } from 'chai';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import '@alt-javascript/jsnosqlc-memory';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { InvalidStateError } from '@alt-javascript/jsmdma-auth-core';
import UserRepository from '../UserRepository.js';
import AuthService    from '../AuthService.js';

const JWT_SECRET = 'auth-test-secret-must-be-32-chars!!';

// ── test doubles ──────────────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId, email = 'user@example.com') {
    this._providerUserId = providerUserId;
    this._email          = email;
  }

  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }

  async validateCallback() {
    return { providerUserId: this._providerUserId, email: this._email };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeService() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const repo   = new UserRepository(client);
  const svc    = new AuthService();
  svc.userRepository = repo;
  svc.jwtSecret      = JWT_SECRET;
  return { svc, repo };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {

  // ── beginAuth() ─────────────────────────────────────────────────────────────

  describe('beginAuth()', () => {
    it('returns authorizationURL and state only (PKCE verifier stays server-side)', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('uid-1');
      const result   = svc.beginAuth('mock', provider);

      assert.property(result, 'authorizationURL');
      assert.property(result, 'state');
      assert.notProperty(result, 'codeVerifier');
      assert.isString(result.authorizationURL);
      assert.isString(result.state);
    });

    it('authorizationURL contains the state parameter', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('uid-1');
      const { authorizationURL, state } = svc.beginAuth('mock', provider);
      const url = new URL(authorizationURL);
      assert.equal(url.searchParams.get('state'), state);
    });
  });

  // ── completeAuth() — new user ────────────────────────────────────────────────

  describe('completeAuth() — new user', () => {
    it('creates a new user with a UUID', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('github-uid-1', 'alice@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { user } = await svc.completeAuth('github', provider, 'mock-code', state);

      assert.isString(user.userId);
      assert.match(user.userId, /^[0-9a-f-]{36}$/, 'userId should be a UUID');
    });

    it('new user has the provider in providers list', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('github-uid-2', 'bob@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { user } = await svc.completeAuth('github', provider, 'code', state);

      assert.isArray(user.providers);
      assert.lengthOf(user.providers, 1);
      assert.equal(user.providers[0].provider, 'github');
      assert.equal(user.providers[0].providerUserId, 'github-uid-2');
    });

    it('new user has the email from provider', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('github-uid-3', 'carol@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { user } = await svc.completeAuth('github', provider, 'code', state);
      assert.equal(user.email, 'carol@github.com');
    });

    it('returns a signed JWT token', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-4', 'dave@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { user, token } = await svc.completeAuth('github', provider, 'code', state);

      assert.isString(token);
      const payload = await JwtSession.verify(token, JWT_SECRET);
      assert.equal(payload.sub, user.userId);
    });

    it('JWT token contains providers array', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-5', 'eve@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { token } = await svc.completeAuth('github', provider, 'code', state);
      const payload = await JwtSession.verify(token, JWT_SECRET);
      assert.deepEqual(payload.providers, ['github']);
    });
  });

  // ── completeAuth() — returning user ─────────────────────────────────────────

  describe('completeAuth() — returning user', () => {
    it('same UUID on second login via same provider', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-returning', 'return@github.com');

      const { state: s1 } = svc.beginAuth('github', provider);
      const { user: user1 } = await svc.completeAuth('github', provider, 'code', s1);

      const { state: s2 } = svc.beginAuth('github', provider);
      const { user: user2 } = await svc.completeAuth('github', provider, 'code', s2);

      assert.equal(user1.userId, user2.userId, 'UUID should be stable across logins');
    });

    it('JWT sub is same UUID on second login', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-stable', 'stable@github.com');

      const { state: s1 } = svc.beginAuth('github', provider);
      const { token: tok1 } = await svc.completeAuth('github', provider, 'code', s1);

      const { state: s2 } = svc.beginAuth('github', provider);
      const { token: tok2 } = await svc.completeAuth('github', provider, 'code', s2);

      const p1 = await JwtSession.verify(tok1, JWT_SECRET);
      const p2 = await JwtSession.verify(tok2, JWT_SECRET);
      assert.equal(p1.sub, p2.sub);
    });
  });

  // ── completeAuth() — state validation ───────────────────────────────────────

  describe('completeAuth() — CSRF protection', () => {
    it('throws InvalidStateError when state is unknown or expired', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-csrf');
      const { state } = svc.beginAuth('github', provider);

      try {
        await svc.completeAuth('github', provider, 'code', `${state}-tampered`);
        assert.fail('should have thrown InvalidStateError');
      } catch (err) {
        assert.instanceOf(err, InvalidStateError);
      }
    });
  });

  // ── completeAuth() — Apple email preservation ────────────────────────────────

  describe('completeAuth() — Apple email preservation', () => {
    it('preserves email from first login when Apple sends null on second login', async () => {
      const { svc } = await makeService();

      // First login: Apple sends email
      const firstLogin  = new MockProvider('apple-sub-1', 'user@icloud.com');
      const { state: s1 } = svc.beginAuth('apple', firstLogin);
      const { user: u1 } = await svc.completeAuth('apple', firstLogin, 'code', s1);
      assert.equal(u1.email, 'user@icloud.com');

      // Second login: Apple sends null email (normal for Apple)
      const secondLogin = new MockProvider('apple-sub-1', null); // same providerUserId, no email
      const { state: s2 } = svc.beginAuth('apple', secondLogin);
      const { user: u2 } = await svc.completeAuth('apple', secondLogin, 'code', s2);

      assert.equal(u2.userId, u1.userId, 'UUID should be stable');
      assert.equal(u2.email, 'user@icloud.com', 'email should be preserved from first login');
    });
  });

});
