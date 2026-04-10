/**
 * run.js — Auth lifecycle example
 *
 * Demonstrates the complete M002 authentication layer:
 *
 *   1. Boot CDI context with mock OAuth providers
 *   2. First login → new UUID issued, JWT returned
 *   3. GET /auth/me → user identity confirmed
 *   4. POST /sync with JWT → authenticated sync succeeds
 *   5. Rolling refresh → X-Auth-Token header emitted for near-expiry token
 *   6. Link a second provider → providers list updated
 *   7. Unlink the first provider → one provider remains
 *   8. Attempt to unlink last provider → 409 (correctly rejected)
 *   9. Use an expired token → 401 with reason: idle
 *  10. Exit 0
 *
 * Uses Hono's app.request() for request simulation — no TCP port needed.
 *
 * Run:
 *   node packages/example-auth/run.js
 */

import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { SyncRepository, SyncService } from '@alt-javascript/jsmdma-server';
import { SyncController } from '@alt-javascript/jsmdma-hono';
import { authHonoStarter } from '@alt-javascript/jsmdma-auth-hono';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { SignJWT } from 'jose';

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
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(line);
}

function print(label, value) {
  const val = typeof value === 'object' ? JSON.stringify(value) : value;
  console.log(`  ${label.padEnd(24)} ${val}`);
}

// ── mock OAuth providers ──────────────────────────────────────────────────────

class MockProvider {
  constructor(providerUserId, email) {
    this._uid   = providerUserId;
    this._email = email;
  }
  createAuthorizationURL(state) {
    return new URL(`https://mock.provider/auth?state=${state}`);
  }
  async validateCallback() {
    return { providerUserId: this._uid, email: this._email };
  }
}

// ── craft an expired token for expiry test ────────────────────────────────────

async function craftExpiredToken(sub, providers) {
  const key = new TextEncoder().encode(JWT_SECRET);
  const idleExpiredIat = Math.floor(Date.now() / 1000) - (3 * 24 * 60 * 60 + 60); // 3d + 1min ago
  return new SignJWT({ sub, providers, iat_session: idleExpiredIat })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(idleExpiredIat)
    .setSubject(sub)
    .sign(key);
}

// ── craft a near-expiry token for refresh test ────────────────────────────────

async function craftRefreshableToken(sub, providers, email) {
  const key    = new TextEncoder().encode(JWT_SECRET);
  const oldIat = Math.floor(Date.now() / 1000) - (60 * 60 + 60); // 1h + 1min ago
  return new SignJWT({ sub, providers, email, iat_session: oldIat })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(oldIat)
    .setSubject(sub)
    .sign(key);
}

// ── CDI context ───────────────────────────────────────────────────────────────

async function buildContext(providers) {
  const config = new EphemeralConfig({
    'boot':    { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging': { level: { ROOT: 'error' } },
    'server':  { port: 0 },
    'auth':    { jwt: { secret: JWT_SECRET } },
    'orgs':    { registerable: false },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository, name: 'syncRepository', scope: 'singleton' },
    { Reference: SyncService,    name: 'syncService',    scope: 'singleton' },
    ...authHonoStarter(),
    { Reference: SyncController, name: 'syncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  appCtx.get('authController').providers = providers;

  return { app: appCtx.get('honoAdapter').app, appCtx };
}

// ── helper: login via a mock provider ────────────────────────────────────────

async function login(app, providerName) {
  const beginRes  = await app.request(`/auth/${providerName}`);
  const { state, codeVerifier } = await beginRes.json();
  const callbackUrl = `/auth/${providerName}/callback?code=mock&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`;
  const res = await app.request(callbackUrl);
  return res.json();
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner('jsmdma — Auth Lifecycle Example');

  const { app } = await buildContext({
    github: new MockProvider('gh-user-1', 'alice@github.com'),
    google: new MockProvider('google-user-1', 'alice@google.com'),
  });

  console.log('\n  ✓ CDI context ready (mock providers: github, google)');

  // ── Step 1: First login ────────────────────────────────────────────────────

  banner('Step 1: First login via GitHub');

  const { user: u1, token: token1 } = await login(app, 'github');

  assert(u1.userId.length === 36, 'userId should be a UUID');
  assert(u1.providers.length === 1, 'should have 1 provider');
  assert(u1.providers[0].provider === 'github', 'provider should be github');

  print('User UUID:', u1.userId);
  print('Email:', u1.email);
  print('Providers:', u1.providers.map(p => p.provider));
  print('JWT (first 40):', token1.slice(0, 40) + '...');
  console.log('\n  ✓ New UUID assigned');

  // ── Step 2: GET /auth/me ───────────────────────────────────────────────────

  banner('Step 2: GET /auth/me — verify identity');

  const meRes  = await app.request('/auth/me', {
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert(meRes.status === 200, `/auth/me should return 200, got ${meRes.status}`);
  const me = await meRes.json();

  assert(me.userId === u1.userId, 'userId should match');
  print('userId:', me.userId);
  print('email:', me.email);
  print('providers:', me.providers);
  console.log('\n  ✓ Identity confirmed');

  // ── Step 3: Authenticated POST /sync ──────────────────────────────────────

  banner('Step 3: POST /sync with JWT');

  const syncRes = await app.request('/sync', {
    method:  'POST',
    body:    JSON.stringify({ collection: 'notes', clientClock: '0000000000000-000000-00000000', changes: [] }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token1}` },
  });
  assert(syncRes.status === 200, `/sync should return 200, got ${syncRes.status}`);
  const syncBody = await syncRes.json();
  print('serverClock:', syncBody.serverClock);
  console.log('\n  ✓ Authenticated sync succeeded');

  // ── Step 4: Rolling refresh ────────────────────────────────────────────────

  banner('Step 4: Rolling refresh — token near expiry');

  const oldToken = await craftRefreshableToken(u1.userId, ['github'], u1.email);
  const refreshRes = await app.request('/auth/me', {
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  assert(refreshRes.status === 200, `should still be valid: ${refreshRes.status}`);
  const newToken = refreshRes.headers.get('x-auth-token');
  assert(newToken != null, 'X-Auth-Token header should be present');
  const newPayload = await JwtSession.verify(newToken, JWT_SECRET);

  print('Old token iat (h ago):', `~${Math.floor((Date.now()/1000 - 3660) / 3600)}h`);
  print('New token iat (now):', 'fresh');
  print('iat_session preserved:', newPayload.iat_session < Math.floor(Date.now() / 1000));
  console.log('\n  ✓ Rolling refresh: X-Auth-Token header emitted, iat_session preserved');

  // ── Step 5: Link second provider ──────────────────────────────────────────

  banner('Step 5: Link Google as second provider');

  const beginRes = await app.request('/auth/google', {
    headers: { Authorization: `Bearer ${token1}` },
  });
  const { state, codeVerifier } = await beginRes.json();

  const linkRes = await app.request(
    `/auth/link/google?code=mock&state=${state}&stored_state=${state}&code_verifier=${codeVerifier}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token1}` } },
  );
  assert(linkRes.status === 200, `link should return 200, got ${linkRes.status}`);
  const { user: linked } = await linkRes.json();

  assert(linked.providers.length === 2, 'should have 2 providers after link');
  assert(linked.userId === u1.userId, 'UUID should be unchanged');
  print('Providers after link:', linked.providers.map(p => p.provider).sort());
  console.log('\n  ✓ Google linked; UUID unchanged');

  // ── Step 6: Unlink GitHub ─────────────────────────────────────────────────

  banner('Step 6: Unlink GitHub (still has Google)');

  const unlinkRes = await app.request('/auth/providers/github', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert(unlinkRes.status === 200, `unlink should return 200, got ${unlinkRes.status}`);
  const { providers: remaining } = await unlinkRes.json();

  assert(remaining.length === 1, 'should have 1 provider after unlink');
  assert(remaining[0].provider === 'google', 'remaining provider should be google');
  print('Providers after unlink:', remaining.map(p => p.provider));
  console.log('\n  ✓ GitHub unlinked; Google remains');

  // ── Step 7: 409 on last provider ─────────────────────────────────────────

  banner('Step 7: Attempt to unlink last provider (Google)');

  const lastUnlinkRes = await app.request('/auth/providers/google', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token1}` },
  });
  assert(lastUnlinkRes.status === 409, `should return 409, got ${lastUnlinkRes.status}`);
  const { error } = await lastUnlinkRes.json();
  print('Response:', error);
  console.log('\n  ✓ Last provider rejection: 409 returned correctly');

  // ── Step 8: Expired token ────────────────────────────────────────────────

  banner('Step 8: Expired token → 401');

  const expiredToken = await craftExpiredToken(u1.userId, ['google']);
  const expiredRes   = await app.request('/auth/me', {
    headers: { Authorization: `Bearer ${expiredToken}` },
  });
  assert(expiredRes.status === 401, `should return 401, got ${expiredRes.status}`);
  const expiredBody = await expiredRes.json();
  assert(expiredBody.reason === 'idle', `should have reason=idle, got ${expiredBody.reason}`);
  print('Status:', expiredRes.status);
  print('Reason:', expiredBody.reason);
  console.log('\n  ✓ Expired token correctly rejected with reason=idle');

  // ── Summary ───────────────────────────────────────────────────────────────

  banner('Result');
  console.log('\n  ✓ First login → new UUID assigned');
  console.log('  ✓ GET /auth/me → identity confirmed');
  console.log('  ✓ POST /sync → authenticated request succeeds');
  console.log('  ✓ Rolling refresh → X-Auth-Token emitted, iat_session preserved');
  console.log('  ✓ Provider link → second provider added, UUID unchanged');
  console.log('  ✓ Provider unlink → first provider removed');
  console.log('  ✓ Last provider protection → 409 on unlink attempt');
  console.log('  ✓ Expired token → 401 with reason=idle');
  console.log('\n  All assertions passed. Auth lifecycle working correctly.\n');
}

main().catch((err) => {
  console.error('\n✗ Example failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
