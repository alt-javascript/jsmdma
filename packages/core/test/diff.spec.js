/**
 * diff.spec.js — Mocha tests for diff()
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import HLC from '../hlc.js';
import diff from '../diff.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const diffSource = readFileSync(join(__dir, '../diff.js'), 'utf-8');

describe('diff()', () => {

  const NOW = HLC.tick(HLC.zero(), 5000);

  // ── basic detection ──────────────────────────────────────────────────────────

  it('detects a changed field', () => {
    const base    = { score: 10 };
    const current = { score: 20 };
    const result  = diff(base, current, {}, NOW);
    assert.property(result.changed, 'score');
    assert.equal(result.changed.score.old, 10);
    assert.equal(result.changed.score.new, 20);
  });

  it('stamps changed fields with hlcNow', () => {
    const base    = { x: 1 };
    const current = { x: 2 };
    const result  = diff(base, current, {}, NOW);
    assert.equal(result.changed.x.rev, NOW);
  });

  it('puts unchanged fields in the unchanged array', () => {
    const base    = { a: 1, b: 2 };
    const current = { a: 1, b: 3 };
    const result  = diff(base, current, {}, NOW);
    assert.include(result.unchanged, 'a');
    assert.notProperty(result.changed, 'a');
  });

  it('returns empty changed for identical documents', () => {
    const doc    = { a: 1, b: 'hello', c: true };
    const result = diff(doc, { ...doc }, {}, NOW);
    assert.deepEqual(result.changed, {});
    assert.sameMembers(result.unchanged, ['a', 'b', 'c']);
  });

  it('detects a deleted field (new: undefined)', () => {
    const base    = { a: 1, b: 2 };
    const current = { a: 1 };
    const result  = diff(base, current, {}, NOW);
    assert.property(result.changed, 'b');
    assert.equal(result.changed.b.old, 2);
    assert.equal(result.changed.b.new, undefined);
  });

  it('detects a new field added by current (old: undefined)', () => {
    const base    = { a: 1 };
    const current = { a: 1, b: 99 };
    const result  = diff(base, current, {}, NOW);
    assert.property(result.changed, 'b');
    assert.equal(result.changed.b.old, undefined);
    assert.equal(result.changed.b.new, 99);
  });

  // ── private field exclusion ──────────────────────────────────────────────────

  it('excludes private fields (starting with _) from diff', () => {
    const base    = { name: 'Alice', _rev: 'old', _fieldRevs: {} };
    const current = { name: 'Alice', _rev: 'new', _fieldRevs: { x: 'y' } };
    const result  = diff(base, current, {}, NOW);
    assert.notProperty(result.changed, '_rev');
    assert.notProperty(result.changed, '_fieldRevs');
    assert.notInclude(result.unchanged, '_rev');
  });

  // ── multiple fields ──────────────────────────────────────────────────────────

  it('handles multiple changed and unchanged fields', () => {
    const base    = { a: 1, b: 2, c: 3, d: 4 };
    const current = { a: 1, b: 9, c: 3, d: 8 };
    const result  = diff(base, current, {}, NOW);
    assert.sameMembers(Object.keys(result.changed), ['b', 'd']);
    assert.sameMembers(result.unchanged, ['a', 'c']);
  });

  // ── null / undefined base ────────────────────────────────────────────────────

  it('treats null base as empty document', () => {
    const current = { a: 1 };
    const result  = diff(null, current, {}, NOW);
    assert.property(result.changed, 'a');
    assert.equal(result.changed.a.old, undefined);
    assert.equal(result.changed.a.new, 1);
  });

  // ── isomorphism audit ────────────────────────────────────────────────────────

  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = ['node:fs', 'node:path', 'node:crypto', "'fs'", "'path'", "'crypto'",
      '"fs"', '"path"', '"crypto"', 'Buffer.', 'process.env', 'require('];
    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(diffSource, forbidden);
      });
    }
  });

});
