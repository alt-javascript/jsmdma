/**
 * AppSyncController.spec.js — Integration tests for AppSyncController
 *
 * Full CDI stack: AuthMiddlewareRegistrar → AppSyncController → SyncService → SyncRepository
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { SyncRepository, SyncService, ApplicationRegistry, SchemaValidator } from '@alt-javascript/data-api-server';
import { AuthMiddlewareRegistrar } from '@alt-javascript/data-api-auth-hono';
import { JwtSession } from '@alt-javascript/data-api-auth-core';
import { HLC } from '@alt-javascript/data-api-core';
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
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
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
    it('appSyncController.syncService is autowired', () => {
      const ctrl = appCtx.get('appSyncController');
      assert.instanceOf(ctrl.syncService, SyncService);
    });

    it('appSyncController.applicationRegistry is set', () => {
      const ctrl = appCtx.get('appSyncController');
      assert.instanceOf(ctrl.applicationRegistry, ApplicationRegistry);
    });

    it('appSyncController.schemaValidator is set', () => {
      const ctrl = appCtx.get('appSyncController');
      assert.instanceOf(ctrl.schemaValidator, SchemaValidator);
    });
  });

});
