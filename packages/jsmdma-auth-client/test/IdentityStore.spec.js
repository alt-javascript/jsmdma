import { assert } from 'chai';
import IdentityStore from '../IdentityStore.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};

describe('IdentityStore', () => {
  beforeEach(() => { global.localStorage = mockStorage; });
  afterEach(() => { mockStorage.clear(); });

  it('getAll() returns [] when empty', () => {
    assert.deepEqual(IdentityStore.getAll(), []);
  });

  it('upsert() adds a new identity', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'alice@example.com' });
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].uuid, 'u1');
  });

  it('upsert() updates an existing identity by uuid', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice Updated', provider: 'google', email: 'a@b.com' });
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].name, 'Alice Updated');
  });

  it('remove() deletes an identity by uuid', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.upsert({ uuid: 'u2', name: 'Bob', provider: 'apple', email: 'b@b.com' });
    IdentityStore.remove('u1');
    const all = IdentityStore.getAll();
    assert.lengthOf(all, 1);
    assert.equal(all[0].uuid, 'u2');
  });

  it('clear() removes all identities', () => {
    IdentityStore.upsert({ uuid: 'u1', name: 'Alice', provider: 'google', email: 'a@b.com' });
    IdentityStore.clear();
    assert.deepEqual(IdentityStore.getAll(), []);
  });
});
