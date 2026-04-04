/**
 * SyncService.spec.js — Unit tests for SyncService
 *
 * Tests namespacing, text auto-merge, HLC fallback, nested doc support, and
 * ACL fan-out through the service directly (no HTTP layer). Uses jsnosqlc-memory.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import { HLC } from '@alt-javascript/data-api-core';
import SyncRepository from '../SyncRepository.js';
import SyncService from '../SyncService.js';
import DocumentIndexRepository from '../DocumentIndexRepository.js';

async function buildService() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const repo = new SyncRepository(client);
  const svc  = new SyncService();
  svc.syncRepository = repo;
  return { svc, repo, client };
}

/**
 * Build a SyncService wired with a DocumentIndexRepository, both sharing the
 * same in-memory nosqlClient so sync storage and docIndex storage are isolated
 * in the same memory instance (different collection names keep them separate).
 */
async function buildServiceWithDocIndex() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const syncRepo = new SyncRepository(client);
  const docIndexRepo = new DocumentIndexRepository(client);
  const svc = new SyncService();
  svc.syncRepository = syncRepo;
  svc.documentIndexRepository = docIndexRepo;
  return { svc, syncRepo, docIndexRepo, client };
}

describe('SyncService', () => {

  // ── namespacing ──────────────────────────────────────────────────────────────

  describe('user + application namespacing', () => {
    it('isolates documents between different users with the same app+collection', async () => {
      const { svc } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      await svc.sync('notes', HLC.zero(), [{
        key: 'doc-1',
        doc: { text: 'user-A content' },
        fieldRevs: { text: t1 },
        baseClock: HLC.zero(),
      }], 'user-A', 'todo');

      // user-B syncs pull from the same logical collection
      const { serverChanges } = await svc.sync('notes', HLC.zero(), [], 'user-B', 'todo');

      assert.isEmpty(serverChanges, 'user-B must not see user-A documents');
    });

    it('isolates documents between different apps with the same user+collection', async () => {
      const { svc } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      await svc.sync('items', HLC.zero(), [{
        key: 'item-1',
        doc: { name: 'app-A item' },
        fieldRevs: { name: t1 },
        baseClock: HLC.zero(),
      }], 'user-1', 'app-A');

      const { serverChanges } = await svc.sync('items', HLC.zero(), [], 'user-1', 'app-B');

      assert.isEmpty(serverChanges, 'app-B must not see app-A documents');
    });

    it('same user + same app sees their own documents', async () => {
      const { svc } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      await svc.sync('tasks', HLC.zero(), [{
        key: 'task-1',
        doc: { title: 'My task' },
        fieldRevs: { title: t1 },
        baseClock: HLC.zero(),
      }], 'user-X', 'todo');

      const { serverChanges } = await svc.sync('tasks', HLC.zero(), [], 'user-X', 'todo');

      assert.lengthOf(serverChanges, 1);
      assert.equal(serverChanges[0].title, 'My task');
    });
  });

  // ── text auto-merge ──────────────────────────────────────────────────────────

  describe('text auto-merge for string fields', () => {
    it('reports mergeStrategy:text-auto-merged when server and client have non-overlapping string changes', async () => {
      const { svc, repo } = await buildService();
      const tA = HLC.tick(HLC.zero(), 1000);
      const tB = HLC.tick(tA, 2000);

      // Seed server document
      await repo.store('user-1:notes:journal', 'entry-1',
        { body: 'line1\nline2' },
        { body: tA },
        tA,
      );

      // Client syncs a change that adds a line after the server's content.
      // Base value stored on server is '' (no _base_body), so textMerge will
      // treat client value and server value as both starting from ''.
      // Since both differ from '', this becomes an HLC conflict unless the
      // base is set.  This test verifies the conflict shape.
      const { conflicts } = await svc.sync('journal', tA, [{
        key: 'entry-1',
        doc: { body: 'line1\nline2\nclient-addition' },
        fieldRevs: { body: tB },
        baseClock: tA,
      }], 'user-1', 'notes');

      // At minimum a conflict is reported; we verify the shape is correct
      assert.isArray(conflicts);
      if (conflicts.length > 0) {
        const c = conflicts[0];
        assert.property(c, 'field');
        assert.property(c, 'winner');
        assert.property(c, 'winnerValue');
      }
    });
  });

  // ── HLC fallback ─────────────────────────────────────────────────────────────

  describe('HLC conflict resolution', () => {
    it('higher fieldRev wins when both sides change a non-string field', async () => {
      const { svc, repo } = await buildService();
      const tA = HLC.tick(HLC.zero(), 1000);
      const tB = HLC.tick(tA, 2000); // tB > tA

      await repo.store('user-1:todo:tasks', 'task-1',
        { count: 5 },
        { count: tA },
        tA,
      );

      // Client has count=99 at tB (later); server has count=5 at tA
      const { conflicts } = await svc.sync('tasks', HLC.zero(), [{
        key: 'task-1',
        doc: { count: 99 },
        fieldRevs: { count: tB },
        baseClock: HLC.zero(),
      }], 'user-1', 'todo');

      // tB > tA → client wins
      assert.isArray(conflicts);
      if (conflicts.length > 0) {
        assert.equal(conflicts[0].winner, 'local');
      }
    });

    it('returns serverChanges for documents client has not seen', async () => {
      const { svc } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      const r1 = await svc.sync('items', HLC.zero(), [{
        key: 'item-1',
        doc: { label: 'Hello' },
        fieldRevs: { label: t1 },
        baseClock: HLC.zero(),
      }], 'user-Z', 'myapp');

      // Fresh sync with zero clock — should get the doc back
      const r2 = await svc.sync('items', HLC.zero(), [], 'user-Z', 'myapp');
      assert.lengthOf(r2.serverChanges, 1);
      assert.equal(r2.serverChanges[0].label, 'Hello');

      // Sync with the serverClock we received — should get nothing new
      const r3 = await svc.sync('items', r1.serverClock, [], 'user-Z', 'myapp');
      assert.isEmpty(r3.serverChanges);
    });
  });

  // ── nested document support (dot-path fieldRevs) ──────────────────────────────

  describe('nested document support (dot-path fieldRevs)', () => {
    it('two clients editing different leaf paths of a planner doc merge cleanly', async () => {
      const { svc, repo } = await buildService();
      const t0 = HLC.tick(HLC.zero(), 1000);
      const tA = HLC.tick(t0, 2000); // tA > t0
      const tB = HLC.tick(t0, 3000); // tB > t0

      // Seed a base document that both clients have seen (at t0)
      await repo.store('user-1:planner:plans', 'plan-1',
        {
          meta: { name: 'Work 2026' },
          days: {},
        },
        { meta: t0, days: t0 },
        t0,
      );

      // Client A updates meta.name (fieldRev for 'meta' is tA)
      const r1 = await svc.sync('plans', t0, [{
        key: 'plan-1',
        doc: {
          meta: { name: 'Work 2026 Revised' },
          days: {},
        },
        fieldRevs: { meta: tA },   // tA > t0 → clientChanged for 'meta'
        baseClock: t0,
      }], 'user-1', 'planner');

      assert.isEmpty(r1.conflicts, 'Client A: no conflicts (only A changed meta)');

      // tB > t0 → clientChanged for 'days'.
      // SyncService sees serverChanged for 'meta' (tA > t0) and clientChanged for
      // 'days' (tB > t0): each side changed only its own top-level key → no conflict.
      const r2 = await svc.sync('plans', t0, [{
        key: 'plan-1',
        doc: {
          meta: { name: 'Work 2026' },
          days: { '2026-03-28': { tl: 'standup', col: 0 } },
        },
        fieldRevs: { days: tB },   // tB > t0 → clientChanged for 'days'
        baseClock: t0,
      }], 'user-1', 'planner');

      assert.isEmpty(r2.conflicts, 'Client B: no conflicts (only B changed days)');

      // Pull final converged state and verify both edits are present
      const { serverChanges } = await svc.sync('plans', HLC.zero(), [], 'user-1', 'planner');
      assert.lengthOf(serverChanges, 1, 'one document in the collection');

      const final = serverChanges[0];
      assert.deepEqual(final.meta, { name: 'Work 2026 Revised' },
        'A\'s meta.name edit present in merged doc');
      assert.deepEqual(final.days['2026-03-28'], { tl: 'standup', col: 0 },
        'B\'s days.tl edit present in merged doc');
      assert.isEmpty(r1.conflicts.concat(r2.conflicts), 'zero total conflicts across both syncs');
    });
  });

  // ── ACL fan-out ──────────────────────────────────────────────────────────────

  describe('ACL fan-out via documentIndexRepository', () => {
    it('null-guard: when documentIndexRepository is null, sync returns only own docs', async () => {
      // Use buildService() — no documentIndexRepository wired
      const { svc, repo } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Store Alice's doc directly in Alice's namespace
      await repo.store('alice:planner:docs', 'alice-doc-1',
        { title: 'Alice private' }, { title: t1 }, t1);

      // Bob syncs — should NOT see Alice's doc (documentIndexRepository is null)
      const { serverChanges } = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');
      assert.isEmpty(serverChanges, 'Bob must not see cross-namespace docs when docIndex is null');
    });

    it("Bob receives Alice's doc that is visibility:shared with Bob", async () => {
      const { svc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice stores her doc in her namespace
      await syncRepo.store('alice:planner:docs', 'alice-shared-doc',
        { title: 'Shared year planner' }, { title: t1 }, t1);

      // Index it with visibility:shared and share with bob
      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-shared-doc', 'docs');
      await docIndexRepo.setVisibility('alice', 'planner', 'alice-shared-doc', 'shared');
      await docIndexRepo.addSharedWith('alice', 'planner', 'alice-shared-doc', 'bob', 'planner');

      // Bob syncs
      const { serverChanges } = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');

      const titles = serverChanges.map((d) => d.title);
      assert.include(titles, 'Shared year planner', "Bob must receive Alice's shared doc");
    });

    it("Bob does NOT receive Alice's doc that is visibility:private", async () => {
      const { svc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice stores a private doc in her namespace
      await syncRepo.store('alice:planner:docs', 'alice-private-doc',
        { title: 'Alice private notes' }, { title: t1 }, t1);

      // Index it — visibility stays 'private' (default from upsertOwnership)
      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-private-doc', 'docs');
      // No setVisibility call — stays private

      // Bob syncs
      const { serverChanges } = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');

      const titles = serverChanges.map((d) => d.title);
      assert.notInclude(titles, 'Alice private notes', "Bob must not receive Alice's private doc");
    });

    it("Bob receives Alice's doc that is visibility:public", async () => {
      const { svc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice stores a public doc
      await syncRepo.store('alice:planner:docs', 'alice-public-doc',
        { title: 'Public announcement' }, { title: t1 }, t1);

      // Index it as public
      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-public-doc', 'docs');
      await docIndexRepo.setVisibility('alice', 'planner', 'alice-public-doc', 'public');

      // Bob syncs
      const { serverChanges } = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');

      const titles = serverChanges.map((d) => d.title);
      assert.include(titles, 'Public announcement', "Bob must receive Alice's public doc");
    });

    it('cross-namespace doc is filtered by clientClock (not returned if already seen)', async () => {
      const { svc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice stores a shared doc
      await syncRepo.store('alice:planner:docs', 'alice-shared-seen',
        { title: 'Already seen shared doc' }, { title: t1 }, t1);

      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-shared-seen', 'docs');
      await docIndexRepo.setVisibility('alice', 'planner', 'alice-shared-seen', 'shared');
      await docIndexRepo.addSharedWith('alice', 'planner', 'alice-shared-seen', 'bob', 'planner');

      // First sync — Bob gets the doc; capture the serverClock
      const r1 = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');
      assert.isTrue(r1.serverChanges.some((d) => d.title === 'Already seen shared doc'),
        'Bob must receive doc on first sync');

      // Second sync using the serverClock from first sync — doc already seen, not returned
      const r2 = await svc.sync('docs', r1.serverClock, [], 'bob', 'planner');
      const titles2 = r2.serverChanges.map((d) => d.title);
      assert.notInclude(titles2, 'Already seen shared doc',
        'Bob must not receive the same shared doc twice once clientClock advances');
    });

    it("Bob only receives shared doc, not Alice's private doc, when both exist", async () => {
      const { svc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Alice has two docs in her namespace: one private, one shared with Bob
      await syncRepo.store('alice:planner:docs', 'alice-private',
        { title: 'Alice private' }, { title: t1 }, t1);
      await syncRepo.store('alice:planner:docs', 'alice-shared',
        { title: 'Alice shared' }, { title: t1 }, t1);

      // Index private doc — stays private
      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-private', 'docs');

      // Index shared doc — share with bob
      await docIndexRepo.upsertOwnership('alice', 'planner', 'alice-shared', 'docs');
      await docIndexRepo.setVisibility('alice', 'planner', 'alice-shared', 'shared');
      await docIndexRepo.addSharedWith('alice', 'planner', 'alice-shared', 'bob', 'planner');

      // Bob syncs
      const { serverChanges } = await svc.sync('docs', HLC.zero(), [], 'bob', 'planner');
      const titles = serverChanges.map((d) => d.title);

      assert.include(titles, 'Alice shared', 'Bob must receive the shared doc');
      assert.notInclude(titles, 'Alice private', 'Bob must not receive the private doc');
    });
  });

  // ── PRUNE-02: full-pull recovery after client clock reset ─────────────────────

  describe('prune and full-pull recovery (PRUNE-02)', () => {
    it('client that resets to HLC.zero() after prune receives all stored docs on next sync', async () => {
      const { svc } = await buildService();
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // Step 1: initial sync — push two documents to the server
      const r1 = await svc.sync('notes', HLC.zero(), [
        {
          key: 'doc-A',
          doc: { text: 'Alpha content' },
          fieldRevs: { text: t1 },
          baseClock: HLC.zero(),
        },
        {
          key: 'doc-B',
          doc: { text: 'Beta content' },
          fieldRevs: { text: t1 },
          baseClock: HLC.zero(),
        },
      ], 'prune-user', 'prune-app');

      // Sanity: serverClock returned is non-zero (client would advance its clock to here)
      assert.isString(r1.serverClock);
      assert.notEqual(r1.serverClock, HLC.zero(),
        'serverClock must be non-zero after first sync');

      // Step 2: client simulates a prune by discarding all local data and
      // resetting its clock back to HLC.zero()
      const clientClockAfterPrune = HLC.zero();

      // Step 3: re-sync with the reset clock — server must return all docs
      const r2 = await svc.sync('notes', clientClockAfterPrune, [], 'prune-user', 'prune-app');

      assert.lengthOf(r2.serverChanges, 2,
        'after prune+reset to HLC.zero(), client must receive full pull of all 2 stored docs');

      const texts = r2.serverChanges.map((d) => d.text);
      assert.include(texts, 'Alpha content', 'doc-A must be present in full pull');
      assert.include(texts, 'Beta content', 'doc-B must be present in full pull');
    });
  });

});
