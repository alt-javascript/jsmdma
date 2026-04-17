/**
 * AppSyncController.spec.js — Integration tests for AppSyncController
 *
 * Full CDI stack: AuthMiddlewareRegistrar → AppSyncController → AppSyncService
 *                  → SyncService → SyncRepository
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository,
  SyncService,
  AppSyncService,
  ApplicationRegistry,
  SchemaValidator,
  DocumentIndexRepository,
} from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar } from '@alt-javascript/jsmdma-auth-hono';
import {
  OrgRepository, OrgService, UserRepository,
} from '@alt-javascript/jsmdma-auth-server';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import AppSyncController from '../AppSyncController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-chars-long!!';

const APPLICATIONS_CONFIG = {
  todo:            {
    description: 'To-do lists',
    collections: {
      tasks: {
        schema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            done:  { type: 'boolean' },
          },
        },
      },
    },
  },
  'shopping-list': { description: 'Shopping lists' },
};

const BASE_CONFIG = {
  boot:         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  logging:      { level: { ROOT: 'error' } },
  server:       { port: 0 },
  auth:         { jwt: { secret: JWT_SECRET } },
  applications: APPLICATIONS_CONFIG,
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,      name: 'syncRepository',      scope: 'singleton' },
    { Reference: SyncService,         name: 'syncService',         scope: 'singleton' },
    { Reference: AppSyncService,      name: 'appSyncService',      scope: 'singleton' },
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: UserRepository,  name: 'userRepository',  scope: 'singleton' },
    { Reference: OrgRepository,   name: 'orgRepository',   scope: 'singleton' },
    { Reference: OrgService,      name: 'orgService',      scope: 'singleton' },
    // Auth middleware MUST come before AppSyncController
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function buildContextWithoutAppSyncService() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
    { Reference: OrgRepository,  name: 'orgRepository',  scope: 'singleton' },
    { Reference: OrgService,     name: 'orgService',     scope: 'singleton' },
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId = 'user-uuid', extra = {}) {
  return JwtSession.sign({ sub: userId, providers: ['github'], ...extra }, JWT_SECRET);
}

async function syncPost(app, application, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(`/${application}/sync`, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AppSyncController (CDI integration)', () => {
  let appCtx;
  let app;

  beforeEach(async () => {
    appCtx = await buildContext();
    app    = appCtx.get('honoAdapter').app;
  });

  // ── health ────────────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 { status: ok }', async () => {
      const res = await app.request('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    });
  });

  // ── old route removed ─────────────────────────────────────────────────────────

  describe('POST /sync (old route)', () => {
    it('returns 404 — old route has been removed', async () => {
      const token = await makeToken();
      const res   = await app.request('/sync', {
        method:  'POST',
        body:    JSON.stringify({ collection: 'items', clientClock: HLC.zero() }),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404);
    });
  });

  // ── service wiring ───────────────────────────────────────────────────────────

  describe('POST /:application/sync — service wiring', () => {
    it('returns 500 when appSyncService is not wired', async () => {
      const miswiredCtx = await buildContextWithoutAppSyncService();

      try {
        const miswiredApp = miswiredCtx.get('honoAdapter').app;
        const token = await makeToken();

        const res = await syncPost(miswiredApp, 'todo', {
          collection: 'tasks',
          clientClock: HLC.zero(),
          changes: [],
        }, token);

        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.error, 'Sync adapter is misconfigured');
      } finally {
        await miswiredCtx.stop?.();
      }
    });
  });

  // ── auth guard ────────────────────────────────────────────────────────────────

  describe('POST /:application/sync — auth', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      });
      assert.equal(res.status, 401);
    });

    it('returns 401 for an invalid token', async () => {
      const res = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      }, 'not-a-real-token');
      assert.equal(res.status, 401);
    });
  });

  // ── application allowlist ─────────────────────────────────────────────────────

  describe('POST /:application/sync — allowlist', () => {
    it('returns 404 for an unknown application', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'unknown-app', {
        collection:  'items',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.include(body.error, 'unknown-app');
    });

    it('accepts a known application (todo)', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);
      assert.equal(res.status, 200);
    });

    it('accepts a known application (shopping-list)', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'shopping-list', {
        collection:  'lists',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);
      assert.equal(res.status, 200);
    });
  });

  // ── user isolation ────────────────────────────────────────────────────────────

  describe('POST /:application/sync — user isolation', () => {
    it('user-A cannot see user-B documents through the API', async () => {
      const tokenA = await makeToken('user-A');
      const tokenB = await makeToken('user-B');
      const t1     = HLC.tick(HLC.zero(), Date.now());

      // user-A pushes a document
      await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key:       'task-private',
          doc:       { title: 'user-A private task' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, tokenA);

      // user-B pulls — should see nothing
      const res  = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      }, tokenB);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isEmpty(body.serverChanges, 'user-B must not see user-A documents');
    });

    it('same user sees their own documents across sync calls', async () => {
      const token = await makeToken('user-same');
      const t1    = HLC.tick(HLC.zero(), Date.now());

      await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key:       'my-task',
          doc:       { title: 'My personal task' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      const res  = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.lengthOf(body.serverChanges, 1);
      assert.equal(body.serverChanges[0].title, 'My personal task');
    });

    it('todo and shopping-list are isolated for the same user', async () => {
      const token = await makeToken('user-multi-app');
      const t1    = HLC.tick(HLC.zero(), Date.now());

      await syncPost(app, 'todo', {
        collection:  'items',
        clientClock: HLC.zero(),
        changes: [{
          key:       'item-1',
          doc:       { name: 'todo item' },
          fieldRevs: { name: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      const res = await syncPost(app, 'shopping-list', {
        collection:  'items',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isEmpty(body.serverChanges, 'shopping-list must not see todo documents');
    });
  });

  // ── response shape ────────────────────────────────────────────────────────────

  describe('POST /:application/sync — response shape', () => {
    it('returns serverClock, serverChanges, and conflicts on success', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes:     [],
      }, token);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'serverClock');
      assert.isString(body.serverClock);
      assert.isArray(body.serverChanges);
      assert.isArray(body.conflicts);
    });
  });

  // ── validation ────────────────────────────────────────────────────────────────

  describe('POST /:application/sync — body validation', () => {
    it('returns 400 when collection is missing', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'todo', { clientClock: HLC.zero() }, token);
      assert.equal(res.status, 400);
    });

    it('returns 400 when clientClock is missing', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'todo', { collection: 'tasks' }, token);
      assert.equal(res.status, 400);
    });
  });

  // ── schema validation ─────────────────────────────────────────────────────────

  describe('POST /:application/sync — schema validation', () => {
    it('returns 400 with schema error details for an invalid doc', async () => {
      const token = await makeToken();
      // todo/tasks requires 'title' (string) — sending a doc without it
      const res = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key:       'task-bad',
          doc:       { done: true },   // missing required 'title'
          fieldRevs: {},
          baseClock: HLC.zero(),
        }],
      }, token);

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'Schema validation failed');
      assert.isArray(body.details);
      assert.isNotEmpty(body.details);
      const fields = body.details.map((d) => d.field);
      assert.include(fields, 'title');
    });

    it('accepts a valid doc that passes schema', async () => {
      const token = await makeToken();
      const t1    = HLC.tick(HLC.zero(), Date.now());
      const res   = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key:       'task-good',
          doc:       { title: 'Buy milk', done: false },
          fieldRevs: { title: t1, done: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      assert.equal(res.status, 200);
    });

    it('no schema configured (shopping-list/lists) — always passes', async () => {
      const token = await makeToken();
      const t1    = HLC.tick(HLC.zero(), Date.now());
      const res   = await syncPost(app, 'shopping-list', {
        collection:  'lists',
        clientClock: HLC.zero(),
        changes: [{
          key:       'list-1',
          doc:       { whatever: 'no schema here' },
          fieldRevs: { whatever: t1 },
          baseClock: HLC.zero(),
        }],
      }, token);

      assert.equal(res.status, 200);
    });

    it('error details include the document key', async () => {
      const token = await makeToken();
      const res   = await syncPost(app, 'todo', {
        collection:  'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key:       'failing-key',
          doc:       {},
          fieldRevs: {},
          baseClock: HLC.zero(),
        }],
      }, token);

      assert.equal(res.status, 400);
      const body = await res.json();
      const keys = body.details.map((d) => d.key);
      assert.include(keys, 'failing-key');
    });
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('appSyncController.appSyncService is autowired', () => {
      const ctrl = appCtx.get('appSyncController');
      assert.instanceOf(ctrl.appSyncService, AppSyncService);
    });

    it('appSyncService.syncService is autowired', () => {
      const service = appCtx.get('appSyncService');
      assert.instanceOf(service.syncService, SyncService);
    });

    it('appSyncService application/schema dependencies are autowired', () => {
      const service = appCtx.get('appSyncService');
      assert.instanceOf(service.applicationRegistry, ApplicationRegistry);
      assert.instanceOf(service.schemaValidator, SchemaValidator);
    });
  });

  // ── org-scoped sync via x-org-id header ───────────────────────────────────

  describe('POST /:application/sync — x-org-id org-scoped sync', () => {

    // Helper: seed a user directly (avoids OAuth flow)
    async function seedUser(userId) {
      const userRepo = appCtx.get('userRepository');
      await userRepo._users().store(userId, {
        userId, email: `${userId}@test.com`, providers: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    // Helper: create org via OrgService and return orgId
    async function createOrg(creatorId, name) {
      const orgSvc = appCtx.get('orgService');
      const { org } = await orgSvc.createOrg(creatorId, name);
      return org.orgId;
    }

    // Helper: add member via OrgService
    async function addMember(adminId, orgId, userId) {
      const orgSvc = appCtx.get('orgService');
      await orgSvc.addMember(adminId, orgId, userId);
    }

    function orgSyncPost(application, body, token, orgId) {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      if (orgId) headers['x-org-id'] = orgId;
      return app.request(`/${application}/sync`, {
        method: 'POST', body: JSON.stringify(body), headers,
      });
    }

    it('non-member presenting x-org-id receives 403', async () => {
      await seedUser('alice');
      await seedUser('bob');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');
      const orgId      = await createOrg('alice', 'Test Org');
      // bob is not a member

      const res = await orgSyncPost('shopping-list', {
        collection: 'items', clientClock: HLC.zero(), changes: [],
      }, bobToken, orgId);

      assert.equal(res.status, 403);
    });

    it('member with x-org-id receives 200', async () => {
      await seedUser('alice');
      const token = await makeToken('alice');
      const orgId = await createOrg('alice', 'Test Org');

      const res = await orgSyncPost('shopping-list', {
        collection: 'items', clientClock: HLC.zero(), changes: [],
      }, token, orgId);

      assert.equal(res.status, 200);
    });

    it('two members of same org share documents via x-org-id', async () => {
      await seedUser('alice');
      await seedUser('bob');
      const aliceToken = await makeToken('alice');
      const bobToken   = await makeToken('bob');
      const orgId      = await createOrg('alice', 'Shared Org');
      await addMember('alice', orgId, 'bob');

      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes a shared doc to the org namespace
      await orgSyncPost('shopping-list', {
        collection: 'groceries',
        clientClock: HLC.zero(),
        changes: [{
          key: 'list-1',
          doc: { name: 'Weekend shop' },
          fieldRevs: { name: t1 },
          baseClock: HLC.zero(),
        }],
      }, aliceToken, orgId);

      // Bob pulls from the org namespace — should see Alice's doc
      const res  = await orgSyncPost('shopping-list', {
        collection: 'groceries', clientClock: HLC.zero(), changes: [],
      }, bobToken, orgId);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.lengthOf(body.serverChanges, 1, 'Bob should see the doc Alice pushed');
      assert.equal(body.serverChanges[0].name, 'Weekend shop');
    });

    it('org namespace is isolated from personal namespace', async () => {
      await seedUser('alice');
      const token = await makeToken('alice');
      const orgId = await createOrg('alice', 'Isolated Org');

      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes to org namespace
      await orgSyncPost('shopping-list', {
        collection: 'items',
        clientClock: HLC.zero(),
        changes: [{
          key: 'item-1', doc: { name: 'Org item' },
          fieldRevs: { name: t1 }, baseClock: HLC.zero(),
        }],
      }, token, orgId);

      // Alice pulls from personal namespace (no x-org-id) — should be empty
      const res = await syncPost(app, 'shopping-list', {
        collection: 'items', clientClock: HLC.zero(), changes: [],
      }, token);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isEmpty(body.serverChanges, 'personal namespace must not see org documents');
    });

    it('same org + different applications produce isolated namespaces', async () => {
      await seedUser('alice');
      const token = await makeToken('alice');
      const orgId = await createOrg('alice', 'Multi-App Org');

      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Push to /todo/sync with org header
      await orgSyncPost('todo', {
        collection: 'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key: 'task-1',
          doc: { title: 'Org todo task', done: false },
          fieldRevs: { title: t1, done: t1 },
          baseClock: HLC.zero(),
        }],
      }, token, orgId);

      // Pull from /shopping-list/sync with same org header — different app, different namespace
      const res = await orgSyncPost('shopping-list', {
        collection: 'tasks', clientClock: HLC.zero(), changes: [],
      }, token, orgId);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isEmpty(body.serverChanges, 'different applications must have isolated org namespaces');
    });

  });

});

// ── DocumentIndexRepository wiring ────────────────────────────────────────────
//
// A separate context that adds DocumentIndexRepository to the CDI registration
// so we can assert that upsertOwnership fires on sync writes.
//
// The existing suite above remains completely unmodified — it proves backward
// compatibility (AppSyncService works fine when documentIndexRepository is
// NOT wired because of the null-guard).

async function buildContextWithDocIndex() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,      name: 'syncRepository',      scope: 'singleton' },
    { Reference: SyncService,         name: 'syncService',         scope: 'singleton' },
    { Reference: AppSyncService,      name: 'appSyncService',      scope: 'singleton' },
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator,     name: 'schemaValidator',     scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: UserRepository,      name: 'userRepository',      scope: 'singleton' },
    { Reference: OrgRepository,       name: 'orgRepository',       scope: 'singleton' },
    { Reference: OrgService,          name: 'orgService',          scope: 'singleton' },
    // Auth middleware MUST come before AppSyncController
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    // DocumentIndexRepository registered BEFORE AppSyncController so CDI can autowire it
    { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
    { Reference: AppSyncController,   name: 'appSyncController',   scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

describe('AppSyncController — DocumentIndexRepository upsert on sync write', () => {
  let appCtx;
  let app;
  let docIndexRepo;

  beforeEach(async () => {
    appCtx      = await buildContextWithDocIndex();
    app         = appCtx.get('honoAdapter').app;
    docIndexRepo = appCtx.get('documentIndexRepository');
  });

  it('documentIndexRepository is autowired into appSyncService', () => {
    const service = appCtx.get('appSyncService');
    assert.instanceOf(service.documentIndexRepository, DocumentIndexRepository);
  });

  it('docIndex entry is created with visibility=private after a sync write', async () => {
    const token = await makeToken('owner-1');
    const t1    = HLC.tick(HLC.zero(), Date.now());

    const res = await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [{
        key:       'doc-abc',
        doc:       { name: 'My item' },
        fieldRevs: { name: t1 },
        baseClock: HLC.zero(),
      }],
    }, token);

    assert.equal(res.status, 200, 'sync should succeed');

    const entry = await docIndexRepo.get('owner-1', 'shopping-list', 'doc-abc');
    assert.isNotNull(entry, 'docIndex entry must exist after sync write');
    assert.equal(entry.userId,     'owner-1');
    assert.equal(entry.app,        'shopping-list');
    assert.equal(entry.docKey,     'doc-abc');
    assert.equal(entry.collection, 'items');
    assert.equal(entry.visibility, 'private');
    assert.deepEqual(entry.sharedWith, []);
    assert.isNull(entry.shareToken);
  });

  it('visibility is preserved (not reset to private) on a second sync write for the same docKey', async () => {
    const token = await makeToken('owner-2');
    const t1    = HLC.tick(HLC.zero(), Date.now());

    // First write — entry created with visibility=private
    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [{
        key:       'doc-preserve',
        doc:       { name: 'First version' },
        fieldRevs: { name: t1 },
        baseClock: HLC.zero(),
      }],
    }, token);

    // Manually promote visibility to 'shared'
    await docIndexRepo.setVisibility('owner-2', 'shopping-list', 'doc-preserve', 'shared');

    // Second write (update) — upsert must NOT reset visibility
    const t2 = HLC.tick(t1, Date.now());
    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [{
        key:       'doc-preserve',
        doc:       { name: 'Updated version' },
        fieldRevs: { name: t2 },
        baseClock: HLC.zero(),
      }],
    }, token);

    const entry = await docIndexRepo.get('owner-2', 'shopping-list', 'doc-preserve');
    assert.isNotNull(entry);
    assert.equal(entry.visibility, 'shared', 'visibility must not be reset to private on re-sync');
  });

  it('no docIndex entry is created when changes array is empty', async () => {
    const token = await makeToken('owner-3');

    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes:     [],
    }, token);

    // We cannot check a specific key because nothing was written — confirm count by
    // calling listByUser; it must return empty.
    const entries = await docIndexRepo.listByUser('owner-3', 'shopping-list');
    assert.isEmpty(entries, 'no docIndex entries when no changes are submitted');
  });

  it('multiple changes in one sync call each get a docIndex entry', async () => {
    const token = await makeToken('owner-4');
    const t1    = HLC.tick(HLC.zero(), Date.now());

    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [
        { key: 'multi-1', doc: { name: 'A' }, fieldRevs: { name: t1 }, baseClock: HLC.zero() },
        { key: 'multi-2', doc: { name: 'B' }, fieldRevs: { name: t1 }, baseClock: HLC.zero() },
        { key: 'multi-3', doc: { name: 'C' }, fieldRevs: { name: t1 }, baseClock: HLC.zero() },
      ],
    }, token);

    const entries = await docIndexRepo.listByUser('owner-4', 'shopping-list');
    assert.lengthOf(entries, 3, 'each change must produce a docIndex entry');
    const keys = entries.map((e) => e.docKey).sort();
    assert.deepEqual(keys, ['multi-1', 'multi-2', 'multi-3']);
  });
});

// ── DocumentIndexRepository ACL integration ───────────────────────────────────
//
// End-to-end ACL tests through the full HTTP stack.  The context wires
// DocumentIndexRepository so SyncService receives it via CDI and activates
// the ACL fan-out path.  Tests verify:
//   - Bob's sync does NOT return Alice's private doc (isolation)
//   - Bob's sync DOES return Alice's shared doc (fan-out)
//   - Alice's private doc is absent even when Bob's shared doc is present

describe('AppSyncController — DocumentIndexRepository ACL integration', () => {
  let appCtx;
  let app;
  let docIndexRepo;

  beforeEach(async () => {
    appCtx       = await buildContextWithDocIndex();
    app          = appCtx.get('honoAdapter').app;
    docIndexRepo = appCtx.get('documentIndexRepository');
  });

  it("Bob's sync does NOT return Alice's private doc", async () => {
    const aliceToken = await makeToken('alice-acl');
    const bobToken   = await makeToken('bob-acl');
    const t1         = HLC.tick(HLC.zero(), Date.now());

    // Alice pushes a private doc
    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [{
        key:       'alice-private',
        doc:       { name: 'Alice private item' },
        fieldRevs: { name: t1 },
        baseClock: HLC.zero(),
      }],
    }, aliceToken);

    // docIndex entry created with visibility=private — no further action

    // Bob syncs — must NOT see Alice's private doc
    const res  = await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes:     [],
    }, bobToken);

    assert.equal(res.status, 200);
    const body = await res.json();
    const keys = body.serverChanges.map((d) => d._key);
    assert.notInclude(keys, 'alice-private', "Bob must not see Alice's private doc");
    assert.isEmpty(body.serverChanges, 'Bob should see no docs at all');
  });

  it("Bob's sync returns Alice's shared doc when sharedWith Bob", async () => {
    const aliceToken = await makeToken('alice-acl2');
    const bobToken   = await makeToken('bob-acl2');
    const t1         = HLC.tick(HLC.zero(), Date.now());

    // Alice pushes a doc → docIndex entry is auto-created (private)
    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [{
        key:       'alice-shared',
        doc:       { name: 'Alice shared item' },
        fieldRevs: { name: t1 },
        baseClock: HLC.zero(),
      }],
    }, aliceToken);

    // Promote the docIndex entry to shared + grant Bob access
    await docIndexRepo.setVisibility('alice-acl2', 'shopping-list', 'alice-shared', 'shared');
    await docIndexRepo.addSharedWith('alice-acl2', 'shopping-list', 'alice-shared', 'bob-acl2', 'shopping-list');

    // Bob syncs — should receive Alice's shared doc via ACL fan-out
    const res  = await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes:     [],
    }, bobToken);

    assert.equal(res.status, 200);
    const body = await res.json();
    const keys = body.serverChanges.map((d) => d._key);
    assert.include(keys, 'alice-shared', "Bob must see Alice's shared doc");
    const sharedDoc = body.serverChanges.find((d) => d._key === 'alice-shared');
    assert.equal(sharedDoc.name, 'Alice shared item');
  });

  it("Alice's private doc is absent when a different doc is shared with Bob", async () => {
    const aliceToken = await makeToken('alice-acl3');
    const bobToken   = await makeToken('bob-acl3');
    const t1         = HLC.tick(HLC.zero(), Date.now());

    // Alice pushes two docs: one private, one shared
    await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes: [
        {
          key:       'alice-private3',
          doc:       { name: 'Alice private' },
          fieldRevs: { name: t1 },
          baseClock: HLC.zero(),
        },
        {
          key:       'alice-shared3',
          doc:       { name: 'Alice shared' },
          fieldRevs: { name: t1 },
          baseClock: HLC.zero(),
        },
      ],
    }, aliceToken);

    // Share only alice-shared3 with Bob
    await docIndexRepo.setVisibility('alice-acl3', 'shopping-list', 'alice-shared3', 'shared');
    await docIndexRepo.addSharedWith('alice-acl3', 'shopping-list', 'alice-shared3', 'bob-acl3', 'shopping-list');

    // Bob syncs — should see shared3 but NOT private3
    const res  = await syncPost(app, 'shopping-list', {
      collection:  'items',
      clientClock: HLC.zero(),
      changes:     [],
    }, bobToken);

    assert.equal(res.status, 200);
    const body = await res.json();
    const keys = body.serverChanges.map((d) => d._key);
    assert.include(keys,    'alice-shared3',  'Bob must see the shared doc');
    assert.notInclude(keys, 'alice-private3', 'Bob must NOT see the private doc');
    assert.lengthOf(body.serverChanges, 1, 'exactly one doc visible to Bob');
  });
});
