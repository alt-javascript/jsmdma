/**
 * ExportService.spec.js — Unit tests for ExportService
 *
 * Tests exportUser() and exportOrg() covering:
 *   - happy paths with data in one app + collection
 *   - storage key structure (personal vs. org-scoped)
 *   - pruning of empty apps/collections
 *   - docIndex contents
 *   - null / not-found cases
 *   - apps without collection config produce no entries
 *
 * Uses jsnosqlc-memory for a fully in-process test environment.
 * Direct CDI injection (no framework needed for unit tests).
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import { HLC } from '@alt-javascript/data-api-core';
import SyncRepository           from '../SyncRepository.js';
import DocumentIndexRepository  from '../DocumentIndexRepository.js';
import ApplicationRegistry      from '../ApplicationRegistry.js';
import ExportService            from '../ExportService.js';
// Auth-server packages sit in a sibling workspace
import UserRepository from '../../auth-server/UserRepository.js';
import OrgRepository  from '../../auth-server/OrgRepository.js';

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Build an ExportService wired to fresh in-memory repos.
 * appConfig: { [appName]: { collections: { [colName]: {} } } }
 */
async function buildService(appConfig = {}) {
  const client       = await DriverManager.getClient('jsnosqlc:memory:');
  const syncRepo     = new SyncRepository(client);
  const docIndexRepo = new DocumentIndexRepository(client);
  const userRepo     = new UserRepository(client);
  const orgRepo      = new OrgRepository(client);

  const appReg = new ApplicationRegistry();
  appReg.applications = appConfig;

  const svc = new ExportService();
  svc.syncRepository          = syncRepo;
  svc.documentIndexRepository = docIndexRepo;
  svc.userRepository          = userRepo;
  svc.orgRepository           = orgRepo;
  svc.applicationRegistry     = appReg;

  return { svc, syncRepo, docIndexRepo, userRepo, orgRepo };
}

/** Store a personal doc and register it in the docIndex. */
async function seedUserDoc(syncRepo, docIndexRepo, userId, app, col, key, doc) {
  const hlc     = HLC.tick(HLC.zero(), Date.now());
  const nsKey   = `${userId}:${app}:${col}`;
  await syncRepo.store(nsKey, key, doc, {}, hlc);
  await docIndexRepo.upsertOwnership(userId, app, key, col);
  return hlc;
}

/** Store an org-scoped doc. */
async function seedOrgDoc(syncRepo, orgId, app, col, key, doc) {
  const hlc   = HLC.tick(HLC.zero(), Date.now());
  const nsKey = `org:${orgId}:${app}:${col}`;
  await syncRepo.store(nsKey, key, doc, {}, hlc);
  return hlc;
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('ExportService', () => {

  // ── exportUser ─────────────────────────────────────────────────────────────

  describe('exportUser()', () => {

    it('returns { user, docs, docIndex } for user with data in one app+collection', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('alice', 'alice@example.com', 'local', 'alice');
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'doc-1',
        { title: 'Q1 plan' });

      const result = await svc.exportUser('alice');

      assert.isObject(result.user);
      assert.equal(result.user.userId, 'alice');
      assert.isObject(result.docs);
      assert.isArray(result.docs['year-planner']?.planners);
      assert.lengthOf(result.docs['year-planner'].planners, 1);
      assert.equal(result.docs['year-planner'].planners[0].title, 'Q1 plan');
      assert.isArray(result.docIndex);
      assert.isAbove(result.docIndex.length, 0);
    });

    it('docs are keyed by app then collection', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {}, notes: {} } },
      });

      await userRepo.create('alice', 'alice@example.com', 'local', 'alice');
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'p1',
        { title: 'Planner doc' });
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'notes', 'n1',
        { title: 'Note doc' });

      const { docs } = await svc.exportUser('alice');

      assert.property(docs, 'year-planner');
      assert.property(docs['year-planner'], 'planners');
      assert.property(docs['year-planner'], 'notes');
      assert.lengthOf(docs['year-planner'].planners, 1);
      assert.lengthOf(docs['year-planner'].notes, 1);
    });

    it('empty apps are omitted from the docs envelope', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
        'todo-app':     { collections: { tasks: {} } },
      });

      await userRepo.create('alice', 'alice@example.com', 'local', 'alice');
      // Only seed data in year-planner — todo-app stays empty
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'p1',
        { title: 'My plan' });

      const { docs } = await svc.exportUser('alice');

      assert.property(docs, 'year-planner', 'year-planner must be present');
      assert.notProperty(docs, 'todo-app',  'empty todo-app must be pruned');
    });

    it('docIndex contains all entries for the user', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('alice', 'alice@example.com', 'local', 'alice');
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'doc-1',
        { title: 'First' });
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'doc-2',
        { title: 'Second' });

      const { docIndex } = await svc.exportUser('alice');

      assert.lengthOf(docIndex, 2, 'docIndex must have one entry per seeded doc');
      const keys = docIndex.map((e) => e.docKey);
      assert.include(keys, 'doc-1');
      assert.include(keys, 'doc-2');
    });

    it('returns user:null, docs:{}, docIndex:[] when userId is not in userRepository', async () => {
      const { svc } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      const result = await svc.exportUser('nobody');

      assert.isNull(result.user);
      assert.deepEqual(result.docs, {});
      assert.deepEqual(result.docIndex, []);
    });

  });

  // ── exportOrg ──────────────────────────────────────────────────────────────

  describe('exportOrg()', () => {

    it('returns { org, members, docs } for org with data in one app+collection', async () => {
      const { svc, syncRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await orgRepo.createOrg('org-1', 'Test Org', 'carol');
      await orgRepo.createMember('org-1', 'carol', 'org-admin');
      await seedOrgDoc(syncRepo, 'org-1', 'year-planner', 'planners', 'org-doc-1',
        { title: 'Org Q1 plan' });

      const result = await svc.exportOrg('org-1');

      assert.isObject(result.org);
      assert.equal(result.org.orgId, 'org-1');
      assert.isArray(result.members);
      assert.lengthOf(result.members, 1);
      assert.equal(result.members[0].userId, 'carol');
      assert.isArray(result.docs['year-planner']?.planners);
      assert.lengthOf(result.docs['year-planner'].planners, 1);
      assert.equal(result.docs['year-planner'].planners[0].title, 'Org Q1 plan');
    });

    it("org-scoped storage key is 'org:{orgId}:{app}:{col}' (NOT namespaceKey)", async () => {
      const { svc, syncRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await orgRepo.createOrg('org-2', 'Key Test Org', 'carol');

      // Store using the raw org-scoped key — exportOrg must find it
      const hlc = HLC.tick(HLC.zero(), Date.now());
      await syncRepo.store('org:org-2:year-planner:planners', 'key-doc',
        { title: 'Key check' }, {}, hlc);

      const { docs } = await svc.exportOrg('org-2');

      assert.property(docs, 'year-planner');
      assert.lengthOf(docs['year-planner'].planners, 1);
      assert.equal(docs['year-planner'].planners[0].title, 'Key check');
    });

    it('empty apps are omitted from the docs envelope', async () => {
      const { svc, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
        'todo-app':     { collections: { tasks: {} } },
      });

      await orgRepo.createOrg('org-3', 'Sparse Org', 'carol');
      // No docs seeded at all

      const { docs } = await svc.exportOrg('org-3');

      assert.deepEqual(docs, {}, 'docs must be empty when no org docs exist');
    });

    it('members array contains all registered members', async () => {
      const { svc, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await orgRepo.createOrg('org-4', 'Multi Org', 'carol');
      await orgRepo.createMember('org-4', 'carol', 'org-admin');
      await orgRepo.createMember('org-4', 'bob',   'member');

      const { members } = await svc.exportOrg('org-4');

      assert.lengthOf(members, 2);
      const userIds = members.map((m) => m.userId);
      assert.include(userIds, 'carol');
      assert.include(userIds, 'bob');
    });

    it('returns org:null, members:[], docs:{} when orgId is not found', async () => {
      const { svc } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      const result = await svc.exportOrg('nonexistent-org');

      assert.isNull(result.org);
      assert.deepEqual(result.members, []);
      assert.deepEqual(result.docs, {});
    });

    it('apps without collections in config produce no entries in docs', async () => {
      const { svc, syncRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
        'no-col-app':   {}, // no collections key
      });

      await orgRepo.createOrg('org-5', 'No-col Org', 'carol');
      // Even if we stored something under the key, it must not appear because
      // the config has no collections to iterate
      const hlc = HLC.tick(HLC.zero(), Date.now());
      await syncRepo.store('org:org-5:no-col-app:things', 'x', { title: 'hidden' }, {}, hlc);

      const { docs } = await svc.exportOrg('org-5');

      assert.notProperty(docs, 'no-col-app',
        'app with no collections config must not appear in docs');
    });

  });

});
