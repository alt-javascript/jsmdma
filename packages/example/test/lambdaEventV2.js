const DEFAULT_DOMAIN = 'example.execute-api.ap-southeast-2.amazonaws.com';
const DEFAULT_STAGE = '$default';

let requestSequence = 0;

export function resetApiGatewayV2EventSequenceForTests() {
  requestSequence = 0;
}

function nextRequestId() {
  requestSequence += 1;
  return `req-${String(requestSequence).padStart(6, '0')}`;
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized[name.toLowerCase()] = String(value);
  }
  return normalized;
}

function encodeQueryParams(params) {
  if (!params || typeof params !== 'object') {
    return '';
  }

  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

function toBodyString(body) {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  return JSON.stringify(body);
}

export function buildApiGatewayV2Event({
  method = 'GET',
  path = '/health',
  headers = {},
  body,
  queryStringParameters,
  rawQueryString,
  requestContext = {},
  routeKey,
  stage = DEFAULT_STAGE,
  cookies = [],
  isBase64Encoded = false,
  pathParameters,
  stageVariables,
} = {}) {
  const { http: requestContextHttp = {}, ...requestContextRest } = requestContext ?? {};

  const resolvedDomain = requestContextRest.domainName
    ?? headers.host
    ?? headers.Host
    ?? DEFAULT_DOMAIN;

  const mergedHeaders = normalizeHeaders({
    accept: 'application/json',
    host: resolvedDomain,
    'x-forwarded-proto': 'https',
    ...headers,
  });

  const resolvedMethod = typeof method === 'string' ? method.toUpperCase() : method;
  const resolvedRouteKey = routeKey ?? (typeof resolvedMethod === 'string' ? `${resolvedMethod} ${path}` : '$default');
  const resolvedQueryString = rawQueryString ?? encodeQueryParams(queryStringParameters);
  const now = new Date();

  return {
    version: '2.0',
    routeKey: resolvedRouteKey,
    rawPath: path,
    rawQueryString: resolvedQueryString,
    cookies,
    headers: mergedHeaders,
    queryStringParameters,
    requestContext: {
      ...requestContextRest,
      accountId: requestContextRest.accountId ?? '123456789012',
      apiId: requestContextRest.apiId ?? 'jsmdma-example',
      domainName: resolvedDomain,
      domainPrefix: requestContextRest.domainPrefix ?? resolvedDomain.split('.')[0],
      http: {
        ...requestContextHttp,
        method: requestContextHttp.method ?? resolvedMethod,
        path: requestContextHttp.path ?? path,
        protocol: requestContextHttp.protocol ?? 'HTTP/1.1',
        sourceIp: requestContextHttp.sourceIp ?? '127.0.0.1',
        userAgent: requestContextHttp.userAgent ?? 'jsmdma-lambda-tests',
      },
      requestId: requestContextRest.requestId ?? nextRequestId(),
      routeKey: requestContextRest.routeKey ?? resolvedRouteKey,
      stage: requestContextRest.stage ?? stage,
      time: requestContextRest.time ?? now.toUTCString(),
      timeEpoch: requestContextRest.timeEpoch ?? now.getTime(),
    },
    isBase64Encoded,
    pathParameters,
    stageVariables,
    body: toBodyString(body),
  };
}

export function parseApiGatewayV2JsonResponse(response, { allowEmptyBody = false } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('[lambdaEventV2] Expected Lambda response object');
  }

  if (typeof response.statusCode !== 'number') {
    throw new TypeError('[lambdaEventV2] Lambda response must include numeric statusCode');
  }

  if (!Object.prototype.hasOwnProperty.call(response, 'body')) {
    throw new TypeError('[lambdaEventV2] Lambda response must include body');
  }

  if (response.body === '' && allowEmptyBody) {
    return null;
  }

  if (typeof response.body !== 'string') {
    throw new TypeError('[lambdaEventV2] Lambda response body must be a JSON string');
  }

  try {
    return JSON.parse(response.body);
  } catch (err) {
    throw new Error(`[lambdaEventV2] Invalid JSON response body: ${err.message}`, { cause: err });
  }
}

export function expectTypedErrorEnvelope(response, {
  statusCode,
  error,
  code,
  detailsRequired = false,
} = {}) {
  const payload = parseApiGatewayV2JsonResponse(response);

  if (statusCode !== undefined && response.statusCode !== statusCode) {
    throw new Error(`Expected statusCode ${statusCode}, got ${response.statusCode}`);
  }

  if (error !== undefined && payload.error !== error) {
    throw new Error(`Expected error '${error}', got '${payload.error}'`);
  }

  if (code !== undefined && payload.code !== code) {
    throw new Error(`Expected code '${code}', got '${payload.code}'`);
  }

  if (detailsRequired && !Object.prototype.hasOwnProperty.call(payload, 'details')) {
    throw new Error('Expected response payload to include details');
  }

  return payload;
}
