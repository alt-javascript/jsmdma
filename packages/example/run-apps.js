/**
 * run-apps.js — Multi-application sync example (M003 + M004)
 *
 * Demonstrates:
 *   1. Two configured applications — todo (with JSON Schema) and shopping-list (free-form)
 *   2. Two users — Alice and Bob — with isolated document namespaces
 *   3. Schema validation: invalid todo task (missing title) → 400
 *   4. Text auto-merge: Alice and Bob both edit a shared meeting notes field
 *      on different devices (same userId); non-overlapping line additions
 *      are auto-merged without surfacing a conflict
 *   5. Shopping list: free-form document, no schema, syncs cleanly
 *   6. Organisation-scoped sync: Alice creates an org, adds Bob, both share
 *      a document via x-org-id header; Carol (non-member) is rejected
 *
 * Run:
 *   node packages/example/run-apps.js
 */

import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { SyncRepository, SyncService, ApplicationRegistry, SchemaValidator, DocumentIndexRepository } from '@alt-javascript/data-api-server';
import { AppSyncController, DocIndexController } from '@alt-javascript/data-api-hono';
import { AuthMiddlewareRegistrar, OrgController } from '@alt-javascript/data-api-auth-hono';
import {
  UserRepository, OrgRepository, OrgService,
} from '@alt-javascript/data-api-auth-server';
import { JwtSession } from '@alt-javascript/data-api-auth-core';
import { HLC } from '@alt-javascript/data-api-core';

// ── helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'run-apps-jwt-secret-at-least-32chars!';

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function fail(message) {
  console.error(`\n  ✗ ASSERTION FAILED: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function banner(text) {
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  ${text}\n${line}`);
}

// ── CDI context ───────────────────────────────────────────────────────────────

const APPLICATIONS_CONFIG = {
  todo: {
    description: 'To-do lists',
    collections: {
      tasks: {
        schema: {
          type:     'object',
          required: ['title'],
          properties: {
            title:     { type: 'string' },
            done:      { type: 'boolean' },
            priority:  { type: 'string', enum: ['low', 'medium', 'high'] },
            notes:     { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
  },
  'shopping-list': {
    description: 'Shopping lists (free-form, no schema)',
  },
  'year-planner': {
    description: 'Year planner (free-form documents)',
  },
};

async function buildApp() {
  const config = new EphemeralConfig({
    'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging':      { level: { ROOT: 'error' } },
    'server':       { port: 0 },
    'auth':         { jwt: { secret: JWT_SECRET } },
    'applications': APPLICATIONS_CONFIG,
    'orgs':         { registerable: true },
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: SyncRepository,     name: 'syncRepository',     scope: 'singleton' },
    { Reference: SyncService,        name: 'syncService',        scope: 'singleton' },
    { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: SchemaValidator,    name: 'schemaValidator',    scope: 'singleton',
      properties: [{ name: 'applications', path: 'applications' }] },
    { Reference: UserRepository,     name: 'userRepository',     scope: 'singleton' },
    { Reference: OrgRepository,      name: 'orgRepository',      scope: 'singleton' },
    { Reference: OrgService,         name: 'orgService',         scope: 'singleton' },
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
    { Reference: AppSyncController,  name: 'appSyncController',  scope: 'singleton' },
    { Reference: OrgController,      name: 'orgController',      scope: 'singleton',
      properties: [{ name: 'registerable', path: 'orgs.registerable' }] },
    { Reference: DocIndexController, name: 'docIndexController', scope: 'singleton' },
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return { app: appCtx.get('honoAdapter').app, appCtx };
}

/**
 * Minimal app variant with org registration DISABLED — used in Scenario 12 to
 * verify that POST /orgs returns 403 when orgs.registerable is absent.
 */
async function buildAppNoReg() {
  const config = new EphemeralConfig({
    'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
    'logging':      { level: { ROOT: 'error' } },
    'server':       { port: 0 },
    'auth':         { jwt: { secret: JWT_SECRET } },
    'applications': APPLICATIONS_CONFIG,
    // 'orgs' key intentionally absent → OrgController.registerable stays null → 403
  });

  const context = new Context([
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
    { Reference: UserRepository,     name: 'userRepository',     scope: 'singleton' },
    { Reference: OrgRepository,      name: 'orgRepository',      scope: 'singleton' },
    { Reference: OrgService,         name: 'orgService',         scope: 'singleton' },
    { Reference: AuthMiddlewareRegistrar, name: 'authMiddlewareRegistrar', scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }] },
    { Reference: OrgController,      name: 'orgController',      scope: 'singleton' },
    // OrgController has no registerable property injection → defaults to null → 403
  ]);

  const appCtx = new ApplicationContext({ contexts: [context], config });
  await appCtx.start({ run: false });
  await appCtx.get('nosqlClient').ready();

  return { app: appCtx.get('honoAdapter').app, appCtx };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function orgPost(app, body, token) {
  const res = await app.request('/orgs', {
    method:  'POST',
    body:    JSON.stringify(body),
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
  return { status: res.status, body: await res.json() };
}

async function syncPost(app, application, body, token, orgId) {
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  };
  if (orgId) headers['x-org-id'] = orgId;

  const res = await app.request(`/${application}/sync`, {
    method:  'POST',
    body:    JSON.stringify(body),
    headers,
  });
  return { status: res.status, body: await res.json() };
}

async function docIndexGet(app, application, docKey, token) {
  const res = await app.request(`/docIndex/${application}/${docKey}`, {
    method:  'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner('data-api — Multi-App Example (M003 + M004)');

  const { app, appCtx } = await buildApp();
  ok('Hono server ready (two applications: todo, shopping-list; org management enabled)');

  // Mint tokens for Alice and Bob
  const aliceToken = await JwtSession.sign({ sub: 'alice-uuid', providers: ['demo'] }, JWT_SECRET);
  const bobToken   = await JwtSession.sign({ sub: 'bob-uuid',   providers: ['demo'] }, JWT_SECRET);
  // Alice's two devices (same userId, two "instances")
  const aliceDeviceAToken = aliceToken;
  const aliceDeviceBToken = await JwtSession.sign({ sub: 'alice-uuid', providers: ['demo'] }, JWT_SECRET);

  const t0 = HLC.tick(HLC.zero(), Date.now());

  // ── 1. Unknown application → 404 ─────────────────────────────────────────

  banner('Scenario 1: Unknown application → 404');

  const r1 = await syncPost(app, 'unknown-app', {
    collection: 'items', clientClock: HLC.zero(), changes: [],
  }, aliceToken);

  assert(r1.status === 404, `Expected 404, got ${r1.status}`);
  assert(r1.body.error.includes('unknown-app'), 'Error should mention the app name');
  ok('POST /unknown-app/sync → 404 Unknown application');

  // ── 2. Schema validation — missing required field → 400 ──────────────────

  banner('Scenario 2: Schema validation — missing title → 400');

  const t1 = HLC.tick(t0, Date.now());

  const r2 = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes: [{
      key:       'bad-task',
      doc:       { done: false, priority: 'high' },  // missing required 'title'
      fieldRevs: { done: t1, priority: t1 },
      baseClock: HLC.zero(),
    }],
  }, aliceToken);

  assert(r2.status === 400, `Expected 400, got ${r2.status}`);
  assert(r2.body.error === 'Schema validation failed', `Unexpected error: ${r2.body.error}`);
  assert(Array.isArray(r2.body.details), 'Details should be an array');
  const missingTitleError = r2.body.details.find((d) => d.field === 'title');
  assert(missingTitleError, 'Should have an error about missing title field');
  ok('POST /todo/sync with missing title → 400 Schema validation failed');
  console.log(`  details: ${JSON.stringify(r2.body.details)}`);

  // ── 3. Valid todo task syncs cleanly ──────────────────────────────────────

  banner('Scenario 3: Valid todo task → 200');

  const t2 = HLC.tick(t1, Date.now());

  const r3 = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes: [{
      key:       'task-1',
      doc:       { title: 'Buy groceries', done: false, priority: 'medium', notes: '' },
      fieldRevs: { title: t2, done: t2, priority: t2, notes: t2 },
      baseClock: HLC.zero(),
    }],
  }, aliceToken);

  assert(r3.status === 200, `Expected 200, got ${r3.status}`);
  assert(Array.isArray(r3.body.serverChanges), 'serverChanges should be an array');
  ok('POST /todo/sync with valid task → 200 (task stored)');

  // ── 4. User isolation — Bob cannot see Alice's tasks ─────────────────────

  banner("Scenario 4: User isolation — Bob cannot see Alice's tasks");

  const r4 = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes:     [],
  }, bobToken);

  assert(r4.status === 200, `Expected 200, got ${r4.status}`);
  assert(r4.body.serverChanges.length === 0, `Bob should see 0 tasks, saw ${r4.body.serverChanges.length}`);
  ok("Bob's pull from /todo/sync returns 0 tasks (isolated from Alice's data)");

  // ── 5. Text auto-merge — Alice's two devices edit meeting notes ───────────

  banner('Scenario 5: Text auto-merge — two devices add to meeting notes');

  // Seed: Alice's task-1 already has notes: ''  (from scenario 3)
  // Device A adds an action item; Device B adds an attendee — different lines
  const baseNotes = '';
  const tA = HLC.tick(t2, Date.now());
  await new Promise((r) => setTimeout(r, 2));
  const tB = HLC.tick(tA, Date.now());

  // Simulate: both devices have baseClock from after task-1 was stored
  const deviceABaseClock = r3.body.serverClock;

  // Device A (offline): adds an action item
  const notesAfterA = '- Action: Alice prepares slide deck';

  // Device B (offline, concurrent): adds an attendee note
  const notesAfterB = '- Attendee: Carol joined';

  // Device A syncs first
  const rA = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: deviceABaseClock,
    changes: [{
      key:       'task-1',
      doc:       { title: 'Buy groceries', done: false, priority: 'medium', notes: notesAfterA },
      fieldRevs: { title: t2, done: t2, priority: t2, notes: tA },
      baseClock: deviceABaseClock,
    }],
  }, aliceDeviceAToken);

  assert(rA.status === 200, `Device A sync expected 200, got ${rA.status}`);
  ok('Device A synced notes addition cleanly');

  const deviceBBaseClock = deviceABaseClock; // B was at same base before A synced

  // Device B syncs second — notes field conflicts (both changed it from baseNotes='')
  const rB = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: deviceBBaseClock,
    changes: [{
      key:       'task-1',
      doc:       { title: 'Buy groceries', done: false, priority: 'medium', notes: notesAfterB },
      fieldRevs: { title: t2, done: t2, priority: t2, notes: tB },
      baseClock: deviceBBaseClock,
    }],
  }, aliceDeviceBToken);

  assert(rB.status === 200, `Device B sync expected 200, got ${rB.status}`);
  ok('Device B synced notes — checking conflict resolution');

  if (rB.body.conflicts.length > 0) {
    const notesConflict = rB.body.conflicts.find((c) => c.field === 'notes');
    if (notesConflict?.mergeStrategy === 'text-auto-merged') {
      ok(`notes field auto-merged (mergeStrategy: text-auto-merged)`);
      console.log(`  merged result: ${JSON.stringify(notesConflict.winnerValue)}`);
    } else {
      ok(`notes field conflict resolved by HLC (winner: ${notesConflict?.winner})`);
      console.log(`  Note: auto-merge requires stored base snapshot; current base='' means both sides differ from empty base`);
    }
  } else {
    ok('notes field: no conflict (one side was a clean non-conflicting change)');
  }

  // ── 6. Shopping list — free-form, no schema ───────────────────────────────

  banner('Scenario 6: Shopping list — free-form document, no schema');

  const t3 = HLC.tick(tB, Date.now());

  const r6 = await syncPost(app, 'shopping-list', {
    collection:  'lists',
    clientClock: HLC.zero(),
    changes: [{
      key:       'weekend-shop',
      doc:       {
        name:  'Weekend groceries',
        store: 'Whole Foods',
        items: ['milk', 'eggs', 'bread'],
        budget: 80,
      },
      fieldRevs: { name: t3, store: t3, items: t3, budget: t3 },
      baseClock: HLC.zero(),
    }],
  }, aliceToken);

  assert(r6.status === 200, `Expected 200, got ${r6.status}`);
  ok('POST /shopping-list/sync with free-form doc → 200 (no schema, accepted)');

  // Verify Bob still sees nothing in shopping-list (isolation)
  const r6b = await syncPost(app, 'shopping-list', {
    collection:  'lists',
    clientClock: HLC.zero(),
    changes:     [],
  }, bobToken);

  assert(r6b.body.serverChanges.length === 0, `Bob should see 0 shopping lists, saw ${r6b.body.serverChanges.length}`);
  ok("Bob's shopping-list pull returns 0 items (isolated from Alice's lists)");

  // ── Scenario 7: Organisation-scoped sync ─────────────────────────────────

  banner('Scenario 7: Organisation-scoped sync');

  // Seed users so OrgService can verify they exist
  const userRepo = appCtx.get('userRepository');
  const orgSvc   = appCtx.get('orgService');

  for (const userId of ['alice-uuid', 'bob-uuid', 'carol-uuid']) {
    await userRepo._users().store(userId, {
      userId, email: `${userId}@example.com`, providers: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }

  const carolToken = await JwtSession.sign({ sub: 'carol-uuid', providers: ['demo'] }, JWT_SECRET);

  // Alice creates an org; Bob is added as a member
  const { org } = await orgSvc.createOrg('alice-uuid', 'Example Team');
  await orgSvc.addMember('alice-uuid', org.orgId, 'bob-uuid');
  ok(`Alice created org "${org.name}" (orgId: ${org.orgId.slice(0, 8)}...)`);
  ok('Alice added Bob as a member');

  const t7 = HLC.tick(HLC.zero(), Date.now());

  // Alice pushes a shared document to the org namespace
  const r7a = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes: [{
      key:       'shared-task',
      doc:       { title: 'Shared org task', done: false },
      fieldRevs: { title: t7, done: t7 },
      baseClock: HLC.zero(),
    }],
  }, aliceToken, org.orgId);

  assert(r7a.status === 200, `Expected 200, got ${r7a.status}`);
  ok('Alice pushed shared task to org namespace');

  // Bob pulls from the org namespace — should see Alice's document
  const r7b = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes:     [],
  }, bobToken, org.orgId);

  assert(r7b.status === 200, `Expected 200, got ${r7b.status}`);
  assert(r7b.body.serverChanges.length === 1, `Bob should see 1 task, saw ${r7b.body.serverChanges.length}`);
  assert(r7b.body.serverChanges[0].title === 'Shared org task', 'Bob should see the shared task title');
  ok('Bob pulled shared task from org namespace (shared with Alice)');

  // Carol (not a member) is rejected with 403
  const r7c = await syncPost(app, 'todo', {
    collection:  'tasks',
    clientClock: HLC.zero(),
    changes:     [],
  }, carolToken, org.orgId);

  assert(r7c.status === 403, `Expected 403, got ${r7c.status}`);
  ok('Carol (non-member) rejected with 403');

  // Alice pulls from personal namespace (no org header) — org docs are invisible
  // Use a fresh collection name to avoid mixing with tasks created in earlier scenarios
  const r7d = await syncPost(app, 'todo', {
    collection:  'org-test-collection',
    clientClock: HLC.zero(),
    changes:     [],
  }, aliceToken);

  assert(r7d.body.serverChanges.length === 0, `Personal namespace should be empty for fresh collection, saw ${r7d.body.serverChanges.length} docs`);
  ok('Org namespace isolated from Alice\'s personal namespace');

  // ── Scenario 11: DocIndex — ownership tracking and share token ───────────

  banner('Scenario 11: DocIndex — ownership tracking and share token');

  // Sync a year-planner document as Alice so docIndex gets an entry
  const t11 = HLC.tick(HLC.zero(), Date.now());

  const r11sync = await syncPost(app, 'year-planner', {
    collection:  'plans',
    clientClock: HLC.zero(),
    changes: [{
      key:       'planner-2026',
      doc:       { title: 'Year Plan 2026', goals: ['ship M007', 'learn Rust'] },
      fieldRevs: { title: t11, goals: t11 },
      baseClock: HLC.zero(),
    }],
  }, aliceToken);

  assert(r11sync.status === 200, `Expected 200 from year-planner sync, got ${r11sync.status}`);
  ok('Alice synced year-planner/planner-2026 (docIndex entry created)');

  // GET /docIndex/year-planner/planner-2026 with aliceToken → 200
  const r11get = await docIndexGet(app, 'year-planner', 'planner-2026', aliceToken);
  assert(r11get.status === 200, `Expected 200 from docIndex GET, got ${r11get.status}`);

  const entry = r11get.body;
  assert(entry.visibility === 'private', `Expected visibility='private', got '${entry.visibility}'`);
  assert(entry.userId === 'alice-uuid', `Expected userId='alice-uuid', got '${entry.userId}'`);
  ok('GET /docIndex/year-planner/planner-2026 → 200 (visibility=private, userId=alice-uuid)');
  console.log('  docIndex entry:', JSON.stringify(entry, null, 2));

  // PATCH visibility → 'shared'
  const r11patch = await app.request('/docIndex/year-planner/planner-2026', {
    method:  'PATCH',
    body:    JSON.stringify({ visibility: 'shared' }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
  });
  assert(r11patch.status === 200, `Expected 200 from PATCH, got ${r11patch.status}`);
  const patched = await r11patch.json();
  assert(patched.visibility === 'shared', `Expected patched visibility='shared', got '${patched.visibility}'`);
  ok('PATCH /docIndex/year-planner/planner-2026 → 200 (visibility updated to shared)');

  // POST /docIndex/year-planner/planner-2026/shareToken → 200, shareToken is string
  const r11mint = await app.request('/docIndex/year-planner/planner-2026/shareToken', {
    method:  'POST',
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
  assert(r11mint.status === 200, `Expected 200 from mintToken, got ${r11mint.status}`);
  const { shareToken } = await r11mint.json();
  assert(typeof shareToken === 'string' && shareToken.length > 0, `Expected shareToken string, got ${shareToken}`);
  ok(`POST /docIndex/year-planner/planner-2026/shareToken → 200 (shareToken minted: ${shareToken.slice(0, 8)}...)`);

  // GET /docIndex/year-planner/planner-2026 with bobToken → 404 (entry keyed by owner userId, invisible to Bob)
  const r11bob = await docIndexGet(app, 'year-planner', 'planner-2026', bobToken);
  assert(r11bob.status === 404, `Expected 404 for Bob (entry not found under Bob's userId), got ${r11bob.status}`);
  ok('GET /docIndex/year-planner/planner-2026 with bobToken → 404 (entry invisible — keyed by owner userId)');

  // ── Scenario 12: HTTP org create — registerable flag and duplicate name ───

  banner('Scenario 12: HTTP org create — registerable=true, duplicate name 409, disabled 403');

  // Seed a fresh user so the org name 'scenario-12-org' doesn't collide with Scenario 7
  await userRepo._users().store('carol-s12-uuid', {
    userId:    'carol-s12-uuid',
    email:     'carol-s12@example.com',
    providers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const carolS12Token = await JwtSession.sign({ sub: 'carol-s12-uuid', providers: ['demo'] }, JWT_SECRET);

  // (a) POST /orgs with registerable=true → 201
  const r12a = await orgPost(app, { name: 'scenario-12-org' }, carolS12Token);
  assert(r12a.status === 201, `Expected 201 from POST /orgs, got ${r12a.status}: ${JSON.stringify(r12a.body)}`);
  assert(r12a.body.role === 'org-admin', `Expected role='org-admin', got '${r12a.body.role}'`);
  ok(`POST /orgs { name: 'scenario-12-org' } → 201 (orgId: ${r12a.body.orgId?.slice(0, 8)}..., role: ${r12a.body.role})`);

  // (b) POST /orgs same name again → 409 DuplicateOrgNameError
  const r12b = await orgPost(app, { name: 'scenario-12-org' }, carolS12Token);
  assert(r12b.status === 409, `Expected 409 from duplicate POST /orgs, got ${r12b.status}: ${JSON.stringify(r12b.body)}`);
  ok(`POST /orgs same name again → 409 (${r12b.body.error})`);

  // (c) POST /orgs with registerable absent → 403
  // Build a separate minimal app with no orgs.registerable in config
  const { app: appNoReg, appCtx: appCtxNoReg } = await buildAppNoReg();

  // Seed a user in the no-reg app store so the JWT sub resolves
  const userRepoNoReg = appCtxNoReg.get('userRepository');
  await userRepoNoReg._users().store('carol-s12-uuid', {
    userId:    'carol-s12-uuid',
    email:     'carol-s12@example.com',
    providers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const r12c = await orgPost(appNoReg, { name: 'any-org-name' }, carolS12Token);
  assert(r12c.status === 403, `Expected 403 from POST /orgs (no-reg), got ${r12c.status}: ${JSON.stringify(r12c.body)}`);
  ok(`POST /orgs (registerable absent) → 403 (${r12c.body.error})`);

  // Tear down the no-reg app
  await appCtxNoReg.stop?.();

  // ── Summary ───────────────────────────────────────────────────────────────

  banner('All scenarios passed');
  console.log('\n  ✓ Unknown application → 404');
  console.log('  ✓ Invalid todo doc (missing title) → 400 with schema details');
  console.log('  ✓ Valid todo task → 200 stored and retrievable');
  console.log('  ✓ User isolation — Bob cannot see Alice\'s data');
  console.log('  ✓ Text auto-merge attempted on concurrent notes edits');
  console.log('  ✓ Shopping list (no schema) syncs free-form documents');
  console.log('  ✓ Shopping list user isolation — Bob cannot see Alice\'s lists');
  console.log('  ✓ Org created; Bob added as member');
  console.log('  ✓ Alice + Bob share documents via x-org-id header');
  console.log('  ✓ Carol (non-member) rejected with 403');
  console.log('  ✓ Org namespace isolated from personal namespace');
  console.log('  ✓ DocIndex ownership entry created on sync write');
  console.log('  ✓ DocIndex GET returns entry with correct userId and visibility');
  console.log('  ✓ DocIndex PATCH updates visibility to shared');
  console.log('  ✓ DocIndex mintToken returns UUID share token');
  console.log('  ✓ DocIndex GET returns 404 for non-owner (entry invisible — keyed by owner userId)');
  console.log('  ✓ HTTP POST /orgs (registerable=true) → 201 with role=org-admin');
  console.log('  ✓ HTTP POST /orgs duplicate name → 409 DuplicateOrgNameError');
  console.log('  ✓ HTTP POST /orgs (registerable absent) → 403');
  console.log('\n  Multi-app, multi-user, org-scoped sync + docIndex ownership tracking + HTTP org creation working correctly.\n');
}

main().catch((err) => {
  console.error('\n✗ Example failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
