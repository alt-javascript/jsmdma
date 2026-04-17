/**
 * DocumentIndexRepository.spec.js — Unit tests for DocumentIndexRepository
 *
 * Uses jsnosqlc-memory driver. All tests run against a fresh client per suite.
 */
import { assert } from 'chai';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import '@alt-javascript/jsnosqlc-memory'; // self-registers MemoryDriver
import DocumentIndexRepository from '../DocumentIndexRepository.js';

async function makeRepo() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  return new DocumentIndexRepository(client);
}

describe('DocumentIndexRepository', () => {

  // ── upsertOwnership ──────────────────────────────────────────────────────────

  it('upsertOwnership() creates an entry with private defaults on first call', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-a', 'tasks');

    const entry = await repo.get('user-1', 'todo', 'doc-a');
    assert.isNotNull(entry);
    assert.equal(entry.docKey,     'doc-a');
    assert.equal(entry.userId,     'user-1');
    assert.equal(entry.app,        'todo');
    assert.equal(entry.collection, 'tasks');
    assert.equal(entry.visibility, 'private');
    assert.deepEqual(entry.sharedWith, []);
    assert.isNull(entry.shareToken);
    assert.isString(entry.createdAt);
    assert.isString(entry.updatedAt);
  });

  it('upsertOwnership() preserves visibility on subsequent calls', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-b', 'tasks');
    await repo.setVisibility('user-1', 'todo', 'doc-b', 'shared');

    // Second upsert must NOT reset visibility back to 'private'
    await repo.upsertOwnership('user-1', 'todo', 'doc-b', 'tasks');

    const entry = await repo.get('user-1', 'todo', 'doc-b');
    assert.equal(entry.visibility, 'shared', 'visibility must survive re-upsert');
  });

  it('upsertOwnership() preserves sharedWith on subsequent calls', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-c', 'tasks');
    await repo.addSharedWith('user-1', 'todo', 'doc-c', 'user-2', 'todo');

    await repo.upsertOwnership('user-1', 'todo', 'doc-c', 'tasks');

    const entry = await repo.get('user-1', 'todo', 'doc-c');
    assert.lengthOf(entry.sharedWith, 1, 'sharedWith must survive re-upsert');
    assert.equal(entry.sharedWith[0].userId, 'user-2');
  });

  it('upsertOwnership() preserves shareToken on subsequent calls', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-d', 'tasks');
    await repo.setShareToken('user-1', 'todo', 'doc-d', 'tok-abc-123');

    await repo.upsertOwnership('user-1', 'todo', 'doc-d', 'tasks');

    const entry = await repo.get('user-1', 'todo', 'doc-d');
    assert.equal(entry.shareToken, 'tok-abc-123', 'shareToken must survive re-upsert');
  });

  // ── get ──────────────────────────────────────────────────────────────────────

  it('get() returns null for an unknown key', async () => {
    const repo = await makeRepo();
    const result = await repo.get('nobody', 'app', 'no-such-doc');
    assert.isNull(result);
  });

  // ── setVisibility ────────────────────────────────────────────────────────────

  it('setVisibility() changes the visibility field', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-e', 'tasks');

    await repo.setVisibility('user-1', 'todo', 'doc-e', 'org');

    const entry = await repo.get('user-1', 'todo', 'doc-e');
    assert.equal(entry.visibility, 'org');
  });

  // ── addSharedWith ────────────────────────────────────────────────────────────

  it('addSharedWith() appends a share pair to the sharedWith list', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-f', 'tasks');

    await repo.addSharedWith('user-1', 'todo', 'doc-f', 'user-2', 'todo');

    const entry = await repo.get('user-1', 'todo', 'doc-f');
    assert.lengthOf(entry.sharedWith, 1);
    assert.deepEqual(entry.sharedWith[0], { userId: 'user-2', app: 'todo' });
  });

  it('addSharedWith() is idempotent — same pair added twice yields one entry', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-g', 'tasks');

    await repo.addSharedWith('user-1', 'todo', 'doc-g', 'user-2', 'todo');
    await repo.addSharedWith('user-1', 'todo', 'doc-g', 'user-2', 'todo');

    const entry = await repo.get('user-1', 'todo', 'doc-g');
    assert.lengthOf(entry.sharedWith, 1, 'duplicate share pair must not be stored twice');
  });

  // ── setShareToken ────────────────────────────────────────────────────────────

  it('setShareToken() sets the token on an entry', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-h', 'tasks');

    await repo.setShareToken('user-1', 'todo', 'doc-h', 'tok-xyz');

    const entry = await repo.get('user-1', 'todo', 'doc-h');
    assert.equal(entry.shareToken, 'tok-xyz');
  });

  it('setShareToken(null) clears the token', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'todo', 'doc-i', 'tasks');
    await repo.setShareToken('user-1', 'todo', 'doc-i', 'tok-xyz');

    await repo.setShareToken('user-1', 'todo', 'doc-i', null);

    const entry = await repo.get('user-1', 'todo', 'doc-i');
    assert.isNull(entry.shareToken);
  });

  // ── listByUser ───────────────────────────────────────────────────────────────

  it('listByUser() returns all entries for a userId+app', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-1', 'planner', 'doc-j', 'events');
    await repo.upsertOwnership('user-1', 'planner', 'doc-k', 'events');
    await repo.upsertOwnership('user-1', 'planner', 'doc-l', 'notes');
    // Different user — must NOT appear in results
    await repo.upsertOwnership('user-2', 'planner', 'doc-m', 'events');

    const results = await repo.listByUser('user-1', 'planner');
    assert.lengthOf(results, 3);
    const keys = results.map((e) => e.docKey).sort();
    assert.deepEqual(keys, ['doc-j', 'doc-k', 'doc-l']);
  });

  it('listByUser() returns an empty array when no entries exist', async () => {
    const repo = await makeRepo();
    const results = await repo.listByUser('no-such-user', 'planner');
    assert.isArray(results);
    assert.isEmpty(results);
  });

  // ── delete ───────────────────────────────────────────────────────────────────

  it('delete() removes a docIndex entry by compositeKey; get() returns null after', async () => {
    const repo = await makeRepo();
    await repo.upsertOwnership('user-del', 'todo', 'doc-del', 'tasks');

    const entry = await repo.get('user-del', 'todo', 'doc-del');
    assert.isNotNull(entry);
    const compositeKey = entry._key;

    await repo.delete(compositeKey);

    const after = await repo.get('user-del', 'todo', 'doc-del');
    assert.isNull(after);
  });

  // ── listAccessibleDocs ───────────────────────────────────────────────────────

  describe('listAccessibleDocs', () => {

    async function makeRepoWithDocs() {
      const repo = await makeRepo();

      // Alice owns three docs in 'planner'
      await repo.upsertOwnership('alice', 'planner', 'alice-private',  'events');
      await repo.upsertOwnership('alice', 'planner', 'alice-public',   'events');
      await repo.upsertOwnership('alice', 'planner', 'alice-shared',   'events');
      await repo.upsertOwnership('alice', 'planner', 'alice-org',      'events');

      await repo.setVisibility('alice', 'planner', 'alice-public',  'public');
      await repo.setVisibility('alice', 'planner', 'alice-shared',  'shared');
      await repo.setVisibility('alice', 'planner', 'alice-org',     'org');

      // alice-shared is shared with bob in the same 'planner' app
      await repo.addSharedWith('alice', 'planner', 'alice-shared', 'bob', 'planner');

      // Bob owns one private doc in 'planner'
      await repo.upsertOwnership('bob', 'planner', 'bob-private', 'events');

      // A doc in a completely different app — must never appear
      await repo.upsertOwnership('alice', 'calendar', 'alice-cal-doc', 'events');
      await repo.setVisibility('alice', 'calendar', 'alice-cal-doc', 'public');

      return repo;
    }

    it('own docs are always included (private visibility)', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('alice', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.include(keys, 'alice-private', 'own private doc should be visible');
    });

    it('own docs are always included (all own visibility levels)', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('alice', 'planner');
      const keys = results.map((d) => d.docKey);
      // Alice sees all four of her own docs
      assert.include(keys, 'alice-private');
      assert.include(keys, 'alice-public');
      assert.include(keys, 'alice-shared');
      assert.include(keys, 'alice-org');
    });

    it('public docs from other users are included', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.include(keys, 'alice-public', 'public doc should be visible to bob');
    });

    it('shared doc with correct sharedWith entry is included', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.include(keys, 'alice-shared', 'shared doc explicitly shared with bob should appear');
    });

    it('shared doc where requestor is NOT in sharedWith is excluded', async () => {
      const repo = await makeRepoWithDocs();
      // Carol is not in alice-shared's sharedWith list
      const results = await repo.listAccessibleDocs('carol', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.notInclude(keys, 'alice-shared', 'shared doc not shared with carol should be hidden');
    });

    it('private docs from other users are excluded', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.notInclude(keys, 'alice-private', 'alice private doc must not appear for bob');
    });

    it('org-visibility docs are excluded when orgIds=[] (cross-namespace deferred)', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner', []);
      const keys = results.map((d) => d.docKey);
      assert.notInclude(keys, 'alice-org', 'org doc must not appear when orgIds is empty');
    });

    it('docs from a different app are never included', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner');
      const keys = results.map((d) => d.docKey);
      assert.notInclude(keys, 'alice-cal-doc', 'cross-app public doc must not bleed through');
    });

    it('returns an empty array when no docs exist for the app', async () => {
      const repo = await makeRepo();
      const results = await repo.listAccessibleDocs('alice', 'nonexistent-app');
      assert.isArray(results);
      assert.isEmpty(results);
    });

    it('bob sees exactly his own doc plus alice-public and alice-shared', async () => {
      const repo = await makeRepoWithDocs();
      const results = await repo.listAccessibleDocs('bob', 'planner');
      const keys = results.map((d) => d.docKey).sort();
      assert.deepEqual(keys, ['alice-public', 'alice-shared', 'bob-private'].sort());
    });

  });

});
