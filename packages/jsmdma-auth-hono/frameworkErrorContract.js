/**
 * frameworkErrorContract.js — shared typed-envelope helpers for HTTP errors.
 *
 * Contract shape:
 *   {
 *     error: string,
 *     code: string,
 *     reason?: unknown,
 *     details?: unknown,
 *   }
 *
 * Notes:
 * - `error` remains backward-compatible human text.
 * - `code` is deterministic and machine-readable.
 * - 5xx responses are always redacted to avoid leaking internals.
 */

const STATUS_CODE_TO_ERROR_CODE = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  422: 'unprocessable_entity',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
});

const STATUS_CODE_TO_DEFAULT_ERROR = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStatus(status) {
  return Number.isInteger(status) ? status : 500;
}

export function defaultErrorCodeForStatus(status) {
  const normalizedStatus = normalizeStatus(status);
  if (STATUS_CODE_TO_ERROR_CODE[normalizedStatus]) {
    return STATUS_CODE_TO_ERROR_CODE[normalizedStatus];
  }

  if (normalizedStatus >= 500) return 'internal_error';
  if (normalizedStatus >= 400) return 'request_error';
  return 'unknown_error';
}

export function defaultErrorMessageForStatus(status, statusText) {
  const normalizedStatus = normalizeStatus(status);

  if (normalizedStatus >= 500) {
    return 'Internal Server Error';
  }

  if (STATUS_CODE_TO_DEFAULT_ERROR[normalizedStatus]) {
    return STATUS_CODE_TO_DEFAULT_ERROR[normalizedStatus];
  }

  if (hasNonEmptyString(statusText)) {
    return statusText.trim();
  }

  if (normalizedStatus >= 400) {
    return 'Request failed';
  }

  return 'Unknown error';
}

function resolveErrorMessage({ status, body, statusText }) {
  if (isPlainObject(body)) {
    if (hasNonEmptyString(body.error)) return body.error.trim();
    if (hasNonEmptyString(body.message)) return body.message.trim();
  }

  if (hasNonEmptyString(body)) {
    const raw = body.trim();
    const statusPrefix = `${status} `;
    if (raw.startsWith(statusPrefix)) {
      const withoutPrefix = raw.slice(statusPrefix.length).trim();
      return withoutPrefix || defaultErrorMessageForStatus(status, statusText);
    }
    return raw;
  }

  return defaultErrorMessageForStatus(status, statusText);
}

function resolveErrorCode({ status, body }) {
  if (isPlainObject(body) && hasNonEmptyString(body.code)) {
    return body.code.trim();
  }

  return defaultErrorCodeForStatus(status);
}

/**
 * Normalize any >=400 response body to the deterministic framework envelope.
 *
 * @param {{ status: number, body: unknown, statusText?: string }} input
 * @returns {{ error: string, code: string, reason?: unknown, details?: unknown }}
 */
export function normalizeFrameworkErrorBody(input = {}) {
  const status = normalizeStatus(input.status);
  const body = input.body;
  const statusText = input.statusText;

  const code = resolveErrorCode({ status, body });

  // Never leak internal details across 5xx responses.
  if (status >= 500) {
    return {
      error: 'Internal Server Error',
      code,
    };
  }

  const envelope = {
    error: resolveErrorMessage({ status, body, statusText }),
    code,
  };

  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'reason') && body.reason !== undefined) {
    envelope.reason = body.reason;
  }

  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'details') && body.details !== undefined) {
    envelope.details = body.details;
  }

  return envelope;
}
