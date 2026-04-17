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
 *   GITHUB_CLIENT_ID     — GitHub OAuth App client ID
 *   GITHUB_CLIENT_SECRET — GitHub OAuth App client secret
 *   JWT_SECRET            — HS256 signing secret (min 32 chars)
 *
 * Optional environment variables:
 *   SPA_ORIGIN            — origin of the SPA (default: http://localhost:8080)
 *
 * Google Cloud Console setup:
 *   Authorised redirect URIs must include:
 *     http://127.0.0.1:8081/auth/google/callback
 *   Authorised JavaScript origins must include:
 *     http://localhost:8080
 *     http://127.0.0.1:8080
 *
 * Run:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *     GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
 *     JWT_SECRET=... node packages/example-auth/run-local.js
 *
 * Sign-in flow (BFF pattern — codeVerifier never leaves server):
 *   1. Browser: GET http://127.0.0.1:8081/auth/google
 *      → JSON { authorizationURL, state }
 *   2. Browser: redirect to authorizationURL
 *   3. Google: redirect to http://127.0.0.1:8081/auth/google/callback?code=...&state=...
 *   4. Server: looks up codeVerifier by state, exchanges with Google, issues JWT
 *      → 302 redirect to {SPA_ORIGIN}/?token=<jwt>
 *   5. SPA: ?token= handler stores JWT in localStorage
 */

import '@alt-javascript/jsnosqlc-memory';
import { Context, ApplicationContext } from '@alt-javascript/cdi';
import { EphemeralConfig } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from 'packages/jsmdma-hono';
import { GoogleProvider, GitHubProvider } from 'packages/jsmdma-auth-core';
import { LoggerFactory } from '@alt-javascript/logger';
import { fileURLToPath } from 'node:url';
import CorsMiddlewareRegistrar from './CorsMiddlewareRegistrar.js';

// ── validate env ──────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const JWT_SECRET           = process.env.JWT_SECRET;

const missing = [
  !GOOGLE_CLIENT_ID     && 'GOOGLE_CLIENT_ID',
  !GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
  !GITHUB_CLIENT_ID     && 'GITHUB_CLIENT_ID',
  !GITHUB_CLIENT_SECRET && 'GITHUB_CLIENT_SECRET',
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

const GOOGLE_REDIRECT_URI  = 'http://127.0.0.1:8081/auth/google/callback';
const GITHUB_REDIRECT_URI  = 'http://127.0.0.1:8081/auth/github/callback';
const SPA_ORIGIN   = process.env.SPA_ORIGIN || 'http://localhost:8080';

const PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner.json', import.meta.url));
const APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../example/schemas/planner-preferences.json', import.meta.url));
const GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../server/schemas/preferences.json', import.meta.url));

const APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner application',
    collections: {
      planners: {
        schemaPath: PLANNER_SCHEMA_PATH,
      },
      preferences: {
        schemaPath: GENERIC_PREFERENCES_SCHEMA_PATH,
      },
      'planner-preferences': {
        schemaPath: APP_PREFERENCES_SCHEMA_PATH,
      },
    },
  },
};

// ── CDI context ───────────────────────────────────────────────────────────────

const config = new EphemeralConfig({
  'boot':         { 'banner-mode': 'off', nosql: { url: 'jsnosqlc:memory:' } },
  'logging':      { format: 'text', level: { ROOT: 'debug' } },
  'server':       { port: 8081, host: '127.0.0.1' },
  'auth':         { jwt: { secret: JWT_SECRET } },
  'applications': APPLICATIONS_CONFIG,
  'orgs':         { registerable: false },
});

const context = new Context([
  // Explicit loggerFactory with config so logging.format='text' is respected
  { Reference: LoggerFactory, name: 'loggerFactory', scope: 'singleton',
    constructorArgs: [config] },
  ...jsmdmaHonoStarter({
    hooks: {
      // CORS must stay ahead of auth middleware registration.
      beforeAuth: [{ Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton' }],
    },
  }),
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
      redirectUri:  GOOGLE_REDIRECT_URI,
    }),
    github: new GitHubProvider({
      clientId:     GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      redirectUri:  GITHUB_REDIRECT_URI,
    }),
  };
  appCtx.get('authController').spaOrigin = SPA_ORIGIN;

  console.log('\n  jsmdma local POC server running on http://127.0.0.1:8081');
  console.log('  Routes:');
  console.log('    GET  /health');
  console.log('    GET  /auth/google              → begin OAuth (returns authorizationURL JSON)');
  console.log('    GET  /auth/google/callback     → complete OAuth (returns { user, token })');
  console.log('    GET  /auth/github              → begin GitHub OAuth');
  console.log('    GET  /auth/github/callback     → complete GitHub OAuth');
  console.log('    GET  /auth/me                  → current user (requires JWT)');
  console.log('    POST /year-planner/sync        → HLC sync (requires JWT)');
  console.log('  Auth: jsmdma JWT (issued after Google or GitHub OAuth redirect flow)');
  console.log('  Storage: in-memory (data lost on restart)');
  console.log('\n  Start the SPA: npx http-server site/ -p 8080 (in year-planner repo)');
  console.log('  Sign in: redirect to http://127.0.0.1:8081/auth/google or /auth/github\n');
}

main().catch((err) => {
  console.error('\nFailed to start:', err.message);
  console.error(err.stack);
  process.exit(1);
});
