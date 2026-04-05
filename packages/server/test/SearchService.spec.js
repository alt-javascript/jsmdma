/**
 * SearchService.spec.js — Unit tests for SearchService
 *
 * Tests ACL-gated search: own docs, cross-namespace public/shared/private docs,
 * filter precision, null-guard (no docIndex), and dot-path contains filtering.
 * Uses jsnosqlc-memory for a fully in-process test environment.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager, Filter } from '@alt-javascript/jsnosqlc-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import SyncRepository from '../SyncRepository.js';
import SearchService from '../SearchService.js';
import DocumentIndexRepository from '../DocumentIndexRepository.js';

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a SearchService wired with both SyncRepository and DocumentIndexRepository,
 * all sharing the same in-memory nosqlClient.
 */
async function buildServiceWithDocIndex() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const syncRepo = new SyncRepository(client);
  const docIndexRepo = new DocumentIndexRepository(client);
  const searchSvc = new SearchService();
  searchSvc.syncRepository = syncRepo;
  searchSvc.documentIndexRepository = docIndexRepo;
  return { searchSvc, syncRepo, docIndexRepo, client };
}

/**
 * Build a SearchService with NO docIndex (null-guard / backward-compat mode).
 */
async function buildServiceWithoutDocIndex() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  const syncRepo = new SyncRepository(client);
  const searchSvc = new SearchService();
  searchSvc.syncRepository = syncRepo;
  // documentIndexRepository intentionally left null
  return { searchSvc, syncRepo, client };
}

/**
 * Convenience: store a doc and register it in the docIndex.
 * Defaults to visibility:'private'; pass visibility to override.
 */
async function seedDoc(syncRepo, docIndexRepo, userId, app, collection, key, doc, visibility = 'private') {
  const hlc = HLC.tick(HLC.zero(), Date.now());
  const storageCol = `${userId}:${app}:${collection}`;
  await syncRepo.store(storageCol, key, doc, {}, hlc);
  await docIndexRepo.upsertOwnership(userId, app, key, collection);
  if (visibility !== 'private') {
    await docIndexRepo.setVisibility(userId, app, key, visibility);
  }
  return hlc;
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('SearchService', () => {

  // ── own document access ────────────────────────────────────────────────────

  describe('own documents', () => {
    it('returns own private doc when filter matches', async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'doc-1',
        { title: 'Alice planner', type: 'plan' });

      const filter = Filter.where('title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'alice', 'planner');

      assert.lengthOf(results, 1);
      assert.equal(results[0].title, 'Alice planner');
    });

    it('excludes own doc when filter does not match (filter precision)', async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();
      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'doc-1',
        { title: 'Alice planner', type: 'plan' });

      // Filter that does NOT match the stored doc
      const filter = Filter.where('title').contains('budget').build();
      const results = await searchSvc.search('planners', filter, 'alice', 'planner');

      assert.isEmpty(results, 'non-matching filter must return empty array');
    });

    it('returns empty array when no docs exist at all', async () => {
      const { searchSvc } = await buildServiceWithDocIndex();

      const filter = Filter.where('title').contains('anything').build();
      const results = await searchSvc.search('planners', filter, 'alice', 'planner');

      assert.isArray(results);
      assert.isEmpty(results);
    });
  });

  // ── cross-namespace public docs ────────────────────────────────────────────

  describe('cross-namespace public documents', () => {
    it("includes Alice's public doc in Bob's search when filter matches", async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'alice-public',
        { title: 'Alice public planner' }, 'public');

      const filter = Filter.where('title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'bob', 'planner');

      const titles = results.map((d) => d.title);
      assert.include(titles, 'Alice public planner', "Bob must receive Alice's public doc");
    });

    it("excludes Alice's public doc when filter does not match", async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'alice-public',
        { title: 'Alice public planner' }, 'public');

      // Filter that doesn't match Alice's doc
      const filter = Filter.where('title').contains('budget').build();
      const results = await searchSvc.search('planners', filter, 'bob', 'planner');

      const titles = results.map((d) => d.title);
      assert.notInclude(titles, 'Alice public planner',
        "Bob must not receive Alice's doc if filter doesn't match");
    });
  });

  // ── cross-namespace private docs (ACL gate) ────────────────────────────────

  describe('cross-namespace private documents (ACL gate)', () => {
    it("excludes Alice's private doc from Bob's results even when filter matches", async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      // Alice's doc is private (default) — indexed but not visible to Bob
      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'alice-private',
        { title: 'Alice private planner' }, 'private');

      const filter = Filter.where('title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'bob', 'planner');

      const titles = results.map((d) => d.title);
      assert.notInclude(titles, 'Alice private planner',
        "Bob must not receive Alice's private doc");
    });
  });

  // ── cross-namespace shared docs ────────────────────────────────────────────

  describe('cross-namespace shared documents (SRCH-02)', () => {
    it("includes Alice's shared doc in Bob's results when Bob is in sharedWith", async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'alice-shared',
        { title: 'Alice shared planner' }, 'shared');
      await docIndexRepo.addSharedWith('alice', 'planner', 'alice-shared', 'bob', 'planner');

      const filter = Filter.where('title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'bob', 'planner');

      const titles = results.map((d) => d.title);
      assert.include(titles, 'Alice shared planner',
        "Bob must receive Alice's shared doc when he is in sharedWith");
    });

    it("excludes Alice's shared doc from Charlie's results when Charlie is not in sharedWith", async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      await seedDoc(syncRepo, docIndexRepo, 'alice', 'planner', 'planners', 'alice-shared',
        { title: 'Alice shared planner' }, 'shared');
      // Shared with bob only — charlie is NOT in sharedWith
      await docIndexRepo.addSharedWith('alice', 'planner', 'alice-shared', 'bob', 'planner');

      const filter = Filter.where('title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'charlie', 'planner');

      const titles = results.map((d) => d.title);
      assert.notInclude(titles, 'Alice shared planner',
        "Charlie must not receive Alice's shared doc — he is not in sharedWith");
    });
  });

  // ── null-guard: no documentIndexRepository ────────────────────────────────

  describe('null-guard: no documentIndexRepository', () => {
    it('returns only own docs when documentIndexRepository is null', async () => {
      const { searchSvc, syncRepo } = await buildServiceWithoutDocIndex();

      // Store alice's doc directly (no docIndex)
      const hlc = HLC.tick(HLC.zero(), Date.now());
      await syncRepo.store('alice:planner:planners', 'alice-doc',
        { title: 'Alice planner' }, {}, hlc);

      // Bob searches — must not see Alice's doc
      const filter = Filter.where('title').contains('planner').build();
      const bobResults = await searchSvc.search('planners', filter, 'bob', 'planner');
      assert.isEmpty(bobResults, 'Bob must not see cross-namespace docs when docIndex is null');

      // Alice searches — must see her own doc
      const aliceResults = await searchSvc.search('planners', filter, 'alice', 'planner');
      assert.lengthOf(aliceResults, 1);
      assert.equal(aliceResults[0].title, 'Alice planner');
    });
  });

  // ── dot-path field filtering (SRCH-01) ────────────────────────────────────

  describe('dot-path field filtering (SRCH-01)', () => {
    it('contains op works on dot-path field meta.title', async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      // Store a doc with a nested meta object
      const hlc = HLC.tick(HLC.zero(), Date.now());
      const storageCol = 'alice:planner:planners';
      await syncRepo.store(storageCol, 'nested-doc',
        { meta: { title: 'My nested planner' }, type: 'plan' }, {}, hlc);
      await docIndexRepo.upsertOwnership('alice', 'planner', 'nested-doc', 'planners');

      const filter = Filter.where('meta.title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'alice', 'planner');

      assert.lengthOf(results, 1, 'dot-path filter must find the nested doc');
      assert.equal(results[0].meta.title, 'My nested planner');
    });

    it('Alice public planner with meta.title appears in Bob search (slice demo scenario)', async () => {
      const { searchSvc, syncRepo, docIndexRepo } = await buildServiceWithDocIndex();

      // Alice: public planner with meta.title containing "planner"
      const hlc = HLC.tick(HLC.zero(), Date.now());
      await syncRepo.store('alice:year-planner:planners', 'alice-year-planner',
        { meta: { title: 'Alice year planner' }, type: 'plan' }, {}, hlc);
      await docIndexRepo.upsertOwnership('alice', 'year-planner', 'alice-year-planner', 'planners');
      await docIndexRepo.setVisibility('alice', 'year-planner', 'alice-year-planner', 'public');

      // Alice: private planner — must NOT appear in Bob's results
      await syncRepo.store('alice:year-planner:planners', 'alice-private-planner',
        { meta: { title: 'Alice private year planner' }, type: 'plan' }, {}, hlc);
      await docIndexRepo.upsertOwnership('alice', 'year-planner', 'alice-private-planner', 'planners');
      // stays private

      const filter = Filter.where('meta.title').contains('planner').build();
      const results = await searchSvc.search('planners', filter, 'bob', 'year-planner');

      const titles = results.map((d) => d.meta.title);
      assert.include(titles, 'Alice year planner',
        "Bob must see Alice's public planner");
      assert.notInclude(titles, 'Alice private year planner',
        "Bob must NOT see Alice's private planner");
    });
  });
});
