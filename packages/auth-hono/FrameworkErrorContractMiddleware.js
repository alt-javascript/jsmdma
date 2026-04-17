/**
 * FrameworkErrorContractMiddleware.js — centralized HTTP error envelope normalizer.
 *
 * Applies to all starter-registered routes and normalizes >=400 responses to a
 * deterministic typed contract while preserving backward-compatible `error`
 * text on non-5xx paths.
 */
import { normalizeFrameworkErrorBody } from './frameworkErrorContract.js';

function tryParseJsonString(raw) {
  if (typeof raw !== 'string') return raw;

  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return raw;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

async function readResponseBody(response) {
  if (!response) return null;

  const contentType = response.headers.get('content-type') ?? '';
  const cloned = response.clone();

  if (contentType.includes('application/json')) {
    try {
      return await cloned.json();
    } catch {
      // Fall through to text parsing for malformed JSON payloads.
    }
  }

  try {
    const text = await cloned.text();
    if (!text || text.trim().length === 0) {
      return null;
    }
    return tryParseJsonString(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} [logger]
 * @returns {(c: import('hono').Context, next: Function) => Promise<void>}
 */
export function frameworkErrorContractMiddleware(logger) {
  return async (c, next) => {
    await next();

    const status = c.res?.status ?? 200;
    if (status < 400) {
      return;
    }

    const originalBody = await readResponseBody(c.res);
    const normalizedBody = normalizeFrameworkErrorBody({
      status,
      statusText: c.res?.statusText,
      body: originalBody,
    });

    const headers = new Headers(c.res?.headers ?? undefined);
    headers.set('content-type', 'application/json; charset=UTF-8');
    headers.delete('content-length');

    c.res = new Response(JSON.stringify(normalizedBody), {
      status,
      headers,
    });

    logger?.debug?.(`[FrameworkErrorContractMiddleware] normalized ${status} response with code=${normalizedBody.code}`);
  };
}

export default class FrameworkErrorContractMiddleware {
  constructor() {
    this.logger = null; // CDI autowired
  }

  /**
   * Register global envelope normalization for starter-driven failures.
   * @param {import('hono').Hono} app
   */
  routes(app) {
    app.use('*', frameworkErrorContractMiddleware(this.logger));
  }
}
