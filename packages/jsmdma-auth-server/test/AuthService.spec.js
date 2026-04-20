/**
 * AuthService.spec.js — Integration tests for AuthService + UserRepository.
 *
 * Uses jsnosqlc-memory for profile persistence and an in-memory identity-link
 * store test double that mirrors oauthIdentityLinkStore semantics.
 */
import { assert } from 'chai';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import '@alt-javascript/jsnosqlc-memory';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { InvalidStateError } from '@alt-javascript/jsmdma-auth-core';
import UserRepository from '../UserRepository.js';
import AuthService from '../AuthService.js';

const JWT_SECRET = 'auth-test-secret-must-be-32-chars!!';
const SUPPORTED_PROVIDERS = new Set(['google', 'github', 'apple', 'microsoft', 'meta', 'generic']);

function createStoreError(code, reason, message) {
  const err = new Error(message ?? `${code}:${reason}`);
  err.name = 'OAuthError';
  err.code = code;
  err.reason = reason;
  err.diagnostics = { reason };
  if (code === 'identity_link_conflict') err.status = 409;
  if (code === 'invalid_state') err.status = 500;
  return err;
}

function assertNonEmptyString(value, field, operation) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createStoreError(
      'invalid_state',
      'non_empty_string_required',
      `${operation} requires non-empty ${field}`,
    );
  }
  return value.trim();
}

function assertSupportedProvider(value, operation) {
  const provider = assertNonEmptyString(value, 'provider', operation);
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw createStoreError('invalid_state', 'unsupported_provider', `${operation} unsupported provider`);
  }
  return provider;
}

class InMemoryIdentityLinkStore {
  constructor() {
    this.anchorOwners = new Map(); // `${provider}::${providerUserId}` -> userId
    this.userLinks = new Map(); // userId -> Map<provider, providerUserId>
    this.calls = {
      getUserByProviderAnchor: 0,
      link: 0,
      getLinksForUser: 0,
    };
    this.hooks = {
      getUserByProviderAnchor: null,
      link: null,
      getLinksForUser: null,
    };
  }

  setHook(operation, hook) {
    this.hooks[operation] = hook;
  }

  _anchorKey(provider, providerUserId) {
    return `${provider}::${providerUserId}`;
  }

  seedLink(userId, provider, providerUserId) {
    const anchor = this._anchorKey(provider, providerUserId);
    this.anchorOwners.set(anchor, userId);

    const links = this.userLinks.get(userId) ?? new Map();
    links.set(provider, providerUserId);
    this.userLinks.set(userId, links);
  }

  async getUserByProviderAnchor(input) {
    this.calls.getUserByProviderAnchor += 1;

    if (this.hooks.getUserByProviderAnchor) {
      return this.hooks.getUserByProviderAnchor(input, this);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createStoreError('invalid_state', 'invalid_operation_shape', 'lookup input must be object');
    }

    const provider = assertSupportedProvider(input.provider, 'getUserByProviderAnchor');
    const providerUserId = assertNonEmptyString(input.providerUserId, 'providerUserId', 'getUserByProviderAnchor');

    return this.anchorOwners.get(this._anchorKey(provider, providerUserId)) ?? null;
  }

  async link(input) {
    this.calls.link += 1;

    if (this.hooks.link) {
      return this.hooks.link(input, this);
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw createStoreError('invalid_state', 'invalid_operation_shape', 'link input must be object');
    }

    const userId = assertNonEmptyString(input.userId, 'userId', 'link');
    const provider = assertSupportedProvider(input.provider, 'link');
    const providerUserId = assertNonEmptyString(input.providerUserId, 'providerUserId', 'link');
    const anchor = this._anchorKey(provider, providerUserId);

    const owner = this.anchorOwners.get(anchor);
    if (owner && owner !== userId) {
      throw createStoreError('identity_link_conflict', 'anchor_already_linked', 'anchor already linked');
    }

    const links = this.userLinks.get(userId) ?? new Map();
    const existingForProvider = links.get(provider);
    if (existingForProvider && existingForProvider !== providerUserId) {
      throw createStoreError('identity_link_conflict', 'duplicate_provider_swap_attempt', 'provider already linked to another id');
    }

    links.set(provider, providerUserId);
    this.userLinks.set(userId, links);
    this.anchorOwners.set(anchor, userId);

    return {
      outcome: owner ? 'noop' : 'linked',
      link: { userId, provider, providerUserId, anchor },
      totalLinksForUser: links.size,
    };
  }

  async getLinksForUser(userId) {
    this.calls.getLinksForUser += 1;

    if (this.hooks.getLinksForUser) {
      return this.hooks.getLinksForUser(userId, this);
    }

    const normalizedUserId = assertNonEmptyString(userId, 'userId', 'getLinksForUser');
    const links = this.userLinks.get(normalizedUserId);
    if (!links) return [];

    return [...links.entries()]
      .map(([provider, providerUserId]) => ({
        userId: normalizedUserId,
        provider,
        providerUserId,
        anchor: this._anchorKey(provider, providerUserId),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

class MockProvider {
  constructor(providerUserId, email = 'user@example.com') {
    this._providerUserId = providerUserId;
    this._email = email;
  }

  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }

  async validateCallback() {
    return { providerUserId: this._providerUserId, email: this._email };
  }
}

async function captureAsyncError(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function makeService(options = {}) {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const repo = new UserRepository(client);
  const store = options.store ?? new InMemoryIdentityLinkStore();

  const svc = new AuthService();
  svc.userRepository = repo;
  svc.oauthIdentityLinkStore = store;
  svc.jwtSecret = JWT_SECRET;
  if (options.uuidGenerator) {
    svc.uuidGenerator = options.uuidGenerator;
  }

  return { svc, repo, store };
}

describe('AuthService', () => {

  describe('beginAuth()', () => {
    it('returns authorizationURL and state only (PKCE verifier stays server-side)', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('uid-1');
      const result = svc.beginAuth('mock', provider);

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

  describe('completeAuth() store-authority callback flow', () => {
    it('creates a new user and links ownership through oauthIdentityLinkStore', async () => {
      const { svc, store } = await makeService({
        uuidGenerator: () => '00000000-0000-4000-8000-000000000001',
      });
      const provider = new MockProvider('github-uid-1', 'alice@github.com');
      const { state } = svc.beginAuth('github', provider);

      const { user } = await svc.completeAuth('github', provider, 'mock-code', state);

      assert.equal(user.userId, '00000000-0000-4000-8000-000000000001');
      assert.deepEqual(user.providers, [{ provider: 'github', providerUserId: 'github-uid-1' }]);

      assert.equal(store.calls.getUserByProviderAnchor, 1, 'anchor lookup should be performed');
      assert.equal(store.calls.link, 1, 'ownership link should be created for first login');
      assert.equal(store.calls.getLinksForUser, 1, 'projection should be loaded from store');
    });

    it('reuses stable UUID across repeated callbacks for the same provider anchor', async () => {
      const { svc } = await makeService({
        uuidGenerator: () => '00000000-0000-4000-8000-000000000002',
      });
      const provider = new MockProvider('gh-uid-returning', 'return@github.com');

      const { state: firstState } = svc.beginAuth('github', provider);
      const first = await svc.completeAuth('github', provider, 'code', firstState);

      const { state: secondState } = svc.beginAuth('github', provider);
      const second = await svc.completeAuth('github', provider, 'code', secondState);

      assert.equal(first.user.userId, second.user.userId, 'UUID should be stable across logins');
      assert.deepEqual(second.user.providers, [{ provider: 'github', providerUserId: 'gh-uid-returning' }]);
    });

    it('builds JWT provider claims from store-backed projection reads', async () => {
      const { svc, repo, store } = await makeService();

      await repo.create('existing-user-1', 'x@example.com', [
        { provider: 'google', providerUserId: 'stale-google-id' },
      ]);
      store.seedLink('existing-user-1', 'github', 'gh-live-id');

      const provider = new MockProvider('gh-live-id', 'x@example.com');
      const { state } = svc.beginAuth('github', provider);
      const { user, token } = await svc.completeAuth('github', provider, 'code', state);

      assert.equal(user.userId, 'existing-user-1');
      assert.deepEqual(user.providers, [{ provider: 'github', providerUserId: 'gh-live-id' }]);

      const payload = await JwtSession.verify(token, JWT_SECRET);
      assert.deepEqual(payload.providers, ['github']);
    });

    it('resolves deterministic first-login races by re-reading anchor ownership and deleting orphan profile', async () => {
      const { svc, repo, store } = await makeService({
        uuidGenerator: () => 'orphan-user-id',
      });

      await repo.create('winner-user-id', null);

      store.setHook('link', async (input, identityStore) => {
        identityStore.seedLink('winner-user-id', input.provider, input.providerUserId);
        throw createStoreError('identity_link_conflict', 'anchor_already_linked', 'simulated race conflict');
      });

      const provider = new MockProvider('race-anchor-user-id', 'winner@example.com');
      const { state } = svc.beginAuth('github', provider);
      const { user } = await svc.completeAuth('github', provider, 'code', state);

      assert.equal(user.userId, 'winner-user-id');
      assert.equal(user.email, 'winner@example.com', 'winner profile should be hydrated with callback email');
      assert.isNull(await repo.getUser('orphan-user-id'), 'orphan profile must be cleaned up after race conflict');
    });

    it('does not call legacy repository authority methods during callback completion', async () => {
      const { svc, repo } = await makeService();
      repo.findByProvider = async () => {
        throw new Error('legacy findByProvider must not be called');
      };
      repo.addProvider = async () => {
        throw new Error('legacy addProvider must not be called');
      };
      repo.removeProvider = async () => {
        throw new Error('legacy removeProvider must not be called');
      };

      const provider = new MockProvider('gh-no-legacy', 'nolegacy@github.com');
      const { state } = svc.beginAuth('github', provider);
      const { user } = await svc.completeAuth('github', provider, 'code', state);

      assert.equal(user.userId.length, 36);
    });
  });

  describe('completeAuth() typed failure paths', () => {
    it('throws InvalidStateError for unknown/tampered state', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('gh-uid-csrf');
      const { state } = svc.beginAuth('github', provider);

      const err = await captureAsyncError(() => (
        svc.completeAuth('github', provider, 'code', `${state}-tampered`)
      ));

      assert.instanceOf(err, InvalidStateError);
    });

    it('fails closed when callback payload is malformed', async () => {
      const { svc } = await makeService();
      const malformedProvider = {
        createAuthorizationURL: (state) => new URL(`https://mock.provider/auth?state=${state}`),
        validateCallback: async () => ({ email: 'missing-provider-user-id@example.com' }),
      };
      const { state } = svc.beginAuth('github', malformedProvider);

      const err = await captureAsyncError(() => (
        svc.completeAuth('github', malformedProvider, 'code', state)
      ));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'malformed_provider_callback');
    });

    it('propagates typed unsupported-provider failures from identity-link store', async () => {
      const { svc } = await makeService();
      const provider = new MockProvider('provider-user-1', 'unsupported@example.com');
      const { state } = svc.beginAuth('legacy-provider', provider);

      const err = await captureAsyncError(() => (
        svc.completeAuth('legacy-provider', provider, 'code', state)
      ));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'unsupported_provider');
    });

    it('maps malformed store lookup output to typed invalid_state failure', async () => {
      const store = new InMemoryIdentityLinkStore();
      store.setHook('getUserByProviderAnchor', async () => ({ malformed: true }));
      const { svc } = await makeService({ store });
      const provider = new MockProvider('gh-malformed-lookup', 'lookup@example.com');
      const { state } = svc.beginAuth('github', provider);

      const err = await captureAsyncError(() => (
        svc.completeAuth('github', provider, 'code', state)
      ));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'malformed_dependency_response');
    });

    it('maps store timeouts to deterministic typed dependency_timeout failures', async () => {
      const store = new InMemoryIdentityLinkStore();
      store.setHook('getLinksForUser', async () => {
        throw new Error('timeout while loading user links');
      });
      const { svc } = await makeService({ store });
      const provider = new MockProvider('gh-timeout-1', 'timeout@example.com');
      const { state } = svc.beginAuth('github', provider);

      const err = await captureAsyncError(() => (
        svc.completeAuth('github', provider, 'code', state)
      ));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'dependency_timeout');
    });

    it('preserves first-login email when provider later omits it (Apple behavior)', async () => {
      const { svc } = await makeService();

      const firstLogin = new MockProvider('apple-sub-1', 'user@icloud.com');
      const { state: firstState } = svc.beginAuth('apple', firstLogin);
      const first = await svc.completeAuth('apple', firstLogin, 'code', firstState);
      assert.equal(first.user.email, 'user@icloud.com');

      const secondLogin = new MockProvider('apple-sub-1', null);
      const { state: secondState } = svc.beginAuth('apple', secondLogin);
      const second = await svc.completeAuth('apple', secondLogin, 'code', secondState);

      assert.equal(second.user.userId, first.user.userId);
      assert.equal(second.user.email, 'user@icloud.com');
    });
  });
});
