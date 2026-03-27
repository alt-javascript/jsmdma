/**
 * SyncRepository.spec.js — Integration tests for SyncRepository
 *
 * Uses jsnosqlc-memory driver. All tests run against a fresh client per suite.
 */
import { assert } from 'chai';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import '@alt-javascript/jsnosqlc-memory'; // self-registers MemoryDriver
import { HLC } from '@alt-javascript/data-api-core';
import SyncRepository from '../SyncRepository.js';

async function makeRepo() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  return new SyncRepository(client);
}

describe('SyncRepository', () => {

  // ── store / get ──────────────────────────────────────────────────────────────

  it('store() persists a document with _rev and _fieldRevs', async () => {
    const repo = await makeRepo();
    const hlc  = HLC.tick(HLC.zero(), 1000);
    const fieldRevs = { name: hlc };

    await repo.store('docs', 'doc-1', { name: 'Alice' }, fieldRevs, hlc);
    const doc = await repo.get('docs', 'doc-1');

    assert.isNotNull(doc);
    assert.equal(doc.name,    'Alice');
    assert.equal(doc._rev,    hlc);
    assert.deepEqual(doc._fieldRevs, fieldRevs);
    assert.equal(doc._key,    'doc-1');
  });

  it('get() returns null for an unknown key', async () => {
    const repo = await makeRepo();
    const doc  = await repo.get('docs', 'no-such-key');
    assert.isNull(doc);
  });

  it('store() overwrites an existing document on the same key', async () => {
    const repo = await makeRepo();
    const t1 = HLC.tick(HLC.zero(), 1000);
    const t2 = HLC.tick(t1,        2000);

    await repo.store('docs', 'key-1', { val: 'first'  }, { val: t1 }, t1);
    await repo.store('docs', 'key-1', { val: 'second' }, { val: t2 }, t2);

    const doc = await repo.get('docs', 'key-1');
    assert.equal(doc.val,  'second');
    assert.equal(doc._rev, t2);
  });

  it('store() preserves _fieldRevs correctly', async () => {
    const repo = await makeRepo();
    const t1   = HLC.tick(HLC.zero(), 1000);
    const fieldRevs = { a: t1, b: t1 };

    await repo.store('docs', 'k', { a: 1, b: 2 }, fieldRevs, t1);
    const doc = await repo.get('docs', 'k');

    assert.deepEqual(doc._fieldRevs, fieldRevs);
  });

  // ── changesSince ─────────────────────────────────────────────────────────────

  it('changesSince() returns only docs with _rev > clientClock', async () => {
    const repo = await makeRepo();

    // Store 5 docs at t1..t5
    let clock = HLC.zero();
    const clocks = [];
    for (let i = 1; i <= 5; i++) {
      clock = HLC.tick(clock, i * 1000);
      clocks.push(clock);
      await repo.store('items', `item-${i}`, { n: i }, { n: clock }, clock);
    }

    // Query with t3 as clientClock → should return docs at t4 and t5
    const results = await repo.changesSince('items', clocks[2]);
    assert.lengthOf(results, 2);
    const ns = results.map(d => d.n).sort();
    assert.deepEqual(ns, [4, 5]);
  });

  it('changesSince() with HLC.zero() returns all documents', async () => {
    const repo = await makeRepo();

    let clock = HLC.zero();
    for (let i = 1; i <= 3; i++) {
      clock = HLC.tick(clock, i * 1000);
      await repo.store('things', `t-${i}`, { i }, {}, clock);
    }

    const results = await repo.changesSince('things', HLC.zero());
    assert.lengthOf(results, 3);
  });

  it('changesSince() with clock equal to latest _rev returns empty (gt not gte)', async () => {
    const repo = await makeRepo();

    const t1 = HLC.tick(HLC.zero(), 1000);
    await repo.store('solo', 'only-doc', { x: 1 }, {}, t1);

    // Query with exactly t1 — should return nothing (strictly greater than)
    const results = await repo.changesSince('solo', t1);
    assert.isEmpty(results);
  });

  it('changesSince() on an empty collection returns empty array', async () => {
    const repo = await makeRepo();
    const results = await repo.changesSince('empty-collection', HLC.zero());
    assert.isArray(results);
    assert.isEmpty(results);
  });

});
