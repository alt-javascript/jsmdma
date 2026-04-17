/**
 * authMiddleware.spec.js — Unit tests for authMiddleware factory
 *
 * Uses a minimal Hono app (no CDI). Tests the middleware in isolation.
 */
import { assert } from 'chai';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { authMiddleware } from '../authMiddleware.js';

const SECRET = 'middleware-test-secret-32-chars!!';
const KEY    = new TextEncoder().encode(SECRET);

// ── helpers ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.use('/protected/*', authMiddleware(SECRET));
  app.get('/protected/resource', (c) => {
    const user = c.get('user');
    return c.json({ ok: true, sub: user?.sub ?? null });
  });
  app.post('/protected/data', (c) => c.json({ ok: true }));
  return app;
}

async function makeValidToken(extra = {}) {
  return JwtSession.sign({ sub: 'user-uuid', providers: ['github'], ...extra }, SECRET);
}

async function craftToken({ iat, iatSession }) {
  return new SignJWT({ sub: 'test-user', providers: ['github'], iat_session: iatSession })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setSubject('test-user')
    .sign(KEY);
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('authMiddleware', () => {

  it('passes valid token and attaches user to context', async () => {
    const app   = buildApp();
    const token = await makeValidToken();
    const res   = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sub, 'user-uuid');
  });

  it('returns typed 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await app.request('/protected/resource');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Unauthorized');
    assert.equal(body.code, 'unauthorized');
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const app = buildApp();
    const res = await app.request('/protected/resource', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(res.status, 401);
  });

  it('returns 401 for an invalid (bad signature) token', async () => {
    const app = buildApp();
    const res = await app.request('/protected/resource', {
      headers: { Authorization: 'Bearer not.a.valid.jwt.at.all' },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Unauthorized');
  });

  it('returns 401 with reason=idle for idle-expired token', async () => {
    const app = buildApp();
    const idleToken = await craftToken({
      iat: nowSec() - (3 * 24 * 60 * 60 + 60),
      iatSession: nowSec() - (3 * 24 * 60 * 60 + 60),
    });
    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${idleToken}` },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Session expired');
    assert.equal(body.reason, 'idle');
  });

  it('returns 401 with reason=hard for hard-expired token', async () => {
    const app = buildApp();
    const hardToken = await craftToken({
      iat: nowSec(),                              // recent iat (was "refreshed" today)
      iatSession: nowSec() - (7 * 24 * 60 * 60 + 60), // but session is old
    });
    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${hardToken}` },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Session expired');
    assert.equal(body.code, 'unauthorized');
    assert.equal(body.reason, 'hard');
  });

  it('emits X-Auth-Token header when token is eligible for refresh', async () => {
    const app = buildApp();
    // Token with iat > 1h ago but within idle TTL
    const oldIat = nowSec() - (60 * 60 + 60);
    const refreshToken = await craftToken({ iat: oldIat, iatSession: oldIat });
    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    assert.equal(res.status, 200);
    const newToken = res.headers.get('x-auth-token');
    assert.isString(newToken, 'X-Auth-Token header should be present');
    // Verify the new token is valid
    const payload = await JwtSession.verify(newToken, SECRET);
    assert.equal(payload.sub, 'test-user');
  });

  it('does not emit X-Auth-Token for a fresh token', async () => {
    const app   = buildApp();
    const token = await makeValidToken();
    const res   = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.isNull(res.headers.get('x-auth-token'));
  });

});
