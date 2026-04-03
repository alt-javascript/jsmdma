/**
 * EntitySchemas.spec.js — Fixture tests for all five entity JSON Schemas.
 *
 * Uses AJV directly (not SchemaValidator) to verify that each schema:
 *   1. Compiles without error
 *   2. Accepts valid minimal and full documents
 *   3. Rejects documents missing required fields
 *   4. Enforces enum constraints where present
 *   5. Rejects additional properties where additionalProperties: false
 *
 * Schema files are loaded from packages/server/schemas/ relative to this file.
 */
import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { assert } from 'chai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ allErrors: true });

function loadAndCompile(relPath) {
  const schema = JSON.parse(readFileSync(resolve(__dirname, relPath), 'utf8'));
  return ajv.compile(schema);
}

// ── User ──────────────────────────────────────────────────────────────────────

describe('user.json schema', () => {
  let validate;

  before(() => {
    validate = loadAndCompile('../schemas/user.json');
  });

  it('compiles without error', () => {
    assert.isFunction(validate);
  });

  it('accepts a minimal valid user (userId + providers)', () => {
    const ok = validate({
      userId: 'u-1',
      providers: [{ provider: 'github', providerUserId: 'gh-99' }],
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a full user with all optional fields', () => {
    const ok = validate({
      userId: 'u-2',
      email: 'alice@example.com',
      providers: [{ provider: 'google', providerUserId: 'g-42' }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a user with null email', () => {
    const ok = validate({
      userId: 'u-3',
      email: null,
      providers: [],
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('rejects a user missing userId', () => {
    const ok = validate({ providers: [] });
    assert.isFalse(ok);
  });

  it('rejects a user missing providers', () => {
    const ok = validate({ userId: 'u-4' });
    assert.isFalse(ok);
  });

  it('rejects a user with an additional property', () => {
    const ok = validate({ userId: 'u-5', providers: [], extraField: true });
    assert.isFalse(ok);
  });

  it('rejects a provider item missing providerUserId', () => {
    const ok = validate({
      userId: 'u-6',
      providers: [{ provider: 'github' }],
    });
    assert.isFalse(ok);
  });

  it('rejects a provider item with an additional property', () => {
    const ok = validate({
      userId: 'u-7',
      providers: [{ provider: 'github', providerUserId: 'x', extra: true }],
    });
    assert.isFalse(ok);
  });
});

// ── Org ───────────────────────────────────────────────────────────────────────

describe('org.json schema', () => {
  let validate;

  before(() => {
    validate = loadAndCompile('../schemas/org.json');
  });

  it('compiles without error', () => {
    assert.isFunction(validate);
  });

  it('accepts a valid org with all required fields', () => {
    const ok = validate({
      orgId: 'org-1',
      name: 'Acme Corp',
      createdBy: 'u-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('rejects an org missing orgId', () => {
    const ok = validate({ name: 'Acme', createdBy: 'u-1', createdAt: '2024-01-01T00:00:00.000Z' });
    assert.isFalse(ok);
  });

  it('rejects an org missing name', () => {
    const ok = validate({ orgId: 'org-2', createdBy: 'u-1', createdAt: '2024-01-01T00:00:00.000Z' });
    assert.isFalse(ok);
  });

  it('rejects an org missing createdBy', () => {
    const ok = validate({ orgId: 'org-3', name: 'X', createdAt: '2024-01-01T00:00:00.000Z' });
    assert.isFalse(ok);
  });

  it('rejects an org missing createdAt', () => {
    const ok = validate({ orgId: 'org-4', name: 'X', createdBy: 'u-1' });
    assert.isFalse(ok);
  });

  it('rejects an org with an additional property', () => {
    const ok = validate({
      orgId: 'org-5',
      name: 'X',
      createdBy: 'u-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      extra: true,
    });
    assert.isFalse(ok);
  });
});

// ── OrgMember ─────────────────────────────────────────────────────────────────

describe('orgMember.json schema', () => {
  let validate;

  before(() => {
    validate = loadAndCompile('../schemas/orgMember.json');
  });

  it('compiles without error', () => {
    assert.isFunction(validate);
  });

  it('accepts a valid org-admin member', () => {
    const ok = validate({
      orgId: 'org-1',
      userId: 'u-1',
      role: 'org-admin',
      joinedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a valid member role', () => {
    const ok = validate({
      orgId: 'org-1',
      userId: 'u-2',
      role: 'member',
      joinedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('rejects an invalid role value', () => {
    const ok = validate({
      orgId: 'org-1',
      userId: 'u-3',
      role: 'superuser',
      joinedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isFalse(ok);
  });

  it('rejects an orgMember missing role', () => {
    const ok = validate({ orgId: 'org-1', userId: 'u-4', joinedAt: '2024-01-01T00:00:00.000Z' });
    assert.isFalse(ok);
  });

  it('rejects an orgMember missing userId', () => {
    const ok = validate({ orgId: 'org-1', role: 'member', joinedAt: '2024-01-01T00:00:00.000Z' });
    assert.isFalse(ok);
  });

  it('rejects an orgMember with an additional property', () => {
    const ok = validate({
      orgId: 'org-1',
      userId: 'u-5',
      role: 'member',
      joinedAt: '2024-01-01T00:00:00.000Z',
      extra: true,
    });
    assert.isFalse(ok);
  });
});

// ── DocIndex ──────────────────────────────────────────────────────────────────

describe('docIndex.json schema', () => {
  let validate;

  before(() => {
    validate = loadAndCompile('../schemas/docIndex.json');
  });

  it('compiles without error', () => {
    assert.isFunction(validate);
  });

  it('accepts a minimal valid docIndex (no sharedWith, no shareToken)', () => {
    const ok = validate({
      docKey: 'planner-2024',
      userId: 'u-1',
      app: 'year-planner',
      collection: 'planners',
      visibility: 'private',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a full docIndex with sharedWith and shareToken', () => {
    const ok = validate({
      docKey: 'planner-2025',
      userId: 'u-1',
      app: 'year-planner',
      collection: 'planners',
      visibility: 'shared',
      sharedWith: [
        { userId: 'u-2', app: 'year-planner' },
        { userId: 'u-3', app: 'year-planner' },
      ],
      shareToken: 'token-uuid-abc',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts null shareToken', () => {
    const ok = validate({
      docKey: 'doc-1',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      visibility: 'private',
      shareToken: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('rejects a docIndex with an invalid visibility value', () => {
    const ok = validate({
      docKey: 'doc-2',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      visibility: 'everyone',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isFalse(ok);
  });

  it('rejects a docIndex missing a required field (visibility)', () => {
    const ok = validate({
      docKey: 'doc-3',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isFalse(ok);
  });

  it('rejects a docIndex with an additional root property', () => {
    const ok = validate({
      docKey: 'doc-4',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      visibility: 'private',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      extra: true,
    });
    assert.isFalse(ok);
  });

  it('rejects a sharedWith item missing app', () => {
    const ok = validate({
      docKey: 'doc-5',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      visibility: 'shared',
      sharedWith: [{ userId: 'u-2' }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isFalse(ok);
  });

  it('rejects a sharedWith item with an additional property', () => {
    const ok = validate({
      docKey: 'doc-6',
      userId: 'u-1',
      app: 'todo',
      collection: 'tasks',
      visibility: 'shared',
      sharedWith: [{ userId: 'u-2', app: 'todo', extra: true }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.isFalse(ok);
  });

  it('accepts all valid visibility enum values', () => {
    for (const visibility of ['private', 'shared', 'org', 'public']) {
      const ok = validate({
        docKey: 'doc-vis',
        userId: 'u-1',
        app: 'todo',
        collection: 'tasks',
        visibility,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      assert.isTrue(ok, `visibility '${visibility}' should be valid — ${JSON.stringify(validate.errors)}`);
    }
  });
});

// ── AppConfig ─────────────────────────────────────────────────────────────────

describe('appConfig.json schema', () => {
  let validate;

  before(() => {
    validate = loadAndCompile('../schemas/appConfig.json');
  });

  it('compiles without error', () => {
    assert.isFunction(validate);
  });

  it('accepts an empty config object', () => {
    const ok = validate({});
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a minimal app with no collections', () => {
    const ok = validate({ todo: {} });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a valid app+collection config with description and schemaPath', () => {
    const ok = validate({
      'year-planner': {
        description: 'Annual planning app',
        collections: {
          planners: { schemaPath: './schemas/planner.json' },
        },
      },
      todo: {
        collections: {
          tasks: {},
        },
      },
    });
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('accepts a collection with an inline schema object', () => {
    const ok = validate({
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
    assert.isTrue(ok, JSON.stringify(validate.errors));
  });

  it('rejects an app entry whose collection value is a string instead of an object', () => {
    const ok = validate({
      todo: {
        collections: {
          tasks: 'not-an-object',
        },
      },
    });
    assert.isFalse(ok);
  });

  it('rejects a collection with an additional property', () => {
    const ok = validate({
      todo: {
        collections: {
          tasks: { schemaPath: './x.json', unknownKey: true },
        },
      },
    });
    assert.isFalse(ok);
  });

  it('rejects an app entry with an additional property', () => {
    const ok = validate({
      todo: {
        description: 'ok',
        collections: {},
        unknownAppProp: true,
      },
    });
    assert.isFalse(ok);
  });
});
