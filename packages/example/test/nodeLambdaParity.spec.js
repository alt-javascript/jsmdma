import { assert } from 'chai';
import { JwtSession } from '@alt-javascript/jsmdma-auth-core';
import { HLC } from '@alt-javascript/jsmdma-core';
import {
  FULL_STACK_JWT_SECRET,
  FULL_STACK_STARTER_OPTIONS,
  buildFullStackStarterApp,
} from '../runtime/fullStackStarterApp.js';
import {
  createLambdaHandlerForTests,
  resetLambdaBootstrapCacheForTests,
} from '../lambda-handler.js';
import {
  buildApiGatewayV2Event,
  parseApiGatewayV2JsonResponse,
  resetApiGatewayV2EventSequenceForTests,
} from './lambdaEventV2.js';

const PARITY_USERS = Object.freeze({
  owner: 'parity-owner-user',
  member: 'parity-member-user',
  nonMember: 'parity-non-member-user',
  schema: 'parity-schema-user',
});

const SENSITIVE_THROW_TEXT = 'parity-sensitive-5xx-text';
const PARITY_ORG_ID = 'parity-org-fixed-id';
const PARITY_ORG_NAME = 'Parity Org Deterministic';

class ParityThrowController {
  static __routes = [
    { method: 'POST', path: '/_parity/throw', handler: 'throwInjected' },
  ];

  throwInjected() {
    throw new Error(`forced-sensitive-throw:${SENSITIVE_THROW_TEXT}`);
  }
}

const PARITY_STARTER_OPTIONS = {
  hooks: {
    afterAppSync: [
      ...FULL_STACK_STARTER_OPTIONS.hooks.afterAppSync,
      ParityThrowController,
    ],
  },
};

function hasDetails(payload) {
  return Object.prototype.hasOwnProperty.call(payload ?? {}, 'details');
}

function payloadIncludesSensitiveText(payload) {
  return JSON.stringify(payload ?? null).includes(SENSITIVE_THROW_TEXT);
}

async function parseNodeJsonWithContext(response, contextLabel) {
  const text = await response.text();

  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`[node-parity:${contextLabel}] Expected non-empty JSON body, got '${text}'`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `[node-parity:${contextLabel}] Failed to parse Node response JSON: ${err.message}. status=${response.status} body=${text}`,
      { cause: err },
    );
  }
}

function parseLambdaJsonWithContext(response, contextLabel) {
  try {
    return parseApiGatewayV2JsonResponse(response);
  } catch (err) {
    throw new Error(
      `[lambda-parity:${contextLabel}] Failed to parse Lambda response payload: ${err.message}. envelope=${JSON.stringify(response)}`,
      { cause: err },
    );
  }
}

function expectParityEnvelope({
  label,
  expectedStatusCode,
  expectedCode,
  expectedError,
  detailsRequired = false,
  nodeResult,
  lambdaResult,
}) {
  const nodeSummary = {
    statusCode: nodeResult.statusCode,
    code: nodeResult.payload?.code ?? null,
    error: nodeResult.payload?.error ?? null,
    detailsPresent: hasDetails(nodeResult.payload),
  };

  const lambdaSummary = {
    statusCode: lambdaResult.statusCode,
    code: lambdaResult.payload?.code ?? null,
    error: lambdaResult.payload?.error ?? null,
    detailsPresent: hasDetails(lambdaResult.payload),
  };

  assert.deepEqual(
    nodeSummary,
    lambdaSummary,
    `[parity:${label}] Node/Lambda envelope mismatch. node=${JSON.stringify(nodeSummary)} lambda=${JSON.stringify(lambdaSummary)}`,
  );

  assert.equal(
    nodeSummary.statusCode,
    expectedStatusCode,
    `[parity:${label}] Expected statusCode=${expectedStatusCode}, got node=${nodeSummary.statusCode} lambda=${lambdaSummary.statusCode}`,
  );

  assert.equal(nodeSummary.code, expectedCode, `[parity:${label}] Expected code=${expectedCode}`);
  assert.equal(nodeSummary.error, expectedError, `[parity:${label}] Expected error='${expectedError}'`);

  if (detailsRequired) {
    assert.isTrue(nodeSummary.detailsPresent, `[parity:${label}] Expected details to be present on node response`);
    assert.isTrue(lambdaSummary.detailsPresent, `[parity:${label}] Expected details to be present on lambda response`);
    assert.isArray(nodeResult.payload.details, `[parity:${label}] Expected node details to be an array`);
    assert.isArray(lambdaResult.payload.details, `[parity:${label}] Expected lambda details to be an array`);
    assert.isNotEmpty(nodeResult.payload.details, `[parity:${label}] Expected non-empty node details`);
    assert.isNotEmpty(lambdaResult.payload.details, `[parity:${label}] Expected non-empty lambda details`);
  }
}

async function seedRuntime({ runtime, label }) {
  let userRepository;
  let orgRepository;

  try {
    userRepository = runtime.appCtx.get('userRepository');
    orgRepository = runtime.appCtx.get('orgRepository');
  } catch (err) {
    throw new Error(`[parity:${label}:setup] Missing userRepository/orgRepository dependencies`, { cause: err });
  }

  if (!userRepository || !orgRepository) {
    throw new Error(`[parity:${label}:setup] userRepository/orgRepository not available on appCtx`);
  }

  try {
    for (const userId of Object.values(PARITY_USERS)) {
      await userRepository._users().store(userId, {
        userId,
        email: `${userId}@example.com`,
        providers: ['test'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    await orgRepository.createOrg(PARITY_ORG_ID, PARITY_ORG_NAME, PARITY_USERS.owner);
    await orgRepository.createMember(PARITY_ORG_ID, PARITY_USERS.owner, 'org-admin');
    await orgRepository.createMember(PARITY_ORG_ID, PARITY_USERS.member, 'member');

    return {
      orgId: PARITY_ORG_ID,
    };
  } catch (err) {
    throw new Error(`[parity:${label}:setup] Failed while seeding users/org membership: ${err.message}`, { cause: err });
  }
}

async function buildNodeRuntime() {
  try {
    return await buildFullStackStarterApp({ starterOptions: PARITY_STARTER_OPTIONS });
  } catch (err) {
    throw new Error(`[parity:node:bootstrap] Failed to build starter app: ${err.message}`, { cause: err });
  }
}

async function buildLambdaRuntime() {
  try {
    return await createLambdaHandlerForTests({
      appBuilder: () => buildFullStackStarterApp({ starterOptions: PARITY_STARTER_OPTIONS }),
    });
  } catch (err) {
    throw new Error(`[parity:lambda:bootstrap] Failed to build lambda runtime: ${err.message}`, { cause: err });
  }
}

async function invokeNode({ runtime, label, request }) {
  const headers = { ...(request.headers ?? {}) };
  const hasJsonBody = request.body !== undefined;

  if (hasJsonBody && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await runtime.app.request(request.path, {
    method: request.method,
    headers,
    body: hasJsonBody ? JSON.stringify(request.body) : undefined,
  });

  const payload = await parseNodeJsonWithContext(response, label);

  return {
    statusCode: response.status,
    payload,
  };
}

async function invokeLambda({ runtime, label, request }) {
  const headers = { ...(request.headers ?? {}) };
  const hasJsonBody = request.body !== undefined;

  if (hasJsonBody && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await runtime.handler(buildApiGatewayV2Event({
    method: request.method,
    path: request.path,
    headers,
    body: request.body,
  }), {});

  const payload = parseLambdaJsonWithContext(response, label);

  return {
    statusCode: response.statusCode,
    payload,
    rawResponse: response,
  };
}

function withAuth(token, headers = {}) {
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}

function buildSyncBody({ changes = [] } = {}) {
  return {
    collection: 'tasks',
    clientClock: HLC.zero(),
    changes,
  };
}

function buildSchemaInvalidChange() {
  const invalidClock = HLC.tick(HLC.zero(), Date.now());

  return {
    key: 'task-missing-title',
    doc: { done: false },
    fieldRevs: { done: invalidClock },
    baseClock: HLC.zero(),
  };
}

async function runParityProbe({ nodeRuntime, lambdaRuntime, label, request }) {
  const nodeResult = await invokeNode({ runtime: nodeRuntime, label, request });
  const lambdaResult = await invokeLambda({ runtime: lambdaRuntime, label, request });

  return { nodeResult, lambdaResult };
}

describe('node↔lambda parity matrix (packages/example)', function nodeLambdaParitySuite() {
  this.timeout(15000);

  let nodeRuntime;
  let lambdaRuntime;
  let tokens;
  let parityOrgId;

  before(async () => {
    await resetLambdaBootstrapCacheForTests();
    resetApiGatewayV2EventSequenceForTests();

    nodeRuntime = await buildNodeRuntime();
    lambdaRuntime = await buildLambdaRuntime();

    const seededNode = await seedRuntime({ runtime: nodeRuntime, label: 'node' });
    const seededLambda = await seedRuntime({ runtime: lambdaRuntime, label: 'lambda' });
    parityOrgId = seededNode.orgId;

    assert.equal(
      seededLambda.orgId,
      parityOrgId,
      '[parity:setup] Expected deterministic orgId seeding across node and lambda runtimes',
    );

    tokens = {
      owner: await JwtSession.sign({ sub: PARITY_USERS.owner, providers: ['test'] }, FULL_STACK_JWT_SECRET),
      member: await JwtSession.sign({ sub: PARITY_USERS.member, providers: ['test'] }, FULL_STACK_JWT_SECRET),
      nonMember: await JwtSession.sign({ sub: PARITY_USERS.nonMember, providers: ['test'] }, FULL_STACK_JWT_SECRET),
      schema: await JwtSession.sign({ sub: PARITY_USERS.schema, providers: ['test'] }, FULL_STACK_JWT_SECRET),
    };
  });

  after(async () => {
    await nodeRuntime?.appCtx?.stop?.();
    await lambdaRuntime?.shutdown?.();
    await resetLambdaBootstrapCacheForTests();
    resetApiGatewayV2EventSequenceForTests();
  });

  it('keeps unauthenticated POST /todo/sync equivalent at 401 unauthorized', async () => {
    const { nodeResult, lambdaResult } = await runParityProbe({
      nodeRuntime,
      lambdaRuntime,
      label: 'todo-sync-unauth',
      request: {
        method: 'POST',
        path: '/todo/sync',
        body: buildSyncBody(),
      },
    });

    expectParityEnvelope({
      label: 'todo-sync-unauth',
      expectedStatusCode: 401,
      expectedCode: 'unauthorized',
      expectedError: 'Unauthorized',
      nodeResult,
      lambdaResult,
    });
  });

  it('keeps org-scoped non-member sync equivalent at 403 forbidden', async () => {
    const requestBody = buildSyncBody();

    const { nodeResult, lambdaResult } = await runParityProbe({
      nodeRuntime,
      lambdaRuntime,
      label: 'org-sync-non-member',
      request: {
        method: 'POST',
        path: '/todo/sync',
        headers: withAuth(tokens.nonMember, { 'x-org-id': parityOrgId }),
        body: requestBody,
      },
    });

    expectParityEnvelope({
      label: 'org-sync-non-member',
      expectedStatusCode: 403,
      expectedCode: 'forbidden',
      expectedError: `Not a member of organisation: ${parityOrgId}`,
      nodeResult,
      lambdaResult,
    });
  });

  it('keeps schema-invalid sync equivalent at 400 bad_request with details', async () => {
    const requestBody = buildSyncBody({ changes: [buildSchemaInvalidChange()] });

    const { nodeResult, lambdaResult } = await runParityProbe({
      nodeRuntime,
      lambdaRuntime,
      label: 'schema-invalid-sync',
      request: {
        method: 'POST',
        path: '/todo/sync',
        headers: withAuth(tokens.schema),
        body: requestBody,
      },
    });

    expectParityEnvelope({
      label: 'schema-invalid-sync',
      expectedStatusCode: 400,
      expectedCode: 'bad_request',
      expectedError: 'Schema validation failed',
      detailsRequired: true,
      nodeResult,
      lambdaResult,
    });
  });

  it('keeps unknown app and malformed route-class probes equivalent at 404 not_found', async () => {
    const probes = [
      {
        label: 'unknown-app-sync',
        request: {
          method: 'POST',
          path: '/unknown-app/sync',
          headers: withAuth(tokens.member),
          body: buildSyncBody(),
        },
        expectedError: 'Unknown application: unknown-app',
      },
      {
        label: 'malformed-route-class',
        request: {
          method: 'GET',
          path: '/todo/not-a-real-route',
        },
        expectedError: 'Not Found',
      },
    ];

    for (const probe of probes) {
      const { nodeResult, lambdaResult } = await runParityProbe({
        nodeRuntime,
        lambdaRuntime,
        label: probe.label,
        request: probe.request,
      });

      expectParityEnvelope({
        label: probe.label,
        expectedStatusCode: 404,
        expectedCode: 'not_found',
        expectedError: probe.expectedError,
        nodeResult,
        lambdaResult,
      });
    }
  });

  it('keeps forced-throw 5xx responses redacted and equivalent (no sensitive text leak)', async () => {
    const { nodeResult, lambdaResult } = await runParityProbe({
      nodeRuntime,
      lambdaRuntime,
      label: 'forced-throw-5xx',
      request: {
        method: 'POST',
        path: '/_parity/throw',
      },
    });

    expectParityEnvelope({
      label: 'forced-throw-5xx',
      expectedStatusCode: 500,
      expectedCode: 'internal_error',
      expectedError: 'Internal Server Error',
      nodeResult,
      lambdaResult,
    });

    assert.isFalse(
      payloadIncludesSensitiveText(nodeResult.payload),
      `[parity:forced-throw-5xx] Node payload leaked sensitive throw text: ${JSON.stringify(nodeResult.payload)}`,
    );

    assert.isFalse(
      payloadIncludesSensitiveText(lambdaResult.payload),
      `[parity:forced-throw-5xx] Lambda payload leaked sensitive throw text: ${JSON.stringify(lambdaResult.payload)}`,
    );

    assert.isFalse(
      String(lambdaResult.rawResponse?.body ?? '').includes(SENSITIVE_THROW_TEXT),
      `[parity:forced-throw-5xx] Lambda raw envelope body leaked sensitive throw text: ${JSON.stringify(lambdaResult.rawResponse)}`,
    );
  });
});
