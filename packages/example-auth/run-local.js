// packages/example-auth/run-local.js
/**
 * run-local.js — Local POC server with full jsmdma auth stack.
 *
 * Starts a real HTTP server on 127.0.0.1:8081.
 * Issues jsmdma JWTs after Google OAuth redirect flow.
 * Uses in-memory jsnosqlc for storage (data is lost on restart).
 *
 * Required environment variables:
 *   GOOGLE_CLIENT_ID      — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET  — Google OAuth client secret
 *   JWT_SECRET            — HS256 signing secret (min 32 chars)
 *
 * Google Cloud Console setup:
 *   Authorised redirect URIs must include:
 *     http://127.0.0.1:8081/auth/google/callback
 *   Authorised JavaScript origins must include:
 *     http://localhost:8080
 *     http://127.0.0.1:8080
 *
 * Run:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... JWT_SECRET=... \
 *     node packages/example-auth/run-local.js
 *
 * Sign-in flow:
 *   1. Browser: GET http://127.0.0.1:8081/auth/google
 *      → JSON { authorizationURL, state, codeVerifier }
 *   2. Browser: store state + codeVerifier in sessionStorage; redirect to authorizationURL
 *   3. Google: redirect to http://127.0.0.1:8081/auth/google/callback?code=...&state=...
 *   4. Browser: POST state + codeVerifier from sessionStorage to callback
 *      → JSON { user, token }
 *   5. Browser: store token in localStorage as auth_token
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
import { authHonoStarter } from '@alt-javascript/jsmdma-auth-hono';
import { GoogleProvider } from '@alt-javascript/jsmdma-auth-core';
import CorsMiddlewareRegistrar from './CorsMiddlewareRegistrar.js';

// ── validate env ──────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const JWT_SECRET           = process.env.JWT_SECRET;

const missing = [
  !GOOGLE_CLIENT_ID     && 'GOOGLE_CLIENT_ID',
  !GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
  !JWT_SECRET           && 'JWT_SECRET',
].filter(Boolean);

if (missing.length) {
  console.error('\nError: Missing required environment variables:', missing.join(', '));
  console.error('\nUsage:');
  console.error('  GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret> JWT_SECRET=<secret32> \\');
  console.error('    node packages/example-auth/run-local.js\n');
  process.exit(1);
}

if (JWT_SECRET.length < 32) {
  console.error('\nError: JWT_SECRET must be at least 32 characters.\n');
  process.exit(1);
}

// ── config ────────────────────────────────────────────────────────────────────

const REDIRECT_URI = 'http://127.0.0.1:8081/auth/google/callback';

const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner application',
    collections: {
      planners: {
        schemaPath: './packages/server/schemas/planner.json',
      },
      preferences: {
        schemaPath: './packages/server/schemas/preferences.json',
      },
    },
  },
};

// ── CDI context ───────────────────────────────────────────────────────────────

const config = new EphemeralConfig({
  'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  'logging':      { level: { ROOT: 'info' } },
  'server':       { port: 8081, host: '127.0.0.1' },
  'auth':         { jwt: { secret: JWT_SECRET } },
  'applications': APPLICATIONS_CONFIG,
  'orgs':         { registerable: false },
});

const context = new Context([
  ...honoStarter(),
  ...jsnosqlcAutoConfiguration(),
  { Reference: SyncRepository,    name: 'syncRepository',    scope: 'singleton' },
  { Reference: SyncService,       name: 'syncService',       scope: 'singleton' },
  { Reference: ApplicationRegistry, name: 'applicationRegistry', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  { Reference: SchemaValidator, name: 'schemaValidator', scope: 'singleton',
    properties: [{ name: 'applications', path: 'applications' }] },
  // CORS must be first
  { Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton' },
  // Full auth stack: AuthMiddlewareRegistrar MUST come before AppSyncController
  ...authHonoStarter(),
  { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
]);

const appCtx = new ApplicationContext({ contexts: [context], config });

// ── start ─────────────────────────────────────────────────────────────────────

async function main() {
  await appCtx.start();
  await appCtx.get('nosqlClient').ready();

  // Set OAuth providers post-startup (providers are runtime instances, not CDI beans)
  appCtx.get('authController').providers = {
    google: new GoogleProvider({
      clientId:     GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri:  REDIRECT_URI,
    }),
  };

  console.log('\n  jsmdma local POC server running on http://127.0.0.1:8081');
  console.log('  Routes:');
  console.log('    GET  /health');
  console.log('    GET  /auth/google              → begin OAuth (returns authorizationURL JSON)');
  console.log('    GET  /auth/google/callback     → complete OAuth (returns { user, token })');
  console.log('    GET  /auth/me                  → current user (requires JWT)');
  console.log('    POST /year-planner/sync        → HLC sync (requires JWT)');
  console.log('  Auth: jsmdma JWT (issued after Google OAuth redirect flow)');
  console.log('  Storage: in-memory (data lost on restart)');
  console.log('\n  Start the SPA: npx http-server site/ -p 8080 (in year-planner repo)');
  console.log('  Sign in: redirect to http://127.0.0.1:8081/auth/google\n');
}

main().catch((err) => {
  console.error('\nFailed to start:', err.message);
  console.error(err.stack);
  process.exit(1);
});
