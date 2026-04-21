// packages/example-auth/run-local.js
/**
 * run-local.js — Local POC server with full jsmdma auth stack.
 *
 * Starts a real HTTP server on 127.0.0.1:8081.
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
 *   Authorised redirect URIs should include canonical oauth callbacks:
 *     http://127.0.0.1:8081/oauth/google/callback
 *     http://127.0.0.1:8081/oauth/github/callback
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
  console.log('    GET  /oauth/google/authorize    → browser redirect start (302 + Location/Set-Cookie)');
  console.log('    GET  /oauth/google/callback     → callback consume (typed envelope, replay/malformed aware)');
  console.log('    GET  /oauth/github/authorize    → browser redirect start (GitHub)');
  console.log('    GET  /oauth/github/callback     → callback consume (GitHub)');
  console.log('    GET  /auth/google               → transaction start JSON ({ authorizationURL, state })');
  console.log('    GET  /auth/github               → transaction start JSON ({ authorizationURL, state })');
  console.log('    POST /auth/login/finalize       → mode-aware login completion (bearer|cookie/session)');
  console.log('    GET  /auth/me                   → current user session (mode-aware)');
  console.log('    POST /auth/link/finalize        → link an additional provider');
  console.log('    DELETE /auth/unlink/:provider   → unlink provider (typed lockout on last provider)');
  console.log('    POST /auth/signout              → mode-aware signout');
  console.log('    POST /year-planner/sync         → HLC sync (requires auth)');
  console.log('  Auth: JWT bearer or cookie session via split-flow lifecycle endpoints');
  console.log('  Storage: in-memory (data lost on restart)');
  console.log('\n  Start the SPA: npx http-server site/ -p 8080 (in year-planner repo)');
  console.log('  Browser flow start: http://127.0.0.1:8081/oauth/google/authorize (or /oauth/github/authorize)\n');
}

main().catch((err) => {
  console.error('\nFailed to start:', err.message);
  console.error(err.stack);
  process.exit(1);
});
