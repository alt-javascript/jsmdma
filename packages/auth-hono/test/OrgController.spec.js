/**
 * OrgController.spec.js — Integration tests for OrgController
 *
 * Full CDI stack: AuthMiddlewareRegistrar → OrgController → OrgService → OrgRepository
 * Uses Hono's app.request() — no real HTTP server.
 * Users seeded directly via UserRepository.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  UserRepository, AuthService,
  OrgRepository, OrgService,
} from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import AuthMiddlewareRegistrar from '../AuthMiddlewareRegistrar.js';
import OrgController from '../OrgController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'org-controller-test-secret-32chars!!';

const BASE_CONFIG = {
  boot:    { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging: { level: { ROOT: 'error' } },
  server:  { port: 0 },
  auth:    { jwt: { secret: JWT_SECRET } },
  orgs:    { registerable: true },
};

// ── CDI context ───────────────────────────────────────────────────────────────

async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: UserRepository,  name: 'userRepository',  scope: 'singleton' },
    { Reference: AuthService,     name: 'authService',     scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: OrgRepository,   name: 'orgRepository',   scope: 'singleton' },
    { Reference: OrgService,      name: 'orgService',      scope: 'singleton' },
    // Middleware MUST come before controllers
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: OrgController,   name: 'orgController',   scope: 'singleton',
      properties: [{ name: 'registerable', path: 'orgs.registerable' }] },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function buildContextNoRegistration() {
  // Omit the orgs key entirely so registerable stays null (not injected)
  const { orgs: _omit, ...configWithoutOrgs } = BASE_CONFIG;
  const config = new EphemeralConfig(configWithoutOrgs);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: UserRepository,  name: 'userRepository',  scope: 'singleton' },
    { Reference: AuthService,     name: 'authService',     scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: OrgRepository,   name: 'orgRepository',   scope: 'singleton' },
    { Reference: OrgService,      name: 'orgService',      scope: 'singleton' },
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: OrgController,   name: 'orgController',   scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId) {
  return JwtSession.sign({ sub: userId, providers: ['test'], email: `${userId}@test.com` }, JWT_SECRET);
}

function authed(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function seedUser(appCtx, userId) {
  const repo = appCtx.get('userRepository');
  await repo._users().store(userId, {
    userId,
    email:     `${userId}@test.com`,
    providers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function post(app, path, body, token) {
  return app.request(path, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers: authed(token),
  });
}

async function get(app, path, token) {
  return app.request(path, { headers: authed(token) });
}

async function patch(app, path, body, token) {
  return app.request(path, {
    method:  'PATCH',
    body:    JSON.stringify(body),
    headers: authed(token),
  });
}

async function del(app, path, token) {
  return app.request(path, {
    method:  'DELETE',
    headers: authed(token),
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OrgController (CDI integration)', () => {
  let appCtx;
  let app;

  beforeEach(async () => {
    appCtx = await buildContext();
    app    = appCtx.get('honoAdapter').app;
  });

  // ── POST /orgs ────────────────────────────────────────────────────────────

  describe('POST /orgs', () => {
    it('creates org and returns orgId + name + role:org-admin', async () => {
      await seedUser(appCtx, 'alice');
      const token = await makeToken('alice');

      const res  = await post(app, '/orgs', { name: 'Acme Corp' }, token);
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.isString(body.orgId);
      assert.equal(body.name, 'Acme Corp');
      assert.equal(body.role, 'org-admin');
    });

    it('returns 401 without token', async () => {
      const res = await app.request('/orgs', {
        method:  'POST',
        body:    JSON.stringify({ name: 'Test' }),
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 401);
    });

    it('returns 400 when name is missing', async () => {
      await seedUser(appCtx, 'alice');
      const token = await makeToken('alice');
      const res   = await post(app, '/orgs', {}, token);
      assert.equal(res.status, 400);
    });

    it('returns 403 when orgs.registerable is absent', async () => {
      const noRegCtx = await buildContextNoRegistration();
      const noRegApp = noRegCtx.get('honoAdapter').app;
      await (async () => {
        const repo = noRegCtx.get('userRepository');
        await repo._users().store('alice', {
          userId: 'alice', email: 'alice@test.com', providers: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      })();
      const token = await makeToken('alice');
      const res   = await post(noRegApp, '/orgs', { name: 'Acme' }, token);
      assert.equal(res.status, 403);
    });

    it('returns 409 when org name is already taken', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');

      // alice creates 'Acme'
      const first = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      assert.equal(first.status, 201);

      // bob tries to create another org with the same name
      const second = await post(app, '/orgs', { name: 'Acme' }, bobToken);
      assert.equal(second.status, 409);
    });
  });

  // ── GET /orgs ─────────────────────────────────────────────────────────────

  describe('GET /orgs', () => {
    it('lists caller\'s orgs', async () => {
      await seedUser(appCtx, 'alice');
      const token = await makeToken('alice');

      await post(app, '/orgs', { name: 'Org One' }, token);
      await post(app, '/orgs', { name: 'Org Two' }, token);

      const res  = await get(app, '/orgs', token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isArray(body.orgs);
      assert.lengthOf(body.orgs, 2);
    });

    it('returns 401 without token', async () => {
      const res = await app.request('/orgs');
      assert.equal(res.status, 401);
    });
  });

  // ── GET /orgs/:orgId/members ──────────────────────────────────────────────

  describe('GET /orgs/:orgId/members', () => {
    it('returns 403 for non-member', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');

      const createRes = await post(app, '/orgs', { name: 'Secret Org' }, aliceToken);
      const { orgId } = await createRes.json();

      const res = await get(app, `/orgs/${orgId}/members`, bobToken);
      assert.equal(res.status, 403);
    });

    it('returns 200 with member list for org member', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');

      const createRes = await post(app, '/orgs', { name: 'Open Org' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);

      const res  = await get(app, `/orgs/${orgId}/members`, bobToken);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isArray(body.members);
      assert.lengthOf(body.members, 2);
    });

    it('returns 404 for unknown org', async () => {
      await seedUser(appCtx, 'alice');
      const token = await makeToken('alice');
      const res   = await get(app, '/orgs/no-such-org/members', token);
      assert.equal(res.status, 404);
    });
  });

  // ── POST /orgs/:orgId/members ─────────────────────────────────────────────

  describe('POST /orgs/:orgId/members', () => {
    it('adds member successfully (admin caller)', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();

      const res  = await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.member.userId, 'bob');
      assert.equal(body.member.role, 'member');
    });

    it('returns 403 for non-admin member caller', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      await seedUser(appCtx, 'carol');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);

      const res = await post(app, `/orgs/${orgId}/members`, { userId: 'carol' }, bobToken);
      assert.equal(res.status, 403);
    });

    it('returns 409 when user is already a member', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);

      const res = await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);
      assert.equal(res.status, 409);
    });
  });

  // ── PATCH /orgs/:orgId/members/:userId ────────────────────────────────────

  describe('PATCH /orgs/:orgId/members/:userId', () => {
    it('changes role successfully', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);

      const res  = await patch(app, `/orgs/${orgId}/members/bob`, { role: 'org-admin' }, aliceToken);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.member.role, 'org-admin');
    });

    it('returns 409 when demoting last admin', async () => {
      await seedUser(appCtx, 'alice');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();

      const res = await patch(app, `/orgs/${orgId}/members/alice`, { role: 'member' }, aliceToken);
      assert.equal(res.status, 409);
    });
  });

  // ── DELETE /orgs/:orgId/members/:userId ───────────────────────────────────

  describe('DELETE /orgs/:orgId/members/:userId', () => {
    it('removes member successfully', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);

      const res  = await del(app, `/orgs/${orgId}/members/bob`, aliceToken);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isTrue(body.removed);
    });

    it('returns 409 when removing last admin', async () => {
      await seedUser(appCtx, 'alice');
      const aliceToken = await makeToken('alice');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();

      const res = await del(app, `/orgs/${orgId}/members/alice`, aliceToken);
      assert.equal(res.status, 409);
    });

    it('returns 403 when caller is not org-admin', async () => {
      await seedUser(appCtx, 'alice');
      await seedUser(appCtx, 'bob');
      await seedUser(appCtx, 'carol');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');

      const createRes = await post(app, '/orgs', { name: 'Acme' }, aliceToken);
      const { orgId } = await createRes.json();
      await post(app, `/orgs/${orgId}/members`, { userId: 'bob' }, aliceToken);
      await post(app, `/orgs/${orgId}/members`, { userId: 'carol' }, aliceToken);

      const res = await del(app, `/orgs/${orgId}/members/carol`, bobToken);
      assert.equal(res.status, 403);
    });
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('orgController.orgService is autowired', () => {
      const ctrl = appCtx.get('orgController');
      assert.instanceOf(ctrl.orgService, OrgService);
    });
  });

});
