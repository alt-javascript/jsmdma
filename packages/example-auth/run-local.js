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
 *   GITHUB_CLIENT_ID      — GitHub OAuth App client ID
 *   GITHUB_CLIENT_SECRET  — GitHub OAuth App client secret
 *   JWT_SECRET            — HS256 signing secret (min 32 chars)
 *
 * Optional environment variables:
 *   SPA_ORIGIN            — origin of the SPA (default: http://localhost:8080)
 *
 * Google Cloud Console setup:
 *   Authorised redirect URIs should include both legacy and boot-oauth callbacks:
 *     http://127.0.0.1:8081/auth/google/callback
 *     http://127.0.0.1:8081/oauth/google/callback
 *   Authorised JavaScript origins must include:
 *     http://localhost:8080
 *     http://127.0.0.1:8080
 *
 * Run:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
 *   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
 *   JWT_SECRET=... node packages/example-auth/run-local.js
 */

import {
  buildRunLocalStarterApp,
  createRunLocalAuthProviders,
  ensureRunLocalEnv,
} from './runtime/authStarterRuntime.js';

function printUsage() {
  console.error('\nUsage:');
  console.error('  GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret> \\');
  console.error('  GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> \\');
  console.error('  JWT_SECRET=<secret32> node packages/example-auth/run-local.js\n');
}

async function main() {
  let env;

  try {
    env = ensureRunLocalEnv();
  } catch (err) {
    if (err?.code === 'MISSING_ENV') {
      console.error(`\nError: Missing required environment variables: ${err.missing.join(', ')}`);
      printUsage();
      process.exit(1);
    }

    if (err?.code === 'INVALID_ENV') {
      console.error(`\nError: ${err.message}\n`);
      process.exit(1);
    }

    throw err;
  }

  const providers = createRunLocalAuthProviders({
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
  });

  await buildRunLocalStarterApp({
    run: true,
    jwtSecret: env.JWT_SECRET,
    googleClientId: env.GOOGLE_CLIENT_ID,
    githubClientId: env.GITHUB_CLIENT_ID,
    providers,
    spaOrigin: env.SPA_ORIGIN,
  });

  console.log('\n  jsmdma local POC server running on http://127.0.0.1:8081');
  console.log('  Routes:');
  console.log('    GET  /health');
  console.log('    GET  /oauth/google/authorize    → boot oauth authorize start (302 + Location/Set-Cookie)');
  console.log('    GET  /oauth/google/callback     → boot oauth callback consume (typed json envelope)');
  console.log('    GET  /oauth/github/authorize    → boot oauth github authorize start');
  console.log('    GET  /oauth/github/callback     → boot oauth github callback consume');
  console.log('    GET  /auth/google               → begin OAuth (returns authorizationURL JSON)');
  console.log('    GET  /auth/google/callback      → complete OAuth (returns { user, token })');
  console.log('    GET  /auth/github               → begin GitHub OAuth');
  console.log('    GET  /auth/github/callback      → complete GitHub OAuth');
  console.log('    GET  /auth/me                   → current user (requires JWT)');
  console.log('    POST /year-planner/sync         → HLC sync (requires JWT)');
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
