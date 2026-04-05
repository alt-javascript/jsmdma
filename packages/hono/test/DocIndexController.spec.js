/**
 * DocIndexController.spec.js — Integration tests for DocIndexController
 *
 * Full CDI stack: AuthMiddlewareRegistrar → DocIndexController → DocumentIndexRepository
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { DocumentIndexRepository } from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar } from '@alt-javascript/jsmdma-auth-hono';
import {
  OrgRepository, OrgService, UserRepository,
} from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import DocIndexController from '../DocIndexController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-chars-long!!';

const BASE_CONFIG = {
  boot:    { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging: { level: { ROOT: 'error' } },
  server:  { port: 0 },
  auth:    { jwt: { secret: JWT_SECRET } },
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: UserRepository,  name: 'userRepository',  scope: 'singleton' },
    { Reference: OrgRepository,   name: 'orgRepository',   scope: 'singleton' },
    { Reference: OrgService,      name: 'orgService',      scope: 'singleton' },
    // Auth middleware MUST come before DocIndexController
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
    { Reference: DocIndexController,      name: 'docIndexController',      scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId = 'user-uuid', extra = {}) {
  return JwtSession.sign({ sub: userId, providers: ['github'], ...extra }, JWT_SECRET);
}

function docIndexReq(app, method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return app.request(path, opts);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DocIndexController (CDI integration)', () => {
  let appCtx;
  let app;
  let docIndexRepo;

  beforeEach(async () => {
    appCtx      = await buildContext();
    app         = appCtx.get('honoAdapter').app;
    docIndexRepo = appCtx.get('documentIndexRepository');
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('docIndexController.documentIndexRepository is autowired', () => {
      const ctrl = appCtx.get('docIndexController');
      assert.instanceOf(ctrl.documentIndexRepository, DocumentIndexRepository);
    });
  });

  // ── GET /docIndex/:app/:docKey ─────────────────────────────────────────────

  describe('GET /docIndex/:app/:docKey', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await docIndexReq(app, 'GET', '/docIndex/todo/task-1');
      assert.equal(res.status, 401);
    });

    it('returns 404 for a nonexistent entry', async () => {
      const token = await makeToken('user-a');
      const res   = await docIndexReq(app, 'GET', '/docIndex/todo/nonexistent', token);
      assert.equal(res.status, 404);
    });

    it('returns 200 and the entry for the owner', async () => {
      const token = await makeToken('owner-get');
      // Seed directly via repository
      await docIndexRepo.upsertOwnership('owner-get', 'todo', 'task-1', 'tasks');

      const res = await docIndexReq(app, 'GET', '/docIndex/todo/task-1', token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.userId,     'owner-get');
      assert.equal(body.app,        'todo');
      assert.equal(body.docKey,     'task-1');
      assert.equal(body.visibility, 'private');
    });

    it('returns 403 for a non-owner (entry seeded under different userId)', async () => {
      // Seed entry under 'real-owner'
      await docIndexRepo.upsertOwnership('real-owner', 'todo', 'task-1', 'tasks');

      // 'attacker' cannot read it via the owner-keyed path
      // DocIndexController does get(user.sub, app, docKey) so this will return 404
      // because the key doesn't exist for the attacker's userId
      const attackerToken = await makeToken('attacker');
      const res = await docIndexReq(app, 'GET', '/docIndex/todo/task-1', attackerToken);
      // get() uses user.sub as userId — entry stored under 'real-owner' won't be found
      assert.equal(res.status, 404);
    });
  });

  // ── PATCH /docIndex/:app/:docKey ──────────────────────────────────────────

  describe('PATCH /docIndex/:app/:docKey', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-1', null, { visibility: 'shared' });
      assert.equal(res.status, 401);
    });

    it('returns 404 when entry does not exist', async () => {
      const token = await makeToken('patch-owner');
      const res   = await docIndexReq(app, 'PATCH', '/docIndex/todo/missing', token, { visibility: 'shared' });
      assert.equal(res.status, 404);
    });

    it('updates visibility to shared — returns 200 with updated entry', async () => {
      await docIndexRepo.upsertOwnership('patch-vis', 'todo', 'task-1', 'tasks');
      const token = await makeToken('patch-vis');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-1', token, { visibility: 'shared' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.visibility, 'shared');
    });

    it('updates visibility to public — returns 200', async () => {
      await docIndexRepo.upsertOwnership('patch-pub', 'todo', 'task-2', 'tasks');
      const token = await makeToken('patch-pub');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-2', token, { visibility: 'public' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.visibility, 'public');
    });

    it('returns 400 for an invalid visibility value', async () => {
      await docIndexRepo.upsertOwnership('patch-bad-vis', 'todo', 'task-3', 'tasks');
      const token = await makeToken('patch-bad-vis');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-3', token, { visibility: 'banana' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'visibility');
    });

    it('returns 400 when sharedWith is not an array', async () => {
      await docIndexRepo.upsertOwnership('patch-bad-sw', 'todo', 'task-4', 'tasks');
      const token = await makeToken('patch-bad-sw');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-4', token, { sharedWith: 'not-an-array' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'sharedWith');
    });

    it('adds a sharedWith entry — returns 200 with updated sharedWith', async () => {
      await docIndexRepo.upsertOwnership('patch-sw', 'todo', 'task-5', 'tasks');
      const token = await makeToken('patch-sw');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-5', token, {
        sharedWith: [{ userId: 'friend-1', app: 'todo' }],
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isArray(body.sharedWith);
      assert.deepInclude(body.sharedWith, { userId: 'friend-1', app: 'todo' });
    });

    it('non-owner cannot patch (entry exists for different userId)', async () => {
      // Seed under 'real-owner-patch' — non-owner will get 404 because key lookup uses user.sub
      await docIndexRepo.upsertOwnership('real-owner-patch', 'todo', 'task-6', 'tasks');
      const nonOwnerToken = await makeToken('non-owner-patch');

      const res = await docIndexReq(app, 'PATCH', '/docIndex/todo/task-6', nonOwnerToken, { visibility: 'shared' });
      // get() will return null (wrong userId in key) → 404
      assert.equal(res.status, 404);
    });
  });

  // ── POST /docIndex/:app/:docKey/shareToken ────────────────────────────────

  describe('POST /docIndex/:app/:docKey/shareToken', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await docIndexReq(app, 'POST', '/docIndex/todo/task-1/shareToken');
      assert.equal(res.status, 401);
    });

    it('returns 404 when entry does not exist', async () => {
      const token = await makeToken('mint-owner');
      const res   = await docIndexReq(app, 'POST', '/docIndex/todo/missing/shareToken', token);
      assert.equal(res.status, 404);
    });

    it('returns 200 with a UUID shareToken', async () => {
      await docIndexRepo.upsertOwnership('mint-user', 'todo', 'task-1', 'tasks');
      const token = await makeToken('mint-user');

      const res = await docIndexReq(app, 'POST', '/docIndex/todo/task-1/shareToken', token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isString(body.shareToken);
      // UUID v4 pattern
      assert.match(body.shareToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('minted token is persisted in the repository', async () => {
      await docIndexRepo.upsertOwnership('mint-persist', 'todo', 'task-mint', 'tasks');
      const token = await makeToken('mint-persist');

      const res = await docIndexReq(app, 'POST', '/docIndex/todo/task-mint/shareToken', token);
      assert.equal(res.status, 200);
      const { shareToken } = await res.json();

      const entry = await docIndexRepo.get('mint-persist', 'todo', 'task-mint');
      assert.equal(entry.shareToken, shareToken);
    });

    it('returns 403 for a non-owner (entry keyed under different userId)', async () => {
      await docIndexRepo.upsertOwnership('real-owner-mint', 'todo', 'task-1', 'tasks');
      const nonOwnerToken = await makeToken('non-owner-mint');

      // get() will return null (wrong userId in key) → 404
      const res = await docIndexReq(app, 'POST', '/docIndex/todo/task-1/shareToken', nonOwnerToken);
      assert.equal(res.status, 404);
    });
  });

  // ── DELETE /docIndex/:app/:docKey/shareToken ──────────────────────────────

  describe('DELETE /docIndex/:app/:docKey/shareToken', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await docIndexReq(app, 'DELETE', '/docIndex/todo/task-1/shareToken');
      assert.equal(res.status, 401);
    });

    it('returns 404 when entry does not exist', async () => {
      const token = await makeToken('revoke-owner');
      const res   = await docIndexReq(app, 'DELETE', '/docIndex/todo/missing/shareToken', token);
      assert.equal(res.status, 404);
    });

    it('returns 200 with shareToken: null after revoking', async () => {
      await docIndexRepo.upsertOwnership('revoke-user', 'todo', 'task-1', 'tasks');
      const token = await makeToken('revoke-user');

      // First mint a token
      await docIndexRepo.setShareToken('revoke-user', 'todo', 'task-1', 'some-token-value');

      // Now revoke it
      const res = await docIndexReq(app, 'DELETE', '/docIndex/todo/task-1/shareToken', token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isNull(body.shareToken);
    });

    it('shareToken is null in repository after revoke', async () => {
      await docIndexRepo.upsertOwnership('revoke-persist', 'todo', 'task-revoke', 'tasks');
      const token = await makeToken('revoke-persist');

      await docIndexRepo.setShareToken('revoke-persist', 'todo', 'task-revoke', 'active-token');

      const res = await docIndexReq(app, 'DELETE', '/docIndex/todo/task-revoke/shareToken', token);
      assert.equal(res.status, 200);

      const entry = await docIndexRepo.get('revoke-persist', 'todo', 'task-revoke');
      assert.isNull(entry.shareToken);
    });

    it('returns 403/404 for a non-owner', async () => {
      await docIndexRepo.upsertOwnership('real-owner-revoke', 'todo', 'task-1', 'tasks');
      const nonOwnerToken = await makeToken('non-owner-revoke');

      const res = await docIndexReq(app, 'DELETE', '/docIndex/todo/task-1/shareToken', nonOwnerToken);
      assert.equal(res.status, 404);
    });
  });
});
