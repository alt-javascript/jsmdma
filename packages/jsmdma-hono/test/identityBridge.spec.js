/**
 * identityBridge.spec.js — Bridge regression suite for R031.
 *
 * Proves: OAuthSessionMiddleware correctly bridges identity into controllers
 * through HonoControllerRegistrar's middleware pipeline.
 *
 * Six required test cases:
 *   1. Identity propagation — valid token → 201 (OrgController.createOrg ran with identity)
 *   2. 401 session_required — no Authorization header
 *   3. 401 session_invalid (malformed) — "Bearer not-a-jwt"
 *   4. 401 session_invalid (wrong signature) — token signed with different secret
 *   5. 401 session_expired — token with exp in the past
 *   6. Multi-controller identity — both OrgController + DocIndexController receive identity
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { OAuthSessionMiddleware } from '@alt-javascript/boot-oauth';
import { OAuthSessionEngine } from '@alt-javascript/boot-oauth-core';
import { OrgRepository, OrgService, DocumentIndexRepository } from '@alt-javascript/jsmdma-server';
import { mintTestToken, TestOAuthSessionEngine, TEST_JWT_SECRET } from './helpers/mintTestToken.js';
import OrgController from '../OrgController.js';
import DocIndexController from '../DocIndexController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  boot:    { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging: { level: { ROOT: 'error' } },
  server:  { port: 0 },
  orgs:    { registerable: true },
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: OrgRepository,           name: 'orgRepository',           scope: 'singleton' },
    { Reference: OrgService,              name: 'orgService',              scope: 'singleton' },
    { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
    // OAuthSessionMiddleware requires oauthSessionEngine CDI bean
    { Reference: TestOAuthSessionEngine,  name: 'oauthSessionEngine',      scope: 'singleton' },
    // Auth middleware MUST come before controllers
    { Reference: OAuthSessionMiddleware,  name: 'oauthSessionMiddleware',  scope: 'singleton' },
    { Reference: OrgController,           name: 'orgController',           scope: 'singleton',
      properties: [{ name: 'registerable', path: 'orgs.registerable' }] },
    { Reference: DocIndexController,      name: 'docIndexController',      scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();
  return appCtx;
}

function apiReq(app, method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return app.request(path, opts);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('identityBridge (CDI integration)', () => {
  let appCtx;
  let app;

  beforeEach(async () => {
    appCtx = await buildContext();
    app    = appCtx.get('honoAdapter').app;
  });

  // 1. Identity propagation
  it('POST /orgs with valid token returns 201 with orgId (identity.userId propagated through pipeline)', async () => {
    const token = mintTestToken({ userId: 'bridge-user-1' });
    const res = await apiReq(app, 'POST', '/orgs', token, { name: 'Bridge Org' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.property(body, 'orgId');
    assert.equal(body.name, 'Bridge Org');
  });

  // 2. 401 session_required — no token
  it('POST /orgs without Authorization header returns 401 session_required', async () => {
    const res = await apiReq(app, 'POST', '/orgs', null, { name: 'No Auth Org' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'session_required');
  });

  // 3. 401 session_invalid — malformed token
  it('POST /orgs with malformed Bearer token returns 401 session_invalid', async () => {
    const res = await apiReq(app, 'POST', '/orgs', 'not-a-jwt', { name: 'Malformed Auth Org' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'session_invalid');
  });

  // 4. 401 session_invalid — wrong signature
  it('POST /orgs with wrong-signature token returns 401 session_invalid', async () => {
    const wrongEngine = new OAuthSessionEngine({ secret: 'wrong-secret-totally-different-xyz-999' });
    const wrongToken = wrongEngine.sign({
      userId: 'attacker', provider: 'test', providerUserId: 'x',
      email: 'x@evil.com', intent: 'signin', mode: 'bearer',
    });
    const res = await apiReq(app, 'POST', '/orgs', wrongToken, { name: 'Wrong Sig Org' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'session_invalid');
  });

  // 5. 401 session_expired — exp in the past
  it('POST /orgs with expired token returns 401 session_expired', async () => {
    const expEngine = new OAuthSessionEngine({ secret: TEST_JWT_SECRET });
    const expiredToken = expEngine.sign(
      { userId: 'expired-user', provider: 'test', providerUserId: 'x', email: 'x@test.com', intent: 'signin', mode: 'bearer' },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    const res = await apiReq(app, 'POST', '/orgs', expiredToken, { name: 'Expired Auth Org' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'session_expired');
  });

  // 6. Multi-controller identity — OAuthSessionMiddleware runs for all __routes controllers
  it('valid token reaches both OrgController and DocIndexController (multi-controller identity bridge)', async () => {
    const token = mintTestToken({ userId: 'multi-ctrl-user' });

    // OrgController: POST /orgs → 201 proves identity.userId present
    const orgRes = await apiReq(app, 'POST', '/orgs', token, { name: 'Multi Ctrl Org' });
    assert.equal(orgRes.status, 201, 'OrgController: expected 201, not 401 — identity must be present');

    // DocIndexController: GET /docIndex/:app/:docKey → 404 (entry not found) not 401 (not auth failure)
    // If identity were missing, DocIndexController._getUser() would return null → 401.
    const docRes = await apiReq(app, 'GET', '/docIndex/todo/no-such-key', token);
    assert.equal(docRes.status, 404, 'DocIndexController: expected 404 (entry not found), not 401 (auth failure) — identity must reach second controller');
  });
});
