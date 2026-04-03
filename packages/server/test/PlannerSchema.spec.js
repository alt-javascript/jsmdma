/**
 * PlannerSchema.spec.js — Validates planner.json schema via SchemaValidator.
 *
 * Uses SchemaValidator directly (no CDI) with schemaPath pointing to the
 * actual packages/server/schemas/planner.json file.
 */

import { assert } from 'chai';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import SchemaValidator from '../SchemaValidator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../schemas/planner.json');

function makeValidator() {
  const sv = new SchemaValidator();
  sv.applications = {
    'year-planner': {
      collections: {
        planners: { schemaPath: SCHEMA_PATH },
      },
    },
  };
  return sv;
}

function validate(doc) {
  return makeValidator().validate('year-planner', 'planners', doc);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fieldNames(result) {
  return result.errors.map((e) => e.field);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('PlannerSchema (planner.json)', () => {

  // ── valid documents ───────────────────────────────────────────────────────

  it('1. valid minimal planner (meta.name + meta.year only) passes', () => {
    const result = validate({ meta: { name: 'My Planner', year: 2026 } });
    assert.isTrue(result.valid, `Expected valid; errors: ${JSON.stringify(result.errors)}`);
    assert.isEmpty(result.errors);
  });

  it('2. valid full planner with days passes', () => {
    const result = validate({
      meta: {
        name:    'Full Planner',
        year:    2026,
        lang:    'en',
        theme:   'ink',
        dark:    false,
        created: '2026-01-01T00:00:00Z',
      },
      days: {
        '2026-03-28': {
          tp:    3,
          tl:    'Work',
          col:   2,
          notes: 'Sprint planning day',
          emoji: '💻',
        },
        '2026-12-25': {
          tp: 0,
          tl: 'Holiday',
        },
      },
    });
    assert.isTrue(result.valid, `Expected valid; errors: ${JSON.stringify(result.errors)}`);
    assert.isEmpty(result.errors);
  });

  // ── meta field validation ─────────────────────────────────────────────────

  it('3. meta.name > 64 chars fails', () => {
    const result = validate({
      meta: { name: 'x'.repeat(65), year: 2026 },
    });
    assert.isFalse(result.valid);
    const fields = fieldNames(result);
    assert.isTrue(
      fields.some((f) => f.includes('name') || f.includes('meta')),
      `Expected error on meta.name; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('4. meta.year = 1800 (below minimum 1900) fails', () => {
    const result = validate({ meta: { name: 'Old Planner', year: 1800 } });
    assert.isFalse(result.valid);
    const fields = fieldNames(result);
    assert.isTrue(
      fields.some((f) => f.includes('year') || f.includes('meta')),
      `Expected error on meta.year; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('5. meta.year = 2200 (above maximum 2100) fails', () => {
    const result = validate({ meta: { name: 'Future Planner', year: 2200 } });
    assert.isFalse(result.valid);
    const fields = fieldNames(result);
    assert.isTrue(
      fields.some((f) => f.includes('year') || f.includes('meta')),
      `Expected error on meta.year; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('10. meta with unknown field fails (additionalProperties: false)', () => {
    const result = validate({
      meta: { name: 'Planner', year: 2026, unknownField: 'bad' },
    });
    assert.isFalse(result.valid);
  });

  it('11. missing meta fails (required)', () => {
    const result = validate({ days: {} });
    assert.isFalse(result.valid);
    const fields = fieldNames(result);
    assert.isTrue(
      fields.some((f) => f.includes('meta') || f === '(root)'),
      `Expected error about missing meta; got: ${JSON.stringify(result.errors)}`,
    );
  });

  // ── days field validation ─────────────────────────────────────────────────

  it('6. days with non-ISO key ("march-28") fails propertyNames', () => {
    const result = validate({
      meta: { name: 'Planner', year: 2026 },
      days: { 'march-28': { tp: 1 } },
    });
    assert.isFalse(result.valid, `Expected invalid; errors: ${JSON.stringify(result.errors)}`);
  });

  it('7. days entry with tl > 32 chars fails', () => {
    const result = validate({
      meta: { name: 'Planner', year: 2026 },
      days: { '2026-03-28': { tl: 'x'.repeat(33) } },
    });
    assert.isFalse(result.valid);
    assert.isNotEmpty(result.errors);
  });

  it('8. days entry with col = 9 (above maximum 8) fails', () => {
    const result = validate({
      meta: { name: 'Planner', year: 2026 },
      days: { '2026-03-28': { col: 9 } },
    });
    assert.isFalse(result.valid);
    assert.isNotEmpty(result.errors);
  });

  it('9. days entry with unknown field fails (additionalProperties: false)', () => {
    const result = validate({
      meta: { name: 'Planner', year: 2026 },
      days: { '2026-03-28': { unknownField: 'bad' } },
    });
    assert.isFalse(result.valid);
  });

});
