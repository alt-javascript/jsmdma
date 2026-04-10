/**
 * DocumentStore.spec.js — TDD tests for DocumentStore
 *
 * Uses a mock localStorage so tests run in Node without a browser.
 * Each test resets storage to a clean state.
 */
import { assert } from 'chai';
import DocumentStore from '../DocumentStore.js';

// ── mock localStorage ──────────────────────────────────────────────────────────
let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
  key:        (n) => Object.keys(_store)[n] ?? null,
  get length() { return Object.keys(_store).length; },
};

// ── helpers ────────────────────────────────────────────────────────────────────
function makeStore(opts = {}) {
  return new DocumentStore({ namespace: 'test', ...opts });
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('DocumentStore', () => {
  // Scoped setup: re-assert mock before each test, clear after.
  beforeEach(() => { global.localStorage = mockStorage; });
  afterEach(() => { mockStorage.clear(); });

  it('set() and get() round-trip a document', () => {
    const store = makeStore();
    store.set('uuid-1', { name: 'Test', year: 2026 });
    const doc = store.get('uuid-1');
    assert.deepEqual(doc, { name: 'Test', year: 2026 });
  });

  it('get() returns null for unknown uuid', () => {
    const store = makeStore();
    assert.isNull(store.get('no-such-uuid'));
  });

  it('list() returns all documents', () => {
    const store = makeStore();
    store.set('a', { x: 1 });
    store.set('b', { x: 2 });
    const list = store.list();
    assert.lengthOf(list, 2);
    const uuids = list.map(e => e.uuid).sort();
    assert.deepEqual(uuids, ['a', 'b']);
    const docs = list.map(e => e.doc);
    assert.ok(docs.find(d => d.x === 1));
    assert.ok(docs.find(d => d.x === 2));
  });

  it('list() returns empty array when store is empty', () => {
    const store = makeStore();
    assert.deepEqual(store.list(), []);
  });

  it('find() returns the first matching document', () => {
    const store = makeStore();
    store.set('x1', { type: 'a', val: 1 });
    store.set('x2', { type: 'b', val: 2 });
    store.set('x3', { type: 'a', val: 3 });
    const result = store.find(doc => doc.type === 'a');
    assert.equal(result.doc.type, 'a');
    assert.ok(['x1', 'x3'].includes(result.uuid));
  });

  it('find() returns null when no document matches', () => {
    const store = makeStore();
    store.set('x1', { type: 'a' });
    assert.isNull(store.find(doc => doc.type === 'z'));
  });

  it('delete() removes the document', () => {
    const store = makeStore();
    store.set('del-me', { v: 1 });
    store.delete('del-me');
    assert.isNull(store.get('del-me'));
    assert.lengthOf(store.list(), 0);
  });

  it('namespaces are isolated — two stores with different namespaces do not share docs', () => {
    const storeA = new DocumentStore({ namespace: 'alpha' });
    const storeB = new DocumentStore({ namespace: 'beta' });
    storeA.set('shared-key', { from: 'alpha' });
    assert.isNull(storeB.get('shared-key'));
  });

  it('migrate() applies a registered migration once and updates migration_version', () => {
    // Register a migration that adds a default field
    DocumentStore.registerMigration('test', 1, (docs) =>
      docs.map(({ uuid, doc }) => ({ uuid, doc: { ...doc, migrated: true } }))
    );

    const store = makeStore();
    store.set('m1', { name: 'Before' });
    store.migrate();

    const doc = store.get('m1');
    assert.equal(doc.migrated, true);
    // Version stored in localStorage
    assert.equal(mockStorage.getItem('test:migration_version'), '1');
  });

  it('migrate() does NOT re-apply a migration that was already applied', () => {
    // Version already at 1
    mockStorage.setItem('test:migration_version', '1');
    let callCount = 0;
    DocumentStore.registerMigration('test', 1, (docs) => {
      callCount++;
      return docs;
    });
    const store = makeStore();
    store.set('x', { val: 42 });
    store.migrate();
    assert.equal(callCount, 0);
  });
});
