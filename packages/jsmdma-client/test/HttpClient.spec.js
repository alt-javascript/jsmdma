/**
 * HttpClient.spec.js — TDD tests for HttpClient
 *
 * Mocks global.fetch for all tests.
 */
import { assert } from 'chai';
import HttpClient from '../HttpClient.js';

// ── helpers ────────────────────────────────────────────────────────────────────
function makeClient(overrides = {}) {
  return new HttpClient({
    getToken: () => 'test-token-abc',
    onTokenRefresh: () => {},
    ...overrides,
  });
}

function mockFetch(status, body, headers = {}) {
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('HttpClient', () => {
  afterEach(() => { delete global.fetch; });

  it('fetchJSON injects Authorization Bearer header', async () => {
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.fetchJSON('http://example.com/api');
    assert.equal(capturedHeaders['Authorization'], 'Bearer test-token-abc');
  });

  it('fetchJSON does not inject Authorization when getToken returns null', async () => {
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true, status: 200,
        json: async () => ({}),
        headers: { get: () => null },
      };
    };

    const client = makeClient({ getToken: () => null });
    await client.fetchJSON('http://example.com/api');
    assert.isUndefined(capturedHeaders['Authorization']);
  });

  it('fetchJSON returns parsed JSON body on 2xx', async () => {
    mockFetch(200, { result: 'hello' });
    const client = makeClient();
    const data = await client.fetchJSON('http://example.com/api');
    assert.deepEqual(data, { result: 'hello' });
  });

  it('fetchJSON throws with err.status on non-2xx', async () => {
    mockFetch(401, { error: 'unauthorized' });
    const client = makeClient();
    try {
      await client.fetchJSON('http://example.com/api');
      assert.fail('expected error');
    } catch (err) {
      assert.equal(err.status, 401);
    }
  });

  it('fetchJSON calls onTokenRefresh when X-Auth-Token header is present', async () => {
    let refreshedToken = null;
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true }),
      headers: { get: (name) => name.toLowerCase() === 'x-auth-token' ? 'new-token-xyz' : null },
    });

    const client = makeClient({ onTokenRefresh: (t) => { refreshedToken = t; } });
    await client.fetchJSON('http://example.com/api');
    assert.equal(refreshedToken, 'new-token-xyz');
  });

  it('post() sends method POST with JSON body', async () => {
    let capturedMethod = null;
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      capturedBody = opts.body;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true }),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.post('http://example.com/api', { key: 'val' });
    assert.equal(capturedMethod, 'POST');
    assert.deepEqual(JSON.parse(capturedBody), { key: 'val' });
  });

  it('delete() sends method DELETE', async () => {
    let capturedMethod = null;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      return {
        ok: true, status: 200,
        json: async () => ({}),
        headers: { get: () => null },
      };
    };

    const client = makeClient();
    await client.delete('http://example.com/api/item');
    assert.equal(capturedMethod, 'DELETE');
  });
});
