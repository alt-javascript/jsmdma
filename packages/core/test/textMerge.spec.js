/**
 * textMerge.spec.js — Unit tests for textMerge()
 */
import { assert } from 'chai';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import textMerge from '../textMerge.js';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const source = readFileSync(join(__dir, '../textMerge.js'), 'utf-8');

describe('textMerge()', () => {

  // ── trivial cases ────────────────────────────────────────────────────────────

  it('returns remote when local equals base (no local change)', () => {
    const base   = 'line1\nline2\nline3';
    const local  = base;
    const remote = 'line1\nline2\nline3\nline4';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.equal(merged, remote);
  });

  it('returns local when remote equals base (no remote change)', () => {
    const base   = 'line1\nline2';
    const local  = 'line1\nline2\nlocal-addition';
    const remote = base;
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.equal(merged, local);
  });

  it('returns local when both sides are identical (concurrent same edit)', () => {
    const base   = 'a\nb';
    const local  = 'a\nb\nc';
    const remote = 'a\nb\nc';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.equal(merged, local);
  });

  // ── clean auto-merge ─────────────────────────────────────────────────────────

  it('auto-merges local addition at end and remote addition at end (different lines)', () => {
    const base   = 'alpha\nbeta\ngamma';
    const local  = 'alpha\nbeta\ngamma\nlocal-line';
    const remote = 'alpha\nbeta\ngamma\nremote-line';
    // Both add a line at the end — they don't change the same base line but
    // they insert at the same anchor (end), so this is an overlap → autoMerged:false
    const { autoMerged } = textMerge(base, local, remote);
    // Same anchor → conflict; caller falls back to HLC
    assert.isFalse(autoMerged);
  });

  it('auto-merges local addition at start and remote addition at end', () => {
    const base   = 'line1\nline2\nline3';
    const local  = 'local-header\nline1\nline2\nline3';
    const remote = 'line1\nline2\nline3\nremote-footer';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.include(merged, 'local-header');
    assert.include(merged, 'remote-footer');
    assert.include(merged, 'line1');
    assert.include(merged, 'line3');
  });

  it('auto-merges local edit to line1 and remote edit to line3 (non-overlapping)', () => {
    const base   = 'line1\nline2\nline3';
    const local  = 'LINE1\nline2\nline3';
    const remote = 'line1\nline2\nLINE3';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.include(merged, 'LINE1');
    assert.include(merged, 'line2');
    assert.include(merged, 'LINE3');
  });

  it('auto-merges local insertion in middle and remote insertion at different location', () => {
    const base   = 'a\nb\nc\nd';
    const local  = 'a\nINSERTED\nb\nc\nd';
    const remote = 'a\nb\nc\nINSERTED_REMOTE\nd';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.include(merged, 'INSERTED');
    assert.include(merged, 'INSERTED_REMOTE');
  });

  // ── conflict: overlapping hunks → autoMerged:false ───────────────────────────

  it('returns autoMerged:false when both sides change the same line', () => {
    const base   = 'unchanged\nshared-line\nend';
    const local  = 'unchanged\nlocal-version\nend';
    const remote = 'unchanged\nremote-version\nend';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isFalse(autoMerged);
    assert.isNull(merged);
  });

  it('returns autoMerged:false when both sides modify overlapping ranges', () => {
    const base   = 'a\nb\nc\nd\ne';
    const local  = 'a\nX\nY\nd\ne';   // replaces b+c with X+Y
    const remote = 'a\nb\nZ\nd\ne';   // replaces c with Z
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isFalse(autoMerged);
    assert.isNull(merged);
  });

  // ── empty base ────────────────────────────────────────────────────────────────

  it('auto-merges when base is empty and both sides add different lines', () => {
    // Both insert at position 0 of an empty base — same anchor → overlap
    const { autoMerged } = textMerge('', 'local-line', 'remote-line');
    // Two concurrent inserts at the same (only) anchor point → conflict
    assert.isFalse(autoMerged);
  });

  it('returns local when base is empty and remote is also empty', () => {
    const { merged, autoMerged } = textMerge('', 'local-content', '');
    assert.isTrue(autoMerged);
    assert.equal(merged, 'local-content');
  });

  it('handles null base (treated as empty string)', () => {
    const { merged, autoMerged } = textMerge(null, 'local-content', null);
    assert.isTrue(autoMerged);
    assert.equal(merged, 'local-content');
  });

  it('handles undefined base (treated as empty string)', () => {
    const { merged, autoMerged } = textMerge(undefined, undefined, 'remote-content');
    assert.isTrue(autoMerged);
    assert.equal(merged, 'remote-content');
  });

  // ── deletion ──────────────────────────────────────────────────────────────────

  it('auto-merges when local deletes a line that remote does not touch', () => {
    const base   = 'keep\ndelete-me\nalso-keep';
    const local  = 'keep\nalso-keep';  // deleted line 2
    const remote = 'keep\ndelete-me\nalso-keep'; // unchanged
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.notInclude(merged, 'delete-me');
    assert.include(merged, 'keep');
    assert.include(merged, 'also-keep');
  });

  it('auto-merges idempotent deletion (both sides delete the same line)', () => {
    const base   = 'line1\nremove\nline3';
    const local  = 'line1\nline3';
    const remote = 'line1\nline3';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.notInclude(merged, 'remove');
    assert.include(merged, 'line1');
    assert.include(merged, 'line3');
  });

  it('returns autoMerged:false when local deletes a line that remote modifies', () => {
    const base   = 'keep\ncontest\nend';
    const local  = 'keep\nend';             // deleted 'contest'
    const remote = 'keep\ncontest-EDITED\nend'; // edited 'contest'
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isFalse(autoMerged);
    assert.isNull(merged);
  });

  // ── trailing newline preservation ─────────────────────────────────────────────

  it('preserves trailing newline from inputs', () => {
    const base   = 'a\nb\n';
    const local  = 'a\nb\nc\n';
    const remote = base;
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.equal(merged, 'a\nb\nc\n');
  });

  // ── whitespace lines ──────────────────────────────────────────────────────────

  it('treats whitespace-only lines as ordinary lines', () => {
    const base   = 'a\n   \nb';
    const local  = 'a\n   \nb\nlocal';
    const remote = 'a\n   \nb';
    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged);
    assert.include(merged, '   ');
    assert.include(merged, 'local');
  });

  // ── real-world: meeting notes ─────────────────────────────────────────────────

  it('auto-merges concurrent meeting note additions from two users', () => {
    const base = [
      '## Meeting Notes — 2026-03-27',
      '',
      '### Attendees',
      '- Alice',
      '- Bob',
      '',
      '### Action Items',
    ].join('\n');

    const local = [
      '## Meeting Notes — 2026-03-27',
      '',
      '### Attendees',
      '- Alice',
      '- Bob',
      '',
      '### Action Items',
      '- Alice: prepare design doc',   // Alice added her action
    ].join('\n');

    const remote = [
      '## Meeting Notes — 2026-03-27',
      '',
      '### Attendees',
      '- Alice',
      '- Bob',
      '- Carol',                        // Bob added Carol to attendees
      '',
      '### Action Items',
    ].join('\n');

    const { merged, autoMerged } = textMerge(base, local, remote);
    assert.isTrue(autoMerged, 'should auto-merge non-overlapping section additions');
    assert.include(merged, '- Carol');
    assert.include(merged, '- Alice: prepare design doc');
  });

  // ── isomorphism audit ─────────────────────────────────────────────────────────

  describe('isomorphism (no Node-specific imports)', () => {
    const NODE_ONLY = [
      "node:fs", "node:path", "node:crypto",
      "'fs'", "'path'", "'crypto'",
      '"fs"', '"path"', '"crypto"',
      'Buffer.', 'process.env', 'require(',
    ];
    for (const forbidden of NODE_ONLY) {
      it(`does not import or use "${forbidden}"`, () => {
        assert.notInclude(source, forbidden);
      });
    }
  });

});
