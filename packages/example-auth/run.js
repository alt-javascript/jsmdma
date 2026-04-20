/**
 * run.js — Mode-aware auth lifecycle walkthrough
 *
 * Demonstrates the boot-style lifecycle contract:
 *
 *   1. GET /auth/:provider + POST /auth/login/finalize (mode=bearer)
 *   2. GET /auth/me with bearer token
 *   3. POST /auth/link/finalize + DELETE /auth/unlink/:provider
 *   4. POST /auth/signout and stale-session rejection on /auth/me
 *   5. GET /auth/:provider + POST /auth/login/finalize (mode=session alias)
 *   6. GET /auth/me with cookie session + cookie signout invalidation
 *
 * Run:
 *   node packages/example-auth/run.js
 */

import { buildAuthOnlyStarterApp } from './runtime/authStarterRuntime.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'example-auth-secret-must-be-32-chars!!';

// ── helpers ───────────────────────────────────────────────────────────────────

function assert(condition, message) {
  if (!condition) {
    console.error(`\n✗ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function banner(text) {
  const line = '─'.repeat(68);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(line);
}

function print(label, value) {
  const val = typeof value === 'object' ? JSON.stringify(value) : value;
  console.log(`  ${label.padEnd(30)} ${val}`);
}

function encode(value) {
  return encodeURIComponent(value ?? '');
}

async function expectJson(res, label) {
  const body = await res.json().catch(() => null);
  assert(body && typeof body === 'object', `${label} returned malformed JSON envelope`);
  return body;
}

async function expectTypedError(res, { status, code, reason }, label) {
  assert(res.status === status, `${label} should return ${status}, got ${res.status}`);
  const body = await expectJson(res, label);
  assert(body.code === code, `${label} should return code=${code}, got ${body.code}`);
  if (reason !== undefined) {
    assert(body.reason === reason, `${label} should return reason=${reason}, got ${body.reason}`);
  }
  return body;
}

function extractCookieValue(setCookie, name) {
  if (typeof setCookie !== 'string' || setCookie.length === 0) return null;
  const first = setCookie.split(';')[0] ?? '';
  const [cookieName, rawValue] = first.split('=');
  if (!cookieName || cookieName.trim() !== name) return null;
  return decodeURIComponent(rawValue ?? '');
}

// ── mock OAuth providers ──────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId, email) {
    this._uid = providerUserId;
    this._email = email;
  }

  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }

  async validateCallback() {
    return { providerUserId: this._uid, email: this._email };
  }
}

// ── lifecycle helpers ─────────────────────────────────────────────────────────

async function beginAuth(app, provider, query = '') {
  const res = await app.request(`/auth/${provider}${query}`);
  assert(res.status === 200, `begin auth should return 200, got ${res.status}`);
  const body = await expectJson(res, `begin auth (${provider})`);
  assert(typeof body.state === 'string' && body.state.length > 0, 'begin auth should return non-empty state');
  return body;
}

async function loginFinalize(app, { provider, state, mode }) {
  const res = await app.request(
    `/auth/login/finalize?provider=${encode(provider)}&code=mock-code&state=${encode(state)}&mode=${encode(mode)}`,
    { method: 'POST' },
  );
  assert(res.status === 200, `login finalize should return 200, got ${res.status}`);
  return expectJson(res, `login finalize (${provider}, mode=${mode})`);
}

async function linkFinalize(app, { token, provider, state }) {
  const res = await app.request(
    `/auth/link/finalize?provider=${encode(provider)}&code=mock-code&state=${encode(state)}&stored_state=${encode(state)}&code_verifier=`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  assert(res.status === 200, `link finalize should return 200, got ${res.status}`);
  return expectJson(res, `link finalize (${provider})`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner('jsmdma — Mode-aware Auth Lifecycle Example');

  const { app } = await buildAuthOnlyStarterApp({
    jwtSecret: JWT_SECRET,
    providers: {
      github: new MockProvider('gh-user-1', 'alice@github.com'),
      google: new MockProvider('google-user-1', 'alice@google.com'),
    },
  });

  console.log('\n  ✓ Boot-first starter context ready (mock providers: github, google)');

  // ── Step 1: login finalize (bearer mode) ───────────────────────────────────

  banner('Step 1: GET /auth/:provider + POST /auth/login/finalize (bearer)');

  const beginLogin = await beginAuth(app, 'github');
  const loginBearer = await loginFinalize(app, {
    provider: 'github',
    state: beginLogin.state,
    mode: 'bearer',
  });

  assert(loginBearer.mode === 'bearer', `expected bearer mode, got ${loginBearer.mode}`);
  assert(typeof loginBearer.token === 'string' && loginBearer.token.length > 0, 'bearer login should return token');
  assert(loginBearer.user?.userId, 'bearer login should return user payload');

  print('userId:', loginBearer.user.userId);
  print('providers:', loginBearer.user.providers.map((p) => p.provider));
  print('mode:', loginBearer.mode);
  console.log('\n  ✓ Bearer login finalized');

  // ── Step 2: /auth/me + mode mismatch negative ──────────────────────────────

  banner('Step 2: GET /auth/me with bearer token + mismatch negative');

  const meBearerRes = await app.request('/auth/me', {
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  assert(meBearerRes.status === 200, `/auth/me should return 200, got ${meBearerRes.status}`);
  const meBearer = await expectJson(meBearerRes, 'GET /auth/me (bearer)');

  assert(meBearer.userId === loginBearer.user.userId, 'bearer /auth/me userId should match login userId');
  assert(meBearer.mode === 'bearer', `expected /auth/me mode=bearer, got ${meBearer.mode}`);

  const mismatchRes = await app.request('/auth/me?mode=cookie', {
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  await expectTypedError(mismatchRes, {
    status: 400,
    code: 'invalid_state',
    reason: 'session_mode_mismatch',
  }, 'GET /auth/me mode mismatch');

  print('/auth/me mode:', meBearer.mode);
  console.log('\n  ✓ Bearer identity confirmed and mode mismatch is typed');

  // ── Step 3: link finalize ───────────────────────────────────────────────────

  banner('Step 3: Link second provider via /auth/link/finalize');

  const beginLink = await beginAuth(app, 'google', '?link=true');
  const linkResult = await linkFinalize(app, {
    token: loginBearer.token,
    provider: 'google',
    state: beginLink.state,
  });

  const linkedProviders = (linkResult.user?.providers ?? []).map((p) => p.provider).sort();
  assert(linkedProviders.length === 2, `expected 2 providers after link, got ${linkedProviders.length}`);
  assert(linkedProviders[0] === 'github' && linkedProviders[1] === 'google', 'expected github + google after link');

  print('providers after link:', linkedProviders);
  console.log('\n  ✓ Link finalize succeeded with deterministic projection');

  // ── Step 4: unlink + lockout guard ─────────────────────────────────────────

  banner('Step 4: DELETE /auth/unlink/:provider + last-provider lockout reason');

  const unlinkGithubRes = await app.request('/auth/unlink/github', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  assert(unlinkGithubRes.status === 200, `unlink github should return 200, got ${unlinkGithubRes.status}`);
  const unlinkGithubBody = await expectJson(unlinkGithubRes, 'DELETE /auth/unlink/github');

  const remaining = (unlinkGithubBody.providers ?? []).map((p) => p.provider);
  assert(remaining.length === 1 && remaining[0] === 'google', 'google should remain after unlink github');

  const lockoutRes = await app.request('/auth/unlink/google', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  await expectTypedError(lockoutRes, {
    status: 409,
    code: 'last_provider_unlink_forbidden',
    reason: 'last_provider_lockout',
  }, 'DELETE /auth/unlink/google lockout');

  print('remaining providers:', remaining);
  console.log('\n  ✓ Unlink and last-provider lockout typed reason verified');

  // ── Step 5: bearer signout + stale-session rejection ───────────────────────

  banner('Step 5: POST /auth/signout (bearer) + stale /auth/me token');

  const signoutBearerRes = await app.request('/auth/signout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  assert(signoutBearerRes.status === 200, `signout bearer should return 200, got ${signoutBearerRes.status}`);
  const signoutBearerBody = await expectJson(signoutBearerRes, 'POST /auth/signout (bearer)');
  assert(signoutBearerBody.mode === 'bearer', `signout bearer should report mode=bearer, got ${signoutBearerBody.mode}`);

  const staleBearerMeRes = await app.request('/auth/me', {
    headers: { Authorization: `Bearer ${loginBearer.token}` },
  });
  await expectTypedError(staleBearerMeRes, {
    status: 401,
    code: 'invalid_state',
    reason: 'session_not_found',
  }, 'GET /auth/me with stale bearer token');

  console.log('\n  ✓ Signout invalidates bearer session token deterministically');

  // ── Step 6: cookie mode alias + cookie signout invalidation ────────────────

  banner('Step 6: login finalize mode=session alias + cookie session lifecycle');

  const beginCookieLogin = await beginAuth(app, 'github');
  const loginCookie = await loginFinalize(app, {
    provider: 'github',
    state: beginCookieLogin.state,
    mode: 'session', // alias -> cookie
  });

  assert(loginCookie.mode === 'cookie', `mode=session should normalize to cookie, got ${loginCookie.mode}`);
  assert(!loginCookie.token, 'cookie login should not return token in body');

  const finalizeCookieRes = await app.request(
    `/auth/login/finalize?provider=github&code=mock-code&state=${encode(beginCookieLogin.state)}&mode=session`,
    { method: 'POST' },
  );
  assert(finalizeCookieRes.status === 400, 'replaying same state should fail');
  const replayBody = await expectJson(finalizeCookieRes, 'POST /auth/login/finalize replay');
  assert(replayBody.code === 'invalid_state', `replay should return invalid_state, got ${replayBody.code}`);
  assert(replayBody.reason === 'unknown_state', `replay should return reason=unknown_state, got ${replayBody.reason}`);

  const beginCookieLogin2 = await beginAuth(app, 'github');
  const cookieFinalizeRes = await app.request(
    `/auth/login/finalize?provider=github&code=mock-code&state=${encode(beginCookieLogin2.state)}&mode=session`,
    { method: 'POST' },
  );
  assert(cookieFinalizeRes.status === 200, `cookie finalize should return 200, got ${cookieFinalizeRes.status}`);
  const cookieFinalizeBody = await expectJson(cookieFinalizeRes, 'cookie login finalize');
  assert(cookieFinalizeBody.mode === 'cookie', 'cookie finalize should report cookie mode');

  const setCookie = cookieFinalizeRes.headers.get('set-cookie');
  const cookieToken = extractCookieValue(setCookie, 'auth_session');
  assert(cookieToken, 'cookie finalize should set auth_session cookie');

  const meCookieRes = await app.request('/auth/me?mode=cookie', {
    headers: { Cookie: `auth_session=${encodeURIComponent(cookieToken)}` },
  });
  assert(meCookieRes.status === 200, `cookie /auth/me should return 200, got ${meCookieRes.status}`);
  const meCookie = await expectJson(meCookieRes, 'GET /auth/me (cookie)');
  assert(meCookie.mode === 'cookie', `expected cookie mode on /auth/me, got ${meCookie.mode}`);

  const signoutCookieRes = await app.request('/auth/signout?mode=cookie', {
    method: 'POST',
    headers: { Cookie: `auth_session=${encodeURIComponent(cookieToken)}` },
  });
  assert(signoutCookieRes.status === 200, `cookie signout should return 200, got ${signoutCookieRes.status}`);
  const signoutCookieBody = await expectJson(signoutCookieRes, 'POST /auth/signout (cookie)');
  assert(signoutCookieBody.mode === 'cookie', `cookie signout should report mode=cookie, got ${signoutCookieBody.mode}`);

  const staleCookieMeRes = await app.request('/auth/me?mode=cookie', {
    headers: { Cookie: `auth_session=${encodeURIComponent(cookieToken)}` },
  });
  await expectTypedError(staleCookieMeRes, {
    status: 401,
    code: 'invalid_state',
    reason: 'session_not_found',
  }, 'GET /auth/me with stale cookie token');

  console.log('\n  ✓ Cookie mode/session alias lifecycle verified');

  // ── Summary ─────────────────────────────────────────────────────────────────

  banner('Result');
  console.log('\n  ✓ login finalize (bearer) → /auth/me (bearer)');
  console.log('  ✓ link finalize → unlink with typed last_provider_lockout guard');
  console.log('  ✓ signout rejects stale bearer session with session_not_found');
  console.log('  ✓ mode=session alias normalizes to cookie and works end-to-end');
  console.log('  ✓ replay and mode mismatch return deterministic typed reasons');
  console.log('\n  All assertions passed. Mode-aware auth lifecycle is working correctly.\n');
}

main().catch((err) => {
  console.error('\n✗ Example failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
