// packages/example-auth/run-local.js
/**
 * run-local.js — Local POC server for Phase 12 end-to-end sync testing.
 *
 * Starts a real HTTP server on 127.0.0.1:8081.
 * Verifies Google ID tokens (not jsmdma JWTs).
 * Uses in-memory jsnosqlc for storage (data is lost on restart).
 *
 * Run:
 *   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \
 *     node packages/example-auth/run-local.js
 *
 * Routes served:
 *   GET  /health              — liveness check
 *   POST /year-planner/sync   — HLC sync endpoint (requires Google ID token)
 */

import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository,
  SyncService,
  ApplicationRegistry,
  SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import { AppSyncController } from '@alt-javascript/jsmdma-hono';
import CorsMiddlewareRegistrar from './CorsMiddlewareRegistrar.js';
import GoogleIdTokenMiddlewareRegistrar from './GoogleIdTokenMiddlewareRegistrar.js';

// ── config ────────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
  console.error('\nError: GOOGLE_CLIENT_ID environment variable is required.\n');
  console.error('  GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com \\');
  console.error('    node packages/example-auth/run-local.js\n');
  process.exit(1);
}

const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner application',
    collections: {
      planners: {
        schemaPath: './packages/server/schemas/planner.json',
      },
    },
  },
};

// ── CDI context ───────────────────────────────────────────────────────────────

const config = new EphemeralConfig({
  'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  'logging':      { level: { ROOT: 'info' } },
  'server':       { port: 8081, host: '127.0.0.1' },
  'auth':         { google: { clientId: GOOGLE_CLIENT_ID } },
  'applications': APPLICATIONS_CONFIG,
});

const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,    name: 'syncRepository',    scope: 'singleton' },
  { Reference: SyncService,       name: 'syncService',       scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator,   name: 'schemaValidator',   scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  // CORS must be first — applies to all routes including 401 responses
  { Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton' },
  // Google auth middleware before AppSyncController
  { Reference: GoogleIdTokenMiddlewareRegistrar, name: 'googleIdTokenMiddlewareRegistrar', scope: 'singleton',
    properties: [{ name: 'googleClientId', path: 'auth.google.clientId' }] },
  { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
]);

const appCtx = new ApplicationContext({ contexts: [context], config });

// ── start ─────────────────────────────────────────────────────────────────────

async function main() {
  await appCtx.start();   // calls HonoAdapter.run() — binds TCP port 8081
  await appCtx.get('nosqlClient').ready();
  console.log('\n  jsmdma local POC server running on http://127.0.0.1:8081');
  console.log('  Routes: GET /health, POST /year-planner/sync');
  console.log('  Auth: Google OIDC ID token verification');
  console.log('  Storage: in-memory (data lost on restart)\n');
  console.log('  Start the SPA: npx http-server site/ -p 8080 (in year-planner repo)');
  console.log('  Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('\nFailed to start:', err.message);
  console.error(err.stack);
  process.exit(1);
});
