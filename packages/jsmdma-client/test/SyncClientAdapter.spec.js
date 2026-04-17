// packages/jsmdma-client/test/SyncClientAdapter.spec.js
import { expect } from 'chai';
import SyncClientAdapter from '../SyncClientAdapter.js';
import { SyncDocumentStore } from '../SyncDocumentStore.js';
import { HLC } from 'packages/jsmdma-core';

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

// Mock fetch
let fetchCalls = [];
let fetchResponse = { serverClock: '0000000000001-000001-server', serverChanges: [] };

function installFetchMock() {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      json: async () => fetchResponse,
    };
  };
}

installFetchMock();

describe('SyncClientAdapter', () => {
  let store;
  let adapter;

  beforeEach(() => {
    localStorage.clear();
    fetchCalls = [];
    fetchResponse = { serverClock: '0000000000001-000001-server', serverChanges: [] };
    installFetchMock(); // re-install in case another spec's afterEach deleted it
    store = new SyncDocumentStore({ namespace: 'test' });
    adapter = new SyncClientAdapter(store, { collection: 'planners' });
  });

  describe('markEdited(docId, dotPath)', () => {
    it('stores HLC timestamp for dotPath', () => {
      adapter.markEdited('doc-1', 'days.2026-01-01.tl');
      const revs = JSON.parse(localStorage.getItem('rev:doc-1'));
      expect(revs).to.have.property('days.2026-01-01.tl');
    });

    it('produces strictly later clock on second call', () => {
      adapter.markEdited('doc-1', 'field.a');
      const rev1 = JSON.parse(localStorage.getItem('rev:doc-1'))['field.a'];
      adapter.markEdited('doc-1', 'field.a');
      const rev2 = JSON.parse(localStorage.getItem('rev:doc-1'))['field.a'];
      expect(HLC.compare(rev2, rev1)).to.be.greaterThan(0);
    });
  });

  describe('sync(userId, authHeaders, syncUrl)', () => {
    it('sends all syncable docs in one request', async () => {
      store.set('doc-1', { meta: { userKey: 'user-1' }, days: { '2026-01-01': { tl: 'A' } } });
      store.set('doc-2', { meta: { userKey: 'user-1' }, days: { '2026-02-01': { tl: 'B' } } });
      store.set('doc-3', { meta: { userKey: 'device-x' }, days: {} }); // not syncable

      await adapter.sync('user-1', { Authorization: 'Bearer tok' }, 'http://localhost/sync');
      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].opts.body);
      expect(body.changes).to.have.length(2);
      expect(body.changes.map(c => c.key).sort()).to.deep.equal(['doc-1', 'doc-2']);
    });

    it('sends empty changes when no syncable docs (pull-only)', async () => {
      store.set('doc-1', { meta: { userKey: 'device-x' }, days: {} });

      await adapter.sync('user-1', {}, 'http://localhost/sync');
      expect(fetchCalls).to.have.length(1);
      const body = JSON.parse(fetchCalls[0].opts.body);
      expect(body.changes).to.deep.equal([]);
    });

    it('sends Authorization header', async () => {
      await adapter.sync('user-1', { Authorization: 'Bearer abc' }, 'http://localhost/sync');
      const headers = fetchCalls[0].opts.headers;
      expect(headers['Authorization']).to.equal('Bearer abc');
    });

    it('merges matching _key serverChanges via merge', async () => {
      store.set('doc-1', { meta: { userKey: 'user-1' }, days: {} });
      fetchResponse = {
        serverClock: '0000000000001-000001-server',
        serverChanges: [{
          _key: 'doc-1', _rev: '0000000000001-000001-server', _fieldRevs: {},
          meta: { userKey: 'user-1' }, days: { '2026-03-01': { tl: 'ServerDay' } },
        }],
      };

      const results = await adapter.sync('user-1', {}, 'http://localhost/sync');
      expect(results).to.have.property('doc-1');
    });

    it('stores foreign _key serverChanges via set()', async () => {
      store.set('doc-1', { meta: { userKey: 'user-1' }, days: {} });
      fetchResponse = {
        serverClock: '0000000000001-000001-server',
        serverChanges: [{
          _key: 'foreign-doc', _rev: '0000000000001-000001-server', _fieldRevs: {},
          meta: { userKey: 'user-1', year: 2026 }, days: { '2026-05-01': { tl: 'Foreign' } },
        }],
      };

      await adapter.sync('user-1', {}, 'http://localhost/sync');
      const foreignDoc = store.get('foreign-doc');
      expect(foreignDoc).to.not.be.null;
      expect(foreignDoc.days['2026-05-01'].tl).to.equal('Foreign');
    });

    it('updates sync state for all synced docs', async () => {
      store.set('doc-1', { meta: { userKey: 'user-1' }, days: {} });
      store.set('doc-2', { meta: { userKey: 'user-1' }, days: {} });
      adapter.markEdited('doc-1', 'days.2026-01-01.tl');

      await adapter.sync('user-1', {}, 'http://localhost/sync');
      expect(localStorage.getItem('sync:doc-1')).to.equal('0000000000001-000001-server');
      expect(localStorage.getItem('sync:doc-2')).to.equal('0000000000001-000001-server');
    });

    it('clears rev: after successful sync', async () => {
      store.set('doc-1', { meta: { userKey: 'user-1' }, days: {} });
      adapter.markEdited('doc-1', 'days.2026-01-01.tl');
      expect(JSON.parse(localStorage.getItem('rev:doc-1'))).to.have.property('days.2026-01-01.tl');

      await adapter.sync('user-1', {}, 'http://localhost/sync');
      expect(JSON.parse(localStorage.getItem('rev:doc-1'))).to.deep.equal({});
    });

    it('throws with err.status on HTTP error', async () => {
      globalThis.fetch = async () => ({ ok: false, status: 401 });
      try {
        await adapter.sync('user-1', {}, 'http://localhost/sync');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.status).to.equal(401);
      }
      // Restore mock
      globalThis.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        return { ok: true, json: async () => fetchResponse };
      };
    });
  });

  describe('prune(docId)', () => {
    it('removes rev/base/sync keys', () => {
      localStorage.setItem('sync:doc-1', 'clock');
      localStorage.setItem('rev:doc-1', '{}');
      localStorage.setItem('base:doc-1', '{}');
      adapter.prune('doc-1');
      expect(localStorage.getItem('sync:doc-1')).to.be.null;
      expect(localStorage.getItem('rev:doc-1')).to.be.null;
      expect(localStorage.getItem('base:doc-1')).to.be.null;
    });
  });

  describe('pruneAll()', () => {
    it('prunes all documents in store', () => {
      store.set('a', { meta: { userKey: 'u' } });
      store.set('b', { meta: { userKey: 'u' } });
      localStorage.setItem('sync:a', 'x');
      localStorage.setItem('sync:b', 'x');
      adapter.pruneAll();
      expect(localStorage.getItem('sync:a')).to.be.null;
      expect(localStorage.getItem('sync:b')).to.be.null;
    });
  });
});
