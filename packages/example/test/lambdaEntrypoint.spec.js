import { assert } from 'chai';
import { HLC } from '@alt-javascript/jsmdma-core';
import { OAuthSessionMiddleware } from '@alt-javascript/boot-oauth';
import { buildFullStackStarterApp } from '../runtime/fullStackStarterApp.js';
import { createLambdaHandlerForTests } from '../lambda-handler.js';
import {
  buildApiGatewayV2Event,
  parseApiGatewayV2JsonResponse,
  expectTypedErrorEnvelope,
} from './lambdaEventV2.js';
import { mintTestToken, TestOAuthSessionEngine } from '../../jsmdma-hono/test/helpers/mintTestToken.js';

function parseJsonWithContext(response, contextLabel) {
  try {
    return parseApiGatewayV2JsonResponse(response);
  } catch (err) {
    throw new Error(
      `[lambda-entrypoint:${contextLabel}] Failed to parse lambda response payload: ${err.message}. response=${JSON.stringify(response)}`,
      { cause: err },
    );
  }
}

function assertTypedErrorWithContext(response, expected, contextLabel) {
  try {
    return expectTypedErrorEnvelope(response, expected);
  } catch (err) {
    throw new Error(
      `[lambda-entrypoint:${contextLabel}] Typed envelope assertion failed: ${err.message}. response=${JSON.stringify(response)}`,
      { cause: err },
    );
  }
}

function buildAuthStarterOptions() {
  return {
    starterOptions: {
      hooks: {
        beforeSync: [
          { Reference: TestOAuthSessionEngine, name: 'oauthSessionEngine', scope: 'singleton' },
          { Reference: OAuthSessionMiddleware,  name: 'oauthSessionMiddleware',  scope: 'singleton' },
        ],
      },
    },
  };
}

describe('lambda entrypoint adapter integration (packages/example)', () => {
  let runtime;
  let authToken;

  async function invokeLambda({
    method,
    path,
    body,
    token,
    headers = {},
  }) {
    const event = buildApiGatewayV2Event({
      method,
      path,
      body,
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    return runtime.handler(event, {});
  }

  before(async () => {
    runtime = await createLambdaHandlerForTests({
      appBuilder: () => buildFullStackStarterApp(buildAuthStarterOptions()),
    });
    authToken = mintTestToken({ userId: 'lambda-entrypoint-user' });
  });

  after(async () => {
    await runtime?.shutdown?.();
  });

  it('serves GET /health with 200 via API Gateway v2 event envelope', async () => {
    const response = await invokeLambda({
      method: 'GET',
      path: '/health',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseJsonWithContext(response, 'health'), { status: 'ok' });
  });

  it('keeps POST /todo/sync gated at 401 on the Lambda adapter path when no token is provided', async () => {
    const response = await invokeLambda({
      method: 'POST',
      path: '/todo/sync',
      headers: { 'Content-Type': 'application/json' },
      body: {
        collection: 'tasks',
        clientClock: HLC.zero(),
        changes: [],
      },
    });

    assertTypedErrorWithContext(response, {
      statusCode: 401,
      error: 'Unauthorized',
      code: 'session_required',
    }, 'todo-sync-unauth');
  });

  it('returns typed 404 for unknown application route-class through Lambda adapter wiring', async () => {
    const response = await invokeLambda({
      method: 'POST',
      path: '/unknown-app/sync',
      token: authToken,
      headers: { 'Content-Type': 'application/json' },
      body: {
        collection: 'tasks',
        clientClock: HLC.zero(),
        changes: [],
      },
    });

    const payload = assertTypedErrorWithContext(response, {
      statusCode: 404,
      code: 'not_found',
    }, 'unknown-app-sync');

    assert.include(payload.error, 'unknown-app');
  });

  it('returns typed 404 for malformed route path classes through Lambda adapter wiring', async () => {
    const response = await invokeLambda({
      method: 'GET',
      path: '/todo/not-a-real-route',
    });

    assertTypedErrorWithContext(response, {
      statusCode: 404,
      error: 'Not Found',
      code: 'not_found',
    }, 'route-class-404');
  });

  it('returns typed 400 + details for schema-invalid sync payloads', async () => {
    const invalidClock = HLC.tick(HLC.zero(), Date.now());

    const response = await invokeLambda({
      method: 'POST',
      path: '/todo/sync',
      token: authToken,
      headers: { 'Content-Type': 'application/json' },
      body: {
        collection: 'tasks',
        clientClock: HLC.zero(),
        changes: [{
          key: 'task-missing-title',
          doc: { done: false },
          fieldRevs: { done: invalidClock },
          baseClock: HLC.zero(),
        }],
      },
    });

    const payload = assertTypedErrorWithContext(response, {
      statusCode: 400,
      error: 'Schema validation failed',
      code: 'bad_request',
      detailsRequired: true,
    }, 'schema-invalid-sync');

    assert.isArray(payload.details);
    assert.isNotEmpty(payload.details);
  });
});
