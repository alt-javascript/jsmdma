/**
 * UserRepository.spec.js — Unit tests for UserRepository profile persistence.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import UserRepository from '../UserRepository.js';

async function makeRepo() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  return new UserRepository(client);
}

async function captureAsyncError(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('UserRepository', () => {

  it('create + getUser round-trip stores profile with empty provider projection by default', async () => {
    const repo = await makeRepo();
    const user = await repo.create('u-1', 'alice@example.com');

    assert.equal(user.userId, 'u-1');
    assert.equal(user.email, 'alice@example.com');
    assert.isArray(user.providers);
    assert.lengthOf(user.providers, 0);

    const fetched = await repo.getUser('u-1');
    assert.deepEqual(fetched, user);
  });

  it('create accepts an initial provider projection', async () => {
    const repo = await makeRepo();

    const user = await repo.create('u-proj', 'proj@example.com', [
      { provider: 'github', providerUserId: 'gh-123' },
    ]);

    assert.deepEqual(user.providers, [
      { provider: 'github', providerUserId: 'gh-123' },
    ]);
  });

  it('getUser returns null for unknown userId', async () => {
    const repo = await makeRepo();
    assert.isNull(await repo.getUser('no-such-user'));
  });

  it('syncProvidersProjection replaces providers using store-backed projection data', async () => {
    const repo = await makeRepo();
    const created = await repo.create('u-2', 'bob@example.com', [
      { provider: 'google', providerUserId: 'g-1' },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 2));

    const updated = await repo.syncProvidersProjection('u-2', [
      { provider: 'github', providerUserId: 'gh-2' },
      { provider: 'google', providerUserId: 'g-1' },
    ]);

    assert.deepEqual(updated.providers, [
      { provider: 'github', providerUserId: 'gh-2' },
      { provider: 'google', providerUserId: 'g-1' },
    ]);
    assert.notEqual(updated.updatedAt, created.updatedAt, 'updatedAt should move forward on projection sync');
  });

  it('syncProvidersProjection throws when user does not exist', async () => {
    const repo = await makeRepo();

    const err = await captureAsyncError(() => (
      repo.syncProvidersProjection('missing-user', [{ provider: 'google', providerUserId: 'g-x' }])
    ));

    assert.instanceOf(err, Error);
    assert.include(err.message, 'User not found: missing-user');
  });

  it('syncProvidersProjection rejects malformed projection entries', async () => {
    const repo = await makeRepo();
    await repo.create('u-3', 'c@example.com');

    const err = await captureAsyncError(() => (
      repo.syncProvidersProjection('u-3', [{ provider: 'google' }])
    ));

    assert.instanceOf(err, Error);
    assert.include(err.message, 'must include provider and providerUserId');
  });

  it('updateEmail persists new email and updates timestamp', async () => {
    const repo = await makeRepo();
    const created = await repo.create('u-4', null);

    await new Promise((resolve) => setTimeout(resolve, 2));

    const updated = await repo.updateEmail('u-4', 'new@example.com');
    assert.equal(updated.email, 'new@example.com');
    assert.notEqual(updated.updatedAt, created.updatedAt);
  });

  it('deleteUser removes user record and is idempotent', async () => {
    const repo = await makeRepo();
    await repo.create('u-del', 'del@example.com');

    assert.isNotNull(await repo.getUser('u-del'));

    await repo.deleteUser('u-del');
    assert.isNull(await repo.getUser('u-del'));

    await repo.deleteUser('u-del');
    assert.isNull(await repo.getUser('u-del'));
  });
});
