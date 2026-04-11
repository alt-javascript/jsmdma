/**
 * SyncClient.spec.js — Mocha tests for SyncClient
 *
 * Covers: edit, getChanges, sync, prune, shouldPrune, getSnapshot, fromSnapshot,
 * the edit→sync state machine, and an isomorphism audit.
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import HLC from '../hlc.js';
import SyncClient from '../SyncClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const syncClientSource = readFileSync(join(__dir, '../SyncClient.js'), 'utf-8');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal server response for use in sync() tests.
 * serverClock is a real HLC so HLC.recv can parse it.
 */
function makeServerResponse(serverChanges = [], serverClock = null, conflicts = []) {
  return {
    serverClock: serverClock ?? HLC.tick(HLC.zero(), 5000),
    serverChanges,
    conflicts,
  };
}

/**
 * Build a server document record matching the protocol shape SyncClient expects:
 * app fields plus _key and _fieldRevs.
 */
function makeServerDoc(key, appFields, fieldRevs = {}) {
  return { _key: key, _fieldRevs: fieldRevs, ...appFields };
}

/**
 * Minimal mock server: receives changes from one client, stores them,
 * and returns all known docs as serverChanges to any syncing client.
 * Uses a SyncClient internally to demonstrate server-as-client symmetry.
 *
 * The server merges incoming client changes using HLC-wins semantics and
 * stores the winning fieldRev per field so that subsequent clients receive
 * authoritative revision vectors for correct conflict resolution.
 */
function createMockServer(nodeId = 'server') {
  const server = new SyncClient(nodeId, 0);
  let serverClock = HLC.tick(HLC.zero(), 1);

  return {
    sync(clientChanges, wallMs = Date.now()) {
      for (const change of clientChanges) {
        const existing = server.docs[change.key];
        if (!existing) {
          // New doc — store with client's fieldRevs intact
          server.docs[change.key] = {
            doc: change.doc,
            fieldRevs: { ...change.fieldRevs },
            baseSnapshot: change.doc,
          };
        } else {
          // Merge: for each field, the higher HLC wins; store the winning fieldRev
          const mergedDoc = { ...existing.doc };
          const mergedRevs = { ...existing.fieldRevs };
          for (const field of new Set([
            ...Object.keys(existing.doc),
            ...Object.keys(change.doc),
          ])) {
            if (field.startsWith('_')) continue;
            const serverRev = existing.fieldRevs[field] ?? HLC.zero();
            const clientRev = change.fieldRevs[field] ?? HLC.zero();
            if (HLC.compare(clientRev, serverRev) > 0) {
              mergedDoc[field] = change.doc[field];
              mergedRevs[field] = clientRev;
            }
          }
          server.docs[change.key] = {
            doc: mergedDoc,
            fieldRevs: mergedRevs,
            baseSnapshot: mergedDoc,
          };
        }
      }
      serverClock = HLC.tick(serverClock, wallMs);
      const serverChanges = Object.entries(server.docs).map(([key, entry]) => ({
        _key: key,
        _fieldRevs: entry.fieldRevs,
        ...entry.doc,
      }));
      return { serverClock, serverChanges };
    },
    get docs() { return server.docs; },
  };
}

// ─── describe SyncClient ──────────────────────────────────────────────────────

describe('SyncClient', () => {

  // ── constructor ──────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('initialises clock with the provided nodeId', () => {
      const client = new SyncClient('node-1', 1000);
      const d = HLC.decode(client.clock);
      assert.equal(d.node, 'node-1');
      assert.equal(d.ms, 1000);
    });

    it('initialises baseClock to HLC.zero()', () => {
      const client = new SyncClient('n', 0);
      assert.equal(client.baseClock, HLC.zero());
    });

    it('initialises docs to an empty object', () => {
      const client = new SyncClient('n', 0);
      assert.deepEqual(client.docs, {});
    });

    it('initialises lastSyncAt to null', () => {
      const client = new SyncClient('n', 0);
      assert.isNull(client.lastSyncAt);
    });
  });

  // ── edit() ───────────────────────────────────────────────────────────────────

  describe('edit()', () => {
    it('stores the document under the given key', () => {
      const client = new SyncClient('n', 1000);
      const doc = { title: 'Buy milk', done: false };
      client.edit('todos/1', doc, 1000);
      assert.deepEqual(client.docs['todos/1'].doc, doc);
    });

    it('stamps fieldRevs for all fields on a new doc', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Buy milk', done: false }, 1000);
      const { fieldRevs } = client.docs['todos/1'];
      assert.isString(fieldRevs.title);
      assert.isString(fieldRevs.done);
      // Both should be real HLC strings (parseable)
      assert.doesNotThrow(() => HLC.decode(fieldRevs.title));
      assert.doesNotThrow(() => HLC.decode(fieldRevs.done));
    });

    it('clock advances on each edit call (strictly monotonic)', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k1', { a: 1 }, 1000);
      const c1 = client.clock;
      client.edit('k2', { b: 2 }, 1000);
      const c2 = client.clock;
      assert.isAbove(HLC.compare(c2, c1), 0);
    });

    it('unchanged fields on re-edit do NOT get a new fieldRev', () => {
      // baseSnapshot is only updated on sync(), so we need a sync to set the
      // common ancestor before testing that an unchanged field keeps its fieldRev.
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Buy milk', done: false }, 1000);

      // Sync so baseSnapshot becomes { title: 'Buy milk', done: false }
      const serverHlc = HLC.tick(HLC.zero(), 500); // lower than local → local wins
      const serverDoc = makeServerDoc('todos/1',
        { title: 'Buy milk', done: false },
        { title: serverHlc, done: serverHlc });
      client.sync(makeServerResponse([serverDoc], HLC.tick(HLC.zero(), 5000)), 5000);

      const revTitleAfterSync = client.docs['todos/1'].fieldRevs.title;

      // Re-edit with only 'done' changed — 'title' unchanged against baseSnapshot
      client.edit('todos/1', { title: 'Buy milk', done: true }, 6000);
      const revTitleAfterReEdit = client.docs['todos/1'].fieldRevs.title;

      assert.equal(revTitleAfterReEdit, revTitleAfterSync,
        'title fieldRev must not change when title is unchanged relative to baseSnapshot');
    });

    it('changed fields on re-edit DO get a new (greater) fieldRev', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Buy milk', done: false }, 1000);
      const rev1 = client.docs['todos/1'].fieldRevs.done;
      client.edit('todos/1', { title: 'Buy milk', done: true }, 2000);
      const rev2 = client.docs['todos/1'].fieldRevs.done;
      assert.isAbove(HLC.compare(rev2, rev1), 0);
    });

    it('returns this (chainable)', () => {
      const client = new SyncClient('n', 1000);
      const returned = client.edit('k1', { a: 1 }, 1000).edit('k2', { b: 2 }, 1000);
      assert.strictEqual(returned, client);
      assert.property(client.docs, 'k1');
      assert.property(client.docs, 'k2');
    });

    it('wallMs parameter is forwarded to HLC.tick (clock ms matches wallMs when higher)', () => {
      const client = new SyncClient('n', 0);
      client.edit('k1', { x: 1 }, 9000);
      assert.equal(HLC.decode(client.clock).ms, 9000);
    });

    it('private fields (starting with _) are excluded from fieldRevs', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k1', { title: 'hi', _proto: 'secret' }, 1000);
      const { fieldRevs } = client.docs['k1'];
      assert.property(fieldRevs, 'title');
      assert.notProperty(fieldRevs, '_proto');
    });
  });

  // ── getChanges() ─────────────────────────────────────────────────────────────

  describe('getChanges()', () => {
    it('returns empty array before any edits', () => {
      const client = new SyncClient('n', 0);
      assert.deepEqual(client.getChanges(), []);
    });

    it('returns one entry per edited document', () => {
      const client = new SyncClient('n', 1000);
      client.edit('a', { x: 1 }, 1000).edit('b', { y: 2 }, 1000);
      assert.lengthOf(client.getChanges(), 2);
    });

    it('each entry has key, doc, fieldRevs, and baseClock', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Go' }, 1000);
      const [entry] = client.getChanges();
      assert.property(entry, 'key');
      assert.property(entry, 'doc');
      assert.property(entry, 'fieldRevs');
      assert.property(entry, 'baseClock');
    });

    it('entry.key matches the key passed to edit()', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/99', { title: 'Task' }, 1000);
      const [entry] = client.getChanges();
      assert.equal(entry.key, 'todos/99');
    });

    it('entry.doc is the document passed to edit()', () => {
      const client = new SyncClient('n', 1000);
      const doc = { title: 'Task', done: false };
      client.edit('todos/1', doc, 1000);
      const [entry] = client.getChanges();
      assert.deepEqual(entry.doc, doc);
    });

    it('baseClock is HLC.zero() before first sync', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k', { v: 1 }, 1000);
      const [entry] = client.getChanges();
      assert.equal(entry.baseClock, HLC.zero());
    });

    it('fieldRevs in the payload match the stored fieldRevs', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k', { a: 1, b: 2 }, 1000);
      const [entry] = client.getChanges();
      assert.deepEqual(entry.fieldRevs, client.docs['k'].fieldRevs);
    });
  });

  // ── sync() ───────────────────────────────────────────────────────────────────

  describe('sync()', () => {
    it('returns an object with serverChanges and conflicts arrays', () => {
      const client = new SyncClient('n', 1000);
      const result = client.sync(makeServerResponse());
      assert.isArray(result.serverChanges);
      assert.isArray(result.conflicts);
    });

    it('inserts a new doc from server when key not in local docs', () => {
      const client = new SyncClient('n', 1000);
      const serverDoc = makeServerDoc('todos/1', { title: 'Server task', done: false });
      const resp = makeServerResponse([serverDoc], HLC.tick(HLC.zero(), 5000));
      client.sync(resp, 5000);
      assert.property(client.docs, 'todos/1');
      assert.deepEqual(client.docs['todos/1'].doc, { title: 'Server task', done: false });
    });

    it('new doc from server has baseSnapshot equal to its appFields', () => {
      const client = new SyncClient('n', 1000);
      const appFields = { title: 'Server task', done: false };
      const serverDoc = makeServerDoc('todos/1', appFields);
      client.sync(makeServerResponse([serverDoc], HLC.tick(HLC.zero(), 5000)), 5000);
      assert.deepEqual(client.docs['todos/1'].baseSnapshot, appFields);
    });

    it('merges server change with local doc (local-only fields preserved)', () => {
      const client = new SyncClient('n', 1000);
      // Local: title and note fields
      client.edit('todos/1', { title: 'Local title', note: 'local note' }, 1000);
      const localFieldRevs = { ...client.docs['todos/1'].fieldRevs };

      // Server sends a change only to 'title' with a lower HLC than local
      const serverHlc = HLC.tick(HLC.zero(), 500); // lower than local clock
      const serverDoc = makeServerDoc('todos/1', { title: 'Server title' }, {
        title: serverHlc,
      });
      client.sync(makeServerResponse([serverDoc], HLC.tick(HLC.zero(), 5000)), 5000);

      // Local 'title' fieldRev is higher — local wins
      assert.equal(client.docs['todos/1'].doc.title, 'Local title');
      // 'note' field was local-only — must survive
      assert.equal(client.docs['todos/1'].doc.note, 'local note');
    });

    it('server field with higher HLC wins over local', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Local title' }, 1000);

      // Server sends a title with a much higher HLC
      const serverHlc = HLC.tick(HLC.zero(), 99999999);
      const serverDoc = makeServerDoc('todos/1', { title: 'Server title' }, {
        title: serverHlc,
      });
      const serverClock = HLC.tick(HLC.zero(), 99999999);
      client.sync(makeServerResponse([serverDoc], serverClock), 9999);

      assert.equal(client.docs['todos/1'].doc.title, 'Server title');
    });

    it('baseClock advances to serverClock after sync', () => {
      const client = new SyncClient('n', 1000);
      const serverClock = HLC.tick(HLC.zero(), 5000);
      client.sync(makeServerResponse([], serverClock), 5000);
      assert.equal(client.baseClock, serverClock);
    });

    it('lastSyncAt is set to a number after sync', () => {
      const client = new SyncClient('n', 1000);
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 5000);
      assert.isNumber(client.lastSyncAt);
    });

    it('lastSyncAt equals the wallMs passed to sync', () => {
      const client = new SyncClient('n', 1000);
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 12345);
      assert.equal(client.lastSyncAt, 12345);
    });

    it('clock is advanced via HLC.recv after sync', () => {
      const client = new SyncClient('n', 1000);
      const clockBefore = client.clock;
      const serverClock = HLC.tick(HLC.zero(), 9000);
      client.sync(makeServerResponse([], serverClock), 9000);
      assert.isAbove(HLC.compare(client.clock, clockBefore), 0);
    });

    it('baseSnapshot is updated to merged result after sync', () => {
      const client = new SyncClient('n', 1000);
      client.edit('todos/1', { title: 'Original' }, 1000);

      const serverHlc = HLC.tick(HLC.zero(), 9000);
      const serverDoc = makeServerDoc('todos/1', { title: 'Updated', extra: 'added' }, {
        title: serverHlc,
        extra: serverHlc,
      });
      const serverClock = HLC.tick(HLC.zero(), 9000);
      client.sync(makeServerResponse([serverDoc], serverClock), 9000);

      // After sync, baseSnapshot must reflect the merged doc
      const { baseSnapshot } = client.docs['todos/1'];
      assert.equal(baseSnapshot.title, 'Updated');
      assert.equal(baseSnapshot.extra, 'added');
    });

    it('merge conflicts are surfaced in returned conflicts array', () => {
      const client = new SyncClient('n', 1000);
      // Local edit at wall=1000
      client.edit('todos/1', { title: 'Local' }, 1000);

      // Server has a different value for the same field at a lower clock (so local wins)
      const serverHlc = HLC.tick(HLC.zero(), 500); // lower → local wins
      const serverDoc = makeServerDoc('todos/1', { title: 'Server' }, { title: serverHlc });
      const serverClock = HLC.tick(HLC.zero(), 5000);
      const result = client.sync(makeServerResponse([serverDoc], serverClock), 5000);

      // A conflict should be reported (both sides changed 'title')
      const titleConflict = result.conflicts.find(c => c.field === 'title');
      assert.isDefined(titleConflict, 'Expected a conflict entry for "title"');
    });

    it('server-level conflicts from serverResponse.conflicts are included', () => {
      const client = new SyncClient('n', 1000);
      const serverConflict = { field: 'x', winner: 'remote' };
      const resp = makeServerResponse([], HLC.tick(HLC.zero(), 5000), [serverConflict]);
      const result = client.sync(resp, 5000);
      assert.deepInclude(result.conflicts, serverConflict);
    });

    it('private fields (_key, _fieldRevs) are not stored in the merged doc', () => {
      const client = new SyncClient('n', 1000);
      const serverDoc = makeServerDoc('todos/1', { title: 'Task' });
      client.sync(makeServerResponse([serverDoc], HLC.tick(HLC.zero(), 5000)), 5000);
      const { doc } = client.docs['todos/1'];
      assert.notProperty(doc, '_key');
      assert.notProperty(doc, '_fieldRevs');
    });
  });

  // ── prune() ──────────────────────────────────────────────────────────────────

  describe('prune()', () => {
    it('resets baseClock to HLC.zero()', () => {
      const client = new SyncClient('n', 1000);
      // Force a sync to set baseClock
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 5000);
      assert.notEqual(client.baseClock, HLC.zero());
      client.prune();
      assert.equal(client.baseClock, HLC.zero());
    });

    it('clears all docs (docs becomes empty object)', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k1', { a: 1 }, 1000).edit('k2', { b: 2 }, 1000);
      assert.isAbove(Object.keys(client.docs).length, 0);
      client.prune();
      assert.equal(Object.keys(client.docs).length, 0);
    });

    it('resets lastSyncAt to null', () => {
      const client = new SyncClient('n', 1000);
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 5000);
      assert.isNumber(client.lastSyncAt);
      client.prune();
      assert.isNull(client.lastSyncAt);
    });

    it('returns this (chainable)', () => {
      const client = new SyncClient('n', 1000);
      const returned = client.prune();
      assert.strictEqual(returned, client);
    });

    it('does not affect the local HLC clock (node identity preserved)', () => {
      const client = new SyncClient('node-x', 1000);
      client.edit('k', { v: 1 }, 1000);
      const clockBefore = client.clock;
      client.prune();
      assert.equal(client.clock, clockBefore);
    });
  });

  // ── shouldPrune() ────────────────────────────────────────────────────────────

  describe('shouldPrune()', () => {
    it('returns false before first sync (lastSyncAt is null)', () => {
      const client = new SyncClient('n', 0);
      assert.isFalse(client.shouldPrune(0));
    });

    it('returns false when threshold is not exceeded', () => {
      const client = new SyncClient('n', 1000);
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 5000);
      // Very large threshold — threshold should not be exceeded
      assert.isFalse(client.shouldPrune(Number.MAX_SAFE_INTEGER));
    });

    it('returns true when threshold is exceeded', () => {
      const client = new SyncClient('n', 1000);
      // Sync with a wallMs far in the past (0), so Date.now()-0 > 0 threshold
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 0);
      // Threshold of 0 ms: any positive elapsed time should qualify
      assert.isTrue(client.shouldPrune(0));
    });

    it('returns true with a sensible elapsed time and threshold', () => {
      const client = new SyncClient('n', 1000);
      const syncedAt = Date.now() - 10000; // 10 seconds ago
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), syncedAt);
      // Threshold of 5 seconds: 10s > 5s → should prune
      assert.isTrue(client.shouldPrune(5000));
    });
  });

  // ── edit → sync round-trip ───────────────────────────────────────────────────

  describe('edit → sync round-trip', () => {
    it('edit() then getChanges() has correct keys, fieldRevs stamp the edit clock, baseClock is zero', () => {
      const client = new SyncClient('rt', 1000);
      client.edit('todos/1', { title: 'A', done: false }, 1000);
      const changes = client.getChanges();
      assert.lengthOf(changes, 1);

      const [entry] = changes;
      assert.equal(entry.key, 'todos/1');
      assert.equal(entry.baseClock, HLC.zero());
      assert.isString(entry.fieldRevs.title);
      assert.isString(entry.fieldRevs.done);

      // fieldRevs must equal the client's clock at time of edit
      const editClock = client.clock;
      // They can't exceed the current clock
      assert.isAtMost(HLC.compare(entry.fieldRevs.title, editClock), 0);
    });

    it('after sync(), a second edit on a server field produces fieldRev > server fieldRev', () => {
      const client = new SyncClient('rt', 1000);
      client.edit('todos/1', { title: 'Old' }, 1000);

      const serverHlc = HLC.tick(HLC.zero(), 9000);
      const serverDoc = makeServerDoc('todos/1', { title: 'Synced' }, { title: serverHlc });
      const serverClock = HLC.tick(HLC.zero(), 9000);
      client.sync(makeServerResponse([serverDoc], serverClock), 9000);

      // Edit again — new fieldRev must be > server's fieldRev
      client.edit('todos/1', { title: 'Post-sync edit' }, 10000);
      const newRev = client.docs['todos/1'].fieldRevs.title;
      assert.isAbove(HLC.compare(newRev, serverHlc), 0);
    });

    it('after sync(), no-op re-edit shows no changed fields for unmodified fields', () => {
      const client = new SyncClient('rt', 1000);
      client.edit('todos/1', { title: 'A', done: false }, 1000);

      const serverHlc = HLC.tick(HLC.zero(), 9000);
      const serverDoc = makeServerDoc('todos/1', { title: 'A', done: false }, {
        title: serverHlc,
        done: serverHlc,
      });
      const serverClock = HLC.tick(HLC.zero(), 9000);
      client.sync(makeServerResponse([serverDoc], serverClock), 9000);

      // Record rev snapshot before no-op re-edit
      const revsBeforeReEdit = { ...client.docs['todos/1'].fieldRevs };

      // Re-edit with identical values — nothing changed
      client.edit('todos/1', { title: 'A', done: false }, 10000);

      // fieldRevs must not have changed (diff produced no changed fields)
      assert.deepEqual(client.docs['todos/1'].fieldRevs, revsBeforeReEdit);
    });

    it('getChanges() after sync reflects the updated baseClock', () => {
      const client = new SyncClient('rt', 1000);
      const serverClock = HLC.tick(HLC.zero(), 5000);
      client.sync(makeServerResponse([], serverClock), 5000);

      client.edit('todos/1', { title: 'New' }, 6000);
      const [entry] = client.getChanges();
      assert.equal(entry.baseClock, serverClock);
    });
  });

  // ── getSnapshot() / fromSnapshot() ──────────────────────────────────────────

  describe('getSnapshot() / fromSnapshot()', () => {
    it('getSnapshot() returns a plain JS object with required fields', () => {
      const client = new SyncClient('snap-node', 1000);
      client.edit('k', { a: 1 }, 1000);
      const snap = client.getSnapshot();
      assert.isObject(snap);
      assert.property(snap, 'nodeId');
      assert.property(snap, 'clock');
      assert.property(snap, 'baseClock');
      assert.property(snap, 'docs');
      assert.property(snap, 'lastSyncAt');
    });

    it('getSnapshot().nodeId matches the nodeId passed to constructor', () => {
      const client = new SyncClient('my-device', 1000);
      const snap = client.getSnapshot();
      assert.equal(snap.nodeId, 'my-device');
    });

    it('getSnapshot() captures the current clock value', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k', { v: 1 }, 1000);
      const snap = client.getSnapshot();
      assert.equal(snap.clock, client.clock);
    });

    it('getSnapshot() captures baseClock, docs, and lastSyncAt', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k', { v: 1 }, 1000);
      client.sync(makeServerResponse([], HLC.tick(HLC.zero(), 5000)), 5000);

      const snap = client.getSnapshot();
      assert.equal(snap.baseClock, client.baseClock);
      assert.deepEqual(snap.docs, client.docs);
      assert.equal(snap.lastSyncAt, client.lastSyncAt);
    });

    it('fromSnapshot() restores a client with identical state', () => {
      const original = new SyncClient('device-a', 1000);
      original.edit('todos/1', { title: 'Task' }, 1000);
      const serverClock = HLC.tick(HLC.zero(), 5000);
      original.sync(makeServerResponse([], serverClock), 5000);

      const snap = original.getSnapshot();
      const restored = SyncClient.fromSnapshot(snap);

      assert.equal(restored.clock, original.clock);
      assert.equal(restored.baseClock, original.baseClock);
      assert.deepEqual(restored.docs, original.docs);
      assert.equal(restored.lastSyncAt, original.lastSyncAt);
    });

    it('fromSnapshot() preserves nodeId (decoded from clock)', () => {
      const original = new SyncClient('my-device-id', 1000);
      const snap = original.getSnapshot();
      const restored = SyncClient.fromSnapshot(snap);
      assert.equal(HLC.decode(restored.clock).node, 'my-device-id');
    });

    it('snapshot-restored client can continue editing', () => {
      const original = new SyncClient('n', 1000);
      original.edit('k', { v: 1 }, 1000);
      const restored = SyncClient.fromSnapshot(original.getSnapshot());

      // Edit on the restored client
      restored.edit('k', { v: 2 }, 2000);
      assert.equal(restored.docs['k'].doc.v, 2);
      // Clock must have advanced beyond the snapshot's clock
      assert.isAbove(HLC.compare(restored.clock, original.clock), 0);
    });

    it('snapshot-restored client can sync correctly', () => {
      const original = new SyncClient('n', 1000);
      original.edit('k', { v: 1 }, 1000);
      const restored = SyncClient.fromSnapshot(original.getSnapshot());

      const serverClock = HLC.tick(HLC.zero(), 9000);
      restored.sync(makeServerResponse([], serverClock), 9000);

      assert.equal(restored.baseClock, serverClock);
      assert.isNumber(restored.lastSyncAt);
    });

    it('getSnapshot() returns a serialisable (JSON round-trippable) object', () => {
      const client = new SyncClient('n', 1000);
      client.edit('k', { v: 1 }, 1000);
      const snap = client.getSnapshot();
      const json = JSON.stringify(snap);
      const parsed = JSON.parse(json);
      assert.deepEqual(parsed, snap);
    });
  });

  // ── two-client bidirectional sync ────────────────────────────────────────────

  describe('two-client bidirectional sync', () => {

    it('two clients editing different fields converge after mutual sync', () => {
      const mockServer = createMockServer();
      const clientA = new SyncClient('device-a', 1000);
      const clientB = new SyncClient('device-b', 1000);

      // Seed an initial doc via clientA so both clients share a common baseSnapshot
      clientA.edit('doc/1', { title: 'Original', note: 'Original' }, 1000);
      const respSeed = mockServer.sync(clientA.getChanges(), 2000);
      clientA.sync(respSeed, 2000);

      // clientB pulls the initial doc — now both have the same baseSnapshot
      const respBSeed = mockServer.sync([], 2000);
      clientB.sync(respBSeed, 2000);

      // Now each client edits only their own field (diff against baseSnapshot
      // means only changed fields get a new fieldRev)
      clientA.edit('doc/1', { title: 'A title', note: 'Original' }, 3000);
      clientB.edit('doc/1', { title: 'Original', note: 'B note' }, 4000);

      // Both push their changes to the server
      const respA = mockServer.sync(clientA.getChanges(), 5000);
      clientA.sync(respA, 5000);

      const respB = mockServer.sync(clientB.getChanges(), 6000);
      clientB.sync(respB, 6000);

      // Client A syncs again to receive B's note
      const respA2 = mockServer.sync(clientA.getChanges(), 7000);
      clientA.sync(respA2, 7000);

      assert.equal(clientA.docs['doc/1'].doc.title, 'A title');
      assert.equal(clientA.docs['doc/1'].doc.note, 'B note');
      assert.equal(clientB.docs['doc/1'].doc.title, 'A title');
      assert.equal(clientB.docs['doc/1'].doc.note, 'B note');
    });

    it('two clients editing the same field — higher HLC wins, both converge', () => {
      const mockServer = createMockServer();
      const clientA = new SyncClient('device-a', 1000);
      const clientB = new SyncClient('device-b', 9000);

      clientA.edit('doc/1', { title: 'A wins?' }, 1000);
      clientB.edit('doc/1', { title: 'B wins' }, 9000);

      mockServer.sync(clientA.getChanges(), 10000);
      const respB = mockServer.sync(clientB.getChanges(), 10000);
      clientB.sync(respB, 10000);

      const respA = mockServer.sync(clientA.getChanges(), 11000);
      clientA.sync(respA, 11000);

      const respB2 = mockServer.sync(clientB.getChanges(), 12000);
      clientB.sync(respB2, 12000);

      assert.equal(clientA.docs['doc/1'].doc.title, 'B wins');
      assert.equal(clientB.docs['doc/1'].doc.title, 'B wins');
    });

    it('offline client catches up in a single sync after reconnect', () => {
      const mockServer = createMockServer();
      const clientA = new SyncClient('device-a', 1000);
      const clientB = new SyncClient('device-b', 2000);

      // Client B makes 3 edits while offline
      clientB.edit('doc/1', { v: 1 }, 2000);
      clientB.edit('doc/1', { v: 2 }, 3000);
      clientB.edit('doc/1', { v: 3 }, 4000);

      // Client A syncs normally
      clientA.edit('doc/1', { v: 0, extra: 'from-a' }, 1000);
      const respA = mockServer.sync(clientA.getChanges(), 5000);
      clientA.sync(respA, 5000);

      // Client B reconnects — single sync
      const respB = mockServer.sync(clientB.getChanges(), 6000);
      clientB.sync(respB, 6000);

      // Client A gets B's changes
      const respA2 = mockServer.sync(clientA.getChanges(), 7000);
      clientA.sync(respA2, 7000);

      assert.equal(clientA.docs['doc/1'].doc.v, 3);
      assert.equal(clientA.docs['doc/1'].doc.extra, 'from-a');
      assert.equal(clientB.docs['doc/1'].doc.v, 3);
      assert.equal(clientB.docs['doc/1'].doc.extra, 'from-a');
    });

    it('server-as-client symmetry: both sides use SyncClient, both converge to identical result', () => {
      const side1 = new SyncClient('side-1', 1000);
      const side2 = new SyncClient('side-2', 2000);

      side1.edit('doc/1', { a: 1, b: 0 }, 1000);
      side2.edit('doc/1', { a: 0, b: 2 }, 2000);

      // side2 acts as server — receives side1's changes
      const changes1 = side1.getChanges();
      side2.sync({
        serverClock: HLC.tick(HLC.zero(), 5000),
        serverChanges: changes1.map(c => ({ _key: c.key, _fieldRevs: c.fieldRevs, ...c.doc })),
      }, 5000);

      // side1 acts as server — receives side2's merged changes
      const changes2 = side2.getChanges();
      side1.sync({
        serverClock: HLC.tick(HLC.zero(), 6000),
        serverChanges: changes2.map(c => ({ _key: c.key, _fieldRevs: c.fieldRevs, ...c.doc })),
      }, 6000);

      assert.deepEqual(
        side1.docs['doc/1'].doc,
        side2.docs['doc/1'].doc,
        'Both sides must converge regardless of which is labelled server or client'
      );
    });

    it('snapshot round-trip preserves sync ability across serialisation boundary', () => {
      const mockServer = createMockServer();
      const clientA = new SyncClient('device-a', 1000);

      clientA.edit('doc/1', { title: 'Before snap' }, 1000);
      const resp1 = mockServer.sync(clientA.getChanges(), 2000);
      clientA.sync(resp1, 2000);

      // Simulate tab close + reopen via JSON round-trip
      const snap = JSON.parse(JSON.stringify(clientA.getSnapshot()));
      const restored = SyncClient.fromSnapshot(snap);

      restored.edit('doc/1', { title: 'After snap' }, 3000);
      const resp2 = mockServer.sync(restored.getChanges(), 4000);
      restored.sync(resp2, 4000);

      assert.equal(restored.docs['doc/1'].doc.title, 'After snap');
      assert.equal(mockServer.docs['doc/1'].doc.title, 'After snap');
    });

  });

  // ── isomorphism audit ────────────────────────────────────────────────────────

  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = [
      'node:fs', 'node:path', 'node:crypto', 'node:process',
      "'fs'", "'path'", "'crypto'",
      '"fs"', '"path"', '"crypto"',
      'Buffer.', 'process.env', '__dirname', '__filename', 'require(',
    ];

    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(syncClientSource, forbidden,
          `SyncClient.js must not contain "${forbidden}" — it must remain isomorphic`);
      });
    }
  });

});
