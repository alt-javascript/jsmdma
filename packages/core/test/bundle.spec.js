/**
 * bundle.spec.js — Structural smoke test for the ESM CDN bundle.
 *
 * This is a Node-side test that reads the built bundle file and checks its
 * structural properties — it does NOT execute the bundle in a browser.
 *
 * Run:  npm run build -w packages/core && npm test -w packages/core
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assert } from 'chai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(__dirname, '../dist/data-api-core.esm.js');

describe('ESM bundle (dist/data-api-core.esm.js)', () => {

  let source;

  before(() => {
    assert.isTrue(existsSync(BUNDLE_PATH), `Bundle not found at ${BUNDLE_PATH} — run "npm run build -w packages/core" first`);
    source = readFileSync(BUNDLE_PATH, 'utf-8');
  });

  it('file exists', () => {
    assert.isTrue(existsSync(BUNDLE_PATH));
  });

  it('file size is less than 30 000 bytes', () => {
    const size = Buffer.byteLength(source, 'utf-8');
    assert.isBelow(size, 30_000, `Bundle is ${size} bytes — expected < 30 000`);
  });

  it('contains ESM export block', () => {
    assert.include(source, 'export {', 'Bundle must contain "export {"');
  });

  it('exports HLC', () => {
    assert.match(source, /\bHLC\b/, 'Bundle must contain HLC');
  });

  it('exports flatten', () => {
    assert.match(source, /\bflatten\b/, 'Bundle must export flatten');
  });

  it('exports unflatten', () => {
    assert.match(source, /\bunflatten\b/, 'Bundle must export unflatten');
  });

  it('exports diff', () => {
    assert.match(source, /\bdiff\b/, 'Bundle must export diff');
  });

  it('exports merge', () => {
    assert.match(source, /\bmerge\b/, 'Bundle must export merge');
  });

  it('exports textMerge', () => {
    assert.match(source, /\btextMerge\b/, 'Bundle must export textMerge');
  });

});
