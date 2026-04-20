import '@alt-javascript/jsnosqlc-memory';
import { Context } from '@alt-javascript/cdi';
import { Boot } from '@alt-javascript/boot';
import { ConfigFactory } from '@alt-javascript/config';
import {
  jsmdmaHonoStarter,
  DocIndexController,
  SearchController,
  ExportController,
  DeletionController,
} from '@alt-javascript/jsmdma-hono';
import {
  SearchService,
  DocumentIndexRepository,
  ExportService,
  DeletionService,
} from '@alt-javascript/jsmdma-server';
import { AuthMiddlewareRegistrar, OrgController } from '@alt-javascript/jsmdma-auth-hono';
import { UserRepository, OrgRepository, OrgService } from '@alt-javascript/jsmdma-auth-server';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FULL_STACK_JWT_SECRET = 'run-apps-jwt-secret-at-least-32chars!';

export const FULL_STACK_PACKAGE_BASE_PATH = fileURLToPath(new URL('..', import.meta.url));
export const FULL_STACK_PLANNER_SCHEMA_PATH = fileURLToPath(new URL('../schemas/planner.json', import.meta.url));
export const FULL_STACK_APP_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../schemas/planner-preferences.json', import.meta.url));
export const FULL_STACK_GENERIC_PREFERENCES_SCHEMA_PATH = fileURLToPath(new URL('../../jsmdma-server/schemas/preferences.json', import.meta.url));

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

export const FULL_STACK_APPLICATIONS_CONFIG = {
  todo: {
    description: 'To-do lists',
    collections: {
      tasks: {
        schema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            done: { type: 'boolean' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            notes: { type: 'string' },
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
    description: 'Year planner application',
    collections: {
      planners: {
        schemaPath: FULL_STACK_PLANNER_SCHEMA_PATH,
      },
      preferences: {
        schemaPath: FULL_STACK_GENERIC_PREFERENCES_SCHEMA_PATH,
      },
      'planner-preferences': {
        schemaPath: FULL_STACK_APP_PREFERENCES_SCHEMA_PATH,
      },
    },
  },
};

export const FULL_STACK_STARTER_OPTIONS = {
  hooks: {
    beforeAppSync: [
      { Reference: DocumentIndexRepository, name: 'documentIndexRepository', scope: 'singleton' },
      { Reference: SearchService, name: 'searchService', scope: 'singleton' },
      { Reference: ExportService, name: 'exportService', scope: 'singleton' },
      { Reference: DeletionService, name: 'deletionService', scope: 'singleton' },
    ],
    afterAppSync: [
      { Reference: DocIndexController, name: 'docIndexController', scope: 'singleton' },
      { Reference: SearchController, name: 'searchController', scope: 'singleton' },
      { Reference: ExportController, name: 'exportController', scope: 'singleton' },
      { Reference: DeletionController, name: 'deletionController', scope: 'singleton' },
    ],
  },
};

export const NO_REG_ORG_ONLY_STARTER_OPTIONS = {
  features: {
    sync: false,
    auth: false,
    appSyncController: false,
  },
  hooks: {
    beforeSync: [
      { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
      { Reference: OrgRepository, name: 'orgRepository', scope: 'singleton' },
      { Reference: OrgService, name: 'orgService', scope: 'singleton' },
      {
        Reference: AuthMiddlewareRegistrar,
        name: 'authMiddlewareRegistrar',
        scope: 'singleton',
        properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
      },
      { Reference: OrgController, name: 'orgController', scope: 'singleton' },
    ],
  },
};

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

export function createFullStackConfig({
  jwtSecret = FULL_STACK_JWT_SECRET,
  applicationsConfig = FULL_STACK_APPLICATIONS_CONFIG,
  includeOrgsRegisterable = true,
  orgsRegisterable = true,
} = {}) {
  const config = {
    auth: { jwt: { secret: jwtSecret } },
    applications: applicationsConfig,
  };

  if (includeOrgsRegisterable) {
    config.orgs = { registerable: orgsRegisterable };
  }

  return config;
}

export function createFullStackStarterOptions(overrides = {}) {
  return mergeStarterOptions(FULL_STACK_STARTER_OPTIONS, overrides);
}

export function createNoRegStarterOptions(overrides = {}) {
  return mergeStarterOptions(NO_REG_ORG_ONLY_STARTER_OPTIONS, overrides);
}

export function loadFullStackConfig({
  basePath = FULL_STACK_PACKAGE_BASE_PATH,
  overrides,
} = {}) {
  return ConfigFactory.loadConfig({
    basePath,
    overrides,
  });
}

async function buildStarterApplicationContext({ config, starterOptions }) {
  await registerBootWorkspaceMemoryDriver();

  const context = new Context([
    ...jsmdmaHonoStarter(starterOptions),
  ]);

  const appCtx = await Boot.boot({
    contexts: [context],
    run: false,
    config,
  });

  await appCtx.get('nosqlClient').ready();

  return appCtx;
}

export async function buildFullStackStarterContext({
  jwtSecret = FULL_STACK_JWT_SECRET,
  applicationsConfig = FULL_STACK_APPLICATIONS_CONFIG,
  orgsRegisterable = true,
  starterOptions = {},
  basePath = FULL_STACK_PACKAGE_BASE_PATH,
} = {}) {
  const config = loadFullStackConfig({
    basePath,
    overrides: createFullStackConfig({
      jwtSecret,
      applicationsConfig,
      includeOrgsRegisterable: true,
      orgsRegisterable,
    }),
  });

  return buildStarterApplicationContext({
    config,
    starterOptions: createFullStackStarterOptions(starterOptions),
  });
}

export async function buildFullStackStarterApp(options = {}) {
  const appCtx = await buildFullStackStarterContext(options);
  return {
    app: appCtx.get('honoAdapter').app,
    appCtx,
  };
}

export async function buildFullStackStarterContextNoReg({
  jwtSecret = FULL_STACK_JWT_SECRET,
  applicationsConfig = FULL_STACK_APPLICATIONS_CONFIG,
  starterOptions = {},
  basePath = FULL_STACK_PACKAGE_BASE_PATH,
} = {}) {
  const config = loadFullStackConfig({
    basePath,
    overrides: createFullStackConfig({
      jwtSecret,
      applicationsConfig,
      includeOrgsRegisterable: false,
    }),
  });

  return buildStarterApplicationContext({
    config,
    starterOptions: createNoRegStarterOptions(starterOptions),
  });
}

export async function buildFullStackStarterAppNoReg(options = {}) {
  const appCtx = await buildFullStackStarterContextNoReg(options);
  return {
    app: appCtx.get('honoAdapter').app,
    appCtx,
  };
}
