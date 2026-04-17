import { handle } from 'hono/aws-lambda';
import { buildFullStackStarterApp } from './runtime/fullStackStarterApp.js';

const BOOT_STAGE = Object.freeze({
  BUILD_APP: 'build-app',
  CREATE_ADAPTER: 'create-adapter',
  READY: 'ready',
});

let cachedRuntimePromise = null;
let cachedRuntime = null;

function assertLambdaResponseEnvelope(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('[lambda-handler] Adapter returned a non-object response envelope');
  }

  if (typeof response.statusCode !== 'number') {
    throw new Error('[lambda-handler] Adapter response is missing numeric statusCode');
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'body')) {
    throw new Error('[lambda-handler] Adapter response is missing body field');
  }
}

async function stopRuntime(runtime) {
  if (!runtime?.appCtx || typeof runtime.appCtx.stop !== 'function') {
    return;
  }
  await runtime.appCtx.stop();
}

function createBootstrapError(stage, err) {
  const rootMessage = err?.message ?? String(err);
  return new Error(`[lambda-handler] Bootstrap failed during ${stage}: ${rootMessage}`, { cause: err });
}

async function buildRuntime({ appBuilder = buildFullStackStarterApp, cacheScope = 'production' } = {}) {
  let stage = BOOT_STAGE.BUILD_APP;
  let appRuntime = null;

  try {
    appRuntime = await appBuilder();

    if (!appRuntime?.app || !appRuntime?.appCtx) {
      throw new Error('starter runtime did not return { app, appCtx }');
    }

    stage = BOOT_STAGE.CREATE_ADAPTER;
    const lambdaAdapter = handle(appRuntime.app);

    if (typeof lambdaAdapter !== 'function') {
      throw new Error('hono/aws-lambda handle(app) did not return a function');
    }

    const diagnostics = {
      cacheScope,
      stage: BOOT_STAGE.READY,
      coldStartEpochMs: Date.now(),
      invocationCount: 0,
    };

    const invoke = async (event, context) => {
      diagnostics.invocationCount += 1;
      const response = await lambdaAdapter(event, context);
      assertLambdaResponseEnvelope(response);
      return response;
    };

    return {
      app: appRuntime.app,
      appCtx: appRuntime.appCtx,
      diagnostics,
      handler: invoke,
    };
  } catch (err) {
    await stopRuntime(appRuntime);
    throw createBootstrapError(stage, err);
  }
}

async function getOrCreateCachedRuntime() {
  if (!cachedRuntimePromise) {
    cachedRuntimePromise = buildRuntime({ cacheScope: 'production' });
  }

  try {
    const runtime = await cachedRuntimePromise;
    cachedRuntime = runtime;
    return runtime;
  } catch (err) {
    cachedRuntimePromise = null;
    cachedRuntime = null;
    throw err;
  }
}

export function getLambdaBootstrapDiagnostics() {
  return {
    cacheInitialized: Boolean(cachedRuntimePromise),
    cacheReady: Boolean(cachedRuntime),
    cacheScope: cachedRuntime?.diagnostics?.cacheScope ?? null,
    invocationCount: cachedRuntime?.diagnostics?.invocationCount ?? 0,
    coldStartEpochMs: cachedRuntime?.diagnostics?.coldStartEpochMs ?? null,
    stage: cachedRuntime?.diagnostics?.stage ?? null,
  };
}

export async function resetLambdaBootstrapCacheForTests() {
  const runtime = cachedRuntime;
  const runtimePromise = cachedRuntimePromise;

  cachedRuntimePromise = null;
  cachedRuntime = null;

  if (runtime) {
    await stopRuntime(runtime);
    return;
  }

  if (runtimePromise) {
    try {
      const startedRuntime = await runtimePromise;
      await stopRuntime(startedRuntime);
    } catch {
      // Ignore bootstrap failures while resetting tests; cache was already cleared.
    }
  }
}

export async function createLambdaHandlerForTests({ appBuilder = buildFullStackStarterApp } = {}) {
  await resetLambdaBootstrapCacheForTests();

  const runtime = await buildRuntime({
    appBuilder,
    cacheScope: 'test',
  });

  let shutDown = false;

  return {
    handler: runtime.handler,
    app: runtime.app,
    appCtx: runtime.appCtx,
    diagnostics: runtime.diagnostics,
    shutdown: async () => {
      if (shutDown) {
        return;
      }
      shutDown = true;
      await stopRuntime(runtime);
      await resetLambdaBootstrapCacheForTests();
    },
  };
}

export async function handler(event, context) {
  const runtime = await getOrCreateCachedRuntime();
  return runtime.handler(event, context);
}
