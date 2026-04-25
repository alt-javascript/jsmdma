/**
 * AppSyncController.js — Hono transport adapter for application-scoped sync.
 *
 * Routes:
 *   GET  /health             — liveness check
 *   POST /:application/sync  — delegates to AppSyncService
 *
 * Authentication/application/org/schema/docIndex orchestration lives in
 * AppSyncService (server package). This controller only extracts transport
 * fields and delegates.
 *
 * CDI autowiring (by name):
 *   this.appSyncService — AppSyncService instance
 *   this.logger         — optional logger
 */
const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
});

function errorCodeForStatus(statusCode) {
  if (ERROR_CODE_BY_STATUS[statusCode]) {
    return ERROR_CODE_BY_STATUS[statusCode];
  }
  if (statusCode >= 500) return 'internal_error';
  if (statusCode >= 400) return 'request_error';
  return 'unknown_error';
}

function failure(statusCode, error, extras = {}) {
  return {
    statusCode,
    body: {
      error,
      code: errorCodeForStatus(statusCode),
      ...extras,
    },
  };
}

export default class AppSyncController {
  static __routes = [
    { method: 'GET',  path: '/health',            handler: 'health' },
    { method: 'POST', path: '/:application/sync', handler: 'sync'   },
  ];

  constructor() {
    this.appSyncService = null; // CDI autowired
    this.logger         = null; // CDI autowired
  }

  /**
   * GET /health
   */
  health() {
    return { status: 'ok' };
  }

  /**
   * POST /:application/sync
   * @param {{ body: Object, params: Object, headers: Object, identity: Object }} request
   */
  async sync(request) {
    const { body, params, headers, identity } = request ?? {};

    if (!this.appSyncService || typeof this.appSyncService.sync !== 'function') {
      this.logger?.error?.('[AppSyncController] appSyncService is not wired');
      return failure(500, 'Sync adapter is misconfigured');
    }

    let response;
    try {
      response = await this.appSyncService.sync({ body, params, headers, identity });
    } catch (error) {
      this.logger?.error?.(`[AppSyncController] appSyncService.sync threw: ${error?.message ?? error}`);
      return failure(500, 'Sync failed');
    }

    const validShape = (
      response
      && typeof response === 'object'
      && !Array.isArray(response)
      && typeof response.statusCode === 'number'
      && Object.prototype.hasOwnProperty.call(response, 'body')
    );

    if (!validShape) {
      this.logger?.error?.('[AppSyncController] appSyncService.sync returned malformed response');
      return failure(500, 'Malformed sync response');
    }

    return response;
  }
}
