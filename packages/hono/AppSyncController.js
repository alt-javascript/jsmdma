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
   * @param {{ body: Object, params: Object, headers: Object, honoCtx: import('hono').Context }} request
   */
  async sync(request) {
    const { body, params, headers, honoCtx } = request ?? {};

    if (!this.appSyncService || typeof this.appSyncService.sync !== 'function') {
      this.logger?.error?.('[AppSyncController] appSyncService is not wired');
      return { statusCode: 500, body: { error: 'Sync adapter is misconfigured' } };
    }

    let response;
    try {
      response = await this.appSyncService.sync({ body, params, headers, honoCtx });
    } catch (error) {
      this.logger?.error?.(`[AppSyncController] appSyncService.sync threw: ${error?.message ?? error}`);
      return { statusCode: 500, body: { error: 'Sync failed' } };
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
      return { statusCode: 500, body: { error: 'Malformed sync response' } };
    }

    return response;
  }
}
