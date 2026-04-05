/**
 * DeletionController.spec.js — CDI integration tests for DeletionController.
 *
 * Full CDI stack:
 *   AuthMiddlewareRegistrar → DeletionController → DeletionService
 *   → SyncRepository + DocumentIndexRepository + OrgRepository + UserRepository
 *
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 * Seeds data via AppSyncController (same syncPost helper as other specs).
 *
 * Test matrix:
 *   DELETE /account
 *     - 401 when no Authorization header
 *     - 204 on success; userRepository.getUser returns null afterwards
 *     - synced docs gone after user delete
 *
 *   DELETE /orgs/:orgId
 *     - 401 when no Authorization header
 *     - 404 for unknown orgId
 *     - 403 for non-admin caller
 *     - 204 on success; orgRepository.getOrg returns null afterwards
 *     - org-scoped docs gone after org delete
 *
 *   CDI wiring
 *     - deletionController.deletionService is autowired
 *     - deletionController.orgRepository is autowired
 */
import { assert } from 'chai';
import { randomUUID } from 'crypto';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService, ExportService,
  ApplicationRegistry, SchemaValidator, DocumentIndexRepository,
  DeletionService,
} from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar } from '@alt-javascript/jsmdma-auth-hono';
import { UserRepository, OrgRepository, OrgService } from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import AppSyncController    from '../AppSyncController.js';
import DeletionController   from '../DeletionController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-chars-long!!';

const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year-planning app',
    collections:  { planners: {} },
  },
  todo: { description: 'To-do lists', collections: { todos: {} } },
};

const BASE_CONFIG = {
  boot:         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging:      { level: { ROOT: 'error' } },
  server:       { port: 0 },
  auth:         { jwt: { secret: JWT_SECRET } },
  applications: APPLICATIONS_CONFIG,
};

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a full CDI context with DeletionController, DeletionService, and AppSyncController.
 * CDI order: DeletionService → AuthMiddlewareRegistrar → AppSyncController → DeletionController
 */
async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,          name: 'syncRepository',          scope: 'singleton' },
    { Reference: SyncService,             name: 'syncService',             scope: 'singleton' },
    { Reference: ExportService,           name: 'exportService',           scope: 'singleton' },
    { Reference: DeletionService,         name: 'deletionService',         scope: 'singleton' },
    { Reference: ApplicationRegistry,     name: 'applicationRegistry',     scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator,         name: 'schemaValidator',         scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: UserRepository,          name: 'userRepository',          scope: 'singleton' },
    { Reference: OrgRepository,           name: 'orgRepository',           scope: 'singleton' },
    { Reference: OrgService,              name: 'orgService',              scope: 'singleton' },
    { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
    // Auth middleware MUST come before controllers
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    // AppSyncController for seeding test data via HTTP
    { Reference: AppSyncController,       name: 'appSyncController',       scope: 'singleton' },
    // DeletionController AFTER AuthMiddlewareRegistrar
    { Reference: DeletionController,      name: 'deletionController',      scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId = 'user-uuid', extra = {}) {
  return JwtSession.sign({ sub: userId, providers: ['github'], ...extra }, JWT_SECRET);
}

/** DELETE /account */
async function deleteAccountReq(app, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request('/account', { method: 'DELETE', headers });
}

/** DELETE /orgs/:orgId */
async function deleteOrgReq(app, orgId, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(`/orgs/${orgId}`, { method: 'DELETE', headers });
}

/** POST /:application/sync — used to seed documents */
function syncPost(app, application, body, token, orgId) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (orgId) headers['x-org-id'] = orgId;
  return app.request(`/${application}/sync`, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers,
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('DeletionController (CDI integration)', () => {
  let appCtx;
  let app;
  let userRepository;
  let orgRepository;

  beforeEach(async () => {
    appCtx         = await buildContext();
    app            = appCtx.get('honoAdapter').app;
    userRepository = appCtx.get('userRepository');
    orgRepository  = appCtx.get('orgRepository');
  });

  // ── DELETE /account — auth guard ──────────────────────────────────────────

  describe('DELETE /account — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await deleteAccountReq(app, null);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── DELETE /account — happy path ──────────────────────────────────────────

  describe('DELETE /account — happy path', () => {
    it('returns 204 and user record is gone after delete', async () => {
      const userId = 'del-alice-01';
      const token  = await makeToken(userId);

      // Seed the user record
      await userRepository._users().store(userId, { userId, email: null, providers: [] });

      const res = await deleteAccountReq(app, token);
      assert.equal(res.status, 204);

      const user = await userRepository.getUser(userId);
      assert.isNull(user, 'user record should be gone after DELETE /account');
    });

    it('synced docs are gone after DELETE /account', async () => {
      const userId = 'del-alice-docs';
      const token  = await makeToken(userId);
      const t1     = HLC.tick(HLC.zero(), Date.now());

      // Seed user and a doc via AppSyncController
      await userRepository._users().store(userId, { userId, email: null, providers: [] });
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'del-planner-01',
          doc:       { title: 'Alice Plan' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      const res = await deleteAccountReq(app, token);
      assert.equal(res.status, 204);

      const syncRepo = appCtx.get('syncRepository');
      const docs = await syncRepo.changesSince(`${userId}:year-planner:planners`, HLC.zero());
      assert.lengthOf(docs, 0, 'synced docs should be gone after delete');
    });
  });

  // ── DELETE /orgs/:orgId — auth guard ──────────────────────────────────────

  describe('DELETE /orgs/:orgId — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await deleteOrgReq(app, 'some-org-id', null);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── DELETE /orgs/:orgId — guards ──────────────────────────────────────────

  describe('DELETE /orgs/:orgId — guards', () => {
    it('returns 404 for unknown orgId', async () => {
      const userId = 'del-ghost-user';
      const orgId  = 'ghost-org-' + randomUUID();
      const token  = await makeToken(userId);

      const res = await deleteOrgReq(app, orgId, token);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.property(body, 'error');
    });

    it('returns 403 when caller is not org-admin', async () => {
      const adminId  = 'del-admin-guard';
      const memberId = 'del-member-guard';
      const orgId    = randomUUID();
      const orgName  = `Guard Del Org ${orgId}`;

      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId,  'org-admin');
      await orgRepository.createMember(orgId, memberId, 'member');

      const memberToken = await makeToken(memberId);
      const res         = await deleteOrgReq(app, orgId, memberToken);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── DELETE /orgs/:orgId — happy path ──────────────────────────────────────

  describe('DELETE /orgs/:orgId — happy path', () => {
    it('returns 204 and org record is gone after delete', async () => {
      const adminId = 'del-carol-01';
      const orgId   = randomUUID();
      const orgName = `Delete Test Org ${orgId}`;

      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId, 'org-admin');

      const token = await makeToken(adminId);
      const res   = await deleteOrgReq(app, orgId, token);
      assert.equal(res.status, 204);

      const org = await orgRepository.getOrg(orgId);
      assert.isNull(org, 'org record should be gone after DELETE /orgs/:orgId');
    });

    it('org-scoped docs are gone after DELETE /orgs/:orgId', async () => {
      const adminId = 'del-carol-docs';
      const orgId   = randomUUID();
      const orgName = `Del Docs Org ${orgId}`;
      const t1      = HLC.tick(HLC.zero(), Date.now());

      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId, 'org-admin');

      const token = await makeToken(adminId);

      // Seed an org-scoped doc via AppSyncController
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'org-del-planner-01',
          doc:       { title: 'Org Plan' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, token, orgId);

      const res = await deleteOrgReq(app, orgId, token);
      assert.equal(res.status, 204);

      const syncRepo = appCtx.get('syncRepository');
      const docs = await syncRepo.changesSince(`org:${orgId}:year-planner:planners`, HLC.zero());
      assert.lengthOf(docs, 0, 'org-scoped docs should be gone after delete');
    });
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('deletionController.deletionService is autowired', () => {
      const ctrl = appCtx.get('deletionController');
      assert.instanceOf(ctrl.deletionService, DeletionService);
    });

    it('deletionController.orgRepository is autowired', () => {
      const ctrl = appCtx.get('deletionController');
      assert.instanceOf(ctrl.orgRepository, OrgRepository);
    });
  });
});
