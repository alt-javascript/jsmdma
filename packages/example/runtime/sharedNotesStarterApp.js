import '@alt-javascript/jsnosqlc-memory';
import { Context } from '@alt-javascript/cdi';
import { Boot } from '@alt-javascript/boot';
import { ConfigFactory } from '@alt-javascript/config';
import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHARED_NOTES_APPLICATION = 'shared-notes';
export const SHARED_NOTES_PACKAGE_BASE_PATH = fileURLToPath(new URL('..', import.meta.url));

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

export const SHARED_NOTES_APPLICATIONS_CONFIG = {
  [SHARED_NOTES_APPLICATION]: {
    description: 'Shared notes application (example)',
  },
};

export function createSharedNotesConfig({
  applicationsConfig = SHARED_NOTES_APPLICATIONS_CONFIG,
} = {}) {
  return {
    applications: applicationsConfig,
    orgs: { registerable: false },
  };
}

export function loadSharedNotesConfig({
  basePath = SHARED_NOTES_PACKAGE_BASE_PATH,
  overrides,
} = {}) {
  return ConfigFactory.loadConfig({
    basePath,
    overrides,
  });
}

export async function buildSharedNotesStarterContext({
  applicationsConfig = SHARED_NOTES_APPLICATIONS_CONFIG,
  starterOptions = {},
  basePath = SHARED_NOTES_PACKAGE_BASE_PATH,
} = {}) {
  await registerBootWorkspaceMemoryDriver();

  const config = loadSharedNotesConfig({
    basePath,
    overrides: createSharedNotesConfig({
      applicationsConfig,
    }),
  });

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

export async function buildSharedNotesStarterApp(options = {}) {
  const appCtx = await buildSharedNotesStarterContext(options);
  return {
    app: appCtx.get('honoAdapter').app,
    appCtx,
  };
}
