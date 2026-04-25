/**
 * ExportController.js — Hono controller for full-data export.
 *
 * Routes:
 *   GET /account/export         — export all data for the authenticated user
 *   GET /orgs/:orgId/export     — export all data for an organisation
 *
 * Authentication is required on both routes.  OAuthSessionMiddleware must
 * be registered before this controller in the CDI context.  The identity
 * is read from request.identity (set by OAuthSessionMiddleware); requests
 * without a valid session token are rejected with 401.
 *
 * GET /account/export:
 *   Returns { user, docs, docIndex } via ExportService.exportUser(userId).
 *
 * GET /orgs/:orgId/export:
 *   Requires the caller to be an org-admin.  The org-admin check uses
 *   OrgRepository.getMember(orgId, userId) directly (no OrgService layer
 *   needed — we only need a membership read, not a mutation).
 *   Returns { org, members, docs } via ExportService.exportOrg(orgId).
 *   Returns 404 when orgId does not exist (envelope.org === null).
 *
 * CDI autowiring (by name):
 *   this.exportService  — ExportService instance
 *   this.orgRepository  — OrgRepository instance
 *   this.logger         — optional logger
 */
export default class ExportController {
  static __routes = [
    { method: 'GET', path: '/account/export',     handler: 'exportUser' },
    { method: 'GET', path: '/orgs/:orgId/export', handler: 'exportOrg'  },
  ];

  constructor() {
    this.exportService = null; // CDI autowired
    this.orgRepository = null; // CDI autowired
    this.logger        = null; // CDI autowired
  }

  /**
   * GET /account/export
   * @param {{ params: Object, identity: Object }} request
   */
  async exportUser(request) {
    // ── Auth guard ────────────────────────────────────────────────────────────
    const userPayload = request.identity ?? null;
    if (!userPayload || !userPayload.userId) {
      this.logger?.debug?.('[ExportController] 401 — missing or invalid user payload on /account/export');
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = userPayload.userId;

    // ── Export ────────────────────────────────────────────────────────────────
    const envelope = await this.exportService.exportUser(userId);

    if (envelope.user === null) {
      this.logger?.debug?.(`[ExportController] 404 — userId=${userId} not found`);
      return { statusCode: 404, body: { error: `User not found: ${userId}` } };
    }

    this.logger?.info?.(`[ExportController] exportUser userId=${userId}`);

    return { statusCode: 200, body: envelope };
  }

  /**
   * GET /orgs/:orgId/export
   * @param {{ params: Object, identity: Object }} request
   */
  async exportOrg(request) {
    const { params } = request;

    // ── Auth guard ────────────────────────────────────────────────────────────
    const userPayload = request.identity ?? null;
    if (!userPayload || !userPayload.userId) {
      this.logger?.debug?.('[ExportController] 401 — missing or invalid user payload on /orgs/:orgId/export');
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = userPayload.userId;
    const orgId  = params?.orgId;

    // ── Org existence check ───────────────────────────────────────────────────
    const org = await this.orgRepository.getOrg(orgId);
    if (!org) {
      this.logger?.debug?.(`[ExportController] 404 — orgId=${orgId} not found`);
      return { statusCode: 404, body: { error: `Organisation not found: ${orgId}` } };
    }

    // ── Org-admin check ───────────────────────────────────────────────────────
    const member = await this.orgRepository.getMember(orgId, userId);
    if (!member || member.role !== 'org-admin') {
      this.logger?.debug?.(`[ExportController] 403 — userId=${userId} is not org-admin of orgId=${orgId}`);
      return { statusCode: 403, body: { error: 'Forbidden: org-admin role required' } };
    }

    // ── Export ────────────────────────────────────────────────────────────────
    const envelope = await this.exportService.exportOrg(orgId);

    this.logger?.info?.(`[ExportController] exportOrg orgId=${orgId} by userId=${userId}`);
    return { statusCode: 200, body: envelope };
  }
}
