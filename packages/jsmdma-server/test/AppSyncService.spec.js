/**
 * AppSyncService.spec.js — Unit contract tests for AppSyncService orchestration.
 */
import { assert } from 'chai';
import AppSyncService from '../AppSyncService.js';

function makeRequest(overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);

  // AppSyncService reads request.identity.userId (migrated in commit 040d8e1).
  // When `user: null` is explicitly supplied, produce no identity → triggers 401.
  const identity = has('user')
    ? (overrides.user == null ? null : { userId: overrides.user.sub ?? 'user-1' })
    : { userId: 'user-1' };

  return {
    params: { application: 'todo', ...(overrides.params ?? {}) },
    headers: has('headers') ? overrides.headers : {},
    body: has('body')
      ? overrides.body
      : {
        collection: 'tasks',
        clientClock: '0000000000000-000000-client',
        changes: [],
      },
    identity,
  };
}

function makeService(overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const syncCalls = [];
  const upsertCalls = [];

  const service = new AppSyncService();
  service.applicationRegistry = has('applicationRegistry')
    ? overrides.applicationRegistry
    : { isAllowed: () => true };
  service.schemaValidator = has('schemaValidator')
    ? overrides.schemaValidator
    : { validate: () => ({ valid: true, errors: [] }) };
  service.orgService = has('orgService')
    ? overrides.orgService
    : { isMember: async () => true };
  service.syncService = has('syncService')
    ? overrides.syncService
    : {
      async sync(...args) {
        syncCalls.push(args);
        return {
          serverClock: '0000000000001-000000-server',
          serverChanges: [],
          conflicts: [],
        };
      },
    };

  service.documentIndexRepository = has('documentIndexRepository')
    ? overrides.documentIndexRepository
    : {
      async upsertOwnership(...args) {
        upsertCalls.push(args);
      },
    };

  service.logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    ...(overrides.logger ?? {}),
  };

  return { service, syncCalls, upsertCalls };
}

describe('AppSyncService', () => {

  describe('guards and validation', () => {
    it('returns 401 when auth subject is missing', async () => {
      const { service } = makeService();
      const result = await service.sync(makeRequest({ user: null }));

      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.body, {
        error: 'Authentication required',
        code: 'unauthorized',
      });
    });

    it('returns 404 for unknown applications', async () => {
      const { service, syncCalls } = makeService({
        applicationRegistry: { isAllowed: () => false },
      });

      const result = await service.sync(makeRequest());

      assert.equal(result.statusCode, 404);
      assert.equal(result.body.error, 'Unknown application: todo');
      assert.isEmpty(syncCalls, 'syncService must not be called for unknown apps');
    });

    it('treats non-boolean allowlist responses as deny (404)', async () => {
      const { service } = makeService({
        applicationRegistry: { isAllowed: () => 'yes' },
      });

      const result = await service.sync(makeRequest());

      assert.equal(result.statusCode, 404);
      assert.equal(result.body.error, 'Unknown application: todo');
      assert.equal(result.body.code, 'not_found');
    });

    it('returns 400 when body is missing/non-object', async () => {
      const { service } = makeService();
      const result = await service.sync(makeRequest({ body: null }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Request body is required');
      assert.equal(result.body.code, 'bad_request');
    });

    it('returns 400 when collection is missing', async () => {
      const { service } = makeService();
      const result = await service.sync(makeRequest({
        body: { clientClock: 'clock-1', changes: [] },
      }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Missing required field: collection');
    });

    it('returns 400 when clientClock is missing', async () => {
      const { service } = makeService();
      const result = await service.sync(makeRequest({
        body: { collection: 'tasks', changes: [] },
      }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Missing required field: clientClock');
      assert.equal(result.body.code, 'bad_request');
    });

    it('returns 400 when changes is not an array', async () => {
      const { service } = makeService();
      const result = await service.sync(makeRequest({
        body: { collection: 'tasks', clientClock: 'clock-1', changes: 'bad' },
      }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Invalid field: changes must be an array');
    });

    it('returns 400 with details[].key when schema validation fails', async () => {
      const { service } = makeService({
        schemaValidator: {
          validate() {
            return {
              valid: false,
              errors: [{ field: 'title', message: 'must have required property title' }],
            };
          },
        },
      });

      const result = await service.sync(makeRequest({
        body: {
          collection: 'tasks',
          clientClock: 'clock-1',
          changes: [{ key: 'task-bad', doc: {} }],
        },
      }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Schema validation failed');
      assert.isArray(result.body.details);
      assert.deepInclude(result.body.details, {
        key: 'task-bad',
        field: 'title',
        message: 'must have required property title',
      });
    });

    it('treats malformed schema validator payload as 400-safe diagnostics', async () => {
      const { service } = makeService({
        schemaValidator: { validate: () => ({}) },
      });

      const result = await service.sync(makeRequest({
        body: {
          collection: 'tasks',
          clientClock: 'clock-1',
          changes: [{ key: 'task-malformed', doc: { title: 'x' } }],
        },
      }));

      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error, 'Schema validation failed');
      assert.equal(result.body.code, 'bad_request');
      assert.equal(result.body.details[0].key, 'task-malformed');
      assert.equal(result.body.details[0].field, '(validator)');
    });
  });

  describe('org membership enforcement', () => {
    it('returns 500 when x-org-id is provided but orgService is missing', async () => {
      const { service } = makeService({ orgService: null });

      const result = await service.sync(makeRequest({
        headers: { 'x-org-id': 'org-1' },
      }));

      assert.equal(result.statusCode, 500);
      assert.equal(result.body.error, 'Org-scoped sync is not configured');
    });

    it('returns 403 when requester is not an org member', async () => {
      const { service, syncCalls } = makeService({
        orgService: { isMember: async () => false },
      });

      const result = await service.sync(makeRequest({
        headers: { 'x-org-id': 'org-1' },
      }));

      assert.equal(result.statusCode, 403);
      assert.equal(result.body.error, 'Not a member of organisation: org-1');
      assert.equal(result.body.code, 'forbidden');
      assert.isEmpty(syncCalls, 'syncService must not be called when membership fails');
    });
  });

  describe('sync delegation shape', () => {
    it('personal sync uses (collection, clientClock, changes, userId, application)', async () => {
      const { service, syncCalls } = makeService();

      const changes = [{ key: 'a', doc: { title: 'A' } }];
      const result = await service.sync(makeRequest({
        body: { collection: 'tasks', clientClock: 'clock-1', changes },
      }));

      assert.equal(result.statusCode, 200);
      assert.deepEqual(syncCalls[0], ['tasks', 'clock-1', changes, 'user-1', 'todo']);
    });

    it('org sync uses (org:{orgId}:{application}:{collection}, clientClock, changes)', async () => {
      const { service, syncCalls } = makeService({
        orgService: { isMember: async () => true },
      });

      const changes = [{ key: 'a', doc: { title: 'A' } }];
      const result = await service.sync(makeRequest({
        headers: { 'x-org-id': 'org-99' },
        body: { collection: 'tasks', clientClock: 'clock-1', changes },
      }));

      assert.equal(result.statusCode, 200);
      assert.deepEqual(syncCalls[0], ['org:org-99:todo:tasks', 'clock-1', changes]);
    });
  });

  describe('document index side effects', () => {
    it('does not upsert docIndex when changes is empty', async () => {
      const { service, upsertCalls } = makeService();

      const result = await service.sync(makeRequest({
        body: { collection: 'tasks', clientClock: 'clock-1', changes: [] },
      }));

      assert.equal(result.statusCode, 200);
      assert.isEmpty(upsertCalls);
    });

    it('upserts docIndex ownership once per change (multi-change batch)', async () => {
      const { service, upsertCalls } = makeService();

      const changes = Array.from({ length: 12 }, (_, i) => ({
        key: `doc-${i + 1}`,
        doc: { title: `Task ${i + 1}` },
      }));

      const result = await service.sync(makeRequest({
        body: { collection: 'tasks', clientClock: 'clock-1', changes },
      }));

      assert.equal(result.statusCode, 200);
      assert.lengthOf(upsertCalls, 12);
      assert.deepEqual(upsertCalls[0], ['user-1', 'todo', 'doc-1', 'tasks']);
      assert.deepEqual(upsertCalls[11], ['user-1', 'todo', 'doc-12', 'tasks']);
    });
  });

  describe('500-safe failure behavior', () => {
    it('returns typed non-leaky 500 when syncService throws and skips docIndex writes', async () => {
      const { service, upsertCalls } = makeService({
        syncService: {
          async sync() {
            throw new Error('db timeout');
          },
        },
      });

      const result = await service.sync(makeRequest({
        body: {
          collection: 'tasks',
          clientClock: 'clock-1',
          changes: [{ key: 'doc-1', doc: { title: 'A' } }],
        },
      }));

      assert.equal(result.statusCode, 500);
      assert.equal(result.body.error, 'Sync failed');
      assert.equal(result.body.code, 'internal_error');
      assert.notInclude(result.body.error, 'db timeout');
      assert.isEmpty(upsertCalls, 'docIndex writes must not run when sync fails');
    });

    it('returns typed 500 when syncService returns malformed response shape', async () => {
      const { service } = makeService({
        syncService: {
          async sync() {
            return { serverClock: 'clock-1', serverChanges: null, conflicts: [] };
          },
        },
      });

      const result = await service.sync(makeRequest());

      assert.equal(result.statusCode, 500);
      assert.equal(result.body.error, 'Malformed sync response');
      assert.equal(result.body.code, 'internal_error');
    });

    it('returns typed 500 when docIndex upsert fails and aborts remaining writes', async () => {
      const upsertKeys = [];
      const { service } = makeService({
        documentIndexRepository: {
          async upsertOwnership(_userId, _app, docKey) {
            upsertKeys.push(docKey);
            if (docKey === 'doc-2') throw new Error('index write failed');
          },
        },
      });

      const result = await service.sync(makeRequest({
        body: {
          collection: 'tasks',
          clientClock: 'clock-1',
          changes: [
            { key: 'doc-1', doc: { title: 'A' } },
            { key: 'doc-2', doc: { title: 'B' } },
            { key: 'doc-3', doc: { title: 'C' } },
          ],
        },
      }));

      assert.equal(result.statusCode, 500);
      assert.equal(result.body.error, 'Document ownership index update failed');
      assert.equal(result.body.code, 'internal_error');
      assert.deepEqual(upsertKeys, ['doc-1', 'doc-2'], 'upsert loop should stop at first failure');
    });
  });
});

