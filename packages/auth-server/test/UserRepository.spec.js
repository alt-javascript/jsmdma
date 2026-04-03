/**
 * UserRepository.spec.js — Unit tests for UserRepository
 *
 * Uses jsnosqlc-memory driver. All tests run against a fresh client per suite.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import UserRepository from '../UserRepository.js';

async function makeRepo() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  return new UserRepository(client);
}

describe('UserRepository', () => {

  // ── create / getUser / findByProvider ────────────────────────────────────

  it('create + getUser round-trip', async () => {
    const repo = await makeRepo();
    const user = await repo.create('u-1', 'alice@example.com', 'google', 'g-123');
    assert.equal(user.userId, 'u-1');
    assert.equal(user.email, 'alice@example.com');
    assert.lengthOf(user.providers, 1);
    assert.equal(user.providers[0].provider, 'google');
    assert.equal(user.providers[0].providerUserId, 'g-123');

    const fetched = await repo.getUser('u-1');
    assert.deepEqual(fetched, user);
  });

  it('getUser returns null for unknown userId', async () => {
    const repo = await makeRepo();
    assert.isNull(await repo.getUser('no-such-user'));
  });

  it('findByProvider returns user when provider index entry exists', async () => {
    const repo = await makeRepo();
    await repo.create('u-2', 'bob@example.com', 'github', 'gh-456');

    const found = await repo.findByProvider('github', 'gh-456');
    assert.isNotNull(found);
    assert.equal(found.userId, 'u-2');
  });

  // ── deleteUser ───────────────────────────────────────────────────────────────

  it('deleteUser removes user record and provider index entries', async () => {
    const repo = await makeRepo();
    await repo.create('u-del', 'del@example.com', 'google', 'g-del-1');
    await repo.addProvider('u-del', 'github', 'gh-del-2');

    // Confirm both exist before delete
    assert.isNotNull(await repo.getUser('u-del'));
    assert.isNotNull(await repo.findByProvider('google', 'g-del-1'));
    assert.isNotNull(await repo.findByProvider('github', 'gh-del-2'));

    await repo.deleteUser('u-del');

    // User record gone
    assert.isNull(await repo.getUser('u-del'));
    // Provider index entries gone
    assert.isNull(await repo.findByProvider('google', 'g-del-1'));
    assert.isNull(await repo.findByProvider('github', 'gh-del-2'));
  });

  it('deleteUser is idempotent — does not throw when user does not exist', async () => {
    const repo = await makeRepo();
    // Should not throw
    await repo.deleteUser('nonexistent-user');
    // Confirm user is still null
    assert.isNull(await repo.getUser('nonexistent-user'));
  });

  it('deleteUser removes single-provider user cleanly', async () => {
    const repo = await makeRepo();
    await repo.create('u-single', 'single@example.com', 'apple', 'ap-999');

    await repo.deleteUser('u-single');

    assert.isNull(await repo.getUser('u-single'));
    assert.isNull(await repo.findByProvider('apple', 'ap-999'));
  });

});
