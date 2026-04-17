/**
 * DeletionService.spec.js — Unit tests for DeletionService
 *
 * Tests deleteUser() and deleteOrg() covering:
 *   - docs, docIndex, and user record removed on deleteUser
 *   - no-op when user has no docs (empty loop)
 *   - org memberships removed on deleteUser
 *   - works correctly across multiple apps
 *   - org docs, members, name reservation, and org record removed on deleteOrg
 *   - idempotent when org already gone (no throw)
 *   - all members removed by deleteOrg
 *
 * Uses jsnosqlc-memory for a fully in-process test environment.
 * Direct CDI injection (no framework needed for unit tests).
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import { HLC } from 'packages/jsmdma-core';
import SyncRepository           from '../SyncRepository.js';
import DocumentIndexRepository  from '../DocumentIndexRepository.js';
import ApplicationRegistry      from '../ApplicationRegistry.js';
import DeletionService          from '../DeletionService.js';
import UserRepository  from '../../jsmdma-auth-server/UserRepository.js';
import OrgRepository   from '../../jsmdma-auth-server/OrgRepository.js';

// ── helpers ────────────────────────────────────────────────────────────────────

async function buildService(appConfig = {}) {
  const client       = await DriverManager.getClient('jsnosqlc:memory:');
  const syncRepo     = new SyncRepository(client);
  const docIndexRepo = new DocumentIndexRepository(client);
  const userRepo     = new UserRepository(client);
  const orgRepo      = new OrgRepository(client);

  const appReg = new ApplicationRegistry();
  appReg.applications = appConfig;

  const svc = new DeletionService();
  svc.syncRepository          = syncRepo;
  svc.documentIndexRepository = docIndexRepo;
  svc.userRepository          = userRepo;
  svc.orgRepository           = orgRepo;
  svc.applicationRegistry     = appReg;

  return { svc, syncRepo, docIndexRepo, userRepo, orgRepo, appReg };
}

/** Store a personal doc and register it in the docIndex. */
async function seedUserDoc(syncRepo, docIndexRepo, userId, app, col, key, doc) {
  const hlc   = HLC.tick(HLC.zero(), Date.now());
  const nsKey = `${userId}:${app}:${col}`;
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

describe('DeletionService', () => {

  // ── deleteUser ─────────────────────────────────────────────────────────────

  describe('deleteUser()', () => {

    it('removes docs, docIndex entries, and user record', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('alice', 'alice@example.com', 'local', 'alice-pid');
      await seedUserDoc(syncRepo, docIndexRepo, 'alice', 'year-planner', 'planners', 'doc-1',
        { title: 'My plan' });

      await svc.deleteUser('alice');

      // User record gone
      const user = await userRepo.getUser('alice');
      assert.isNull(user, 'user record should be deleted');

      // Doc gone
      const docs = await syncRepo.changesSince('alice:year-planner:planners', HLC.zero());
      assert.lengthOf(docs, 0, 'synced docs should be deleted');

      // docIndex entries gone
      const entries = await docIndexRepo.listByUser('alice', 'year-planner');
      assert.lengthOf(entries, 0, 'docIndex entries should be deleted');
    });

    it('is a no-op when user has no docs (empty docIndex loop)', async () => {
      const { svc, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('bob', 'bob@example.com', 'local', 'bob-pid');

      // Should not throw even with no docs
      await svc.deleteUser('bob');

      const user = await userRepo.getUser('bob');
      assert.isNull(user, 'user record should be deleted even with no docs');
    });

    it('removes org memberships for the deleted user', async () => {
      const { svc, userRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('carol', 'carol@example.com', 'local', 'carol-pid');
      await orgRepo.createOrg('org-1', 'Carol Org', 'carol');
      await orgRepo.createMember('org-1', 'carol', 'org-admin');

      await svc.deleteUser('carol');

      const member = await orgRepo.getMember('org-1', 'carol');
      assert.isNull(member, 'org membership should be removed');
    });

    it('works across multiple apps — docs in all apps are deleted', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
        'todo':         { collections: { tasks: {}   } },
      });

      await userRepo.create('dave', 'dave@example.com', 'local', 'dave-pid');
      await seedUserDoc(syncRepo, docIndexRepo, 'dave', 'year-planner', 'planners', 'p1',
        { title: 'Plan' });
      await seedUserDoc(syncRepo, docIndexRepo, 'dave', 'todo', 'tasks', 't1',
        { title: 'Task' });

      await svc.deleteUser('dave');

      const plannerDocs = await syncRepo.changesSince('dave:year-planner:planners', HLC.zero());
      const taskDocs    = await syncRepo.changesSince('dave:todo:tasks', HLC.zero());
      assert.lengthOf(plannerDocs, 0, 'year-planner docs should be deleted');
      assert.lengthOf(taskDocs,    0, 'todo docs should be deleted');

      const plannerIdx = await docIndexRepo.listByUser('dave', 'year-planner');
      const todoIdx    = await docIndexRepo.listByUser('dave', 'todo');
      assert.lengthOf(plannerIdx, 0, 'year-planner docIndex entries should be deleted');
      assert.lengthOf(todoIdx,    0, 'todo docIndex entries should be deleted');
    });

    it('removes multiple docs in the same collection', async () => {
      const { svc, syncRepo, docIndexRepo, userRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await userRepo.create('eve', 'eve@example.com', 'local', 'eve-pid');
      await seedUserDoc(syncRepo, docIndexRepo, 'eve', 'year-planner', 'planners', 'p1',
        { title: 'Jan' });
      await seedUserDoc(syncRepo, docIndexRepo, 'eve', 'year-planner', 'planners', 'p2',
        { title: 'Feb' });

      await svc.deleteUser('eve');

      const docs = await syncRepo.changesSince('eve:year-planner:planners', HLC.zero());
      assert.lengthOf(docs, 0, 'all docs should be deleted');
    });

  });

  // ── deleteOrg ──────────────────────────────────────────────────────────────

  describe('deleteOrg()', () => {

    it('removes org docs, all members, name reservation, and org record', async () => {
      const { svc, syncRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await orgRepo.createOrg('org-a', 'Alpha Org', 'admin-1');
      await orgRepo.reserveName('Alpha Org', 'org-a');
      await orgRepo.createMember('org-a', 'admin-1', 'org-admin');
      await seedOrgDoc(syncRepo, 'org-a', 'year-planner', 'planners', 'org-doc-1',
        { title: 'Org plan' });

      await svc.deleteOrg('org-a');

      // Org record gone
      const org = await orgRepo.getOrg('org-a');
      assert.isNull(org, 'org record should be deleted');

      // Member gone
      const member = await orgRepo.getMember('org-a', 'admin-1');
      assert.isNull(member, 'member should be removed');

      // Name reservation gone
      const nameExists = await orgRepo.nameExists('Alpha Org');
      assert.isFalse(nameExists, 'org name reservation should be released');

      // Org docs gone
      const docs = await syncRepo.changesSince('org:org-a:year-planner:planners', HLC.zero());
      assert.lengthOf(docs, 0, 'org docs should be deleted');
    });

    it('is idempotent when org already gone — no throw', async () => {
      const { svc } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      // Should not throw even when org never existed
      await svc.deleteOrg('nonexistent-org');
    });

    it('removes all members including multiple members', async () => {
      const { svc, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {} } },
      });

      await orgRepo.createOrg('org-b', 'Beta Org', 'admin-2');
      await orgRepo.createMember('org-b', 'admin-2', 'org-admin');
      await orgRepo.createMember('org-b', 'user-2',  'member');
      await orgRepo.createMember('org-b', 'user-3',  'member');

      await svc.deleteOrg('org-b');

      const m1 = await orgRepo.getMember('org-b', 'admin-2');
      const m2 = await orgRepo.getMember('org-b', 'user-2');
      const m3 = await orgRepo.getMember('org-b', 'user-3');
      assert.isNull(m1, 'admin member should be removed');
      assert.isNull(m2, 'member user-2 should be removed');
      assert.isNull(m3, 'member user-3 should be removed');
    });

    it('removes org docs across multiple apps and collections', async () => {
      const { svc, syncRepo, orgRepo } = await buildService({
        'year-planner': { collections: { planners: {}, notes: {} } },
        'todo':         { collections: { tasks: {} } },
      });

      await orgRepo.createOrg('org-c', 'Multi-app Org', 'admin-3');
      await seedOrgDoc(syncRepo, 'org-c', 'year-planner', 'planners', 'p1', { title: 'Planner' });
      await seedOrgDoc(syncRepo, 'org-c', 'year-planner', 'notes',    'n1', { title: 'Note'    });
      await seedOrgDoc(syncRepo, 'org-c', 'todo',         'tasks',    't1', { title: 'Task'    });

      await svc.deleteOrg('org-c');

      const plannerDocs = await syncRepo.changesSince('org:org-c:year-planner:planners', HLC.zero());
      const noteDocs    = await syncRepo.changesSince('org:org-c:year-planner:notes',    HLC.zero());
      const taskDocs    = await syncRepo.changesSince('org:org-c:todo:tasks',            HLC.zero());
      assert.lengthOf(plannerDocs, 0, 'planner docs should be deleted');
      assert.lengthOf(noteDocs,    0, 'note docs should be deleted');
      assert.lengthOf(taskDocs,    0, 'task docs should be deleted');
    });

  });

});
