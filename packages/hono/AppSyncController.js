/**
 * AppSyncController.js — Hono controller for application-scoped sync.
 *
 * Replaces the old SyncController.  Routes:
 *   GET  /health                — liveness check
 *   POST /:application/sync    — sync documents for the given application
 *
 * The :application path segment is validated against the ApplicationRegistry
 * allowlist (config-driven).  Unknown applications return 404.
 *
 * Authentication is required.  The auth middleware (AuthMiddlewareRegistrar)
 * must be registered before this controller in the CDI context.  The JWT
 * payload is read from the Hono context via honoCtx.get('user'); requests
 * without a valid token are rejected with 401.
 *
 * Storage isolation: userId and application are passed to SyncService, which
 * namespaces the internal collection key as {userId}:{application}:{collection}.
 *
 * CDI autowiring (by name):
 *   this.syncService          — SyncService instance
 *   this.applicationRegistry  — ApplicationRegistry instance
 *   this.logger               — optional logger
 */
export default class AppSyncController {
  static __routes = [
    { method: 'GET',  path: '/health',            handler: 'health' },
    { method: 'POST', path: '/:application/sync', handler: 'sync'   },
  ];

  constructor() {
    this.syncService         = null; // CDI autowired
    this.applicationRegistry = null; // CDI autowired
    this.schemaValidator     = null; // CDI autowired
    this.logger              = null; // CDI autowired
  }

  /**
   * GET /health
   */
  health() {
    return { status: 'ok' };
  }

  /**
   * POST /:application/sync
   * @param {{ body: Object, params: Object, honoCtx: import('hono').Context }} request
   */
  async sync(request) {
    const { body, params, honoCtx } = request;

    // ── Auth guard ────────────────────────────────────────────────────────────
    const userPayload = honoCtx?.get?.('user') ?? null;
    if (!userPayload || !userPayload.sub) {
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = userPayload.sub;

    // ── Application allowlist ────────────────────────────────────────────────
    const application = params?.application;
    if (!application) {
      return { statusCode: 400, body: { error: 'Missing application in path' } };
    }
    if (!this.applicationRegistry?.isAllowed(application)) {
      this.logger?.debug?.(`[AppSyncController] unknown application: ${application}`);
      return { statusCode: 404, body: { error: `Unknown application: ${application}` } };
    }

    // ── Request body validation ───────────────────────────────────────────────
    if (!body || typeof body !== 'object') {
      return { statusCode: 400, body: { error: 'Request body is required' } };
    }

    const { collection, clientClock, changes = [] } = body;

    if (!collection || typeof collection !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: collection' } };
    }
    if (!clientClock || typeof clientClock !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: clientClock' } };
    }

    this.logger?.debug?.(
      `[AppSyncController] POST /${application}/sync userId=${userId} collection=${collection} clientClock=${clientClock} changes=${changes.length}`,
    );

    // ── Schema validation ─────────────────────────────────────────────────────
    if (this.schemaValidator && Array.isArray(changes) && changes.length > 0) {
      const validationErrors = [];
      for (const change of changes) {
        const result = this.schemaValidator.validate(application, collection, change.doc ?? {});
        if (!result.valid) {
          validationErrors.push(...result.errors.map((e) => ({ key: change.key, ...e })));
        }
      }
      if (validationErrors.length > 0) {
        return { statusCode: 400, body: { error: 'Schema validation failed', details: validationErrors } };
      }
    }

    const result = await this.syncService.sync(collection, clientClock, changes, userId, application);
    return result;
  }
}
