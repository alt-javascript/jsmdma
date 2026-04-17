// @alt-javascript/jsmdma-client/test/SyncDocumentStore.spec.js
import { expect } from 'chai';
import { SyncDocumentStore } from '../SyncDocumentStore.js';

// Mock localStorage for Node.js
const storage = {};
globalThis.localStorage = {
  getItem: (k) => storage[k] ?? null,
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
  clear: () => { for (const k of Object.keys(storage)) delete storage[k]; },
  get length() { return Object.keys(storage).length; },
  key: (i) => Object.keys(storage)[i] ?? null,
};

describe('SyncDocumentStore', () => {
  let store;

  beforeEach(() => {
    localStorage.clear();
    store = new SyncDocumentStore({ namespace: 'test' });
  });

  describe('delegation to DocumentStore', () => {
    it('set() and get() round-trip', () => {
      store.set('doc-1', { meta: { userKey: 'u1' }, data: 'hello' });
      expect(store.get('doc-1')).to.deep.include({ data: 'hello' });
    });

    it('get() returns null for unknown uuid', () => {
      expect(store.get('missing')).to.be.null;
    });

    it('list() returns all documents', () => {
      store.set('a', { meta: { userKey: 'u1' } });
      store.set('b', { meta: { userKey: 'device-1' } });
      expect(store.list()).to.have.length(2);
    });

    it('delete() removes document', () => {
      store.set('doc-1', { meta: { userKey: 'u1' } });
      store.delete('doc-1');
      expect(store.get('doc-1')).to.be.null;
    });

    it('find() with predicate', () => {
      store.set('a', { meta: { userKey: 'u1', year: 2026 } });
      store.set('b', { meta: { userKey: 'u1', year: 2025 } });
      const result = store.find((doc) => doc.meta.year === 2025);
      expect(result.uuid).to.equal('b');
    });
  });

  describe('listSyncable(userId)', () => {
    it('returns only docs with matching meta.userKey', () => {
      store.set('a', { meta: { userKey: 'user-1' }, days: {} });
      store.set('b', { meta: { userKey: 'device-abc' }, days: {} });
      store.set('c', { meta: { userKey: 'user-1' }, days: {} });
      const result = store.listSyncable('user-1');
      expect(result).to.have.length(2);
      expect(result.map(r => r.uuid).sort()).to.deep.equal(['a', 'c']);
    });

    it('returns empty array when no docs match userId', () => {
      store.set('a', { meta: { userKey: 'device-abc' }, days: {} });
      expect(store.listSyncable('user-1')).to.deep.equal([]);
    });
  });

  describe('listLocal()', () => {
    it('returns all docs regardless of userKey', () => {
      store.set('a', { meta: { userKey: 'user-1' } });
      store.set('b', { meta: { userKey: 'device-abc' } });
      expect(store.listLocal()).to.have.length(2);
    });
  });

  describe('takeOwnership(uuid, userId)', () => {
    it('updates meta.userKey to userId', () => {
      store.set('doc-1', { meta: { userKey: 'device-abc', year: 2026 }, days: {} });
      store.takeOwnership('doc-1', 'user-1');
      expect(store.get('doc-1').meta.userKey).to.equal('user-1');
    });

    it('makes doc appear in listSyncable after ownership transfer', () => {
      store.set('doc-1', { meta: { userKey: 'device-abc' }, days: {} });
      expect(store.listSyncable('user-1')).to.have.length(0);
      store.takeOwnership('doc-1', 'user-1');
      expect(store.listSyncable('user-1')).to.have.length(1);
    });

    it('preserves all other document fields', () => {
      store.set('doc-1', { meta: { userKey: 'device-abc', year: 2026, name: 'My Plan' }, days: { '2026-01-01': { tl: 'HNY' } } });
      store.takeOwnership('doc-1', 'user-1');
      const doc = store.get('doc-1');
      expect(doc.meta.year).to.equal(2026);
      expect(doc.meta.name).to.equal('My Plan');
      expect(doc.days['2026-01-01'].tl).to.equal('HNY');
    });
  });
});
