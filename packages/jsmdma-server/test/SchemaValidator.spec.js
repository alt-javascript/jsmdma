/**
 * SchemaValidator.spec.js — Unit tests for SchemaValidator
 */
import { assert } from 'chai';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import SchemaValidator from '../SchemaValidator.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeValidator(applications) {
  const sv = new SchemaValidator();
  sv.applications = applications;
  return sv;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SchemaValidator', () => {

  // ── no schema configured ──────────────────────────────────────────────────────

  it('passes validation when no applications config is set', () => {
    const sv = makeValidator(null);
    const result = sv.validate('todo', 'tasks', { anything: true });
    assert.isTrue(result.valid);
    assert.isEmpty(result.errors);
  });

  it('passes validation when application is not in config', () => {
    const sv = makeValidator({ other: {} });
    const result = sv.validate('todo', 'tasks', { anything: true });
    assert.isTrue(result.valid);
    assert.isEmpty(result.errors);
  });

  it('passes validation when collection is not in application config', () => {
    const sv = makeValidator({ todo: { collections: { notes: {} } } });
    const result = sv.validate('todo', 'tasks', { anything: true });
    assert.isTrue(result.valid);
    assert.isEmpty(result.errors);
  });

  it('passes validation when collection has no schema and no schemaPath', () => {
    const sv = makeValidator({ todo: { collections: { tasks: {} } } });
    const result = sv.validate('todo', 'tasks', { anything: true });
    assert.isTrue(result.valid);
    assert.isEmpty(result.errors);
  });

  // ── inline schema ─────────────────────────────────────────────────────────────

  it('validates a valid doc against an inline schema', () => {
    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schema: {
              type: 'object',
              required: ['title'],
              properties: { title: { type: 'string' }, done: { type: 'boolean' } },
              additionalProperties: false,
            },
          },
        },
      },
    });
    const result = sv.validate('todo', 'tasks', { title: 'Buy milk', done: false });
    assert.isTrue(result.valid);
    assert.isEmpty(result.errors);
  });

  it('rejects a doc missing a required field', () => {
    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schema: {
              type: 'object',
              required: ['title'],
              properties: { title: { type: 'string' } },
            },
          },
        },
      },
    });
    const result = sv.validate('todo', 'tasks', { done: true });
    assert.isFalse(result.valid);
    assert.isNotEmpty(result.errors);
    const fields = result.errors.map((e) => e.field);
    assert.include(fields, 'title');
  });

  it('rejects a doc with wrong field type', () => {
    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schema: {
              type: 'object',
              properties: { count: { type: 'integer' } },
            },
          },
        },
      },
    });
    const result = sv.validate('todo', 'tasks', { count: 'not-a-number' });
    assert.isFalse(result.valid);
    assert.isNotEmpty(result.errors);
  });

  it('error objects have field and message properties', () => {
    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
          },
        },
      },
    });
    const { errors } = sv.validate('todo', 'tasks', {});
    assert.isNotEmpty(errors);
    for (const e of errors) {
      assert.property(e, 'field');
      assert.property(e, 'message');
      assert.isString(e.field);
      assert.isString(e.message);
    }
  });

  // ── schemaPath ────────────────────────────────────────────────────────────────

  it('loads schema from schemaPath and validates correctly', () => {
    const dir  = tmpdir();
    const path = join(dir, `schema-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    }));

    const sv = makeValidator({
      'shopping-list': {
        collections: {
          lists: { schemaPath: path },
        },
      },
    });

    assert.isTrue(sv.validate('shopping-list', 'lists', { name: 'Weekend groceries' }).valid);
    assert.isFalse(sv.validate('shopping-list', 'lists', { price: 9.99 }).valid);
  });

  it('schemaPath wins over inline schema when both are present', () => {
    const dir  = tmpdir();
    const path = join(dir, `schema-wins-${Date.now()}.json`);
    // schemaPath schema requires 'id'; inline schema requires 'title'
    writeFileSync(path, JSON.stringify({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    }));

    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schemaPath: path,
            schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
          },
        },
      },
    });

    // Valid against schemaPath schema (has 'id'), invalid against inline (no 'title')
    assert.isTrue(sv.validate('todo', 'tasks', { id: 'abc' }).valid,  'schemaPath schema must win');
    assert.isFalse(sv.validate('todo', 'tasks', { title: 'hi' }).valid, 'should fail schemaPath schema (no id)');
  });

  it('throws a descriptive error when schemaPath file does not exist', () => {
    const sv = makeValidator({
      todo: { collections: { tasks: { schemaPath: '/no/such/file.json' } } },
    });
    assert.throws(
      () => sv.validate('todo', 'tasks', {}),
      /SchemaValidator: failed to load schema/,
    );
  });

  // ── caching ───────────────────────────────────────────────────────────────────

  it('returns consistent results across multiple calls (caching)', () => {
    const sv = makeValidator({
      todo: {
        collections: {
          tasks: {
            schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
          },
        },
      },
    });
    const r1 = sv.validate('todo', 'tasks', { title: 'a' });
    const r2 = sv.validate('todo', 'tasks', { title: 'b' });
    const r3 = sv.validate('todo', 'tasks', {});
    assert.isTrue(r1.valid);
    assert.isTrue(r2.valid);
    assert.isFalse(r3.valid);
  });

});
