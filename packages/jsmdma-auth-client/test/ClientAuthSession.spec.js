import { assert } from 'chai';
import ClientAuthSession from '../ClientAuthSession.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};

const TEST_SECRET = 'client-auth-session-test-secret-32';

async function makeToken(overrides = {}) {
  const { SignJWT } = await import('jose');
  const now = Math.floor(Date.now() / 1000);
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT({
    sub: 'user-uuid-abc',
    providers: ['google'],
    email: 'test@example.com',
    iat_session: now,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .sign(secret);
}

async function makeExpiredIdleToken() {
  const { SignJWT } = await import('jose');
  const nowSec = Math.floor(Date.now() / 1000);
  const fourDaysAgo = nowSec - 4 * 24 * 60 * 60;
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT({ sub: 'user-old', providers: ['google'], iat_session: fourDaysAgo })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(fourDaysAgo)
    .sign(secret);
}

describe('ClientAuthSession', () => {
  beforeEach(() => { global.localStorage = mockStorage; });
  afterEach(() => { mockStorage.clear(); });

  it('store() and getToken() round-trip the JWT', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.equal(ClientAuthSession.getToken(), token);
  });

  it('getToken() returns null when no token stored', () => {
    assert.isNull(ClientAuthSession.getToken());
  });

  it('getPayload() returns decoded payload with sub', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    const payload = ClientAuthSession.getPayload();
    assert.equal(payload.sub, 'user-uuid-abc');
    assert.deepEqual(payload.providers, ['google']);
  });

  it('isSignedIn() returns true when valid token present', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.isTrue(ClientAuthSession.isSignedIn());
  });

  it('isSignedIn() returns false when no token', () => {
    assert.isFalse(ClientAuthSession.isSignedIn());
  });

  it('getUserUuid() returns jwt.sub', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    assert.equal(ClientAuthSession.getUserUuid(), 'user-uuid-abc');
  });

  it('getUserUuid() returns null when no token', () => {
    assert.isNull(ClientAuthSession.getUserUuid());
  });

  it('getToken() returns null for idle-expired token (iat > 3 days old)', async () => {
    const token = await makeExpiredIdleToken();
    ClientAuthSession.store(token);
    assert.isNull(ClientAuthSession.getToken());
  });

  it('clear() removes auth_token, auth_provider, auth_time', async () => {
    const token = await makeToken();
    ClientAuthSession.store(token);
    mockStorage.setItem('auth_provider', 'google');
    mockStorage.setItem('auth_time', String(Date.now()));
    ClientAuthSession.clear();
    assert.isNull(mockStorage.getItem('auth_token'));
    assert.isNull(mockStorage.getItem('auth_provider'));
    assert.isNull(mockStorage.getItem('auth_time'));
  });
});
