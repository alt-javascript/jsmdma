/**
 * merge.spec.js — Mocha tests for merge()
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import HLC from '../hlc.js';
import merge from '../merge.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const mergeSource = readFileSync(join(__dir, '../merge.js'), 'utf-8');

describe('merge()', () => {

  // Establish two causally-ordered clocks: tEarly < tLate
  const tEarly = HLC.tick(HLC.zero(), 1000);
  const tLate  = HLC.tick(HLC.zero(), 2000);

  function makeLocal(doc, fieldRevs = {})  { return { doc, fieldRevs }; }
  function makeRemote(doc, fieldRevs = {}) { return { doc, fieldRevs }; }

  // ── no conflicts ─────────────────────────────────────────────────────────────

  it('returns empty conflicts when no field is changed by both sides', () => {
    const base   = { a: 1, b: 2, c: 3 };
    const local  = makeLocal( { a: 9, b: 2, c: 3 }, { a: tEarly });
    const remote = makeRemote({ a: 1, b: 8, c: 3 }, { b: tLate  });
    const { merged, conflicts } = merge(base, local, remote);
    assert.isEmpty(conflicts);
    assert.equal(merged.a, 9); // only local changed
    assert.equal(merged.b, 8); // only remote changed
    assert.equal(merged.c, 3); // neither changed
  });

  it('applies only-local changes', () => {
    const base   = { x: 1 };
    const local  = makeLocal( { x: 42 }, { x: tEarly });
    const remote = makeRemote({ x: 1  }, {});
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.x, 42);
    assert.isEmpty(conflicts);
  });

  it('applies only-remote changes', () => {
    const base   = { x: 1 };
    const local  = makeLocal( { x: 1  }, {});
    const remote = makeRemote({ x: 77 }, { x: tLate });
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.x, 77);
    assert.isEmpty(conflicts);
  });

  it('leaves unchanged fields at their base value', () => {
    const base   = { keep: 'yes', change: 'no' };
    const local  = makeLocal( { keep: 'yes', change: 'local-new'  }, { change: tEarly });
    const remote = makeRemote({ keep: 'yes', change: 'remote-new' }, { change: tLate  });
    const { merged } = merge(base, local, remote);
    assert.equal(merged.keep, 'yes');
  });

  it('handles multi-field non-conflicting mix', () => {
    const base   = { a: 1, b: 2, c: 3, d: 4 };
    const local  = makeLocal( { a: 10, b: 2,  c: 3,  d: 4  }, { a: tEarly });
    const remote = makeRemote({ a: 1,  b: 20, c: 3,  d: 40 }, { b: tLate, d: tLate });
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.a, 10);
    assert.equal(merged.b, 20);
    assert.equal(merged.c, 3);
    assert.equal(merged.d, 40);
    assert.isEmpty(conflicts);
  });

  // ── conflict: remote wins ────────────────────────────────────────────────────

  it('resolves conflict to remote when remote HLC is higher', () => {
    const base   = { tag: 'original' };
    const local  = makeLocal( { tag: 'local-edit'  }, { tag: tEarly });
    const remote = makeRemote({ tag: 'remote-edit' }, { tag: tLate  });
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.tag, 'remote-edit');
    assert.lengthOf(conflicts, 1);
    assert.equal(conflicts[0].winner, 'remote');
    assert.equal(conflicts[0].winnerValue, 'remote-edit');
  });

  // ── conflict: local wins ─────────────────────────────────────────────────────

  it('resolves conflict to local when local HLC is higher', () => {
    const base   = { tag: 'original' };
    const local  = makeLocal( { tag: 'local-edit'  }, { tag: tLate  });
    const remote = makeRemote({ tag: 'remote-edit' }, { tag: tEarly });
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.tag, 'local-edit');
    assert.equal(conflicts[0].winner, 'local');
  });

  // ── conflict: tie-break (equal HLC → local wins) ─────────────────────────────

  it('local wins on equal HLC (stable tie-break)', () => {
    const base   = { x: 0 };
    const local  = makeLocal( { x: 'local-val'  }, { x: tEarly });
    const remote = makeRemote({ x: 'remote-val' }, { x: tEarly }); // same clock
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.x, 'local-val');
    assert.equal(conflicts[0].winner, 'local');
  });

  // ── conflict: structured output ──────────────────────────────────────────────

  it('conflict object has all required fields', () => {
    const base   = { f: 'base' };
    const local  = makeLocal( { f: 'L' }, { f: tEarly });
    const remote = makeRemote({ f: 'R' }, { f: tLate  });
    const { conflicts } = merge(base, local, remote);
    const c = conflicts[0];
    assert.property(c, 'field');
    assert.property(c, 'localRev');
    assert.property(c, 'remoteRev');
    assert.property(c, 'localValue');
    assert.property(c, 'remoteValue');
    assert.property(c, 'winner');
    assert.property(c, 'winnerValue');
    assert.equal(c.field, 'f');
    assert.equal(c.localValue, 'L');
    assert.equal(c.remoteValue, 'R');
    assert.equal(c.winnerValue, 'R'); // remote wins
  });

  it('reports multiple conflicts when multiple fields both changed', () => {
    const base   = { a: 1, b: 2 };
    const local  = makeLocal( { a: 10, b: 20 }, { a: tEarly, b: tLate  });
    const remote = makeRemote({ a: 11, b: 21 }, { a: tLate,  b: tEarly });
    const { conflicts } = merge(base, local, remote);
    assert.lengthOf(conflicts, 2);
    const fields = conflicts.map(c => c.field).sort();
    assert.deepEqual(fields, ['a', 'b']);
  });

  // ── private field exclusion ──────────────────────────────────────────────────

  it('excludes private fields (_ prefix) from merge output', () => {
    const base   = { name: 'Alice', _rev: 'old' };
    const local  = makeLocal( { name: 'Alice', _rev: 'local-rev'  }, {});
    const remote = makeRemote({ name: 'Alice', _rev: 'remote-rev' }, {});
    const { merged } = merge(base, local, remote);
    assert.notProperty(merged, '_rev');
  });

  // ── missing fieldRevs fallback ───────────────────────────────────────────────

  it('falls back to HLC.zero() when fieldRevs is missing for a field', () => {
    // Both changed 'x' but neither has a fieldRev for it
    // → both fall back to zero() → tie → local wins
    const base   = { x: 0 };
    const local  = makeLocal( { x: 'L' }, {}); // no fieldRevs
    const remote = makeRemote({ x: 'R' }, {}); // no fieldRevs
    const { merged, conflicts } = merge(base, local, remote);
    assert.equal(merged.x, 'L'); // local wins tie
    assert.lengthOf(conflicts, 1);
  });

  // ── text auto-merge (string fields) ──────────────────────────────────────────

  it('auto-merges string field with non-overlapping line changes', () => {
    const base   = { notes: 'line1\nline2\nline3' };
    const local  = makeLocal(
      { notes: 'LOCAL-HEADER\nline1\nline2\nline3' },
      { notes: tEarly },
    );
    const remote = makeRemote(
      { notes: 'line1\nline2\nline3\nREMOTE-FOOTER' },
      { notes: tLate },
    );
    const { merged, conflicts } = merge(base, local, remote);
    assert.include(merged.notes, 'LOCAL-HEADER');
    assert.include(merged.notes, 'REMOTE-FOOTER');
    assert.include(merged.notes, 'line1');
    assert.lengthOf(conflicts, 1);
    assert.equal(conflicts[0].winner,        'auto-merged');
    assert.equal(conflicts[0].mergeStrategy, 'text-auto-merged');
  });

  it('falls back to HLC winner for string field with overlapping line changes', () => {
    const base   = { notes: 'unchanged\ncontest\nend' };
    const local  = makeLocal(
      { notes: 'unchanged\nlocal-version\nend' },
      { notes: tEarly },
    );
    const remote = makeRemote(
      { notes: 'unchanged\nremote-version\nend' },
      { notes: tLate },
    );
    const { merged, conflicts } = merge(base, local, remote);
    // tLate > tEarly → remote wins
    assert.equal(merged.notes, 'unchanged\nremote-version\nend');
    assert.lengthOf(conflicts, 1);
    assert.equal(conflicts[0].winner, 'remote');
    assert.isUndefined(conflicts[0].mergeStrategy);
  });

  it('applies HLC winner logic unchanged for non-string conflicting fields', () => {
    const base   = { count: 1 };
    const local  = makeLocal(  { count: 10 }, { count: tLate  });
    const remote = makeRemote( { count: 99 }, { count: tEarly });
    const { merged, conflicts } = merge(base, local, remote);
    // tLate > tEarly → local wins
    assert.equal(merged.count, 10);
    assert.equal(conflicts[0].winner, 'local');
    assert.isUndefined(conflicts[0].mergeStrategy);
  });

  // ── isomorphism audit ────────────────────────────────────────────────────────

  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = ['node:fs', 'node:path', 'node:crypto', "'fs'", "'path'", "'crypto'",
      '"fs"', '"path"', '"crypto"', 'Buffer.', 'process.env', 'require('];
    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(mergeSource, forbidden);
      });
    }
  });

});
