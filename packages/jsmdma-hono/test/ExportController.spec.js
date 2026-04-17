/**
 * ExportController.spec.js — CDI integration tests for ExportController.
 *
 * Full CDI stack:
 *   AuthMiddlewareRegistrar → ExportController → ExportService
 *   → SyncRepository + DocumentIndexRepository + OrgRepository + UserRepository
 *
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 * Seeds data via AppSyncController (same syncPost helper as SearchController.spec.js).
 *
 * Test matrix:
 *   GET /account/export
 *     - 401 when no Authorization header
 *     - 200 returns envelope with user, docs, docIndex keys (EXP-01)
 *     - envelope.docs contains synced documents under correct app+collection
 *
 *   GET /orgs/:orgId/export
 *     - 401 when no Authorization header
 *     - 403 when caller is not org-admin (non-member)
 *     - 403 when caller is a regular member (not org-admin)
 *     - 404 when orgId does not exist
 *     - 200 returns envelope with org, members, docs keys (EXP-02)
 *     - envelope.docs contains org-scoped synced documents
 */
import { assert } from 'chai';
import { randomUUID } from 'crypto';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService, AppSyncService, ExportService,
  ApplicationRegistry, SchemaValidator, DocumentIndexRepository,
} from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar } from '@alt-javascript/jsmdma-auth-hono';
import { UserRepository, OrgRepository, OrgService } from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import AppSyncController from '../AppSyncController.js';
import ExportController  from '../ExportController.js';

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
 * Build a full CDI context with ExportController and AppSyncController.
 * CDI order: ExportService → AuthMiddlewareRegistrar → ExportController
 */
async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,          name: 'syncRepository',          scope: 'singleton' },
    { Reference: SyncService,             name: 'syncService',             scope: 'singleton' },
    { Reference: AppSyncService,          name: 'appSyncService',          scope: 'singleton' },
    { Reference: ExportService,           name: 'exportService',           scope: 'singleton' },
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
    // ExportController AFTER AuthMiddlewareRegistrar
    { Reference: ExportController,        name: 'exportController',        scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId = 'user-uuid', extra = {}) {
  return JwtSession.sign({ sub: userId, providers: ['github'], ...extra }, JWT_SECRET);
}

/** GET /account/export */
function exportUserGet(app, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request('/account/export', { method: 'GET', headers });
}

/** GET /orgs/:orgId/export */
function exportOrgGet(app, orgId, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(`/orgs/${orgId}/export`, { method: 'GET', headers });
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

describe('ExportController (CDI integration)', () => {
  let appCtx;
  let app;
  let orgRepository;

  beforeEach(async () => {
    appCtx        = await buildContext();
    app           = appCtx.get('honoAdapter').app;
    orgRepository = appCtx.get('orgRepository');
  });

  // ── GET /account/export — auth guard ──────────────────────────────────────

  describe('GET /account/export — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await exportUserGet(app, null);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── GET /account/export — happy path (EXP-01) ─────────────────────────────

  describe('GET /account/export — happy path', () => {
    it('returns 200 with user, docs, and docIndex keys in the envelope (EXP-01)', async () => {
      const userId = 'export-alice-01';
      const token  = await makeToken(userId);

      // Seed the user record so exportUser returns 200 (not 404)
      await appCtx.get('userRepository')._users().store(userId, { userId, email: null, providers: [] });

      const res = await exportUserGet(app, token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'user');
      assert.property(body, 'docs');
      assert.property(body, 'docIndex');
      assert.isObject(body.docs);
      assert.isArray(body.docIndex);
    });

    it('envelope.docs contains synced documents under correct app+collection', async () => {
      const userId = 'export-alice-docs';
      const token  = await makeToken(userId);
      const t1     = HLC.tick(HLC.zero(), Date.now());

      // Seed the user record so exportUser returns 200 (not 404)
      await appCtx.get('userRepository')._users().store(userId, { userId, email: null, providers: [] });

      // Seed a doc via AppSyncController
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'planner-alice-01',
          doc:       { title: 'Alice Year Planner' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      const res = await exportUserGet(app, token);
      assert.equal(res.status, 200);
      const body = await res.json();

      // docs['year-planner']['planners'] should contain the synced doc
      assert.property(body.docs, 'year-planner');
      assert.property(body.docs['year-planner'], 'planners');
      const planners = body.docs['year-planner']['planners'];
      assert.isArray(planners);
      assert.isAtLeast(planners.length, 1);
      const found = planners.find((d) => d._key === 'planner-alice-01');
      assert.ok(found, 'synced planner should appear in export');
      assert.equal(found.title, 'Alice Year Planner');

      // docIndex should contain an entry for the synced doc
      assert.isArray(body.docIndex);
      const indexEntry = body.docIndex.find((e) => e.docKey === 'planner-alice-01');
      assert.ok(indexEntry, 'docIndex should contain the synced doc');
    });
  });

  // ── GET /orgs/:orgId/export — auth guard ──────────────────────────────────

  describe('GET /orgs/:orgId/export — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await exportOrgGet(app, 'some-org-id', null);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── GET /orgs/:orgId/export — org-admin guard ─────────────────────────────

  describe('GET /orgs/:orgId/export — org-admin guard', () => {
    it('returns 403 when caller is not a member of the org', async () => {
      const adminId = 'export-admin-guard';
      const bobId   = 'export-bob-nonmember';
      const orgId   = randomUUID();
      const orgName = `Guard Org ${orgId}`;

      // Create org with admin as org-admin
      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId, 'org-admin');

      // Bob (non-member) tries to export
      const bobToken = await makeToken(bobId);
      const res      = await exportOrgGet(app, orgId, bobToken);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.property(body, 'error');
    });

    it('returns 403 when caller is a regular member but not org-admin', async () => {
      const adminId  = 'export-admin-role';
      const memberId = 'export-member-role';
      const orgId    = randomUUID();
      const orgName  = `Role Org ${orgId}`;

      // Create org and add Bob as a regular member
      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId,  'org-admin');
      await orgRepository.createMember(orgId, memberId, 'member');

      const memberToken = await makeToken(memberId);
      const res         = await exportOrgGet(app, orgId, memberToken);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── GET /orgs/:orgId/export — 404 ────────────────────────────────────────

  describe('GET /orgs/:orgId/export — 404', () => {
    it('returns 404 when orgId does not exist', async () => {
      const userId = 'export-ghost-user';
      const orgId  = 'does-not-exist-' + randomUUID();

      // Register caller as org-admin of the ghost org so we reach the service layer
      await orgRepository.createMember(orgId, userId, 'org-admin');

      const token = await makeToken(userId);
      const res   = await exportOrgGet(app, orgId, token);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.property(body, 'error');
    });
  });

  // ── GET /orgs/:orgId/export — happy path (EXP-02) ────────────────────────

  describe('GET /orgs/:orgId/export — happy path', () => {
    it('returns 200 with org, members, and docs keys in the envelope (EXP-02)', async () => {
      const adminId = 'export-carol-admin';
      const orgId   = randomUUID();
      const orgName = `Carol Org ${orgId}`;

      // Create org and add Carol as org-admin
      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId, 'org-admin');

      const token = await makeToken(adminId);
      const res   = await exportOrgGet(app, orgId, token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'org');
      assert.property(body, 'members');
      assert.property(body, 'docs');
      assert.isObject(body.docs);
      assert.isArray(body.members);
      assert.isAtLeast(body.members.length, 1);
      assert.equal(body.org.orgId, orgId);
    });

    it('envelope.docs contains org-scoped synced documents', async () => {
      const adminId = 'export-carol-docs';
      const orgId   = randomUUID();
      const orgName = `Carol Docs Org ${orgId}`;
      const t1      = HLC.tick(HLC.zero(), Date.now());

      // Create org and add Carol as org-admin
      await orgRepository.createOrg(orgId, orgName, adminId);
      await orgRepository.createMember(orgId, adminId, 'org-admin');

      const token = await makeToken(adminId);

      // Seed a doc to the org namespace
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'org-planner-01',
          doc:       { title: 'Org Year Planner' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, token, orgId);

      const res = await exportOrgGet(app, orgId, token);
      assert.equal(res.status, 200);
      const body = await res.json();

      // docs['year-planner']['planners'] should contain the org-scoped doc
      assert.property(body.docs, 'year-planner');
      assert.property(body.docs['year-planner'], 'planners');
      const planners = body.docs['year-planner']['planners'];
      assert.isArray(planners);
      assert.isAtLeast(planners.length, 1);
      const found = planners.find((d) => d._key === 'org-planner-01');
      assert.ok(found, 'org-scoped planner should appear in org export');
      assert.equal(found.title, 'Org Year Planner');
    });
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('exportController.exportService is autowired', () => {
      const ctrl = appCtx.get('exportController');
      assert.instanceOf(ctrl.exportService, ExportService);
    });

    it('exportController.orgRepository is autowired', () => {
      const ctrl = appCtx.get('exportController');
      assert.instanceOf(ctrl.orgRepository, OrgRepository);
    });
  });
});
