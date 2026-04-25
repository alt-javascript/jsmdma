/**
 * FrameworkErrorContractMiddleware.js — centralized HTTP error envelope normalizer.
 *
 * Boot __middleware pipeline version: works on result objects { statusCode, body, headers }.
 * Also exports frameworkErrorContractMiddleware() (Hono-style) for backward compatibility
 * during the transition — used by auth-hono's starter until S03.
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
  static __middleware = { order: 3 };

  constructor() {
    this.logger = null; // CDI autowired
  }

  routes(app) {
    app.notFound((c) => c.json(normalizeFrameworkErrorBody({ status: 404 }), 404));
  }

  /**
   * Boot pipeline handler — normalizes >=400 result objects to the typed error envelope.
   * @param {{ statusCode: number, body: unknown, headers: object }} request
   * @param {Function} next
   * @returns {Promise<{ statusCode: number, body: unknown, headers: object }>}
   */
  async handle(request, next) {
    const result = await next(request);

    // statusCode == null means the handler returned a plain object (e.g. { status: 'ok' });
    // pass through unchanged so HonoControllerRegistrar can serialize it with c.json(result).
    if (!result || result.statusCode == null || result.statusCode < 400) {
      return result;
    }

    const normalizedBody = normalizeFrameworkErrorBody({
      status: result.statusCode,
      body: result.body,
    });

    this.logger?.debug?.(`[FrameworkErrorContractMiddleware] normalized ${result.statusCode} response with code=${normalizedBody.code}`);

    return { ...result, body: normalizedBody };
  }
}
