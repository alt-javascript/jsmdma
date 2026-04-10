/**
 * AuthProvider.spec.js — TDD tests for AuthProvider
 *
 * Mocks global.fetch and window.location for redirect testing.
 */
import { assert } from 'chai';
import AuthProvider from '../AuthProvider.js';

let _session = {};
const mockSessionStorage = {
  getItem:    (k) => _session[k] ?? null,
  setItem:    (k, v) => { _session[k] = String(v); },
  removeItem: (k) => { delete _session[k]; },
  clear:      () => { _session = {}; },
};

const CONFIG = {
  google: { clientId: 'test-google-client-id' },
  apiUrl: 'http://127.0.0.1:8081/',
};

function makeProvider(cfg = CONFIG) {
  return new AuthProvider(cfg);
}

describe('AuthProvider', () => {
  beforeEach(() => { global.sessionStorage = mockSessionStorage; });
  afterEach(() => {
    mockSessionStorage.clear();
    delete global.fetch;
    delete global.window;
  });

  it('getAvailableProviders() returns configured providers', () => {
    const p = makeProvider({ google: { clientId: 'id' }, microsoft: { clientId: 'msid' }, apiUrl: 'http://x/' });
    const providers = p.getAvailableProviders();
    assert.include(providers, 'google');
    assert.include(providers, 'microsoft');
  });

  it('getAvailableProviders() excludes non-provider config keys (apiUrl)', () => {
    const p = makeProvider();
    const providers = p.getAvailableProviders();
    assert.notInclude(providers, 'apiUrl');
  });

  it('isConfigured() returns true when at least one provider is set', () => {
    const p = makeProvider();
    assert.isTrue(p.isConfigured());
  });

  it('isConfigured() returns false when no providers configured', () => {
    const p = makeProvider({ apiUrl: 'http://x/' });
    assert.isFalse(p.isConfigured());
  });

  it('signIn() fetches /auth/:provider and stores PKCE params in sessionStorage', async () => {
    let fetchedUrl = null;
    global.fetch = async (url) => {
      fetchedUrl = url;
      return {
        ok: true, status: 200,
        json: async () => ({
          authorizationURL: 'https://accounts.google.com/o/oauth2/auth?state=s1',
          state: 's1',
          codeVerifier: 'cv-abc123',
        }),
      };
    };

    // Mock window.location to capture the redirect without actually navigating
    let redirectedTo = null;
    global.window = { location: {} };
    Object.defineProperty(global.window.location, 'href', {
      set: (v) => { redirectedTo = v; },
      configurable: true,
    });

    const p = makeProvider();
    // signIn returns a never-resolving promise — race with a timeout
    await Promise.race([
      p.signIn('google').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 50)),
    ]);

    assert.include(fetchedUrl, '/auth/google');
    assert.equal(mockSessionStorage.getItem('oauth_state'), 's1');
    assert.equal(mockSessionStorage.getItem('oauth_code_verifier'), 'cv-abc123');
    assert.include(redirectedTo, 'accounts.google.com');
  });

  it('signIn() throws if provider is not configured', async () => {
    const p = makeProvider();
    try {
      await p.signIn('apple');
      assert.fail('expected error');
    } catch (err) {
      assert.include(err.message, 'apple');
    }
  });

  it('signIn() throws if server returns error', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const p = makeProvider();
    try {
      await p.signIn('google');
      assert.fail('expected error');
    } catch (err) {
      assert.ok(err.message);
    }
  });

  it('signOut() clears auth_token, auth_provider, auth_time', () => {
    let _ls = {};
    global.localStorage = {
      getItem:    k => _ls[k] ?? null,
      setItem:    (k, v) => { _ls[k] = v; },
      removeItem: k => { delete _ls[k]; },
    };
    _ls['auth_token']    = 'some-token';
    _ls['auth_provider'] = 'google';
    _ls['auth_time']     = '123';

    const p = makeProvider();
    p.signOut();

    assert.isUndefined(_ls['auth_token']);
    assert.isUndefined(_ls['auth_provider']);
    assert.isUndefined(_ls['auth_time']);
  });
});
