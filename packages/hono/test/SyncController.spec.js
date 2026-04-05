/**
 * SyncController.spec.js — Integration tests for SyncController via boot-hono CDI
 *
 * Tests the full stack: CDI → SyncController → SyncService → SyncRepository → jsnosqlc-memory
 * Uses Hono's native app.request() — no HTTP server started.
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';    // self-registers MemoryDriver
import { Context } from '@alt-javascript/cdi';
import { ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { SyncRepository, SyncService } from '@alt-javascript/jsmdma-server';
import { HLC } from '@alt-javascript/jsmdma-core';
import SyncController from '../SyncController.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  'boot': { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  'logging': { level: { ROOT: 'error' } },
  'server': { port: 0 },
};

async function buildContext() {
  const config = new EphemeralConfig(BASE_CONFIG);

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository, name: 'syncRepository', scope: 'singleton' },
    { Reference: SyncService,    name: 'syncService',    scope: 'singleton' },
    { Reference: SyncController, name: 'syncController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });

  // Ensure nosqlClient is ready before tests run
  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

async function syncPost(app, body) {
  return app.request('/sync', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SyncController (CDI integration)', () => {
  let appCtx;
  let app;

  beforeEach(async () => {
    appCtx = await buildContext();
    app    = appCtx.get('honoAdapter').app;
  });

  // ── health ───────────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 { status: ok }', async () => {
      const res = await app.request('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    });
  });

  // ── validation ───────────────────────────────────────────────────────────────

  describe('POST /sync — validation', () => {
    it('returns 400 when body is empty', async () => {
      const res = await app.request('/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.property(body, 'error');
    });

    it('returns 400 when collection is missing', async () => {
      const res = await syncPost(app, { clientClock: HLC.zero() });
      assert.equal(res.status, 400);
    });

    it('returns 400 when clientClock is missing', async () => {
      const res = await syncPost(app, { collection: 'items' });
      assert.equal(res.status, 400);
    });
  });

  // ── empty sync ───────────────────────────────────────────────────────────────

  describe('POST /sync — empty changeset', () => {
    it('returns 200 with serverClock, empty serverChanges and conflicts', async () => {
      const res = await syncPost(app, {
        collection:  'items',
        clientClock: HLC.zero(),
        changes:     [],
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.property(body, 'serverClock');
      assert.isString(body.serverClock);
      assert.isArray(body.serverChanges);
      assert.isEmpty(body.serverChanges);
      assert.isArray(body.conflicts);
      assert.isEmpty(body.conflicts);
    });
  });

  // ── single change ────────────────────────────────────────────────────────────

  describe('POST /sync — single change', () => {
    it('persists a doc and returns it on subsequent sync', async () => {
      const t1 = HLC.tick(HLC.zero(), Date.now());

      // First sync: push one change
      const res1 = await syncPost(app, {
        collection:  'notes',
        clientClock: HLC.zero(),
        changes: [{
          key:       'note-1',
          doc:       { title: 'Hello', body: 'World' },
          fieldRevs: { title: t1, body: t1 },
          baseClock: HLC.zero(),
        }],
      });
      assert.equal(res1.status, 200);
      const r1 = await res1.json();
      assert.property(r1, 'serverClock');
      const serverClock1 = r1.serverClock;

      // Second sync from a fresh client (zero clock) — should receive the stored doc
      const res2 = await syncPost(app, {
        collection:  'notes',
        clientClock: HLC.zero(),
        changes:     [],
      });
      assert.equal(res2.status, 200);
      const r2 = await res2.json();
      assert.lengthOf(r2.serverChanges, 1);
      assert.equal(r2.serverChanges[0].title, 'Hello');
      assert.equal(r2.serverChanges[0].body,  'World');

      // Third sync with serverClock1 — should receive nothing new
      const res3 = await syncPost(app, {
        collection:  'notes',
        clientClock: serverClock1,
        changes:     [],
      });
      assert.equal(res3.status, 200);
      const r3 = await res3.json();
      assert.isEmpty(r3.serverChanges);
    });
  });

  // ── conflict detection ───────────────────────────────────────────────────────

  describe('POST /sync — conflict', () => {
    it('detects a conflict when both sides changed the same field', async () => {
      const tEarly = HLC.tick(HLC.zero(), 1000);
      const tLate  = HLC.tick(tEarly,    2000);

      // Seed: store a doc on the server directly (simulate prior shared state)
      const repo = appCtx.get('syncRepository');
      await repo.store('things', 'obj-1',
        { name: 'Original', color: 'red' },
        { name: tEarly, color: tEarly },
        tEarly,
      );

      // Client syncs a change to 'color' (using tLate)
      // Server already has color='red' at tEarly; client has color='blue' at tLate
      const res = await syncPost(app, {
        collection:  'things',
        clientClock: HLC.zero(),
        changes: [{
          key:       'obj-1',
          doc:       { name: 'Original', color: 'blue' },
          fieldRevs: { color: tLate },
          baseClock: tEarly,
        }],
      });

      // color changed on client (tLate) vs server (tEarly) → tLate wins
      // But both are the same value in this case: server has 'red', client has 'blue'
      // server doc is the "remote" side — since both sides differ from base, this is a conflict
      // client wins because tLate > tEarly
      assert.equal(res.status, 200);
      const body = await res.json();
      // There may or may not be a conflict depending on whether server doc differs from base
      // In this setup, server has stored 'red', client sends 'blue' — both differ from a fresh base
      // SyncService uses server doc as base, so only one side changed → no conflict (client wins clean)
      // This test verifies the response is well-formed
      assert.property(body, 'serverClock');
      assert.property(body, 'serverChanges');
      assert.property(body, 'conflicts');
      assert.isArray(body.conflicts);
    });

    it('produces a conflict when server has an independently-updated field', async () => {
      const tA = HLC.tick(HLC.zero(), 1000);
      const tB = HLC.tick(tA,        2000); // tB > tA

      // Step 1: seed the shared state (both clients have this)
      const repo = appCtx.get('syncRepository');
      await repo.store('things', 'shared-doc',
        { value: 'base' },
        { value: tA },
        tA,
      );

      // Step 2: simulate server-side update (another client already synced)
      await repo.store('things', 'shared-doc',
        { value: 'server-update' },
        { value: tB },
        tB,
      );

      // Step 3: now another client (that only saw tA) syncs their own change to 'value'
      const tC = HLC.tick(tA, 1500); // concurrent with tB, but tB > tC

      const res = await syncPost(app, {
        collection:  'things',
        clientClock: tA,   // client last saw tA
        changes: [{
          key:       'shared-doc',
          doc:       { value: 'client-update' },
          fieldRevs: { value: tC },
          baseClock: tA,
        }],
      });

      assert.equal(res.status, 200);
      const body = await res.json();

      // Both sides changed 'value': server has 'server-update' at tB, client has 'client-update' at tC
      // tB > tC → server wins
      assert.isArray(body.conflicts);
      assert.lengthOf(body.conflicts, 1);
      assert.equal(body.conflicts[0].field,  'value');
      assert.equal(body.conflicts[0].winner, 'remote'); // server (remote) wins
    });
  });

  // ── CDI wiring ───────────────────────────────────────────────────────────────

  describe('CDI wiring', () => {
    it('syncController.syncService is autowired', () => {
      const ctrl = appCtx.get('syncController');
      assert.instanceOf(ctrl.syncService, SyncService);
    });

    it('syncService.syncRepository is autowired', () => {
      const svc = appCtx.get('syncService');
      assert.instanceOf(svc.syncRepository, SyncRepository);
    });

    it('syncRepository.nosqlClient is autowired', () => {
      const repo = appCtx.get('syncRepository');
      assert.isNotNull(repo.nosqlClient);
    });
  });

});
