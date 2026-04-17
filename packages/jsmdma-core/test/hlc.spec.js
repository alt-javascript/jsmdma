/**
 * hlc.spec.js — Mocha tests for HLC (Hybrid Logical Clock)
 *
 * Covers: tick, recv, merge, compare, encode/decode, zero, create.
 * Also verifies hlc.js has no Node-specific imports.
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import HLC from '../hlc.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const hlcSource = readFileSync(join(__dir, '../hlc.js'), 'utf-8');

describe('HLC', () => {

  // ── zero ────────────────────────────────────────────────────────────────────

  describe('zero()', () => {
    it('returns a string of the expected length and format', () => {
      const z = HLC.zero();
      assert.match(z, /^0{13}-0{6}-[^-]+$/);
    });

    it('is less than any real clock', () => {
      const real = HLC.tick(HLC.zero(), 1);
      assert.isBelow(HLC.compare(HLC.zero(), real), 0);
    });
  });

  // ── create ──────────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('encodes the given node ID', () => {
      const c = HLC.create('node-abc', 5000);
      const d = HLC.decode(c);
      assert.equal(d.node, 'node-abc');
      assert.equal(d.ms, 5000);
      assert.equal(d.seq, 0);
    });
  });

  // ── encode / decode ──────────────────────────────────────────────────────────

  describe('encode / decode', () => {
    it('round-trips correctly for typical values', () => {
      const state = { ms: 1_700_000_000_000, seq: 42, node: 'abc123' };
      const encoded = HLC.encode(state);
      const decoded = HLC.decode(encoded);
      assert.equal(decoded.ms, state.ms);
      assert.equal(decoded.seq, state.seq);
      assert.equal(decoded.node, state.node);
    });

    it('round-trips correctly for zero values', () => {
      const state = { ms: 0, seq: 0, node: 'x' };
      const encoded = HLC.encode(state);
      const decoded = HLC.decode(encoded);
      assert.equal(decoded.ms, 0);
      assert.equal(decoded.seq, 0);
      assert.equal(decoded.node, 'x');
    });

    it('round-trips correctly for maximum expected seq', () => {
      const state = { ms: 1_000_000_000, seq: 0xFFFFFF, node: 'n1' };
      const encoded = HLC.encode(state);
      const decoded = HLC.decode(encoded);
      assert.equal(decoded.seq, 0xFFFFFF);
    });

    it('decode throws on invalid format', () => {
      assert.throws(() => HLC.decode('badstring'), /invalid format/);
    });

    it('node can contain hyphens (UUID format)', () => {
      const state = { ms: 1000, seq: 0, node: '550e8400-e29b-41d4-a716-446655440000' };
      const encoded = HLC.encode(state);
      const decoded = HLC.decode(encoded);
      assert.equal(decoded.node, '550e8400-e29b-41d4-a716-446655440000');
    });
  });

  // ── tick ─────────────────────────────────────────────────────────────────────

  describe('tick()', () => {
    it('advances seq when wall clock has not moved', () => {
      const t0 = HLC.tick(HLC.zero(), 1000);
      const t1 = HLC.tick(t0, 1000);
      const d0 = HLC.decode(t0);
      const d1 = HLC.decode(t1);
      assert.equal(d1.ms, d0.ms);
      assert.equal(d1.seq, d0.seq + 1);
    });

    it('resets seq to 0 when wall clock advances', () => {
      const t0 = HLC.tick(HLC.zero(), 1000);
      // bump seq a few times
      const t1 = HLC.tick(t0, 1000);
      const t2 = HLC.tick(t1, 1000);
      // now wall advances
      const t3 = HLC.tick(t2, 2000);
      const d3 = HLC.decode(t3);
      assert.equal(d3.ms, 2000);
      assert.equal(d3.seq, 0);
    });

    it('is strictly monotonic across 1000 same-ms ticks', () => {
      let prev = HLC.zero();
      for (let i = 0; i < 1000; i++) {
        const next = HLC.tick(prev, 5000);
        assert.isAbove(HLC.compare(next, prev), 0, `tick ${i} not monotonic`);
        prev = next;
      }
    });

    it('is strictly monotonic as wall clock advances', () => {
      let prev = HLC.zero();
      for (let ms = 1; ms <= 100; ms++) {
        const next = HLC.tick(prev, ms);
        assert.isAbove(HLC.compare(next, prev), 0);
        prev = next;
      }
    });

    it('preserves node ID', () => {
      const init = HLC.create('my-node', 1000);
      const ticked = HLC.tick(init, 1000);
      assert.equal(HLC.decode(ticked).node, 'my-node');
    });
  });

  // ── recv ──────────────────────────────────────────────────────────────────────

  describe('recv()', () => {
    it('advances beyond remote when remote is ahead', () => {
      const local  = HLC.tick(HLC.zero(), 1000);
      const remote = HLC.tick(HLC.zero(), 5000);
      const after  = HLC.recv(local, remote, 500);
      const d = HLC.decode(after);
      assert.isAtLeast(d.ms, 5000);
    });

    it('advances beyond local when local is ahead', () => {
      const local  = HLC.tick(HLC.zero(), 5000);
      const remote = HLC.tick(HLC.zero(), 1000);
      const after  = HLC.recv(local, remote, 500);
      const d = HLC.decode(after);
      assert.isAtLeast(d.ms, 5000);
    });

    it('uses wall clock when it is the maximum', () => {
      const local  = HLC.tick(HLC.zero(), 100);
      const remote = HLC.tick(HLC.zero(), 200);
      const after  = HLC.recv(local, remote, 9999);
      const d = HLC.decode(after);
      assert.equal(d.ms, 9999);
      assert.equal(d.seq, 0);
    });

    it('returns a clock strictly greater than both inputs when ms matches', () => {
      const base   = HLC.tick(HLC.zero(), 1000);
      // create remote at same ms
      const remote = HLC.tick(base, 1000);
      const after  = HLC.recv(base, remote, 1000);
      assert.isAbove(HLC.compare(after, base),   0);
      assert.isAbove(HLC.compare(after, remote),  0);
    });

    it('preserves local node ID in output', () => {
      const local  = HLC.create('local-node', 1000);
      const remote = HLC.create('remote-node', 2000);
      const after  = HLC.recv(local, remote, 500);
      assert.equal(HLC.decode(after).node, 'local-node');
    });
  });

  // ── merge ────────────────────────────────────────────────────────────────────

  describe('merge()', () => {
    it('returns the larger of two clocks', () => {
      const a = HLC.tick(HLC.zero(), 1000);
      const b = HLC.tick(HLC.zero(), 2000);
      assert.equal(HLC.merge(a, b), b);
      assert.equal(HLC.merge(b, a), b);
    });

    it('returns the same value when both are equal', () => {
      const a = HLC.tick(HLC.zero(), 1000);
      assert.equal(HLC.merge(a, a), a);
    });
  });

  // ── compare ──────────────────────────────────────────────────────────────────

  describe('compare()', () => {
    it('returns -1 when a < b', () => {
      const a = HLC.tick(HLC.zero(), 1000);
      const b = HLC.tick(HLC.zero(), 2000);
      assert.equal(HLC.compare(a, b), -1);
    });

    it('returns 1 when a > b', () => {
      const a = HLC.tick(HLC.zero(), 2000);
      const b = HLC.tick(HLC.zero(), 1000);
      assert.equal(HLC.compare(a, b), 1);
    });

    it('returns 0 for identical clocks', () => {
      const a = HLC.tick(HLC.zero(), 1000);
      assert.equal(HLC.compare(a, a), 0);
    });

    it('is consistent with Array.sort()', () => {
      const clocks = [];
      let prev = HLC.zero();
      for (let i = 0; i < 10; i++) {
        const next = HLC.tick(prev, 1000 + i * 100);
        clocks.push(next);
        prev = next;
      }
      const shuffled = [...clocks].sort(() => Math.random() - 0.5);
      shuffled.sort((a, b) => HLC.compare(a, b));
      assert.deepEqual(shuffled, clocks);
    });
  });

  // ── isomorphism audit ────────────────────────────────────────────────────────

  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = ['node:fs', 'node:path', 'node:crypto', 'node:process',
      "'fs'", "'path'", "'crypto'", "'process'", '"fs"', '"path"', '"crypto"', '"process"',
      'Buffer.', 'process.env', '__dirname', '__filename', 'require('];

    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(hlcSource, forbidden,
          `hlc.js must not contain "${forbidden}" — it must remain isomorphic`);
      });
    }
  });

});
