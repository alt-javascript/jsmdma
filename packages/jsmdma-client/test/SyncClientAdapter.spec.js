/**
 * SyncClientAdapter.spec.js — TDD tests for SyncClientAdapter
 */
import { assert } from 'chai';
import DocumentStore from '../DocumentStore.js';
import SyncClientAdapter from '../SyncClientAdapter.js';
import { HLC } from '@alt-javascript/jsmdma-core';

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
before(() => { global.localStorage = mockStorage; });
afterEach(() => {
  mockStorage.clear();
  delete global.fetch;
});

const DOC_ID  = 'plan-uuid-1';
const SYNC_URL = 'http://127.0.0.1:8081/year-planner/sync';
const AUTH_HDR = { Authorization: 'Bearer test-jwt' };

function makeAdapter(collection = 'planners') {
  const store = new DocumentStore({ namespace: 'plnr' });
  return { store, adapter: new SyncClientAdapter(store, { collection }) };
}

function mockSyncResponse(serverChanges = [], serverClock = null) {
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        serverClock: serverClock ?? HLC.tick(HLC.zero(), Date.now()),
        serverChanges,
        conflicts: [],
      }),
      headers: { get: () => null },
    };
  };
  return () => capturedBody;
}

describe('SyncClientAdapter', () => {
  describe('markEdited()', () => {
    it('stores an HLC timestamp for the given dotPath', () => {
      const { adapter } = makeAdapter();
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const revs = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`));
      assert.property(revs, 'days.2026-03-28.tl');
      assert.isString(revs['days.2026-03-28.tl']);
    });

    it('second markEdited produces a strictly later clock than the first', () => {
      const { adapter } = makeAdapter();
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const first = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`))['days.2026-03-28.tl'];
      adapter.markEdited(DOC_ID, 'days.2026-03-28.tl');
      const second = JSON.parse(mockStorage.getItem(`rev:${DOC_ID}`))['days.2026-03-28.tl'];
      assert.equal(HLC.compare(first, second), -1, 'second clock must be > first');
    });
  });

  describe('sync()', () => {
    it('sends correct jsmdma payload shape', async () => {
      const { store, adapter } = makeAdapter();
      const doc = { meta: { year: 2026 }, days: {} };
      store.set(DOC_ID, doc);
      const getBody = mockSyncResponse();

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);

      const body = getBody();
      assert.equal(body.collection, 'planners');
      assert.isString(body.clientClock);
      assert.isArray(body.changes);
      assert.lengthOf(body.changes, 1);
      assert.equal(body.changes[0].key, DOC_ID);
      assert.deepEqual(body.changes[0].doc, doc);
      assert.isObject(body.changes[0].fieldRevs);
      assert.isString(body.changes[0].baseClock);
    });

    it('sends Authorization header from authHeaders', async () => {
      const { store, adapter } = makeAdapter();
      const doc = {};
      store.set(DOC_ID, doc);
      let capturedHeaders = null;
      global.fetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true, status: 200,
          json: async () => ({ serverClock: HLC.zero(), serverChanges: [], conflicts: [] }),
          headers: { get: () => null },
        };
      };

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);
      assert.equal(capturedHeaders['Authorization'], 'Bearer test-jwt');
    });

    it('persists sync clock, base snapshot after successful sync', async () => {
      const { store, adapter } = makeAdapter();
      const doc = { days: { '2026-01-01': { tp: 1 } } };
      store.set(DOC_ID, doc);
      const serverClock = HLC.tick(HLC.zero(), Date.now());
      mockSyncResponse([], serverClock);

      await adapter.sync(DOC_ID, doc, AUTH_HDR, SYNC_URL);

      assert.equal(mockStorage.getItem(`sync:${DOC_ID}`), serverClock);
      const base = JSON.parse(mockStorage.getItem(`base:${DOC_ID}`));
      assert.deepEqual(base, doc);
    });

    it('stores a foreign document received from the server via DocumentStore.set()', async () => {
      const { store, adapter } = makeAdapter();
      const ownDoc = { meta: { year: 2026, uid: 'user-1' }, days: {} };
      const foreignKey = 'foreign-planner-uuid';
      const foreignDoc = { meta: { year: 2026, uid: 'user-1' }, days: { '2026-05-01': { tp: 2 } } };
      store.set(DOC_ID, ownDoc);

      const serverClock = HLC.tick(HLC.zero(), Date.now());
      mockSyncResponse([{ _key: foreignKey, _rev: 1, _fieldRevs: {}, ...foreignDoc }], serverClock);

      await adapter.sync(DOC_ID, ownDoc, AUTH_HDR, SYNC_URL);

      // Foreign document stored in DocumentStore
      const stored = store.get(foreignKey);
      assert.deepEqual(stored.meta, foreignDoc.meta);
      assert.deepEqual(stored.days, foreignDoc.days);
    });

    it('throws with err.status on HTTP error', async () => {
      const { store, adapter } = makeAdapter();
      store.set(DOC_ID, {});
      global.fetch = async () => ({
        ok: false, status: 401,
        json: async () => ({ error: 'unauthorized' }),
        headers: { get: () => null },
      });

      try {
        await adapter.sync(DOC_ID, {}, AUTH_HDR, SYNC_URL);
        assert.fail('expected error');
      } catch (err) {
        assert.equal(err.status, 401);
      }
    });
  });

  describe('prune()', () => {
    it('removes rev:, base:, sync: keys for the docId', () => {
      const { adapter } = makeAdapter();
      mockStorage.setItem(`rev:${DOC_ID}`,  JSON.stringify({ 'a.b': 'clock' }));
      mockStorage.setItem(`base:${DOC_ID}`, JSON.stringify({ x: 1 }));
      mockStorage.setItem(`sync:${DOC_ID}`, 'some-clock');

      adapter.prune(DOC_ID);

      assert.isNull(mockStorage.getItem(`rev:${DOC_ID}`));
      assert.isNull(mockStorage.getItem(`base:${DOC_ID}`));
      assert.isNull(mockStorage.getItem(`sync:${DOC_ID}`));
    });
  });

  describe('pruneAll()', () => {
    it('prunes sync state for every document in the DocumentStore', () => {
      const { store, adapter } = makeAdapter();
      store.set('uuid-a', { val: 1 });
      store.set('uuid-b', { val: 2 });
      mockStorage.setItem('rev:uuid-a',  '{}');
      mockStorage.setItem('sync:uuid-a', 'clock-a');
      mockStorage.setItem('rev:uuid-b',  '{}');
      mockStorage.setItem('sync:uuid-b', 'clock-b');

      adapter.pruneAll();

      assert.isNull(mockStorage.getItem('rev:uuid-a'));
      assert.isNull(mockStorage.getItem('sync:uuid-a'));
      assert.isNull(mockStorage.getItem('rev:uuid-b'));
      assert.isNull(mockStorage.getItem('sync:uuid-b'));
    });
  });
});
