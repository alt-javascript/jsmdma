/**
 * flatten.spec.js — Mocha tests for flatten() and unflatten()
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { flatten, unflatten } from '../flatten.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const flattenSource = readFileSync(join(__dir, '../flatten.js'), 'utf-8');

describe('flatten() and unflatten()', () => {

  // 1. Simple nested object round-trips
  it('round-trips a simple nested object', () => {
    const obj = { a: { b: 1 } };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a.b': 1 });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 2. 3-level deep nesting
  it('round-trips 3-level deep nesting', () => {
    const obj = { a: { b: { c: 42 } } };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a.b.c': 42 });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 3. Key with literal dot encodes as %2E and round-trips
  it('encodes literal dots in key names as %2E and round-trips', () => {
    const obj = { 'a.b': 'dotted-key' };
    const flat = flatten(obj);
    assert.property(flat, 'a%2Eb');
    assert.equal(flat['a%2Eb'], 'dotted-key');
    const restored = unflatten(flat);
    assert.property(restored, 'a.b');
    assert.equal(restored['a.b'], 'dotted-key');
  });

  // 4. Null leaf value
  it('preserves null as a leaf value', () => {
    const obj = { a: { b: null } };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a.b': null });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 5. Array as leaf value (not traversed)
  it('treats arrays as opaque leaf values and does not recurse into them', () => {
    const arr = [1, 2, 3];
    const obj = { a: { tags: arr } };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a.tags': arr });
    // array identity preserved in the flat map
    assert.strictEqual(flat['a.tags'], arr);
    const restored = unflatten(flat);
    assert.deepEqual(restored, obj);
  });

  // 6. Empty object as leaf value (treated as leaf since no keys)
  it('treats an empty object as a leaf value', () => {
    const obj = { a: {} };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a': {} });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 7. Empty string value
  it('preserves empty string as a leaf value', () => {
    const obj = { a: { b: '' } };
    const flat = flatten(obj);
    assert.deepEqual(flat, { 'a.b': '' });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 8. Private fields excluded (keys starting with _)
  it('excludes private fields (starting with _) from flatten', () => {
    const obj = { name: 'Alice', _rev: 'xyz', nested: { _internal: 42, value: 1 } };
    const flat = flatten(obj);
    assert.notProperty(flat, '_rev');
    assert.notProperty(flat, 'nested._internal');
    assert.property(flat, 'name');
    assert.property(flat, 'nested.value');
  });

  it('excludes private fields (starting with _) from unflatten', () => {
    const flat = { 'name': 'Alice', '_rev': 'xyz' };
    const obj = unflatten(flat);
    assert.notProperty(obj, '_rev');
    assert.property(obj, 'name');
  });

  // 9. Flat (depth-1) object — same as before
  it('is a no-op for a flat depth-1 object', () => {
    const obj = { a: 1, b: 'hello', c: true };
    const flat = flatten(obj);
    assert.deepEqual(flat, { a: 1, b: 'hello', c: true });
    assert.deepEqual(unflatten(flat), obj);
  });

  // 10. Isomorphism audit — no Node-specific imports
  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = ['node:fs', 'node:path', 'node:crypto', "'fs'", "'path'", "'crypto'",
      '"fs"', '"path"', '"crypto"', 'Buffer.', 'process.env', 'require('];
    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(flattenSource, forbidden);
      });
    }
  });

});
