import { assert } from 'chai';
import {
  handler,
  createLambdaHandlerForTests,
  resetLambdaBootstrapCacheForTests,
  getLambdaBootstrapDiagnostics,
} from '../lambda-handler.js';
import {
  buildApiGatewayV2Event,
  parseApiGatewayV2JsonResponse,
} from './lambdaEventV2.js';

describe('lambda handler bootstrap contracts (packages/example)', () => {
  afterEach(async () => {
    await resetLambdaBootstrapCacheForTests();
  });

  it('exports production handler and deterministic test bootstrap helper', () => {
    assert.isFunction(handler);
    assert.isFunction(createLambdaHandlerForTests);
    assert.isFunction(resetLambdaBootstrapCacheForTests);
    assert.isFunction(getLambdaBootstrapDiagnostics);
  });

  it('boots a fresh test handler and serves /health through the aws-lambda adapter path', async () => {
    const runtime = await createLambdaHandlerForTests();

    try {
      const response = await runtime.handler(buildApiGatewayV2Event({
        method: 'GET',
        path: '/health',
      }), {});

      assert.equal(response.statusCode, 200);
      assert.deepEqual(parseApiGatewayV2JsonResponse(response), { status: 'ok' });
      assert.equal(runtime.diagnostics.cacheScope, 'test');
      assert.equal(runtime.diagnostics.invocationCount, 1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('reuses the cached production runtime across warm invocations without re-bootstrap', async () => {
    await resetLambdaBootstrapCacheForTests();

    const first = await handler(buildApiGatewayV2Event({ method: 'GET', path: '/health' }), {});
    const firstDiag = getLambdaBootstrapDiagnostics();
    const second = await handler(buildApiGatewayV2Event({ method: 'GET', path: '/health' }), {});
    const secondDiag = getLambdaBootstrapDiagnostics();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    assert.isTrue(firstDiag.cacheReady, 'Expected cache to be ready after first invocation');
    assert.isTrue(secondDiag.cacheReady, 'Expected cache to remain ready after warm invocation');
    assert.equal(firstDiag.coldStartEpochMs, secondDiag.coldStartEpochMs, 'Expected cold start timestamp to remain stable');
    assert.equal(secondDiag.invocationCount, firstDiag.invocationCount + 1, 'Expected warm invocation count increment');
  });

  it('treats malformed API Gateway events as negative path (never a success health response)', async () => {
    const runtime = await createLambdaHandlerForTests();

    try {
      const malformedEvent = buildApiGatewayV2Event({
        method: undefined,
        path: '/todo/sync',
        headers: {
          host: undefined,
        },
        requestContext: {
          domainName: undefined,
          domainPrefix: undefined,
          http: {
            method: undefined,
          },
        },
      });

      const response = await runtime.handler(malformedEvent, {});

      assert.containsAllKeys(response, ['statusCode', 'body']);
      assert.isAtLeast(response.statusCode, 400, 'Malformed event should resolve through an error path, never a success path');
    } finally {
      await runtime.shutdown();
    }
  });

  it('fails startup deterministically when bootstrap cannot initialize the app context', async () => {
    let thrown = null;

    try {
      await createLambdaHandlerForTests({
        appBuilder: async () => {
          throw new Error('boom');
        },
      });
    } catch (err) {
      thrown = err;
    }

    assert.instanceOf(thrown, Error);
    assert.include(thrown.message, 'Bootstrap failed during build-app');
    assert.include(thrown.message, 'boom');
  });

  it('throws a deterministic parse error for non-JSON lambda response bodies', () => {
    assert.throws(
      () => parseApiGatewayV2JsonResponse({ statusCode: 500, body: 'not-json' }),
      '[lambdaEventV2] Invalid JSON response body:',
    );
  });
});
