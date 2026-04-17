import { assert } from 'chai';
import { JwtSession } from 'packages/jsmdma-auth-core';
import { HLC } from 'packages/jsmdma-core';
import { FULL_STACK_JWT_SECRET } from '../runtime/fullStackStarterApp.js';
import { createLambdaHandlerForTests } from '../lambda-handler.js';
import {
  buildApiGatewayV2Event,
  parseApiGatewayV2JsonResponse,
  expectTypedErrorEnvelope,
} from './lambdaEventV2.js';

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
    runtime = await createLambdaHandlerForTests();
    authToken = await JwtSession.sign(
      { sub: 'lambda-entrypoint-user', providers: ['test'] },
      FULL_STACK_JWT_SECRET,
    );
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

  it('keeps POST /todo/sync JWT-gated (401 unauthorized) on the Lambda adapter path', async () => {
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
      code: 'unauthorized',
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
