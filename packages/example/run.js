/**
 * run.js — Offline-first sync example (updated for M003)
 *
 * Demonstrates the jsmdma sync protocol end-to-end:
 *
 *   1. Start a CDI-managed Hono server (AppSyncController, auth middleware)
 *   2. Establish a shared starting document (initial sync via /:application/sync)
 *   3. Client A goes offline and edits field1 + field2
 *   4. Client B goes offline and edits field2 + field3
 *   5. Client A syncs — changes applied cleanly
 *   6. Client B syncs — field2 conflicts (both changed it); higher HLC wins
 *   7. Print the final converged state and validate it
 *
 * The two clients use simulated HTTP via Hono's app.request() — functionally
 * identical to real HTTP (same middleware, routing, serialisation, error handling)
 * without requiring a free TCP port. This keeps the example self-contained and
 * runnable in any environment.
 *
 * Run:
 *   node packages/example/run.js
 */

import { HLC } from '@alt-javascript/jsmdma-core';
import { buildSharedNotesStarterApp } from './runtime/sharedNotesStarterApp.js';
import { OAuthSessionMiddleware } from '@alt-javascript/boot-oauth';
import { mintTestToken, TestOAuthSessionEngine } from '../jsmdma-hono/test/helpers/mintTestToken.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const APPLICATION = 'shared-notes';

function withTestAuth() {
  return {
    hooks: {
      beforeSync: [
        { Reference: TestOAuthSessionEngine, name: 'oauthSessionEngine', scope: 'singleton' },
        { Reference: OAuthSessionMiddleware, name: 'oauthSessionMiddleware', scope: 'singleton' },
      ],
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`\n✗ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function banner(text) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(line);
}

function print(label, value) {
  console.log(`  ${label.padEnd(20)} ${JSON.stringify(value)}`);
}

/** Simple sync client that maintains its own HLC and baseClock state */
class SyncClient {
  constructor(name, app, collection, token) {
    this.name       = name;
    this.app        = app;
    this.collection = collection;
    this.token      = token;            // JWT bearer token
    this.clock      = HLC.create(name, Date.now());
    this.baseClock  = HLC.zero();       // last clock received from server
    this.localDocs  = {};               // key → { doc, fieldRevs }
  }

  /**
   * Apply a local edit (simulates working offline).
   * Advances local clock and records per-field revisions.
   */
  edit(key, fields) {
    this.clock = HLC.tick(this.clock, Date.now());
    const existing = this.localDocs[key] ?? { doc: {}, fieldRevs: {} };
    const updatedDoc = { ...existing.doc, ...fields };
    const updatedRevs = { ...existing.fieldRevs };
    for (const field of Object.keys(fields)) {
      updatedRevs[field] = this.clock;
    }
    this.localDocs[key] = { doc: updatedDoc, fieldRevs: updatedRevs };
    return this;
  }

  /**
   * Sync all local changes to the server via /:application/sync.
   * Returns { serverClock, serverChanges, conflicts }.
   */
  async sync() {
    const changes = Object.entries(this.localDocs).map(([key, { doc, fieldRevs }]) => ({
      key,
      doc,
      fieldRevs,
      baseClock: this.baseClock,
    }));

    const res = await this.app.request(`/${APPLICATION}/sync`, {
      method:  'POST',
      body:    JSON.stringify({ collection: this.collection, clientClock: this.baseClock, changes }),
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Sync failed ${res.status}: ${err}`);
    }

    const result = await res.json();

    this.baseClock = result.serverClock;
    this.clock = HLC.merge(this.clock, result.serverClock);

    for (const serverDoc of result.serverChanges) {
      const key = serverDoc._key;
      if (!key) continue;
      const { _key, _rev, _fieldRevs, ...appFields } = serverDoc;
      this.localDocs[key] = { doc: appFields, fieldRevs: _fieldRevs ?? {} };
    }

    return result;
  }

  /** Get the current local version of a document */
  doc(key) {
    return this.localDocs[key]?.doc ?? null;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner('jsmdma — Offline-First Sync Example (M003)');

  // ── 1. Start CDI context ──────────────────────────────────────────────────

  const { app, appCtx } = await buildSharedNotesStarterApp({
    starterOptions: withTestAuth(),
  });

  console.log('\n  ✓ Hono server ready (CDI, in-memory NoSQL, auth middleware)');

  // Mint JWT tokens — same user ID on two devices (the canonical offline-first scenario)
  const USER_ID = 'shared-user-uuid';
  const tokenA = mintTestToken({ userId: USER_ID });
  const tokenB = mintTestToken({ userId: USER_ID });

  // ── 2. Establish shared starting document ─────────────────────────────────

  banner('Step 1: Initial state — shared document');

  const COLLECTION = 'notes';
  const DOC_KEY    = 'doc-1';
  const INITIAL    = { field1: 'original', field2: 'original', field3: 'original' };

  const clientA = new SyncClient('client-a', app, COLLECTION, tokenA);
  clientA.edit(DOC_KEY, INITIAL);
  await clientA.sync();

  // Client B is the same user (same userId) on a second device.
  // It starts by pulling the document that client A just pushed.
  const clientB = new SyncClient('client-b', app, COLLECTION, tokenB);
  await clientB.sync(); // pull-only — gets doc-1 from the server

  // Set both clients to their respective baseClock states
  console.log('\n  Initial document:');
  print('field1:', INITIAL.field1);
  print('field2:', INITIAL.field2);
  print('field3:', INITIAL.field3);
  console.log(`\n  Client A baseClock: ${clientA.baseClock}`);
  console.log(`  Client B baseClock: ${clientB.baseClock}`);

  // ── 3. Both clients go offline and make conflicting edits ─────────────────

  banner('Step 2: Offline edits (network outage simulated)');

  await new Promise((r) => setTimeout(r, 2));
  clientA.edit(DOC_KEY, { field1: 'A-edit', field2: 'A-edit' });

  await new Promise((r) => setTimeout(r, 2));
  clientB.edit(DOC_KEY, { field2: 'B-edit', field3: 'B-edit' });

  console.log('\n  Client A offline edits: field1=A-edit, field2=A-edit');
  console.log('  Client B offline edits: field2=B-edit, field3=B-edit');

  // ── 4. Client A syncs first ───────────────────────────────────────────────

  banner('Step 3: Client A syncs (no conflicts — only A changed these fields)');

  const resultA = await clientA.sync();
  console.log(`\n  conflicts: ${resultA.conflicts.length} (expected 0)`);
  assert(resultA.conflicts.length === 0, 'Client A sync should have no conflicts');
  console.log('  ✓ Client A synced cleanly');

  // ── 5. Client B syncs second (field2 conflict) ────────────────────────────

  banner('Step 4: Client B syncs (field2 conflicts — both clients changed it)');

  const resultB = await clientB.sync();
  console.log(`\n  conflicts: ${resultB.conflicts.length} (expected 1 — field2)`);
  assert(resultB.conflicts.length === 1, 'Client B sync should have exactly 1 conflict');

  const conflict = resultB.conflicts[0];
  assert(conflict.field === 'field2', `Conflict should be on field2, got ${conflict.field}`);

  console.log('\n  Conflict:');
  print('field:', conflict.field);
  print('client-b value:', conflict.localValue);
  print('server value:', conflict.remoteValue);
  print('winner:', conflict.winner);
  print('winning value:', conflict.winnerValue);

  assert(conflict.winner === 'local', 'Client B should win field2 (B clock is higher)');
  console.log('\n  ✓ field2 conflict resolved — B wins (higher HLC)');

  // ── 6. Final state ────────────────────────────────────────────────────────

  banner('Step 5: Assertions');

  // Pull final converged state as a neutral observer (same user, fresh baseClock)
  const observer = new SyncClient('observer', app, COLLECTION, tokenA);
  await observer.sync();
  const finalDoc = observer.doc(DOC_KEY);

  console.log('\n  Final document on server:');
  print('field1:', finalDoc?.field1);
  print('field2:', finalDoc?.field2);
  print('field3:', finalDoc?.field3);

  assert(finalDoc?.field1 === 'A-edit', `field1 should be 'A-edit', got '${finalDoc?.field1}'`);
  assert(finalDoc?.field2 === 'B-edit', `field2 should be 'B-edit' (B wins — higher HLC), got '${finalDoc?.field2}'`);
  assert(finalDoc?.field3 === 'B-edit', `field3 should be 'B-edit', got '${finalDoc?.field3}'`);

  banner('Result');
  console.log('\n  ✓ field1 = "A-edit"   (only Client A changed this — clean merge)');
  console.log('  ✓ field2 = "B-edit"   (both changed — conflict, B wins (higher HLC))');
  console.log('  ✓ field3 = "B-edit"   (only Client B changed this — clean merge)');
  console.log('\n  All assertions passed. Offline-first sync protocol working correctly.\n');
}

main().catch((err) => {
  console.error('\n✗ Example failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
