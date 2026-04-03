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
 * Storage namespacing:
 *   Personal (no x-org-id header):
 *     {userId}:{application}:{collection}  — via namespaceKey()
 *   Org-scoped (x-org-id header present):
 *     org:{orgId}:{application}:{collection}
 *     The org: prefix is unambiguous — userIds are UUIDs and never start with 'org:'.
 *     Requires live isMember check via OrgService; 403 on non-member.
 *
 * CDI autowiring (by name):
 *   this.syncService               — SyncService instance
 *   this.applicationRegistry       — ApplicationRegistry instance
 *   this.schemaValidator           — SchemaValidator instance
 *   this.orgService                — OrgService instance (optional; 500 if header present but not wired)
 *   this.documentIndexRepository   — DocumentIndexRepository instance (optional; skip upsert if not wired)
 *   this.logger                    — optional logger
 */
import { namespaceKey } from '@alt-javascript/data-api-server';

export default class AppSyncController {
  static __routes = [
    { method: 'GET',  path: '/health',            handler: 'health' },
    { method: 'POST', path: '/:application/sync', handler: 'sync'   },
  ];

  constructor() {
    this.syncService              = null; // CDI autowired
    this.applicationRegistry      = null; // CDI autowired
    this.schemaValidator          = null; // CDI autowired
    this.orgService               = null; // CDI autowired (required for org-scoped sync)
    this.documentIndexRepository  = null; // CDI autowired (optional — skip upsert if not wired)
    this.logger                   = null; // CDI autowired
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
    const { body, params, headers, honoCtx } = request;

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

    // ── Org-scope resolution ──────────────────────────────────────────────────
    // x-org-id header (lowercased by HTTP/2; check both casings for HTTP/1.1 compat)
    const orgId = headers?.['x-org-id'] ?? headers?.['X-Org-Id'] ?? null;
    let storageCollection;

    if (orgId) {
      if (!this.orgService) {
        this.logger?.error?.('[AppSyncController] x-org-id header present but orgService not wired');
        return { statusCode: 500, body: { error: 'Org-scoped sync is not configured' } };
      }
      const isMember = await this.orgService.isMember(userId, orgId);
      if (!isMember) {
        this.logger?.debug?.(`[AppSyncController] org membership denied orgId=${orgId} userId=${userId}`);
        return { statusCode: 403, body: { error: `Not a member of organisation: ${orgId}` } };
      }
      storageCollection = `org:${orgId}:${application}:${collection}`;
      this.logger?.debug?.(
        `[AppSyncController] org-scoped sync orgId=${orgId} userId=${userId} app=${application} storage=${storageCollection}`,
      );
    } else {
      storageCollection = namespaceKey(userId, application, collection);
    }

    this.logger?.debug?.(
      `[AppSyncController] POST /${application}/sync userId=${userId} collection=${collection} storage=${storageCollection} changes=${changes.length}`,
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

    // Pass the pre-computed storageCollection as 'collection'; omit userId/application
    // so SyncService uses the provided key as-is (fallback path when userId is undefined).
    const result = await this.syncService.sync(storageCollection, clientClock, changes);

    // ── Document ownership index ───────────────────────────────────────────────
    // Upsert a docIndex entry for every incoming write so ownership is tracked from
    // the first sync.  Null-guarded: if documentIndexRepository is not wired (e.g.
    // in test contexts that don't need it), this block is silently skipped.
    if (this.documentIndexRepository && Array.isArray(changes) && changes.length > 0) {
      for (const change of changes) {
        await this.documentIndexRepository.upsertOwnership(userId, application, change.key, collection);
        this.logger?.info?.(
          `[AppSyncController] docIndex upsert userId=${userId} app=${application} key=${change.key} collection=${collection}`,
        );
      }
    }

    return result;
  }
}
