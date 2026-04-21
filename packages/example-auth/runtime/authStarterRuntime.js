import '@alt-javascript/jsnosqlc-memory';
import { Context } from '@alt-javascript/cdi';
import { Boot } from '@alt-javascript/boot';
import { ConfigFactory } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
import { GoogleProvider, GitHubProvider } from '@alt-javascript/jsmdma-auth-core';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import CorsMiddlewareRegistrar from '../CorsMiddlewareRegistrar.js';

export const AUTH_STARTER_PACKAGE_BASE_PATH = fileURLToPath(new URL('..', import.meta.url));

export const AUTH_DEFAULT_JWT_SECRET = 'example-auth-secret-must-be-32-chars!!';
export const AUTH_LOCAL_DEFAULT_SPA_ORIGIN = 'http://localhost:8080';

export const AUTH_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8081/auth/google/callback';
export const AUTH_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8081/auth/github/callback';

export const BOOT_OAUTH_GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/google/callback';
export const BOOT_OAUTH_GITHUB_REDIRECT_URI = 'http://127.0.0.1:8081/oauth/github/callback';

export const AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID = 'example-auth-only-google-client-id';
export const AUTH_ONLY_BOOT_OAUTH_GITHUB_CLIENT_ID = 'example-auth-only-github-client-id';

export const AUTH_PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner.json', import.meta.url));
export const AUTH_APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../example/schemas/planner-preferences.json', import.meta.url));
export const AUTH_GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../jsmdma-server/schemas/preferences.json', import.meta.url));

export const AUTH_LOCAL_APPLICATIONS_CONFIG = {
  'year-planner': {
    description: 'Year planner application',
    collections: {
      planners: {
        schemaPath: AUTH_PLANNER_SCHEMA_PATH,
      },
      preferences: {
        schemaPath: AUTH_GENERIC_PREFERENCES_SCHEMA_PATH,
      },
      'planner-preferences': {
        schemaPath: AUTH_APP_PREFERENCES_SCHEMA_PATH,
      },
    },
  },
};

export const AUTH_ONLY_STARTER_OPTIONS = {
  features: {
    sync: false,
    appSyncController: false,
  },
};

export const RUN_LOCAL_STARTER_OPTIONS = {
  hooks: {
    beforeAuth: [
      { Reference: CorsMiddlewareRegistrar, name: 'corsMiddlewareRegistrar', scope: 'singleton' },
    ],
  },
};

const require = createRequire(import.meta.url);

async function registerBootWorkspaceMemoryDriver() {
  let bootJsnosqlcEntry = null;

  try {
    const jsmdmaHonoEntry = require.resolve('@alt-javascript/jsmdma-hono');
    bootJsnosqlcEntry = require.resolve('@alt-javascript/boot-jsnosqlc', {
      paths: [path.dirname(jsmdmaHonoEntry)],
    });
  } catch {
    try {
      bootJsnosqlcEntry = require.resolve('@alt-javascript/boot-jsnosqlc');
    } catch {
      return;
    }
  }

  const bootMemoryDriverEntry = path.join(
    path.dirname(bootJsnosqlcEntry),
    '../../node_modules/@alt-javascript/jsnosqlc-memory/index.js',
  );

  try {
    await import(pathToFileURL(bootMemoryDriverEntry).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'ENOENT') {
      throw err;
    }
  }
}

function mergeStarterOptions(baseOptions, overrides = {}) {
  const merged = { ...baseOptions, ...overrides };

  if (Object.prototype.hasOwnProperty.call(overrides, 'features')) {
    if (overrides.features && typeof overrides.features === 'object' && !Array.isArray(overrides.features)) {
      merged.features = { ...(baseOptions.features ?? {}), ...overrides.features };
    } else {
      merged.features = overrides.features;
    }
  }

  if (Object.prototype.hasOwnProperty.call(overrides, 'hooks')) {
    if (overrides.hooks && typeof overrides.hooks === 'object' && !Array.isArray(overrides.hooks)) {
      merged.hooks = { ...(baseOptions.hooks ?? {}), ...overrides.hooks };
    } else {
      merged.hooks = overrides.hooks;
    }
  }

  return merged;
}

function assertUrlString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Malformed oauth provider config: ${name} must be a non-empty string`);
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`Malformed oauth provider config: ${name} must be a valid URL`);
  }
}

function assertProviderClientId(providerConfig, providerName) {
  if (!providerConfig || typeof providerConfig !== 'object') {
    throw new Error(`Malformed oauth provider config: providers.${providerName} must be an object`);
  }

  if (typeof providerConfig.clientId !== 'string' || providerConfig.clientId.trim().length === 0) {
    throw new Error(`Malformed oauth provider config: providers.${providerName}.clientId must be a non-empty string`);
  }

  assertUrlString(providerConfig.redirectUri, `providers.${providerName}.redirectUri`);
}

function assertBootOauthProviderConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Malformed oauth provider config: boot.oauth must be an object');
  }

  if (!config.providers || typeof config.providers !== 'object') {
    throw new Error('Malformed oauth provider config: boot.oauth.providers must be an object');
  }

  assertProviderClientId(config.providers.google, 'google');
  assertProviderClientId(config.providers.github, 'github');
}

function getMissingEnvVars(env) {
  return [
    !env.GOOGLE_CLIENT_ID?.trim() && 'GOOGLE_CLIENT_ID',
    !env.GOOGLE_CLIENT_SECRET?.trim() && 'GOOGLE_CLIENT_SECRET',
    !env.GITHUB_CLIENT_ID?.trim() && 'GITHUB_CLIENT_ID',
    !env.GITHUB_CLIENT_SECRET?.trim() && 'GITHUB_CLIENT_SECRET',
    !env.JWT_SECRET?.trim() && 'JWT_SECRET',
  ].filter(Boolean);
}

export function ensureRunLocalEnv(env = process.env) {
  const missing = getMissingEnvVars(env);
  if (missing.length > 0) {
    const error = new Error(`Missing required environment variables: ${missing.join(', ')}`);
    error.code = 'MISSING_ENV';
    error.missing = missing;
    throw error;
  }

  if (env.JWT_SECRET.trim().length < 32) {
    const error = new Error('JWT_SECRET must be at least 32 characters.');
    error.code = 'INVALID_ENV';
    throw error;
  }

  return {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID.trim(),
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET.trim(),
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID.trim(),
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET.trim(),
    JWT_SECRET: env.JWT_SECRET.trim(),
    SPA_ORIGIN: env.SPA_ORIGIN?.trim() || AUTH_LOCAL_DEFAULT_SPA_ORIGIN,
  };
}

export function createAuthOnlyStarterOptions(overrides = {}) {
  return mergeStarterOptions(AUTH_ONLY_STARTER_OPTIONS, overrides);
}

export function createRunLocalStarterOptions(overrides = {}) {
  return mergeStarterOptions(RUN_LOCAL_STARTER_OPTIONS, overrides);
}

export function loadAuthStarterConfig({
  basePath = AUTH_STARTER_PACKAGE_BASE_PATH,
  overrides,
} = {}) {
  return ConfigFactory.loadConfig({
    basePath,
    overrides,
  });
}

export function createAuthOnlyBootOauthProviderConfig({
  googleClientId = AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID,
  githubClientId = AUTH_ONLY_BOOT_OAUTH_GITHUB_CLIENT_ID,
  googleRedirectUri = BOOT_OAUTH_GOOGLE_REDIRECT_URI,
  githubRedirectUri = BOOT_OAUTH_GITHUB_REDIRECT_URI,
} = {}) {
  const bootOauthConfig = {
    providers: {
      google: {
        clientId: googleClientId,
        redirectUri: googleRedirectUri,
      },
      github: {
        clientId: githubClientId,
        redirectUri: githubRedirectUri,
      },
    },
  };

  assertBootOauthProviderConfig(bootOauthConfig);

  return bootOauthConfig;
}

export function createAuthOnlyConfigOverrides({
  jwtSecret = AUTH_DEFAULT_JWT_SECRET,
  googleClientId = AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID,
  githubClientId = AUTH_ONLY_BOOT_OAUTH_GITHUB_CLIENT_ID,
  bootOauth,
} = {}) {
  const bootOauthConfig = bootOauth ?? createAuthOnlyBootOauthProviderConfig({
    googleClientId,
    githubClientId,
  });

  assertBootOauthProviderConfig(bootOauthConfig);

  return {
    auth: { jwt: { secret: jwtSecret } },
    boot: {
      oauth: bootOauthConfig,
    },
  };
}

export function createRunLocalBootOauthProviderConfig({
  googleClientId,
  githubClientId,
} = {}) {
  const bootOauthConfig = createAuthOnlyBootOauthProviderConfig({
    googleClientId,
    githubClientId,
  });

  assertBootOauthProviderConfig(bootOauthConfig);

  return bootOauthConfig;
}

export function createRunLocalConfigOverrides({
  jwtSecret,
  googleClientId,
  githubClientId,
  applicationsConfig = AUTH_LOCAL_APPLICATIONS_CONFIG,
  server,
} = {}) {
  return {
    auth: { jwt: { secret: jwtSecret } },
    applications: applicationsConfig,
    boot: {
      oauth: createRunLocalBootOauthProviderConfig({
        googleClientId,
        githubClientId,
      }),
    },
    ...(server ? { server } : {}),
  };
}

export function createRunLocalAuthProviders({
  googleClientId,
  googleClientSecret,
  githubClientId,
  githubClientSecret,
} = {}) {
  return {
    google: new GoogleProvider({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      redirectUri: AUTH_GOOGLE_REDIRECT_URI,
    }),
    github: new GitHubProvider({
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      redirectUri: AUTH_GITHUB_REDIRECT_URI,
    }),
  };
}

export async function buildAuthStarterContext({
  configOverrides = {},
  starterOptions = {},
  run = false,
  basePath = AUTH_STARTER_PACKAGE_BASE_PATH,
} = {}) {
  await registerBootWorkspaceMemoryDriver();

  const config = loadAuthStarterConfig({
    basePath,
    overrides: configOverrides,
  });

  const context = new Context([
    ...jsmdmaHonoStarter(starterOptions),
  ]);

  const appCtx = await Boot.boot({
    contexts: [context],
    run,
    config,
  });

  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

export async function buildAuthOnlyStarterContext({
  jwtSecret = AUTH_DEFAULT_JWT_SECRET,
  googleClientId = AUTH_ONLY_BOOT_OAUTH_GOOGLE_CLIENT_ID,
  githubClientId = AUTH_ONLY_BOOT_OAUTH_GITHUB_CLIENT_ID,
  bootOauth,
  providers = {},
  starterOptions = {},
  run = false,
  basePath = AUTH_STARTER_PACKAGE_BASE_PATH,
} = {}) {
  const appCtx = await buildAuthStarterContext({
    run,
    basePath,
    configOverrides: createAuthOnlyConfigOverrides({
      jwtSecret,
      googleClientId,
      githubClientId,
      bootOauth,
    }),
    starterOptions: createAuthOnlyStarterOptions(starterOptions),
  });

  appCtx.get('authController').providers = providers;

  return appCtx;
}

export async function buildAuthOnlyStarterApp(options = {}) {
  const appCtx = await buildAuthOnlyStarterContext(options);
  return {
    app: appCtx.get('honoAdapter').app,
    appCtx,
  };
}

export async function buildRunLocalStarterContext({
  jwtSecret,
  googleClientId,
  githubClientId,
  providers = {},
  spaOrigin = AUTH_LOCAL_DEFAULT_SPA_ORIGIN,
  applicationsConfig = AUTH_LOCAL_APPLICATIONS_CONFIG,
  starterOptions = {},
  server,
  run = false,
  basePath = AUTH_STARTER_PACKAGE_BASE_PATH,
} = {}) {
  const appCtx = await buildAuthStarterContext({
    run,
    basePath,
    configOverrides: createRunLocalConfigOverrides({
      jwtSecret,
      googleClientId,
      githubClientId,
      applicationsConfig,
      server,
    }),
    starterOptions: createRunLocalStarterOptions(starterOptions),
  });

  appCtx.get('authController').providers = providers;
  appCtx.get('authController').spaOrigin = spaOrigin;

  return appCtx;
}

export async function buildRunLocalStarterApp(options = {}) {
  const appCtx = await buildRunLocalStarterContext(options);
  return {
    app: appCtx.get('honoAdapter').app,
    appCtx,
  };
}
