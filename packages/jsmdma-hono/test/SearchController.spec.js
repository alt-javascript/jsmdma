/**
 * SearchController.spec.js — CDI integration tests for SearchController
 *
 * Full CDI stack: AuthMiddlewareRegistrar → SearchController → SearchService
 *                 → SyncRepository + DocumentIndexRepository
 * Uses Hono's app.request() — no real HTTP server.
 * Uses JwtSession.sign() to mint test tokens.
 *
 * Test matrix covers:
 *   - 401 when no Authorization header
 *   - 401 for invalid/expired token
 *   - 404 for unknown application
 *   - 400 when collection absent from body
 *   - 400 when filter absent from body
 *   - 400 when filter is not an object with a type field
 *   - 200 with empty results for authenticated user with no docs (SRCH-01)
 *   - Bob's search does NOT return Alice's private doc (SRCH-02)
 *   - Bob's search DOES return Alice's public/shared doc (SRCH-02, SRCH-03)
 *   - Bob's search DOES return Alice's doc shared directly with Bob
 *   - Filter applied correctly — only matching docs returned (SRCH-01)
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository, SyncService, AppSyncService, SearchService,
  ApplicationRegistry, SchemaValidator, DocumentIndexRepository,
} from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar } from 'packages/jsmdma-auth-hono';
import { UserRepository, OrgRepository, OrgService } from 'packages/jsmdma-auth-server';
import { JwtSession } from 'packages/jsmdma-auth-core';
import { HLC } from 'packages/jsmdma-core';
import SearchController from '../SearchController.js';
import AppSyncController from '../AppSyncController.js';

// ── constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-at-least-32-chars-long!!';

const APPLICATIONS_CONFIG = {
  'year-planner': { description: 'Year-planning app' },
  todo:           { description: 'To-do lists' },
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
 * Build a full CDI context with both SearchController and AppSyncController
 * (AppSyncController allows us to write test data via the sync endpoint).
 */
async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,          name: 'syncRepository',          scope: 'singleton' },
    { Reference: SyncService,             name: 'syncService',             scope: 'singleton' },
    { Reference: AppSyncService,          name: 'appSyncService',          scope: 'singleton' },
    { Reference: SearchService,           name: 'searchService',           scope: 'singleton' },
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
    { Reference: AppSyncController,   name: 'appSyncController',   scope: 'singleton' },
    // SearchController AFTER AuthMiddlewareRegistrar
    { Reference: SearchController,    name: 'searchController',    scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function makeToken(userId = 'user-uuid', extra = {}) {
  return JwtSession.sign({ sub: userId, providers: ['github'], ...extra }, JWT_SECRET);
}

/** POST /:application/search */
function searchPost(app, application, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return app.request(`/${application}/search`, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers,
  });
}

/** POST /:application/sync — used to seed documents */
function syncPost(app, application, body, token) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  return app.request(`/${application}/sync`, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers,
  });
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('SearchController (CDI integration)', () => {
  let appCtx;
  let app;
  let docIndexRepo;

  beforeEach(async () => {
    appCtx       = await buildContext();
    app          = appCtx.get('honoAdapter').app;
    docIndexRepo = appCtx.get('documentIndexRepository');
  });

  // ── auth guard ────────────────────────────────────────────────────────────────

  describe('POST /:application/search — auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'meta.title', op: 'contains', value: 'Plan' },
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.property(body, 'error');
    });

    it('returns 401 for an invalid/expired token', async () => {
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'meta.title', op: 'contains', value: 'Plan' },
      }, 'not-a-real-token');
      assert.equal(res.status, 401);
    });
  });

  // ── application allowlist ─────────────────────────────────────────────────────

  describe('POST /:application/search — allowlist', () => {
    it('returns 404 for an unknown application', async () => {
      const token = await makeToken();
      const res = await searchPost(app, 'unknown-app', {
        collection: 'items',
        filter: { type: 'condition', field: 'name', op: 'contains', value: 'x' },
      }, token);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.include(body.error, 'unknown-app');
    });
  });

  // ── body validation ───────────────────────────────────────────────────────────

  describe('POST /:application/search — body validation', () => {
    it('returns 400 when collection is absent', async () => {
      const token = await makeToken();
      const res = await searchPost(app, 'year-planner', {
        filter: { type: 'condition', field: 'name', op: 'contains', value: 'x' },
      }, token);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'collection');
    });

    it('returns 400 when filter is absent', async () => {
      const token = await makeToken();
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
      }, token);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'filter');
    });

    it('returns 400 when filter is not an object', async () => {
      const token = await makeToken();
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: 'not-an-object',
      }, token);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'filter');
    });

    it('returns 400 when filter has no type field', async () => {
      const token = await makeToken();
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { field: 'name', op: 'contains', value: 'x' },
      }, token);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.include(body.error, 'filter');
    });
  });

  // ── basic search ──────────────────────────────────────────────────────────────

  describe('POST /:application/search — basic results', () => {
    it('returns 200 with empty results for authenticated user with no docs', async () => {
      const token = await makeToken('user-empty');
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'meta.title', op: 'contains', value: 'Plan' },
      }, token);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'results');
      assert.isArray(body.results);
      assert.isEmpty(body.results);
    });

    it('filter applied correctly — only docs matching the filter are returned (SRCH-01)', async () => {
      const token = await makeToken('user-filter');
      const t1    = HLC.tick(HLC.zero(), Date.now());

      // Seed two docs: one matching, one not
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [
          {
            key:       'planner-match',
            doc:       { title: 'My Planner', active: true },
            fieldRevs: { title: t1, active: t1 },
            baseClock: HLC.zero(),
          },
          {
            key:       'planner-nomatch',
            doc:       { title: 'Something Else', active: false },
            fieldRevs: { title: t1, active: t1 },
            baseClock: HLC.zero(),
          },
        ],
      }, token);

      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'title', op: 'contains', value: 'Planner' },
      }, token);

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.isArray(body.results);
      assert.lengthOf(body.results, 1);
      assert.equal(body.results[0].title, 'My Planner');
    });
  });

  // ── ACL scoping (SRCH-02, SRCH-03) ───────────────────────────────────────────

  describe('POST /:application/search — ACL scoping', () => {
    it("Bob's search does NOT return Alice's private doc (SRCH-02)", async () => {
      const aliceToken = await makeToken('alice-search');
      const bobToken   = await makeToken('bob-search');
      const t1         = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes a private planner
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'alice-private-planner',
          doc:       { title: 'Alice Private Planner' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, aliceToken);

      // docIndex entry created with visibility=private by default — no further action

      // Bob searches — must NOT see Alice's private doc
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'title', op: 'contains', value: 'Planner' },
      }, bobToken);

      assert.equal(res.status, 200);
      const body = await res.json();
      const keys = body.results.map((d) => d._key);
      assert.notInclude(keys, 'alice-private-planner', "Bob must not see Alice's private planner");
      assert.isEmpty(body.results, 'Bob should see no results');
    });

    it("Bob's search DOES return Alice's public planner (SRCH-02, SRCH-03)", async () => {
      const aliceToken = await makeToken('alice-public');
      const bobToken   = await makeToken('bob-public');
      const t1         = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes a planner
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'alice-public-planner',
          doc:       { title: 'Alice Public Planner' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, aliceToken);

      // Set the doc to public visibility
      await docIndexRepo.setVisibility('alice-public', 'year-planner', 'alice-public-planner', 'public');

      // Bob searches — must see Alice's public doc
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'title', op: 'contains', value: 'Planner' },
      }, bobToken);

      assert.equal(res.status, 200);
      const body = await res.json();
      const keys = body.results.map((d) => d._key);
      assert.include(keys, 'alice-public-planner', "Bob must see Alice's public planner");
      const found = body.results.find((d) => d._key === 'alice-public-planner');
      assert.equal(found.title, 'Alice Public Planner');
    });

    it("Bob's search DOES return Alice's planner shared directly with Bob", async () => {
      const aliceToken = await makeToken('alice-shared');
      const bobToken   = await makeToken('bob-shared');
      const t1         = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes a planner
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [{
          key:       'alice-shared-planner',
          doc:       { title: 'Alice Shared Planner' },
          fieldRevs: { title: t1 },
          baseClock: HLC.zero(),
        }],
      }, aliceToken);

      // Share the doc with Bob
      await docIndexRepo.setVisibility('alice-shared', 'year-planner', 'alice-shared-planner', 'shared');
      await docIndexRepo.addSharedWith('alice-shared', 'year-planner', 'alice-shared-planner', 'bob-shared', 'year-planner');

      // Bob searches — must see Alice's shared planner
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'title', op: 'contains', value: 'Planner' },
      }, bobToken);

      assert.equal(res.status, 200);
      const body = await res.json();
      const keys = body.results.map((d) => d._key);
      assert.include(keys, 'alice-shared-planner', "Bob must see Alice's shared planner");
    });

    it("Alice's private doc is NOT returned even when a different doc is shared with Bob", async () => {
      const aliceToken = await makeToken('alice-mix');
      const bobToken   = await makeToken('bob-mix');
      const t1         = HLC.tick(HLC.zero(), Date.now());

      // Alice pushes two planners: one private, one shared
      await syncPost(app, 'year-planner', {
        collection:  'planners',
        clientClock: HLC.zero(),
        changes: [
          {
            key:       'alice-private-mix',
            doc:       { title: 'Alice Private Mix Planner' },
            fieldRevs: { title: t1 },
            baseClock: HLC.zero(),
          },
          {
            key:       'alice-shared-mix',
            doc:       { title: 'Alice Shared Mix Planner' },
            fieldRevs: { title: t1 },
            baseClock: HLC.zero(),
          },
        ],
      }, aliceToken);

      // Only share the second planner with Bob
      await docIndexRepo.setVisibility('alice-mix', 'year-planner', 'alice-shared-mix', 'shared');
      await docIndexRepo.addSharedWith('alice-mix', 'year-planner', 'alice-shared-mix', 'bob-mix', 'year-planner');

      // Bob searches
      const res = await searchPost(app, 'year-planner', {
        collection: 'planners',
        filter: { type: 'condition', field: 'title', op: 'contains', value: 'Planner' },
      }, bobToken);

      assert.equal(res.status, 200);
      const body = await res.json();
      const keys = body.results.map((d) => d._key);
      assert.include(keys,    'alice-shared-mix',  'Bob must see the shared planner');
      assert.notInclude(keys, 'alice-private-mix', 'Bob must NOT see the private planner');
      assert.lengthOf(body.results, 1, 'exactly one result visible to Bob');
    });
  });

  // ── CDI wiring ────────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('searchController.searchService is autowired', () => {
      const ctrl = appCtx.get('searchController');
      assert.instanceOf(ctrl.searchService, SearchService);
    });

    it('searchController.applicationRegistry is autowired', () => {
      const ctrl = appCtx.get('searchController');
      assert.instanceOf(ctrl.applicationRegistry, ApplicationRegistry);
    });
  });
});
